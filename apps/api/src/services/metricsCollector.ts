/**
 * Métriques temps réel et historiques (cf. ARCHITECTURE.md, priorité #5 du rapport concurrentiel
 * `docs/reports/competitive-analysis-2026-08-12.md`) — QUAI expose déjà `cpuPercent`/`memBytes`
 * en INSTANTANÉ (docker.ts#readContainerUsage, utilisé par topology.ts à chaque poll client) mais
 * ne persistait jusqu'ici aucune série temporelle : impossible de tracer une courbe dans le temps
 * ou de diagnostiquer une dérive de charge après coup.
 *
 * Ce module scrape périodiquement (config.metrics.intervalMs, 30s par défaut) TOUS les conteneurs
 * `running` avec exactement le même appel que topology.ts (`readContainerUsage`, aucune
 * réimplémentation) et écrit un point par conteneur par cycle dans un store JSON Lines — même
 * pattern append-only que notifications-log.jsonl/scans.jsonl — mais À FENÊTRE GLISSANTE : chaque
 * cycle purge aussi les points plus vieux que `config.metrics.retentionMs` (7 jours par défaut),
 * contrairement aux journaux d'événements rares du reste du projet qui, eux, ne sont jamais
 * purgés (un événement watchdog/scan est rare ; un point de métrique toutes les 30s par conteneur
 * ne l'est pas — sans purge, le fichier grossirait indéfiniment).
 *
 * Comme scanScheduler.ts/watchdog.ts : ce module ne doit jamais lancer d'exception vers
 * l'appelant, une panne de cycle ne doit jamais faire planter le process ni bloquer le tick
 * suivant.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getClient, isDockerReachable, readContainerUsage } from "./docker.js";
import type { ContainerMetricPoint } from "../types.js";

function resolvedMetricsLogPath(): string {
  return path.resolve(config.metrics.storePath);
}

/** Lit tous les points connus, lignes corrompues ignorées (écriture interrompue) — même défense
 * que scan.ts#readAllScans/notificationsStore.ts#listNotificationEvents. */
async function readAllPoints(): Promise<ContainerMetricPoint[]> {
  try {
    const raw = await fs.readFile(resolvedMetricsLogPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const points: ContainerMetricPoint[] = [];
    for (const line of lines) {
      try {
        points.push(JSON.parse(line) as ContainerMetricPoint);
      } catch {
        // ligne corrompue : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return points;
  } catch {
    return [];
  }
}

async function appendPoints(points: readonly ContainerMetricPoint[]): Promise<void> {
  if (points.length === 0) return;
  const filePath = resolvedMetricsLogPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = points.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await fs.appendFile(filePath, body, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Purge pure — testable sans I/O : conserve uniquement les points dont le timestamp est plus
 * récent que `now - retentionMs`. Extraite en fonction pure pour être vérifiable indépendamment
 * de la fenêtre glissante réelle (7 jours, difficile à tester avec de vraies dates).
 */
export function purgeOldMetricPoints(
  points: readonly ContainerMetricPoint[],
  retentionMs: number,
  now: number,
): ContainerMetricPoint[] {
  const cutoff = now - retentionMs;
  return points.filter((p) => new Date(p.timestamp).getTime() > cutoff);
}

async function rewriteStore(points: readonly ContainerMetricPoint[]): Promise<void> {
  const filePath = resolvedMetricsLogPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = points.length > 0 ? points.map((p) => JSON.stringify(p)).join("\n") + "\n" : "";
  await fs.writeFile(filePath, body, { encoding: "utf-8", mode: 0o600 });
}

/** Points d'un conteneur précis, triés du plus ancien au plus récent (ordre naturel pour un
 * graphique) — filtrage optionnel par fenêtre temporelle (`since`/`until`, ISO 8601). */
export async function listContainerMetrics(
  containerId: string,
  since?: string,
  until?: string,
): Promise<ContainerMetricPoint[]> {
  const all = await readAllPoints();
  return all
    .filter((p) => p.containerId === containerId)
    .filter((p) => (since ? p.timestamp >= since : true))
    .filter((p) => (until ? p.timestamp <= until : true))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Garde anti-chevauchement — même raison que scanScheduler.ts#cycleInFlight : un cycle qui taperait
// `docker stats` sur potentiellement des dizaines de conteneurs peut légitimement dépasser
// `config.metrics.intervalMs` sur un hôte chargé ; sans cette garde, deux cycles concurrents
// pourraient se marcher dessus sur la purge/réécriture du fichier.
let cycleInFlight = false;

/**
 * Un cycle complet — exporté pour les tests et un déclenchement manuel éventuel (même pattern que
 * scanScheduler.ts#runScanSchedulerCycle/watchdog.ts#runWatchdogCycle). Scrape tous les conteneurs
 * `running` du démon LOCAL (même périmètre que scanScheduler.ts — les environnements Docker
 * distants ne sont pas encore câblés dans ce module, cf. ARCHITECTURE.md § "Environnements Docker
 * distants", "Ce qui reste à faire").
 */
export async function runMetricsCollectorCycle(
  retentionMs: number = config.metrics.retentionMs,
): Promise<void> {
  if (cycleInFlight) {
    // eslint-disable-next-line no-console
    console.warn("[metrics-collector] cycle précédent encore en cours — ce tick est ignoré plutôt que de démarrer un second cycle concurrent");
    return;
  }
  cycleInFlight = true;
  try {
    const docker = await getClient();
    if (!(await isDockerReachable(docker))) return;

    const runningContainers = await docker.listContainers({ all: false });
    if (runningContainers.length === 0) return;

    const timestamp = new Date().toISOString();
    const newPoints: ContainerMetricPoint[] = await Promise.all(
      runningContainers.map(async (c): Promise<ContainerMetricPoint> => {
        const usage = await readContainerUsage(docker, c.Id);
        return {
          containerId: c.Id,
          timestamp,
          cpuPercent: usage.cpuPercent,
          memBytes: usage.memBytes,
          // Cumuls réseau/disque réels (voir docker.ts#ContainerUsage) — absents plutôt que 0 pour
          // un conteneur qui n'en rapporte pas (network_mode:host, storage driver sans E/S bloc).
          ...(usage.netRxBytes !== undefined ? { netRxBytes: usage.netRxBytes, netTxBytes: usage.netTxBytes } : {}),
          ...(usage.blkReadBytes !== undefined ? { blkReadBytes: usage.blkReadBytes, blkWriteBytes: usage.blkWriteBytes } : {}),
        };
      }),
    );

    await appendPoints(newPoints);

    // Purge — ne réécrit le fichier que si au moins un point a effectivement été retiré (même
    // principe que topologyPositionsStore.ts#purgeStalePositions : pas d'écriture disque inutile
    // à chaque cycle si la fenêtre de rétention n'a encore rien à purger).
    const all = await readAllPoints();
    const kept = purgeOldMetricPoints(all, retentionMs, Date.now());
    if (kept.length !== all.length) {
      await rewriteStore(kept);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[metrics-collector] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Démarre le scrape périodique — appelé une seule fois depuis index.ts#main() (JAMAIS depuis
 * buildServer(), même raison que startWatchdog()/startScanScheduler() : ne jamais déclencher de
 * vrais appels `docker stats` pendant les tests qui construisent juste le serveur avec
 * `app.inject`). Retourne une fonction d'arrêt à appeler pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startMetricsCollector(intervalMs: number = config.metrics.intervalMs): () => void {
  void runMetricsCollectorCycle();
  const timer = setInterval(() => void runMetricsCollectorCycle(), intervalMs);
  return () => clearInterval(timer);
}
