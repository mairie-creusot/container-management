/**
 * GET /api/environments             — liste des environnements (Prod/Swarm, Staging/K8s, Dev local/Compose).
 * GET /api/environments/:id/nodes   — nœuds d'un environnement donné.
 */

import type { FastifyInstance } from "fastify";
import { getAllEnvironments } from "../services/environments.js";

export default async function environmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/environments", async (_request, reply) => {
    const environments = await getAllEnvironments();
    return reply.send(environments);
  });

  fastify.get<{ Params: { id: string } }>("/api/environments/:id/nodes", async (request, reply) => {
    const environments = await getAllEnvironments();
    const environment = environments.find((e) => e.id === request.params.id);
    if (!environment) {
      return reply.code(404).send({ error: `Environment "${request.params.id}" not found` });
    }
    return reply.send(environment.nodes);
  });
}
