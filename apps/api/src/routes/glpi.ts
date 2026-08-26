/**
 * Routes GLPI (tickets de la Mairie du Creusot) — voir services/glpi.ts.
 *
 * GET    /api/glpi/status                  — { configured, reachable?, apiUrl?, authMode?,
 *                                              serviceAccount? } + dernier poll réel. JAMAIS un jeton.
 * GET    /api/glpi/my-tickets              — tickets dont l'UTILISATEUR DE LA SESSION QUAI est
 *                                              demandeur. Aucun identifiant d'utilisateur n'est
 *                                              accepté depuis le client : on part exclusivement de
 *                                              `request.authSession.username`, rapproché du champ
 *                                              `name` de /User. 0 ou >1 correspondance est signalé
 *                                              honnêtement (`account`), jamais deviné.
 * GET    /api/glpi/tickets/:id             — détail + suivis, UNIQUEMENT si l'utilisateur de la
 *                                              session est demandeur du ticket côté GLPI (404 sinon,
 *                                              sans révéler l'existence du ticket).
 * POST   /api/glpi/tickets/:id/followup    — { content } : ajoute un suivi au nom de l'utilisateur
 *                                              connecté (même contrôle d'accès que ci-dessus).
 *                                              Note : le hook global plugins/auth.ts exige déjà le
 *                                              rôle operator ou admin pour toute méthode mutante.
 * GET    /api/glpi/browse/accounts         — comptes GLPI (recherche par identifiant, paginée).
 * GET    /api/glpi/browse/tickets          — ?requesterId=N : tickets de CE compte ; sans requesterId :
 *                                              tous les tickets visibles du compte de service. Paginé.
 * GET    /api/glpi/browse/tickets/:id      — détail d'un ticket, sans restriction de demandeur.
 *   Les trois routes /api/glpi/browse/* sont réservées aux rôles operator et admin (garde de
 *   préfixe ci-dessous : un viewer reçoit 403 sur TOUTE route du préfixe, présente ou future), en
 *   LECTURE SEULE, et toute lecture de tickets d'autrui est écrite au journal d'audit.
 * GET    /api/glpi/search-options          — options de recherche RÉELLES de Ticket (admin) : sert à
 *                                              confirmer les numéros supposés de services/glpi.ts.
 * La configuration est celle du GREFFON "glpi" (plugins/glpi/config.ts), stockée par le socle.
 * GET    /api/glpi/config                  — config REDACTÉE (admin) : jamais appToken/userToken/
 *                                              password, même partiellement.
 * PUT    /api/glpi/config                  — configure/remplace (admin) — teste RÉELLEMENT la
 *                                              connexion avant d'enregistrer (même discipline que
 *                                              PUT /api/hycu/config).
 * POST   /api/glpi/config/test             — teste une config candidate SANS persister (admin).
 * DELETE /api/glpi/config                  — retire la configuration (admin).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectIfPluginDisabled } from "../plugins/activation.js";
import {
  addGlpiFollowupForUser,
  getGlpiStatus,
  getGlpiTicket,
  getGlpiTicketForUser,
  getGlpiTicketSearchOptions,
  GLPI_PAGE_LIMIT_MAX,
  isGlpiConfigured,
  lastKnownGlpiPoll,
  listGlpiTicketsForUser,
  listGlpiTicketsPage,
  releaseGlpiSession,
  resolveGlpiUserByLogin,
  searchGlpiUsers,
  testGlpiConnection,
} from "../services/glpi.js";
import { recordAuditEvent } from "../services/auditLog.js";
import { loadGlpiPluginConfig, removeGlpiPluginConfig, saveGlpiPluginConfig } from "../plugins/glpi/config.js";
import type { SetupGlpiConfig } from "../services/setupStore.js";

/** Même garde locale admin que routes/hycu.ts#rejectIfNotAdmin. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/**
 * Consulter les tickets d'AUTRUI est réservé aux rôles élevés du projet — les mêmes que
 * PRIVILEGED_ROLES de plugins/auth.ts (operator + admin), qui définit déjà "agir sur
 * l'infrastructure" pour toutes les méthodes mutantes, et que routes/console.ts réutilise tel quel
 * pour une lecture sensible (console d'un conteneur). L'assistance GLPI est précisément le travail
 * d'un opérateur ; réserver ces routes au seul admin l'empêcherait de faire son métier sans rien
 * protéger de plus, puisqu'un operator peut déjà écrire dans GLPI. Un viewer, lui, est en lecture
 * de supervision : il n'a aucun titre à lire les tickets de quelqu'un d'autre et reçoit 403.
 */
const PRIVILEGED_ROLES: ReadonlyArray<string> = ["operator", "admin"];

function rejectIfNotPrivileged(request: FastifyRequest, reply: FastifyReply): boolean {
  const roles = request.authSession?.roles ?? [];
  if (!roles.some((role) => PRIVILEGED_ROLES.includes(role))) {
    reply.code(403).send({ error: "Insufficient role: operator or admin required" });
    return true;
  }
  return false;
}

const BROWSE_PREFIX = "/api/glpi/browse/";

function pathnameOf(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/** Entier optionnel d'une query : `undefined` = absent, `null` = fourni mais invalide (-> 400). */
function optionalInt(raw: unknown, min: number, max: number): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

interface GlpiConfigBody {
  apiUrl?: string;
  appToken?: string;
  userToken?: string;
  username?: string;
  password?: string;
}

interface PublicGlpiConfig {
  apiUrl: string;
  authMode: "user-token" | "credentials";
  username?: string;
  /** Booléens de PRÉSENCE uniquement — aucune valeur, aucun préfixe, aucune longueur. */
  hasAppToken: boolean;
  hasUserToken: boolean;
  hasPassword: boolean;
}

/** Projection publique : les secrets ne sortent JAMAIS, même tronqués (voir en-tête). */
function toPublicConfig(cfg: SetupGlpiConfig): PublicGlpiConfig {
  return {
    apiUrl: cfg.apiUrl,
    authMode: cfg.userToken ? "user-token" : "credentials",
    ...(cfg.username ? { username: cfg.username } : {}),
    hasAppToken: Boolean(cfg.appToken),
    hasUserToken: Boolean(cfg.userToken),
    hasPassword: Boolean(cfg.password),
  };
}

/** Fusionne le corps reçu avec l'existant : un secret vide/absent CONSERVE celui déjà enregistré
 * (même convention que PUT /api/hycu/config — reconfigurer l'URL sans ressaisir les jetons). */
function mergeCandidate(body: GlpiConfigBody, existing: SetupGlpiConfig | null): SetupGlpiConfig {
  const apiUrl = body.apiUrl?.trim() || existing?.apiUrl || "";
  const appToken = body.appToken?.trim() || existing?.appToken || "";
  const userToken = body.userToken?.trim() || existing?.userToken;
  const username = body.username?.trim() ?? existing?.username;
  const password = body.password?.trim() || existing?.password;
  return {
    apiUrl,
    appToken,
    // userToken prioritaire : s'il est fourni, on n'entraîne pas d'ambiguïté avec un couple
    // login/mot de passe résiduel.
    ...(userToken ? { userToken } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function parseTicketId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Cible réellement consultée, pour le journal d'audit — jamais la query brute du client. */
function auditTargetOf(request: FastifyRequest): string {
  const pathname = pathnameOf(request.url);
  if (pathname !== `${BROWSE_PREFIX}tickets`) return pathname;
  const requesterId = (request.query as { requesterId?: unknown } | undefined)?.requesterId;
  if (requesterId === undefined || requesterId === "") return `${pathname}?scope=all`;
  // Valeur tronquée : même refusée en 400, elle vient du client et ne doit pas gonfler le journal.
  return `${pathname}?requesterId=${String(requesterId).slice(0, 32)}`;
}

/** Un module en pause ne sert plus ses données ; sa configuration reste lisible pour le réactiver. */
async function rejectIfDisabled(reply: FastifyReply): Promise<boolean> {
  return await rejectIfPluginDisabled(reply, "glpi", "Assistance GLPI");
}

export default async function glpiRoutes(fastify: FastifyInstance): Promise<void> {
  // Garde de PRÉFIXE : toute route /api/glpi/browse/*, y compris une future, exige operator/admin.
  fastify.addHook("preHandler", async (request, reply) => {
    if (!pathnameOf(request.url).startsWith(BROWSE_PREFIX)) return;
    if (rejectIfNotPrivileged(request, reply)) return reply;
  });

  // Lire les tickets d'autrui laisse une trace nominative (même forme que plugins/audit.ts, qui ne
  // journalise que les méthodes mutantes) — y compris les 403 : une tentative refusée se voit.
  fastify.addHook("onResponse", async (request, reply) => {
    if (!pathnameOf(request.url).startsWith(`${BROWSE_PREFIX}tickets`)) return;
    if (!request.authSession) return;
    await recordAuditEvent({
      actor: request.authSession.username,
      actorDisplayName: request.authSession.displayName,
      method: request.method,
      path: auditTargetOf(request),
      statusCode: reply.statusCode,
      ok: reply.statusCode < 400,
    });
  });

  fastify.get<{ Querystring: { q?: string; offset?: string; limit?: string } }>(
    "/api/glpi/browse/accounts",
    async (request, reply) => {
      if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });
      const offset = optionalInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInt(request.query.limit, 1, GLPI_PAGE_LIMIT_MAX);
      if (offset === null || limit === null) {
        return reply.code(400).send({ error: `offset must be >= 0 and limit between 1 and ${GLPI_PAGE_LIMIT_MAX}` });
      }
      try {
        const page = await searchGlpiUsers(request.query.q ?? "", {
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return reply.send({ configured: true, reachable: true, ...page });
      } catch (err) {
        return reply.code(502).send({
          configured: true,
          reachable: false,
          users: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  fastify.get<{ Querystring: { requesterId?: string; offset?: string; limit?: string; openOnly?: string } }>(
    "/api/glpi/browse/tickets",
    async (request, reply) => {
      if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });
      const requesterId = optionalInt(request.query.requesterId, 1, Number.MAX_SAFE_INTEGER);
      const offset = optionalInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInt(request.query.limit, 1, GLPI_PAGE_LIMIT_MAX);
      if (requesterId === null) return reply.code(400).send({ error: "requesterId must be a positive integer" });
      if (offset === null || limit === null) {
        return reply.code(400).send({ error: `offset must be >= 0 and limit between 1 and ${GLPI_PAGE_LIMIT_MAX}` });
      }
      try {
        const page = await listGlpiTicketsPage({
          ...(requesterId !== undefined ? { requesterId } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(request.query.openOnly === "true" ? { openOnly: true } : {}),
        });
        return reply.send({
          configured: true,
          reachable: true,
          scope: requesterId !== undefined ? "requester" : "all",
          ...(requesterId !== undefined ? { requesterId } : {}),
          ...page,
        });
      } catch (err) {
        return reply.code(502).send({
          configured: true,
          reachable: false,
          tickets: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/glpi/browse/tickets/:id", async (request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    const ticketId = parseTicketId(request.params.id);
    if (ticketId === null) return reply.code(400).send({ error: "Ticket id must be a positive integer" });
    if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });
    try {
      const ticket = await getGlpiTicket(ticketId);
      if (!ticket) return reply.code(404).send({ error: `Ticket ${ticketId} introuvable` });
      return reply.send(ticket);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/glpi/status", async (_request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    const status = await getGlpiStatus();
    const lastPoll = lastKnownGlpiPoll();
    return reply.send({ ...status, ...(lastPoll ? { lastPoll } : {}) });
  });

  fastify.get("/api/glpi/my-tickets", async (request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    if (!(await isGlpiConfigured())) {
      return reply.send({ configured: false, tickets: [] });
    }
    // L'identifiant provient EXCLUSIVEMENT de la session QUAI : aucun paramètre client ne peut
    // désigner un autre utilisateur.
    const username = request.authSession!.username;
    try {
      const match = await resolveGlpiUserByLogin(username);
      if (match.outcome === "not-found") {
        return reply.send({ configured: true, reachable: true, account: "not-found", tickets: [] });
      }
      if (match.outcome === "ambiguous") {
        // Plusieurs comptes GLPI portent ce login : on refuse de choisir (jamais de rapprochement
        // approximatif silencieux). Seul le NOMBRE est exposé, pas les ids d'autres comptes.
        return reply.send({
          configured: true,
          reachable: true,
          account: "ambiguous",
          candidateCount: match.candidateIds.length,
          tickets: [],
        });
      }
      const tickets = await listGlpiTicketsForUser(match.userId);
      return reply.send({ configured: true, reachable: true, account: "found", tickets });
    } catch (err) {
      return reply.code(502).send({
        configured: true,
        reachable: false,
        tickets: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/glpi/tickets/:id", async (request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    const ticketId = parseTicketId(request.params.id);
    if (ticketId === null) return reply.code(400).send({ error: "Ticket id must be a positive integer" });
    if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });

    try {
      const match = await resolveGlpiUserByLogin(request.authSession!.username);
      if (match.outcome !== "found") {
        return reply.code(404).send({ error: `Ticket ${ticketId} introuvable` });
      }
      const ticket = await getGlpiTicketForUser(match.userId, ticketId);
      // `null` = le ticket existe peut-être, mais l'utilisateur n'en est pas demandeur : même
      // réponse que "introuvable", pour ne pas révéler son existence.
      if (!ticket) return reply.code(404).send({ error: `Ticket ${ticketId} introuvable` });
      return reply.send(ticket);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post<{ Params: { id: string }; Body: { content?: string } }>(
    "/api/glpi/tickets/:id/followup",
    async (request, reply) => {
      const ticketId = parseTicketId(request.params.id);
      if (ticketId === null) return reply.code(400).send({ error: "Ticket id must be a positive integer" });
      const content = request.body?.content?.trim();
      if (!content) return reply.code(400).send({ error: "content is required" });
      if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });

      try {
        const match = await resolveGlpiUserByLogin(request.authSession!.username);
        if (match.outcome !== "found") return reply.code(404).send({ error: `Ticket ${ticketId} introuvable` });
        const followupId = await addGlpiFollowupForUser(match.userId, ticketId, content);
        if (followupId === null) return reply.code(404).send({ error: `Ticket ${ticketId} introuvable` });
        return reply.code(201).send({ id: followupId });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  fastify.get("/api/glpi/search-options", async (request, reply) => {
    if (await rejectIfDisabled(reply)) return;
    if (rejectIfNotAdmin(request, reply)) return;
    if (!(await isGlpiConfigured())) return reply.code(503).send({ error: "GLPI n'est pas configuré" });
    try {
      return reply.send(await getGlpiTicketSearchOptions());
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/glpi/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;
    const current = await loadGlpiPluginConfig();
    return reply.send(current ? { configured: true, config: toPublicConfig(current) } : { configured: false });
  });

  fastify.put<{ Body: GlpiConfigBody }>("/api/glpi/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const existing = await loadGlpiPluginConfig();
    const candidate = mergeCandidate(request.body ?? {}, existing);
    if (!candidate.apiUrl || !candidate.appToken) {
      return reply.code(400).send({ error: "apiUrl and appToken are required" });
    }
    if (!candidate.userToken && !(candidate.username && candidate.password)) {
      return reply.code(400).send({ error: "userToken or username+password is required" });
    }

    // Teste réellement la connexion avant d'enregistrer — jamais persisté à l'aveugle.
    const test = await testGlpiConnection(candidate);
    if (!test.ok) return reply.code(400).send({ error: test.message });

    await saveGlpiPluginConfig(candidate);
    // La session en cache appartenait à l'ancienne config : on la libère proprement.
    await releaseGlpiSession();
    return reply.send({ configured: true, config: toPublicConfig(candidate) });
  });

  fastify.post<{ Body: GlpiConfigBody }>("/api/glpi/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;
    const existing = await loadGlpiPluginConfig();
    const result = await testGlpiConnection(mergeCandidate(request.body ?? {}, existing));
    return reply.send(result);
  });

  fastify.delete("/api/glpi/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;
    await releaseGlpiSession();
    await removeGlpiPluginConfig();
    return reply.send({ ok: true });
  });
}
