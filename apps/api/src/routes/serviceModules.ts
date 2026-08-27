/**
 * GET    /api/service-modules                    — registre des modules métier disponibles et leur
 *                                                  état de configuration RÉEL (voir
 *                                                  services/serviceModules.ts).
 * GET    /api/service-modules/bindings           — liaisons effectives nœud -> module : manuelles
 *                                                  (persistées) + automatiques (recalculées depuis
 *                                                  les nœuds réels du graphe, jamais persistées).
 * PUT    /api/service-modules/bindings           — { nodeId, moduleId } lie un nœud à un module —
 *                                                  operator/admin (hook global sur les méthodes
 *                                                  mutantes, plugins/auth.ts).
 * DELETE /api/service-modules/bindings/:nodeId   — retire la liaison MANUELLE d'un nœud (une
 *                                                  liaison automatique n'est pas supprimable : elle
 *                                                  disparaît d'elle-même dès que la correspondance
 *                                                  cesse d'être vraie) — operator/admin.
 * GET    /api/service-modules/:moduleId/snapshot — instantané générique du module (summary /
 *                                                  entities / relations), LECTURE SEULE.
 */

import type { FastifyInstance } from "fastify";
import { getTopology } from "../services/topology.js";
import {
  resolveServiceModuleProvider,
  listEffectiveBindings,
  listServiceModules,
} from "../services/serviceModules.js";
import { removeManualBinding, setManualBinding } from "../services/serviceBindingsStore.js";
import type { TopologyNode } from "../types.js";

/** Durée (ms) de réutilisation des nœuds du graphe pour le calcul des liaisons automatiques — le
 * graphe complet est coûteux (Docker + Prism Central + HYCU + hôtes distants) et le frontend
 * interroge ces liaisons à chaque rafraîchissement de sa topologie : sans ce cache, chaque poll en
 * déclencherait un SECOND. Volontairement court : une VM renommée/réadressée se reflète au poll
 * suivant, jamais figée. */
const TOPOLOGY_NODES_CACHE_MS = 10_000;

let cachedNodes: { at: number; nodes: TopologyNode[] } | null = null;

async function topologyNodes(): Promise<TopologyNode[]> {
  if (cachedNodes && Date.now() - cachedNodes.at < TOPOLOGY_NODES_CACHE_MS) return cachedNodes.nodes;
  const topology = await getTopology();
  cachedNodes = { at: Date.now(), nodes: topology.nodes };
  return topology.nodes;
}

interface BindingBody {
  nodeId?: string;
  moduleId?: string;
}

export default async function serviceModulesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/service-modules", async (_request, reply) => {
    return reply.send({ modules: await listServiceModules() });
  });

  fastify.get("/api/service-modules/bindings", async (_request, reply) => {
    // Un graphe indisponible (Docker éteint, Prism injoignable) ne doit pas faire échouer la
    // lecture des liaisons : les liaisons MANUELLES restent exactes sans lui, seules les
    // automatiques (qui ont besoin des nœuds réels) sont alors absentes — honnête, jamais devinées.
    const nodes = await topologyNodes().catch(() => [] as TopologyNode[]);
    return reply.send({ bindings: await listEffectiveBindings(nodes) });
  });

  fastify.put<{ Body: BindingBody }>("/api/service-modules/bindings", async (request, reply) => {
    const nodeId = request.body?.nodeId?.trim();
    const moduleId = request.body?.moduleId?.trim();
    if (!nodeId || !moduleId) {
      return reply.code(400).send({ error: "Champs requis manquants : nodeId, moduleId" });
    }
    // Résolution COMPLÈTE : un module apporté par un greffon actif est liable comme les autres.
    if (!(await resolveServiceModuleProvider(moduleId))) {
      return reply.code(400).send({ error: `Module inconnu : ${moduleId}` });
    }
    const binding = await setManualBinding(nodeId, moduleId, request.authSession!.username);
    return reply.send(binding);
  });

  fastify.delete<{ Params: { nodeId: string } }>("/api/service-modules/bindings/:nodeId", async (request, reply) => {
    const removed = await removeManualBinding(request.params.nodeId);
    if (!removed) return reply.code(404).send({ error: "Aucune liaison manuelle pour ce nœud" });
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { moduleId: string } }>("/api/service-modules/:moduleId/snapshot", async (request, reply) => {
    const provider = await resolveServiceModuleProvider(request.params.moduleId);
    if (!provider) return reply.code(404).send({ error: `Module inconnu : ${request.params.moduleId}` });
    return reply.send(await provider.getSnapshot());
  });
}
