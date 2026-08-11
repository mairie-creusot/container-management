/**
 * Contrats de données partagés web <-> api.
 *
 * Ces interfaces sont recopiées EXACTEMENT depuis le chapitre "Contrats de données"
 * de ARCHITECTURE.md (racine du monorepo). Ne pas les modifier ici sans mettre à jour
 * ARCHITECTURE.md en premier — c'est le contrat partagé entre apps/web et apps/api.
 */

export type RegistryKind = "dockerhub" | "ghcr" | "gitlab" | "harbor";

export interface ImageRef {
  id: string;
  name: string; // ex: "nginx" ou "ghcr.io/ville-lecreusot/portail-citoyen"
  registry: RegistryKind;
  currentTag: string;
  latestTag: string;
  environment: string; // nom de l'environnement où l'image tourne
  status: "update" | "uptodate";
  digest: string;
  sizeBytes: number;
  layers: number;
}

export interface Registry {
  id: string;
  kind: RegistryKind;
  name: string;
  url: string;
  status: "connected" | "unconfigured" | "error";
  trackedImages: number;
  lastSyncAt: string | null; // ISO 8601
  // Raison concrète de "error" (ex: "GHCR : identifiants invalides ou expirés (401)") — absent
  // si status !== "error" ou si le test n'a produit qu'un échec réseau générique déjà couvert
  // par "error". Voir registries/index.ts#testRegistryConnection.
  statusDetail?: string;
}

/** Résultat de l'exploration du catalogue distant d'un registry — voir GET /api/registries/:id/repositories. */
export interface RegistryCatalogResult {
  repositories: string[];
  // Raison concrète pour laquelle `repositories` est vide (ou incomplet) : identifiants
  // invalides, organisation introuvable, aucune organisation déduite, etc. Absent si tout s'est
  // bien passé (y compris quand le catalogue est simplement, réellement, vide).
  diagnostic?: string;
}

export interface ContainerRef {
  id: string;
  name: string;
  image: string;
  environment: string;
  node: string;
  state: "running" | "restarting" | "stopped";
  cpuPercent: number;
  memBytes: number;
}

export interface ContainerPortMapping {
  containerPort: string;
  hostPort: string | null;
  proto: string;
}

export interface ContainerMount {
  source: string;
  destination: string;
  type: string;
  readOnly: boolean;
}

/** Détail complet d'un conteneur (équivalent `docker inspect`) — chargé à la demande, pas dans la liste. */
export interface ContainerDetail extends ContainerRef {
  fullId: string;
  createdAt: string;
  command: string;
  restartPolicy: string;
  networkMode: string;
  ports: ContainerPortMapping[];
  mounts: ContainerMount[];
  env: string[];
  labels: Record<string, string>;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string | null;
  labels: Record<string, string>;
  scope: string;
  /** Nombre de conteneurs (actifs ou non) qui montent ce volume — utile avant suppression. */
  inUseBy: number;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  containerCount: number;
  createdAt: string | null;
  internal: boolean;
}

/** Infos hôte du démon Docker d'un environnement (équivalent `docker info`) — CPU/RAM totaux, version, socket... */
export interface DockerHostInfo {
  serverVersion: string;
  apiVersion: string;
  os: string;
  kernelVersion: string;
  architecture: string;
  cpus: number;
  totalMemBytes: number;
  containersRunning: number;
  containersStopped: number;
  imagesCount: number;
  storageDriver: string;
  dockerRootDir: string;
  /** Chemin/URL utilisé pour joindre le démon (ex: "npipe:////./pipe/docker_engine", "unix:///var/run/docker.sock"). */
  endpoint: string;
  swarmActive: boolean;
  volumesCount: number;
}

export interface ClusterNode {
  id: string;
  environmentId: string;
  role: string; // manager | worker | control-plane | standalone
  cpuPercent: number;
  memPercent: number;
  status: "ok" | "warn" | "crit";
  containerCount: number;
}

export interface Environment {
  id: string;
  name: string;
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix";
  status: "ok" | "warn";
  nodes: ClusterNode[];
  /** Infos hôte du démon Docker (orchestrator "swarm"/"compose" uniquement — absent pour Kubernetes/Nutanix). */
  hostInfo?: DockerHostInfo;
}

/** VM Nutanix (Prism Central API v3) — voir src/services/nutanix.ts. */
export interface NutanixVm {
  id: string;
  name: string;
  powerState: "on" | "off" | "unknown";
  numVcpus: number;
  memoryMib: number;
  /** Nom du cluster Nutanix physique hébergeant la VM. */
  cluster: string;
}

export interface GitOpsFile {
  path: string; // ex: "prod/nginx.yaml"
  desiredManifest: string; // YAML brut
  actualManifest: string; // YAML brut reconstruit depuis le cluster
  drift: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string; // ISO 8601
}

export type Role = "admin" | "operator" | "viewer";

export interface Session {
  username: string;
  displayName: string;
  roles: Role[];
}

/**
 * Interface WASM (@quai/wasm-core) — recopiée depuis ARCHITECTURE.md.
 * Voir src/types/wasm-core.d.ts pour la déclaration ambiante du module,
 * et src/services/gitops.ts pour l'intégration + le repli si le package
 * n'est pas encore buildable.
 */
export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  hasDrift: boolean;
}

// --- Infra-as-code (OpenTofu / Ansible / Packer) — voir apps/api/src/services/iac/ ---
// QUAI pilote les VRAIS binaires (aucune réimplémentation) : un "workspace" est un dossier
// réel sur disque contenant la config native de l'outil (fichiers .tf/.tofu, playbook.yml,
// template.pkr.hcl...), un "run" est une invocation réelle de ce binaire dont la sortie est
// journalisée en direct.

export type IacEngine = "tofu" | "ansible" | "packer";

export interface IacEngineStatus {
  engine: IacEngine;
  available: boolean;
  version: string | null;
}

export interface IacWorkspace {
  id: string;
  name: string;
  engine: IacEngine;
  createdAt: string; // ISO 8601
  createdBy: string; // username
}

export interface IacFileEntry {
  path: string; // relatif à la racine du workspace, ex: "main.tf"
  sizeBytes: number;
}

export type IacRunStatus = "running" | "success" | "failed";

export interface IacRun {
  id: string;
  workspaceId: string;
  engine: IacEngine;
  action: string; // ex: "plan", "apply", "run", "build"
  status: IacRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  startedBy: string; // username
}

/** IacRun + le log complet (stdout+stderr entrelacés) — chargé à la demande, pas dans la liste des runs. */
export interface IacRunDetail extends IacRun {
  log: string;
}

// --- Topologie (graphe visuel type Railway — voir services/topology.ts) ---
// Construit à partir des vraies données Docker (docker.listContainers renvoie déjà Mounts et
// NetworkSettings.Networks dans son résumé, pas besoin d'un inspect() par conteneur).

export type TopologyNodeKind = "container" | "volume" | "network";

export interface TopologyNode {
  id: string; // ex: "container:<id>", "volume:<name>", "network:<id>"
  kind: TopologyNodeKind;
  label: string;
  /** Sous-titre affiché sous le label (ex: image du conteneur, driver du volume). */
  subtitle: string;
  status: "running" | "stopped" | "restarting" | "neutral";
  /** Conteneurs uniquement : utilisation courante (docker.ts#readContainerUsage), pour affichage direct sur le nœud du graphe. */
  cpuPercent?: number;
  memBytes?: number;
  /** Conteneurs uniquement : une image plus récente est disponible (GET /api/images, status "update"). */
  updateAvailable?: boolean;
  /** Conteneurs uniquement : un fichier GitOps rapproché par nom est en dérive (GET /api/gitops/files). */
  drift?: boolean;
}

export interface TopologyEdge {
  id: string;
  source: string; // id de TopologyNode
  target: string; // id de TopologyNode
  kind: "mount" | "network";
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string; // ISO 8601
}

// --- Scan de vulnérabilités (Grype) — voir apps/api/src/services/scan.ts ---
// QUAI pilote le VRAI binaire Grype (https://github.com/anchore/grype, Apache-2.0) en
// sous-processus, comme OpenTofu/Ansible/Packer (services/iac/*) : aucune réimplémentation
// d'un scanner de CVE.

export type VulnSeverity = "Critical" | "High" | "Medium" | "Low" | "Negligible" | "Unknown";

export interface Vulnerability {
  id: string; // ex: "CVE-2023-1255"
  severity: VulnSeverity;
  packageName: string;
  installedVersion: string;
  fixedInVersion: string | null; // null si Grype ne connaît pas de correctif
}

export type ScanStatus = "running" | "success" | "failed";

export interface ScanResult {
  id: string;
  image: string; // référence Docker passée à Grype, ex: "nginx:1.27"
  status: ScanStatus;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  vulnerabilities: Vulnerability[];
  summary: Record<VulnSeverity, number>;
}

// --- Notifications système (watchdog proactif) — voir apps/api/src/services/watchdog.ts ---
// Événements détectés tout seuls en tâche de fond (PAS déclenchés par une action utilisateur,
// contrairement aux notifications d'erreur d'action côté web) : nouvelle version d'image
// disponible, intégration qui devient injoignable ou de nouveau joignable. Émis une seule fois
// par transition (edge-triggered), jamais répétés en boucle tant que l'état ne change pas.

export type SystemNotificationKind =
  | "image_update_available"
  | "integration_unreachable"
  | "integration_reachable";

export interface SystemNotificationEvent {
  id: string;
  timestamp: string; // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  /** Message concret et actionnable, ex: "Nouvelle version disponible pour nginx:1.25 -> 1.27". */
  message: string;
  read: boolean;
}
