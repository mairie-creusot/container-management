/**
 * GET /api/topology            — graphe visuel de l'infra (conteneurs/volumes/networks/VMs Nutanix
 *                                 + relations réelles).
 * GET /api/topology/positions  — disposition des nœuds déplacés à la main par L'UTILISATEUR
 *                                 CONNECTÉ (préférence d'affichage par compte, pas par appareil —
 *                                 voir services/topologyPositionsStore.ts). {} si rien déplacé.
 * PUT /api/topology/positions  — { positions: Record<nodeId, {x,y}> } remplace la disposition
 *                                 complète de l'utilisateur connecté (operator/admin, cf.
 *                                 plugins/auth.ts — même rôle que nodesDraggable côté frontend).
 */

import type { FastifyInstance } from "fastify";
import { getTopology } from "../services/topology.js";
import { getPositionsForUser, savePositionsForUser, type NodePositions } from "../services/topologyPositionsStore.js";

interface SavePositionsBody {
  positions?: NodePositions;
}

export default async function topologyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/topology", async (_request, reply) => {
    return reply.send(await getTopology());
  });

  fastify.get("/api/topology/positions", async (request, reply) => {
    return reply.send(await getPositionsForUser(request.authSession!.username));
  });

  fastify.put<{ Body: SavePositionsBody }>("/api/topology/positions", async (request, reply) => {
    const positions = request.body?.positions ?? {};
    await savePositionsForUser(request.authSession!.username, positions);
    return reply.send({ ok: true });
  });
}
