/**
 * Réconciliation du reverse proxy — la config de Caddy ne vit QU'en mémoire (POST /load, voir
 * services/reverseProxy.ts) : un redémarrage de Caddy la perd et QUAI devient injoignable en
 * HTTPS sans aucun signal (panne réelle constatée). Cette boucle republie au démarrage de l'API
 * puis à intervalle régulier, UNIQUEMENT quand ce que Caddy sert réellement diffère de ce que
 * QUAI attend. Même câblage que watchdog.ts/gitopsReconciler.ts : démarrée depuis index.ts#main()
 * seulement, jamais depuis buildServer().
 */

import { config } from "../config.js";
import {
  buildDesiredCaddyConfig,
  fetchServedCaddyState,
  listRoutes,
  pushDesiredCaddyConfig,
  type ServedCaddyState,
} from "./reverseProxy.js";

const STARTUP_RETRY_DELAY_MS = 5_000;
const STARTUP_MAX_ATTEMPTS = 12;

export type ReverseProxyReconcileOutcome =
  | "empty-store"
  | "caddy-unreachable"
  | "in-sync"
  | "republished"
  | "republish-failed"
  | "cycle-failed"
  | "busy";

export interface ReverseProxyDrift {
  drifted: boolean;
  /** Sous-domaines attendus que Caddy ne sert pas (cas d'un Caddy redémarré, config perdue). */
  missingSubdomains: string[];
  /** Sous-domaines servis par Caddy que QUAI n'attend plus (route supprimée pendant une panne d'API). */
  unexpectedSubdomains: string[];
  /** Adresses d'écoute attendues absentes (ex: `:443` après un retour au Caddyfile de bootstrap). */
  missingListeners: string[];
}

/** État exposé via GET /api/reverse-proxy/status (champ `reconciliation`) — jamais rien d'inventé. */
export interface ReverseProxyReconciliationStatus {
  intervalMs: number;
  /** null tant qu'aucun cycle n'a tourné (boucle non démarrée, ex: en test). */
  lastCheckAt: string | null;
  lastOutcome: ReverseProxyReconcileOutcome | null;
  /** null si QUAI n'a encore jamais republié depuis le démarrage du process. */
  lastRepublishAt: string | null;
  /** null si Caddy n'a encore jamais répondu (jamais interrogé, ou toujours injoignable). */
  caddyReachable: boolean | null;
  driftDetected: boolean | null;
  lastDrift: ReverseProxyDrift | null;
  expectedSubdomains: string[] | null;
  servedSubdomains: string[] | null;
  lastError: string | null;
}

const state: ReverseProxyReconciliationStatus = {
  intervalMs: config.reverseProxy.reconcileIntervalMs,
  lastCheckAt: null,
  lastOutcome: null,
  lastRepublishAt: null,
  caddyReachable: null,
  driftDetected: null,
  lastDrift: null,
  expectedSubdomains: null,
  servedSubdomains: null,
  lastError: null,
};

export function getReverseProxyReconciliationStatus(): ReverseProxyReconciliationStatus {
  return { ...state, intervalMs: config.reverseProxy.reconcileIntervalMs };
}

/** Comparaison SÉMANTIQUE (ensembles de sous-domaines + écoutes), pure et testable sans I/O. */
export function detectReverseProxyDrift(
  desired: { subdomains: readonly string[]; listen: readonly string[] },
  served: { subdomains: readonly string[]; listen: readonly string[] },
): ReverseProxyDrift {
  const servedSubdomains = new Set(served.subdomains.map((value) => value.toLowerCase()));
  const desiredSubdomains = new Set(desired.subdomains.map((value) => value.toLowerCase()));
  const servedListen = new Set(served.listen);
  const missingSubdomains = [...desiredSubdomains].filter((value) => !servedSubdomains.has(value));
  const unexpectedSubdomains = [...servedSubdomains].filter((value) => !desiredSubdomains.has(value));
  const missingListeners = desired.listen.filter((address) => !servedListen.has(address));
  return {
    drifted: missingSubdomains.length > 0 || unexpectedSubdomains.length > 0 || missingListeners.length > 0,
    missingSubdomains,
    unexpectedSubdomains,
    missingListeners,
  };
}

function describeDrift(drift: ReverseProxyDrift): string {
  const parts: string[] = [];
  if (drift.missingSubdomains.length > 0) parts.push(`non servis: ${drift.missingSubdomains.join(", ")}`);
  if (drift.unexpectedSubdomains.length > 0) parts.push(`servis en trop: ${drift.unexpectedSubdomains.join(", ")}`);
  if (drift.missingListeners.length > 0) parts.push(`écoutes manquantes: ${drift.missingListeners.join(", ")}`);
  return parts.join(" ; ");
}

function record(
  outcome: ReverseProxyReconcileOutcome,
  patch: Partial<ReverseProxyReconciliationStatus>,
): ReverseProxyReconcileOutcome {
  state.lastCheckAt = new Date().toISOString();
  state.lastOutcome = outcome;
  Object.assign(state, patch);
  return outcome;
}

// Même garde anti-chevauchement que watchdog.ts : un cycle plus long que l'intervalle ne doit
// jamais en déclencher un second en parallèle (deux POST /load concurrents).
let cycleInFlight = false;

/** Un cycle complet — exporté pour les tests et un déclenchement manuel éventuel. */
export async function runReverseProxyReconcileCycle(): Promise<ReverseProxyReconcileOutcome> {
  if (cycleInFlight) return "busy";
  cycleInFlight = true;
  try {
    const routes = await listRoutes();
    if (routes.length === 0) {
      // Magasin vide : rien à republier, donc AUCUN appel vers Caddy.
      return record("empty-store", { driftDetected: false, lastDrift: null, expectedSubdomains: [], lastError: null });
    }

    let served: ServedCaddyState;
    try {
      served = await fetchServedCaddyState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[reverse-proxy-reconciler] Caddy injoignable, republication reportée : ${message}`);
      return record("caddy-unreachable", { caddyReachable: false, servedSubdomains: null, lastError: message });
    }

    const desired = await buildDesiredCaddyConfig();
    const drift = detectReverseProxyDrift(desired, served);
    const observed: Partial<ReverseProxyReconciliationStatus> = {
      caddyReachable: true,
      driftDetected: drift.drifted,
      lastDrift: drift,
      expectedSubdomains: desired.subdomains,
      servedSubdomains: served.subdomains,
    };

    if (!drift.drifted) {
      // Conforme : on ne recharge JAMAIS Caddy pour rien.
      return record("in-sync", { ...observed, lastError: null });
    }

    try {
      await pushDesiredCaddyConfig(desired);
      // eslint-disable-next-line no-console
      console.info(`[reverse-proxy-reconciler] dérive corrigée, configuration republiée (${describeDrift(drift)})`);
      // POST /load répondu 200 : Caddy sert désormais exactement la config poussée.
      return record("republished", {
        ...observed,
        driftDetected: false,
        lastRepublishAt: new Date().toISOString(),
        servedSubdomains: [...desired.subdomains].sort(),
        lastError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[reverse-proxy-reconciler] republication échouée : ${message}`);
      return record("republish-failed", { ...observed, lastError: message });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[reverse-proxy-reconciler] cycle failed: ${message}`);
    return record("cycle-failed", { lastError: message });
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Démarre la republication au démarrage (réessayée tant que Caddy n'a pas répondu, celui-ci
 * pouvant démarrer après l'API) puis la boucle périodique. Retourne la fonction d'arrêt à appeler
 * pendant l'arrêt propre SIGTERM/SIGINT — elle libère AUSSI le réessai de démarrage en attente.
 */
export function startReverseProxyReconciler(
  intervalMs: number = config.reverseProxy.reconcileIntervalMs,
  startupRetryDelayMs: number = STARTUP_RETRY_DELAY_MS,
  startupMaxAttempts: number = STARTUP_MAX_ATTEMPTS,
): () => void {
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;

  const startupAttempt = async (attempt: number): Promise<void> => {
    if (stopped) return;
    const outcome = await runReverseProxyReconcileCycle();
    if (stopped || outcome !== "caddy-unreachable") return;
    if (attempt >= startupMaxAttempts) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reverse-proxy-reconciler] Caddy toujours injoignable après ${attempt} essais — la boucle périodique prend le relais`,
      );
      return;
    }
    retryTimer = setTimeout(() => void startupAttempt(attempt + 1), startupRetryDelayMs);
  };
  void startupAttempt(1);

  const timer = setInterval(() => void runReverseProxyReconcileCycle(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  };
}
