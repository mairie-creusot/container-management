/**
 * GET  /api/images?status=update|uptodate — liste des images suivies.
 * POST /api/images/:id/update             — déclenche la mise à jour explicite d'une image
 *                                            (jamais automatique, cf. ARCHITECTURE.md).
 * GET  /api/images/:id/history            — historique RÉEL des couches (équivalent `docker
 *                                            history`), voir services/docker.ts#getImageHistory.
 */

import type { FastifyInstance } from "fastify";
import { getImageHistory } from "../services/docker.js";
import { deleteImage, getImages, ImageNotFoundError, ImagePullError, pullNewImage, updateImage } from "../services/images.js";
import type { ImageRef } from "../types.js";

/** Référence Docker réelle à passer au démon pour une image suivie (locale ou démo) — même
 * rapprochement par nom que routes/scan.ts#dockerReferenceFor (dupliqué à l'identique, un
 * utilitaire partagé serait disproportionné pour une seule ligne). */
function dockerReferenceFor(image: ImageRef): string {
  return `${image.name}:${image.currentTag}`;
}

function isValidStatus(value: unknown): value is ImageRef["status"] {
  return value === "update" || value === "uptodate";
}

export default async function imagesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { status?: string } }>("/api/images", async (request, reply) => {
    const { status } = request.query;
    if (status !== undefined && !isValidStatus(status)) {
      return reply.code(400).send({ error: 'status must be "update" or "uptodate"' });
    }
    const images = await getImages(isValidStatus(status) ? status : undefined);
    return reply.send(images);
  });

  fastify.post<{ Params: { id: string } }>("/api/images/:id/update", async (request, reply) => {
    try {
      const updated = await updateImage(request.params.id);
      return reply.send(updated);
    } catch (err) {
      if (err instanceof ImageNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/images/:id/history", async (request, reply) => {
    const image = (await getImages()).find((i) => i.id === request.params.id);
    if (!image) return reply.code(404).send({ error: `Image "${request.params.id}" not found` });
    try {
      const history = await getImageHistory(dockerReferenceFor(image));
      return reply.send(history);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  fastify.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/images/:id",
    async (request, reply) => {
      try {
        await deleteImage(request.params.id, request.query.force === "true");
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof ImageNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        const inUse = /image is being used|has dependent child images/i.test(message);
        return reply.code(inUse ? 409 : 502).send({ error: message });
      }
    },
  );

  fastify.post<{ Body: { reference?: string } }>("/api/images/pull", async (request, reply) => {
    const reference = request.body?.reference?.trim();
    if (!reference) {
      return reply.code(400).send({ error: "reference is required (ex: \"redis:7-alpine\")" });
    }
    try {
      await pullNewImage(reference);
      const images = await getImages();
      return reply.send({ ok: true, images });
    } catch (err) {
      if (err instanceof ImagePullError) {
        return reply.code(502).send({ ok: false, error: err.message });
      }
      throw err;
    }
  });
}
