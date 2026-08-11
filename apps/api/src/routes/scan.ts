/**
 * Scan de vulnérabilités (Grype + OSV-Scanner réels, voir services/scan.ts).
 *
 * POST /api/images/:id/scan     — lance un scan (operator/admin, cf. plugins/auth.ts). Body
 *                                  optionnel { scanner?: "grype" | "osv-scanner" }, "grype" par
 *                                  défaut si absent — ne change rien pour les clients existants.
 * GET  /api/images/:id/scans    — historique des scans d'une image, tous scanners confondus.
 * GET  /api/scans/:scanId       — détail + statut d'un scan (à poller pendant qu'il tourne).
 * GET  /api/scanners/status     — présence + version des binaires grype/osv-scanner sur l'hôte.
 *
 * L'id d'image (ImageRef.id, ex: "local:ghcr.io/org/app:1.0") contient des "/" : comme pour
 * GET /api/gitops/files/:path/diff (voir routes/gitops.ts), le client doit URL-encoder :id
 * (encodeURIComponent) et Fastify le décode automatiquement côté serveur — pas de décodage
 * manuel ici, sous peine de double-décodage.
 */

import type { FastifyInstance } from "fastify";
import { getImages } from "../services/images.js";
import { getScan, listScannerStatuses, listScansForImage, startScan } from "../services/scan.js";
import type { ImageRef, ScannerId } from "../types.js";

/** Référence Docker réelle à passer au scanner pour une image suivie (locale ou démo). */
function dockerReferenceFor(image: ImageRef): string {
  return `${image.name}:${image.currentTag}`;
}

const KNOWN_SCANNERS: readonly ScannerId[] = ["grype", "osv-scanner"];

/** Corps optionnel { scanner? } -> ScannerId valide, "grype" par défaut/si valeur inconnue. */
function scannerFromBody(body: unknown): ScannerId {
  const requested = body && typeof body === "object" ? (body as { scanner?: unknown }).scanner : undefined;
  return typeof requested === "string" && (KNOWN_SCANNERS as readonly string[]).includes(requested)
    ? (requested as ScannerId)
    : "grype";
}

export default async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string }; Body: { scanner?: ScannerId } | undefined }>(
    "/api/images/:id/scan",
    async (request, reply) => {
      const image = (await getImages()).find((i) => i.id === request.params.id);
      if (!image) return reply.code(404).send({ error: `Image "${request.params.id}" not found` });
      const scanner = scannerFromBody(request.body);
      const scan = await startScan(dockerReferenceFor(image), scanner);
      return reply.code(201).send(scan);
    },
  );

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

  fastify.get("/api/scanners/status", async (_request, reply) => {
    return reply.send(await listScannerStatuses());
  });
}
