/**
 * Liaisons MANUELLES nœud du graphe -> module métier (voir serviceModules.ts) : quelle ressource
 * réelle du parc (ex. la VM Nutanix `nutanix-vm:<uuid>` nommée HDV3CX) porte quel module.
 *
 * Manuelles UNIQUEMENT : les liaisons AUTOMATIQUES (l'hôte configuré d'une intégration correspond
 * réellement au nom/à une IP d'un nœud) sont recalculées à chaud à chaque lecture par
 * serviceModules.ts#resolveAutomaticBindings et ne sont JAMAIS persistées ici — une correspondance
 * qui cesse d'être vraie (VM renommée, IP changée, intégration reconfigurée) doit disparaître
 * d'elle-même, pas survivre dans un fichier.
 *
 * Même pattern de persistance que topologyGroupInteriorPositionsStore.ts/topologyPositionsStore.ts :
 * JSON à côté de config.json, permissions 0600, cache mémoire.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface ManualServiceBinding {
  /** Id RÉEL d'un TopologyNode (ex "nutanix-vm:<uuid>", "container:<id>") — jamais un libellé. */
  nodeId: string;
  /** Id d'un module du registre (serviceModules.ts#SERVICE_MODULE_PROVIDERS). */
  moduleId: string;
  /** Horodatage ISO de la liaison. */
  boundAt: string;
  /** Utilisateur qui a créé la liaison (traçabilité, même esprit que les autres stores). */
  boundBy: string;
}

/** nodeId -> liaison (un nœud porte au plus UN module : c'est la vue "ce nœud EST ce service"). */
type StoredBindings = Record<string, ManualServiceBinding>;

let cache: StoredBindings | null = null;

function resolvedStorePath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "service-bindings.json");
}

async function readFromDisk(): Promise<StoredBindings> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredBindings) : {};
  } catch {
    return {};
  }
}

async function writeToDisk(next: StoredBindings): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<StoredBindings> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function listManualBindings(): Promise<ManualServiceBinding[]> {
  const all = await getAll();
  return Object.values(all);
}

export async function getManualBinding(nodeId: string): Promise<ManualServiceBinding | null> {
  const all = await getAll();
  return all[nodeId] ?? null;
}

/** PUT /api/service-modules/bindings — remplace la liaison de CE nœud (un module par nœud). */
export async function setManualBinding(nodeId: string, moduleId: string, boundBy: string): Promise<ManualServiceBinding> {
  const all = await getAll();
  const binding: ManualServiceBinding = { nodeId, moduleId, boundAt: new Date().toISOString(), boundBy };
  const next: StoredBindings = { ...all, [nodeId]: binding };
  await writeToDisk(next);
  cache = next;
  return binding;
}

/** DELETE /api/service-modules/bindings/:nodeId — `false` si ce nœud n'avait aucune liaison manuelle. */
export async function removeManualBinding(nodeId: string): Promise<boolean> {
  const all = await getAll();
  if (!all[nodeId]) return false;
  const next = { ...all };
  delete next[nodeId];
  await writeToDisk(next);
  cache = next;
  return true;
}

/** Tests uniquement — le cache est un singleton de process (même contrainte que les autres stores). */
export function resetServiceBindingsCacheForTests(): void {
  cache = null;
}
