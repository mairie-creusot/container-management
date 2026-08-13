/**
 * GET /api/topology            — graphe visuel de l'infra (conteneurs/volumes/networks/VMs Nutanix
 *                                 + relations réelles), inclut désormais `groups` (voir
 *                                 services/topologyGroupsStore.ts).
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
 *
 * POST   /api/topology/groups      — { label, nodeIds } crée un groupement RÉEL (sélection
 *                                     multiple + "Regrouper" côté canevas, jamais deviné) —
 *                                     operator/admin (hook global). `nodeIds` doit référencer au
 *                                     moins 2 ids RÉELS : soit un nœud présent dans le graphe actuel
 *                                     (`getTopology()`), soit un TopologyGroup déjà existant
 *                                     (groupes imbriqués, 13/08/2026) — aucun déjà membre d'un autre
 *                                     groupe, aucun cycle, profondeur <= 5, <= 256 vrais nœuds
 *                                     transitivement contenus (voir topologyGroupsStore.ts) — 400
 *                                     explicite sinon, jamais un groupe partiellement inventé.
 * PATCH  /api/topology/groups/:id  — { label?, collapsed? } renomme et/ou replie/déplie —
 *                                     operator/admin. 404 si le groupe n'existe pas/plus.
 * DELETE /api/topology/groups/:id  — dissocie le groupe (les membres redeviennent des nœuds
 *                                     autonomes, jamais supprimés) — operator/admin.
 *
 * GET /api/topology/groups/:id/positions — disposition des MEMBRES DIRECTS de ce groupe déplacés à
 *                                 la main dans sa vue "composition interne" (retour utilisateur du
 *                                 13/08/2026), par utilisateur ET par groupe — jamais mélangée avec
 *                                 /api/topology/positions (graphe principal, voir
 *                                 topologyGroupInteriorPositionsStore.ts). {} si rien déplacé.
 * PUT /api/topology/groups/:id/positions — { positions } remplace cette disposition — operator/admin.
 */

import type { FastifyInstance } from "fastify";
import { getTopology } from "../services/topology.js";
import {
  purgeStalePositions,
  savePositionsForUser,
  type NodePositions,
} from "../services/topologyPositionsStore.js";
import {
  getGroupInteriorPositions,
  purgeStaleGroupInteriorPositions,
  saveGroupInteriorPositions,
} from "../services/topologyGroupInteriorPositionsStore.js";
import {
  createGroup,
  CyclicGroupError,
  deleteGroup,
  DuplicateGroupMemberError,
  MaxGroupDepthExceededError,
  MaxGroupSizeExceededError,
  updateGroup,
} from "../services/topologyGroupsStore.js";

interface SavePositionsBody {
  positions?: NodePositions;
}

interface CreateGroupBody {
  label?: string;
  nodeIds?: string[];
}

interface UpdateGroupBody {
  label?: string;
  collapsed?: boolean;
}

export default async function topologyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/topology", async (_request, reply) => {
    return reply.send(await getTopology());
  });

  fastify.get("/api/topology/positions", async (request, reply) => {
    // Graphe actuel calculé côté serveur (mêmes données que GET /api/topology) pour purger toute
    // position dont l'id de nœud n'y apparaît plus avant de la renvoyer — voir purgeStalePositions.
    //
    // Bug réel corrigé le 13/08/2026 (retour utilisateur : "il memorise mal a chaque refresh ou
    // hardrefresh ou rebuild ce n'est pas a la position ou j'ai mis" — la carte d'un GROUPE
    // repositionnée à la main sur le canevas principal revenait systématiquement à sa position par
    // défaut) : `liveNodeIds` ne contenait QUE les ids de `topology.nodes` (vrais conteneurs/
    // volumes/networks/VMs...), jamais ceux de `topology.groups` (groupes imbriqués, 13/08/2026) —
    // une carte de groupe déplacée à la main persiste pourtant sa position sous SON PROPRE id
    // (`group:<uuid>`, voir handleNodeDragStop, TopologyGraph.tsx). purgeStalePositions traitait
    // donc CETTE entrée comme orpheline (aucun id de ce nom dans liveNodeIds) et la supprimait à
    // CHAQUE appel de cette route — donc à chaque rechargement de page, quasi immédiatement après
    // l'avoir déplacée.
    const topology = await getTopology();
    const liveNodeIds = new Set([...topology.nodes.map((n) => n.id), ...topology.groups.map((g) => g.id)]);
    return reply.send(await purgeStalePositions(request.authSession!.username, liveNodeIds));
  });

  fastify.put<{ Body: SavePositionsBody }>("/api/topology/positions", async (request, reply) => {
    const positions = request.body?.positions ?? {};
    await savePositionsForUser(request.authSession!.username, positions);
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: CreateGroupBody }>("/api/topology/groups", async (request, reply) => {
    const label = request.body?.label?.trim();
    const nodeIds = request.body?.nodeIds;
    if (!label) return reply.code(400).send({ error: "label is required" });
    if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
      return reply.code(400).send({ error: "nodeIds must contain at least 2 node ids" });
    }
    // Aucun id inventé : chaque membre doit exister RÉELLEMENT — soit un vrai nœud du graphe
    // courant, soit l'id d'un TopologyGroup déjà existant (groupes imbriqués, 13/08/2026 — voir
    // types.ts#TopologyGroup#nodeIds) — jamais une supposition (ARCHITECTURE.md § "Graphe de
    // topologie").
    const topology = await getTopology();
    const liveNodeIds = new Set(topology.nodes.map((n) => n.id));
    const existingGroupIds = new Set(topology.groups.map((g) => g.id));
    const uniqueIds = Array.from(new Set(nodeIds));
    const unknown = uniqueIds.find((id) => !liveNodeIds.has(id) && !existingGroupIds.has(id));
    if (unknown) return reply.code(400).send({ error: `Node "${unknown}" not found` });
    if (uniqueIds.length < 2) return reply.code(400).send({ error: "nodeIds must contain at least 2 distinct node ids" });
    try {
      const group = await createGroup({ label, nodeIds: uniqueIds, createdBy: request.authSession!.username });
      return reply.code(201).send(group);
    } catch (err) {
      if (err instanceof DuplicateGroupMemberError) return reply.code(409).send({ error: err.message });
      // Groupes imbriqués (13/08/2026) : anti-cycle/profondeur max/taille max — même pattern de
      // traduction que DuplicateGroupMemberError ci-dessus, en 400 (erreur de requête du client,
      // jamais un conflit de concurrence comme l'appartenance déjà existante ci-dessus).
      if (err instanceof CyclicGroupError || err instanceof MaxGroupDepthExceededError || err instanceof MaxGroupSizeExceededError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateGroupBody }>("/api/topology/groups/:id", async (request, reply) => {
    const { label, collapsed } = request.body ?? {};
    const trimmedLabel = label !== undefined ? label.trim() : undefined;
    if (trimmedLabel !== undefined && !trimmedLabel) return reply.code(400).send({ error: "label cannot be empty" });
    const updated = await updateGroup(request.params.id, {
      ...(trimmedLabel !== undefined ? { label: trimmedLabel } : {}),
      ...(collapsed !== undefined ? { collapsed } : {}),
    });
    if (!updated) return reply.code(404).send({ error: "Group not found" });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>("/api/topology/groups/:id", async (request, reply) => {
    const ok = await deleteGroup(request.params.id);
    if (!ok) return reply.code(404).send({ error: "Group not found" });
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { id: string } }>("/api/topology/groups/:id/positions", async (request, reply) => {
    // Purge d'abord silencieusement les entrées dont l'id de membre n'est plus un membre DIRECT
    // actuel de CE groupe (même esprit que GET /api/topology/positions ci-dessus) — 404 explicite si
    // le groupe lui-même n'existe plus/pas (jamais une réponse {} trompeuse qui laisserait croire
    // qu'il existe simplement sans rien de déplacé).
    const topology = await getTopology();
    const group = topology.groups.find((g) => g.id === request.params.id);
    if (!group) return reply.code(404).send({ error: "Group not found" });
    const liveMemberIds = new Set(group.nodeIds);
    return reply.send(await purgeStaleGroupInteriorPositions(request.authSession!.username, group.id, liveMemberIds));
  });

  fastify.put<{ Params: { id: string }; Body: SavePositionsBody }>("/api/topology/groups/:id/positions", async (request, reply) => {
    const topology = await getTopology();
    const group = topology.groups.find((g) => g.id === request.params.id);
    if (!group) return reply.code(404).send({ error: "Group not found" });
    const positions = request.body?.positions ?? {};
    await saveGroupInteriorPositions(request.authSession!.username, group.id, positions);
    return reply.send({ ok: true });
  });
}
