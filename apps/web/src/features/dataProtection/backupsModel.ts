// Logique pure de la page Sauvegardes (HYCU) — aucun rendu, testée par backupsModel.test.ts.

/** Valeur absente : un tiret, jamais un zéro qui se ferait passer pour une mesure. */
export const MISSING = "—";

const BYTE_UNITS = ["o", "Kio", "Mio", "Gio", "Tio", "Pio"];

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return MISSING;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 2;
  return `${value.toFixed(decimals).replace(".", ",")} ${BYTE_UNITS[unit] ?? "o"}`;
}

export function formatPercent(percent?: number): string {
  return percent === undefined || !Number.isFinite(percent) ? MISSING : `${percent.toFixed(1).replace(".", ",")} %`;
}
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
