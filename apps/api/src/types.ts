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
  orchestrator: "swarm" | "kubernetes" | "compose";
  status: "ok" | "warn";
  nodes: ClusterNode[];
  /** Infos hôte du démon Docker (orchestrator "swarm"/"compose" uniquement — absent pour Kubernetes). */
  hostInfo?: DockerHostInfo;
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
