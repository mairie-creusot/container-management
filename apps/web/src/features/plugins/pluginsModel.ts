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

/**
 * Où mène l'entrée d'un module dans le tiroir « Extensions ».
 *  - "page"     : le module apporte sa propre page (Sauvegardes, Téléphonie, Assistance GLPI) ;
 *  - "graph"    : il n'apporte pas de page mais des nœuds — ses données vivent dans le graphe des
 *                 Environnements, c'est là qu'on l'envoie (cas de Nutanix) ;
 *  - "settings" : il n'apporte ni page ni nœud, seule sa configuration existe.
 *
 * Sans ces deux dernières formes, un module parfaitement actif restait absent du menu et se lisait
 * comme un module en panne — la question est revenue deux fois.
 */
export type PluginNavTarget = { kind: "page"; view: ViewId } | { kind: "graph" } | { kind: "settings" };

export interface PluginNavItem {
  pluginId: string;
  label: string;
  target: PluginNavTarget;
  /** Greffon activé mais pas configuré : sa page reste le seul endroit qui l'explique. */
  needsConfiguration: boolean;
}

function manifestName(manifest: PluginManifest): string {
  const name = manifest.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : manifest.id;
}

/**
 * Une entrée par module ACTIF, quelle que soit sa forme. Un module désactivé n'en a pas. Tant que la
 * liste n'a pas répondu (`idle`/`loading`/`unavailable`), le catalogue des pages est rendu tel quel :
 * rien ne disparaît sur une supposition.
 *
 * Ordre : les pages connues d'abord, dans l'ordre du catalogue (le menu ne se réorganise pas sous
 * les yeux de l'utilisateur), puis les autres modules dans l'ordre du serveur.
 */
export function derivePluginNavItems(
  source: PluginsNavSource,
  catalog: readonly PluginNavDefinition[] = PLUGIN_NAV_CATALOG,
): PluginNavItem[] {
  if (source.status !== "ready") {
    return catalog.map((definition) => ({
      pluginId: definition.pluginId,
      label: definition.label,
      target: { kind: "page", view: definition.view },
      needsConfiguration: false,
    }));
  }

  const active = source.items.filter((entry) => entry.enabled);
  const items: PluginNavItem[] = [];
  const placed = new Set<string>();

  for (const definition of catalog) {
    const summary = active.find((entry) => entry.manifest.id === definition.pluginId);
    if (!summary) continue;
    placed.add(definition.pluginId);
    items.push({
      pluginId: definition.pluginId,
      label: definition.label,
      target: { kind: "page", view: definition.view },
      needsConfiguration: !summary.configured,
    });
  }

  for (const summary of active) {
    const id = summary.manifest.id;
    if (placed.has(id)) continue;
    const contributesNodes = (summary.manifest.permissions?.graphNodeKinds?.length ?? 0) > 0;
    items.push({
      pluginId: id,
      label: manifestName(summary.manifest),
      target: contributesNodes ? { kind: "graph" } : { kind: "settings" },
      needsConfiguration: !summary.configured,
    });
  }
  return items;
}

/** Vrai si cette vue n'existe que parce qu'un greffon la fournit. */
export function isPluginView(view: ViewId, catalog: readonly PluginNavDefinition[] = PLUGIN_NAV_CATALOG): boolean {
  return catalog.some((definition) => definition.view === view);
}

/**
 * Ce que ce module APPORTE réellement à l'application, déduit de son manifeste et du catalogue de
 * pages — jamais une description écrite à la main.
 *
 * Cette liste existe parce que « installé mais absent du menu » se lisait comme une panne : Nutanix
 * n'apporte pas de page à lui, il alimente le graphe et sa section de réglages. Le dire sur la carte
 * du module évite de chercher une entrée de menu qui n'a jamais eu lieu d'être.
 */
export function pluginContributions(
  manifest: PluginManifest,
  catalog: readonly PluginNavDefinition[] = PLUGIN_NAV_CATALOG,
): string[] {
  const out: string[] = [];

  const page = catalog.find((definition) => definition.pluginId === manifest.id);
  if (page) out.push(`Page « ${page.label} »`);

  const kinds = manifest.permissions?.graphNodeKinds ?? [];
  if (kinds.length > 0) out.push(kinds.length === 1 ? "Nœuds du graphe (1 type)" : `Nœuds du graphe (${kinds.length} types)`);

  const actions = Object.keys(manifest.actions ?? {}).length;
  if (actions > 0) out.push(actions === 1 ? "1 action" : `${actions} actions`);

  // Toujours vrai pour un module chargé : son formulaire est déduit de `configSchema`.
  out.push("Section de réglages");
  return out;
}
