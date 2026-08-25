/**
 * GET /api/plugins — greffons RÉELLEMENT enregistrés et leur manifeste PUBLIC : ni secret, ni
 * valeur de configuration (voir plugins/registry.ts#listPluginManifests). Liste vide tant
 * qu'aucune intégration n'est migrée vers le socle, jamais une liste d'exemples.
 */

import type { FastifyInstance } from "fastify";
import { listPluginManifests } from "../plugins/registry.js";

export default async function pluginsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/plugins", async (_request, reply) => {
    return reply.send({ plugins: listPluginManifests() });
  });
}
