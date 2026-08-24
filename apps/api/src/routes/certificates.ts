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
 * Aucune de ces routes ne renvoie de clé privée ni d'identifiant, y compris dans un message
 * d'erreur (voir services/certificates.ts#scrubSecrets).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CertificateEnrollmentError,
  CertificatesNotConfiguredError,
  forgetCertificate,
  testCertificatesConnection,
} from "../services/certificates.js";
import { certificatesOverview, renewSubjectNow } from "../services/certificatesReconciler.js";
import {
  clearCertificatesConfig,
  getEffectiveCertificatesConfig,
  setCertificatesConfig,
} from "../services/setupStore.js";
import type { CertificateEnrollmentMethod, SetupCertificatesConfig } from "../services/setupStore.js";

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
  username: string;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll: boolean;
  tlsRejectUnauthorized?: boolean;
}

interface CertificatesConfigStatus {
  configured: boolean;
  config?: PublicCertificatesConfig;
}

function toPublicConfig(cfg: SetupCertificatesConfig): PublicCertificatesConfig {
  return {
    caUrl: cfg.caUrl,
    method: cfg.method ?? "certsrv",
    template: cfg.template,
    username: cfg.username,
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
  username?: string;
  password?: string;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll?: boolean;
  tlsRejectUnauthorized?: boolean;
}

/** Construit une config candidate depuis le corps de requête, en conservant le mot de passe déjà
 * enregistré si le champ est vide (même convention que PUT /api/hycu/config). */
function candidateFrom(body: CertificatesConfigBody, existing: SetupCertificatesConfig | null): SetupCertificatesConfig {
  return {
    caUrl: body.caUrl?.trim() ?? existing?.caUrl ?? "",
    method: "certsrv",
    template: body.template?.trim() ?? existing?.template ?? "",
    username: body.username?.trim() ?? existing?.username ?? "",
    password: body.password?.trim() || existing?.password || "",
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
  if (!candidate.username) missing.push("username");
  if (!candidate.password) missing.push("password");
  return missing;
}

/** Traduit une erreur du service en réponse HTTP — jamais de 500 opaque, jamais de secret. */
function replyForEnrollmentError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CertificatesNotConfiguredError) {
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
      ? { configured: true, config: toPublicConfig(current) }
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

    // Teste réellement l'autorité avant d'enregistrer — jamais persisté à l'aveugle.
    const test = await testCertificatesConnection(candidate);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    const saved = await setCertificatesConfig(candidate);
    return reply.send({ configured: true, config: toPublicConfig(saved.certificates!) } satisfies CertificatesConfigStatus);
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
