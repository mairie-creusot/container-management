/**
 * GET    /api/ad-dns/config — config DNS AD courante, REDACTÉE (jamais le mot de passe, cf.
 *                             types.ts#AdDnsStatus) + résultat de la dernière synchronisation
 *                             connue (celle de la route la plus récente à avoir été poussée).
 * PUT    /api/ad-dns/config — enregistre/remplace la config — admin uniquement (403 sinon),
 *                             même garde que routes/secrets.ts/remoteEnvironments.ts/lxc.ts pour
 *                             des intégrations de sensibilité comparable : un `operator` qui
 *                             changerait `kdcHost` pourrait rediriger `kinit` vers un KDC
 *                             Kerberos qu'il contrôle (rogue-KDC) avec le mot de passe déjà
 *                             enregistré du compte de service AD — voir
 *                             docs/reports/security-audit-2026-08-12.md, finding E3.
 *                             `password` omis/vide = conserve le mot de passe déjà enregistré
 *                             (même convention que PATCH /api/registries/:id).
 * DELETE /api/ad-dns/config — désactive la synchronisation automatique — admin uniquement, même
 *                             raison que PUT ci-dessus.
 * POST   /api/ad-dns/test   — valide une config candidate (kinit uniquement, aucun enregistrement
 *                             DNS écrit) avant de l'enregistrer (operator/admin, hook global —
 *                             ne mute rien, cohérent avec /api/setup/test/*).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isIPv4 } from "node:net";
import { testAdDnsConnection } from "../services/adDns.js";
import { clearAdDnsConfig, getEffectiveAdDnsConfig, setAdDnsConfig } from "../services/setupStore.js";
import type { SetupAdDnsConfig } from "../services/setupStore.js";
import { lastKnownDnsSync } from "../services/reverseProxy.js";
import type { AdDnsConfig, AdDnsStatus } from "../types.js";

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que secrets.ts/lxc.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface AdDnsConfigBody {
  realm?: string;
  kdcHost?: string;
  zone?: string;
  serviceAccount?: string;
  password?: string;
  targetIp?: string;
}

function toPublicConfig(cfg: SetupAdDnsConfig): AdDnsConfig {
  return { realm: cfg.realm, kdcHost: cfg.kdcHost, zone: cfg.zone, serviceAccount: cfg.serviceAccount, targetIp: cfg.targetIp };
}

function missingFields(body: AdDnsConfigBody, requirePassword: boolean): string[] {
  const missing: string[] = [];
  if (!body.realm?.trim()) missing.push("realm");
  if (!body.kdcHost?.trim()) missing.push("kdcHost");
  if (!body.zone?.trim()) missing.push("zone");
  if (!body.serviceAccount?.trim()) missing.push("serviceAccount");
  if (!body.targetIp?.trim()) missing.push("targetIp");
  if (requirePassword && !body.password?.trim()) missing.push("password");
  return missing;
}

/**
 * `targetIp` n'était vérifié que « non vide » avant écriture dans l'enregistrement `A` poussé par
 * `nsupdate` (services/adDns.ts#pushDnsRecord) — même mécanisme d'injection que `subdomain`
 * (finding C3), moindre car réservé à un rôle désormais admin (voir E3 ci-dessus), mais
 * incohérent avec le reste du projet. Seul l'IPv4 est utilisé (enregistrement `A`, jamais `AAAA`)
 * — voir docs/reports/security-audit-2026-08-12.md, finding M6.
 */
function isValidTargetIp(value: string): boolean {
  return isIPv4(value);
}

export default async function adDnsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/ad-dns/config", async (_request, reply) => {
    const current = await getEffectiveAdDnsConfig();
    const status: AdDnsStatus = current
      ? { configured: true, config: toPublicConfig(current), ...(lastKnownDnsSync() ? { lastSync: lastKnownDnsSync()! } : {}) }
      : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: AdDnsConfigBody }>("/api/ad-dns/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await getEffectiveAdDnsConfig();
    const missing = missingFields(body, !existing);
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
    }
    if (!isValidTargetIp(body.targetIp!.trim())) {
      return reply.code(400).send({ error: `targetIp "${body.targetIp}" is not a valid IPv4 address` });
    }
    const candidate: SetupAdDnsConfig = {
      realm: body.realm!.trim(),
      kdcHost: body.kdcHost!.trim(),
      zone: body.zone!.trim(),
      serviceAccount: body.serviceAccount!.trim(),
      targetIp: body.targetIp!.trim(),
      // password vide/absent = conserver l'existant (mêmes conventions que PATCH /api/registries/:id).
      password: body.password?.trim() ? body.password.trim() : (existing?.password ?? ""),
    };
    if (!candidate.password) {
      return reply.code(400).send({ error: "password is required" });
    }
    const saved = await setAdDnsConfig(candidate);
    return reply.send({ configured: true, config: toPublicConfig(saved.adDns!) } satisfies AdDnsStatus);
  });

  fastify.delete("/api/ad-dns/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearAdDnsConfig();
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: AdDnsConfigBody }>("/api/ad-dns/test", async (request, reply) => {
    const body = request.body ?? {};
    const existing = await getEffectiveAdDnsConfig();
    const missing = missingFields(body, !existing);
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
    }
    if (!isValidTargetIp(body.targetIp!.trim())) {
      return reply.code(400).send({ error: `targetIp "${body.targetIp}" is not a valid IPv4 address` });
    }
    const candidate: SetupAdDnsConfig = {
      realm: body.realm!.trim(),
      kdcHost: body.kdcHost!.trim(),
      zone: body.zone!.trim(),
      serviceAccount: body.serviceAccount!.trim(),
      targetIp: body.targetIp!.trim(),
      password: body.password?.trim() ? body.password.trim() : (existing?.password ?? ""),
    };
    if (!candidate.password) {
      return reply.code(400).send({ error: "password is required" });
    }
    const result = await testAdDnsConnection(candidate);
    return reply.send(result);
  });
}
