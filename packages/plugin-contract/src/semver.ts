/**
 * Semver minimal et PUR (aucune dépendance) : juste ce dont le socle a besoin — valider la version
 * d'un greffon et décider si la version du socle satisfait sa plage `coreApi`.
 */

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const RANGE_PATTERN = /^([\^~]?)(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string | undefined;
}

export type SemverRangeOperator = "^" | "~" | "=";

export interface SemverRange {
  operator: SemverRangeOperator;
  major: number;
  minor: number;
  /** Absent pour une plage à deux composantes ("^1.0", "1.0") : le correctif est alors libre. */
  patch?: number | undefined;
}

export function parseSemver(value: string): Semver | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

export function isSemver(value: unknown): boolean {
  return typeof value === "string" && parseSemver(value) !== undefined;
}

/** Formats acceptés : "^1.0", "^1.0.2", "~1.0", "~1.0.2", "1.0", "1.0.2". */
export function parseSemverRange(value: string): SemverRange | undefined {
  const match = RANGE_PATTERN.exec(value);
  if (!match) return undefined;
  const [, operator, major, minor, patch] = match;
  if (major === undefined || minor === undefined) return undefined;
  return {
    operator: operator === "^" || operator === "~" ? operator : "=",
    major: Number(major),
    minor: Number(minor),
    patch: patch === undefined ? undefined : Number(patch),
  };
}

function compareCore(version: Semver, major: number, minor: number, patch: number): number {
  if (version.major !== major) return version.major - major;
  if (version.minor !== minor) return version.minor - minor;
  return version.patch - patch;
}

/** Une préversion ne satisfait aucune plage (règle npm) — le socle n'expose jamais de préversion. */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  const parsedRange = parseSemverRange(range);
  if (!parsed || !parsedRange) return false;
  if (parsed.prerelease !== undefined) return false;

  const lowerPatch = parsedRange.patch ?? 0;
  if (compareCore(parsed, parsedRange.major, parsedRange.minor, lowerPatch) < 0) return false;

  if (parsedRange.operator === "=") {
    if (parsed.major !== parsedRange.major || parsed.minor !== parsedRange.minor) return false;
    return parsedRange.patch === undefined || parsed.patch === parsedRange.patch;
  }

  if (parsedRange.operator === "~") {
    return parsed.major === parsedRange.major && parsed.minor === parsedRange.minor;
  }

  // "^" : compatible tant que le premier composant non nul ne change pas.
  if (parsedRange.major > 0) return parsed.major === parsedRange.major;
  if (parsedRange.minor > 0 || parsedRange.patch === undefined) {
    return parsed.major === 0 && parsed.minor === parsedRange.minor;
  }
  return parsed.major === 0 && parsed.minor === 0 && parsed.patch === parsedRange.patch;
}
