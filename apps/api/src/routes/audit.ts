/**
 * GET /api/audit — journal d'audit "qui a fait quoi" (voir services/auditLog.ts). Réservé au
 * rôle admin : expose l'activité de TOUS les utilisateurs, pas seulement la sienne.
 */

import type { FastifyInstance } from "fastify";
import { listAuditEvents } from "../services/auditLog.js";

export default async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/audit", async (request, reply) => {
    if (!request.authSession?.roles.includes("admin")) {
      return reply.code(403).send({ error: "Insufficient role: admin required" });
    }
    return reply.send(await listAuditEvents());
  });
}
