/**
 * Regroupements de nœuds du graphe de topologie ("encapsulation façon Railway/Logisim" — voir
 * ARCHITECTURE.md § "Graphe de topologie" et types.ts#TopologyGroup) : contrairement aux positions
 * (topologyPositionsStore.ts, PROPRES à chaque compte connecté), un groupement est PARTAGÉ entre
 * tous les utilisateurs — il reflète une organisation réelle de l'infra décidée une fois par un
 * humain (sélection multiple + "Regrouper" sur le canevas), pas une préférence d'affichage
 * individuelle. Même pattern de persistance que topologyPositionsStore.ts/secrets.json : JSON sur
 * disque, cache mémoire process invalidé à chaque écriture, fichier `0600`.
 *
 * Ce store ne connaît QUE l'identité du groupe (id/label/membres/replié/créateur) — jamais les
 * ports d'entrée/sortie ni le rendu : ceux-ci sont dérivés côté client des arêtes réelles qui
 * traversent la frontière du groupe (topologyGraphShared.tsx#deriveGroupPorts), pour ne jamais
 * désynchroniser une donnée dérivée d'une vraie connexion Docker.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { TopologyGroup } from "../types.js";

let cache: TopologyGroup[] | null = null;

function resolvedStorePath(): string {
  // Même dossier que config.json (CONFIG_PATH), voir topologyPositionsStore.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "topology-groups.json");
}

async function readFromDisk(): Promise<TopologyGroup[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TopologyGroup[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: TopologyGroup[]): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<TopologyGroup[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET /api/topology (le graphe inclut désormais `groups`, voir routes/topology.ts). */
export async function listGroups(): Promise<TopologyGroup[]> {
  return getAll();
}

export class DuplicateGroupMemberError extends Error {
  constructor(nodeId: string) {
    super(`Le nœud "${nodeId}" appartient déjà à un autre groupe.`);
    this.name = "DuplicateGroupMemberError";
  }
}

/**
 * POST /api/topology/groups — crée un groupement RÉEL à partir d'une sélection explicite de
 * l'utilisateur (jamais deviné/inféré automatiquement, voir types.ts#TopologyGroup). `nodeIds`
 * doit déjà avoir été validé par l'appelant (routes/topology.ts) contre le graphe réel actuel
 * (au moins 2 ids, tous existants dans `getTopology()`) — ce store vérifie en plus ici qu'aucun
 * des ids n'appartient déjà à un autre groupe (un nœud ne peut être membre que d'un seul groupe à
 * la fois, pour que l'imbrication reste simple à représenter visuellement dans ce premier lot).
 */
export async function createGroup(input: { label: string; nodeIds: string[]; createdBy: string }): Promise<TopologyGroup> {
  const all = await getAll();
  const alreadyGrouped = new Set(all.flatMap((g) => g.nodeIds));
  for (const id of input.nodeIds) {
    if (alreadyGrouped.has(id)) throw new DuplicateGroupMemberError(id);
  }
  const group: TopologyGroup = {
    id: `group:${randomUUID()}`,
    label: input.label,
    nodeIds: input.nodeIds,
    collapsed: true, // "un seul nœud replié" par défaut à la création, voir ARCHITECTURE.md
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  const next = [...all, group];
  await writeToDisk(next);
  cache = next;
  return group;
}

/** PATCH /api/topology/groups/:id — renommer et/ou replier/déplier. `undefined` = champ inchangé. */
export async function updateGroup(id: string, patch: { label?: string; collapsed?: boolean }): Promise<TopologyGroup | null> {
  const all = await getAll();
  const index = all.findIndex((g) => g.id === id);
  if (index === -1) return null;
  const current = all[index]!;
  const updated: TopologyGroup = {
    ...current,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}),
  };
  const next = [...all];
  next[index] = updated;
  await writeToDisk(next);
  cache = next;
  return updated;
}

/** DELETE /api/topology/groups/:id — dissocie le groupe (les membres redeviennent des nœuds
 * autonomes, jamais supprimés eux-mêmes : seul le regroupement disparaît). */
export async function deleteGroup(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((g) => g.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}
