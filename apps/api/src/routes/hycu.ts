/**
 * Routes HYCU — intégration LECTURE SEULE du contrôleur de sauvegarde (voir services/hycu.ts,
 * garde-fou de prudence absolue : l'appliance protège la production de la mairie, AUCUNE route
 * mutante vers HYCU n'existe ici — backup/restore/policy/target restent hors périmètre).
 *
 * GET    /api/hycu/status   — résumé calculé (VMs protégées, policies, targets, jobs par statut)
 *                              + dernier poll (lastKnownHycuPoll) ; { configured: false } si
 *                              jamais configuré.
 * GET    /api/hycu/vms      — VMs vues par HYCU (policy résolue) ; [] si non configuré/injoignable.
 * GET    /api/hycu/policies — policies + nombre de VMs assignées (calculé) ; [] idem.
 * GET    /api/hycu/targets  — targets (capacité/utilisation) ; [] idem.
 * GET    /api/hycu/jobs     — jobs récents (statut/type/horodatage si exposés) ; [] idem.
 * GET    /api/hycu/events   — événements récents (sévérité/message si exposés) ; [] idem.
 * Lecture pour tout rôle authentifié (session exigée par la garde globale plugins/auth.ts —
 * même niveau que GET /api/nutanix/vms).
 *
 * GET    /api/hycu/config      — config courante REDACTÉE (jamais le mot de passe).
 * PUT    /api/hycu/config      — configure/remplace (admin uniquement) — teste RÉELLEMENT la
 *                                 connexion avant d'enregistrer, jamais persisté à l'aveugle
 *                                 (même discipline que PUT /api/nutanix/config).
 * POST   /api/hycu/config/test — teste une config candidate SANS persister (admin uniquement).
 * DELETE /api/hycu/config      — retire la configuration (admin uniquement).
 *
 * La configuration est lue/écrite via le greffon (plugins/hycu/config.ts, stockage générique des
 * intégrations) : une config écrite avant la migration dans le champ typé `hycu` est reprise puis
 * retirée, sans ressaisie.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectIfPluginDisabled } from "../plugins/activation.js";
import {
  getHycuEvents,
  getHycuJobs,
  getHycuPolicies,
  getHycuStatus,
  getHycuTargets,
  getHycuVms,
  lastKnownHycuPoll,
  testHycuConnection,
} from "../services/hycu.js";
import { loadHycuPluginConfig, removeHycuPluginConfig, saveHycuPluginConfig } from "../plugins/hycu/config.js";
import type { SetupHycuConfig } from "../services/setupStore.js";
import type { HycuConfig, HycuConfigStatus } from "../types.js";

/** Même garde locale admin que routes/nutanix.ts#rejectIfNotAdmin — sensibilité comparable
 * (identifiants donnant accès à toute l'infra de sauvegarde de la production). */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface HycuConfigBody {
  url?: string;
  username?: string;
  password?: string;
}

function toPublicConfig(cfg: SetupHycuConfig): HycuConfig {
  return { url: cfg.url, username: cfg.username };
}

/** Un module en pause ne sert plus ses données ; sa configuration reste lisible pour le réactiver. */
async function rejectIfDisabled(reply: FastifyReply): Promise<boolean> {
  return await rejectIfPluginDisabled(reply, "hycu", "Sauvegarde HYCU");
}

export default async function hycuRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/hycu/status", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    const status = await getHycuStatus();
    const lastPoll = lastKnownHycuPoll();
    return reply.send({ ...status, ...(lastPoll ? { lastPoll } : {}) });
  });

  fastify.get("/api/hycu/vms", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    return reply.send(await getHycuVms());
  });

  fastify.get("/api/hycu/policies", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    return reply.send(await getHycuPolicies());
  });

  fastify.get("/api/hycu/targets", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    return reply.send(await getHycuTargets());
  });

  fastify.get("/api/hycu/jobs", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    return reply.send(await getHycuJobs());
  });

  fastify.get("/api/hycu/events", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    return reply.send(await getHycuEvents());
  });

  fastify.get("/api/hycu/config", async (_request, reply) => {
    const current = await loadHycuPluginConfig();
    const status: HycuConfigStatus = current ? { configured: true, config: toPublicConfig(current) } : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: HycuConfigBody }>("/api/hycu/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await loadHycuPluginConfig();
    const url = body.url?.trim();
    const username = body.username?.trim();
    // password vide/absent = conserver l'existant (même convention que PUT /api/nutanix/config).
    const password = body.password?.trim() || existing?.password || "";

    if (!url || !username || !password) {
      return reply.code(400).send({ error: "url, username and password are required" });
    }

    // Teste réellement la connexion avant d'enregistrer — jamais persisté à l'aveugle.
    const test = await testHycuConnection(url, username, password);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    const saved: SetupHycuConfig = { url, username, password };
    await saveHycuPluginConfig(saved);
    return reply.send({ configured: true, config: toPublicConfig(saved) } satisfies HycuConfigStatus);
  });

  fastify.post<{ Body: HycuConfigBody }>("/api/hycu/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await loadHycuPluginConfig();
    const url = body.url?.trim() ?? existing?.url ?? "";
    const username = body.username?.trim() ?? existing?.username ?? "";
    // Même convention que PUT ci-dessus : tester la config déjà enregistrée sans ressaisir le
    // mot de passe.
    const password = body.password?.trim() || existing?.password || "";

    const result = await testHycuConnection(url, username, password);
    return reply.send(result);
  });

  fastify.delete("/api/hycu/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await removeHycuPluginConfig();
    return reply.send({ ok: true });
  });
}
