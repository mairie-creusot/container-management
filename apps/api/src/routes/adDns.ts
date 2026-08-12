/**
 * GET    /api/ad-dns/config — config DNS AD courante, REDACTÉE (jamais le mot de passe, cf.
 *                             types.ts#AdDnsStatus) + résultat de la dernière synchronisation
 *                             connue (celle de la route la plus récente à avoir été poussée).
 * PUT    /api/ad-dns/config — enregistre/remplace la config (operator/admin, hook global).
 *                             `password` omis/vide = conserve le mot de passe déjà enregistré
 *                             (même convention que PATCH /api/registries/:id).
 * DELETE /api/ad-dns/config — désactive la synchronisation automatique (operator/admin).
 * POST   /api/ad-dns/test   — valide une config candidate (kinit uniquement, aucun enregistrement
 *                             DNS écrit) avant de l'enregistrer.
 */

import type { FastifyInstance } from "fastify";
import { testAdDnsConnection } from "../services/adDns.js";
import { clearAdDnsConfig, getEffectiveAdDnsConfig, setAdDnsConfig } from "../services/setupStore.js";
import type { SetupAdDnsConfig } from "../services/setupStore.js";
import { lastKnownDnsSync } from "../services/reverseProxy.js";
import type { AdDnsConfig, AdDnsStatus } from "../types.js";

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

export default async function adDnsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/ad-dns/config", async (_request, reply) => {
    const current = await getEffectiveAdDnsConfig();
    const status: AdDnsStatus = current
      ? { configured: true, config: toPublicConfig(current), ...(lastKnownDnsSync() ? { lastSync: lastKnownDnsSync()! } : {}) }
      : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: AdDnsConfigBody }>("/api/ad-dns/config", async (request, reply) => {
    const body = request.body ?? {};
    const existing = await getEffectiveAdDnsConfig();
    const missing = missingFields(body, !existing);
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
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

  fastify.delete("/api/ad-dns/config", async (_request, reply) => {
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
