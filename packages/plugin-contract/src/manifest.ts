import type { PluginGraphContext, PluginGraphLinks } from "./graph.js";
import type { JSONSchema } from "./jsonSchema.js";
import type { ServiceModuleSnapshot } from "./snapshot.js";

/**
 * Version du SOCLE de greffons — c'est elle que la plage `coreApi` d'un manifeste doit satisfaire.
 * À incrémenter selon semver dès que ce contrat change : mineur pour un ajout rétrocompatible,
 * majeur pour toute rupture (un greffon compilé contre l'ancien contrat sera alors refusé au
 * chargement, jamais chargé à moitié).
 *
 * 1.1.0 : ajouts FACULTATIFS, un manifeste écrit pour 1.0 reste accepté tel quel — ajout mineur,
 * jamais une rupture.
 *  - `PluginManifest#actions` : description de l'entrée, du danger, de la confirmation et du
 *    rattachement au graphe d'une action ;
 *  - contribution au graphe : `PluginGraphNode#fields`/`#rootAttachment` et
 *    `PluginGraphContribution#link` (voir graph.ts) — de quoi porter une donnée que le contrat ne
 *    sait pas décrire, se rattacher à la racine du graphe, et relier les nœuds d'un AUTRE greffon.
 */
export const CORE_API_VERSION = "1.1.0";

export interface PluginPermissions {
  /** Hôtes que le greffon est autorisé à joindre ("hycu.exemple.priv", "10.0.0.5:9440"). */
  network?: string[] | undefined;
  /** false/absent = LECTURE SEULE imposée par le socle : aucune action mutante n'est admise. */
  mutates?: boolean | undefined;
  /** Types de nœuds que `graph()` ajoute au graphe — obligatoire dès que `graph()` existe. */
  graphNodeKinds?: string[] | undefined;
}

/** Niveau de danger d'une action — MÊME vocabulaire que NodeActionSeverity côté web
 * (apps/web/src/components/topologyNodeRegistry.tsx) : "destructive" est le seul rendu en rouge. */
export type PluginActionSeverity = "safe" | "caution" | "destructive";

/** Valeurs comparables dans une condition d'affichage. */
export type PluginActionStateValue = string | number | boolean | null;

/**
 * Condition d'affichage SÉRIALISABLE d'une action, évaluée sur l'état réel du nœud visé — miroir
 * exact de NodeStateCondition (topologyNodeRegistry.tsx), jamais une seconde grammaire : un greffon
 * ne peut pas livrer de closure, sa déclaration traverse le réseau en JSON.
 */
export interface PluginActionCondition {
  /** Champ réel du nœud consulté ("status", "hostKind"…). */
  field: string;
  equals?: PluginActionStateValue[] | undefined;
  notEquals?: PluginActionStateValue[] | undefined;
  present?: boolean | undefined;
}

/** Confirmation exigée AVANT d'exécuter. `retype` = confirmation FORTE (retaper le nom de la
 * cible), telle que la pratique déjà la suppression d'une VM Nutanix. */
export interface PluginActionConfirmation {
  title: string;
  /** Question posée. `{cible}` y est remplacé par le libellé du nœud visé. */
  message: string;
  confirmLabel: string;
  /** true = le libellé EXACT de la cible doit être retapé — exige `target`. */
  retype?: boolean | undefined;
}

/**
 * Rattachement d'une action à un nœud du graphe : sur quel type de nœud elle agit, par quel champ
 * elle reçoit sa cible, et si l'écran la propose.
 *
 * `menuLabel` et `servedByCore` s'excluent et l'un des deux est OBLIGATOIRE : une action rattachée
 * à un nœud dit soit son entrée de menu, soit ce qui la sert déjà à l'écran. Sans cette règle, une
 * action rattachée disparaîtrait de l'interface sans que personne puisse dire si c'est voulu.
 */
export interface PluginActionTarget {
  /** Type de nœud concerné — doit figurer dans permissions.graphNodeKinds. */
  nodeKind: string;
  /** Propriété de l'entrée alimentée par l'identifiant du nœud — JAMAIS saisie par l'utilisateur,
   * elle ne peut donc pas figurer dans `input.properties`. */
  field: string;
  /** Libellé de l'entrée de menu contextuel proposée pour cette action. */
  menuLabel?: string | undefined;
  /** Toutes les conditions doivent être vraies (ET) — absent = toujours proposée. */
  when?: PluginActionCondition[] | undefined;
  /**
   * Ce qui rend DÉJÀ cette action à l'écran : identifiant de l'entrée du cœur (voir
   * NodeMenuActionId, topologyNodeContract.tsx) ou description de l'écran qui la sert. Renseigné =
   * l'interface ne propose RIEN de plus, la déclaration ne sert qu'au socle (validation, exécution
   * par la route générique) et l'écran ne change pas d'un pixel.
   */
  servedByCore?: string | undefined;
}

/**
 * DESCRIPTION d'une action, à côté de son implémentation (`Plugin#actions`). Sans elle, une action
 * prend `unknown` : ni formulaire déductible, ni validation par le socle, ni niveau de danger.
 * Chaque clé de `PluginManifest#actions` doit être implémentée par le greffon.
 */
export interface PluginActionSpec {
  /** Entrée de l'action, décrite avec le MÊME sous-ensemble que `configSchema` (showIf/enumLabels
   * compris). Absente = l'action ne prend rien d'autre que sa cible. */
  input?: JSONSchema | undefined;
  /** Défaut "safe". */
  severity?: PluginActionSeverity | undefined;
  confirm?: PluginActionConfirmation | undefined;
  target?: PluginActionTarget | undefined;
}

export interface PluginManifest {
  /** Clé stable partagée partout (route, journal, configuration) : "hycu", "3cx", "glpi". */
  id: string;
  name: string;
  /** Semver du greffon lui-même. */
  version: string;
  /** Plage de compatibilité avec le socle, ex. "^1.0". */
  coreApi: string;
  /** Le formulaire de configuration en découle intégralement. */
  configSchema: JSONSchema;
  /** Chemins (pointés si imbriqués) des champs chiffrés au repos, jamais renvoyés par l'API. */
  secretFields: string[];
  permissions: PluginPermissions;
  /** Libellés du journal de traçabilité, une entrée par action exposée. */
  auditLabels: Record<string, string>;
  /** Description des actions (entrée, danger, confirmation, rattachement au graphe) — facultative :
   * une action non décrite reste exécutable, entrée transmise telle quelle et sans écran déduit. */
  actions?: Record<string, PluginActionSpec> | undefined;
}

/** Manifeste tel qu'exposé par l'API : même forme, expurgé de toute valeur (voir publicManifest). */
export type PublicPluginManifest = PluginManifest;

export interface PluginTestResult {
  ok: boolean;
  /** Message RÉEL (succès comme échec) — jamais un secret, même partiel. */
  message: string;
}

/** Nœud contribué au graphe — `status` reprend la palette des nœuds de topologie existants. */
export interface PluginGraphNode {
  id: string;
  /** Doit figurer dans permissions.graphNodeKinds. */
  kind: string;
  label: string;
  subtitle: string;
  status: "running" | "stopped" | "restarting" | "neutral";
  details?: Record<string, string | number> | undefined;
  /**
   * Rattachement à la RACINE du graphe : "environment" pour un environnement à part entière (il est
   * compté comme tel), "integration" pour ce qui s'y rattache sans rien héberger (une appliance de
   * sauvegarde protège, elle n'héberge pas). Absent = aucun rattachement. Sans cette déclaration, le
   * socle devrait savoir qu'un "nutanix-cluster" est un environnement — c'est-à-dire connaître les
   * greffons par leur nom.
   */
  rootAttachment?: "environment" | "integration" | undefined;
  /**
   * Charge utile RECOPIÉE TELLE QUELLE sur le nœud du graphe, sans que le socle l'interprète. Deux
   * usages, tous deux réels :
   *  - porter ce que `details` (chaînes et nombres) ne sait pas transporter — disques d'une VM,
   *    cartes réseau avec VLAN et IP réelle, tiroirs (`attachments`), booléen de placement confirmé ;
   *  - corriger `kind` quand le vocabulaire du greffon est plus fin que celui du graphe : un
   *    "nutanix-cluster" s'y déclare comme un nœud "host" portant un `hostKind`.
   * L'identité du nœud (id, label, subtitle, status) reste celle des champs ci-dessus : `fields` ne
   * peut pas la détourner. Le greffon répond de la justesse de ce qu'il y met, comme de ses données.
   */
  fields?: Record<string, unknown> | undefined;
}

export interface PluginGraphEdge {
  id: string;
  /** PluginGraphNode#id, ou id d'un nœud existant du graphe. */
  source: string;
  target: string;
  kind: string;
  label?: string | undefined;
}

/** Ressource rendue en "tiroir" sous la carte d'un nœud, jamais comme un nœud à part entière. */
export interface PluginGraphAttachment {
  /** Nœud porteur — contribué par ce greffon ou déjà présent dans le graphe. */
  nodeId: string;
  kind: string;
  id: string;
  label: string;
  subtitle: string;
}

export interface PluginGraphContribution {
  nodes: PluginGraphNode[];
  edges: PluginGraphEdge[];
  attachments: PluginGraphAttachment[];
  /**
   * SECOND TEMPS, facultatif : appelé une fois que TOUS les greffons ont contribué leurs nœuds, avec
   * le graphe complet (voir graph.ts). C'est là, et seulement là, qu'un greffon peut relier ou
   * annoter les nœuds d'un AUTRE — la règle de rapprochement reste chez lui, le socle ne fait
   * aucune jointure à sa place. La fermeture garde l'instantané déjà récupéré en phase 1 :
   * l'intégration n'est jamais interrogée une seconde fois dans le même cycle.
   */
  link?: ((context: PluginGraphContext) => PluginGraphLinks | Promise<PluginGraphLinks>) | undefined;
}

export type PluginAction = (input: unknown) => Promise<unknown>;

/**
 * Voie d'écriture PROPRE au greffon, quand le stockage générique ne suffit pas. Un greffon issu
 * d'une intégration historique doit purger son ancien champ typé à chaque écriture : sans cela, une
 * configuration retirée par l'admin ressusciterait au prochain démarrage. Le socle passe TOUJOURS
 * par là quand elle existe, et retombe sinon sur le stockage générique des intégrations.
 */
export interface PluginConfigStore {
  /** Configuration effective (secrets EN CLAIR), ou `null` si le greffon n'est pas configuré.
   * Réservée au socle : ne jamais la renvoyer par une route, seule la vue sûre sort. */
  load(): Promise<Record<string, unknown> | null>;
  /** Remplace la configuration. Refuse (exception) une configuration inutilisable. */
  save(config: Record<string, unknown>): Promise<void>;
  /** Retour à « jamais configuré », reliquats compris. Idempotent. */
  remove(): Promise<void>;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Vérifie la configuration fournie et rapporte le résultat RÉEL, sans rien inventer. */
  test(config: unknown): Promise<PluginTestResult>;
  snapshot(config: unknown): Promise<ServiceModuleSnapshot>;
  graph?(config: unknown): Promise<PluginGraphContribution>;
  /** Chaque clé exige `permissions.mutates` et une entrée dans `auditLabels`. */
  actions?: Record<string, PluginAction> | undefined;
  /** Absent = le socle lit et écrit dans le stockage générique, sous `manifest.id`. */
  configStore?: PluginConfigStore | undefined;
}
