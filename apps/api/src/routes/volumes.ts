/**
 * GET    /api/volumes       — volumes Docker réels de l'hôte (équivalent `docker volume ls`).
 * POST   /api/volumes       — crée un volume nommé (équivalent `docker volume create`).
 * DELETE /api/volumes/:name — supprime un volume (échoue si utilisé par un conteneur, sauf ?force=true).
 */

import type { FastifyInstance } from "fastify";
import { createVolume, listVolumes, removeVolume } from "../services/docker.js";

interface CreateVolumeBody {
  name?: string;
}

export default async function volumesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/volumes", async (_request, reply) => {
    return reply.send(await listVolumes());
  });

  fastify.post<{ Body: CreateVolumeBody }>("/api/volumes", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    try {
      const volume = await createVolume(name);
      return reply.code(201).send(volume);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  fastify.delete<{ Params: { name: string } }>("/api/volumes/:name", async (request, reply) => {
    try {
      await removeVolume(request.params.name);
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const inUse = /volume is in use/i.test(message);
      return reply.code(inUse ? 409 : 502).send({ error: message });
    }
  });
}
