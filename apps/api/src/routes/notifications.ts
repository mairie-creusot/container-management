/**
 * GET  /api/notifications?since=<ISO 8601>  — événements détectés par le watchdog
 *                                              (services/watchdog.ts), les plus récents
 *                                              d'abord ; `since` optionnel pour ne récupérer
 *                                              que ce qui est postérieur à un événement déjà vu.
 * POST /api/notifications/read-all          — marque tous les événements actuellement connus
 *                                              comme lus (rôle operator/admin, cf. hook global
 *                                              sur les méthodes mutantes).
 */

import type { FastifyInstance } from "fastify";
import { listNotificationEvents, markAllNotificationsRead } from "../services/notificationsStore.js";

export default async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { since?: string } }>("/api/notifications", async (request, reply) => {
    return reply.send(await listNotificationEvents(request.query.since));
  });

  fastify.post("/api/notifications/read-all", async (_request, reply) => {
    await markAllNotificationsRead();
    return reply.send({ ok: true });
  });
}
