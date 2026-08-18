// Recherches réelles pour le studio de templates : paquets (Repology) et images publiques
// Docker Hub — voir services/packageSearch.ts et services/dockerHubSearch.ts.

import type { FastifyInstance } from "fastify";
import { searchPackages, repoPrefixForDistro } from "../services/packageSearch.js";
import { listDockerHubTags, searchDockerHubImages } from "../services/dockerHubSearch.js";
import { CLOUD_IMAGE_CATALOG, checkCloudImageUrl } from "../services/cloudImageCatalog.js";

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

  fastify.get("/api/cloud-images", async (_request, reply) => {
    return reply.send({ distros: CLOUD_IMAGE_CATALOG });
  });

  // HEAD réel sur les miroirs officiels uniquement (anti-SSRF) — jamais un lien affirmé sans preuve.
  fastify.get<{ Querystring: { url?: string } }>("/api/cloud-images/check", async (request, reply) => {
    const { url } = request.query;
    if (!url?.trim()) return reply.code(400).send({ error: "url is required" });
    try {
      return reply.send(await checkCloudImageUrl(url.trim()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Invalid URL") || message.startsWith("Only official")) return reply.code(400).send({ error: message });
      return reply.code(502).send({ error: `Vérification indisponible : ${message}` });
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
