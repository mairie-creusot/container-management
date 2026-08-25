// Forme réelle de GET /api/plugins + dérivation pure du tiroir « Extensions » (aucun réseau, aucun Redux).

import type { ViewId } from "@/features/ui/uiSlice";

export interface PluginPermissions {
  network?: string[] | undefined;
  mutates?: boolean | undefined;
  graphNodeKinds?: string[] | undefined;
}

/** Miroir de PluginActionSpec (packages/plugin-contract/src/manifest.ts) — description d'une action
 * telle qu'elle traverse le réseau. `input` reste `unknown` : il n'est exploité qu'après conversion
 * par formSchemaFromManifest, seul juge de ce qui est réellement affichable. */
export interface PluginActionCondition {
  field: string;
  equals?: (string | number | boolean | null)[];
  notEquals?: (string | number | boolean | null)[];
  present?: boolean;
}

export interface PluginActionConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  retype?: boolean;
}

export interface PluginActionTarget {
  nodeKind: string;
  field: string;
  menuLabel?: string;
  when?: PluginActionCondition[];
  servedByCore?: string;
}

export interface PluginActionSpec {
  input?: unknown;
  severity?: "safe" | "caution" | "destructive";
  confirm?: PluginActionConfirmation;
  target?: PluginActionTarget;
}

/** Miroir de PluginManifest (packages/plugin-contract) — manifeste public, sans aucune valeur. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  coreApi: string;
  configSchema: unknown;
  secretFields: string[];
  permissions: PluginPermissions;
  auditLabels: Record<string, string>;
  /** Absent pour un greffon qui ne décrit pas ses actions (contrat antérieur à 1.1). */
  actions?: Record<string, PluginActionSpec>;
}

export interface PluginSummary {
  manifest: PluginManifest;
  enabled: boolean;
  configured: boolean;
}

export type PluginsStatus = "idle" | "loading" | "ready" | "unavailable";

/** Le strict nécessaire à la dérivation du menu — l'état complet du slice le satisfait. */
export interface PluginsNavSource {
  status: PluginsStatus;
  items: readonly PluginSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Seul `id` est exigé : c'est le seul champ dont le menu dépend. */
function readManifest(value: unknown): PluginManifest | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "string" || id === "") return null;
  return value as unknown as PluginManifest;
}

/** Accepte l'enveloppe { manifest, enabled, configured } comme le manifeste nu encore renvoyé
 * aujourd'hui ; `null` = charge utile inexploitable, jamais une liste vide inventée. */
export function normalizePluginsPayload(payload: unknown): PluginSummary[] | null {
  if (!isRecord(payload)) return null;
  const raw: unknown = payload["plugins"];
  if (!Array.isArray(raw)) return null;

  const summaries: PluginSummary[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const manifest = readManifest(isRecord(entry["manifest"]) ? entry["manifest"] : entry);
    if (!manifest) continue;
    // Seul un `false` explicite compte : un champ absent ne fait rien disparaître.
    summaries.push({
      manifest,
      enabled: entry["enabled"] !== false,
      configured: entry["configured"] !== false,
    });
  }
  return summaries;
}

export interface PluginNavDefinition {
  pluginId: string;
  view: ViewId;
  label: string;
}

/** Pages apportées par un greffon. « Environnements » (vue `clusters`) n'y figure pas : elle porte
 * aussi les environnements Docker et reste une page du cœur. */
export const PLUGIN_NAV_CATALOG: readonly PluginNavDefinition[] = [
  { pluginId: "hycu", view: "backups", label: "Sauvegardes" },
  { pluginId: "3cx", view: "threecx", label: "Téléphonie" },
  { pluginId: "glpi", view: "glpi", label: "Assistance GLPI" },
];

export interface PluginNavItem extends PluginNavDefinition {
  /** Greffon activé mais pas configuré : sa page reste le seul endroit qui l'explique. */
  needsConfiguration: boolean;
}

/** Greffon désactivé ou inconnu du serveur : pas d'entrée. Liste pas encore obtenue
 * (`idle`/`loading`/`unavailable`) : tout le catalogue, rien ne disparaît sur une supposition. */
export function derivePluginNavItems(
  source: PluginsNavSource,
  catalog: readonly PluginNavDefinition[] = PLUGIN_NAV_CATALOG,
): PluginNavItem[] {
  if (source.status !== "ready") {
    return catalog.map((definition) => ({ ...definition, needsConfiguration: false }));
  }

  const items: PluginNavItem[] = [];
  for (const definition of catalog) {
    const summary = source.items.find((entry) => entry.manifest.id === definition.pluginId);
    if (!summary || !summary.enabled) continue;
    items.push({ ...definition, needsConfiguration: !summary.configured });
  }
  return items;
}

/** Vrai si cette vue n'existe que parce qu'un greffon la fournit. */
export function isPluginView(view: ViewId, catalog: readonly PluginNavDefinition[] = PLUGIN_NAV_CATALOG): boolean {
  return catalog.some((definition) => definition.view === view);
}
