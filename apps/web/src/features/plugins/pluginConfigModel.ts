// Vue SÛRE de la configuration d'un greffon (GET /api/plugins/:id/config) et dérivations pures qui
// alimentent SchemaForm — aucun réseau, aucun Redux, jamais un secret.

import { isSecretField, type SchemaField, type SchemaValue } from "@/components/SchemaForm";

export interface PluginConfigView {
  configured: boolean;
  enabled: boolean;
  /** Vue sûre : chaque champ secret y est remplacé par un booléen `hasX`. */
  config: Record<string, unknown>;
}

export interface PluginTestOutcome {
  ok: boolean;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `null` = corps inexploitable ; jamais une configuration vide inventée. */
export function normalizePluginConfigPayload(payload: unknown): PluginConfigView | null {
  if (!isRecord(payload)) return null;
  if (typeof payload["configured"] !== "boolean") return null;
  const config = payload["config"];
  return {
    configured: payload["configured"],
    // Seul un `false` explicite met en pause, comme partout ailleurs dans le socle.
    enabled: payload["enabled"] !== false,
    config: isRecord(config) ? config : {},
  };
}

/** `{ ok, message }` du test de connexion ; `null` si la route n'a pas répondu ce qu'elle promet. */
export function normalizePluginTestPayload(payload: unknown): PluginTestOutcome | null {
  if (!isRecord(payload)) return null;
  if (typeof payload["ok"] !== "boolean") return null;
  const message = payload["message"];
  return { ok: payload["ok"], message: typeof message === "string" ? message : "" };
}

/** Même nommage que setupStore#presenceFlagName : le secret « password » sort en « hasPassword ». */
export function presenceFlagName(field: string): string {
  return `has${field.charAt(0).toUpperCase()}${field.slice(1)}`;
}

/** Secrets réellement enregistrés côté serveur — un booléen absent ou faux n'en promet aucun. */
export function storedSecretsFrom(
  secretFields: readonly string[],
  config: Readonly<Record<string, unknown>>,
): string[] {
  return secretFields.filter((field) => config[presenceFlagName(field)] === true);
}

/** Valeurs à réafficher : celles du bon type, jamais un secret (la vue sûre n'en porte aucun). */
export function initialValuesFrom(
  fields: readonly SchemaField[],
  config: Readonly<Record<string, unknown>>,
): Record<string, SchemaValue> {
  const values: Record<string, SchemaValue> = {};
  for (const field of fields) {
    if (isSecretField(field)) continue;
    const raw = config[field.name];
    if (field.type === "boolean") {
      if (typeof raw === "boolean") values[field.name] = raw;
      continue;
    }
    if (field.type === "number") {
      if (typeof raw === "number" && Number.isFinite(raw)) values[field.name] = raw;
      continue;
    }
    if (typeof raw === "string") values[field.name] = raw;
  }
  return values;
}

/** Champ réellement porté par la configuration enregistrée (l'autre branche d'un `showIf` ne l'est pas). */
export function visibleInStoredConfig(
  field: SchemaField,
  config: Readonly<Record<string, unknown>>,
): boolean {
  const condition = field.showIf;
  if (!condition) return true;
  return config[condition.field] === condition.equals;
}
