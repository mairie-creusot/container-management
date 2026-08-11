/**
 * GET /api/topology            — graphe visuel de l'infra (conteneurs/volumes/networks/VMs Nutanix
 *                                 + relations réelles).
 * GET /api/topology/positions  — disposition des nœuds déplacés à la main par L'UTILISATEUR
 *                                 CONNECTÉ (préférence d'affichage par compte, pas par appareil —
 *                                 voir services/topologyPositionsStore.ts). {} si rien déplacé.
 *                                 Purge d'abord silencieusement les entrées dont l'id de nœud
 *                                 n'existe plus dans le graphe RÉEL actuel (conteneur supprimé,
 *                                 volume/network nettoyé...) — "au chargement, être sûr de
 *                                 remettre les bons trucs connectés" : jamais de position fantôme
 *                                 qui traîne indéfiniment (voir purgeStalePositions).
 * PUT /api/topology/positions  — { positions: Record<nodeId, {x,y}> } remplace la disposition
 *                                 complète de l'utilisateur connecté (operator/admin, cf.
 *                                 plugins/auth.ts — même rôle que nodesDraggable côté frontend).
 */

import type { FastifyInstance } from "fastify";
import { getTopology } from "../services/topology.js";
import {
  purgeStalePositions,
  savePositionsForUser,
  type NodePositions,
} from "../services/topologyPositionsStore.js";

interface SavePositionsBody {
  positions?: NodePositions;
}

export default async function topologyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/topology", async (_request, reply) => {
    return reply.send(await getTopology());
  });

  fastify.get("/api/topology/positions", async (request, reply) => {
    // Graphe actuel calculé côté serveur (mêmes données que GET /api/topology) pour purger toute
    // position dont l'id de nœud n'y apparaît plus avant de la renvoyer — voir purgeStalePositions.
    const topology = await getTopology();
    const liveNodeIds = new Set(topology.nodes.map((n) => n.id));
    return reply.send(await purgeStalePositions(request.authSession!.username, liveNodeIds));
  });

  fastify.put<{ Body: SavePositionsBody }>("/api/topology/positions", async (request, reply) => {
    const positions = request.body?.positions ?? {};
    await savePositionsForUser(request.authSession!.username, positions);
    return reply.send({ ok: true });
  });
}
