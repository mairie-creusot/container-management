/**
 * Journalise automatiquement toute requête mutante (POST/PUT/PATCH/DELETE) faite par un
 * utilisateur authentifié — capture générique via un hook `onResponse`, plutôt que d'appeler
 * recordAuditEvent() manuellement dans chaque route (même principe que
 * apps/web/src/features/notifications/errorNotificationMiddleware.ts côté frontend : un
 * nouvel endpoint mutant est audité automatiquement, sans rien à câbler).
 *
 * S'exécute après authPlugin (voir index.ts) : `request.authSession` est déjà résolu à ce
 * stade si la requête est authentifiée. Les requêtes non authentifiées (401 avant d'atteindre
 * un vrai handler) ne sont pas journalisées ici — /api/auth/login est auditée séparément dans
 * routes/auth.ts (succès ET échecs, avant même qu'une session n'existe).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { recordAuditEvent } from "../services/auditLog.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function pathnameOf(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

async function auditPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const pathname = pathnameOf(request.url);
    if (pathname.startsWith("/api/auth/")) return; // auditée séparément (voir routes/auth.ts)
    if (!request.authSession) return; // requête rejetée avant authentification (401) : rien à tracer côté "qui"

    await recordAuditEvent({
      actor: request.authSession.username,
      actorDisplayName: request.authSession.displayName,
      method: request.method,
      path: pathname,
      statusCode: reply.statusCode,
      ok: reply.statusCode < 400,
    });
  });
}

export default fp(auditPlugin, { name: "audit" });
