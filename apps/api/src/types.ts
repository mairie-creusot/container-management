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
  // Limites CPU/mémoire réellement configurées (HostConfig.Memory/NanoCpus, `docker inspect`) —
  // absentes si aucune limite n'a été fixée à la création (0 côté Docker = pas de limite), jamais
  // une valeur fabriquée. Voir POST /api/containers pour la création avec ces limites.
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

/** Snapshot instantané des logs d'un conteneur (équivalent `docker logs --tail <n>`) — voir
 * GET /api/containers/:id/logs. Le flux temps réel (GET (WebSocket) /api/containers/:id/logs/stream)
 * envoie du texte brut chunk par chunk, sans passer par ce contrat JSON (même principe que la
 * console interactive, routes/console.ts). */
export interface ContainerLogsSnapshot {
  logs: string;
}

/**
 * Processus RÉELLEMENT en cours d'exécution dans un conteneur (équivalent `docker top <id>`) —
 * voir GET /api/containers/:id/processes et services/docker.ts#getContainerProcesses. `titles`
 * reflète les colonnes RÉELLES retournées par le démon (dépend de la commande `ps` disponible
 * dans l'image cible, pas un schéma fixe imposé côté QUAI) ; `processes` porte une entrée par
 * ligne, valeurs alignées avec `titles`. Ce n'est PAS une reconstruction de l'architecture
 * applicative interne du conteneur (QUAI n'a aucun moyen de la connaître réellement) : seulement
 * ce que le noyau hôte voit tourner dans le namespace PID du conteneur, tel quel.
 */
export interface ContainerProcessList {
  titles: string[];
  processes: string[][];
}

/**
 * Une couche de l'image d'un conteneur (équivalent `docker history <image>`) — voir
 * GET /api/images/:id/history et services/docker.ts#getImageHistory. `id` vaut souvent
 * "<missing>" pour une couche intermédiaire sans image id propre (comportement natif Docker,
 * pas une anomalie). `createdBy` est la commande Dockerfile telle que Docker la restitue
 * (déjà tronquée par le démon lui-même au-delà d'une certaine longueur).
 */
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
// par un GET liste/détail — seule POST /api/secrets/:id/reveal, admin uniquement, la
// déchiffre à la demande), référencée par `name` lors de la création d'un conteneur.

/** Un conteneur qui référence RÉELLEMENT ce secret via `secretEnv` à sa création (jamais une
 * coïncidence de variable d'environnement) — voir POST /api/containers et
 * secretsStore.ts#recordSecretUsage. */
export interface SecretUsage {
  containerId: string;
  containerName: string;
  key: string; // clé d'env sous laquelle ce secret est injecté dans CE conteneur
}

/** Métadonnées (JAMAIS la valeur) d'une version passée ou courante d'un secret — façon Vault
 * KV v2 (created_time/version courante séparés de la donnée). Voir GET /api/secrets/:id/versions. */
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
  // Historique borné façon Vault KV v2 (cf. ARCHITECTURE.md) : `version` est la version courante,
  // `versionCount` = 1 (courante) + versions précédentes conservées (voir MAX_HISTORY_VERSIONS
  // dans secretsStore.ts) — sert au frontend à savoir s'il vaut la peine de proposer "Historique".
  version: number;
  versionCount: number;
  // Optionnelle : au-delà de cette date, POST /api/containers refuse de résoudre ce secret dans
  // `secretEnv` (SecretExpiredError -> 400) ; reveal reste permissif (rotation possible même
  // expiré). Absente = pas d'expiration configurée.
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
  /**
   * Résultat du dernier essai de synchronisation DNS AD pour cette route (voir services/adDns.ts)
   * — absent si l'intégration AD DNS n'a jamais été configurée (aucune tentative faite). Permet
   * d'éliminer le besoin d'une entrée manuelle de fichier hosts : quand ce statut est "synced",
   * `subdomain` résout réellement via le DNS AD de la mairie, sans intervention côté poste client.
   */
  dnsSync?: AdDnsSyncResult;
}

/** GET /api/reverse-proxy/status — Caddy joignable ou non, même pattern que ScannerStatus. */
export interface ReverseProxyStatus {
  reachable: boolean;
  adminUrl: string;
  /** true si Caddy sert aussi en HTTPS (:443, certificats émis par son autorité interne — voir
   * reverseProxy.ts). Toujours true dès que Caddy est joignable (poussé à chaque configuration
   * depuis le durcissement TLS de ce jour), false si injoignable (inconnu plutôt qu'affirmé). */
  httpsEnabled: boolean;
}

// --- DNS Active Directory (mise à jour dynamique sécurisée, RFC 2136 + GSS-TSIG) --------------
// QUAI ne réimplémente AUCUN client Kerberos/DNS : `kinit` (krb5-user) obtient un ticket pour le
// compte de service configuré, `nsupdate -g` (bind9-dnsutils) l'utilise pour authentifier une
// mise à jour dynamique sécurisée auprès du DNS intégré à l'AD — exactement le mécanisme standard
// qu'utilisent les clients Windows/DHCP pour s'enregistrer eux-mêmes. Objectif : quand une route
// de reverse proxy est créée, son sous-domaine devient réellement résolvable sur le réseau de la
// mairie SANS entrée manuelle de fichier hosts — voir services/adDns.ts.

export interface AdDnsConfig {
  /** Royaume Kerberos (ex "LECREUSOT.FR", conventionnellement en majuscules). */
  realm: string;
  /** Contrôleur de domaine faisant aussi office de KDC/serveur DNS (ex "dc01.lecreusot.fr"). */
  kdcHost: string;
  /** Zone DNS à mettre à jour (ex "lecreusot.fr"). */
  zone: string;
  /** Compte de service Kerberos avec droit "Dynamic Update" sur la zone (ex "svc-quai-dns"). */
  serviceAccount: string;
  /** IP (LAN) vers laquelle pointeront les enregistrements A créés — généralement l'IP de la
   * machine hôte qui publie les ports 80/443 de Caddy (le reverse proxy lui-même). */
  targetIp: string;
}

/** GET /api/ad-dns/config — jamais le mot de passe du compte de service (write-only, voir PUT). */
export interface AdDnsStatus {
  configured: boolean;
  config?: AdDnsConfig;
  lastSync?: AdDnsSyncResult;
}

export type AdDnsSyncOutcome = "synced" | "failed";

export interface AdDnsSyncResult {
  status: AdDnsSyncOutcome;
  /** Détail concret en cas d'échec (jamais avalé) — vide/absent si status = "synced". */
  message?: string;
  at: string; // ISO 8601
}

/** POST /api/ad-dns/test — vérifie seulement l'obtention d'un ticket Kerberos (kinit), n'écrit
 * aucun enregistrement DNS : sert à valider les identifiants avant d'enregistrer la config. */
export interface AdDnsTestResult {
  ok: boolean;
  message: string;
}

// --- Métriques temps réel et historiques (voir apps/api/src/services/metricsCollector.ts) ---
// QUAI expose déjà cpuPercent/memBytes en instantané (docker.ts#readContainerUsage, utilisé par
// topology.ts) mais ne persistait aucune série temporelle avant ce chantier. Un scrape périodique
// (metricsCollector.ts) échantillonne tous les conteneurs `running` et écrit un point par
// conteneur par cycle dans un store JSON Lines à fenêtre glissante (purge des points plus vieux
// qu'une rétention configurable, cf. config.metrics.retentionMs) — voir GET
// /api/containers/:id/metrics.

export interface ContainerMetricPoint {
  containerId: string;
  timestamp: string; // ISO 8601
  cpuPercent: number;
  memBytes: number;
}

// --- Cron Jobs comme type de service natif (voir apps/api/src/services/cronJobsStore.ts et
// cronJobsScheduler.ts) — façon Railway (docs.railway.com/cron-jobs) : une expression cron
// standard 5 champs (minute heure jour-du-mois mois jour-de-semaine) associée à une commande
// shell exécutée via un VRAI `docker exec` (dockerode container.exec, même mécanisme que la
// console interactive, cf. services/docker.ts#openContainerConsole) DANS un conteneur déjà
// existant — jamais de `docker run` éphémère dans ce premier lot (cas d'usage le plus simple et
// le plus courant à livrer proprement, cf. ARCHITECTURE.md). Garde anti-chevauchement : un cycle
// dont le précédent tourne encore est sauté, jamais mis en file d'attente (cf.
// cronJobsScheduler.ts#decideCronJobTick).

export interface CronJobDefinition {
  id: string;
  name: string;
  containerId: string;
  /** Dénormalisé pour affichage même si le conteneur cible est ensuite supprimé/renommé. */
  containerName: string;
  /** Exécutée dans le conteneur cible via ["/bin/sh", "-c", command]. */
  command: string;
  // Expression cron standard 5 champs, ex "0,5,10 * * * *" ou une syntaxe avec pas (voir
  // cronJobsScheduler.ts#parseCronExpression pour la syntaxe complète supportée).
  schedule: string;
  enabled: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy: string; // username
}

export type CronJobRunStatus = "running" | "success" | "failed";

/** "scheduled" : déclenché tout seul par le cycle du scheduler. "manual" : clic operator/admin
 * (POST /api/cron-jobs/:id/trigger) — même distinction que ScanTrigger pour scan.ts. */
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
   * d'une taille raisonnable (cf. MAX_OUTPUT_LENGTH, cronJobsScheduler.ts). */
  output: string;
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

export type TopologyNodeKind = "container" | "volume" | "network" | "nutanix-vm" | "ad-server";

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
  /**
   * Volumes/networks uniquement : horodatage de création RÉEL rapporté par Docker (`CreatedAt`/
   * `Created`). Absent pour les conteneurs/VMs Nutanix (pas nécessaire : leur id EST déjà un
   * identifiant Docker/Nutanix immuable, jamais recyclé — voir topology.ts en-tête de fichier).
   * Sert de garde-fou côté frontend (TopologyGraph.tsx) contre le seul cas réel de recyclage
   * d'id : `volume:<nom>` n'a pas d'autre identité chez Docker que son nom — supprimer un volume
   * puis en recréer un portant EXACTEMENT le même nom produit un nouveau `createdAt` sous le même
   * id de nœud, ce qui permet de détecter que ce n'est pas la même ressource plutôt que de lui
   * appliquer à tort une position héritée de l'ancien nœud.
   */
  createdAt?: string;
  /**
   * Conteneurs uniquement : volumes/networks montés sur CE conteneur et rattachés à AUCUN AUTRE
   * (voir services/topology.ts § "briques") — rendus par le frontend comme des "briques"
   * cliquables directement sous la carte du conteneur (façon Railway), PAS comme des nœuds/arêtes
   * séparés du graphe. Un réseau/volume partagé par ≥2 conteneurs, ou un network Docker par défaut
   * (bridge/host/none, partagé par nature), reste un vrai TopologyNode top-level avec ses arêtes —
   * seule la ressource à usage exclusif d'un unique conteneur devient une brique. `[]`/absent si ce
   * conteneur n'a aucune ressource "bricable" (tout ce qu'il monte est soit orphelin d'aucun autre
   * lien soit partagé, soit il ne monte rien).
   */
  attachments?: TopologyNodeAttachment[];
  /**
   * Conteneurs uniquement : sous-domaines de reverse proxy RÉELLEMENT associés à ce conteneur,
   * rapprochés par `targetContainerId` (voir services/reverseProxy.ts#listRoutes et
   * services/topology.ts) — URL complète (`https://<subdomain>`, TLS interne toujours actif côté
   * Caddy) affichée directement sur la carte du nœud, cliquable, façon Railway. `[]`/absent si
   * aucune route ne cible ce conteneur — jamais un domaine inventé.
   */
  domains?: string[];
}

/**
 * Une ressource (volume ou network) montée EXCLUSIVEMENT par un seul conteneur — voir
 * TopologyNode#attachments ci-dessus et services/topology.ts. `id` reprend le format qu'aurait eu
 * le TopologyNode top-level équivalent (`volume:<nom>` / `network:<id>`) : le frontend l'utilise
 * tel quel pour ouvrir le panneau de détail de cette ressource (mêmes routes GET /api/volumes,
 * GET /api/networks que pour un vrai nœud), sans dupliquer la logique de lookup.
 */
export interface TopologyNodeAttachment {
  kind: "volume" | "network";
  id: string;
  label: string;
  subtitle: string; // driver
  /** Volumes uniquement : point de montage réel dans le conteneur. */
  destination?: string;
  /** Volumes uniquement : monté en lecture seule. */
  readOnly?: boolean;
}

/** Port réellement publié par un conteneur (docker.listContainers()[].Ports — sous-ensemble déjà
 * inclus dans le résumé, pas d'inspect() séparé) — voir TopologyEdge#ports ci-dessous. */
export interface TopologyEdgePort {
  protocol: "tcp" | "udp";
  privatePort: number;
  publicPort?: number;
}

export interface TopologyEdge {
  id: string;
  source: string; // id de TopologyNode
  target: string; // id de TopologyNode
  kind: "mount" | "network";
  /**
   * "network" uniquement : ports RÉELLEMENT publiés par le conteneur à l'une des deux extrémités
   * (docker.listContainers()[].Ports, dédupliqués) — affiché façon Railway comme un badge flottant
   * sur l'arête. Note d'honnêteté : Docker n'attribue pas un port publié à un network précis (le
   * mapping host->conteneur est indépendant du network utilisé) — ce champ liste donc "les ports que
   * publie ce conteneur", pas "le trafic qui transite par CETTE arête" ; pour l'immense majorité des
   * cas (un seul network applicatif par conteneur) les deux coïncident. Absent/[] si le conteneur ne
   * publie aucun port vers l'hôte (cas courant : communication interne au network uniquement).
   */
  ports?: TopologyEdgePort[];
  /**
   * "network" uniquement : `Internal` réel du network Docker (docker.listNetworks()[].Internal) —
   * true = network non routé vers l'extérieur du démon Docker ("Private" façon Railway), false =
   * routable (ex : bridge par défaut avec NAT vers l'hôte). Absent seulement si le network n'a pas
   * pu être retrouvé (course rare entre deux appels Docker).
   */
  private?: boolean;
  /**
   * "network" uniquement, networks "overlay" seulement : chiffrement natif Docker au niveau network
   * (`--opt encrypted`, exposé dans `Options.encrypted`) — seul mécanisme de chiffrement de network
   * que Docker expose lui-même. Absent pour tout autre driver (bridge/host/none/macvlan) : la
   * question n'a pas le même sens pour eux (trafic local au noyau, jamais sur le fil), plutôt que
   * d'inventer un "non chiffré" alarmiste hors sujet.
   */
  encrypted?: boolean;
  /** "mount" uniquement : lecture seule réelle du montage (Mount.RW === false côté Docker), déjà
   * calculée pour les "briques" (TopologyNodeAttachment#readOnly) — reprise ici pour les volumes
   * restés de vrais nœuds (partagés par ≥2 conteneurs), qui n'ont pas d'attachment correspondant. */
  readOnly?: boolean;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string; // ISO 8601
  /** Regroupements réels créés par un utilisateur (voir TopologyGroup ci-dessous et
   * services/topologyGroupsStore.ts) — [] tant qu'aucun groupement n'a jamais été créé. */
  groups: TopologyGroup[];
}

/**
 * Regroupement visuel de nœuds RÉELS du graphe de topologie ("encapsulation façon Railway/
 * Logisim" — voir ARCHITECTURE.md § "Graphe de topologie") : une carte parente repliable/dépliable
 * qui contient visuellement des nœuds existants, créée UNIQUEMENT par une action explicite de
 * l'utilisateur (sélection multiple + "Regrouper" sur le canevas) — jamais deviné/inféré
 * automatiquement à partir des arêtes ou du nommage. Persisté côté serveur
 * (apps/api/src/services/topologyGroupsStore.ts, apps/api/data/topology-groups.json, même pattern
 * 0600 que reverse-proxy.json) et PARTAGÉ entre tous les utilisateurs connectés (contrairement aux
 * positions de nœuds, propres à chaque compte, voir topologyPositionsStore.ts) : un groupement
 * reflète une organisation réelle de l'infra que toute l'équipe doit voir, pas un confort
 * d'affichage individuel. Les ports d'entrée/sortie du groupe et le contenu affiché quand il est
 * déplié sont dérivés CÔTÉ CLIENT des arêtes réelles qui traversent sa frontière (voir
 * topologyGraphShared.tsx#deriveGroupPorts) — jamais persistés ici, pour ne jamais désynchroniser
 * d'une vraie connexion Docker.
 */
export interface TopologyGroup {
  id: string; // "group:<uuid>"
  label: string;
  /** Ids de TopologyNode RÉELS regroupés — toujours >= 2 (voir topologyGroupsStore.ts#createGroup),
   * jamais un id inventé ou un nœud déjà membre d'un autre groupe. */
  nodeIds: string[];
  /** Replié (une seule carte compacte) ou déplié (cadre contenant visuellement ses membres). */
  collapsed: boolean;
  createdAt: string; // ISO 8601
  createdBy: string; // username LDAP à l'origine du regroupement
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

// "manual" : lancé par un clic operator/admin depuis ImagesPage.tsx (POST /api/images/:id/scan
// sans le préciser explicitement retombe sur "manual", comportement historique inchangé).
// "automatic" : lancé tout seul par services/scanScheduler.ts (voir ce fichier) sur une image
// RÉELLEMENT déployée jamais scannée ou dont le dernier scan réussi est trop ancien — jamais
// déclenché par une action utilisateur. Champ optionnel pour rester lisible sur les lignes de
// scans.jsonl écrites avant l'introduction de ce champ (undefined y est traité comme "manual"
// côté frontend, comportement historique).
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

// --- Notifications système (watchdog proactif + scanScheduler) — voir
// apps/api/src/services/watchdog.ts et apps/api/src/services/scanScheduler.ts ---
// Événements détectés tout seuls en tâche de fond (PAS déclenchés par une action utilisateur,
// contrairement aux notifications d'erreur d'action côté web) : nouvelle version d'image
// disponible, intégration qui devient injoignable ou de nouveau joignable, vulnérabilité
// critique trouvée par un scan automatique. Émis une seule fois par transition/par scan
// concerné (edge-triggered pour le watchdog ; voir scanScheduler.ts pour la nature différente
// de sa propre condition d'émission), jamais répétés en boucle sans raison.

export type SystemNotificationKind =
  | "image_update_available"
  | "integration_unreachable"
  | "integration_reachable"
  | "gitops_drift_detected"
  | "vulnerability_detected";

export interface SystemNotificationEvent {
  id: string;
  timestamp: string; // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  /** Message concret et actionnable, ex: "Nouvelle version disponible pour nginx:1.25 -> 1.27". */
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

// --- Intégration GitHub (GitOps réel) — voir apps/api/src/services/githubStore.ts et
// apps/api/src/services/github.ts. Parcourt les VRAIS repos accessibles avec un jeton GitHub
// (PAT) configuré, détecte les fichiers réellement présents à la racine (Dockerfile, compose,
// Terraform), clone/build/déploie réellement. Le jeton n'est jamais renvoyé par une route GET.

/** GET /api/github/status — jamais le jeton lui-même. */
export interface GithubStatus {
  configured: boolean;
  /**
   * true si aucun jeton GitHub dédié n'est configuré mais qu'un jeton GHCR persisté (souvent un
   * PAT GitHub à scope large utilisé pour `docker login ghcr.io`, voir setupStore.ts) est utilisé
   * en repli automatique pour lister les repos — jamais modifié par ce module (lecture seule).
   */
  usingGhcrFallback: boolean;
}

export interface GithubRepoRef {
  id: number;
  fullName: string; // "owner/repo"
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string; // ISO 8601
}

/**
 * GET /api/github/repos/:owner/:repo/detect — résumé honnête de ce qui est réellement présent à
 * la RACINE du repo (pas de parcours récursif dans ce premier lot, voir ARCHITECTURE.md) : un
 * repo sans Dockerfile ne doit jamais faire remonter hasDockerfile: true.
 */
export interface GithubRepoDetection {
  ref: string; // branche/commit effectivement inspecté (résolu à la branche par défaut si omis)
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[]; // noms de fichiers *.tf trouvés à la racine
  /** Dernière instruction EXPOSE trouvée dans le Dockerfile de la racine (lecture réelle du
   * contenu du fichier via l'API Contents GitHub) — absent si aucun Dockerfile ou aucune
   * instruction EXPOSE, jamais une valeur devinée par convention. Pré-remplit le champ "port"
   * du formulaire de déploiement (voir GitHubDeployPage.tsx), toujours éditable. */
  exposedPort?: number;
}

export type GithubDeploymentStatus = "running" | "success" | "failed";

/**
 * "docker-build-run" : Dockerfile détecté -> vrai `docker build` + `docker run` sur la cible.
 * "iac-workspace" : *.tf détecté sans Dockerfile -> workspace IaC créé (voir services/iac/),
 * aucun `tofu apply` automatique — reporté à une action explicite ultérieure de l'utilisateur.
 * null tant que le clone/la détection n'a pas encore déterminé la voie suivie (déploiement
 * encore "running").
 */
export type GithubDeploymentKind = "docker-build-run" | "iac-workspace";

/** "manual" : clic operator/admin sur GitHubDeployPage.tsx. "webhook" : push GitHub reçu par
 * POST /api/github/webhook avec le déploiement automatique activé pour ce dépôt (voir
 * services/githubStore.ts#StoredAutoDeployEntry, routes/githubWebhook.ts). */
export type GithubDeploymentTrigger = "manual" | "webhook";

/** Métadonnées RÉELLES du commit déployé — récupérées via l'API GitHub (GET .../commits/:ref)
 * pour un déploiement manuel, ou directement depuis le payload `push` pour un déploiement
 * automatique (même donnée, deux sources selon le chemin) : jamais fabriqué, absent si la
 * récupération échoue (best-effort, ne bloque jamais le déploiement lui-même). */
export interface GithubDeploymentCommit {
  sha: string;
  message: string; // première ligne uniquement
  author: string; // login GitHub si connu, sinon nom du commit Git
  authorAvatarUrl?: string;
}

export interface GithubDeployment {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  /** null = Docker local (voir services/docker.ts#getClient sans argument). */
  targetEnvironmentId: string | null;
  kind: GithubDeploymentKind | null;
  status: GithubDeploymentStatus;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  startedBy: string; // username, ou "github-webhook:<login>" pour un déclenchement automatique
  triggeredBy: GithubDeploymentTrigger;
  commit?: GithubDeploymentCommit;
  imageTag?: string; // kind "docker-build-run"
  containerId?: string; // kind "docker-build-run"
  containerName?: string; // kind "docker-build-run"
  iacWorkspaceId?: string; // kind "iac-workspace"
  /** Sous-domaine demandé pour ce déploiement (reverse proxy interne), s'il y en a un — voir
   * GitHubDeployPage.tsx. Présent même si la route n'a en fin de compte pas pu être créée
   * (ex: aucun port EXPOSE détecté ni fourni) : reverseProxyRouteId distingue les deux cas. */
  subdomain?: string;
  /** id de la route reverse-proxy (services/reverseProxy.ts) effectivement créée pour ce
   * déploiement — absent si aucun sous-domaine demandé, ou si la création a échoué (voir le log
   * du déploiement pour le détail dans ce dernier cas, jamais une route fantôme inventée ici). */
  reverseProxyRouteId?: string;
}

/** GithubDeployment + le log complet (clone + build + run entrelacés) — chargé à la demande, même principe que IacRunDetail. */
export interface GithubDeploymentDetail extends GithubDeployment {
  log: string;
}

/**
 * GET/PUT /api/github/repos/:owner/:repo/auto-deploy — déploiement automatique sur push (webhook
 * GitHub réel, cf. routes/githubWebhook.ts). Jamais de secret ici (voir
 * services/githubStore.ts#StoredAutoDeployEntry pour la forme persistée avec le secret chiffré).
 */
export interface GithubAutoDeployStatus {
  owner: string;
  repo: string;
  enabled: boolean;
  branch: string;
  targetEnvironmentId?: string;
  subdomain?: string;
  port?: number;
  updatedAt: string | null; // null si jamais configuré
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
