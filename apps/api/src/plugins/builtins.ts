/**
 * Greffons enregistrés au démarrage du serveur (voir index.ts#buildServer).
 *
 * Le greffon d'exemple (plugins/example) n'est délibérément PAS ici — il sert de modèle et de test
 * de bout en bout, jamais d'intégration réelle visible dans l'interface. Migrer une intégration
 * consiste à ajouter son greffon à cette liste.
 */

import type { Plugin } from "@quai/plugin-contract";
import { glpiPlugin } from "./glpi/index.js";
import { hycuPlugin } from "./hycu/index.js";
import { nutanixPlugin } from "./nutanix/index.js";
import { hasPlugin, registerPlugin } from "./registry.js";
import { threecxPlugin } from "./threecx/index.js";

export const BUILTIN_PLUGINS: readonly Plugin[] = [threecxPlugin, glpiPlugin, hycuPlugin, nutanixPlugin];

/** Idempotent : buildServer() est appelé plusieurs fois dans une même exécution de tests. */
export function registerBuiltinPlugins(): void {
  for (const plugin of BUILTIN_PLUGINS) {
    if (!hasPlugin(plugin.manifest.id)) registerPlugin(plugin);
  }
}
