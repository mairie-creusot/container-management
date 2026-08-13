/**
 * Nœuds/arêtes du moteur d'automatisation (trigger -> condition -> action, cf. ARCHITECTURE.md,
 * "moteur d'automatisation" — façon n8n mais câblé UNIQUEMENT sur les capacités RÉELLES déjà
 * existantes de QUAI) : CRUD pur, persistance JSON sur disque, MÊME PATTERN EXACT que
 * services/cronJobsStore.ts (cache mémoire process invalidé à chaque écriture, fichier 0600,
 * `config.automation.storePath`). Aucune valeur sensible ici (un `AutomationActionConfig` ne
 * référence que des ids de ressources déjà existantes — cron job, canal de notification,
 * conteneur — jamais un secret en clair) : pas de chiffrement au repos, comme cron-jobs.json.
 *
 * La VALIDATION métier (un nœud "automation-trigger" doit porter `triggerConfig`, une arête doit
 * respecter l'ordre logique trigger->condition->action, etc.) N'EST PAS ici : elle appartient à
 * routes/automation.ts, exactement comme services/cronJobsStore.ts ne valide jamais la syntaxe
 * cron (routes/cronJobs.ts#isValidCronExpression le fait avant d'appeler ce module). Ce module ne
 * dépend donc JAMAIS de services/automationEngine.ts (qui, lui, dépend de ce module pour lire les
 * nœuds/arêtes à chaque cycle et pour persister `lastFired`/`lastStatus` via `updateTriggerState`)
 * — dépendance à sens unique, aucun cycle d'import.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { AutomationActionConfig, AutomationTriggerConfig } from "../types.js";

export type AutomationNodeKind = "automation-trigger" | "automation-condition" | "automation-action";

export interface AutomationNode {
  id: string;
  kind: AutomationNodeKind;
  label: string;
  createdAt: string; // ISO 8601
  // Un seul des trois selon `kind` (voir routes/automation.ts pour la garde de cohérence) :
  triggerConfig?: AutomationTriggerConfig;
  conditionInvert?: boolean;
  actionConfig?: AutomationActionConfig;
  // Trigger uniquement, mis à jour EXCLUSIVEMENT par le moteur (updateTriggerState ci-dessous,
  // appelé depuis services/automationEngine.ts) — jamais par une route de mutation utilisateur.
  lastFired?: string | null;
  lastStatus?: "ok" | "failing" | "unknown";
}

export interface AutomationEdge {
  id: string;
  source: string; // id d'un AutomationNode
  target: string; // id d'un AutomationNode
}

interface AutomationStoreData {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

let cache: AutomationStoreData | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.automation.storePath);
}

function isStoreData(value: unknown): value is AutomationStoreData {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<AutomationStoreData>).nodes) &&
    Array.isArray((value as Partial<AutomationStoreData>).edges)
  );
}

async function readFromDisk(): Promise<AutomationStoreData> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isStoreData(parsed) ? parsed : { nodes: [], edges: [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

async function writeToDisk(next: AutomationStoreData): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<AutomationStoreData> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET /api/automation/nodes */
export async function listAutomationNodes(): Promise<AutomationNode[]> {
  return (await getAll()).nodes;
}

export async function listAutomationEdges(): Promise<AutomationEdge[]> {
  return (await getAll()).edges;
}

export async function getAutomationNode(id: string): Promise<AutomationNode | undefined> {
  const all = await getAll();
  return all.nodes.find((node) => node.id === id);
}

export interface CreateAutomationNodeInput {
  kind: AutomationNodeKind;
  label: string;
  triggerConfig?: AutomationTriggerConfig;
  conditionInvert?: boolean;
  actionConfig?: AutomationActionConfig;
}

export async function createAutomationNode(input: CreateAutomationNodeInput): Promise<AutomationNode> {
  const all = await getAll();
  const created: AutomationNode = {
    id: randomUUID(),
    kind: input.kind,
    label: input.label,
    createdAt: new Date().toISOString(),
    ...(input.triggerConfig !== undefined ? { triggerConfig: input.triggerConfig } : {}),
    ...(input.conditionInvert !== undefined ? { conditionInvert: input.conditionInvert } : {}),
    ...(input.actionConfig !== undefined ? { actionConfig: input.actionConfig } : {}),
    // Un trigger démarre toujours "unknown"/jamais déclenché — le premier cycle du moteur qui
    // l'observe est celui qui établit son premier état réel (voir automationEngine.ts).
    ...(input.kind === "automation-trigger" ? { lastFired: null, lastStatus: "unknown" as const } : {}),
  };
  const next: AutomationStoreData = { nodes: [...all.nodes, created], edges: all.edges };
  await writeToDisk(next);
  cache = next;
  return created;
}

/** `false` si aucun nœud ne portait cet id — même convention que cronJobsStore.ts#deleteCronJob.
 * Supprime aussi toute arête (source OU target) qui touchait ce nœud, pour ne jamais laisser
 * d'arête pointant vers un nœud inexistant. */
export async function deleteAutomationNode(id: string): Promise<boolean> {
  const all = await getAll();
  const nodes = all.nodes.filter((node) => node.id !== id);
  if (nodes.length === all.nodes.length) return false;
  const edges = all.edges.filter((edge) => edge.source !== id && edge.target !== id);
  const next: AutomationStoreData = { nodes, edges };
  await writeToDisk(next);
  cache = next;
  return true;
}

export async function createAutomationEdge(source: string, target: string): Promise<AutomationEdge> {
  const all = await getAll();
  const created: AutomationEdge = { id: randomUUID(), source, target };
  const next: AutomationStoreData = { nodes: all.nodes, edges: [...all.edges, created] };
  await writeToDisk(next);
  cache = next;
  return created;
}

/** `false` si aucune arête ne portait cet id. */
export async function deleteAutomationEdge(id: string): Promise<boolean> {
  const all = await getAll();
  const edges = all.edges.filter((edge) => edge.id !== id);
  if (edges.length === all.edges.length) return false;
  const next: AutomationStoreData = { nodes: all.nodes, edges };
  await writeToDisk(next);
  cache = next;
  return true;
}

/**
 * Appelée EXCLUSIVEMENT par services/automationEngine.ts à chaque cycle, pour CHAQUE trigger
 * évalué (même s'il n'y a pas eu de transition) — jamais par une route de mutation utilisateur
 * directe. Retourne `undefined` si l'id ne correspond à aucun nœud (ex: supprimé entre deux
 * cycles), auquel cas l'appelant n'a rien de plus à faire.
 */
export async function updateTriggerState(
  id: string,
  patch: { lastFired?: string | null; lastStatus?: "ok" | "failing" | "unknown" },
): Promise<AutomationNode | undefined> {
  const all = await getAll();
  const index = all.nodes.findIndex((node) => node.id === id);
  if (index === -1) return undefined;
  const existing = all.nodes[index]!;
  const updated: AutomationNode = {
    ...existing,
    ...(patch.lastFired !== undefined ? { lastFired: patch.lastFired } : {}),
    ...(patch.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
  };
  const nodes = [...all.nodes];
  nodes[index] = updated;
  const next: AutomationStoreData = { nodes, edges: all.edges };
  await writeToDisk(next);
  cache = next;
  return updated;
}
