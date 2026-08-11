/**
 * GET  /api/registries                          — liste des registries suivis.
 * POST /api/registries                          — ajoute un registry (rôle operator/admin requis, cf. hook global).
 * GET  /api/registries/:id                      — détail d'un registry.
 * GET  /api/registries/:id/repositories          — vrai catalogue distant (pas juste le local).
 * GET  /api/registries/:id/repositories/:repo/tags — tags d'un dépôt du catalogue (:repo encodé, cf. gitops.ts).
 */

import type { FastifyInstance } from "fastify";
import { createRegistry, getPersistedRegistryConfig, getRegistry, listRegistries } from "../services/registriesStore.js";
import { listRegistryRepositories, listTagsForImage } from "../services/registries/index.js";
import type { RegistryKind } from "../types.js";

const VALID_KINDS: readonly RegistryKind[] = ["dockerhub", "ghcr", "gitlab", "harbor"];

interface CreateRegistryBody {
  kind?: string;
  name?: string;
  url?: string;
}

export default async function registriesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/registries", async (_request, reply) => {
    return reply.send(await listRegistries());
  });

  fastify.post<{ Body: CreateRegistryBody }>("/api/registries", async (request, reply) => {
    const { kind, name, url } = request.body ?? {};
    if (!kind || !name || !url) {
      return reply.code(400).send({ error: "kind, name and url are required" });
    }
    if (!VALID_KINDS.includes(kind as RegistryKind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` });
    }
    const registry = await createRegistry({ kind: kind as RegistryKind, name, url });
    return reply.code(201).send(registry);
  });

  fastify.get<{ Params: { id: string } }>("/api/registries/:id", async (request, reply) => {
    const registry = await getRegistry(request.params.id);
    if (!registry) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    return reply.send(registry);
  });

  fastify.get<{ Params: { id: string } }>("/api/registries/:id/repositories", async (request, reply) => {
    const persisted = await getPersistedRegistryConfig(request.params.id);
    if (!persisted) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    // Le "username" persisté est l'identité d'authentification (ex: un email pour GHCR), pas
    // forcément l'org/namespace du catalogue à parcourir — ne le passer qu'à Docker Hub, où
    // il correspond bien au namespace (compte perso/org Docker Hub). Pour GHCR, laisser
    // resolveOrg() déduire l'org depuis une image locale déjà tirée (voir ghcr.ts).
    const namespace = persisted.kind === "dockerhub" ? persisted.username : undefined;
    const repositories = await listRegistryRepositories(persisted.kind, namespace);
    return reply.send({ repositories });
  });

  fastify.get<{ Params: { id: string; repo: string } }>(
    "/api/registries/:id/repositories/:repo/tags",
    async (request, reply) => {
      const persisted = await getPersistedRegistryConfig(request.params.id);
      if (!persisted) {
        return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
      }
      const tags = await listTagsForImage({ name: request.params.repo, registry: persisted.kind });
      return reply.send({ repository: request.params.repo, tags });
    },
  );
}
