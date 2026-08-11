/**
 * Positions des nœuds du graphe de topologie déplacés à la main (voir
 * apps/web/src/components/TopologyGraph.tsx), persistées PAR UTILISATEUR — pas une donnée
 * d'infrastructure, une préférence d'affichage propre à chaque compte connecté (username LDAP).
 *
 * Remplace le stockage précédent en localStorage du navigateur (propre à un APPAREIL, pas à une
 * IDENTITÉ) : un même admin connecté depuis un autre poste, ou deux comptes partageant le même
 * poste, avaient un comportement incohérent. Ici, la disposition suit le compte, pas le navigateur.
 *
 * Persistance JSON sur disque (même dossier/pattern que secrets.json — voir secretsStore.ts,
 * livré plus tôt dans cette session) : cache mémoire process invalidé à chaque écriture, fichier
 * écrit avec des permissions restrictives (0600).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type NodePositions = Record<string, { x: number; y: number }>;

/** username -> positions de ses nœuds déplacés à la main. */
type StoredPositions = Record<string, NodePositions>;

let cache: StoredPositions | null = null;

function resolvedStorePath(): string {
  // Même dossier que config.json (CONFIG_PATH) — voir setupStore.ts/secretsStore.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "topology-positions.json");
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

/** GET /api/topology/positions — {} si cet utilisateur n'a encore rien déplacé. */
export async function getPositionsForUser(username: string): Promise<NodePositions> {
  const all = await getAll();
  return all[username] ?? {};
}

/** PUT /api/topology/positions — remplace la disposition complète de cet utilisateur. */
export async function savePositionsForUser(username: string, positions: NodePositions): Promise<void> {
  const all = await getAll();
  const next = { ...all, [username]: positions };
  await writeToDisk(next);
  cache = next;
}

/**
 * GET /api/topology/positions — retire silencieusement les entrées dont l'id de nœud n'existe
 * plus dans le graphe RÉEL actuel (`liveNodeIds`, calculé par l'appelant via getTopology()) avant
 * de renvoyer/persister la disposition de cet utilisateur : conteneur supprimé, volume/network
 * nettoyé... rien ne purgeait jamais ces entrées auparavant, elles s'accumulaient indéfiniment
 * dans le fichier de chaque utilisateur sans jamais fausser l'affichage (une position pour un id
 * absent n'est simplement jamais consommée par le frontend) mais sans jamais être nettoyées non
 * plus. Ce n'est PAS une suppression de ressource Docker — seulement une préférence d'affichage
 * désormais orpheline, qui peut donc être nettoyée silencieusement (contrairement aux
 * volumes/networks eux-mêmes, jamais retirés sans confirmation explicite de l'utilisateur).
 * N'écrit sur disque que si au moins une entrée a effectivement été retirée.
 */
export async function purgeStalePositions(username: string, liveNodeIds: ReadonlySet<string>): Promise<NodePositions> {
  const current = await getPositionsForUser(username);
  const entries = Object.entries(current);
  const kept = entries.filter(([nodeId]) => liveNodeIds.has(nodeId));
  if (kept.length === entries.length) return current; // rien à purger, aucune écriture inutile
  const cleaned: NodePositions = Object.fromEntries(kept);
  await savePositionsForUser(username, cleaned);
  return cleaned;
}
