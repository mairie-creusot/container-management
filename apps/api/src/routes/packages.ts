// Recherche réelle de paquets pour le studio de templates — voir services/packageSearch.ts.

import type { FastifyInstance } from "fastify";
import { searchPackages, repoPrefixForDistro } from "../services/packageSearch.js";

export default async function packagesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { distro?: string; q?: string } }>("/api/packages/search", async (request, reply) => {
    const { distro, q } = request.query;
    if (!distro || !repoPrefixForDistro(distro)) {
      return reply.code(400).send({ error: "distro must be one of: debian, ubuntu, alpine, fedora, arch" });
    }
    if (!q || q.trim().length < 2) return reply.code(400).send({ error: "q must be at least 2 characters" });
    try {
      return reply.send({ results: await searchPackages(distro, q.trim()), source: "repology" });
    } catch (err) {
      return reply.code(502).send({ error: `Recherche de paquets indisponible : ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
