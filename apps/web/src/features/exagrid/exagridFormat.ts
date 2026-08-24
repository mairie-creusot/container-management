// Formatage des relevés SNMP ExaGrid — une valeur absente de la MIB reste absente (jamais 0).
import type { ExagridSnmpVersion } from "@/types";

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

export function formatAge(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return MISSING;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

// Seuils d'ALERTE VISUELLE QUAI sur l'ancienneté d'une file d'attente (la MIB ne publie aucun
// seuil) — la valeur exacte reste affichée à côté.
export const AGE_WARNING_SECONDS = 24 * 3600;
export const AGE_CRITICAL_SECONDS = 72 * 3600;

export function ageSeverityClass(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds >= AGE_CRITICAL_SECONDS) return " is-critical";
  if (seconds >= AGE_WARNING_SECONDS) return " is-warning";
  return "";
}

export function usageSeverityClass(percent?: number): string {
  if (percent === undefined || !Number.isFinite(percent)) return "";
  if (percent >= 90) return " is-critical";
  if (percent >= 75) return " is-warning";
  return "";
}

export function versionLabel(version?: ExagridSnmpVersion): string {
  if (version === "2c") return "SNMP v2c";
  if (version === "3") return "SNMP v3";
  return MISSING;
}
