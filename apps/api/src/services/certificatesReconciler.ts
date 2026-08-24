/**
 * Renouvellement automatique des certificats AD CS avant expiration, et première émission pour les
 * sous-domaines du reverse proxy qui n'en ont pas encore. Démarrée depuis index.ts#main()
 * seulement, jamais depuis buildServer() — même câblage que reverseProxyReconciler.ts.
 *
 * Règle absolue : une autorité injoignable ne casse JAMAIS TLS. Un échec est enregistré et visible,
 * le certificat en place reste stocké et servi jusqu'à sa vraie expiration.
 *
 * Cette boucle est une action SYSTÈME : aucun utilisateur ne lui est attribué au journal d'audit
 * (seules les demandes manuelles passent par une route mutante, auditée par plugins/audit.ts).
 */

import { config } from "../config.js";
import {
  getCertificatesStatus,
  issueCertificate,
  knownSubjects,
  recordRenewalFailure,
  subjectsDueForRenewal,
} from "./certificates.js";
import { getEffectiveCertificatesConfig } from "./setupStore.js";
import { listRoutes, pushConfigToCaddy } from "./reverseProxy.js";

export type CertificatesReconcileOutcome =
  | "not-configured"
  | "nothing-to-do"
  | "renewed"
  | "partial-failure"
  | "cycle-failed"
  | "busy";

export interface CertificatesReconciliationStatus {
  intervalMs: number;
  lastCheckAt: string | null;
  lastOutcome: CertificatesReconcileOutcome | null;
  lastRenewalAt: string | null;
  /** Sujets réellement (ré)émis au dernier cycle. */
  lastRenewedSubjects: string[];
  /** Sujets dont la (ré)émission a échoué au dernier cycle — jamais masqués. */
  lastFailedSubjects: string[];
  lastError: string | null;
}

const state: CertificatesReconciliationStatus = {
  intervalMs: config.certificates.reconcileIntervalMs,
  lastCheckAt: null,
  lastOutcome: null,
  lastRenewalAt: null,
  lastRenewedSubjects: [],
  lastFailedSubjects: [],
  lastError: null,
};

export function getCertificatesReconciliationStatus(): CertificatesReconciliationStatus {
  return { ...state, intervalMs: config.certificates.reconcileIntervalMs };
}

function record(
  outcome: CertificatesReconcileOutcome,
  patch: Partial<CertificatesReconciliationStatus>,
): CertificatesReconcileOutcome {
  state.lastCheckAt = new Date().toISOString();
  state.lastOutcome = outcome;
  Object.assign(state, patch);
  return outcome;
}

/** Sujets à traiter : ceux qui arrivent à échéance, plus les sous-domaines encore sans certificat
 * quand l'émission automatique est active. Pure et testable sans I/O. */
export function planCertificateWork(
  routeSubdomains: readonly string[],
  known: readonly string[],
  dueForRenewal: readonly string[],
  autoEnroll: boolean,
): string[] {
  const knownSet = new Set(known.map((value) => value.toLowerCase()));
  const planned = new Set(dueForRenewal.map((value) => value.toLowerCase()));
  if (autoEnroll) {
    for (const subdomain of routeSubdomains) {
      const normalized = subdomain.toLowerCase();
      if (!knownSet.has(normalized)) planned.add(normalized);
    }
  }
  return [...planned].sort();
}

let cycleInFlight = false;

/** Un cycle complet — exporté pour les tests et un déclenchement manuel éventuel. */
export async function runCertificatesReconcileCycle(): Promise<CertificatesReconcileOutcome> {
  if (cycleInFlight) return "busy";
  cycleInFlight = true;
  try {
    const cfg = await getEffectiveCertificatesConfig();
    if (!cfg) {
      // Jamais configuré : aucun appel réseau, et Caddy garde son autorité interne pour tout.
      return record("not-configured", { lastRenewedSubjects: [], lastFailedSubjects: [], lastError: null });
    }

    const routes = await listRoutes();
    const planned = planCertificateWork(
      routes.map((route) => route.subdomain),
      await knownSubjects(),
      await subjectsDueForRenewal(),
      cfg.autoEnroll ?? true,
    );
    if (planned.length === 0) {
      return record("nothing-to-do", { lastRenewedSubjects: [], lastFailedSubjects: [], lastError: null });
    }

    const renewed: string[] = [];
    const failed: string[] = [];
    let lastError: string | null = null;
    for (const subject of planned) {
      try {
        await issueCertificate(subject);
        renewed.push(subject);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push(subject);
        lastError = message;
        // Le certificat déjà en place (s'il existe) reste intact et servi.
        await recordRenewalFailure(subject, message);
        // eslint-disable-next-line no-console
        console.warn(`[certificates-reconciler] émission/renouvellement échoué pour ${subject} : ${message}`);
      }
    }

    if (renewed.length > 0) {
      // Republie la config complète pour que Caddy serve les nouveaux certificats (POST /load
      // remplace tout : le certificat doit venir de buildDesiredCaddyConfig(), voir reverseProxy.ts).
      try {
        await pushConfigToCaddy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        // eslint-disable-next-line no-console
        console.warn(`[certificates-reconciler] certificats obtenus mais republication Caddy échouée : ${message}`);
      }
    }

    const patch = {
      lastRenewedSubjects: renewed,
      lastFailedSubjects: failed,
      lastError,
      ...(renewed.length > 0 ? { lastRenewalAt: new Date().toISOString() } : {}),
    };
    if (failed.length > 0) return record("partial-failure", patch);
    return record("renewed", patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[certificates-reconciler] cycle failed: ${message}`);
    return record("cycle-failed", { lastError: message });
  } finally {
    cycleInFlight = false;
  }
}

/** Renouvellement manuel d'un sujet (POST /api/certificates/issue) — republie Caddy. Appelé depuis
 * une route mutante : plugins/audit.ts journalise déjà l'utilisateur qui l'a demandé. */
export async function renewSubjectNow(subject: string): Promise<void> {
  await issueCertificate(subject);
  await pushConfigToCaddy();
}

/** Démarre la boucle et retourne sa fonction d'arrêt (appelée pendant l'arrêt propre). */
export function startCertificatesReconciler(
  intervalMs: number = config.certificates.reconcileIntervalMs,
): () => void {
  void runCertificatesReconcileCycle();
  const timer = setInterval(() => void runCertificatesReconcileCycle(), intervalMs);
  return () => clearInterval(timer);
}

/** Réexport pratique pour les routes : l'état complet en une seule lecture. */
export async function certificatesOverview() {
  return { ...(await getCertificatesStatus()), reconciliation: getCertificatesReconciliationStatus() };
}
