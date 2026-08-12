/**
 * Cron Jobs comme type de service natif (cf. ARCHITECTURE.md, priorité #6 du rapport concurrentiel
 * `docs/reports/competitive-analysis-2026-08-12.md`) — façon Railway (docs.railway.com/cron-jobs) :
 * une définition (services/cronJobsStore.ts) = une expression cron 5 champs standard + une
 * commande shell, exécutée dans un conteneur DÉJÀ EXISTANT via un VRAI `docker exec` (dockerode
 * `container.exec`, exactement le mécanisme déjà utilisé par la console interactive — voir
 * services/docker.ts#openContainerConsole) — jamais de `docker run` éphémère dans ce premier lot
 * (cas d'usage le plus simple et le plus courant à livrer proprement).
 *
 * PARSING CRON — implémentation minimale volontaire (pas de dépendance externe, cohérent avec le
 * principe "rien d'inventé/tiers non maîtrisé" du projet pour un besoin aussi simple) : 5 champs
 * (minute heure jour-du-mois mois jour-de-semaine), chaque champ accepte une étoile (le champ
 * entier), une valeur, une liste séparée par virgules, une plage "a-b", ou un pas ("étoile" ou
 * plage suivie de "slash N") — la syntaxe standard couvrant l'immense majorité des cas réels
 * (ex : l'expression "toutes les 5 minutes" de la doc Railway, minute = étoile-slash-5). Comme le
 * vrai cron Vixie : si jour-du-mois ET jour-de-semaine sont
 * TOUS LES DEUX restreints (différents de `*`), le jour matche si L'UN OU L'AUTRE matche (OR),
 * pas les deux à la fois (AND) — sinon une expression comme "0 0 1 * MON" (le 1er du mois OU tous
 * les lundis) ne matcherait jamais.
 *
 * GARDE ANTI-CHEVAUCHEMENT — "saute le cycle suivant si le précédent tourne encore" (spec exacte
 * de Railway) : `executingJobIds` (Set en mémoire, PAS persisté — perdu au redémarrage du
 * process, acceptable : un run "running" au redémarrage sera de toute façon retrouvé comme tel au
 * prochain tick puisque cette info vit uniquement en mémoire du process courant, jamais un état
 * bloquant durablement) retient les jobs actuellement en cours d'exécution. `decideCronJobTick`
 * (pure, testable sans I/O) décide, pour un job et un instant donnés, s'il faut le déclencher, le
 * SAUTER (chevauchement détecté), ou ne rien faire (pas encore son tour) — jamais de mise en file
 * d'attente : un cycle sauté est un cycle perdu, pas rattrapé plus tard.
 *
 * PRÉCISION — le tick tourne toutes les config.cronJobs.tickIntervalMs (20s par défaut, donc 3
 * ticks par minute) : `lastFiredMinuteKey` (Map en mémoire, par job) garantit qu'un job matchant
 * plusieurs ticks de la même minute n'est traité (déclenché OU sauté) qu'une seule fois pour cette
 * minute. Comme scanScheduler.ts/watchdog.ts, ce module ne doit jamais lancer d'exception vers
 * l'appelant : une panne de cycle est journalisée puis retentée au tick suivant.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { config } from "../config.js";
import { getClient, isDockerReachable } from "./docker.js";
import { getCronJob, listCronJobs } from "./cronJobsStore.js";
import type { CronJobDefinition, CronJobRun, CronJobRunTrigger } from "../types.js";

export class CronJobNotFoundError extends Error {}
export class InvalidCronExpressionError extends Error {}

// --- Parsing cron (pur, sans I/O) -----------------------------------------------------------

interface CronMatcher {
  matches(date: Date): boolean;
}

const FIELD_PATTERN = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

function parseField(expr: string, min: number, max: number): (value: number) => boolean {
  const allowed = new Set<number>();
  for (const part of expr.split(",")) {
    const match = FIELD_PATTERN.exec(part.trim());
    if (!match) {
      throw new InvalidCronExpressionError(`"${part}" is not a valid cron field (expected "*", "N", "A-B", "*/N" or "A-B/N")`);
    }
    const [, rangePart, stepPart] = match;
    const step = stepPart ? Number(stepPart) : 1;
    if (step <= 0) throw new InvalidCronExpressionError(`"${part}" has an invalid step (must be > 0)`);
    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart !== "*") {
      if (rangePart!.includes("-")) {
        const [a, b] = rangePart!.split("-").map(Number) as [number, number];
        rangeStart = a;
        rangeEnd = b;
      } else {
        // Nombre isolé : "N" seul (sans pas) désigne exactement N ; "N" AVEC un pas ("N/S", vrai
        // cron Vixie) désigne "à partir de N jusqu'au bout du champ, tous les S" — PAS juste {N}
        // (sinon un pas appliqué à une seule valeur ne produirait jamais qu'un seul résultat).
        rangeStart = Number(rangePart);
        rangeEnd = stepPart ? max : rangeStart;
      }
    }
    if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
      throw new InvalidCronExpressionError(`"${part}" is out of range (expected ${min}-${max})`);
    }
    for (let v = rangeStart; v <= rangeEnd; v += step) allowed.add(v);
  }
  return (value) => allowed.has(value);
}

/** Parse une expression cron 5 champs — lève InvalidCronExpressionError si invalide. Pure, sans I/O. */
export function parseCronExpression(expression: string): CronMatcher {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(
      `"${expression}" must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = fields as [string, string, string, string, string];
  const minute = parseField(minuteExpr, 0, 59);
  const hour = parseField(hourExpr, 0, 23);
  const dom = parseField(domExpr, 1, 31);
  const month = parseField(monthExpr, 1, 12);
  const dow = parseField(dowExpr, 0, 6); // 0 = dimanche (convention cron standard)
  const domRestricted = domExpr.trim() !== "*";
  const dowRestricted = dowExpr.trim() !== "*";

  return {
    matches(date: Date): boolean {
      if (!minute(date.getMinutes())) return false;
      if (!hour(date.getHours())) return false;
      if (!month(date.getMonth() + 1)) return false;
      const domOk = dom(date.getDate());
      const dowOk = dow(date.getDay());
      // Sémantique Vixie cron : si les deux champs de jour sont restreints, OR plutôt que AND
      // (voir en-tête de fichier) ; sinon comportement AND habituel (l'un des deux vaut toujours
      // true puisque non restreint).
      const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
      return dayOk;
    },
  };
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/** Clé de minute (tronque les secondes/millisecondes) — deux dates dans la même minute partagent
 * la même clé, voir garde de précision en en-tête de fichier. */
export function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

export type CronJobTickDecision = "fire" | "skip-overlap" | "not-due";

/**
 * Décision pure pour un job à un instant donné — testable sans I/O (voir
 * test/cronJobsScheduler.test.ts pour le parsing cron ET la garde anti-chevauchement en
 * isolation). `isExecuting` vient de `executingJobIds` (état en mémoire du scheduler réel).
 */
export function decideCronJobTick(
  job: Pick<CronJobDefinition, "enabled" | "schedule">,
  now: Date,
  lastFiredMinuteKey: string | undefined,
  isExecuting: boolean,
): CronJobTickDecision {
  if (!job.enabled) return "not-due";
  if (lastFiredMinuteKey === minuteKey(now)) return "not-due"; // cette minute a déjà été traitée
  let matcher: CronMatcher;
  try {
    matcher = parseCronExpression(job.schedule);
  } catch {
    return "not-due"; // ne devrait jamais arriver (validé à la création par routes/cronJobs.ts),
    // mais un cycle ne doit JAMAIS planter pour un job mal formé
  }
  if (!matcher.matches(now)) return "not-due";
  return isExecuting ? "skip-overlap" : "fire";
}

// --- Exécution réelle via `docker exec` (dockerode) ------------------------------------------

const MAX_OUTPUT_LENGTH = 64 * 1024; // une sortie de commande peut être volumineuse, même borne d'esprit que scan.ts#maxBuffer

interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Exécute `command` dans le conteneur `containerId` via un VRAI `docker exec` — même mécanisme
 * que services/docker.ts#openContainerConsole (container.exec + exec.start), mais NON interactif
 * (Tty: false, stdout/stderr démultiplexés via docker.modem.demuxStream, même pattern que
 * services/docker.ts#listVolumeFiles pour capturer la sortie d'un conteneur helper).
 */
async function runCommandInContainer(containerId: string, command: string, timeoutMs: number): Promise<ExecResult> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    throw new Error("Docker daemon is not reachable");
  }
  const container = docker.getContainer(containerId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await container.inspect();
  if (info?.State?.Status !== "running") {
    throw new Error(`Container "${containerId}" is not running (state: ${info?.State?.Status ?? "unknown"})`);
  }

  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream: NodeJS.ReadableStream = await exec.start({ hijack: true, Tty: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough();
  stdoutSink.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);

  const streamEnded = new Promise<void>((resolve) => {
    stream.once("end", () => resolve());
  });

  const timedOut = await Promise.race([
    streamEnded.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  let combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
  if (combined.length > MAX_OUTPUT_LENGTH) {
    combined = `${combined.slice(0, MAX_OUTPUT_LENGTH)}\n… (sortie tronquée)`;
  }

  if (timedOut) {
    return { exitCode: null, output: `${combined}\n[QUAI] Commande interrompue après ${timeoutMs}ms (timeout)`, timedOut: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspectResult: any = await exec.inspect();
  const exitCode: number | null = typeof inspectResult?.ExitCode === "number" ? inspectResult.ExitCode : null;
  return { exitCode, output: combined, timedOut: false };
}

// --- Historique d'exécution — JSON Lines append-only, même pattern que scan.ts ----------------

function resolvedHistoryPath(): string {
  return path.resolve(config.cronJobs.historyPath);
}

async function appendRunEvent(run: CronJobRun): Promise<void> {
  try {
    const filePath = resolvedHistoryPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(run)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cron-jobs] failed to persist run event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Dernière version connue de chaque run (une ligne par changement d'état, la plus récente gagne) — même principe que scan.ts#readAllScans. */
async function readAllRuns(): Promise<CronJobRun[]> {
  try {
    const raw = await fs.readFile(resolvedHistoryPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const latestById = new Map<string, CronJobRun>();
    for (const line of lines) {
      try {
        const run = JSON.parse(line) as CronJobRun;
        latestById.set(run.id, run);
      } catch {
        // ligne corrompue : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return [...latestById.values()];
  } catch {
    return [];
  }
}

/** Historique d'un job, les plus récents en premier — voir GET /api/cron-jobs/:id/runs. */
export async function listCronJobRuns(jobId: string): Promise<CronJobRun[]> {
  const all = await readAllRuns();
  return all.filter((r) => r.jobId === jobId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getCronJobRun(runId: string): Promise<CronJobRun | undefined> {
  const all = await readAllRuns();
  return all.find((r) => r.id === runId);
}

// --- Anti-chevauchement + déclenchement --------------------------------------------------------

const executingJobIds = new Set<string>();
const lastFiredMinuteKey = new Map<string, string>();

/**
 * Lance réellement un run — retourne IMMÉDIATEMENT le run à l'état "running" (même pattern que
 * scan.ts#startScan) : `docker exec` continue en arrière-plan, la suite est visible par polling de
 * GET /api/cron-jobs/:id/runs. `executingJobIds.add` est la TOUTE PREMIÈRE instruction (avant tout
 * `await`) pour garantir — grâce au modèle mono-thread de Node — qu'aucun autre appel synchrone à
 * ce module (ex: le prochain job du même cycle de tick) ne puisse voir cet id absent du Set entre
 * ce déclenchement et le premier point de suspension réel.
 */
async function startCronJobRun(job: CronJobDefinition, trigger: CronJobRunTrigger): Promise<CronJobRun> {
  executingJobIds.add(job.id);
  const run: CronJobRun = {
    id: randomUUID(),
    jobId: job.id,
    status: "running",
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
  };
  void appendRunEvent(run);

  void (async () => {
    try {
      const result = await runCommandInContainer(job.containerId, job.command, config.cronJobs.execTimeoutMs);
      const success = !result.timedOut && result.exitCode === 0;
      await appendRunEvent({
        ...run,
        status: success ? "success" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        output: result.output,
      });
    } catch (err) {
      await appendRunEvent({
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        output: err instanceof Error ? err.message : String(err),
      });
    } finally {
      executingJobIds.delete(job.id);
    }
  })();

  return run;
}

/** POST /api/cron-jobs/:id/trigger — déclenchement manuel operator/admin, même job/commande qu'un
 * cycle planifié, seul `trigger` change ("manual" au lieu de "scheduled"). Respecte la MÊME garde
 * anti-chevauchement que le scheduler (refuse si un run de ce job est déjà en cours). */
export async function triggerCronJobRun(jobId: string): Promise<CronJobRun> {
  const job = await getCronJob(jobId);
  if (!job) throw new CronJobNotFoundError(`Cron job "${jobId}" not found`);
  if (executingJobIds.has(jobId)) {
    throw new Error(`Cron job "${job.name}" is already running`);
  }
  return startCronJobRun(job, "manual");
}

/**
 * Un tick complet — exporté pour les tests et un déclenchement manuel éventuel (même pattern que
 * scanScheduler.ts#runScanSchedulerCycle/watchdog.ts#runWatchdogCycle).
 */
export async function runCronJobsSchedulerCycle(now: Date = new Date()): Promise<void> {
  let jobs: CronJobDefinition[];
  try {
    jobs = await listCronJobs();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cron-jobs] failed to read job list: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const job of jobs) {
    const decision = decideCronJobTick(job, now, lastFiredMinuteKey.get(job.id), executingJobIds.has(job.id));
    if (decision === "not-due") continue;
    // "fire" ET "skip-overlap" marquent tous deux cette minute comme traitée pour ce job — un
    // cycle sauté n'est jamais rattrapé au tick suivant de la même minute (voir en-tête de fichier).
    lastFiredMinuteKey.set(job.id, minuteKey(now));
    if (decision === "skip-overlap") {
      // eslint-disable-next-line no-console
      console.warn(`[cron-jobs] "${job.name}" (${job.id}) skipped: previous run still in progress`);
      continue;
    }
    try {
      void startCronJobRun(job, "scheduled");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[cron-jobs] failed to start "${job.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Démarre le tick périodique — appelé une seule fois depuis index.ts#main() (JAMAIS depuis
 * buildServer(), même raison que startWatchdog()/startScanScheduler() : ne jamais déclencher de
 * vrai `docker exec` pendant les tests qui construisent juste le serveur avec `app.inject`).
 * Retourne une fonction d'arrêt à appeler pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startCronJobsScheduler(tickIntervalMs: number = config.cronJobs.tickIntervalMs): () => void {
  const timer = setInterval(() => void runCronJobsSchedulerCycle(), tickIntervalMs);
  return () => clearInterval(timer);
}
