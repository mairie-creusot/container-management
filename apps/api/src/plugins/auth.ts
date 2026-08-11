/**
 * Hook global protégeant toutes les routes /api/* sauf /api/auth/* et /api/setup/*
 * (tant que l'assistant de configuration n'est pas terminé — cf. ARCHITECTURE.md,
 * chapitre "Assistant de configuration au premier lancement").
 *
 * - 401 si aucune session valide (cookie de session absent, invalide ou expiré).
 * - 403 si la méthode est mutante (POST/PUT/PATCH/DELETE) et que l'utilisateur n'a ni le
 *   rôle "operator" ni le rôle "admin" (cf. ARCHITECTURE.md : "Les routes POST exigent le
 *   rôle operator ou admin").
 * - /api/setup/* : ouvert (aucune session requise) tant que `completed=false` ; une fois
 *   `completed=true`, exige une session avec le rôle "admin" (401 sans session, 403 si
 *   authentifié mais pas admin) — flux de reconfiguration réservé aux admins. Exception :
 *   GET /api/setup/status (juste { completed, ...booléens }, aucun secret) n'exige qu'une
 *   session valide, quel que soit le rôle — appelé par tout utilisateur à chaque chargement
 *   de l'app pour savoir si l'assistant doit s'afficher.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config.js";
import { verifySessionToken } from "../services/session.js";
import { isSetupCompleted } from "../services/setupStore.js";
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

    if (pathname.startsWith("/api/setup/")) {
      const completed = await isSetupCompleted();
      if (!completed) return; // assistant en cours : ouvert, aucune session requise

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
