/**
 * CATALOGUE des greffons livrés avec le socle : ce que QUAI sait charger, pas ce qu'il charge.
 *
 * Aucune de ces entrées n'importe le module du greffon : elle porte son identifiant (celui de son
 * manifeste) et de quoi l'importer PLUS TARD. C'est plugins/loader.ts qui décide, à partir de
 * l'état d'activation réel (plugins/activation.ts), lequel est réellement importé — un greffon mis
 * en pause n'est ni importé, ni enregistré, ni sondé : son code n'entre pas dans le process.
 *
 * Le greffon d'exemple (plugins/example) n'est délibérément PAS ici — il sert de modèle et de test
 * de bout en bout, jamais d'intégration réelle visible dans l'interface. Migrer une intégration
 * consiste à ajouter son entrée à cette liste.
 */

export interface PluginModuleEntry {
  /** Identifiant du greffon — connu SANS importer son module, donc utilisable pour décider de
   * l'importer. Le chargeur vérifie qu'il correspond bien à `manifest.id` avant d'enregistrer. */
  id: string;
  /** Nom sous lequel le module exporte son greffon. */
  exportName: string;
  /** Import DYNAMIQUE — appelé uniquement si le greffon est actif. */
  load: () => Promise<unknown>;
}

export const BUILTIN_PLUGINS: readonly PluginModuleEntry[] = [
  { id: "3cx", exportName: "threecxPlugin", load: () => import("./threecx/index.js") },
  { id: "glpi", exportName: "glpiPlugin", load: () => import("./glpi/index.js") },
  { id: "hycu", exportName: "hycuPlugin", load: () => import("./hycu/index.js") },
  { id: "nutanix", exportName: "nutanixPlugin", load: () => import("./nutanix/index.js") },
];

/** Le greffon fait-il partie du catalogue livré ? Vrai même s'il est en pause (donc absent du
 * registre) : c'est ce qui permet de le réactiver sans redémarrage. */
export function isBuiltinPluginId(id: string): boolean {
  return BUILTIN_PLUGINS.some((entry) => entry.id === id);
}
