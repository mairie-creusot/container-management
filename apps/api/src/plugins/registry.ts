/**
 * Registre des GREFFONS d'intégration (à ne pas confondre avec les plugins Fastify auth.ts/audit.ts
 * de ce dossier). Un manifeste non conforme au contrat est refusé en bloc, avec son motif.
 *
 * Le registre ne contient QUE les greffons réellement chargés : c'est plugins/loader.ts qui décide
 * lesquels importer (les actifs) et qui les retire d'ici dès qu'ils sont mis en pause. Un greffon
 * absent de ce registre n'a donc pas seulement disparu de l'écran — son module n'est pas chargé.
 *
 * Ce qui entre ici a ses appels BORNÉS dans le temps (plugins/guard.ts) : aucun appelant du socle
 * n'a à se souvenir de poser un délai sur test/snapshot/graph/actions.
 */

import { CORE_API_VERSION, publicManifest, validatePlugin } from "@quai/plugin-contract";
import type { Plugin, PluginValidationIssue, PublicPluginManifest } from "@quai/plugin-contract";
import { guardPluginCalls } from "./guard.js";

export class PluginRegistrationError extends Error {
  readonly issues: PluginValidationIssue[];

  constructor(id: string, issues: PluginValidationIssue[]) {
    super(`Greffon ${id} refusé : ${issues.map((issue) => issue.message).join(" ; ")}`);
    this.name = "PluginRegistrationError";
    this.issues = issues;
  }
}

const registry = new Map<string, Plugin>();

/** Identifiant lisible pour le message d'erreur, même quand le manifeste est inexploitable. */
function describeCandidate(candidate: unknown): string {
  const manifest = (candidate as { manifest?: { id?: unknown } } | null | undefined)?.manifest;
  return typeof manifest?.id === "string" && manifest.id.length > 0 ? `"${manifest.id}"` : "(sans identifiant)";
}

export function registerPlugin(candidate: unknown): Plugin {
  const result = validatePlugin(candidate, { coreApiVersion: CORE_API_VERSION });
  if (!result.ok) throw new PluginRegistrationError(describeCandidate(candidate), result.issues);

  const plugin = result.plugin;
  const id = plugin.manifest.id;
  if (registry.has(id)) {
    throw new PluginRegistrationError(`"${id}"`, [
      {
        code: "registry.duplicateId",
        field: "id",
        message: `Un greffon portant l'identifiant "${id}" est déjà enregistré — un identifiant est unique dans tout le socle.`,
      },
    ]);
  }

  // Ce qui entre au registre, c'est le greffon dont les appels sont BORNÉS dans le temps : plus
  // aucun appelant n'a à se souvenir de poser un délai (voir plugins/guard.ts).
  const bounded = guardPluginCalls(plugin);
  registry.set(id, bounded);
  return bounded;
}

/** Retire un greffon mis en pause. `false` s'il n'était pas enregistré — jamais une exception :
 * désactiver deux fois de suite n'est pas une erreur. Le module déjà importé reste dans le cache de
 * modules de Node (on ne peut pas l'en sortir), mais plus rien ne l'appelle. */
export function unregisterPlugin(id: string): boolean {
  return registry.delete(id);
}

export function listPlugins(): Plugin[] {
  return [...registry.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function getPlugin(id: string): Plugin | undefined {
  return registry.get(id);
}

export function hasPlugin(id: string): boolean {
  return registry.has(id);
}

/** Ce que GET /api/plugins expose : manifestes expurgés, aucune valeur de configuration. */
export function listPluginManifests(): PublicPluginManifest[] {
  return listPlugins().map((plugin) => publicManifest(plugin.manifest));
}

export function resetPluginRegistryForTests(): void {
  registry.clear();
}
