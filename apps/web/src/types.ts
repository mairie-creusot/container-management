// Réplique exacte des contrats de données partagés web ↔ api.
// Voir ARCHITECTURE.md § "Contrats de données (partagés web ↔ api)".
// Ne pas diverger de ces formes sans mettre à jour le contrat à la racine.

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
  statusDetail?: string;
}

/** Résultat de l'exploration du catalogue distant d'un registry — voir GET /api/registries/:id/repositories. */
export interface RegistryCatalogResult {
  repositories: string[];
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

export interface ClusterNode {
  id: string;
  environmentId: string;
  role: string; // manager | worker | control-plane | standalone
  cpuPercent: number;
  memPercent: number;
  status: "ok" | "warn" | "crit";
  containerCount: number;
}

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
  endpoint: string;
  swarmActive: boolean;
  volumesCount: number;
}

export interface Environment {
  id: string;
  name: string;
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix";
  status: "ok" | "warn";
  nodes: ClusterNode[];
  hostInfo?: DockerHostInfo;
}

/** VM Nutanix (Prism Central API v3) — voir apps/api/src/services/nutanix.ts. */
export interface NutanixVm {
  id: string;
  name: string;
  powerState: "on" | "off" | "unknown";
  numVcpus: number;
  memoryMib: number;
  cluster: string;
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
  inUseBy: number;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  actorDisplayName: string;
  method: string;
  path: string;
  statusCode: number;
  ok: boolean;
}

export type TopologyNodeKind = "container" | "volume" | "network";

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  subtitle: string;
  status: "running" | "stopped" | "restarting" | "neutral";
  /** Conteneurs uniquement : utilisation courante, pour affichage direct sur le nœud du graphe. */
  cpuPercent?: number;
  memBytes?: number;
  /** Conteneurs uniquement : une image plus récente est disponible (GET /api/images, status "update"). */
  updateAvailable?: boolean;
  /** Conteneurs uniquement : un fichier GitOps rapproché par nom est en dérive (GET /api/gitops/files). */
  drift?: boolean;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  kind: "mount" | "network";
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string;
}

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
  createdAt: string;
  createdBy: string;
}

export interface IacFileEntry {
  path: string;
  sizeBytes: number;
}

export type IacRunStatus = "running" | "success" | "failed";

export interface IacRun {
  id: string;
  workspaceId: string;
  engine: IacEngine;
  action: string;
  status: IacRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  startedBy: string;
}

export interface IacRunDetail extends IacRun {
  log: string;
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

// --- Interface WASM (@quai/wasm-core), consommée via l'API GitOps ---

export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  hasDrift: boolean;
}

// --- Assistant de configuration au premier lancement (ARCHITECTURE.md
// § "Assistant de configuration au premier lancement") ---
//
// Les payloads exacts des routes /api/setup/* ne sont pas détaillés champ
// par champ dans ARCHITECTURE.md au-delà de leur intention ; les formes
// ci-dessous sont une extrapolation raisonnable — cohérente avec les
// variables d'environnement LDAP_* déjà nommées dans le contrat d'auth et
// avec le principe « chaque route test/* reçoit la config candidate, ne
// modifie jamais l'état persisté ».

export interface SetupStatus {
  completed: boolean;
}

/** Résultat générique d'un test d'intégration (LDAP/Docker/Kubernetes/registry). */
export interface SetupTestResult {
  ok: boolean;
  message: string;
}

export interface LdapConfigInput {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  groupRoleMap: Record<string, Role>;
}

export interface LdapTestResult extends SetupTestResult {
  // Noms alignés sur apps/api/src/services/ldap.ts#testLdapConnection.
  groupsResolved?: number;
  userDn?: string;
}

export interface KubernetesConfigInput {
  kubeconfigYaml: string;
}

export interface KubernetesTestResult extends SetupTestResult {
  context?: string;
  nodeCount?: number;
}

export interface DockerTestResult extends SetupTestResult {
  version?: string;
}

export interface NutanixConfigInput {
  prismCentralUrl: string;
  username: string;
  password: string;
}

export interface NutanixTestResult extends SetupTestResult {
  vmCount?: number;
}

export interface RegistryConfigInput {
  kind: RegistryKind;
  name: string;
  url: string;
  username?: string;
  password?: string;
  token?: string;
}

export interface RegistryTestResult extends SetupTestResult {
  trackedImages?: number;
}

// --- Scan de vulnérabilités (Grype) — voir apps/api/src/services/scan.ts ---
// QUAI pilote le VRAI binaire Grype (https://github.com/anchore/grype, Apache-2.0) en
// sous-processus, comme OpenTofu/Ansible/Packer : aucune réimplémentation d'un scanner CVE.

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

// --- Notifications système (watchdog proactif) — voir ARCHITECTURE.md
// § "Détection proactive (watchdog)" et apps/api/src/services/watchdog.ts ---

export type SystemNotificationKind =
  | "image_update_available"
  | "integration_unreachable"
  | "integration_reachable";

export interface SystemNotificationEvent {
  id: string;
  timestamp: string; // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  message: string;
  read: boolean;
}

export interface SetupCompletePayload {
  // API : POST /api/setup/complete attend { ldap: SetupLdapConfig, ... } où
  // SetupLdapConfig inclut defaultRole (rôle appliqué quand aucun groupe LDAP
  // de l'utilisateur ne correspond au mapping) — non exposé pour l'instant
  // comme champ éditable de l'assistant, donc fixé à "viewer" (moindre
  // privilège) au moment de la complétion. Voir setupSlice.ts#completeSetup.
  ldap: LdapConfigInput & { defaultRole: Role };
  docker: { host?: string } | null;
  kubernetes: KubernetesConfigInput | null;
  nutanix: NutanixConfigInput | null;
  registries: RegistryConfigInput[];
}
