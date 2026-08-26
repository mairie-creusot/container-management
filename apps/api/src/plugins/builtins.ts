/**
 * CATALOGUE INTERNE des greffons livrés avec le socle : ce que QUAI sait charger, pas ce qu'il charge.
 *
 * REPLI DE DÉVELOPPEMENT depuis l'empaquetage d'origine : en image, ces quatre intégrations sont
 * livrées comme PAQUETS SIGNÉS installés dans le volume de données (plugins/origin.ts) et cette
 * liste ne sert plus de catalogue. Elle reprend son rôle dès que l'image ne fournit aucun paquet
 * d'origine — `pnpm dev`, `vitest` — sinon plus aucune intégration ne serait disponible en local.
 * Dans les deux cas elle reste la liste des identifiants RÉSERVÉS à QUAI (isBuiltinPluginId).
 *
 * Aucune de ces entrées n'importe le module du greffon : elle porte son identifiant (celui de son
 * manifeste) et de quoi l'importer PLUS TARD. C'est plugins/loader.ts qui décide, à partir de
 * l'état d'activation réel (plugins/activation.ts), lequel est réellement importé — un greffon mis
 * en pause n'est ni importé, ni enregistré, ni sondé : son code n'entre pas dans le process.
 *
 * Le greffon d'exemple (plugins/example) n'est délibérément PAS ici — il sert de modèle et de test
 * de bout en bout, jamais d'intégration réelle visible dans l'interface. Migrer une intégration
 * consiste à ajouter son entrée à cette liste.
 *
 * Cette liste est le catalogue INTERNE, celui du code livré. Les modules installés à chaud, eux,
 * viennent du répertoire de données après vérification de leur signature (plugins/installed.ts) ;
 * plugins/catalog.ts réunit les deux, et un module installé ne peut jamais usurper un identifiant
 * qui figure ici.
 */

export interface PluginModuleEntry {
  /** Identifiant du greffon — connu SANS importer son module, donc utilisable pour décider de
   * l'importer. Le chargeur vérifie qu'il correspond bien à `manifest.id` avant d'enregistrer. */
  id: string;
  /** Nom sous lequel le module exporte son greffon. */
  exportName: string;
  /** Paquet d'ORIGINE de cette image — prouvé par la clé qui a signé le paquet, jamais déclaré. */
  origin?: boolean;
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
