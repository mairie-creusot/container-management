/**
 * Routes Certificats (autorité AD CS interne — voir services/certificates.ts).
 *
 * GET    /api/certificates            — état réel de chaque certificat (sujet, émetteur, validité,
 *                                        jours restants, prochain renouvellement, dernier échec)
 *                                        + état de la boucle de renouvellement.
 * GET    /api/certificates/config     — config courante REDACTÉE (jamais le mot de passe).
 * PUT    /api/certificates/config     — configure/remplace (admin) — teste RÉELLEMENT l'autorité
 *                                        avant d'enregistrer, jamais persisté à l'aveugle.
 * POST   /api/certificates/config/test— teste une config candidate SANS persister (admin).
 * DELETE /api/certificates/config     — retire la configuration (admin) ; les certificats déjà
 *                                        émis restent servis jusqu'à expiration.
 * POST   /api/certificates/issue      — émet/réémet pour un sujet donné (operator|admin).
 * DELETE /api/certificates/:subject   — oublie un certificat (operator|admin).
 *
 * Aucune de ces routes ne renvoie de mot de passe ni de clé privée, y compris dans un message
 * d'erreur (voir services/certificates.ts#scrubSecrets).
 *
 * Compte présenté à l'autorité : identifiants dédiés s'ils sont renseignés, sinon le compte de
 * l'annuaire LDAP (voir services/certificates.ts#resolveEnrollmentAccount).
 *
 * Traçabilité : POST /issue et DELETE /:subject sont mutants, donc journalisés automatiquement
 * avec leur demandeur par plugins/audit.ts — rien à câbler ici. Le renouvellement automatique
 * (certificatesReconciler.ts) ne passe par aucune requête : il reste une action système, sans
 * utilisateur inventé.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CertificateAccountError,
  CertificateEnrollmentError,
  CertificatesNotConfiguredError,
  describeEnrollmentAccount,
  forgetCertificate,
  testCertificatesConnection,
} from "../services/certificates.js";
import type { EnrollmentAccountView } from "../services/certificates.js";
import { certificatesOverview, renewSubjectNow } from "../services/certificatesReconciler.js";
import {
  clearCertificatesConfig,
  effectiveAccountSource,
  getEffectiveCertificatesConfig,
  setCertificatesConfig,
} from "../services/setupStore.js";
import type {
  CertificateAccountSource,
  CertificateEnrollmentMethod,
  SetupCertificatesConfig,
} from "../services/setupStore.js";

/** Même garde locale admin que routes/hycu.ts#rejectIfNotAdmin — les identifiants configurés ici
 * permettent d'émettre des certificats au nom de la mairie. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/** Vue publique : ne contient tout simplement PAS le mot de passe (jamais un masquage "***"). */
interface PublicCertificatesConfig {
  caUrl: string;
  method: CertificateEnrollmentMethod;
  template: string;
  accountSource: CertificateAccountSource;
  /** Compte dédié : son identifiant. Compte de l'annuaire : la surcharge saisie, sinon absent. */
  username?: string;
  /** Compte réellement présenté à l'autorité, dérivation comprise — jamais de mot de passe. */
  account?: EnrollmentAccountView;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll: boolean;
  tlsRejectUnauthorized?: boolean;
}

interface CertificatesConfigStatus {
  configured: boolean;
  config?: PublicCertificatesConfig;
}

async function toPublicConfig(cfg: SetupCertificatesConfig): Promise<PublicCertificatesConfig> {
  return {
    caUrl: cfg.caUrl,
    method: cfg.method ?? "certsrv",
    template: cfg.template,
    accountSource: effectiveAccountSource(cfg),
    ...(cfg.username ? { username: cfg.username } : {}),
    account: await describeEnrollmentAccount(cfg),
    ...(cfg.renewBeforeDays !== undefined ? { renewBeforeDays: cfg.renewBeforeDays } : {}),
    ...(cfg.keySize !== undefined ? { keySize: cfg.keySize } : {}),
    autoEnroll: cfg.autoEnroll ?? true,
    ...(cfg.tlsRejectUnauthorized !== undefined ? { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized } : {}),
  };
}

interface CertificatesConfigBody {
  caUrl?: string;
  method?: string;
  template?: string;
  accountSource?: string;
  username?: string;
  password?: string;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll?: boolean;
  tlsRejectUnauthorized?: boolean;
}

/** Mode explicite s'il est envoyé ; sinon un identifiant seul reste un compte dédié (compat). */
function accountSourceFrom(body: CertificatesConfigBody, existing: SetupCertificatesConfig | null): CertificateAccountSource {
  if (body.accountSource === "directory" || body.accountSource === "dedicated") return body.accountSource;
  if (body.username?.trim()) return "dedicated";
  return existing ? effectiveAccountSource(existing) : "directory";
}

/** Construit une config candidate depuis le corps de requête, en conservant le mot de passe déjà
 * enregistré si le champ est vide (même convention que PUT /api/hycu/config). */
function candidateFrom(body: CertificatesConfigBody, existing: SetupCertificatesConfig | null): SetupCertificatesConfig {
  const accountSource = accountSourceFrom(body, existing);
  const keepExistingSecret = existing !== null && effectiveAccountSource(existing) === "dedicated";
  const username = body.username?.trim() ?? existing?.username ?? "";
  return {
    caUrl: body.caUrl?.trim() ?? existing?.caUrl ?? "",
    method: "certsrv",
    template: body.template?.trim() ?? existing?.template ?? "",
    accountSource,
    ...(username ? { username } : {}),
    // Aucun mot de passe n'est conservé ni accepté pour le compte de l'annuaire : c'est bindPassword.
    ...(accountSource === "dedicated"
      ? { password: body.password?.trim() || (keepExistingSecret ? (existing?.password ?? "") : "") }
      : {}),
    ...(body.renewBeforeDays !== undefined
      ? { renewBeforeDays: body.renewBeforeDays }
      : existing?.renewBeforeDays !== undefined
        ? { renewBeforeDays: existing.renewBeforeDays }
        : {}),
    ...(body.keySize !== undefined ? { keySize: body.keySize } : existing?.keySize !== undefined ? { keySize: existing.keySize } : {}),
    ...(body.autoEnroll !== undefined ? { autoEnroll: body.autoEnroll } : existing?.autoEnroll !== undefined ? { autoEnroll: existing.autoEnroll } : {}),
    ...(body.tlsRejectUnauthorized !== undefined
      ? { tlsRejectUnauthorized: body.tlsRejectUnauthorized }
      : existing?.tlsRejectUnauthorized !== undefined
        ? { tlsRejectUnauthorized: existing.tlsRejectUnauthorized }
        : {}),
  };
}

function missingFields(candidate: SetupCertificatesConfig): string[] {
  const missing: string[] = [];
  if (!candidate.caUrl) missing.push("caUrl");
  if (!candidate.template) missing.push("template");
  // Compte de l'annuaire : identifiant et mot de passe viennent du LDAP, rien n'est requis ici.
  if (effectiveAccountSource(candidate) === "dedicated") {
    if (!candidate.username) missing.push("username");
    if (!candidate.password) missing.push("password");
  }
  return missing;
}

/** Traduit une erreur du service en réponse HTTP — jamais de 500 opaque, jamais de secret. */
function replyForEnrollmentError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CertificatesNotConfiguredError || err instanceof CertificateAccountError) {
    // Problème de configuration, pas d'échec de l'autorité : 400, pas 502.
    return reply.code(400).send({ error: err.message });
  }
  if (err instanceof CertificateEnrollmentError) {
    return reply.code(502).send({ error: err.message });
  }
  return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
}

export default async function certificatesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/certificates", async (_request, reply) => {
    return reply.send(await certificatesOverview());
  });

  fastify.get("/api/certificates/config", async (_request, reply) => {
    const current = await getEffectiveCertificatesConfig();
    const status: CertificatesConfigStatus = current
      ? { configured: true, config: await toPublicConfig(current) }
      : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: CertificatesConfigBody }>("/api/certificates/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const existing = await getEffectiveCertificatesConfig();
    const candidate = candidateFrom(request.body ?? {}, existing);
    const missing = missingFields(candidate);
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
    }

    // Teste réellement l'autorité avant d'enregistrer — jamais persisté à l'aveugle. `account`
    // accompagne l'échec pour que l'interface sache quel compte a été essayé, et pourquoi.
    const test = await testCertificatesConnection(candidate);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message, ...(test.account ? { account: test.account } : {}) });
    }

    // `saved.certificates` porte le mot de passe CHIFFRÉ : toPublicConfig ne le renvoie jamais.
    const saved = await setCertificatesConfig(candidate);
    return reply.send({ configured: true, config: await toPublicConfig(saved.certificates!) } satisfies CertificatesConfigStatus);
  });

  fastify.post<{ Body: CertificatesConfigBody }>("/api/certificates/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const existing = await getEffectiveCertificatesConfig();
    const candidate = candidateFrom(request.body ?? {}, existing);
    return reply.send(await testCertificatesConnection(candidate));
  });

  fastify.delete("/api/certificates/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearCertificatesConfig();
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: { subject?: string } }>("/api/certificates/issue", async (request, reply) => {
    const subject = request.body?.subject?.trim();
    if (!subject) {
      return reply.code(400).send({ error: "subject is required" });
    }
    try {
      await renewSubjectNow(subject);
    } catch (err) {
      return replyForEnrollmentError(reply, err);
    }
    return reply.send(await certificatesOverview());
  });

  fastify.delete<{ Params: { subject: string } }>("/api/certificates/:subject", async (request, reply) => {
    const removed = await forgetCertificate(request.params.subject);
    if (!removed) {
      return reply.code(404).send({ error: `Aucun certificat pour "${request.params.subject}"` });
    }
    return reply.send({ ok: true });
  });
}
