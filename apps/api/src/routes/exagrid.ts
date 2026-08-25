/**
 * Routes ExaGrid — intégration LECTURE SEULE de l'appliance de sauvegarde via SNMP (voir
 * services/exagrid.ts) : aucune route mutante vers l'appliance n'existe ici, et aucune ne doit
 * y être ajoutée (SNMP SET est hors périmètre — l'appliance protège la production de la mairie).
 *
 * GET    /api/exagrid/status      — configuré/joignable + capacités + alarme + dernier poll ;
 *                                    { configured: false } si jamais configuré (tout rôle authentifié).
 * GET    /api/exagrid/config      — config courante SANS aucun secret (tout rôle authentifié).
 * PUT    /api/exagrid/config      — configure/remplace (admin) — teste RÉELLEMENT la session SNMP
 *                                    avant d'enregistrer, jamais persisté à l'aveugle.
 * POST   /api/exagrid/config/test — teste une config candidate SANS persister (admin).
 * DELETE /api/exagrid/config      — retire la configuration (admin).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_SNMP_PORT,
  EXAGRID_AUTH_PROTOCOLS,
  EXAGRID_PRIV_PROTOCOLS,
  EXAGRID_SECURITY_LEVELS,
  getExagridStatus,
  lastKnownExagridPoll,
  testExagridConnection,
  toExagridEndpoint,
  validateExagridConfig,
} from "../services/exagrid.js";
import type { ExagridConfigStatus, ExagridSnmpVersion } from "../services/exagrid.js";
import { clearExagridConfig, getEffectiveExagridConfig, setExagridConfig } from "../services/setupStore.js";
import type { SetupExagridConfig } from "../services/setupStore.js";
import { listExagridTraps } from "../services/exagridTraps.js";

/** Même garde locale admin que routes/hycu.ts — les identifiants SNMP donnent accès à l'état de
 * toute l'infrastructure de sauvegarde. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface ExagridConfigBody {
  host?: string;
  port?: number | string;
  version?: string;
  community?: string;
  username?: string;
  securityLevel?: string;
  authProtocol?: string;
  authKey?: string;
  privProtocol?: string;
  privKey?: string;
}

function pickAllowed<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function pickPort(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return undefined;
}

/**
 * Config candidate = corps de requête complété par la config existante. Convention identique à
 * PUT /api/hycu/config pour les secrets : champ vide/absent = CONSERVER l'existant (changer
 * l'hôte sans ressaisir la community). Seuls les champs de la version SNMP retenue sont repris,
 * pour ne jamais traîner un secret d'un mode qui n'est plus utilisé.
 */
function buildCandidate(body: ExagridConfigBody, existing: SetupExagridConfig | null): SetupExagridConfig | { error: string } {
  const host = (body.host ?? existing?.host ?? "").trim();
  const port = pickPort(body.port) ?? existing?.port ?? DEFAULT_SNMP_PORT;
  const version: ExagridSnmpVersion | undefined = pickAllowed<ExagridSnmpVersion>(body.version, ["2c", "3"]) ?? existing?.version;
  if (!version) return { error: 'version doit valoir "2c" ou "3"' };

  if (version === "2c") {
    const community = body.community?.trim() || existing?.community;
    return { host, port, version, ...(community ? { community } : {}) };
  }

  const username = body.username?.trim() || existing?.username;
  const securityLevel = pickAllowed(body.securityLevel, EXAGRID_SECURITY_LEVELS) ?? existing?.securityLevel;
  const authProtocol = pickAllowed(body.authProtocol, EXAGRID_AUTH_PROTOCOLS) ?? existing?.authProtocol;
  const authKey = body.authKey?.trim() || existing?.authKey;
  const privProtocol = pickAllowed(body.privProtocol, EXAGRID_PRIV_PROTOCOLS) ?? existing?.privProtocol;
  const privKey = body.privKey?.trim() || existing?.privKey;
  return {
    host,
    port,
    version,
    ...(username ? { username } : {}),
    ...(securityLevel ? { securityLevel } : {}),
    ...(authProtocol ? { authProtocol } : {}),
    ...(authKey ? { authKey } : {}),
    ...(privProtocol ? { privProtocol } : {}),
    ...(privKey ? { privKey } : {}),
  };
}

export default async function exagridRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/exagrid/status", async (_request, reply) => {
    const status = await getExagridStatus();
    const lastPoll = lastKnownExagridPoll();
    return reply.send({ ...status, ...(lastPoll ? { lastPoll } : {}) });
  });

  // Traps réellement reçus de l'appliance (Configuration > SNMP Traps côté ExaGrid). Distinct de
  // /status, qui vient du poll : un trap est un événement, il ne porte aucune donnée de capacité.
  fastify.get("/api/exagrid/traps", async (_request, reply) => {
    return reply.send({ traps: listExagridTraps() });
  });

  fastify.get("/api/exagrid/config", async (_request, reply) => {
    const current = await getEffectiveExagridConfig();
    const status: ExagridConfigStatus = current ? { configured: true, config: toExagridEndpoint(current) } : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: ExagridConfigBody }>("/api/exagrid/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const candidate = buildCandidate(request.body ?? {}, await getEffectiveExagridConfig());
    if ("error" in candidate) return reply.code(400).send({ error: candidate.error });

    const invalid = validateExagridConfig(candidate);
    if (invalid) return reply.code(400).send({ error: invalid });

    // Teste réellement la session SNMP avant d'enregistrer — jamais persisté à l'aveugle.
    const test = await testExagridConnection(candidate);
    if (!test.ok) return reply.code(400).send({ error: test.message });

    await setExagridConfig(candidate);
    return reply.send({ configured: true, config: toExagridEndpoint(candidate) } satisfies ExagridConfigStatus);
  });

  fastify.post<{ Body: ExagridConfigBody }>("/api/exagrid/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const candidate = buildCandidate(request.body ?? {}, await getEffectiveExagridConfig());
    if ("error" in candidate) return reply.send({ ok: false, message: candidate.error });

    return reply.send(await testExagridConnection(candidate));
  });

  fastify.delete("/api/exagrid/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearExagridConfig();
    return reply.send({ ok: true });
  });
}
