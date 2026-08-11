/**
 * GET    /api/networks     — networks Docker réels de l'hôte (équivalent `docker network ls`).
 * POST   /api/networks     — crée un network (équivalent `docker network create`).
 * DELETE /api/networks/:id — supprime un network.
 */

import type { FastifyInstance } from "fastify";
import { createNetwork, listNetworks, removeNetwork } from "../services/docker.js";

interface CreateNetworkBody {
  name?: string;
  driver?: string;
}

export default async function networksRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/networks", async (_request, reply) => {
    return reply.send(await listNetworks());
  });

  fastify.post<{ Body: CreateNetworkBody }>("/api/networks", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    try {
      const network = await createNetwork(name, request.body?.driver?.trim() || "bridge");
      return reply.code(201).send(network);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  fastify.delete<{ Params: { id: string } }>("/api/networks/:id", async (request, reply) => {
    try {
      await removeNetwork(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const inUse = /has active endpoints/i.test(message);
      return reply.code(inUse ? 409 : 502).send({ error: message });
    }
  });
}
