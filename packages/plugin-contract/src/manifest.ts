import type { JSONSchema } from "./jsonSchema.js";
import type { ServiceModuleSnapshot } from "./snapshot.js";

/**
 * Version du SOCLE de greffons — c'est elle que la plage `coreApi` d'un manifeste doit satisfaire.
 * À incrémenter selon semver dès que ce contrat change : mineur pour un ajout rétrocompatible,
 * majeur pour toute rupture (un greffon compilé contre l'ancien contrat sera alors refusé au
 * chargement, jamais chargé à moitié).
 */
export const CORE_API_VERSION = "1.0.0";

export interface PluginPermissions {
  /** Hôtes que le greffon est autorisé à joindre ("hycu.exemple.priv", "10.0.0.5:9440"). */
  network?: string[] | undefined;
  /** false/absent = LECTURE SEULE imposée par le socle : aucune action mutante n'est admise. */
  mutates?: boolean | undefined;
  /** Types de nœuds que `graph()` ajoute au graphe — obligatoire dès que `graph()` existe. */
  graphNodeKinds?: string[] | undefined;
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
