// Logique pure de la page Sauvegardes (HYCU + ExaGrid) — aucun rendu, testée par backupsModel.test.ts.
import { MISSING } from "@/features/exagrid/exagridFormat";
import type { HycuJob, HycuTarget, HycuVm } from "@/types";

export function formatDateMs(ms?: number): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toLocaleString("fr-FR") : MISSING;
}

/** Statut de job HYCU réel (EXECUTING/OK/WARNING/ERROR) -> props StatusPill ; toute valeur
 * inattendue est affichée brute en neutre, jamais masquée. */
export function jobStatusProps(status: string): { status: string; label?: string } {
  switch (status.toUpperCase()) {
    case "OK":
      return { status: "ok", label: "OK" };
    case "EXECUTING":
      return { status: "executing", label: "En cours" };
    case "WARNING":
      return { status: "warn", label: "Avertissement" };
    case "ERROR":
      return { status: "crit", label: "Erreur" };
    default:
      return { status };
  }
}

export function eventSeverityProps(severity: string): { status: string; label?: string } {
  switch (severity.toUpperCase()) {
    case "ERROR":
      return { status: "crit", label: "Erreur" };
    case "WARNING":
      return { status: "warn", label: "Avertissement" };
    case "INFO":
      return { status: "info", label: "Info" };
    default:
      return { status: severity };
  }
}

/** complianceStatus est un champ supposé (voir apps/api/src/services/hycu.ts) — n'est compté
 * "non conforme" qu'une valeur PRÉSENTE et hors des libellés conformes usuels. */
const COMPLIANT_VALUES = new Set(["COMPLIANT", "OK", "GREEN", "PROTECTED"]);

export interface ComplianceCount {
  withCompliance: number;
  nonCompliant: number;
}

export function countCompliance(vms: HycuVm[]): ComplianceCount {
  const withCompliance = vms.filter((vm) => vm.complianceStatus);
  const nonCompliant = withCompliance.filter((vm) => !COMPLIANT_VALUES.has(vm.complianceStatus!.toUpperCase())).length;
  return { withCompliance: withCompliance.length, nonCompliant };
}

/** Valeur brute conservée en libellé : QUAI colore, il ne renomme pas ce que HYCU rapporte. */
export function complianceProps(value?: string): { status: string; label: string } | null {
  if (!value) return null;
  return { status: COMPLIANT_VALUES.has(value.toUpperCase()) ? "ok" : "warn", label: value };
}

/** Job le plus récent — par startTimeInMillis si exposé, sinon le premier renvoyé par HYCU. */
export function latestJob(jobs: HycuJob[]): HycuJob | null {
  if (jobs.length === 0) return null;
  const withStart = jobs.filter((job) => typeof job.startTimeInMillis === "number");
  if (withStart.length === 0) return jobs[0] ?? null;
  return withStart.reduce((latest, job) => (job.startTimeInMillis! > latest.startTimeInMillis! ? job : latest));
}

// --- Rapprochement HYCU <-> ExaGrid ---------------------------------------------------------
// HYCU n'expose PAS l'adresse d'une cible de sauvegarde : seul son nom est disponible (HycuTarget).
// Le rapprochement se fait donc sur ce nom, et uniquement s'il contient réellement l'adresse ou le
// nom d'hôte de l'appliance ExaGrid configurée, en jeton délimité — jamais sur une ressemblance.

export type ExagridMatchKind = "address" | "hostname";

export interface ExagridTargetMatch {
  target: HycuTarget;
  /** "address" : l'adresse configurée figure telle quelle. "hostname" : seulement son nom court. */
  kind: ExagridMatchKind;
  /** Ce qui a réellement été trouvé dans le nom de la cible, affiché à l'utilisateur. */
  token: string;
}

// Le point fait partie du jeton : "10.20.0.5" ne matche pas "10.20.0.50", ni "exagrid" "exagrid2".
const ADDRESS_BOUNDARY = /[a-z0-9._-]/;
// Pour un nom court, le point délimite : "exagrid" matche "exagrid.lecreusot.priv", pas "exagrid-2".
const HOSTNAME_BOUNDARY = /[a-z0-9-]/;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/\\].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/** Nom court d'un FQDN, seulement s'il est assez distinctif pour ne pas matcher n'importe quoi. */
export function shortLabelOf(host: string): string | null {
  if (IPV4.test(host)) return null;
  const dot = host.indexOf(".");
  if (dot <= 0) return null;
  const label = host.slice(0, dot);
  return label.length >= 3 ? label : null;
}

function containsToken(haystack: string, token: string, boundary: RegExp): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(token, from);
    if (index === -1) return false;
    const before = index === 0 ? "" : haystack.charAt(index - 1);
    const after = haystack.charAt(index + token.length);
    if (!boundary.test(before) && !boundary.test(after)) return true;
    from = index + 1;
  }
}

/** Cibles HYCU qui désignent réellement l'appliance ExaGrid configurée — vide si aucune. */
export function matchExagridTargets(targets: HycuTarget[], rawHost: string | null | undefined): ExagridTargetMatch[] {
  const host = rawHost ? normalizeHost(rawHost) : "";
  if (host === "") return [];
  const exactBoundary = IPV4.test(host) || host.includes(".") ? ADDRESS_BOUNDARY : HOSTNAME_BOUNDARY;
  const short = shortLabelOf(host);

  const matches: ExagridTargetMatch[] = [];
  for (const target of targets) {
    const haystack = (target.name || "").toLowerCase();
    if (haystack === "") continue;
    if (containsToken(haystack, host, exactBoundary)) {
      matches.push({ target, kind: "address", token: host });
      continue;
    }
    if (short && containsToken(haystack, short, HOSTNAME_BOUNDARY)) {
      matches.push({ target, kind: "hostname", token: short });
    }
  }
  // Les correspondances certaines d'abord : c'est la seule sur laquelle QUAI affirme le lien.
  return matches.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "address" ? -1 : 1));
}
