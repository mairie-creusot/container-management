/** GET /api/topology — graphe visuel de l'infra (conteneurs/volumes/networks + relations réelles). */

import type { FastifyInstance } from "fastify";
import { getTopology } from "../services/topology.js";

export default async function topologyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/topology", async (_request, reply) => {
    return reply.send(await getTopology());
  });
}
