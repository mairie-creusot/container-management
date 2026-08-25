/**
 * Contribution au graphe : ce qu'un greffon peut désigner CHEZ LES AUTRES.
 *
 * `Plugin#graph()` (voir manifest.ts) ne reçoit que sa propre configuration : un greffon y décrit
 * SES nœuds, et rien d'autre — il ne peut pas nommer un nœud qu'un autre greffon apportera peut-être
 * au même cycle. D'où le SECOND TEMPS décrit ici (`PluginGraphContribution#link`) : le socle collecte
 * d'abord toutes les contributions, PUIS rappelle chaque greffon avec le graphe complet.
 *
 * Pourquoi deux temps plutôt qu'un contexte passé directement à `graph()` : un contexte rempli au
 * fil de l'eau ferait dépendre le résultat de l'ORDRE d'enregistrement (HYCU chargé avant Nutanix ne
 * verrait aucune VM). Ici la phase 2 ne commence qu'une fois la phase 1 TERMINÉE : tous les greffons
 * reçoivent exactement le même contexte, quel que soit leur ordre.
 */

import type { PluginGraphEdge, PluginGraphNode } from "./manifest.js";

/**
 * Le graphe tel qu'il est APRÈS la phase 1 : les nœuds de tous les greffons, figés. Un greffon s'y
 * repère par le VOCABULAIRE public d'un autre (`kind`, déclaré dans son manifeste sous
 * `permissions.graphNodeKinds`) — jamais en important son code.
 */
export interface PluginGraphContext {
  /** Tous les nœuds contribués, dans l'ordre de contribution. */
  readonly nodes: readonly PluginGraphNode[];
  /** Les nœuds d'un type donné — [] si aucun greffon n'en a contribué (celui qui les apporte peut
   * être absent ou en pause : c'est un cas normal, jamais une erreur). */
  nodesOfKind(kind: string): readonly PluginGraphNode[];
  /** Un nœud par son identifiant exact, `undefined` s'il n'existe pas. */
  node(id: string): PluginGraphNode | undefined;
}

/**
 * Donnée POSÉE sur un nœud déjà contribué — par soi ou par un autre greffon. Distinct d'un tiroir
 * (`PluginGraphAttachment`, une ressource rendue sous la carte) : ici on enrichit la carte
 * elle-même, sans créer ni nœud ni arête.
 */
export interface PluginGraphAnnotation {
  /** Nœud visé — l'annotation est ignorée, avec une trace, s'il n'existe pas dans le graphe. */
  nodeId: string;
  /** Champs recopiés TELS QUELS sur le nœud (mêmes règles que PluginGraphNode#fields). */
  fields: Record<string, unknown>;
}

/** Ce que la phase 2 rend : des liens et des annotations, jamais un nouveau nœud (un nœud apparu
 * après la phase 1 ne serait visible d'aucun autre greffon — l'ordre déciderait à nouveau). */
export interface PluginGraphLinks {
  edges: PluginGraphEdge[];
  annotations: PluginGraphAnnotation[];
}
