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

/** Groupes imbriqués (13/08/2026) : voir types.ts#TopologyGroup#nodeIds. Un groupe ne peut jamais
 * (même indirectement, à travers plusieurs niveaux de sous-groupes) se contenir lui-même. */
export class CyclicGroupError extends Error {
  constructor() {
    super("Un groupe ne peut pas se contenir lui-même, même indirectement à travers plusieurs niveaux d'imbrication.");
    this.name = "CyclicGroupError";
  }
}

/** Profondeur max d'imbrication d'un groupe — voir computeGroupDepth ci-dessous. */
const MAX_GROUP_DEPTH = 5;

export class MaxGroupDepthExceededError extends Error {
  constructor() {
    super(`Un groupe ne peut pas dépasser ${MAX_GROUP_DEPTH} niveaux d'imbrication.`);
    this.name = "MaxGroupDepthExceededError";
  }
}

/** Nombre max de VRAIS TopologyNode transitivement contenus dans un groupe — voir
 * resolveRealNodeIds ci-dessous. */
const MAX_GROUP_SIZE = 256;

export class MaxGroupSizeExceededError extends Error {
  constructor() {
    super(`Un groupe ne peut pas contenir plus de ${MAX_GROUP_SIZE} nœuds réels au total, sous-groupes dépliés compris.`);
    this.name = "MaxGroupSizeExceededError";
  }
}

/**
 * Profondeur d'un groupe (encore hypothétique ici : `nodeIds` n'a pas encore été persisté sous
 * forme de TopologyGroup, voir createGroup ci-dessous) = 1 + la plus grande profondeur parmi ses
 * membres qui sont eux-mêmes des groupes EXISTANTS (`groupsById`), 0 si aucun de ses membres n'est
 * un groupe (uniquement de vrais TopologyNode). Fonction pure, récursive, testable isolément.
 *
 * `visited` protège contre une boucle infinie même si un cycle existait déjà par erreur dans les
 * données persistées (jamais censé arriver en usage normal : un groupe ne référence QUE des
 * groupes déjà existants au moment de sa création, il ne peut donc structurellement jamais devenir
 * son propre ancêtre — voir CyclicGroupError) : ne porte que les ids de groupe déjà visités SUR LE
 * CHEMIN COURANT (pas l'ensemble du graphe), pour ne pas rejeter à tort un même sous-groupe
 * référencé deux fois par deux branches distinctes.
 */
export function computeGroupDepth(nodeIds: string[], groupsById: Map<string, TopologyGroup>, visited: Set<string> = new Set()): number {
  let maxChildDepth = 0;
  for (const id of nodeIds) {
    const child = groupsById.get(id);
    if (!child) continue; // vrai TopologyNode : ne compte pas dans la profondeur
    if (visited.has(child.id)) throw new CyclicGroupError();
    const childVisited = new Set(visited);
    childVisited.add(child.id);
    const childDepth = 1 + computeGroupDepth(child.nodeIds, groupsById, childVisited);
    if (childDepth > maxChildDepth) maxChildDepth = childDepth;
  }
  return maxChildDepth;
}

/**
 * Déplie récursivement `nodeIds` jusqu'aux vrais ids de TopologyNode (jamais un id de groupe dans
 * le résultat) — sert à borner le nombre total de nœuds réels transitivement contenus (voir
 * MAX_GROUP_SIZE ci-dessus). Même garde anti-boucle infinie que computeGroupDepth ci-dessus.
 */
export function resolveRealNodeIds(nodeIds: string[], groupsById: Map<string, TopologyGroup>, visited: Set<string> = new Set()): string[] {
  const result: string[] = [];
  for (const id of nodeIds) {
    const child = groupsById.get(id);
    if (!child) {
      result.push(id);
      continue;
    }
    if (visited.has(child.id)) throw new CyclicGroupError();
    const childVisited = new Set(visited);
    childVisited.add(child.id);
    result.push(...resolveRealNodeIds(child.nodeIds, groupsById, childVisited));
  }
  return result;
}

/**
 * POST /api/topology/groups — crée un groupement RÉEL à partir d'une sélection explicite de
 * l'utilisateur (jamais deviné/inféré automatiquement, voir types.ts#TopologyGroup). `nodeIds`
 * doit déjà avoir été validé par l'appelant (routes/topology.ts) contre le graphe réel actuel ET
 * contre les groupes déjà existants (au moins 2 ids, chacun soit un vrai nœud de `getTopology()`,
 * soit l'id d'un TopologyGroup déjà existant) — ce store vérifie en plus ici :
 *  - qu'aucun des ids n'appartient déjà à un autre groupe (un nœud OU un sous-groupe ne peut être
 *    membre que d'un seul groupe parent à la fois, voir DuplicateGroupMemberError) ;
 *  - qu'aucun cycle ne se formerait, même indirectement (CyclicGroupError — voir
 *    computeGroupDepth/resolveRealNodeIds ci-dessus : structurellement impossible en usage normal
 *    puisqu'un groupe ne référence que des groupes déjà existants, mais gardé en défense en
 *    profondeur contre des données corrompues) ;
 *  - que la profondeur résultante ne dépasse pas MAX_GROUP_DEPTH (MaxGroupDepthExceededError) ;
 *  - que le nombre total de vrais TopologyNode transitivement contenus (déplié à travers tous les
 *    sous-groupes) ne dépasse pas MAX_GROUP_SIZE (MaxGroupSizeExceededError).
 */
export async function createGroup(input: { label: string; nodeIds: string[]; createdBy: string }): Promise<TopologyGroup> {
  const all = await getAll();
  const alreadyGrouped = new Set(all.flatMap((g) => g.nodeIds));
  for (const id of input.nodeIds) {
    if (alreadyGrouped.has(id)) throw new DuplicateGroupMemberError(id);
  }
  const groupsById = new Map(all.map((g) => [g.id, g]));
  const depth = computeGroupDepth(input.nodeIds, groupsById);
  if (depth > MAX_GROUP_DEPTH) throw new MaxGroupDepthExceededError();
  const realNodeCount = resolveRealNodeIds(input.nodeIds, groupsById).length;
  if (realNodeCount > MAX_GROUP_SIZE) throw new MaxGroupSizeExceededError();
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

/**
 * DELETE /api/topology/groups/:id — dissocie le groupe : ne supprime QUE l'enregistrement de ce
 * groupe (son entrée dans `topology-groups.json`), jamais ses membres — qu'il s'agisse de vrais
 * TopologyNode (jamais touchés, Docker/Nutanix/etc. n'est jamais appelé ici) OU de sous-groupes
 * imbriqués (13/08/2026, voir types.ts#TopologyGroup#nodeIds) : un sous-groupe membre du groupe
 * dissocié reste lui-même un TopologyGroup parfaitement valide dans le store, il redevient
 * simplement un groupe de premier niveau/autonome (plus aucun groupe ne le référence dans son
 * `nodeIds`) — comportement déjà correct sans changement nécessaire ici, la dissociation ne fait
 * jamais que filtrer CE seul `id` de la liste, voir `next` ci-dessous.
 */
export async function deleteGroup(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((g) => g.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}
