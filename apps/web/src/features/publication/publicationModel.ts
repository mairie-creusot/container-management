// Modèle de la page Publication : une ligne par service publié, route et certificat rapprochés.
// Aucun rendu ici — logique pure, testée par publicationModel.test.ts.
import type { CertificateSummary } from "@/features/certificates/certificatesSlice";
import type { ReverseProxyRoute } from "@/types";

export const MISSING = "—";

export type PublicationDnsState = "synced" | "failed" | "manual" | "none";

/** "unconfigured" = autorité AD CS absente (aucun certificat ne PEUT exister) ; "missing" =
 * autorité configurée mais ce sous-domaine n'a réellement aucun certificat émis. */
export type PublicationCertState = "valid" | "expiring" | "expired" | "missing" | "unconfigured";

export interface PublicationRow {
  id: string;
  subdomain: string;
  /** `null` pour un certificat émis pour un sujet qui n'est plus publié. */
  route: ReverseProxyRoute | null;
  certificate: CertificateSummary | null;
  target: string;
  /** Explication du port retenu automatiquement — `null` si le port a été saisi. */
  targetHint: string | null;
  autoPort: boolean;
  dns: PublicationDnsState;
  dnsMessage: string | null;
  cert: PublicationCertState;
  daysRemaining: number | null;
  notAfter: string | null;
  publishedAt: string | null;
  renewalError: string | null;
}

export const DNS_LABEL: Record<PublicationDnsState, string> = {
  synced: "Synchronisé",
  failed: "Échec",
  manual: "Manuel",
  none: "Sans objet",
};

/** Jetons de recherche (`dns:échec`) — accentués, la barre de recherche ignore les diacritiques. */
export const DNS_TOKEN: Record<PublicationDnsState, string> = {
  synced: "synchronisé",
  failed: "échec",
  manual: "manuel",
  none: "aucun",
};

export const CERT_LABEL: Record<PublicationCertState, string> = {
  valid: "Valide",
  expiring: "Expire bientôt",
  expired: "Expiré",
  missing: "Aucun certificat",
  unconfigured: "Autorité non configurée",
};

export const CERT_TOKEN: Record<PublicationCertState, string> = {
  valid: "valide",
  expiring: "expirant",
  expired: "expiré",
  missing: "aucun",
  unconfigured: "non-configurée",
};

/** Sujet de certificat et sous-domaine de route comparés sans casse ni point final. */
export function normalizeSubject(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function targetLabel(route: ReverseProxyRoute, containerNameById: Map<string, string>): string {
  if (route.targetContainerId) {
    const name = containerNameById.get(route.targetContainerId) ?? route.targetContainerId.slice(0, 12);
    return `${name} : ${route.targetPort}`;
  }
  if (route.targetHost) return `${route.targetHost} : ${route.targetPort}`;
  return `${MISSING} : ${route.targetPort}`;
}

/** Pourquoi CE port a été retenu quand aucun n'a été saisi (voir ReverseProxyRoute#portDetection). */
export function portDetectionHint(route: ReverseProxyRoute): string | null {
  const detection = route.portDetection;
  if (!detection) return null;
  const origin = detection.source === "exposed" ? "exposés par le conteneur" : "publiés par le conteneur";
  if (detection.rule === "single") return `Port ${route.targetPort} détecté automatiquement (seul port TCP du conteneur).`;
  if (detection.rule === "preferred") {
    return `Port ${route.targetPort} détecté automatiquement parmi les ports ${origin} (${detection.candidates.join(", ")}) — port HTTP usuel prioritaire.`;
  }
  return `Port ${route.targetPort} détecté automatiquement parmi les ports ${origin} (${detection.candidates.join(", ")}) — aucun port HTTP usuel, le plus petit a été retenu.`;
}

export function dnsStateOf(route: ReverseProxyRoute): PublicationDnsState {
  if (!route.dnsSync) return "manual";
  return route.dnsSync.status === "synced" ? "synced" : "failed";
}

function certStateOf(certificate: CertificateSummary | null, authorityConfigured: boolean): PublicationCertState {
  if (!certificate) return authorityConfigured ? "missing" : "unconfigured";
  if (certificate.health === "expired") return "expired";
  if (certificate.health === "expiring") return "expiring";
  return "valid";
}

function expiryTime(certificate: CertificateSummary): number {
  const time = Date.parse(certificate.notAfter);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Rapproche routes et certificats par sujet. Un certificat sans route reste une ligne à part
 * entière — il continue d'être servi et de se renouveler, le masquer le rendrait invisible.
 */
export function buildPublicationRows(
  routes: ReverseProxyRoute[],
  certificates: CertificateSummary[],
  containerNameById: Map<string, string>,
  authorityConfigured: boolean,
): PublicationRow[] {
  const bySubject = new Map<string, CertificateSummary[]>();
  for (const certificate of certificates) {
    const key = normalizeSubject(certificate.subject);
    const bucket = bySubject.get(key);
    if (bucket) bucket.push(certificate);
    else bySubject.set(key, [certificate]);
  }

  const matched = new Set<string>();
  const rows: PublicationRow[] = routes.map((route) => {
    const bucket = bySubject.get(normalizeSubject(route.subdomain)) ?? [];
    // Plusieurs certificats pour un même sujet : celui qui protège le plus longtemps fait foi.
    const certificate = bucket.reduce<CertificateSummary | null>(
      (best, candidate) => (!best || expiryTime(candidate) > expiryTime(best) ? candidate : best),
      null,
    );
    if (certificate) matched.add(certificate.id);
    const hint = portDetectionHint(route);
    return {
      id: `route:${route.id}`,
      subdomain: route.subdomain,
      route,
      certificate,
      target: targetLabel(route, containerNameById),
      targetHint: hint,
      autoPort: !!route.portDetection,
      dns: dnsStateOf(route),
      dnsMessage: route.dnsSync?.message ?? null,
      cert: certStateOf(certificate, authorityConfigured),
      daysRemaining: certificate ? certificate.daysRemaining : null,
      notAfter: certificate ? certificate.notAfter : null,
      publishedAt: route.createdAt,
      renewalError: certificate?.lastRenewalError ?? null,
    };
  });

  for (const certificate of certificates) {
    if (matched.has(certificate.id)) continue;
    rows.push({
      id: `cert:${certificate.id}`,
      subdomain: certificate.subject,
      route: null,
      certificate,
      target: MISSING,
      targetHint: null,
      autoPort: false,
      dns: "none",
      dnsMessage: null,
      cert: certStateOf(certificate, authorityConfigured),
      daysRemaining: certificate.daysRemaining,
      notAfter: certificate.notAfter,
      publishedAt: null,
      renewalError: certificate.lastRenewalError ?? null,
    });
  }

  return rows;
}

export interface PublicationCounters {
  published: number;
  orphanCertificates: number;
  dnsFailed: number;
  certExpiring: number;
  certExpired: number;
  certMissing: number;
}

export function countPublications(rows: PublicationRow[]): PublicationCounters {
  const counters: PublicationCounters = {
    published: 0,
    orphanCertificates: 0,
    dnsFailed: 0,
    certExpiring: 0,
    certExpired: 0,
    certMissing: 0,
  };
  for (const row of rows) {
    if (row.route) counters.published += 1;
    else counters.orphanCertificates += 1;
    if (row.dns === "failed") counters.dnsFailed += 1;
    if (row.cert === "expiring") counters.certExpiring += 1;
    if (row.cert === "expired") counters.certExpired += 1;
    if (row.cert === "missing" && row.route) counters.certMissing += 1;
  }
  return counters;
}

export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return MISSING;
  return new Date(time).toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return MISSING;
  return new Date(time).toLocaleString("fr-FR");
}

/** Ancienneté lisible d'un horodatage ISO — `null` si la date est inexploitable. */
export function formatAgo(iso: string, now = Date.now()): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "à l'instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

export function daysRemainingLabel(days: number | null): string {
  if (days === null) return MISSING;
  if (days < 0) return `expiré depuis ${Math.abs(days)} j`;
  return `${days} j`;
}
