/**
 * Hook global protégeant toutes les routes /api/* sauf /api/auth/* et /api/setup/*
 * (tant que l'assistant de configuration n'est pas terminé — cf. ARCHITECTURE.md,
 * chapitre "Assistant de configuration au premier lancement").
 *
 * - 401 si aucune session valide (cookie de session absent, invalide ou expiré).
 * - 403 si la méthode est mutante (POST/PUT/PATCH/DELETE) et que l'utilisateur n'a ni le
 *   rôle "operator" ni le rôle "admin" (cf. ARCHITECTURE.md : "Les routes POST exigent le
 *   rôle operator ou admin").
 * - /api/setup/* : ouvert (aucune session requise) UNIQUEMENT lors d'un vrai premier démarrage
 *   (`completed=false` ET l'assistant n'a JAMAIS été terminé une seule fois — voir setupStore.ts#
 *   everCompleted/hasEverCompletedSetup). Dès que l'assistant a été terminé au moins une fois —
 *   y compris temporairement rouvert par un admin via POST /api/setup/reset (`completed` repasse
 *   à false, mais `everCompleted` reste true) — exige une session avec le rôle "admin" (401 sans
 *   session, 403 si authentifié mais pas admin) : sans cette distinction, la fenêtre de
 *   reconfiguration laissait POST /api/setup/complete accessible sans authentification, permettant
 *   à quiconque sur le réseau de prendre le contrôle admin de l'instance (corrigé le 12/08/2026,
 *   voir docs/reports/security-audit-2026-08-12.md, finding C1). Exception : GET /api/setup/status
 *   (juste { completed, ...booléens }, aucun secret) n'exige qu'une session valide, quel que soit
 *   le rôle — appelé par tout utilisateur à chaque chargement de l'app pour savoir si l'assistant
 *   doit s'afficher.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config.js";
import { verifySessionToken } from "../services/session.js";
import { hasEverCompletedSetup, isSetupCompleted } from "../services/setupStore.js";
import type { Session } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    authSession?: Session;
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PRIVILEGED_ROLES: ReadonlyArray<Session["roles"][number]> = ["operator", "admin"];

function pathnameOf(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isPublicAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/api/auth/");
}

/**
 * POST /api/github/webhook (déploiement automatique sur push, cf. routes/githubWebhook.ts) :
 * appelé directement par GitHub, qui n'a évidemment pas de cookie de session QUAI — authentifié
 * à la place par une signature HMAC (`X-Hub-Signature-256`) vérifiée dans la route elle-même.
 * Exception minimale et ciblée, même esprit que isPublicAuthRoute ci-dessus.
 */
function isGithubWebhookRoute(pathname: string): boolean {
  return pathname === "/api/github/webhook";
}

/** Authentifie la requête courante (401/403 envoyés directement) ; retourne true si elle doit s'arrêter là. */
async function requireSession(request: FastifyRequest, reply: FastifyReply, requireAdmin: boolean): Promise<boolean> {
  const token = request.cookies[config.session.cookieName];
  if (!token) {
    await reply.code(401).send({ error: "Authentication required" });
    return true;
  }

  try {
    const payload = verifySessionToken(token);
    request.authSession = { username: payload.username, displayName: payload.displayName, roles: payload.roles };
  } catch {
    await reply.code(401).send({ error: "Invalid or expired session" });
    return true;
  }

  if (requireAdmin && !request.authSession.roles.includes("admin")) {
    await reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }

  return false;
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = pathnameOf(request.url);
    if (!pathname.startsWith("/api/")) return;
    if (isPublicAuthRoute(pathname)) return;
    if (isGithubWebhookRoute(pathname) && request.method === "POST") return;

    if (pathname.startsWith("/api/setup/")) {
      const completed = await isSetupCompleted();
      // Un VRAI premier démarrage (jamais terminé une seule fois) reste ouvert, aucune session
      // requise — c'est le seul cas légitime. Une réouverture par un admin (POST /api/setup/reset,
      // `completed` redevenu false mais `everCompleted` toujours true) exige au contraire une
      // session comme le reste de cette route : sans cette distinction, POST /api/setup/complete
      // redevenait accessible sans authentification pendant toute la fenêtre de reconfiguration
      // (voir docs/reports/security-audit-2026-08-12.md, finding C1).
      if (!completed && !(await hasEverCompletedSetup())) return;

      // GET /api/setup/status ne renvoie que { completed, ...booléens } (aucun secret, voir
      // routes/setup.ts) et TOUT utilisateur authentifié en a besoin à chaque chargement de
      // l'app pour savoir si l'assistant doit s'afficher — l'exiger admin ici (comme pour
      // /complete et /reset, qui reconfigurent réellement) ne fait que 403 systématiquement
      // les non-admins sans aucun bénéfice de sécurité.
      const isStatusRead = pathname === "/api/setup/status" && request.method === "GET";
      const stopped = await requireSession(request, reply, !isStatusRead);
      if (stopped) return reply;
      return;
    }

    const stopped = await requireSession(request, reply, false);
    if (stopped) return reply;

    if (MUTATING_METHODS.has(request.method)) {
      const hasPrivilegedRole = request.authSession!.roles.some((role) => PRIVILEGED_ROLES.includes(role));
      if (!hasPrivilegedRole) {
        await reply.code(403).send({ error: "Insufficient role: operator or admin required" });
        return reply;
      }
    }
  });
}

export default fp(authPlugin, { name: "auth" });
