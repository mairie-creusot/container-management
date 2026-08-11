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

/**
 * Une entrée (fichier ou dossier) listée dans un volume Docker — voir
 * GET /api/volumes/:name/files et services/docker.ts#listVolumeFiles. Lecture seule pour ce
 * premier lot : aucune route d'édition/suppression/upload ne consomme ce type.
 */
export interface VolumeFileEntry {
  name: string;
  /** Chemin relatif à la racine du volume, POSIX, toujours préfixé par "/" (ex: "/sub/file.txt"). */
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  /** ISO 8601 ; chaîne vide si le mtime n'a pas pu être déterminé. */
  modifiedAt: string;
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
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix" | "docker-remote" | "lxc";
  status: "ok" | "warn";
  nodes: ClusterNode[];
  /** Infos hôte du démon Docker (orchestrator "swarm"/"compose"/"docker-remote" — absent pour Kubernetes/Nutanix/LXC). */
  hostInfo?: DockerHostInfo;
}

// --- Environnements Docker distants (cf. ARCHITECTURE.md, chapitre "Environnements Docker
// distants") — voir apps/api/src/services/remoteDockerStore.ts. ca/cert/key ne transitent
// JAMAIS par ce contrat une fois enregistrés (write-only, comme SecretRef ci-dessus) : la vue
// publique n'expose que `hasTls` (les identifiants existent) et jamais leur contenu.

export interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  hasTls: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Résultat d'un test de connectivité (GET /api/remote-environments/:id/test) — même forme que SetupTestResult côté web. */
export interface RemoteDockerTestResult {
  ok: boolean;
  message: string;
}

// --- Support LXC (via LXD) — cf. ARCHITECTURE.md, chapitre "Support LXC". LXD (démon de
// gestion LXC de Canonical) est piloté via sa vraie API REST (unix socket local ou HTTPS +
// certificat client à distance, https://documentation.ubuntu.com/lxd/en/latest/rest-api/) —
// voir apps/api/src/services/lxc.ts. Jamais de conteneur LXC fabriqué : [] si LXD n'a jamais
// été configuré ou si configuré mais injoignable.

export interface LxcContainer {
  name: string;
  status: string; // ex: "Running", "Stopped" — reflète tel quel le champ "status" de l'API LXD
  architecture: string;
  createdAt: string; // ISO 8601
  type: string; // "container" | "virtual-machine" (LXD gère les deux avec la même API)
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

// --- Gestionnaire de secrets nommés (façon Vault/GitHub Actions secrets) — voir
// apps/api/src/services/secretsStore.ts. La valeur elle-même n'apparaît JAMAIS dans ce
// contrat : elle est chiffrée au repos (crypto.ts) et write-only côté API (jamais renvoyée
// par un GET liste/détail), référencée par `name` lors de la création d'un conteneur.

export interface SecretRef {
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// --- Reverse proxy interne (*.lecreusot.priv) — voir apps/api/src/services/reverseProxy.ts.
// QUAI pilote un VRAI reverse proxy (Caddy, https://caddyserver.com, Apache-2.0) via son API
// d'administration JSON en direct : aucune réimplémentation d'un serveur HTTP/proxy. Une route
// cible soit un conteneur géré par QUAI (IP résolue en direct sur le réseau Docker, jamais
// figée), soit un host:port arbitraire.

export interface ReverseProxyRoute {
  id: string;
  subdomain: string; // ex: "monapp.lecreusot.priv" — matché sur l'en-tête Host par Caddy
  targetContainerId?: string;
  targetHost?: string;
  targetPort: number;
  createdAt: string; // ISO 8601
}

/** GET /api/reverse-proxy/status — Caddy joignable ou non, même pattern que ScannerStatus. */
export interface ReverseProxyStatus {
  reachable: boolean;
  adminUrl: string;
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

export type TopologyNodeKind = "container" | "volume" | "network" | "nutanix-vm";

export interface TopologyNode {
  id: string; // ex: "container:<id>", "volume:<name>", "network:<id>", "nutanix-vm:<uuid>"
  kind: TopologyNodeKind;
  label: string;
  /** Sous-titre affiché sous le label (ex: image du conteneur, driver du volume, cluster physique pour une VM Nutanix). */
  subtitle: string;
  status: "running" | "stopped" | "restarting" | "neutral";
  /** Conteneurs uniquement : utilisation courante (docker.ts#readContainerUsage), pour affichage direct sur le nœud du graphe. */
  cpuPercent?: number;
  memBytes?: number;
  /** Conteneurs uniquement : une image plus récente est disponible (GET /api/images, status "update"). */
  updateAvailable?: boolean;
  /** Conteneurs uniquement : un fichier GitOps rapproché par nom est en dérive (GET /api/gitops/files). */
  drift?: boolean;
  /**
   * Conteneurs uniquement : nombre de vulnérabilités Critical/High rapprochées du DERNIER scan
   * connu (tous scanners confondus, GET /api/images/:id/scans) pour l'image de ce conteneur —
   * même principe best-effort par nom que updateAvailable/drift ci-dessus, rien d'inventé si
   * aucun scan n'a jamais tourné pour cette image (absent, pas 0). Règle si Grype ET
   * OSV-Scanner ont chacun un dernier scan réussi pour la même image : le plus sévère des deux
   * l'emporte (max des deux comptes), voir services/topology.ts#vulnSummaryForImage.
   */
  vulnCritical?: number;
  vulnHigh?: number;
  /**
   * Conteneurs uniquement : état de santé Docker NATIF (`State.Health.Status` via `docker.ts#
   * readContainerHealth`) — "none" si l'image ne définit aucun `HEALTHCHECK` (résultat honnête et
   * attendu pour la plupart des conteneurs, PAS un échec fabriqué). Jamais présent pour les nœuds
   * non-conteneur (volume/network/nutanix-vm). Une arête ne duplique pas ce champ : le frontend le
   * lit directement sur le(s) nœud(s) conteneur à ses deux bouts (voir TopologyGraph.tsx).
   */
  healthStatus?: "healthy" | "unhealthy" | "starting" | "none";
  /** VMs Nutanix uniquement (voir services/nutanix.ts#NutanixVm) : nombre de vCPUs et mémoire allouée. */
  numVcpus?: number;
  memoryMib?: number;
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

// --- Scan de vulnérabilités (Grype + OSV-Scanner) — voir apps/api/src/services/scan.ts ---
// QUAI pilote les VRAIS binaires Grype (https://github.com/anchore/grype, Apache-2.0) ET
// OSV-Scanner (https://github.com/google/osv-scanner, Apache-2.0) en sous-processus, comme
// OpenTofu/Ansible/Packer (services/iac/*) : aucune réimplémentation d'un scanner de CVE. Les
// deux scanners coexistent (l'un n'exclut pas l'autre) : un seul historique de scans par image,
// chaque entrée sait de quel scanner elle vient (champ `scanner` ci-dessous).

export type ScannerId = "grype" | "osv-scanner";

/** Présence + version du binaire d'un scanner sur l'hôte — même pattern que IacEngineStatus. */
export interface ScannerStatus {
  scanner: ScannerId;
  available: boolean;
  version: string | null;
}

export type VulnSeverity = "Critical" | "High" | "Medium" | "Low" | "Negligible" | "Unknown";

export interface Vulnerability {
  id: string; // ex: "CVE-2023-1255", ou "GHSA-..."/"DEBIAN-CVE-..." pour OSV-Scanner
  severity: VulnSeverity;
  packageName: string;
  installedVersion: string;
  fixedInVersion: string | null; // null si le scanner ne connaît pas de correctif
}

export type ScanStatus = "running" | "success" | "failed";

export interface ScanResult {
  id: string;
  scanner: ScannerId; // scanner à l'origine de ce résultat
  image: string; // référence Docker passée au scanner, ex: "nginx:1.27"
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
  | "integration_reachable"
  | "gitops_drift_detected";

export interface SystemNotificationEvent {
  id: string;
  timestamp: string; // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  /** Message concret et actionnable, ex: "Nouvelle version disponible pour nginx:1.25 -> 1.27". */
  message: string;
  read: boolean;
}
