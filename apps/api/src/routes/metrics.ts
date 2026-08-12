/**
 * GET /api/containers/:id/metrics?since=<ISO 8601>&until=<ISO 8601> — série temporelle
 * CPU/mémoire d'un conteneur, alimentée en tâche de fond par services/metricsCollector.ts (voir
 * ARCHITECTURE.md, priorité #5 du rapport concurrentiel). Ouvert à toute session authentifiée
 * (lecture seule d'une donnée de diagnostic, pas plus sensible que GET /api/containers/:id).
 *
 * `since`/`until` optionnels — sans eux, renvoie tout l'historique connu (borné naturellement par
 * la fenêtre glissante de rétention, cf. config.metrics.retentionMs). Aucune vérification que le
 * conteneur existe encore : un conteneur supprimé peut légitimement avoir un historique de
 * métriques consultable (même principe qu'un scan d'image dont l'image a depuis été supprimée).
 */

import type { FastifyInstance } from "fastify";
import { listContainerMetrics } from "../services/metricsCollector.js";

interface MetricsQuery {
  since?: string;
  until?: string;
}

export default async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string }; Querystring: MetricsQuery }>(
    "/api/containers/:id/metrics",
    async (request, reply) => {
      const { since, until } = request.query;
      const points = await listContainerMetrics(request.params.id, since, until);
      return reply.send(points);
    },
  );
}
