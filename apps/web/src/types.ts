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
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix" | "docker-remote" | "lxc";
  status: "ok" | "warn";
  nodes: ClusterNode[];
  hostInfo?: DockerHostInfo;
}

// --- Environnements Docker distants — voir apps/api/src/services/remoteDockerStore.ts.
// ca/cert/key ne transitent jamais par ce contrat (write-only), seul `hasTls` indique leur présence.

export interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  hasTls: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteDockerTestResult {
  ok: boolean;
  message: string;
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

export type TopologyNodeKind = "container" | "volume" | "network" | "nutanix-vm";

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
  /**
   * Conteneurs uniquement : nombre de vulnérabilités Critical/High rapprochées du DERNIER scan
   * connu (tous scanners confondus) pour l'image de ce conteneur — même principe best-effort par
   * nom que updateAvailable/drift, rien d'inventé si aucun scan n'a jamais tourné (absent, pas 0).
   */
  vulnCritical?: number;
  vulnHigh?: number;
  /**
   * Conteneurs uniquement : état de santé Docker NATIF (`State.Health.Status`, voir
   * apps/api/src/services/docker.ts#readContainerHealth) — "none" si l'image ne définit aucun
   * `HEALTHCHECK` (résultat honnête et attendu pour la plupart des conteneurs, pas un échec).
   * Une arête ne duplique pas ce champ : on le lit directement sur le(s) nœud(s) conteneur à ses
   * deux bouts (voir TopologyGraph.tsx).
   */
  healthStatus?: "healthy" | "unhealthy" | "starting" | "none";
  /** VMs Nutanix uniquement (voir apps/api/src/services/nutanix.ts#NutanixVm). */
  numVcpus?: number;
  memoryMib?: number;
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

/** Une entrée (fichier ou dossier) listée dans un volume Docker — lecture seule. */
export interface VolumeFileEntry {
  name: string;
  /** Chemin relatif à la racine du volume, POSIX, toujours préfixé par "/" (ex: "/sub/file.txt"). */
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  /** ISO 8601 ; chaîne vide si le mtime n'a pas pu être déterminé. */
  modifiedAt: string;
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
// contrat : elle est chiffrée au repos et write-only côté API (jamais renvoyée par un GET
// liste/détail), référencée par `name` lors de la création d'un conteneur.

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

// --- Scan de vulnérabilités (Grype + OSV-Scanner) — voir apps/api/src/services/scan.ts ---
// QUAI pilote les VRAIS binaires Grype (https://github.com/anchore/grype, Apache-2.0) ET
// OSV-Scanner (https://github.com/google/osv-scanner, Apache-2.0) en sous-processus : aucune
// réimplémentation d'un scanner CVE. Les deux scanners coexistent : un seul historique de scans
// par image, chaque entrée sait de quel scanner elle vient (champ `scanner` ci-dessous).

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

// --- Notifications système (watchdog proactif) — voir ARCHITECTURE.md
// § "Détection proactive (watchdog)" et apps/api/src/services/watchdog.ts ---

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
