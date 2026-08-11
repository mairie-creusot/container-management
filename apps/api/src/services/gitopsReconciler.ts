/**
 * GitOps reconciler — boucle de réconciliation PROACTIVE en tâche de fond, même principe que
 * le watchdog (voir services/watchdog.ts, dont ce module reproduit délibérément le pattern
 * exact) : elle ne fait QUE détecter et signaler la dérive, jamais l'appliquer.
 *
 * ARCHITECTURE.md est explicite : "l'application du changement reste une action explicite
 * depuis l'UI" — exactement comme les mises à jour d'image. Ce module n'appelle donc JAMAIS
 * services/gitops.ts#sync() (qui resynchronise réellement), seulement listGitOpsFiles() (pure
 * lecture, calcule juste la dérive courante sans rien modifier). La resynchronisation reste un
 * clic humain sur POST /api/gitops/sync, inchangé.
 *
 * Edge-triggered uniquement : un événement n'est émis QUE pour un changement d'état réel par
 * rapport au dernier état CONNU (persisté sur disque, voir loadState/saveState — pas seulement
 * en mémoire process, pour survivre à un redémarrage sans spammer au reboot). Au tout premier
 * cycle (aucun état persisté), on établit juste la référence sans rien notifier : sinon toute
 * dérive déjà présente au déploiement de cette fonctionnalité déclencherait une notification,
 * ce qui n'est pas un "nouvel" événement.
 *
 * Jamais d'exception qui remonte : un cycle qui échoue est journalisé puis simplement retenté
 * au prochain tick, comme le watchdog.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listGitOpsFiles } from "./gitops.js";
import { recordNotificationEvent } from "./notificationsStore.js";

const DEFAULT_INTERVAL_MS = 90_000;

interface ReconcilerState {
  /** Chemins actuellement connus comme "en dérive" (GitOpsFile.drift === true). */
  driftingPaths: string[];
}

function resolvedStatePath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "gitops-reconciler-state.json");
}

async function loadState(): Promise<{ state: ReconcilerState; isFirstRun: boolean }> {
  try {
    const raw = await fs.readFile(resolvedStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReconcilerState>;
    return { state: { driftingPaths: parsed.driftingPaths ?? [] }, isFirstRun: false };
  } catch {
    return { state: { driftingPaths: [] }, isFirstRun: true };
  }
}

async function saveState(state: ReconcilerState): Promise<void> {
  try {
    const filePath = resolvedStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gitops-reconciler] failed to persist state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface DriftTransitions {
  /** Chemins qui viennent de passer de "pas en dérive" à "en dérive". */
  newlyDrifting: string[];
  /** Chemins qui viennent de repasser de "en dérive" à "pas en dérive". */
  resolved: string[];
}

/**
 * Compare l'ensemble des chemins en dérive précédemment connu au nouvel ensemble courant —
 * pure, testable sans I/O. Symétrique à watchdog.ts#detectReachabilityTransition.
 */
export function detectDriftTransitions(
  previousDriftingPaths: readonly string[],
  currentDriftingPaths: readonly string[],
): DriftTransitions {
  const previousSet = new Set(previousDriftingPaths);
  const currentSet = new Set(currentDriftingPaths);
  return {
    newlyDrifting: currentDriftingPaths.filter((p) => !previousSet.has(p)),
    resolved: previousDriftingPaths.filter((p) => !currentSet.has(p)),
  };
}

/** Un cycle complet de réconciliation — exporté pour les tests et un déclenchement manuel éventuel. */
export async function runGitopsReconcilerCycle(): Promise<void> {
  try {
    const { state: previous, isFirstRun } = await loadState();

    // Lecture seule : calcule la dérive courante sans jamais l'appliquer (voir commentaire de
    // tête de fichier — sync() n'est JAMAIS appelé ici).
    const files = await listGitOpsFiles();
    const currentDriftingPaths = files.filter((f) => f.drift).map((f) => f.path);

    if (!isFirstRun) {
      const { newlyDrifting, resolved } = detectDriftTransitions(previous.driftingPaths, currentDriftingPaths);

      for (const filePath of newlyDrifting) {
        await recordNotificationEvent({
          kind: "gitops_drift_detected",
          level: "error",
          message: `Dérive GitOps détectée sur ${filePath} — resynchronisation manuelle requise`,
        });
      }

      for (const filePath of resolved) {
        await recordNotificationEvent({
          kind: "gitops_drift_detected",
          level: "success",
          message: `Dérive GitOps résorbée sur ${filePath} — état réel de nouveau conforme au dépôt`,
        });
      }
    }

    await saveState({ driftingPaths: currentDriftingPaths });
  } catch (err) {
    // Comme le watchdog : ce cycle ne doit jamais faire planter l'API — une panne est
    // journalisée puis simplement retentée au prochain tick.
    // eslint-disable-next-line no-console
    console.warn(`[gitops-reconciler] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Démarre le scheduler périodique — appelé une seule fois depuis index.ts#main() (jamais
 * depuis buildServer(), pour ne pas déclencher de vrais appels réseau/lecture disque pendant
 * les tests qui construisent juste le serveur avec `app.inject`). Retourne une fonction
 * d'arrêt à appeler pendant l'arrêt propre SIGTERM/SIGINT.
 */
export function startGitopsReconciler(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  void runGitopsReconcilerCycle();
  const timer = setInterval(() => void runGitopsReconcilerCycle(), intervalMs);
  return () => clearInterval(timer);
}
