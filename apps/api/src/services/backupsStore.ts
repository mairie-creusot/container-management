/**
 * Sauvegardes automatiques de volumes/bases de données vers un stockage S3-compatible (cf.
 * ARCHITECTURE.md, chapitre "Sauvegardes automatiques") — persistance des DÉFINITIONS de
 * sauvegarde (ressource ciblée + destination S3 + planification) et de l'HISTORIQUE des
 * exécutions. L'exécution RÉELLE (tar/pg_dump/mysqldump/mongodump en sous-processus/docker exec,
 * upload/suppression S3 via @aws-sdk/client-s3) vit dans services/backupScheduler.ts — ce module
 * ne fait jamais lui-même de vrai appel Docker/S3 (même séparation store/exécution que
 * secretsStore.ts/remoteDockerStore.ts vis-à-vis de docker.ts).
 *
 * Deux fichiers séparés :
 * - BACKUPS_PATH (config.backups.storePath, défaut ./data/backups.json) : définitions, relu/
 *   réécrit en entier à chaque mutation (même pattern que remoteDockerStore.ts) — accessKey/
 *   secretKey S3 chiffrés au repos (crypto.ts), jamais renvoyés par une route (write-only, comme
 *   RemoteDockerTls/SecretRef) : seul `hasCredentials` indique leur présence.
 * - backup-runs.jsonl (même dossier que scans.jsonl/notifications-log.jsonl, dérivé de
 *   CONFIG_PATH) : historique des exécutions, append-only — chaque run traverse
 *   "running" -> "success"|"failed" (une ligne par changement d'état, la ligne la plus récente
 *   par id fait foi, exactement comme scan.ts#readAllScans). La rotation ("supprime les plus
 *   anciennes... dans l'historique local") n'efface JAMAIS physiquement une ligne existante
 *   (append-only, comme le reste du projet) : backupScheduler.ts ajoute une nouvelle ligne
 *   portant `rotated: true` sur le run concerné une fois son objet réellement supprimé de S3 — le
 *   run reste visible pour audit mais n'est plus proposé à la restauration ni recompté dans la
 *   rétention (voir computeRunsToRotate ci-dessous).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { appendFileRestricted, writeFileRestricted } from "../utils/secureFile.js";
import type { BackupDefinition, BackupRun, BackupTarget } from "../types.js";

export class BackupValidationError extends Error {}

interface StoredBackupDestination {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  /** Chiffrés au repos (crypto.ts) quand présents — absents tant qu'aucun identifiant n'a été saisi. */
  accessKey?: string;
  secretKey?: string;
}

interface StoredBackupDefinition {
  id: string;
  name: string;
  target: BackupTarget;
  destination: StoredBackupDestination;
  schedule: string;
  retentionCount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Config effective (déchiffrée) d'une destination S3 — réservée à backupScheduler.ts, jamais exposée par une route. */
export interface EffectiveBackupDestination {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

let definitionsCache: StoredBackupDefinition[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.backups.storePath);
}

function resolvedRunsLogPath(): string {
  // Même dossier que scans.jsonl/notifications-log.jsonl (dérivé de CONFIG_PATH), fichier séparé.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "backup-runs.jsonl");
}

async function readDefinitionsFromDisk(): Promise<StoredBackupDefinition[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredBackupDefinition[]) : [];
  } catch {
    return [];
  }
}

async function writeDefinitionsToDisk(next: StoredBackupDefinition[]): Promise<void> {
  // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
}

async function getAllDefinitions(): Promise<StoredBackupDefinition[]> {
  if (definitionsCache) return definitionsCache;
  definitionsCache = await readDefinitionsFromDisk();
  return definitionsCache;
}

function toRef(def: StoredBackupDefinition): BackupDefinition {
  return {
    id: def.id,
    name: def.name,
    target: def.target,
    destination: {
      endpoint: def.destination.endpoint,
      region: def.destination.region,
      bucket: def.destination.bucket,
      forcePathStyle: def.destination.forcePathStyle,
      hasCredentials: Boolean(def.destination.accessKey && def.destination.secretKey),
    },
    schedule: def.schedule,
    retentionCount: def.retentionCount,
    enabled: def.enabled,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

/** GET /api/backups — jamais accessKey/secretKey, voir toRef(). */
export async function listBackupDefinitions(): Promise<BackupDefinition[]> {
  return (await getAllDefinitions()).map(toRef);
}

export async function getBackupDefinitionRef(id: string): Promise<BackupDefinition | undefined> {
  const found = (await getAllDefinitions()).find((def) => def.id === id);
  return found ? toRef(found) : undefined;
}

export interface BackupDestinationInput {
  endpoint: string;
  region?: string;
  bucket: string;
  forcePathStyle?: boolean;
  accessKey?: string;
  secretKey?: string;
}

export interface CreateBackupDefinitionInput {
  name: string;
  target: BackupTarget;
  destination: BackupDestinationInput;
  schedule: string;
  retentionCount: number;
  enabled?: boolean;
}

// Validation de FORME uniquement (5 champs, caractères attendus) — la sémantique complète
// (cronMatches) vit dans backupScheduler.ts ("le Scheduler" a la responsabilité de
// l'évaluation cron ; ce module ne fait que refuser une expression manifestement invalide avant
// de la persister). Volontairement simple, pas de réimplémentation complexe (cf. mission).
const CRON_FIELD = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/;

function isValidCronExpressionShape(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => CRON_FIELD.test(part));
}

function assertValidTarget(target: BackupTarget): void {
  if (target.kind !== "volume" && target.kind !== "database") {
    throw new BackupValidationError('target.kind must be "volume" or "database"');
  }
  if (!target.ref?.trim()) {
    throw new BackupValidationError("target.ref is required");
  }
}

function assertValidDestinationInput(destination: BackupDestinationInput): void {
  if (!destination.endpoint?.trim()) throw new BackupValidationError("destination.endpoint is required");
  if (!destination.bucket?.trim()) throw new BackupValidationError("destination.bucket is required");
}

function encryptDestination(destination: BackupDestinationInput): StoredBackupDestination {
  return {
    endpoint: destination.endpoint.trim(),
    // "us-east-1" : région par défaut la plus largement acceptée par les stockages S3-compatibles
    // on-prem (MinIO/Ceph) qui n'ont pas de notion réelle de région mais exigent souvent une
    // valeur non vide dans la requête signée SigV4.
    region: destination.region?.trim() || "us-east-1",
    bucket: destination.bucket.trim(),
    forcePathStyle: destination.forcePathStyle ?? true,
    ...(destination.accessKey ? { accessKey: encryptSecretIfNeeded(destination.accessKey) } : {}),
    ...(destination.secretKey ? { secretKey: encryptSecretIfNeeded(destination.secretKey) } : {}),
  };
}

/** POST /api/backups. */
export async function createBackupDefinition(input: CreateBackupDefinitionInput): Promise<BackupDefinition> {
  const name = input.name?.trim();
  if (!name) throw new BackupValidationError("name is required");
  assertValidTarget(input.target);
  if (!isValidCronExpressionShape(input.schedule)) {
    throw new BackupValidationError("schedule must be a standard 5-field cron expression");
  }
  if (!Number.isInteger(input.retentionCount) || input.retentionCount < 1) {
    throw new BackupValidationError("retentionCount must be a positive integer");
  }
  assertValidDestinationInput(input.destination);

  const now = new Date().toISOString();
  const created: StoredBackupDefinition = {
    id: randomUUID(),
    name,
    target: { kind: input.target.kind, ref: input.target.ref.trim() },
    destination: encryptDestination(input.destination),
    schedule: input.schedule.trim(),
    retentionCount: input.retentionCount,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const all = await getAllDefinitions();
  const next = [...all, created];
  await writeDefinitionsToDisk(next);
  definitionsCache = next;
  return toRef(created);
}

export interface UpdateBackupDefinitionInput {
  name?: string;
  target?: BackupTarget;
  // destination omise = destination conservée telle quelle ; fournie = endpoint/region/bucket/
  // forcePathStyle remplacés, accessKey/secretKey omis dans le sous-objet = identifiants
  // conservés (même convention que password/token dans setupStore.ts).
  destination?: BackupDestinationInput;
  // Efface explicitement les identifiants S3 persistés (repasse en accès anonyme) — distinct de
  // "destination fournie sans accessKey/secretKey", qui les conserve.
  clearCredentials?: boolean;
  schedule?: string;
  retentionCount?: number;
  enabled?: boolean;
}

/** PATCH /api/backups/:id. */
export async function updateBackupDefinition(
  id: string,
  patch: UpdateBackupDefinitionInput,
): Promise<BackupDefinition | undefined> {
  const all = await getAllDefinitions();
  const index = all.findIndex((def) => def.id === id);
  if (index === -1) return undefined;
  const existing = all[index]!;

  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new BackupValidationError("name cannot be empty");

  const nextTarget = patch.target ?? existing.target;
  assertValidTarget(nextTarget);

  const nextSchedule = patch.schedule !== undefined ? patch.schedule.trim() : existing.schedule;
  if (!isValidCronExpressionShape(nextSchedule)) {
    throw new BackupValidationError("schedule must be a standard 5-field cron expression");
  }

  const nextRetentionCount = patch.retentionCount !== undefined ? patch.retentionCount : existing.retentionCount;
  if (!Number.isInteger(nextRetentionCount) || nextRetentionCount < 1) {
    throw new BackupValidationError("retentionCount must be a positive integer");
  }

  let nextDestination: StoredBackupDestination;
  if (patch.destination) {
    assertValidDestinationInput(patch.destination);
    const encrypted = encryptDestination(patch.destination);
    nextDestination = {
      ...encrypted,
      // accessKey/secretKey omis dans le patch = conservés (comme password/token ailleurs) —
      // clearCredentials explicite prime sur tout le reste.
      ...(patch.destination.accessKey === undefined && !patch.clearCredentials && existing.destination.accessKey
        ? { accessKey: existing.destination.accessKey }
        : {}),
      ...(patch.destination.secretKey === undefined && !patch.clearCredentials && existing.destination.secretKey
        ? { secretKey: existing.destination.secretKey }
        : {}),
    };
  } else if (patch.clearCredentials) {
    const { accessKey: _accessKey, secretKey: _secretKey, ...rest } = existing.destination;
    nextDestination = rest;
  } else {
    nextDestination = existing.destination;
  }

  const updated: StoredBackupDefinition = {
    id: existing.id,
    name: nextName,
    target: { kind: nextTarget.kind, ref: nextTarget.ref.trim() },
    destination: nextDestination,
    schedule: nextSchedule,
    retentionCount: nextRetentionCount,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const next = all.map((def, i) => (i === index ? updated : def));
  await writeDefinitionsToDisk(next);
  definitionsCache = next;
  return toRef(updated);
}

/** DELETE /api/backups/:id — ne purge jamais backup-runs.jsonl (append-only, comme le reste du
 * projet) : l'historique d'une définition supprimée reste consultable pour audit mais n'apparaît
 * plus dans listBackupDefinitions(). */
export async function deleteBackupDefinition(id: string): Promise<boolean> {
  const all = await getAllDefinitions();
  const next = all.filter((def) => def.id !== id);
  if (next.length === all.length) return false;
  await writeDefinitionsToDisk(next);
  definitionsCache = next;
  return true;
}

/**
 * Config effective déchiffrée d'une destination S3 — réservée à
 * backupScheduler.ts#runBackupNow/restoreBackup. `undefined` si aucune définition ne porte cet id.
 */
export async function getEffectiveBackupDestination(id: string): Promise<EffectiveBackupDestination | undefined> {
  const found = (await getAllDefinitions()).find((def) => def.id === id);
  if (!found) return undefined;
  return {
    endpoint: found.destination.endpoint,
    region: found.destination.region,
    bucket: found.destination.bucket,
    forcePathStyle: found.destination.forcePathStyle,
    ...(found.destination.accessKey ? { accessKeyId: decryptSecret(found.destination.accessKey) } : {}),
    ...(found.destination.secretKey ? { secretAccessKey: decryptSecret(found.destination.secretKey) } : {}),
  };
}

// --- Historique des exécutions (backup-runs.jsonl, append-only) ---------------------------

/** Ajoute un événement au journal — jamais appelé directement par une route, seulement par
 * backupScheduler.ts. Ne lève jamais vers l'appelant (même garde que notificationsStore.ts) : une
 * panne d'écriture ne doit jamais faire échouer un cycle du scheduler. */
export async function appendBackupRunEvent(run: BackupRun): Promise<void> {
  try {
    // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
    await appendFileRestricted(resolvedRunsLogPath(), `${JSON.stringify(run)}\n`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[backups] failed to persist run event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Dernière version connue de chaque run (une ligne par changement d'état, la plus récente par id fait foi). */
async function readAllBackupRuns(): Promise<BackupRun[]> {
  try {
    const raw = await fs.readFile(resolvedRunsLogPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const latestById = new Map<string, BackupRun>();
    for (const line of lines) {
      try {
        const run = JSON.parse(line) as BackupRun;
        latestById.set(run.id, run);
      } catch {
        // ligne corrompue (écriture interrompue) : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return [...latestById.values()];
  } catch {
    return [];
  }
}

/** GET /api/backups/:id/runs — historique d'une définition, les plus récents en premier. */
export async function listBackupRuns(definitionId: string): Promise<BackupRun[]> {
  const all = await readAllBackupRuns();
  return all.filter((r) => r.definitionId === definitionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getBackupRun(runId: string): Promise<BackupRun | undefined> {
  const all = await readAllBackupRuns();
  return all.find((r) => r.id === runId);
}

/**
 * Pure, sans I/O — testable directement avec des runs/dates fabriqués (voir
 * test/backupsStore.test.ts), même esprit que scanScheduler.ts#isScanDue. Runs éligibles à la
 * rotation : succès, avec un objet S3 (`objectKey`), pas déjà rotaté — triés du plus récent au
 * plus ancien, les `retentionCount` premiers sont conservés, le reste est retourné pour
 * suppression (S3 + marquage `rotated` dans l'historique local, voir backupScheduler.ts).
 */
export function computeRunsToRotate(runs: readonly BackupRun[], retentionCount: number): BackupRun[] {
  const eligible = runs
    .filter((r) => r.status === "success" && Boolean(r.objectKey) && !r.rotated)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return eligible.slice(Math.max(0, retentionCount));
}
