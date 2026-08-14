/**
 * Watchdog — détection PROACTIVE en tâche de fond (contrairement au reste de l'app, qui ne
 * réagit qu'à une action utilisateur) :
 *
 *  1. Nouvelle version d'image disponible pour une image suivie (réutilise getImages("update"),
 *     déjà utilisé par images.ts/topology.ts pour les badges "MàJ dispo").
 *  2. Transition de joignabilité d'une intégration réellement configurée (Docker, Kubernetes,
 *     Nutanix, chaque registry avec identifiants persistés) : joignable -> injoignable, et
 *     injoignable -> de nouveau joignable.
 *
 * Edge-triggered uniquement : un événement n'est émis QUE pour un changement d'état réel par
 * rapport au dernier état CONNU (persisté sur disque, voir loadState/saveState ci-dessous —
 * pas seulement en mémoire process, pour survivre à un redémarrage sans spammer au reboot).
 * Au tout premier cycle (aucun état persisté encore), on établit juste la référence sans rien
 * notifier : sans ça, tout ce qui est déjà "en mise à jour" ou déjà injoignable au moment où
 * cette fonctionnalité est déployée déclencherait une notification, ce qui n'est pas un
 * "nouvel" événement.
 *
 * Jamais de fausse alerte sur une intégration qui n'a jamais été configurée (même garde que
 * kubernetes.ts#isKubernetesConfigured / nutanix.ts#isNutanixConfigured partout ailleurs dans
 * le projet) : Kubernetes/Nutanix/chaque registry ne sont surveillés QUE s'ils ont réellement
 * été configurés ; Docker est surveillé sans garde explicite (l'app tente toujours de le
 * joindre, avec repli sur la démo s'il ne répond pas — voir docker.ts), donc sa joignabilité
 * est toujours pertinente à signaler.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getClient, isDockerReachable } from "./docker.js";
import { getImages } from "./images.js";
import { isKubernetesConfigured, isKubernetesReachable } from "./kubernetes.js";
import { isNutanixConfigured, isNutanixReachable } from "./nutanix.js";
import { recordNotificationEvent } from "./notificationsStore.js";
import { decryptRegistryCredentials, getCurrent } from "./setupStore.js";
import { testRegistryConnection } from "./registries/index.js";
import type { ImageRef } from "../types.js";

const DEFAULT_INTERVAL_MS = 75_000;

interface WatchdogState {
  /** Ids des images actuellement connues comme "mise à jour disponible" (voir ImageRef.id). */
  imagesWithUpdate: string[];
  /** Dernière joignabilité connue par clé d'intégration (ex: "docker", "kubernetes", "registry:ghcr:0"). */
  reachability: Record<string, boolean>;
}

function resolvedStatePath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "watchdog-state.json");
}

async function loadState(): Promise<{ state: WatchdogState; isFirstRun: boolean }> {
  try {
    const raw = await fs.readFile(resolvedStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<WatchdogState>;
    return {
      state: { imagesWithUpdate: parsed.imagesWithUpdate ?? [], reachability: parsed.reachability ?? {} },
      isFirstRun: false,
    };
  } catch {
    return { state: { imagesWithUpdate: [], reachability: {} }, isFirstRun: true };
  }
}

async function saveState(state: WatchdogState): Promise<void> {
  try {
    const filePath = resolvedStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[watchdog] failed to persist state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Images "mise à jour disponible" absentes de l'état précédemment connu — pure, testable sans I/O. */
export function detectNewlyUpdatedImages(previousIds: readonly string[], current: readonly ImageRef[]): ImageRef[] {
  return current.filter((image) => !previousIds.includes(image.id));
}

export type ReachabilityTransition = "became-unreachable" | "became-reachable" | "none";

/**
 * Compare l'état de joignabilité précédent au nouveau — pure, testable sans I/O.
 * `previous === undefined` (intégration jamais observée avant, ex: premier cycle après
 * configuration) ne compte jamais comme une transition : il n'y a pas de "avant" à comparer.
 */
export function detectReachabilityTransition(previous: boolean | undefined, current: boolean): ReachabilityTransition {
  if (previous === undefined || previous === current) return "none";
  return current ? "became-reachable" : "became-unreachable";
}

interface ReachabilityCheck {
  key: string;
  label: string;
  reachable: () => Promise<boolean>;
}

/** Construit la liste des intégrations à surveiller CE cycle — seulement celles réellement configurées. */
async function buildReachabilityChecks(): Promise<ReachabilityCheck[]> {
  const checks: ReachabilityCheck[] = [
    { key: "docker", label: "Docker", reachable: async () => isDockerReachable(await getClient()) },
  ];

  if (await isKubernetesConfigured()) {
    checks.push({ key: "kubernetes", label: "Kubernetes", reachable: isKubernetesReachable });
  }

  if (await isNutanixConfigured()) {
    checks.push({ key: "nutanix", label: "Nutanix", reachable: isNutanixReachable });
  }

  const setup = await getCurrent();
  for (const [index, registry] of (setup.registries ?? []).entries()) {
    // Déchiffrement DIRECT de `registry` (l'entrée précise de CE tour de boucle, pas une
    // recherche par kind) : avec deux registries du même kind (ex: deux comptes GHCR), une
    // résolution par kind aurait testé les DEUX entrées avec les identifiants de la première,
    // ne surveillant jamais réellement la joignabilité propre de la seconde.
    const credentials = decryptRegistryCredentials(registry);
    const hasCredentials = Boolean(credentials?.username || credentials?.password || credentials?.token);
    if (!hasCredentials) continue; // même garde que registriesStore.ts : jamais authentifié -> pas surveillé
    checks.push({
      key: `registry:${registry.kind}:${index}`,
      label: `Registry ${registry.name} (${registry.kind})`,
      reachable: async () => (await testRegistryConnection(registry.kind, registry.url, credentials?.token ?? credentials?.password)).ok,
    });
  }

  return checks;
}

function formatHourMinute(date: Date): string {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function checkImageUpdates(previous: WatchdogState, isFirstRun: boolean, next: WatchdogState): Promise<void> {
  const updatable = await getImages("update");
  next.imagesWithUpdate = updatable.map((image) => image.id);

  if (isFirstRun) return; // baseline seulement, voir commentaire de tête de fichier

  for (const image of detectNewlyUpdatedImages(previous.imagesWithUpdate, updatable)) {
    await recordNotificationEvent({
      kind: "image_update_available",
      level: "info",
      message: `Nouvelle version disponible pour ${image.name}:${image.currentTag} -> ${image.latestTag}`,
    });
  }
}

async function checkReachability(previous: WatchdogState, isFirstRun: boolean, next: WatchdogState): Promise<void> {
  const checks = await buildReachabilityChecks();
  for (const check of checks) {
    const reachable = await check.reachable().catch(() => false);
    next.reachability[check.key] = reachable;
    if (isFirstRun) continue;

    const transition = detectReachabilityTransition(previous.reachability[check.key], reachable);
    if (transition === "became-unreachable") {
      await recordNotificationEvent({
        kind: "integration_unreachable",
        level: "error",
        message: `${check.label} injoignable depuis ${formatHourMinute(new Date())}`,
      });
    } else if (transition === "became-reachable") {
      await recordNotificationEvent({
        kind: "integration_reachable",
        level: "success",
        message: `${check.label} de nouveau joignable`,
      });
    }
  }
}

// Garde anti-chevauchement (voir docs/reports/optimization-audit-2026-08-12.md §M7) : sans elle,
// un cycle plus long que DEFAULT_INTERVAL_MS (75s — plausible si checkReachability traîne sur un
// registry injoignable, voir F1) ferait démarrer un second cycle concurrent avant la fin du
// premier, avec deux loadState()/saveState() concurrents sur watchdog-state.json (dernière
// écriture gagne, une transition détectée par le premier cycle peut être silencieusement écrasée
// par le second qui a chargé un état déjà obsolète).
let cycleInFlight = false;

/** Un cycle complet de détection — exporté pour les tests et pour un déclenchement manuel éventuel. */
export async function runWatchdogCycle(): Promise<void> {
  if (cycleInFlight) {
    // eslint-disable-next-line no-console
    console.warn("[watchdog] cycle précédent encore en cours — ce tick est ignoré plutôt que de démarrer un second cycle concurrent");
    return;
  }
  cycleInFlight = true;
  try {
    const { state: previous, isFirstRun } = await loadState();
    const next: WatchdogState = { imagesWithUpdate: [], reachability: { ...previous.reachability } };

    await checkImageUpdates(previous, isFirstRun, next);
    await checkReachability(previous, isFirstRun, next);

    await saveState(next);
  } catch (err) {
    // Le watchdog ne doit jamais faire planter l'API : une panne de cycle est journalisée puis
    // simplement retentée au prochain tick.
    // eslint-disable-next-line no-console
    console.warn(`[watchdog] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Démarre le scheduler périodique — appelé une seule fois depuis index.ts#main() (jamais
 * depuis buildServer(), pour ne pas déclencher de vrais appels réseau pendant les tests qui
 * construisent juste le serveur avec `app.inject`). Retourne une fonction d'arrêt à appeler
 * pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startWatchdog(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  void runWatchdogCycle();
  const timer = setInterval(() => void runWatchdogCycle(), intervalMs);
  return () => clearInterval(timer);
}
