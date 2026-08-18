// Recherches réelles pour le studio de templates : paquets (Repology) et images publiques
// Docker Hub — voir services/packageSearch.ts et services/dockerHubSearch.ts.

import type { FastifyInstance } from "fastify";
import { searchPackages, repoPrefixForDistro } from "../services/packageSearch.js";
import { listDockerHubTags, searchDockerHubImages } from "../services/dockerHubSearch.js";

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

  fastify.get<{ Querystring: { q?: string } }>("/api/dockerhub/search", async (request, reply) => {
    const { q } = request.query;
    if (!q || q.trim().length < 2) return reply.code(400).send({ error: "q must be at least 2 characters" });
    try {
      return reply.send({ results: await searchDockerHubImages(q.trim()) });
    } catch (err) {
      return reply.code(502).send({ error: `Recherche Docker Hub indisponible : ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  fastify.get<{ Querystring: { repo?: string } }>("/api/dockerhub/tags", async (request, reply) => {
    const { repo } = request.query;
    if (!repo?.trim()) return reply.code(400).send({ error: "repo is required" });
    try {
      return reply.send({ tags: await listDockerHubTags(repo.trim()) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Invalid repository")) return reply.code(400).send({ error: message });
      return reply.code(502).send({ error: `Tags Docker Hub indisponibles : ${message}` });
    }
  });
}
