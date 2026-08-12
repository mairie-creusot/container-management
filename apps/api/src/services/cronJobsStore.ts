/**
 * Définitions de cron jobs (cf. ARCHITECTURE.md, priorité #6 du rapport concurrentiel — façon
 * Railway, docs.railway.com/cron-jobs) : CRUD pur, persistance JSON sur disque, MÊME PATTERN
 * EXACT que services/reverseProxy.ts (cache mémoire process invalidé à chaque écriture, fichier
 * 0600, `config.cronJobs.storePath`). Aucune valeur sensible dans une définition (une commande
 * shell n'est pas un secret au sens de secretsStore.ts, même si elle peut en référencer un via
 * une variable d'environnement déjà présente dans le conteneur cible) : pas de chiffrement au
 * repos ici, contrairement à secrets.json/remote-docker.json/lxc.json.
 *
 * La validation de la syntaxe de `schedule` (expression cron) N'EST PAS ici : elle appartient à
 * services/cronJobsScheduler.ts (qui possède déjà `parseCronExpression`, seule source de vérité
 * sur la syntaxe cron) — routes/cronJobs.ts appelle `isValidCronExpression` AVANT createCronJob/
 * updateCronJob, exactement comme services/reverseProxy.ts#isValidSubdomain est appelé par
 * routes/reverseProxy.ts avant createRoute. Ce module ne dépend donc JAMAIS de
 * cronJobsScheduler.ts (qui, lui, dépend de ce module pour lire la liste des jobs à chaque tick)
 * — dépendance à sens unique, aucun cycle d'import.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { CronJobDefinition } from "../types.js";

let cache: CronJobDefinition[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.cronJobs.storePath);
}

async function readFromDisk(): Promise<CronJobDefinition[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CronJobDefinition[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: CronJobDefinition[]): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<CronJobDefinition[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET /api/cron-jobs */
export async function listCronJobs(): Promise<CronJobDefinition[]> {
  return getAll();
}

export async function getCronJob(id: string): Promise<CronJobDefinition | undefined> {
  const all = await getAll();
  return all.find((job) => job.id === id);
}

export interface CreateCronJobInput {
  name: string;
  containerId: string;
  containerName: string;
  command: string;
  schedule: string;
  enabled: boolean;
  createdBy: string;
}

export async function createCronJob(input: CreateCronJobInput): Promise<CronJobDefinition> {
  const all = await getAll();
  const now = new Date().toISOString();
  const created: CronJobDefinition = {
    id: randomUUID(),
    name: input.name,
    containerId: input.containerId,
    containerName: input.containerName,
    command: input.command,
    schedule: input.schedule,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  };
  const next = [...all, created];
  await writeToDisk(next);
  cache = next;
  return created;
}

export interface UpdateCronJobInput {
  name?: string;
  containerId?: string;
  containerName?: string;
  command?: string;
  schedule?: string;
  enabled?: boolean;
}

export async function updateCronJob(id: string, patch: UpdateCronJobInput): Promise<CronJobDefinition | undefined> {
  const all = await getAll();
  const index = all.findIndex((job) => job.id === id);
  if (index === -1) return undefined;
  const existing = all[index]!;
  const updated: CronJobDefinition = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.containerId !== undefined ? { containerId: patch.containerId } : {}),
    ...(patch.containerName !== undefined ? { containerName: patch.containerName } : {}),
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[index] = updated;
  await writeToDisk(next);
  cache = next;
  return updated;
}

/** `false` si aucun job ne portait cet id — même convention que reverseProxy.ts#deleteRoute. */
export async function deleteCronJob(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((job) => job.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}
