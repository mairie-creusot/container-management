/**
 * Scan de vulnérabilités (Grype réel, voir services/scan.ts).
 *
 * POST /api/images/:id/scan   — lance un scan (operator/admin, cf. plugins/auth.ts).
 * GET  /api/images/:id/scans  — historique des scans d'une image.
 * GET  /api/scans/:scanId     — détail + statut d'un scan (à poller pendant qu'il tourne).
 *
 * L'id d'image (ImageRef.id, ex: "local:ghcr.io/org/app:1.0") contient des "/" : comme pour
 * GET /api/gitops/files/:path/diff (voir routes/gitops.ts), le client doit URL-encoder :id
 * (encodeURIComponent) et Fastify le décode automatiquement côté serveur — pas de décodage
 * manuel ici, sous peine de double-décodage.
 */

import type { FastifyInstance } from "fastify";
import { getImages } from "../services/images.js";
import { getScan, listScansForImage, startScan } from "../services/scan.js";
import type { ImageRef } from "../types.js";

/** Référence Docker réelle à passer à Grype pour une image suivie (locale ou démo). */
function dockerReferenceFor(image: ImageRef): string {
  return `${image.name}:${image.currentTag}`;
}

export default async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string } }>("/api/images/:id/scan", async (request, reply) => {
    const image = (await getImages()).find((i) => i.id === request.params.id);
    if (!image) return reply.code(404).send({ error: `Image "${request.params.id}" not found` });
    const scan = await startScan(dockerReferenceFor(image));
    return reply.code(201).send(scan);
  });

  fastify.get<{ Params: { id: string } }>("/api/images/:id/scans", async (request, reply) => {
    const image = (await getImages()).find((i) => i.id === request.params.id);
    if (!image) return reply.code(404).send({ error: `Image "${request.params.id}" not found` });
    const scans = await listScansForImage(dockerReferenceFor(image));
    return reply.send(scans);
  });

  fastify.get<{ Params: { scanId: string } }>("/api/scans/:scanId", async (request, reply) => {
    const scan = await getScan(request.params.scanId);
    if (!scan) return reply.code(404).send({ error: `Scan "${request.params.scanId}" not found` });
    return reply.send(scan);
  });
}
