/**
 * GET    /api/volumes             — volumes Docker réels de l'hôte (équivalent `docker volume ls`).
 *                                    `?environmentId=remote-docker:<id>` cible un environnement
 *                                    Docker distant persisté (voir ARCHITECTURE.md §
 *                                    "Environnements Docker distants"), comme GET /api/containers.
 * POST   /api/volumes             — crée un volume nommé (équivalent `docker volume create`), démon local uniquement.
 * DELETE /api/volumes/:name       — supprime un volume (échoue si utilisé par un conteneur, sauf ?force=true).
 * GET    /api/volumes/:name/files — explorateur de fichiers en lecture seule (voir services/docker.ts#listVolumeFiles).
 */

import type { FastifyInstance } from "fastify";
import { createVolume, listVolumeFiles, listVolumes, removeVolume } from "../services/docker.js";
import { remoteDockerIdFromEnvironmentId } from "../utils/environmentId.js";

interface CreateVolumeBody {
  name?: string;
}

export default async function volumesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { environmentId?: string } }>("/api/volumes", async (request, reply) => {
    return reply.send(await listVolumes(remoteDockerIdFromEnvironmentId(request.query?.environmentId)));
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

  // Explorateur de fichiers d'un volume — LECTURE SEULE (voir ARCHITECTURE.md). `path` est
  // validé/normalisé côté service (services/docker.ts#resolveVolumeSubPath) : toute tentative
  // de sortir du volume monté (ex: "../../etc") est rejetée en 400 avant tout appel Docker.
  fastify.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/volumes/:name/files",
    async (request, reply) => {
      try {
        const entries = await listVolumeFiles(request.params.name, request.query.path ?? "");
        return reply.send(entries);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isBadRequest = /Invalid path|Invalid volume name|Path is not a directory/.test(message);
        const isNotFound = /Path not found|Volume ".*" not found/.test(message);
        const status = isBadRequest ? 400 : isNotFound ? 404 : 502;
        return reply.code(status).send({ error: message });
      }
    },
  );
}
