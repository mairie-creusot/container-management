/**
 * Positions des membres DIRECTS d'un groupe déplacés à la main dans sa vue "composition interne"
 * (TopologySubGraphPanel.tsx, root = groupe, disposition par défaut calculée par
 * layeredGroupPositions — topologyGraphShared.tsx) — retour utilisateur du 13/08/2026 : "laisse à
 * l'utilisateur le choix de le replacer et de mémoriser leur emplacement".
 *
 * Persistée PAR UTILISATEUR **ET** PAR GROUPE, jamais dans topologyPositionsStore.ts (positions du
 * graphe PRINCIPAL) : un même conteneur a une position complètement différente dans chaque
 * contexte (colonnes globales par kind côté graphe principal, vs. disposition locale en couches
 * propre à UN groupe précis ici) — réutiliser le même stockage produirait des coordonnées
 * incohérentes dans l'un ou l'autre contexte dès qu'un conteneur apparaît dans les deux vues.
 *
 * Même pattern de persistance (JSON sur disque, fichier séparé, permissions restrictives) que
 * topologyPositionsStore.ts/secretsStore.ts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type NodePositions = Record<string, { x: number; y: number }>;

/** username -> groupId -> positions de ses membres déplacés à la main dans CE groupe précis. */
type StoredPositions = Record<string, Record<string, NodePositions>>;

let cache: StoredPositions | null = null;

function resolvedStorePath(): string {
  // Même dossier que config.json (CONFIG_PATH) — voir setupStore.ts/topologyPositionsStore.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "topology-group-interior-positions.json");
}

async function readFromDisk(): Promise<StoredPositions> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredPositions) : {};
  } catch {
    return {};
  }
}

async function writeToDisk(next: StoredPositions): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<StoredPositions> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET /api/topology/groups/:id/positions — {} si cet utilisateur n'a encore rien déplacé dans ce groupe. */
export async function getGroupInteriorPositions(username: string, groupId: string): Promise<NodePositions> {
  const all = await getAll();
  return all[username]?.[groupId] ?? {};
}

/** PUT /api/topology/groups/:id/positions — remplace la disposition complète de CE groupe pour l'utilisateur connecté. */
export async function saveGroupInteriorPositions(username: string, groupId: string, positions: NodePositions): Promise<void> {
  const all = await getAll();
  const next: StoredPositions = { ...all, [username]: { ...(all[username] ?? {}), [groupId]: positions } };
  await writeToDisk(next);
  cache = next;
}

/**
 * Retire silencieusement, pour CE groupe précis, toute position dont l'id de membre n'est plus un
 * membre DIRECT actuel du groupe (renommage du groupe sans impact, seul `nodeIds` compte) — même
 * esprit que purgeStalePositions (topologyPositionsStore.ts) : une préférence d'affichage devenue
 * orpheline (membre dissocié entre-temps), jamais une suppression de ressource réelle. N'écrit sur
 * disque que si au moins une entrée a effectivement été retirée.
 */
export async function purgeStaleGroupInteriorPositions(
  username: string,
  groupId: string,
  liveMemberIds: ReadonlySet<string>,
): Promise<NodePositions> {
  const current = await getGroupInteriorPositions(username, groupId);
  const entries = Object.entries(current);
  const kept = entries.filter(([id]) => liveMemberIds.has(id));
  if (kept.length === entries.length) return current;
  const next = Object.fromEntries(kept);
  await saveGroupInteriorPositions(username, groupId, next);
  return next;
}
