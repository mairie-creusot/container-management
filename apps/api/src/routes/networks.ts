/**
 * GET    /api/networks             — networks Docker réels de l'hôte (équivalent `docker network ls`).
 * POST   /api/networks             — crée un network (équivalent `docker network create`).
 * DELETE /api/networks/:id         — supprime un network.
 * POST   /api/networks/:id/connect    — attache un conteneur au network (équivalent `docker network connect`).
 * POST   /api/networks/:id/disconnect — détache un conteneur du network (équivalent `docker network disconnect`).
 *                                        Utilisées par l'éditeur visuel de topologie (glisser-connecter).
 */

import type { FastifyInstance } from "fastify";
import {
  connectContainerToNetwork,
  createNetwork,
  disconnectContainerFromNetwork,
  listNetworks,
  removeNetwork,
} from "../services/docker.js";

interface CreateNetworkBody {
  name?: string;
  driver?: string;
}

interface NetworkMembershipBody {
  containerId?: string;
}

/** Traduit une erreur dockerode en réponse HTTP — 404 si le network/conteneur n'existe plus, 502 sinon. */
function sendNetworkMembershipError(reply: import("fastify").FastifyReply, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const notFound = /no such network|no such container|404/i.test(message);
  reply.code(notFound ? 404 : 502).send({ error: message });
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

  fastify.post<{ Params: { id: string }; Body: NetworkMembershipBody }>(
    "/api/networks/:id/connect",
    async (request, reply) => {
      const containerId = request.body?.containerId?.trim();
      if (!containerId) {
        return reply.code(400).send({ error: "containerId is required" });
      }
      try {
        await connectContainerToNetwork(request.params.id, containerId);
        return reply.send({ ok: true });
      } catch (err) {
        sendNetworkMembershipError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: NetworkMembershipBody }>(
    "/api/networks/:id/disconnect",
    async (request, reply) => {
      const containerId = request.body?.containerId?.trim();
      if (!containerId) {
        return reply.code(400).send({ error: "containerId is required" });
      }
      try {
        await disconnectContainerFromNetwork(request.params.id, containerId);
        return reply.send({ ok: true });
      } catch (err) {
        sendNetworkMembershipError(reply, err);
      }
    },
  );
}
