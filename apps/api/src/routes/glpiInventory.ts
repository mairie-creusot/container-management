/**
 * Réconciliation d'inventaire QUAI <-> GLPI — voir services/glpiInventory.ts.
 *
 * GET   /api/glpi/inventory/diff              — écart complet (tout rôle authentifié).
 * POST  /api/glpi/inventory/computers         — crée la fiche GLPI d'une ressource réelle.
 * PATCH /api/glpi/inventory/computers/:id     — aligne les champs dérivés sur le réel.
 * Aucune route de SUPPRESSION : une fiche obsolète est signalée, jamais supprimée (décision humaine).
 * Le gate operator/admin des méthodes mutantes est celui de plugins/auth.ts, pas redéfini ici.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  GlpiInventoryError,
  createGlpiComputerForResource,
  getGlpiInventoryDiff,
  updateGlpiComputerForResource,
} from "../services/glpiInventory.js";
import type { InventoryField } from "../services/glpiInventory.js";

const KNOWN_FIELDS: ReadonlyArray<InventoryField> = ["name", "uuid", "serial", "vcpu", "memoryMib", "ipAddresses", "operatingSystem", "host"];

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GlpiInventoryError) return reply.code(err.httpStatus).send({ error: err.message });
  return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
}

function parseFields(raw: unknown): InventoryField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fields = raw.filter((value): value is InventoryField => KNOWN_FIELDS.includes(value as InventoryField));
  return fields.length > 0 ? fields : undefined;
}

interface CreateBody {
  resourceId?: string;
}

interface UpdateBody {
  resourceId?: string;
  fields?: unknown;
}

export default async function glpiInventoryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/glpi/inventory/diff", async (_request, reply) => {
    try {
      return reply.send(await getGlpiInventoryDiff());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post<{ Body: CreateBody }>("/api/glpi/inventory/computers", async (request, reply) => {
    const resourceId = request.body?.resourceId?.trim();
    if (!resourceId) return reply.code(400).send({ error: "resourceId is required" });
    try {
      return reply.code(201).send(await createGlpiComputerForResource(resourceId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateBody }>("/api/glpi/inventory/computers/:id", async (request, reply) => {
    const computerId = Number(request.params.id);
    if (!Number.isInteger(computerId) || computerId <= 0) return reply.code(400).send({ error: "id must be a positive integer" });
    const resourceId = request.body?.resourceId?.trim();
    if (!resourceId) return reply.code(400).send({ error: "resourceId is required" });

    try {
      const fields = parseFields(request.body?.fields);
      return reply.send(await updateGlpiComputerForResource(computerId, resourceId, fields));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
