// Inventaire des modules (livrés avec l'application ou installés) tel qu'il traverse le réseau, et
// dérivation PURE de l'écran des Modules — aucun réseau, aucun Redux, jamais une valeur supposée.

import type { PluginsNavSource, PluginSummary } from "@/features/plugins/pluginsModel";

export type ModuleOrigin = "builtin" | "installed" | "unknown";

/** « untrusted » couvre tous les refus (non signé, clé inconnue, signature invalide) : c'est
 * `reason` qui porte le motif réel, jamais une nuance reconstituée ici. */
export type ModuleTrust = "builtin" | "verified" | "untrusted" | "unknown";

export interface ModuleInventoryEntry {
  id: string;
  name: string;
  /** `null` = version non communiquée. */
  version: string | null;
  origin: ModuleOrigin;
  trust: ModuleTrust;
  /** Clé de signature, telle que nommée par le serveur. */
  signedBy: string | null;
  /** Motif RÉEL du refus, tel que rendu par le serveur. */
  reason: string | null;
  /** Date ISO d'installation et auteur, quand le serveur les a conservés. */
  installedAt: string | null;
  installedBy: string | null;
  removable: boolean;
}

export interface ModuleInventory {
  entries: ModuleInventoryEntry[];
  /** Libellés des clés de confiance — vide si le serveur ne les nomme pas. */
  trustKeys: string[];
  /** Nombre de clés de confiance configurées ; `null` = le serveur ne le dit pas. */
  trustKeyCount: number | null;
  /** `null` = le serveur ne dit pas s'il accepte cette opération. */
  installSupported: boolean | null;
  uninstallSupported: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = readString(source[key]);
    if (found !== null) return found;
  }
  return null;
}

function firstBoolean(source: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

const BUILTIN_WORDS = new Set(["builtin", "built-in", "bundled", "core", "embedded"]);
const INSTALLED_WORDS = new Set(["installed", "external", "third-party", "thirdparty", "user", "sideloaded"]);
const VERIFIED_WORDS = new Set(["verified", "trusted", "valid", "ok", "signed"]);
const UNTRUSTED_WORDS = new Set([
  "untrusted",
  "unsigned",
  "rejected",
  "refused",
  "invalid",
  "failed",
  "revoked",
  "mismatch",
  "unknown-key",
  "unknownkey",
  "none",
  "missing",
]);

function readOrigin(raw: Record<string, unknown>, fallback: ModuleOrigin): ModuleOrigin {
  const flag = firstBoolean(raw, ["builtin", "bundled"]);
  if (flag === true) return "builtin";
  if (flag === false) return "installed";
  const word = firstString(raw, ["origin"]);
  if (word === null) return fallback;
  const value = word.toLowerCase();
  if (BUILTIN_WORDS.has(value)) return "builtin";
  if (INSTALLED_WORDS.has(value)) return "installed";
  return "unknown";
}

/** Bloc de confiance imbriqué quand le serveur en publie un ; sinon les champs restent lus sur
 * l'entrée elle-même, mais seulement sous des noms dédiés (jamais un `status` générique). */
function trustBlockOf(raw: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(raw["trust"])) return raw["trust"];
  if (isRecord(raw["signature"])) return raw["signature"];
  return {};
}

function readTrust(
  raw: Record<string, unknown>,
  block: Record<string, unknown>,
  origin: ModuleOrigin,
): ModuleTrust {
  const word =
    firstString(block, ["status", "state", "result", "verification", "trust"]) ??
    firstString(raw, ["trust", "trustStatus", "signatureStatus"]);
  if (word !== null) {
    const value = word.toLowerCase();
    if (VERIFIED_WORDS.has(value)) return "verified";
    if (UNTRUSTED_WORDS.has(value)) return "untrusted";
    if (BUILTIN_WORDS.has(value)) return "builtin";
    return "unknown";
  }
  const flag =
    firstBoolean(block, ["verified", "trusted", "valid"]) ??
    firstBoolean(raw, ["verified", "trusted", "signatureValid"]);
  if (flag === true) return "verified";
  if (flag === false) return "untrusted";
  return origin === "builtin" ? "builtin" : "unknown";
}

function readEntry(value: unknown, defaultOrigin: ModuleOrigin): ModuleInventoryEntry | null {
  if (!isRecord(value)) return null;
  const manifest: Record<string, unknown> = isRecord(value["manifest"]) ? value["manifest"] : {};
  const id = firstString(value, ["id", "pluginId", "moduleId"]) ?? firstString(manifest, ["id"]);
  if (id === null) return null;

  const block = trustBlockOf(value);
  const origin = readOrigin(value, defaultOrigin);
  const removable = firstBoolean(value, ["removable", "uninstallable"]);

  return {
    id,
    name: firstString(value, ["name", "label"]) ?? firstString(manifest, ["name"]) ?? id,
    version: firstString(value, ["version"]) ?? firstString(manifest, ["version"]),
    origin,
    trust: readTrust(value, block, origin),
    signedBy:
      firstString(block, ["keyId", "key", "signedBy", "signer", "label", "fingerprint"]) ??
      firstString(value, ["signedBy", "keyId"]),
    reason:
      firstString(block, ["reason", "message", "error", "detail"]) ??
      firstString(value, ["trustReason", "reason", "error"]),
    installedAt: firstString(value, ["installedAt", "installed_at"]),
    installedBy: firstString(value, ["installedBy", "installed_by"]),
    removable: removable ?? (origin === "installed"),
  };
}

const ENTRY_KEYS = ["modules", "plugins", "items", "installed"] as const;
const TRUST_KEY_KEYS = ["trustedKeyIds", "trustKeys", "trustedKeys", "keys"] as const;

function readTrustKeys(raw: Record<string, unknown>): string[] {
  for (const key of TRUST_KEY_KEYS) {
    const candidate = raw[key];
    if (!Array.isArray(candidate)) continue;
    const labels: string[] = [];
    for (const item of candidate as unknown[]) {
      const label = isRecord(item)
        ? firstString(item, ["label", "name", "id", "keyId", "fingerprint"])
        : readString(item);
      if (label !== null) labels.push(label);
    }
    return labels;
  }
  return [];
}

function readTrustKeyCount(raw: Record<string, unknown>): number | null {
  for (const key of TRUST_KEY_KEYS) {
    const candidate = raw[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  const explicit = raw["trustKeyCount"];
  return typeof explicit === "number" && Number.isFinite(explicit) ? explicit : null;
}

/**
 * `null` = charge utile inexploitable — jamais un inventaire vide inventé. Cette route décrit les
 * modules INSTALLÉS : une entrée qui ne dit pas son origine en est donc un, et les modules livrés
 * avec l'application n'y figurent pas du tout (deriveModuleRows les ajoute depuis GET /api/plugins).
 */
export function normalizeModuleInventory(
  payload: unknown,
  defaultOrigin: ModuleOrigin = "installed",
): ModuleInventory | null {
  const raw: unknown = Array.isArray(payload) ? { modules: payload } : payload;
  if (!isRecord(raw)) return null;

  let list: unknown[] | null = null;
  for (const key of ENTRY_KEYS) {
    const candidate = raw[key];
    if (Array.isArray(candidate)) {
      list = candidate as unknown[];
      break;
    }
  }
  if (list === null) return null;

  const entries: ModuleInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = readEntry(item, defaultOrigin);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }

  return {
    entries,
    trustKeys: readTrustKeys(raw),
    trustKeyCount: readTrustKeyCount(raw),
    installSupported: firstBoolean(raw, ["installSupported", "canInstall", "installAvailable"]),
    uninstallSupported: firstBoolean(raw, ["uninstallSupported", "canUninstall"]),
  };
}

export type ModuleInventorySource =
  | { status: "ready"; inventory: ModuleInventory }
  | { status: "loading" }
  | { status: "unavailable"; reason: string };

export interface ModuleRow extends ModuleInventoryEntry {
  /** `null` = le serveur ne l'a pas dit — jamais supposé activé ni désactivé. */
  enabled: boolean | null;
  configured: boolean | null;
}

function activationOf(plugins: PluginsNavSource, id: string): { enabled: boolean | null; configured: boolean | null } {
  if (plugins.status !== "ready") return { enabled: null, configured: null };
  const summary = plugins.items.find((entry) => entry.manifest.id === id);
  if (!summary) return { enabled: null, configured: null };
  return { enabled: summary.enabled, configured: summary.configured };
}

/** Module chargé par le serveur mais absent de l'inventaire des installés : il est livré avec
 * l'application. Son nom et sa version viennent de son manifeste, jamais d'ailleurs. */
function rowFromSummary(summary: PluginSummary, origin: ModuleOrigin, trust: ModuleTrust): ModuleRow {
  return {
    id: summary.manifest.id,
    name: readString(summary.manifest.name) ?? summary.manifest.id,
    version: readString(summary.manifest.version),
    origin,
    trust,
    signedBy: null,
    reason: null,
    installedAt: null,
    installedBy: null,
    removable: false,
    enabled: summary.enabled,
    configured: summary.configured,
  };
}

/**
 * Lignes réellement affichables : d'abord les modules livrés avec l'application (chargés par le
 * serveur et absents du répertoire d'installation), puis les modules installés, avec leur signature.
 * Inventaire absent : seuls les modules exposés restent listés, sans origine ni confiance — rien
 * n'est deviné à leur place.
 */
export function deriveModuleRows(source: ModuleInventorySource, plugins: PluginsNavSource): ModuleRow[] {
  // Tant que l'inventaire est en cours de lecture, rien n'est rendu : pas d'origine « non
  // communiquée » qui clignoterait avant la réponse réelle.
  if (source.status === "loading") return [];

  const known = source.status === "ready";
  const installed: readonly ModuleInventoryEntry[] = source.status === "ready" ? source.inventory.entries : [];
  const rows: ModuleRow[] = [];
  const seen = new Set(installed.map((entry) => entry.id));

  if (plugins.status === "ready") {
    for (const summary of plugins.items) {
      const id = summary.manifest.id;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(known ? rowFromSummary(summary, "builtin", "builtin") : rowFromSummary(summary, "unknown", "unknown"));
    }
  }

  for (const entry of installed) {
    rows.push({ ...entry, ...activationOf(plugins, entry.id) });
  }
  return rows;
}

export type ModuleInstallAvailability = "ready" | "no-inventory" | "unsupported" | "no-trust-key";

/** Ce que le serveur permet RÉELLEMENT : aucun bouton d'installation n'est proposé sans clé de
 * confiance, plutôt qu'un bouton dont l'échec est certain. */
export function moduleInstallAvailability(source: ModuleInventorySource): ModuleInstallAvailability {
  if (source.status !== "ready") return "no-inventory";
  // L'absence de clé est examinée D'ABORD : c'est la cause réelle du refus, et la seule qui se
  // corrige. Un serveur sans clé annonce aussi l'installation indisponible — dire « non proposée »
  // masquerait pourquoi.
  if (source.inventory.trustKeyCount === 0) return "no-trust-key";
  if (source.inventory.installSupported === false) return "unsupported";
  return "ready";
}

export function moduleUninstallable(row: ModuleRow, source: ModuleInventorySource): boolean {
  if (source.status !== "ready") return false;
  if (source.inventory.uninstallSupported === false) return false;
  return row.removable;
}

export function moduleOriginLabel(origin: ModuleOrigin): string {
  if (origin === "builtin") return "Livré avec l'application";
  if (origin === "installed") return "Installé";
  return "Origine non communiquée";
}

export function moduleTrustLabel(trust: ModuleTrust): string {
  switch (trust) {
    case "builtin":
      return "Intégré au binaire";
    case "verified":
      return "Signature vérifiée";
    case "untrusted":
      return "Signature refusée";
    default:
      return "Confiance non communiquée";
  }
}

/** Confiance ÉTABLIE — un module dont elle ne l'est pas n'est jamais proposé en un clic. */
export function moduleIsTrusted(row: Pick<ModuleRow, "trust">): boolean {
  return row.trust === "builtin" || row.trust === "verified";
}
