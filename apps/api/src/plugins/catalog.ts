/**
 * CATALOGUE COMPLET : ce que le socle sait charger, après vérification de signature.
 *
 * En image, TOUT vient du répertoire d'installation (plugins/installed.ts) : les intégrations de
 * QUAI y sont posées comme paquets d'origine au premier démarrage (plugins/origin.ts), au même titre
 * qu'un module tiers. Hors image (pnpm dev, vitest), aucun paquet d'origine n'existe : le catalogue
 * interne importé statiquement (plugins/builtins.ts) reprend alors son rôle, sinon plus aucune
 * intégration ne serait disponible en local.
 *
 * Un identifiant de QUAI reste RÉSERVÉ dans les deux cas : un module installé qui le porte n'est
 * accepté que s'il EST le paquet d'origine, c'est-à-dire s'il est signé par la clé d'origine de
 * cette image. Sans cela, il suffirait de déposer un répertoire dans le volume de données pour se
 * substituer à l'intégration Nutanix ou HYCU.
 */

import { BUILTIN_PLUGINS, isBuiltinPluginId } from "./builtins.js";
import type { PluginModuleEntry } from "./builtins.js";
import { installedCatalog } from "./installed.js";
import { ensureOriginBootstrapped, hasOriginPackages } from "./origin.js";

export interface PluginCatalog {
  entries: readonly PluginModuleEntry[];
  /** Modules présents sur le disque mais NON chargeables, avec le motif réel. */
  rejected: readonly { id: string; reason: string }[];
}

function usurpation(id: string): { id: string; reason: string } {
  return {
    id,
    reason: `L'identifiant "${id}" est celui d'un greffon livré avec QUAI : un module installé ne peut pas le remplacer.`,
  };
}

export async function readPluginCatalog(): Promise<PluginCatalog> {
  // Les paquets d'origine sont posés AVANT d'être listés : au premier démarrage, le répertoire
  // d'installation est vide et le catalogue serait sinon vide lui aussi.
  await ensureOriginBootstrapped();

  const installed = await installedCatalog();
  const shipped: readonly PluginModuleEntry[] = (await hasOriginPackages()) ? [] : BUILTIN_PLUGINS;
  const shippedIds = new Set(shipped.map((entry) => entry.id));

  const entries: PluginModuleEntry[] = [...shipped];
  const rejected = [...installed.rejected];

  for (const entry of installed.entries) {
    // Repli de développement : le catalogue interne est déjà en place, un module installé du même
    // identifiant serait un doublon — c'est l'intrus qu'on écarte.
    if (shippedIds.has(entry.id)) {
      rejected.push(usurpation(entry.id));
      continue;
    }
    // En image : seul le paquet d'origine, signé par la clé d'origine, peut porter cet identifiant.
    if (isBuiltinPluginId(entry.id) && entry.origin !== true) {
      rejected.push(usurpation(entry.id));
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
