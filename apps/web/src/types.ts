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
  /** uuid réel du cluster physique (cluster_reference) — absent seulement si Prism Central ne l'a
   * pas renvoyé. Sert à relier une VM à son nœud "host" de cluster dans le graphe de topologie. */
  clusterUuid?: string;
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
  // Limites CPU/mémoire réellement configurées (HostConfig.Memory/NanoCpus, `docker inspect`) —
  // absentes si aucune limite n'a été fixée à la création, jamais une valeur fabriquée.
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

/** Snapshot instantané des logs d'un conteneur (équivalent `docker logs --tail <n>`) — voir
 * GET /api/containers/:id/logs. Le flux temps réel (WebSocket, .../logs/stream) envoie du texte
 * brut chunk par chunk, sans passer par ce contrat JSON. */
export interface ContainerLogsSnapshot {
  logs: string;
}

/**
 * Processus RÉELLEMENT en cours d'exécution dans un conteneur (équivalent `docker top <id>`) —
 * voir GET /api/containers/:id/processes. `titles` reflète les colonnes RÉELLES retournées par
 * le démon (dépend de la commande `ps` disponible dans l'image cible). Ce n'est PAS une
 * reconstruction de l'architecture applicative interne (QUAI n'a aucun moyen de la connaître).
 */
export interface ContainerProcessList {
  titles: string[];
  processes: string[][];
}

/** Une couche de l'image d'un conteneur (équivalent `docker history <image>`) — voir
 * GET /api/images/:id/history. `id` vaut souvent "<missing>" pour une couche intermédiaire. */
export interface ImageHistoryLayer {
  id: string;
  createdAt: string;
  createdBy: string;
  sizeBytes: number;
  comment: string;
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

// "cron-job"/"backup" : un nœud par définition réelle (cronJobsStore.ts/backupsStore.ts, voir
// apps/api/src/types.ts pour la doc complète) — `status` dérivé de la dernière exécution réelle
// connue (neutral = jamais exécuté, restarting = en cours, running = dernier succès, stopped =
// dernier échec), jamais inventé.
export type TopologyNodeKind =
  | "container"
  | "volume"
  | "network"
  | "nutanix-vm"
  | "ad-server"
  | "host"
  | "cron-job"
  | "backup"
  | "iac-workspace"
  | "gitops-source"
  | "automation-trigger"
  | "automation-condition"
  | "automation-action";

/** Sous-type d'un nœud "host" — voir TopologyNode#hostKind ci-dessous et
 * apps/api/src/services/topology.ts. Champ explicite plutôt qu'une convention dans `subtitle`. */
export type TopologyHostKind = "nutanix-cluster" | "remote-docker" | "lxc";

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
  /**
   * Volumes/networks uniquement : horodatage de création réel Docker — absent pour les
   * conteneurs/VMs Nutanix (leur id est déjà un identifiant immuable). Utilisé par
   * TopologyGraph.tsx comme garde-fou contre un id de nœud recyclé (volume supprimé puis recréé
   * sous le même nom) : voir apps/api/src/types.ts#TopologyNode pour le détail.
   */
  createdAt?: string;
  /**
   * Conteneurs uniquement : volumes/networks montés sur CE conteneur et rattachés à AUCUN AUTRE
   * (voir apps/api/src/services/topology.ts § "Briques") — rendus par GraphNode
   * (topologyGraphShared.tsx) comme des "briques" cliquables directement sous la carte du
   * conteneur, façon Railway, plutôt que comme des nœuds/arêtes séparés du graphe. Une ressource
   * partagée par ≥2 conteneurs, ou un network Docker par défaut (bridge/host/none), reste un vrai
   * TopologyNode top-level et n'apparaît donc jamais ici.
   */
  attachments?: TopologyNodeAttachment[];
  /**
   * Conteneurs uniquement : sous-domaines de reverse proxy RÉELLEMENT associés à ce conteneur
   * (rapprochés par targetContainerId côté apps/api/src/services/topology.ts) — URL complète
   * (`https://<subdomain>`), affichée directement sur la carte du nœud, cliquable. Absent si
   * aucune route ne cible ce conteneur — jamais un domaine inventé.
   */
  domains?: string[];
  /**
   * Nœuds "host" uniquement : sous-type explicite (cluster Nutanix physique, environnement Docker
   * distant, hôte LXD) — voir apps/api/src/services/topology.ts et topologyGraphShared.tsx#KIND_ICON.
   */
  hostKind?: TopologyHostKind;
  /**
   * Nœuds "host" de sous-type "remote-docker" uniquement, et seulement si ce démon distant est
   * réellement joignable — mêmes infos hôte réelles que Environment#hostInfo. Absent si l'hôte est
   * configuré mais injoignable (`status: "stopped"` porte alors seule l'information).
   */
  hostInfo?: DockerHostInfo;
  /**
   * Nœuds "iac-workspace" uniquement : moteur réel du workspace (voir apps/api/src/services/iac/
   * workspaces.ts) — détermine les actions proposées (mêmes que ENGINE_ACTIONS, services/iac/
   * runner.ts côté API) et son icône.
   */
  iacEngine?: IacEngine;
  /**
   * Nœuds "iac-workspace" uniquement : statut PRÉCIS du dernier run réel, `null` si jamais exécuté
   * — `status` ci-dessus n'en est qu'une projection sur les 4 valeurs génériques du graphe (voir
   * apps/api/src/types.ts#TopologyNode pour le détail complet de la correspondance).
   */
  iacLastRunStatus?: IacRunStatus | null;
  /**
   * Volumes/networks uniquement : `true` si rattaché à AUCUN conteneur — reste un vrai nœud mais
   * sans aucune arête (voir apps/api/src/types.ts#TopologyNode pour le détail complet). Rendu
   * atténué par TopologyGraph.tsx/topologyGraphShared.tsx plutôt qu'un statut fabriqué.
   */
  orphan?: boolean;
  /**
   * Nœuds "automation-trigger" uniquement (voir apps/api/src/services/automationStore.ts,
   * apps/api/src/services/automationEngine.ts) : ce que ce déclencheur surveille réellement — un
   * autre TopologyNode déjà existant sur le graphe, ou une route de reverse proxy. Jamais une
   * nouvelle métrique inventée.
   */
  automationTriggerConfig?: AutomationTriggerConfig;
  /**
   * Nœuds "automation-condition" uniquement : condition minimale v1 — laisse passer la chaîne si
   * la valeur amont est "en échec", ou l'inverse (bloque) si `true`.
   */
  automationConditionInvert?: boolean;
  /**
   * Nœuds "automation-action" uniquement : action RÉELLEMENT exécutée par le moteur sur
   * transition du déclencheur amont vers l'échec — appelle toujours une fonction de service déjà
   * existante ailleurs dans QUAI.
   */
  automationActionConfig?: AutomationActionConfig;
  /**
   * Nœuds "automation-trigger" uniquement : horodatage ISO de la dernière fois où ce déclencheur a
   * RÉELLEMENT exécuté sa chaîne d'actions (voir apps/api/src/types.ts pour le détail complet),
   * `null` tant qu'aucune action n'a encore été déclenchée depuis le démarrage du process — jamais
   * le simple fait d'avoir été évalué (le moteur évalue chaque trigger toutes les ~30s).
   */
  automationLastFired?: string | null;
  /**
   * Nœuds "automation-trigger" uniquement : dernier état RÉEL observé par le moteur au dernier
   * cycle ("failing" = source en échec, "ok" = source saine, "unknown" = jamais encore évalué).
   */
  automationLastStatus?: "ok" | "failing" | "unknown";
  /** Conteneurs uniquement : limites RÉELLEMENT configurées — voir apps/api/src/types.ts pour le
   * détail complet. Absentes si aucune limite n'a été fixée à la création. */
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

// --- Moteur d'automatisation (trigger -> condition -> action) — voir
// apps/api/src/services/automationStore.ts et apps/api/src/services/automationEngine.ts pour la
// doc complète (mirroir exact de apps/api/src/types.ts).

/** Ce qu'un nœud "automation-trigger" surveille réellement — voir apps/api/src/types.ts pour le
 * détail complet. */
export type AutomationTriggerSource =
  | { kind: "topology-node"; nodeId: string }
  | { kind: "reverse-proxy-route"; routeId: string };

export interface AutomationTriggerConfig {
  source: AutomationTriggerSource;
}

/** Action RÉELLEMENT exécutée — chacune appelle une fonction de service DÉJÀ existante côté API,
 * jamais une nouvelle implémentation d'effet de bord. */
export type AutomationActionConfig =
  | { kind: "run-cron-job"; cronJobId: string }
  | { kind: "send-notification"; channelId: string; message: string }
  | { kind: "container-action"; containerId: string; action: "start" | "stop" | "restart" };

export interface AutomationRunLogEntry {
  id: string;
  at: string; // ISO
  triggerNodeId: string;
  path: string[]; // ids des nœuds traversés dans l'ordre (trigger -> [condition] -> action(s))
  ok: boolean;
  message?: string; // détail réel de l'échec le cas échéant, jamais fabriqué
}

/** Voir TopologyNode#attachments ci-dessus — même forme que apps/api/src/types.ts#TopologyNodeAttachment. */
export interface TopologyNodeAttachment {
  kind: "volume" | "network";
  /** Id qu'aurait porté le TopologyNode top-level équivalent ("volume:<nom>" / "network:<id>") —
   * utilisé tel quel pour ouvrir son panneau de détail (mêmes routes/reducers qu'un vrai nœud). */
  id: string;
  label: string;
  subtitle: string;
  destination?: string;
  readOnly?: boolean;
}

/** Port réellement publié par un conteneur — voir TopologyEdge#ports ci-dessous. */
export interface TopologyEdgePort {
  protocol: "tcp" | "udp";
  privatePort: number;
  publicPort?: number;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  /** "hosts" : relation réelle cluster Nutanix -> VM qu'il héberge (rapprochée par uuid de cluster,
   * jamais construite si non déterminable) — voir apps/api/src/types.ts pour le détail complet. */
  /** "automation-flow" : arête RÉELLE entre deux nœuds d'automatisation (trigger -> condition,
   * trigger -> action, condition -> action) — voir apps/api/src/types.ts pour le détail complet. */
  kind: "mount" | "network" | "hosts" | "automation-flow";
  /** "network" uniquement : ports réellement publiés par le conteneur à l'une des deux extrémités
   * (voir doc complète côté apps/api/src/types.ts). */
  ports?: TopologyEdgePort[];
  /** "network" uniquement : Internal réel du network Docker ("Private" façon Railway si true). */
  private?: boolean;
  /** "network" uniquement, overlay seulement : chiffrement natif Docker au niveau network. */
  encrypted?: boolean;
  /** "mount" uniquement : lecture seule réelle du montage. */
  readOnly?: boolean;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string;
  /** Regroupements réels créés par un utilisateur (voir TopologyGroup ci-dessous) — [] tant
   * qu'aucun groupement n'a jamais été créé. */
  groups: TopologyGroup[];
}

/**
 * Regroupement visuel de nœuds RÉELS du graphe de topologie ("encapsulation façon Railway/
 * Logisim") — une carte parente repliable/dépliable créée UNIQUEMENT par une action explicite de
 * l'utilisateur (sélection multiple + "Regrouper" sur le canevas), jamais deviné/inféré
 * automatiquement. Persisté et PARTAGÉ entre tous les utilisateurs connectés (voir
 * apps/api/src/services/topologyGroupsStore.ts) — les ports d'entrée/sortie du groupe sont
 * dérivés CÔTÉ CLIENT des arêtes réelles qui traversent sa frontière (voir
 * topologyGraphShared.tsx#deriveGroupPorts), jamais persistés ici.
 */
export interface TopologyGroup {
  id: string; // "group:<uuid>"
  label: string;
  /** Ids de TopologyNode RÉELS regroupés — toujours >= 2. */
  nodeIds: string[];
  /** Replié (une seule carte compacte) ou déplié (cadre contenant visuellement ses membres). */
  collapsed: boolean;
  createdAt: string; // ISO 8601
  createdBy: string; // username LDAP à l'origine du regroupement
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
// liste/détail — seule POST /api/secrets/:id/reveal, admin uniquement, la déchiffre à la
// demande), référencée par `name` lors de la création d'un conteneur.

/** Un conteneur qui référence RÉELLEMENT ce secret via `secretEnv` à sa création. */
export interface SecretUsage {
  containerId: string;
  containerName: string;
  key: string; // clé d'env sous laquelle ce secret est injecté dans CE conteneur
}

/** Métadonnées (JAMAIS la valeur) d'une version passée ou courante d'un secret. */
export interface SecretVersionMeta {
  version: number;
  updatedAt: string; // ISO 8601
}

export interface SecretRef {
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  usedBy: SecretUsage[];
  version: number;
  versionCount: number;
  expiresAt?: string; // ISO 8601
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
  /** Résultat du dernier essai de synchronisation DNS AD pour cette route (voir services/adDns.ts
   * côté API) — absent si l'intégration AD DNS n'a jamais été configurée. */
  dnsSync?: AdDnsSyncResult;
}

/** GET /api/reverse-proxy/status — Caddy joignable ou non, même pattern que ScannerStatus. */
export interface ReverseProxyStatus {
  reachable: boolean;
  adminUrl: string;
  httpsEnabled: boolean;
}

// --- Config Nutanix, éditable en dehors de l'assistant de premier lancement — voir
// apps/api/src/types.ts pour la doc complète (routes/nutanix.ts).

/** Jamais le mot de passe (write-only). */
export interface NutanixConfig {
  prismCentralUrl: string;
  username: string;
}

export interface NutanixStatus {
  configured: boolean;
  config?: NutanixConfig;
}

// --- DNS Active Directory (mise à jour dynamique sécurisée, RFC 2136 + GSS-TSIG) --------------
// Voir apps/api/src/types.ts pour la doc complète et apps/api/src/services/adDns.ts pour
// l'implémentation (kinit + nsupdate -g réels, aucune réimplémentation de Kerberos/DNS).

export interface AdDnsConfig {
  realm: string;
  kdcHost: string;
  zone: string;
  serviceAccount: string;
  targetIp: string;
}

/** GET /api/ad-dns/config — jamais le mot de passe du compte de service (write-only). */
export interface AdDnsStatus {
  configured: boolean;
  config?: AdDnsConfig;
  lastSync?: AdDnsSyncResult;
}

export type AdDnsSyncOutcome = "synced" | "failed";

export interface AdDnsSyncResult {
  status: AdDnsSyncOutcome;
  message?: string;
  at: string; // ISO 8601
}

/** POST /api/ad-dns/test — vérifie seulement l'obtention d'un ticket Kerberos, n'écrit aucun
 * enregistrement DNS. */
export interface AdDnsTestResult {
  ok: boolean;
  message: string;
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

// "manual" : lancé par un clic operator/admin depuis ImagesPage.tsx. "automatic" : lancé tout
// seul par apps/api/src/services/scanScheduler.ts sur une image RÉELLEMENT déployée jamais
// scannée ou dont le dernier scan réussi est trop ancien. Optionnel pour rester lisible sur les
// scans persistés avant l'introduction de ce champ — undefined y est traité comme "manual".
export type ScanTrigger = "manual" | "automatic";

export interface ScanResult {
  id: string;
  scanner: ScannerId; // scanner à l'origine de ce résultat
  image: string; // référence Docker passée au scanner, ex: "nginx:1.27"
  status: ScanStatus;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  vulnerabilities: Vulnerability[];
  summary: Record<VulnSeverity, number>;
  trigger?: ScanTrigger;
}

// --- Notifications système (watchdog proactif + scanScheduler) — voir ARCHITECTURE.md
// § "Détection proactive (watchdog)" / § "Scan automatique des images déployées" et
// apps/api/src/services/watchdog.ts / apps/api/src/services/scanScheduler.ts ---

export type SystemNotificationKind =
  | "image_update_available"
  | "integration_unreachable"
  | "integration_reachable"
  | "gitops_drift_detected"
  | "vulnerability_detected"
  // Émis par une action "send-notification" du moteur d'automatisation — voir
  // apps/api/src/services/automationEngine.ts pour le détail complet.
  | "automation_triggered";

export interface SystemNotificationEvent {
  id: string;
  timestamp: string; // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  message: string;
  read: boolean;
}

// --- Canaux de notification sortants (webhook générique/Slack/Discord/email SMTP) — voir
// apps/api/src/services/notificationChannelsStore.ts et apps/api/src/services/
// notificationDispatch.ts. Chaque SystemNotificationEvent émis par recordNotificationEvent()
// (watchdog + réconciliateur GitOps + scanScheduler) est aussi routé, en fire-and-forget, vers
// chaque canal actif dont le filtre matche — jamais bloquant, jamais d'exception remontée.

export type NotificationChannelKind = "webhook" | "slack" | "discord" | "email";

/** Filtre optionnel appliqué à un canal — absent/vide = tous les niveaux/types d'événement. */
export interface NotificationChannelFilter {
  levels?: SystemNotificationEvent["level"][];
  kinds?: SystemNotificationKind[];
}

/** Vue "safe" par type — jamais de secret en clair (l'URL webhook/le mot de passe SMTP peuvent
 * porter un jeton d'authentification, donc jamais renvoyés par GET, même convention que
 * remoteDockerStore.ts#toRef pour ca/cert/key). */
export interface NotificationChannelWebhookRef {
  hasUrl: boolean;
}
export interface NotificationChannelSlackRef {
  hasWebhookUrl: boolean;
}
export interface NotificationChannelDiscordRef {
  hasWebhookUrl: boolean;
}
export interface NotificationChannelEmailRef {
  smtpHost: string;
  smtpPort: number;
  smtpUsername?: string;
  smtpSecure: boolean; // true = TLS implicite (port 465 typiquement), false = STARTTLS/clair
  fromAddress: string;
  toAddress: string;
  hasSmtpPassword: boolean;
}

/** GET /api/notification-channels — jamais de secret en clair, voir les Ref par type ci-dessus. */
export interface NotificationChannelRef {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  filter?: NotificationChannelFilter;
  webhook?: NotificationChannelWebhookRef;
  slack?: NotificationChannelSlackRef;
  discord?: NotificationChannelDiscordRef;
  email?: NotificationChannelEmailRef;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** POST /api/notification-channels/:id/test — envoi RÉEL au canal, jamais persisté dans le journal. */
export interface NotificationChannelTestResult {
  ok: boolean;
  message: string;
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

// --- Intégration GitHub (GitOps réel) — voir ARCHITECTURE.md § "Intégration GitHub" et
// apps/api/src/services/github.ts / githubStore.ts. Le jeton n'est jamais renvoyé par une route GET.

export interface GithubStatus {
  configured: boolean;
  usingGhcrFallback: boolean;
}

export interface GithubRepoRef {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface GithubRepoDetection {
  ref: string;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[];
  /** Dernière instruction EXPOSE trouvée dans le Dockerfile de la racine — absent si aucun
   * Dockerfile ou aucun EXPOSE, jamais deviné. Pré-remplit le champ "port" (toujours éditable). */
  exposedPort?: number;
}

export type GithubDeploymentStatus = "running" | "success" | "failed";
export type GithubDeploymentKind = "docker-build-run" | "iac-workspace";
export type GithubDeploymentTrigger = "manual" | "webhook";

export interface GithubDeploymentCommit {
  sha: string;
  message: string;
  author: string;
  authorAvatarUrl?: string;
}

export interface GithubDeployment {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  targetEnvironmentId: string | null;
  kind: GithubDeploymentKind | null;
  status: GithubDeploymentStatus;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  triggeredBy: GithubDeploymentTrigger;
  commit?: GithubDeploymentCommit;
  imageTag?: string;
  containerId?: string;
  containerName?: string;
  iacWorkspaceId?: string;
  subdomain?: string;
  reverseProxyRouteId?: string;
}

export interface GithubDeploymentDetail extends GithubDeployment {
  log: string;
}

/** GET/PUT /api/github/repos/:owner/:repo/auto-deploy — déploiement automatique sur push. */
export interface GithubAutoDeployStatus {
  owner: string;
  repo: string;
  enabled: boolean;
  branch: string;
  targetEnvironmentId?: string;
  subdomain?: string;
  port?: number;
  updatedAt: string | null;
}

// --- Métriques temps réel et historiques (voir apps/api/src/services/metricsCollector.ts) ---
// Scrape périodique (tous les conteneurs `running`, 30s par défaut) écrit un point par conteneur
// par cycle dans un store à fenêtre glissante — voir GET /api/containers/:id/metrics.

export interface ContainerMetricPoint {
  containerId: string;
  timestamp: string; // ISO 8601
  cpuPercent: number;
  memBytes: number;
  /** Cumuls réseau/disque réels — optionnels, voir apps/api/src/types.ts pour le détail complet
   * (absents sur les points antérieurs au 13/08/2026 ou pour un conteneur en network_mode:host). */
  netRxBytes?: number;
  netTxBytes?: number;
  blkReadBytes?: number;
  blkWriteBytes?: number;
}

// --- Cron Jobs comme type de service natif (voir apps/api/src/services/cronJobsStore.ts et
// cronJobsScheduler.ts) — façon Railway : une expression cron standard 5 champs associée à une
// commande shell exécutée via un VRAI `docker exec` dans un conteneur déjà existant.

export interface CronJobDefinition {
  id: string;
  name: string;
  containerId: string;
  /** Dénormalisé pour affichage même si le conteneur cible est ensuite supprimé/renommé. */
  containerName: string;
  /** Exécutée dans le conteneur cible via ["/bin/sh", "-c", command]. */
  command: string;
  // Expression cron standard 5 champs, ex "0,5,10 * * * *" ou une syntaxe avec pas.
  schedule: string;
  enabled: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy: string; // username
}

export type CronJobRunStatus = "running" | "success" | "failed";

/** "scheduled" : déclenché tout seul par le cycle du scheduler. "manual" : clic operator/admin
 * (POST /api/cron-jobs/:id/trigger). */
export type CronJobRunTrigger = "scheduled" | "manual";

export interface CronJobRun {
  id: string;
  jobId: string;
  status: CronJobRunStatus;
  trigger: CronJobRunTrigger;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  /** null si non déterminé (ex : timeout, conteneur injoignable avant le lancement réel). */
  exitCode: number | null;
  /** Sortie stdout+stderr entrelacée réellement capturée sur l'exec Docker, tronquée au-delà
   * d'une taille raisonnable côté API. */
  output: string;
}

// --- Sauvegardes automatiques (volumes Docker + bases de données) vers un stockage
// S3-compatible — voir apps/api/src/services/backupsStore.ts (définitions + historique) et
// apps/api/src/services/backupScheduler.ts (exécution réelle : tar/pg_dump/mysqldump/mongodump
// en sous-processus/docker exec, upload/suppression S3 via @aws-sdk/client-s3). accessKey/
// secretKey ne transitent JAMAIS par ce contrat une fois enregistrés (write-only, même principe
// que RemoteDockerTls/SecretRef) : seul `hasCredentials` indique leur présence.

export type BackupTargetKind = "volume" | "database";

export type BackupDatabaseEngine = "postgres" | "mysql" | "mariadb" | "mongo";

export interface BackupTarget {
  kind: BackupTargetKind;
  /** "volume" : nom du volume Docker. "database" : id du conteneur cible — le dump est exécuté
   * DEDANS via `docker exec` (dockerode `container.exec`, même mécanisme que la console
   * interactive), jamais par un binaire pg_dump/mysqldump/mongodump installé côté API. */
  ref: string;
  /** "database" uniquement : détecté automatiquement depuis l'image du conteneur cible au moment
   * de l'exécution (ex: "postgres:16" -> "postgres") — jamais saisi manuellement, jamais fabriqué
   * si l'image ne correspond à aucun moteur supporté (l'exécution échoue alors explicitement). */
  engine?: BackupDatabaseEngine;
}

export interface BackupDestinationRef {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  hasCredentials: boolean;
}

export interface BackupDefinition {
  id: string;
  name: string;
  target: BackupTarget;
  destination: BackupDestinationRef;
  /** Expression cron standard à 5 champs (minute heure jour-du-mois mois jour-de-semaine). */
  schedule: string;
  /** Nombre de copies conservées — rotation automatique (S3 + historique local) au-delà, voir
   * services/backupsStore.ts#computeRunsToRotate. */
  retentionCount: number;
  enabled: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type BackupRunStatus = "running" | "success" | "failed";

/** "scheduled" : lancé tout seul par services/backupScheduler.ts quand l'expression cron matche.
 * "manual" : POST /api/backups/:id/run (bouton "Sauvegarder maintenant"). */
export type BackupRunTrigger = "scheduled" | "manual";

export interface BackupRun {
  id: string;
  definitionId: string;
  status: BackupRunStatus;
  trigger: BackupRunTrigger;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  sizeBytes: number | null;
  /** Clé de l'objet S3 uploadé — absente tant que l'upload n'a pas réussi. */
  objectKey?: string;
  /** Détail concret en cas d'échec (jamais avalé) — absent si status !== "failed". */
  error?: string;
  /** true une fois que la rotation (retentionCount dépassé) a réellement supprimé l'objet côté
   * S3 — le run reste visible dans l'historique (append-only, voir backupsStore.ts) mais n'est
   * plus proposé à la restauration. Absent = jamais rotaté. */
  rotated?: boolean;
}

/** POST /api/backups/:id/restore/:runId — restauration RÉELLE et destructive (voir
 * services/backupScheduler.ts#restoreBackup). */
export interface BackupRestoreResult {
  ok: boolean;
  message: string;
}
