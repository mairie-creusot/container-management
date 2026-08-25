/**
 * Activation d'un greffon — `enabled` du stockage générique des intégrations, LU par le socle.
 *
 * Désactiver n'efface rien : la configuration (secrets compris) reste écrite, et réactiver la
 * retrouve telle quelle. Un greffon désactivé n'est pas seulement « plus consommé » : son module
 * n'est même pas IMPORTÉ (plugins/loader.ts lit cet état AVANT tout `await import(...)`). Il n'a
 * donc ni tâche prête à tourner, ni contribution au graphe, sans qu'un seul appel réseau soit tenté
 * vers l'intégration.
 *
 * La désactivation est un état EXPLICITE : une entrée existe et porte `enabled: false`. L'ABSENCE
 * d'entrée n'en est pas une — un greffon dont la configuration vit encore dans un champ typé hérité
 * n'a pas encore d'entrée générique et doit continuer de fonctionner exactement comme avant.
 *
 * Périmètre assumé : les routes dédiées héritées (/api/3cx/*, /api/glpi/*, /api/hycu/*,
 * /api/nutanix/*) et les services qu'elles appellent ignorent `enabled` — ils lisent la
 * configuration par plugins/<id>/config.ts#load*PluginConfig, qui la rend quel que soit l'état
 * d'activation. Sans cela, l'écran de configuration afficherait « non configuré » pour un greffon
 * simplement mis en pause, et la convention « secret vide = conserver l'existant » de ces routes
 * effacerait le mot de passe à la première réécriture.
 */

import { getSafeIntegrationConfig } from "../services/setupStore.js";

export async function isPluginDisabled(pluginId: string): Promise<boolean> {
  const entry = await getSafeIntegrationConfig(pluginId);
  return entry !== null && !entry.enabled;
}
