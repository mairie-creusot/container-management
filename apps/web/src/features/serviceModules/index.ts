/**
 * Point d'entrée UNIQUE de la fonctionnalité "module métier par nœud" — tout ce qu'un consommateur
 * du graphe (TopologyGraph.tsx, TopologySubGraphPanel.tsx) doit importer pour :
 *  - savoir quels nœuds portent un module     -> useServiceModuleBindings()
 *  - afficher la pastille sur une carte        -> serviceModuleBadge() (topologyNodeContract.tsx)
 *  - proposer "Ouvrir le module" au clic droit -> serviceModuleMenuItem()
 *  - rendre le module dans le sous-graphe      -> <ServiceModuleView />
 *
 * Le double-clic est déjà couvert sans câblage supplémentaire : TopologyGraph.tsx ouvre déjà
 * TopologySubGraphPanel au double-clic sur n'importe quel nœud, et ce panneau détecte lui-même la
 * liaison du nœud racine pour ouvrir directement l'onglet "Module".
 */

export { default as ServiceModuleView, MODULE_SNAPSHOT_POLL_INTERVAL_MS } from "./ServiceModuleView";
export { default as ServiceModuleBindModal } from "./ServiceModuleBindModal";
export { useServiceModuleBindings } from "./useServiceModuleBindings";
export {
  buildServiceModuleGraph,
  layoutServiceModuleEntities,
  relationEdgeState,
  serviceModuleNodeTypes,
  ServiceModuleNode,
} from "./serviceModuleGraph";
export {
  deleteServiceModuleBinding,
  fetchServiceModuleBindings,
  fetchServiceModuleSnapshot,
  fetchServiceModules,
  putServiceModuleBinding,
} from "./api";
export type {
  ResolvedServiceModuleBinding,
  ServiceModuleBinding,
  ServiceModuleDescriptor,
  ServiceModuleEntity,
  ServiceModuleRelation,
  ServiceModuleSnapshot,
  ServiceModuleSummaryItem,
} from "./types";

import type { ResolvedServiceModuleBinding } from "./types";

/**
 * Entrée de menu contextuel « Ouvrir le module <label> » — structurellement assignable à
 * ContextMenuItem (ContextMenu.tsx) sans dépendre de ce composant, même convention que
 * buildNodeMenuItems (topologyNodeContract.tsx) : la LISTE est déclarée ici, le callback réel
 * (ouvrir le sous-graphe sur ce nœud) reste injecté par l'appelant, seul à savoir le faire.
 * `null` pour un nœud sans module — aucune entrée morte dans le menu.
 */
export function serviceModuleMenuItem(
  binding: ResolvedServiceModuleBinding | undefined,
  onOpen: () => void,
): { label: string; onClick: () => void } | null {
  if (!binding) return null;
  return { label: `Ouvrir le module ${binding.moduleLabel}`, onClick: onOpen };
}
