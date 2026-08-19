/**
 * Routes PBX 3CX — intégration LECTURE SEULE du XAPI (voir services/threecx.ts). AUCUNE route
 * mutante n'existe ici : le XAPI sait raccrocher (Pbx.DropCall), appeler (Pbx.MakeCall) et arrêter
 * les services du PBX, et il s'agit de la téléphonie EN SERVICE de la mairie.
 *
 * GET    /api/3cx/status       — résumé (appels en cours, postes joignables, files, état système)
 *                                 + lastPoll ; { configured: false } si jamais configuré.
 * GET    /api/3cx/active-calls — appels en cours normalisés.
 * GET    /api/3cx/extensions   — postes + présence (enregistré, profil courant, statut de file).
 * GET    /api/3cx/queues       — files d'attente.
 * Les trois listes renvoient une enveloppe { configured, reachable?, accessError?, items } : le
 * XAPI exige une licence 3CX Enterprise, et un refus du PBX ressort dans `accessError` avec SON
 * message, jamais camouflé en liste vide.
 * Lecture pour tout rôle authentifié (session exigée par la garde globale plugins/auth.ts).
 *
 * GET    /api/3cx/config      — config courante REDACTÉE (jamais la clé API).
 * PUT    /api/3cx/config      — configure/remplace (admin) — teste RÉELLEMENT la connexion avant
 *                                d'enregistrer, jamais persisté à l'aveugle.
 * POST   /api/3cx/config/test — teste une config candidate SANS persister (admin).
 * DELETE /api/3cx/config      — retire la configuration (admin).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  getThreecxActiveCalls,
  getThreecxExtensions,
  getThreecxQueues,
  getThreecxStatus,
  lastKnownThreecxPoll,
  resetThreecxCaches,
  testThreecxConnection,
} from "../services/threecx.js";
import { clearThreecxConfig, getEffectiveThreecxConfig, setThreecxConfig } from "../services/setupStore.js";
import type { SetupThreecxConfig } from "../services/setupStore.js";

/** Même garde locale admin que routes/hycu.ts#rejectIfNotAdmin. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface ThreecxConfigBody {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  tlsRejectUnauthorized?: boolean;
}

/** Config publique : la clé API (clientSecret) n'en fait JAMAIS partie, même tronquée. */
interface PublicThreecxConfig {
  baseUrl: string;
  clientId: string;
  tlsRejectUnauthorized?: boolean;
}

function toPublicConfig(cfg: SetupThreecxConfig): PublicThreecxConfig {
  return {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    ...(cfg.tlsRejectUnauthorized !== undefined ? { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized } : {}),
  };
}

export default async function threecxRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/3cx/status", async (_request, reply) => {
    const status = await getThreecxStatus();
    const lastPoll = lastKnownThreecxPoll();
    return reply.send({ ...status, ...(lastPoll ? { lastPoll } : {}) });
  });

  fastify.get("/api/3cx/active-calls", async (_request, reply) => {
    const { items, ...rest } = await getThreecxActiveCalls();
    return reply.send({ ...rest, calls: items });
  });

  fastify.get("/api/3cx/extensions", async (_request, reply) => {
    const { items, ...rest } = await getThreecxExtensions();
    return reply.send({ ...rest, extensions: items });
  });

  fastify.get("/api/3cx/queues", async (_request, reply) => {
    const { items, ...rest } = await getThreecxQueues();
    return reply.send({ ...rest, queues: items });
  });

  fastify.get("/api/3cx/config", async (_request, reply) => {
    const current = await getEffectiveThreecxConfig();
    return reply.send(current ? { configured: true, config: toPublicConfig(current) } : { configured: false });
  });

  fastify.put<{ Body: ThreecxConfigBody }>("/api/3cx/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await getEffectiveThreecxConfig();
    const baseUrl = body.baseUrl?.trim();
    const clientId = body.clientId?.trim();
    // clientSecret vide/absent = conserver l'existant (même convention que PUT /api/hycu/config).
    const clientSecret = body.clientSecret?.trim() || existing?.clientSecret || "";
    const tls = body.tlsRejectUnauthorized ?? existing?.tlsRejectUnauthorized;

    if (!baseUrl || !clientId || !clientSecret) {
      return reply.code(400).send({ error: "baseUrl, clientId and clientSecret are required" });
    }

    const test = await testThreecxConnection(baseUrl, clientId, clientSecret, tls);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    const saved = await setThreecxConfig({ baseUrl, clientId, clientSecret, ...(tls !== undefined ? { tlsRejectUnauthorized: tls } : {}) });
    return reply.send({ configured: true, config: toPublicConfig(saved.threecx!) });
  });

  fastify.post<{ Body: ThreecxConfigBody }>("/api/3cx/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await getEffectiveThreecxConfig();
    const baseUrl = body.baseUrl?.trim() ?? existing?.baseUrl ?? "";
    const clientId = body.clientId?.trim() ?? existing?.clientId ?? "";
    const clientSecret = body.clientSecret?.trim() || existing?.clientSecret || "";
    const tls = body.tlsRejectUnauthorized ?? existing?.tlsRejectUnauthorized;

    const result = await testThreecxConnection(baseUrl, clientId, clientSecret, tls);
    return reply.send(result);
  });

  fastify.delete("/api/3cx/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearThreecxConfig();
    // Le jeton en cache appartenait à la config retirée : il ne doit plus servir.
    resetThreecxCaches();
    return reply.send({ ok: true });
  });
}
