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
 * Les trois listes renvoient une enveloppe { configured, reachable?, accessError?, pbxError?,
 * items }. `accessError` est RÉSERVÉ au refus d'accès (401/403, authentification refusée) — le seul
 * cas qui relève de la licence Enterprise ; toute autre erreur renvoyée par le PBX (400 de
 * validation OData, 404, 5xx) ressort dans `pbxError`. Message du PBX brut, jamais une liste vide
 * silencieuse.
 * Lecture pour tout rôle authentifié (session exigée par la garde globale plugins/auth.ts).
 *
 * La configuration est celle du GREFFON "3cx" (plugins/threecx/config.ts), stockée par le socle.
 * GET    /api/3cx/config      — config courante REDACTÉE (jamais la clé API ni le mot de passe).
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
import type { ThreecxConnectionCandidate } from "../services/threecx.js";
import { loadThreecxPluginConfig, removeThreecxPluginConfig, saveThreecxPluginConfig } from "../plugins/threecx/config.js";
import type { SetupThreecxConfig, ThreecxAuthMode } from "../services/setupStore.js";

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
  authMode?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  tlsRejectUnauthorized?: boolean;
}

/** Config publique : ni la clé API (clientSecret) ni le mot de passe n'en font partie, même tronqués. */
interface PublicThreecxConfig {
  baseUrl: string;
  authMode: ThreecxAuthMode;
  clientId?: string;
  username?: string;
  tlsRejectUnauthorized?: boolean;
}

/** Mode explicitement demandé, sinon celui déjà enregistré — une valeur inconnue ne change rien. */
function resolveAuthMode(requested: string | undefined, fallback: ThreecxAuthMode): ThreecxAuthMode {
  return requested === "user" || requested === "client-credentials" ? requested : fallback;
}

function toPublicConfig(cfg: SetupThreecxConfig): PublicThreecxConfig {
  return {
    baseUrl: cfg.baseUrl,
    authMode: cfg.authMode ?? "client-credentials",
    ...(cfg.clientId ? { clientId: cfg.clientId } : {}),
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.tlsRejectUnauthorized !== undefined ? { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized } : {}),
  };
}

/** Candidate à tester/persister : les identifiants du mode ACTIF viennent du corps, ceux de l'autre
 * mode sont conservés tels quels (un secret vide = conserver celui déjà enregistré). */
function buildCandidate(body: ThreecxConfigBody, existing: SetupThreecxConfig | null, authMode: ThreecxAuthMode, baseUrl: string): ThreecxConnectionCandidate {
  const clientId = (authMode === "client-credentials" ? body.clientId?.trim() || existing?.clientId : existing?.clientId) ?? "";
  const username = (authMode === "user" ? body.username?.trim() || existing?.username : existing?.username) ?? "";
  const clientSecret = body.clientSecret?.trim() || existing?.clientSecret || "";
  const password = body.password?.trim() || existing?.password || "";
  const tls = body.tlsRejectUnauthorized ?? existing?.tlsRejectUnauthorized;
  return {
    baseUrl,
    authMode,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(tls !== undefined ? { tlsRejectUnauthorized: tls } : {}),
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
    const current = await loadThreecxPluginConfig();
    return reply.send(current ? { configured: true, config: toPublicConfig(current) } : { configured: false });
  });

  fastify.put<{ Body: ThreecxConfigBody }>("/api/3cx/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await loadThreecxPluginConfig();
    const baseUrl = body.baseUrl?.trim() ?? "";
    const authMode = resolveAuthMode(body.authMode, existing?.authMode ?? "client-credentials");
    // Secret vide/absent = conserver l'existant (même convention que PUT /api/hycu/config).
    const candidate = buildCandidate(body, existing, authMode, baseUrl);

    if (!baseUrl) return reply.code(400).send({ error: "baseUrl is required" });
    if (authMode === "user") {
      if (!candidate.username || !candidate.password) {
        return reply.code(400).send({ error: "baseUrl, username and password are required in user auth mode" });
      }
    } else if (!candidate.clientId || !candidate.clientSecret) {
      return reply.code(400).send({ error: "baseUrl, clientId and clientSecret are required" });
    }

    const test = await testThreecxConnection(candidate);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    await saveThreecxPluginConfig(candidate);
    return reply.send({ configured: true, config: toPublicConfig(candidate) });
  });

  fastify.post<{ Body: ThreecxConfigBody }>("/api/3cx/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await loadThreecxPluginConfig();
    const baseUrl = body.baseUrl?.trim() || existing?.baseUrl || "";
    // Le mode TESTÉ est celui demandé dans le corps — jamais celui déjà enregistré s'ils diffèrent.
    const authMode = resolveAuthMode(body.authMode, existing?.authMode ?? "client-credentials");
    const candidate = buildCandidate(body, existing, authMode, baseUrl);

    const result = await testThreecxConnection(candidate);
    return reply.send(result);
  });

  fastify.delete("/api/3cx/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await removeThreecxPluginConfig();
    // Le jeton en cache appartenait à la config retirée : il ne doit plus servir.
    resetThreecxCaches();
    return reply.send({ ok: true });
  });
}
