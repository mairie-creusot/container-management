/**
 * Sauvegardes automatiques en tâche de fond (cf. ARCHITECTURE.md, chapitre "Sauvegardes
 * automatiques") — même architecture que scanScheduler.ts/watchdog.ts (cycle périodique, garde
 * anti-chevauchement, `startBackupScheduler()` démarré UNIQUEMENT depuis index.ts#main(), jamais
 * depuis buildServer(), pour ne jamais déclencher de vraie sauvegarde réseau pendant les tests
 * qui construisent juste le serveur avec `app.inject`).
 *
 * Contrairement à scanScheduler.ts (qui rafraîchit ce qui est "périmé"), ce module est un VRAI
 * scheduler cron : à chaque tick (toutes les minutes), il évalue l'expression cron de chaque
 * définition ACTIVE contre l'heure courante (voir cronMatches/isBackupDue ci-dessous, pures et
 * testables sans I/O) et ne lance une sauvegarde que si elle "matche" cette minute précise — pas
 * de rattrapage ("catch-up") si l'API était arrêtée au moment prévu, sémantique cron standard.
 *
 * Exécution RÉELLE, jamais réimplémentée :
 * - Volume Docker : `tar czf -` dans un conteneur `alpine` helper éphémère (même mécanisme que
 *   docker.ts#listVolumeFiles), volume monté en lecture seule, flux stdout streamé directement
 *   sur disque (jamais bufferisé en mémoire, une sauvegarde peut être volumineuse).
 * - Base de données : le moteur (postgres/mysql/mariadb/mongo) est détecté depuis l'image du
 *   conteneur CIBLE, puis `pg_dumpall`/`mysqldump`/`mongodump` est exécuté DEDANS via
 *   `docker exec` (dockerode `container.exec`, même mécanisme que la console interactive,
 *   routes/console.ts) — jamais ces binaires installés côté API. Les identifiants sont lus depuis
 *   les variables d'environnement déjà présentes dans le conteneur cible (POSTGRES_PASSWORD/
 *   MYSQL_ROOT_PASSWORD/MONGO_INITDB_ROOT_*, conventions des images officielles Docker Hub — pas
 *   une invention QUAI), jamais redemandés à l'utilisateur.
 * - Upload/download/suppression S3 : SDK officiel `@aws-sdk/client-s3`, `endpoint` custom +
 *   `forcePathStyle: true` par défaut (compatible MinIO/Ceph/tout stockage S3-compatible on-prem).
 *
 * Restauration (`restoreBackup`) : re-télécharge l'archive/le dump depuis S3 puis le réapplique
 * réellement — extraction tar DANS le volume (stdin d'un conteneur helper) ou exec
 * `psql`/`mysql`/`mongorestore` DANS le conteneur cible avec le dump/l'archive en entrée
 * standard. Action destructive assumée : voir routes/backups.ts pour la confirmation forte
 * exigée côté frontend.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import type Docker from "dockerode";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { withTimeout } from "../utils/async.js";
import { getClient, isDockerReachable } from "./docker.js";
import {
  appendBackupRunEvent,
  computeRunsToRotate,
  getBackupDefinitionRef,
  getBackupRun,
  getEffectiveBackupDestination,
  listBackupDefinitions,
  listBackupRuns,
} from "./backupsStore.js";
import type { EffectiveBackupDestination } from "./backupsStore.js";
import type { BackupDatabaseEngine, BackupDefinition, BackupRestoreResult, BackupRun } from "../types.js";

// --- Cron minimal (5 champs standard : minute heure jour-du-mois mois jour-de-semaine) ---------
// Volontairement simple (cf. mission : "PAS de réimplémentation complexe") : supporte "*", les
// listes ("1,15,30"), les plages ("1-5") et les pas ("*/15", "1-10/2") — largement suffisant pour
// des besoins de planification standards. Pas de support des noms de mois/jours (JAN, MON...) ni
// des extensions Quartz ("L"/"W"/"#") : hors périmètre pour ce premier lot.

function matchesCronPart(part: string, value: number, max: number): boolean {
  const [rangePart, stepPart] = part.split("/");
  const step = stepPart !== undefined ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step <= 0) return false;

  let start: number;
  let end: number;
  if (rangePart === "*") {
    start = 0;
    end = max;
  } else if (rangePart!.includes("-")) {
    const [a, b] = rangePart!.split("-").map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    start = a!;
    end = b!;
  } else {
    const n = Number(rangePart);
    if (!Number.isInteger(n)) return false;
    start = n;
    end = n;
  }

  if (value < start || value > end || value > max) return false;
  return (value - start) % step === 0;
}

function matchesCronField(fieldExpr: string, value: number, max: number): boolean {
  return fieldExpr.split(",").some((part) => matchesCronPart(part, value, max));
}

/** true si `date` tombe dans l'expression cron à 5 champs. Exporté pour les tests. */
export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  const dow = date.getDay(); // 0 (dimanche) - 6 (samedi)
  // "7" est un alias courant de dimanche (0) dans plusieurs implémentations cron : accepté en plus
  // du 0-6 standard plutôt que rejeté, sans complexifier matchesCronField lui-même.
  const dowMatches = matchesCronField(dayOfWeek, dow, 7) || (dow === 0 && matchesCronField(dayOfWeek, 7, 7));
  return (
    matchesCronField(minute, date.getMinutes(), 59) &&
    matchesCronField(hour, date.getHours(), 23) &&
    matchesCronField(dayOfMonth, date.getDate(), 31) &&
    matchesCronField(month, date.getMonth() + 1, 12) &&
    dowMatches
  );
}

function truncatedToMinute(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 60_000);
}

/**
 * Pure, testable sans I/O (voir test/backupScheduler.test.ts) — une définition est due si son
 * expression cron correspond à la minute courante ET qu'aucune exécution n'a déjà démarré
 * pendant CETTE MÊME minute (évite un double déclenchement si le tick dérive/est relancé
 * plusieurs fois dans la même minute). PAS de rattrapage : contrairement à
 * scanScheduler.ts#isScanDue (qui rafraîchit tout ce qui est "périmé"), une définition qui n'a
 * jamais tourné n'est due qu'à la PROCHAINE minute où son expression matche, jamais immédiatement
 * au démarrage de l'API — sémantique cron standard, pas un cron de rafraîchissement.
 */
export function isBackupDue(schedule: string, lastRunStartedAt: string | null, now: Date): boolean {
  if (!cronMatches(schedule, now)) return false;
  if (!lastRunStartedAt) return true;
  return truncatedToMinute(lastRunStartedAt) !== Math.floor(now.getTime() / 60_000);
}

// --- Détection du moteur de base de données depuis l'image du conteneur cible -----------------

/** Pure, exportée pour les tests — jamais de moteur deviné/fabriqué si l'image ne correspond à
 * aucun des quatre moteurs supportés (retourne null, l'appelant échoue alors explicitement). */
export function detectDatabaseEngine(image: string): BackupDatabaseEngine | null {
  const lower = image.toLowerCase();
  if (lower.includes("postgres")) return "postgres";
  if (lower.includes("mariadb")) return "mariadb";
  if (lower.includes("mysql")) return "mysql";
  if (lower.includes("mongo")) return "mongo";
  return null;
}

/**
 * Commandes de dump/restauration par moteur — lisent les identifiants depuis les variables
 * d'environnement DÉJÀ présentes dans le conteneur cible (conventions des images officielles
 * Docker Hub postgres/mysql/mariadb/mongo, pas une invention QUAI) : `docker exec` hérite par
 * défaut de l'environnement du conteneur, aucun identifiant n'est donc jamais redemandé/saisi
 * côté QUAI. `pg_dumpall`/`mysqldump --all-databases` dumpent TOUTES les bases du serveur cible
 * (pas une base précise) : cohérent avec `target.ref` qui désigne un CONTENEUR, pas une base
 * nommée — restaurable tel quel par psql/mysql en entrée standard.
 */
const DUMP_COMMANDS: Record<BackupDatabaseEngine, { cmd: string[]; extension: string }> = {
  postgres: {
    cmd: ["sh", "-c", 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U "${POSTGRES_USER:-postgres}"'],
    extension: "sql",
  },
  mysql: {
    cmd: ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --all-databases -u root'],
    extension: "sql",
  },
  mariadb: {
    cmd: ["sh", "-c", 'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" mysqldump --all-databases -u root'],
    extension: "sql",
  },
  mongo: {
    cmd: [
      "sh",
      "-c",
      'if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then mongodump --archive --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; else mongodump --archive; fi',
    ],
    extension: "archive",
  },
};

/** `--drop`/écrasement complet à la restauration : une restauration est une action destructive
 * assumée (voir routes/backups.ts), le dump restauré doit refléter l'état sauvegardé sans
 * mélange avec les données actuelles. */
const RESTORE_COMMANDS: Record<BackupDatabaseEngine, string[]> = {
  postgres: ["sh", "-c", 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "${POSTGRES_USER:-postgres}"'],
  mysql: ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root'],
  mariadb: ["sh", "-c", 'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" mysql -u root'],
  mongo: [
    "sh",
    "-c",
    'if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then mongorestore --archive --drop --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; else mongorestore --archive --drop; fi',
  ],
};

// --- Volume Docker : tar réel via conteneur helper éphémère (même pattern que docker.ts#listVolumeFiles) ---

const VOLUME_HELPER_IMAGE = "alpine:3.19";

async function ensureImagePresent(docker: Docker, reference: string): Promise<void> {
  try {
    await docker.getImage(reference).inspect();
    return;
  } catch {
    // pas présente localement : tirée à la volée, comme docker.ts#listVolumeFiles.
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(reference, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        reject(err ?? new Error("docker.pull returned no stream"));
        return;
      }
      docker.modem.followProgress(stream, (progressErr: Error | null) => {
        if (progressErr) reject(progressErr);
        else resolve();
      });
    });
  });
}

async function requireVolumeExists(docker: Docker, volumeName: string): Promise<void> {
  try {
    await docker.getVolume(volumeName).inspect();
  } catch {
    throw new Error(`Volume "${volumeName}" not found`);
  }
}

/** `tar czf - -C /volume .` dans un helper alpine, volume monté RO, flux stdout streamé
 * directement sur disque (jamais bufferisé en mémoire — un volume peut être volumineux). */
async function tarVolumeToFile(docker: Docker, volumeName: string, destPath: string): Promise<void> {
  await requireVolumeExists(docker, volumeName);
  await ensureImagePresent(docker, VOLUME_HELPER_IMAGE);

  const container = await docker.createContainer({
    Image: VOLUME_HELPER_IMAGE,
    Cmd: ["tar", "czf", "-", "-C", "/volume", "."],
    Tty: false,
    HostConfig: { Binds: [`${volumeName}:/volume:ro`], AutoRemove: true, NetworkMode: "none" },
  });
  try {
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    const fileStream = createWriteStream(destPath);
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    docker.modem.demuxStream(attachStream, fileStream, stderrSink);
    const streamEnded = new Promise<void>((resolve) => attachStream.once("end", () => resolve()));

    await container.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waitResult: any = await container.wait();
    await streamEnded;
    await new Promise<void>((resolve) => fileStream.end(() => resolve()));

    const statusCode: number = waitResult?.StatusCode ?? 0;
    if (statusCode !== 0) {
      throw new Error(`tar failed (exit ${statusCode}): ${Buffer.concat(stderrChunks).toString("utf8").trim()}`);
    }
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // déjà supprimé (AutoRemove) ou jamais démarré : rien à faire.
    }
  }
}

/** Extraction RÉELLE de l'archive tar dans le volume (restauration) : le fichier téléchargé est
 * streamé sur le stdin d'un conteneur helper qui exécute `tar xzf - -C /volume`. Écrase le
 * contenu actuel du volume — action destructive assumée (voir routes/backups.ts). */
async function extractTarIntoVolume(docker: Docker, volumeName: string, srcPath: string): Promise<void> {
  await requireVolumeExists(docker, volumeName);
  await ensureImagePresent(docker, VOLUME_HELPER_IMAGE);

  const container = await docker.createContainer({
    Image: VOLUME_HELPER_IMAGE,
    Cmd: ["tar", "xzf", "-", "-C", "/volume"],
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: { Binds: [`${volumeName}:/volume`], AutoRemove: true, NetworkMode: "none" },
  });
  try {
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new PassThrough();
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    docker.modem.demuxStream(attachStream, stdoutSink, stderrSink);
    const streamEnded = new Promise<void>((resolve) => attachStream.once("end", () => resolve()));

    await container.start();
    const fileStream = createReadStream(srcPath);
    fileStream.pipe(attachStream, { end: true }); // ferme stdin une fois le fichier entièrement écrit -> tar se termine

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waitResult: any = await container.wait();
    await streamEnded;

    const statusCode: number = waitResult?.StatusCode ?? 0;
    if (statusCode !== 0) {
      throw new Error(`tar restore failed (exit ${statusCode}): ${Buffer.concat(stderrChunks).toString("utf8").trim()}`);
    }
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // …
    }
  }
}

// --- Base de données : dump/restauration RÉELS via `docker exec` dans le conteneur cible -------

async function requireRunningContainer(docker: Docker, containerId: string): Promise<{ image: string }> {
  let info: unknown;
  try {
    info = await docker.getContainer(containerId).inspect();
  } catch {
    throw new Error(`Container "${containerId}" not found`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = info as any;
  if (data?.State?.Status !== "running") {
    throw new Error(`Container "${containerId}" is not running (state: ${data?.State?.Status ?? "unknown"})`);
  }
  return { image: data?.Config?.Image ?? "" };
}

/** Exécute `cmd` DANS le conteneur cible (docker exec), capture stdout (le dump) directement sur
 * disque, jamais bufferisé en mémoire. */
async function execCaptureToFile(docker: Docker, containerId: string, cmd: string[], destPath: string): Promise<void> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, Tty: false });
  const fileStream = createWriteStream(destPath);
  const stderrChunks: Buffer[] = [];
  const stderrSink = new PassThrough();
  stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, fileStream, stderrSink);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  await new Promise<void>((resolve) => fileStream.end(() => resolve()));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await exec.inspect();
  if (info?.ExitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${info?.ExitCode}): ${Buffer.concat(stderrChunks).toString("utf8").trim()}`);
  }
}

/** Exécute `cmd` DANS le conteneur cible avec le fichier téléchargé (dump/archive) fourni en
 * entrée standard — restauration réelle, jamais une simulation. */
async function execFeedFromFile(docker: Docker, containerId: string, cmd: string[], srcPath: string): Promise<void> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({ Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough();
  stdoutSink.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);
  const streamEnded = new Promise<void>((resolve) => stream.once("end", () => resolve()));

  const fileStream = createReadStream(srcPath);
  fileStream.pipe(stream, { end: true });
  await streamEnded;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await exec.inspect();
  if (info?.ExitCode !== 0) {
    const detail = Buffer.concat(stderrChunks).toString("utf8").trim() || Buffer.concat(stdoutChunks).toString("utf8").trim();
    throw new Error(`restore failed (exit ${info?.ExitCode}): ${detail}`);
  }
}

// --- Stockage S3-compatible (MinIO/Ceph/AWS...) via le SDK officiel @aws-sdk/client-s3 ---------

function buildS3Client(destination: EffectiveBackupDestination): S3Client {
  return new S3Client({
    endpoint: destination.endpoint,
    region: destination.region || "us-east-1",
    forcePathStyle: destination.forcePathStyle,
    ...(destination.accessKeyId && destination.secretAccessKey
      ? { credentials: { accessKeyId: destination.accessKeyId, secretAccessKey: destination.secretAccessKey } }
      : {}),
  });
}

async function uploadToS3(destination: EffectiveBackupDestination, objectKey: string, filePath: string): Promise<number> {
  const client = buildS3Client(destination);
  const stat = await fs.stat(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: destination.bucket,
      Key: objectKey,
      Body: createReadStream(filePath),
      ContentLength: stat.size,
    }),
  );
  return stat.size;
}

async function downloadFromS3(destination: EffectiveBackupDestination, objectKey: string, destPath: string): Promise<void> {
  const client = buildS3Client(destination);
  const result = await client.send(new GetObjectCommand({ Bucket: destination.bucket, Key: objectKey }));
  // @aws-sdk/client-s3 sous Node.js (runtime par défaut hors navigateur) : `Body` est un vrai
  // flux Node (Readable), pas un Blob/ReadableStream web — vérifié dans la doc officielle AWS SDK
  // v3 (StreamingBlobPayloadOutputTypes résolu en Readable côté Node).
  const body = result.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    const fileStream = createWriteStream(destPath);
    body.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", () => resolve());
    body.pipe(fileStream);
  });
}

async function deleteFromS3(destination: EffectiveBackupDestination, objectKey: string): Promise<void> {
  const client = buildS3Client(destination);
  await client.send(new DeleteObjectCommand({ Bucket: destination.bucket, Key: objectKey }));
}

// --- Exécution d'une sauvegarde -----------------------------------------------------------

async function ensureTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "quai-backups");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function extensionForTarget(kind: BackupDefinition["target"]["kind"]): string {
  return kind === "volume" ? "tar.gz" : "dump";
}

/**
 * Runs éligibles à la rotation supprimés réellement de S3, puis marqués `rotated: true` dans
 * l'historique local (append-only, voir backupsStore.ts en-tête de fichier) — jamais de
 * réécriture des lignes existantes.
 */
async function applyRetention(definitionId: string, retentionCount: number, destination: EffectiveBackupDestination): Promise<void> {
  const runs = await listBackupRuns(definitionId);
  const toRotate = computeRunsToRotate(runs, retentionCount);
  for (const run of toRotate) {
    try {
      if (run.objectKey) await deleteFromS3(destination, run.objectKey);
      await appendBackupRunEvent({ ...run, rotated: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[backup-scheduler] failed to rotate run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Effectue réellement une sauvegarde (tar/dump + upload S3 + rotation), jamais attendue par
 * l'appelant (voir runBackupNow ci-dessous) : un tar de gros volume ou un dump de grosse base
 * peut prendre plusieurs minutes, ni la route POST /api/backups/:id/run ni le cycle du scheduler
 * ne doivent bloquer dessus. Limite assumée : `withTimeout` abandonne l'attente côté QUAI au-delà
 * de `config.backups.runTimeoutMs` et marque le run "failed", mais ne peut pas garantir l'arrêt
 * immédiat du process Docker sous-jacent (même limite documentée que ailleurs dans ce projet pour
 * les flux dockerode hijackés, contrairement à `execFile` qui, lui, tue vraiment le process —
 * voir scan.ts) — un helper conteneur `AutoRemove` fini par se nettoyer de lui-même une fois son
 * `tar`/dump terminé.
 */
async function performBackup(run: BackupRun, definition: BackupDefinition, destination: EffectiveBackupDestination): Promise<void> {
  const tmpDir = await ensureTmpDir();
  const extension = extensionForTarget(definition.target.kind);
  const tmpFile = path.join(tmpDir, `${run.id}.${extension}`);

  try {
    const docker = await getClient();
    if (!(await isDockerReachable(docker))) {
      throw new Error("Docker daemon is not reachable");
    }

    if (definition.target.kind === "volume") {
      await withTimeout(tarVolumeToFile(docker, definition.target.ref, tmpFile), config.backups.runTimeoutMs, "volume tar");
    } else {
      const { image } = await requireRunningContainer(docker, definition.target.ref);
      const engine = detectDatabaseEngine(image);
      if (!engine) {
        throw new Error(`Could not detect a supported database engine from image "${image}" (expected postgres/mysql/mariadb/mongo)`);
      }
      await withTimeout(
        execCaptureToFile(docker, definition.target.ref, DUMP_COMMANDS[engine].cmd, tmpFile),
        config.backups.runTimeoutMs,
        "database dump",
      );
    }

    const objectKey = `${definition.id}/${run.id}.${extension}`;
    const sizeBytes = await withTimeout(uploadToS3(destination, objectKey, tmpFile), config.backups.runTimeoutMs, "S3 upload");

    await appendBackupRunEvent({ ...run, status: "success", finishedAt: new Date().toISOString(), sizeBytes, objectKey });
    await applyRetention(definition.id, definition.retentionCount, destination);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendBackupRunEvent({ ...run, status: "failed", finishedAt: new Date().toISOString(), error: message });
    // eslint-disable-next-line no-console
    console.warn(`[backup-scheduler] backup "${definition.name}" (${definition.id}) failed: ${message}`);
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

/**
 * Déclenche une sauvegarde réelle pour `definitionId` — retourne IMMÉDIATEMENT le run à l'état
 * "running" (même principe que scan.ts#startScan) : la sauvegarde continue en arrière-plan, le
 * frontend/le cycle suivant suivent l'avancement par polling (GET /api/backups/:id/runs). Jamais
 * un second run concurrent pour la même définition tant que celui-ci reste "running" (voir
 * runBackupSchedulerCycle ci-dessous).
 */
export async function runBackupNow(definitionId: string, trigger: BackupRun["trigger"]): Promise<BackupRun> {
  const definition = await getBackupDefinitionRef(definitionId);
  if (!definition) throw new Error(`Backup definition "${definitionId}" not found`);
  const destination = await getEffectiveBackupDestination(definitionId);
  if (!destination) throw new Error(`Backup definition "${definitionId}" not found`);

  const run: BackupRun = {
    id: randomUUID(),
    definitionId,
    status: "running",
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sizeBytes: null,
  };
  await appendBackupRunEvent(run);

  void performBackup(run, definition, destination).catch((err) => {
    // performBackup() ne devrait jamais rejeter (elle capture déjà ses propres erreurs) — filet
    // de sécurité supplémentaire pour ne jamais laisser une exception non gérée remonter.
    // eslint-disable-next-line no-console
    console.warn(`[backup-scheduler] unexpected error performing backup ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
  });

  return run;
}

/**
 * Restauration RÉELLE et destructive (cf. ARCHITECTURE.md) : retélécharge l'archive/le dump
 * depuis S3 puis le réapplique — extraction tar dans le volume ou exec
 * psql/mysql/mongorestore dans le conteneur cible avec le fichier téléchargé en entrée standard.
 * Bloquante (contrairement à runBackupNow) : un admin qui déclenche une restauration attend
 * explicitement le résultat définitif (succès/échec), pas un polling — cohérent avec la
 * confirmation forte déjà exigée côté frontend avant l'appel.
 */
export async function restoreBackup(definitionId: string, runId: string): Promise<BackupRestoreResult> {
  const definition = await getBackupDefinitionRef(definitionId);
  if (!definition) throw new Error(`Backup definition "${definitionId}" not found`);
  const run = await getBackupRun(runId);
  if (!run || run.definitionId !== definitionId) {
    throw new Error(`Backup run "${runId}" not found for this definition`);
  }
  if (run.status !== "success" || !run.objectKey) {
    throw new Error(`Backup run "${runId}" has no restorable archive (status: ${run.status})`);
  }
  if (run.rotated) {
    throw new Error(`Backup run "${runId}" was rotated and its archive no longer exists in S3`);
  }

  const destination = await getEffectiveBackupDestination(definitionId);
  if (!destination) throw new Error(`Backup definition "${definitionId}" not found`);

  const tmpDir = await ensureTmpDir();
  const extension = extensionForTarget(definition.target.kind);
  const tmpFile = path.join(tmpDir, `restore-${run.id}.${extension}`);

  try {
    await withTimeout(downloadFromS3(destination, run.objectKey, tmpFile), config.backups.runTimeoutMs, "S3 download");

    const docker = await getClient();
    if (!(await isDockerReachable(docker))) {
      throw new Error("Docker daemon is not reachable");
    }

    if (definition.target.kind === "volume") {
      await withTimeout(extractTarIntoVolume(docker, definition.target.ref, tmpFile), config.backups.runTimeoutMs, "volume restore");
      return { ok: true, message: `Volume "${definition.target.ref}" restauré depuis la sauvegarde du ${run.startedAt}.` };
    }

    const { image } = await requireRunningContainer(docker, definition.target.ref);
    const engine = detectDatabaseEngine(image);
    if (!engine) {
      throw new Error(`Could not detect a supported database engine from image "${image}" (expected postgres/mysql/mariadb/mongo)`);
    }
    await withTimeout(
      execFeedFromFile(docker, definition.target.ref, RESTORE_COMMANDS[engine], tmpFile),
      config.backups.runTimeoutMs,
      "database restore",
    );
    return { ok: true, message: `Base de données restaurée dans le conteneur "${definition.target.ref}" depuis la sauvegarde du ${run.startedAt}.` };
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

// --- Cycle périodique ------------------------------------------------------------------------

/** Résolution standard d'un cron : à la minute près — inutile de ticker plus vite. */
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

// Garde anti-chevauchement (même pattern que scanScheduler.ts/watchdog.ts) : protège contre deux
// CYCLES entiers concurrents, pas seulement contre deux runs de la même définition (déjà exclu
// par le check `lastRun?.status === "running"` ci-dessous).
let cycleInFlight = false;

/**
 * Un cycle complet — exporté pour les tests et un déclenchement manuel éventuel (même pattern que
 * scanScheduler.ts#runScanSchedulerCycle). `now` paramétrable pour les tests.
 */
export async function runBackupSchedulerCycle(now: Date = new Date()): Promise<void> {
  if (cycleInFlight) {
    // eslint-disable-next-line no-console
    console.warn("[backup-scheduler] cycle précédent encore en cours — ce tick est ignoré plutôt que de démarrer un second cycle concurrent");
    return;
  }
  cycleInFlight = true;
  try {
    const definitions = (await listBackupDefinitions()).filter((d) => d.enabled);
    for (const definition of definitions) {
      const runs = await listBackupRuns(definition.id);
      const lastRun = runs[0]; // listBackupRuns trie déjà du plus récent au plus ancien
      if (lastRun?.status === "running") continue; // jamais de double-lancement pour la même définition
      if (!isBackupDue(definition.schedule, lastRun?.startedAt ?? null, now)) continue;
      await runBackupNow(definition.id, "scheduled");
    }
  } catch (err) {
    // Comme scanScheduler.ts/watchdog.ts : ce scheduler ne doit jamais faire planter l'API — une
    // panne de cycle est journalisée puis simplement retentée au prochain tick.
    // eslint-disable-next-line no-console
    console.warn(`[backup-scheduler] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Démarre le scheduler périodique — appelé une seule fois depuis index.ts#main() (jamais depuis
 * buildServer(), même raison que startScanScheduler()/startWatchdog() : ne jamais déclencher de
 * vraie sauvegarde Docker/S3 pendant les tests qui construisent juste le serveur avec
 * `app.inject`). Retourne une fonction d'arrêt à appeler pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startBackupScheduler(intervalMs: number = DEFAULT_TICK_INTERVAL_MS): () => void {
  void runBackupSchedulerCycle();
  const timer = setInterval(() => void runBackupSchedulerCycle(), intervalMs);
  return () => clearInterval(timer);
}
