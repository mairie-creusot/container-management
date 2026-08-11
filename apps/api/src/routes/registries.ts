/**
 * GET  /api/registries      — liste des registries suivis.
 * POST /api/registries      — ajoute un registry (rôle operator/admin requis, cf. hook global).
 * GET  /api/registries/:id  — détail d'un registry.
 */

import type { FastifyInstance } from "fastify";
import { createRegistry, getRegistry, listRegistries } from "../services/registriesStore.js";
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
}
