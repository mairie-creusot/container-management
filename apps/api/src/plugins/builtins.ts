/**
 * Greffons enregistrés au démarrage du serveur (voir index.ts#buildServer).
 *
 * Vide en phase 0 : aucune intégration existante n'est migrée, et le greffon d'exemple
 * (plugins/example) n'est délibérément PAS ici — il sert de modèle et de test de bout en bout,
 * jamais d'intégration réelle visible dans l'interface. Migrer une intégration consistera à
 * ajouter son greffon à cette liste.
 */

import type { Plugin } from "@quai/plugin-contract";
import { hasPlugin, registerPlugin } from "./registry.js";

export const BUILTIN_PLUGINS: readonly Plugin[] = [];

/** Idempotent : buildServer() est appelé plusieurs fois dans une même exécution de tests. */
export function registerBuiltinPlugins(): void {
  for (const plugin of BUILTIN_PLUGINS) {
    if (!hasPlugin(plugin.manifest.id)) registerPlugin(plugin);
  }
}
