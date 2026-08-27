/**
 * GET /api/audit — journal « qui a fait quoi » (voir services/auditLog.ts).
 *
 * Ouvert aux rôles qui AGISSENT sur le parc — admin et operator. Le journal expose l'activité de
 * tous les utilisateurs, et c'est délibéré : une équipe informatique doit voir ce que font ses
 * collègues sur les mêmes machines, sinon deux personnes se marchent dessus sans jamais le savoir.
 * Un `viewer`, qui ne peut rien modifier, n'a pas à consulter l'activité des autres.
 *
 * Le journal ne contient JAMAIS de corps de requête (voir plugins/audit.ts) : ni mot de passe, ni
 * jeton, ni contenu de secret. L'ouvrir plus largement n'expose donc aucune valeur sensible.
 */

import type { FastifyInstance } from "fastify";
import { listAuditEvents } from "../services/auditLog.js";

export default async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/audit", async (request, reply) => {
    const roles = request.authSession?.roles ?? [];
    if (!roles.includes("admin") && !roles.includes("operator")) {
      return reply.code(403).send({ error: "Insufficient role: admin or operator required" });
    }
    return reply.send(await listAuditEvents());
  });
}
