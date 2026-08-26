/**
 * CATALOGUE COMPLET : les greffons livrés avec l'image (plugins/builtins.ts) et les modules
 * installés à chaud dont la signature est vérifiée (plugins/installed.ts).
 *
 * Les livrés priment TOUJOURS : un module installé qui porte l'identifiant d'un greffon du socle est
 * refusé ici aussi, pas seulement à l'installation — sans quoi il suffirait de déposer un répertoire
 * dans le volume de données pour se substituer à l'intégration Nutanix ou HYCU.
 */

import { BUILTIN_PLUGINS, isBuiltinPluginId } from "./builtins.js";
import type { PluginModuleEntry } from "./builtins.js";
import { installedCatalog } from "./installed.js";

export interface PluginCatalog {
  entries: readonly PluginModuleEntry[];
  /** Modules présents sur le disque mais NON chargeables, avec le motif réel. */
  rejected: readonly { id: string; reason: string }[];
}

export async function readPluginCatalog(): Promise<PluginCatalog> {
  const installed = await installedCatalog();
  const entries: PluginModuleEntry[] = [...BUILTIN_PLUGINS];
  const rejected = [...installed.rejected];

  for (const entry of installed.entries) {
    if (isBuiltinPluginId(entry.id)) {
      rejected.push({
        id: entry.id,
        reason: `L'identifiant "${entry.id}" est celui d'un greffon livré avec QUAI : un module installé ne peut pas le remplacer.`,
      });
      continue;
    }
    entries.push(entry);
  }
  return { entries, rejected };
}

export async function findCatalogEntry(id: string): Promise<PluginModuleEntry | undefined> {
  return (await readPluginCatalog()).entries.find((entry) => entry.id === id);
}

/** Le socle sait-il charger ce greffon ? Vrai même s'il est en pause (donc absent du registre). */
export async function isCatalogPluginId(id: string): Promise<boolean> {
  return (await findCatalogEntry(id)) !== undefined;
}
