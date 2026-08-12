/**
 * Scan automatique en tâche de fond des images RÉELLEMENT DÉPLOYÉES — jamais déclenché par un
 * clic (contrairement à POST /api/images/:id/scan, ImagesPage.tsx) : aujourd'hui, un scan Grype
 * ou OSV-Scanner (services/scan.ts) ne part que d'une action manuelle, donc une image tirée en
 * prod peut ne jamais être scannée si personne n'y pense. Ce module comble ça en rafraîchissant
 * périodiquement les scans des images visibles dans le graphe de topologie (conteneurs `running`).
 *
 * DIFFÉRENCE DE NATURE avec watchdog.ts (lire attentivement avant de toucher à ce fichier) :
 * watchdog.ts est EDGE-TRIGGERED — il compare l'état courant à un état PRÉCÉDENT persisté
 * (watchdog-state.json) pour détecter une TRANSITION (image qui vient de passer "à jour" ->
 * "MàJ dispo", intégration qui vient de devenir injoignable) et n'émet qu'au moment du
 * changement. Ce module n'a AUCUNE notion de transition : sa question à chaque cycle n'est pas
 * "qu'est-ce qui a changé depuis le dernier cycle ?" mais "quelles images déployées n'ont
 * jamais été scannées par tel scanner, ou dont le dernier scan réussi par ce scanner date de
 * plus de STALE_AFTER_MS ?" — plus proche d'un cron de rafraîchissement périodique (façon
 * renouvellement de certificat) que d'une détection de changement d'état. Conséquence directe :
 * PAS besoin d'un fichier d'état séparé genre watchdog-state.json. `listScansForImage`/
 * `listAllScans` (services/scan.ts, déjà persistées dans scans.jsonl) donnent déjà, pour
 * n'importe quelle image, "a-t-elle déjà été scannée par ce scanner, et quand pour la dernière
 * fois avec succès" — exactement l'information dont ce module a besoin pour décider, sans rien
 * dupliquer sur disque. Un redémarrage de l'API ne perd donc aucune information utile ici.
 *
 * Résolution "image déployée" : réutilise EXACTEMENT le même client Docker/la même garde de
 * joignabilité que services/topology.ts (getClient + isDockerReachable), mais avec
 * `listContainers({ all: false })` plutôt que `{ all: true }` — seuls les conteneurs `running`
 * comptent comme "actuellement déployés" (une image seulement tirée, ou un conteneur arrêté,
 * n'est volontairement PAS scannée ici : ce n'est pas ce qui tourne réellement en prod).
 *
 * Concurrence : au plus MAX_CONCURRENT_SCANS (2) scans lancés en parallèle. Un scan Grype/
 * OSV-Scanner peut être lourd en CPU (analyse de couches, parfois téléchargement de base de
 * vulnérabilités) ; lancer 20 scans simultanés sur un hôte de dev serait irresponsable. 2 plutôt
 * que 1 (strictement séquentiel) : un léger parallélisme raccourcit un cycle avec plusieurs
 * images dues sans pour autant saturer l'hôte — valeur arbitraire mais documentée, ajustable
 * facilement si besoin (voir MAX_CONCURRENT_SCANS ci-dessous).
 *
 * Double-lancement : avant de considérer une image+scanner "due", on vérifie qu'aucun scan
 * "running" n'existe déjà pour ce couple (même logique que le bouton "Scanner" désactivé pendant
 * qu'un scan tourne côté ImagesPage.tsx) — jamais deux scans concurrents pour la même image+scanner.
 *
 * Notification : un scan automatique qui se termine avec au moins une vulnérabilité Critical
 * émet `vulnerability_detected` (notificationsStore.ts) — un scan qui ne trouve rien de critique
 * ne notifie pas (ce serait du bruit permanent vu la fréquence du cycle). Ce n'est PAS
 * edge-triggered comme le watchdog : un même Critical déjà connu au cycle précédent notifie de
 * nouveau au prochain scan qui le retrouve (pas de mémoire "déjà notifié pour ce CVE") — accepté
 * pour ce premier lot, la fréquence (cycle par défaut 45 min, staleness 24h) limite déjà le bruit.
 */

import { getClient, isDockerReachable } from "./docker.js";
import { getScan, listAllScans, startScan } from "./scan.js";
import { recordNotificationEvent } from "./notificationsStore.js";
import type { ScannerId, ScanResult } from "../types.js";

/** Cycle du scheduler — volontairement bien plus espacé que le watchdog (75s) : un scan complet
 * est coûteux, pas la peine de revérifier en boucle serrée un état qui ne bouge pas vite. */
const DEFAULT_INTERVAL_MS = 45 * 60 * 1000; // 45 min

/** Âge maximal d'un dernier scan réussi avant d'être considéré "à rafraîchir". */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

/** Nombre max de scans lancés en parallèle par cycle — voir en-tête de fichier. */
const MAX_CONCURRENT_SCANS = 2;

/** Intervalle de polling + garde-fou de temps d'attente max par scan, voir waitForScanCompletion. */
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min (premier lancement Grype/OSV peut télécharger sa base)

/** Les deux scanners réels pilotés par QUAI (services/scan.ts) — coexistent, aucun ne remplace l'autre. */
const SCANNERS: readonly ScannerId[] = ["grype", "osv-scanner"];

const SCANNER_LABEL: Record<ScannerId, string> = { grype: "Grype", "osv-scanner": "OSV-Scanner" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Une image+scanner est "due" si : aucun scan de ce scanner n'est actuellement "running" pour
 * cette image (jamais de doublon) ET (aucun scan réussi de ce scanner n'existe jamais pour cette
 * image OU le dernier scan réussi de ce scanner date de plus de `staleAfterMs`). Pure, sans I/O,
 * testable directement — même esprit que watchdog.ts#detectNewlyUpdatedImages/
 * detectReachabilityTransition, mais PAS une comparaison à un état précédent (voir en-tête de
 * fichier) : seulement une lecture de l'historique déjà connu à l'instant `now`.
 */
export function isScanDue(
  scansForImage: readonly ScanResult[],
  scanner: ScannerId,
  staleAfterMs: number,
  now: number,
): boolean {
  const relevant = scansForImage.filter((s) => s.scanner === scanner);
  if (relevant.some((s) => s.status === "running")) return false;
  const lastSuccess = relevant
    .filter((s) => s.status === "success")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!lastSuccess) return true; // jamais scanné avec succès par ce scanner
  return now - new Date(lastSuccess.startedAt).getTime() > staleAfterMs;
}

/** Images (référence Docker "name:tag") des conteneurs RÉELLEMENT en cours d'exécution — pas
 * toutes les images locales jamais tirées, seulement ce qui tourne vraiment (voir en-tête). */
async function listDeployedImages(): Promise<string[]> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) return [];
  const runningContainers = await docker.listContainers({ all: false });
  return [...new Set(runningContainers.map((c) => c.Image))];
}

/** Attend qu'un scan sorte de l'état "running" (polling, même principe que le frontend qui
 * poll GET /api/scans/:scanId) — plafonné à MAX_WAIT_MS pour ne jamais bloquer un cycle
 * indéfiniment ; si le scan tourne encore au-delà, il sera simplement retrouvé "running" par
 * isScanDue() au cycle suivant (pas de double-lancement) et son résultat sera visible par
 * polling normal côté frontend, seule la notification proactive de CE cycle est ratée. */
async function waitForScanCompletion(scanId: string): Promise<ScanResult | undefined> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const scan = await getScan(scanId);
    if (!scan || scan.status !== "running") return scan;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

async function scanDueImage(imageReference: string, scanner: ScannerId): Promise<void> {
  const scan = await startScan(imageReference, scanner, "automatic");
  const finished = await waitForScanCompletion(scan.id);
  if (finished?.status === "success" && finished.summary.Critical > 0) {
    await recordNotificationEvent({
      kind: "vulnerability_detected",
      level: "error",
      message: `${finished.summary.Critical} vulnérabilité(s) critique(s) détectée(s) sur ${imageReference} (${SCANNER_LABEL[scanner]})`,
    });
  }
}

/** Exécute `worker` sur `items` avec au plus `limit` exécutions concurrentes — pool simple à
 * curseur partagé, pas de dépendance externe pour une limite de concurrence aussi basique. */
async function runWithConcurrencyLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runNext(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) return;
    try {
      await worker(items[index] as T);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[scan-scheduler] échec sur un scan dû : ${err instanceof Error ? err.message : String(err)}`);
    }
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
}

// Garde anti-chevauchement (voir docs/reports/optimization-audit-2026-08-12.md §M7) : la garde
// fonctionnelle existante (isScanDue() ignore une image+scanner déjà "running") protège déjà
// contre un DOUBLE SCAN, mais pas contre deux CYCLES entiers concurrents qui relisent listAllScans()
// et recalculent `due` en même temps — un cycle peut légitimement dépasser DEFAULT_INTERVAL_MS
// (jusqu'à MAX_WAIT_MS=10min par scan, plusieurs due en attente derrière MAX_CONCURRENT_SCANS=2).
let cycleInFlight = false;

/**
 * Un cycle complet — exporté pour les tests et pour un déclenchement manuel éventuel (même
 * pattern que watchdog.ts#runWatchdogCycle). `staleAfterMs` paramétrable pour les tests
 * (éviter d'attendre 24h réelles pour vérifier qu'une image redevient "due").
 */
export async function runScanSchedulerCycle(staleAfterMs: number = DEFAULT_STALE_AFTER_MS): Promise<void> {
  if (cycleInFlight) {
    // eslint-disable-next-line no-console
    console.warn("[scan-scheduler] cycle précédent encore en cours — ce tick est ignoré plutôt que de démarrer un second cycle concurrent");
    return;
  }
  cycleInFlight = true;
  try {
    const deployedImages = await listDeployedImages();
    if (deployedImages.length === 0) return;

    // Un seul appel pour tout l'historique, filtré en mémoire par image ensuite — même choix que
    // topology.ts#vulnSummaryForImage (listAllScans + filtre local) plutôt que N appels
    // listScansForImage() (un par image), pour ne relire scans.jsonl qu'une fois par cycle.
    const allScans = await listAllScans();
    const now = Date.now();

    const due: Array<{ image: string; scanner: ScannerId }> = [];
    for (const image of deployedImages) {
      const scansForImage = allScans.filter((s) => s.image === image);
      for (const scanner of SCANNERS) {
        if (isScanDue(scansForImage, scanner, staleAfterMs, now)) {
          due.push({ image, scanner });
        }
      }
    }
    if (due.length === 0) return;

    await runWithConcurrencyLimit(due, MAX_CONCURRENT_SCANS, ({ image, scanner }) => scanDueImage(image, scanner));
  } catch (err) {
    // Comme le watchdog : ce scheduler ne doit jamais faire planter l'API — une panne de cycle
    // est journalisée puis simplement retentée au prochain tick.
    // eslint-disable-next-line no-console
    console.warn(`[scan-scheduler] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Démarre le scheduler périodique — appelé une seule fois depuis index.ts#main() (jamais
 * depuis buildServer(), même raison que startWatchdog() : ne jamais déclencher de vrais appels
 * Docker/scanner pendant les tests qui construisent juste le serveur avec `app.inject`).
 * Retourne une fonction d'arrêt à appeler pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startScanScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  void runScanSchedulerCycle();
  const timer = setInterval(() => void runScanSchedulerCycle(), intervalMs);
  return () => clearInterval(timer);
}
