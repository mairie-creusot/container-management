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
  // Organisation GitHub (ghcr) ou namespace/compte (dockerhub) EXPLICITEMENT configuré —
  // indépendant de `username` (identité de connexion, souvent un e-mail pour GHCR, jamais un
  // org/user GitHub valide). Absent = pas de valeur explicite, repli sur l'ancienne déduction
  // (username non-email, puis image locale déjà tirée pour GHCR) — voir
  // registriesStore.ts#resolveRegistryOrg. Pas un secret : exposé tel quel dans la vue publique,
  // contrairement à username/password/token.
  org?: string;
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
 * Détail d'UN process précis d'un conteneur, lu directement dans `/proc/<pid>` DEPUIS L'INTÉRIEUR
 * du conteneur cible (via `docker exec`, jamais `docker top`/dockerode `container.top()`) — voir
 * GET /api/containers/:id/processes/:pid/inspect et services/docker.ts#inspectContainerProcess.
 * `pid` suit donc la numérotation vue PAR LE CONTENEUR LUI-MÊME (son propre namespace PID), PAS
 * les PID hôte que renvoie `docker top` — ces deux numérotations sont complètement différentes
 * (un même process peut porter un PID à 6 chiffres côté hôte et un PID à un chiffre côté
 * conteneur). Toute action sur un process (kill/restart, voir plus bas) utilise cette même
 * convention "vue conteneur", jamais de traduction hôte<->conteneur.
 */
export interface ContainerProcessInspection {
  pid: number;
  /** Ligne de commande RÉELLE (`/proc/<pid>/cmdline`, champs déjà séparés) — toujours présente si
   * le process existe encore (contrairement à environ/openFiles ci-dessous, jamais verrouillée
   * pour un process qu'on peut par ailleurs lister). */
  cmdline: string[];
  /** Variables d'environnement RÉELLES du process (`/proc/<pid>/environ`) — absent si le noyau a
   * refusé la lecture pour CE process précis (permission refusée, ex: process ayant changé d'UID
   * via setuid) : dans ce cas le champ est omis, JAMAIS un objet vide fabriqué comme s'il n'avait
   * aucune variable d'environnement. Voir `partial` ci-dessous. */
  environ?: Record<string, string>;
  /** Cibles réelles des descripteurs de fichier ouverts (`/proc/<pid>/fd/*`, résolues via
   * `readlink`) — chemins de fichiers réels, ou `socket:[inode]`/`pipe:[inode]` pour les
   * descripteurs qui ne pointent pas vers un fichier. Mêmes conditions d'absence qu`environ`
   * ci-dessus (jamais un tableau vide fabriqué en cas d'échec de lecture). */
  openFiles?: string[];
  /** true si `environ` et/ou `openFiles` a dû être omis faute de permission sur ce process précis
   * — honnêteté explicite plutôt qu'un échec silencieux de toute la requête : `cmdline` reste
   * fiable dans tous les cas où ce type est renvoyé. Absent/false = les trois champs sont complets. */
  partial?: boolean;
}

/**
 * Détail enrichi d'un processus RÉEL en cours d'exécution DANS le conteneur cible — voir GET
 * /api/containers/:id/processes/detailed et services/containerInternals.ts. Contrairement à
 * ContainerProcessList ci-dessus (qui reflète `docker top`, donc des PID côté HÔTE — inutilisables
 * pour agir dessus depuis l'intérieur du conteneur), `pid`/`ppid` ici sont lus DEPUIS `/proc` À
 * L'INTÉRIEUR du conteneur cible (via un `docker exec`) : ce sont les PID tels que le conteneur se
 * voit lui-même, les SEULS utilisables pour un futur `docker exec <container> kill <pid>`.
 */
export interface ContainerProcessDetail {
  pid: number;
  ppid: number;
  /** Nom résolu depuis /etc/passwd si lisible dans le conteneur cible (best-effort) ; sinon l'uid
   * numérique brut sous forme de chaîne — jamais un nom fabriqué. */
  user: string;
  /** `comm` tel que rapporté par /proc/<pid>/stat — peut contenir espaces/parenthèses. */
  command: string;
  /** Code d'état process brut (`man 5 proc`, ex: "S", "R", "Z"...), jamais traduit/deviné. */
  state: string;
  /** Temps CPU cumulé RÉEL (utime+stime, convertis via CLK_TCK lu dans le conteneur cible). */
  cpuTimeMs: number;
  /** Âge réel = uptime système (lu dans le conteneur cible) - starttime du process, en secondes. */
  ageSeconds: number;
  /** Ports RÉELLEMENT en LISTEN possédés par ce process (croisement /proc/net/tcp[6] <-> /proc/<pid>/fd/*,
   * voir containerInternals.ts) — absent si ce process ne détient aucun socket en LISTEN. */
  listenPorts?: number[];
}

/**
 * Voir GET /api/containers/:id/processes/detailed. `shellAvailable: false` (processes toujours [])
 * signifie qu'aucun shell POSIX (`sh`) n'a pu être exécuté dans le conteneur cible (image
 * "distroless"/scratch, typiquement) — le frontend doit alors afficher un message honnête plutôt
 * qu'une liste vide silencieuse qui laisserait croire qu'aucun processus ne tourne.
 */
export interface ContainerProcessDetailList {
  processes: ContainerProcessDetail[];
  shellAvailable: boolean;
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

/**
 * Hexdump en lecture seule d'une fenêtre d'octets d'un fichier ARBITRAIRE dans un conteneur —
 * voir GET /api/containers/:id/files/hexdump et services/docker.ts#readContainerFileHexdump.
 * ADMIN UNIQUEMENT côté route (surface plus sensible que VolumeFileEntry ci-dessus : lecture de
 * contenu binaire brut, pas juste un listing de noms/tailles — peut exposer un secret sur disque).
 */
export interface FileHexdump {
  /** Chemin absolu normalisé réellement lu (voir assertValidAbsoluteFilePath, services/docker.ts). */
  path: string;
  /** Taille RÉELLE et totale du fichier dans le conteneur (indépendante de `length`/`offset` demandés). */
  sizeBytes: number;
  /** true si `sizeBytes > offset + (length octets réellement renvoyés)` — le fichier est plus
   * gros que la fenêtre lue, que ce soit parce que le client a demandé moins que le fichier entier
   * ou parce que `length` a été plafonné côté serveur (voir HEXDUMP_MAX_LENGTH). Le frontend s'en
   * sert pour afficher "fichier tronqué" plutôt que de laisser croire que `bytes` est le fichier entier. */
  truncated: boolean;
  offset: number;
  /** Nombre d'octets RÉELLEMENT renvoyés dans `bytes` (donc bytes.length === length * 2) — peut
   * être inférieur à la longueur demandée par le client (fin de fichier atteinte, ou plafonnement). */
  length: number;
  /** Représentation hexadécimale minuscule, sans espaces ni séparateurs (ex: "deadbeef...") — le
   * frontend formate lui-même l'affichage colonnes/ASCII à partir de cette chaîne brute. */
  bytes: string;
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
  /** uuid réel du cluster physique (cluster_reference) — absent seulement si Prism Central ne l'a
   * pas renvoyé (rare). Sert à relier une VM à son VRAI nœud "host" de cluster par identité stable
   * dans le graphe de topologie (services/topology.ts), jamais par rapprochement de nom. */
  clusterUuid?: string;
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

// --- Config Nutanix, éditable EN DEHORS de l'assistant de premier lancement (routes/nutanix.ts,
// services/setupStore.ts#setNutanixConfig/clearNutanixConfig) — avant ces routes, la seule façon
// de configurer Nutanix était l'étape "Orchestrateurs" de l'assistant, invisible/inaccessible une
// fois celui-ci terminé sans tout rouvrir (POST /api/setup/reset, LDAP compris).

/** Jamais le mot de passe (write-only, comme AdDnsConfig ci-dessous). */
export interface NutanixConfig {
  prismCentralUrl: string;
  username: string;
}

/** GET /api/nutanix/config */
export interface NutanixStatus {
  configured: boolean;
  config?: NutanixConfig;
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
  /** Cumuls RÉSEAU/DISQUE réels (voir services/docker.ts#ContainerUsage) — optionnels : absents
   * pour tout point persisté AVANT l'ajout de ces champs (13/08/2026, jamais rétro-calculés sur
   * l'historique déjà écrit) et pour un conteneur en `network_mode: host`/dont le storage driver
   * ne remonte pas l'E/S bloc. Le frontend doit toujours gérer leur absence gracieusement (aucune
   * courbe affichée pour un point qui ne les porte pas), jamais une valeur 0 substituée qui
   * laisserait croire à une mesure réelle nulle. */
  netRxBytes?: number;
  netTxBytes?: number;
  blkReadBytes?: number;
  blkWriteBytes?: number;
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
//
// "cron-job"/"backup" (voir getCronJobNodes/getBackupNodes, services/topology.ts) : un nœud PAR
// DÉFINITION réelle (cronJobsStore.ts/backupsStore.ts, jamais modifiés par ce chantier — la
// mission "tout devient un nœud du graphe" ne fait que projeter leurs définitions déjà
// persistées dans la topologie), indépendants de Docker comme "ad-server"/"nutanix-vm" ci-dessus
// (récupérés que le démon local soit joignable ou non). `status` dérivé de la DERNIÈRE exécution
// réelle connue (CronJobRun/BackupRun) — jamais inventé :
//  - aucune exécution connue -> "neutral" ("jamais exécuté", même convention que "ad-server" sans
//    tentative de synchro depuis le démarrage du process) ;
//  - dernière exécution "running" -> "restarting" (exécution en cours) ;
//  - dernière exécution "success" -> "running" ;
//  - dernière exécution "failed" -> "stopped".
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

/**
 * Sous-type d'un nœud "host" (voir TopologyNode#hostKind ci-dessous, services/topology.ts) —
 * champ explicite plutôt qu'une convention de préfixe dans `subtitle` (fragile, pas typé) : le
 * frontend choisit l'icône/couleur/contenu du panneau de détail sur CE champ, jamais en parsant du
 * texte libre.
 */
export type TopologyHostKind = "nutanix-cluster" | "remote-docker" | "lxc";

export interface TopologyNode {
  // ex: "container:<id>", "volume:<name>", "network:<id>", "nutanix-vm:<uuid>",
  // "host:nutanix-cluster:<uuid>", "host:remote-docker:<id>", "host:lxc", "cron-job:<id>",
  // "backup:<id>"
  id: string;
  kind: TopologyNodeKind;
  label: string;
  /** Sous-titre affiché sous le label (ex: image du conteneur, driver du volume, cluster physique
   * pour une VM Nutanix, adresse/description réelle pour un nœud "host"). */
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
  /**
   * Nœuds "host" uniquement (voir services/topology.ts) : sous-type explicite d'hôte — cluster
   * Nutanix physique, environnement Docker distant (SSH/TCP+TLS, remoteDockerStore.ts) ou hôte LXD
   * (lxcStore.ts). Le frontend s'en sert pour choisir l'icône/couleur/contenu du panneau de détail
   * (topologyGraphShared.tsx#KIND_ICON), jamais en devinant depuis `subtitle`.
   */
  hostKind?: TopologyHostKind;
  /**
   * Nœuds "host" de sous-type "remote-docker" UNIQUEMENT, et seulement si ce démon distant est
   * RÉELLEMENT joignable au moment de la construction du graphe (docker.ts#getDockerHostInfo,
   * même appel que pour Environment#hostInfo) — CPU/RAM/version/conteneurs réels de cet hôte.
   * Absent si l'hôte est configuré mais injoignable : `status: "stopped"` porte alors seule
   * l'information, jamais un hostInfo mis en cache/inventé pour combler l'absence.
   */
  hostInfo?: DockerHostInfo;
  /**
   * Nœuds "iac-workspace" UNIQUEMENT (voir services/iac/workspaces.ts, getIacWorkspaceNodes ci-
   * dessous côté topology.ts) : moteur réel du workspace — détermine les actions proposées par le
   * frontend (mêmes que ENGINE_ACTIONS, services/iac/runner.ts) et son icône.
   */
  iacEngine?: IacEngine;
  /**
   * Nœuds "iac-workspace" UNIQUEMENT : statut PRÉCIS du DERNIER run réel de ce workspace (voir
   * services/iac/runner.ts#listRuns), `null` si ce workspace n'a jamais été exécuté — jamais
   * inventé. `status` ci-dessus en est une projection sur les 4 valeurs génériques du graphe
   * (jamais exécuté -> "neutral" ; "running" -> "restarting" [run en cours] ; "success" ->
   * "running" ; "failed" -> "stopped") ; ce champ porte l'information exacte pour le panneau de
   * détail (topologyGraphShared.tsx ne peut pas la redériver depuis les 4 valeurs génériques).
   */
  iacLastRunStatus?: IacRunStatus | null;
  /**
   * Volumes/networks uniquement : `true` si cette ressource n'est actuellement rattachée à AUCUN
   * conteneur (voir services/topology.ts § "Volumes/networks ORPHELINS") — reste un vrai nœud
   * top-level mais SANS AUCUNE arête (aucun conteneur ne la référence, il n'y a structurellement
   * rien à relier). Absent/`false` pour toute ressource utilisée par ≥1 conteneur, et toujours
   * absent pour les autres kinds. Le frontend s'en sert pour un rendu atténué (topologyGraphShared.
   * tsx) plutôt qu'un statut/badge fabriqué.
   */
  orphan?: boolean;
  /**
   * Nœuds "automation-trigger" UNIQUEMENT (voir services/automationStore.ts,
   * services/automationEngine.ts) : ce que ce déclencheur surveille réellement — soit un autre
   * TopologyNode déjà existant sur le graphe, soit une route de reverse proxy. Jamais une
   * nouvelle métrique inventée : le moteur relit l'état déjà calculé ailleurs (topology.ts pour
   * un nœud, une VRAIE sonde TCP pour une route).
   */
  automationTriggerConfig?: AutomationTriggerConfig;
  /**
   * Nœuds "automation-condition" UNIQUEMENT : condition minimale v1 — laisse passer la chaîne si
   * la valeur amont est "en échec", ou l'inverse (bloque) si `true`. Pas de moteur de règles
   * complexe dans ce premier lot.
   */
  automationConditionInvert?: boolean;
  /**
   * Nœuds "automation-action" UNIQUEMENT : action RÉELLEMENT exécutée par le moteur sur
   * transition du déclencheur amont vers l'échec (voir services/automationEngine.ts) — appelle
   * toujours une fonction de service déjà existante ailleurs dans QUAI, jamais un nouvel effet
   * de bord.
   */
  automationActionConfig?: AutomationActionConfig;
  /**
   * Nœuds "automation-trigger" UNIQUEMENT : horodatage ISO de la dernière fois où ce déclencheur a
   * RÉELLEMENT exécuté sa chaîne d'actions (transition ok/unknown -> failing, voir
   * services/automationEngine.ts#evaluateTrigger) — `null` tant qu'aucune action n'a encore été
   * déclenchée depuis le démarrage du process. Distinct du simple fait d'avoir été évalué : le
   * moteur évalue CHAQUE trigger à CHAQUE cycle (~30s), mais ne déclenche la chaîne que sur cette
   * transition précise — afficher l'horodatage de la dernière évaluation serait quasi toujours
   * "il y a 30s" et n'informerait de rien d'utile pour l'administrateur.
   */
  automationLastFired?: string | null;
  /**
   * Nœuds "automation-trigger" UNIQUEMENT : dernier état RÉEL observé par le moteur au dernier
   * cycle ("failing" = source en échec, "ok" = source saine, "unknown" = jamais encore évalué).
   */
  automationLastStatus?: "ok" | "failing" | "unknown";
  /**
   * Conteneurs uniquement : limites RÉELLEMENT configurées (`HostConfig.Memory`/`HostConfig.
   * NanoCpus`, voir services/docker.ts#ContainerHealthAndLimits, même valeurs que ContainerDetail#
   * memoryLimitBytes/nanoCpus) — absentes si aucune limite n'a été fixée à la création (0 côté
   * Docker = pas de limite, jamais traduit en 0 ici). Alimente la carte flottante d'alerte
   * "Mémoire élevée" du graphe (topologyGraphShared.tsx) : ne se déclenche QUE si une limite
   * réelle existe, jamais un seuil absolu inventé en son absence — même principe que l'alerte CPU
   * déjà existante (CPU_ALERT_THRESHOLD_PERCENT), qui elle n'a besoin d'aucune limite réelle
   * puisque cpuPercent a un plafond naturel implicite (100% par cœur).
   */
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

// --- Moteur d'automatisation (trigger -> condition -> action), façon n8n mais câblé UNIQUEMENT
// sur les capacités RÉELLES déjà existantes de QUAI — voir apps/api/src/services/automationStore.ts
// et apps/api/src/services/automationEngine.ts. Un "trigger" surveille l'état RÉEL déjà calculé
// ailleurs (un TopologyNode existant, ou une VRAIE sonde TCP d'une route de reverse proxy) ; une
// "condition" est un NON logique minimal (v1, pas un moteur de règles) ; une "action" appelle
// toujours une fonction de service DÉJÀ existante (cron job, notification, action conteneur) —
// jamais une nouvelle implémentation d'effet de bord.

/** Ce qu'un nœud "automation-trigger" surveille réellement — v1 : soit un AUTRE TopologyNode déjà
 * existant sur le graphe (conteneur/host/vm nutanix/ad-server — évalué via son `status`/`healthStatus`
 * déjà calculés par services/topology.ts, jamais une nouvelle métrique inventée), soit une route de
 * reverse proxy (évaluée via une VRAIE sonde de joignabilité de son upstream, voir plus bas). */
export type AutomationTriggerSource =
  | { kind: "topology-node"; nodeId: string } // ex: "container:<id>", "host:nutanix-cluster:<uuid>"
  | { kind: "reverse-proxy-route"; routeId: string };

export interface AutomationTriggerConfig {
  source: AutomationTriggerSource;
}

/** Action RÉELLEMENT exécutée — chacune appelle une fonction de service DÉJÀ existante dans QUAI,
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
  /**
   * "hosts" : relation RÉELLE cluster Nutanix -> VM qu'il héberge (rapprochée par uuid de cluster,
   * `NutanixVm#clusterUuid` — jamais construite si ce uuid n'est pas déterminable ou ne correspond
   * à aucun cluster réellement listé). Nœud "host" (source) -> nœud "nutanix-vm" (target), sans
   * port/badge (pas de notion de trafic ici, juste une hiérarchie physique) — voir
   * services/topology.ts et topologyGraphShared.tsx#buildTopologyEdges.
   */
  /**
   * "automation-flow" : arête RÉELLE entre deux nœuds d'automatisation (trigger -> condition,
   * trigger -> action, condition -> action — voir services/automationStore.ts,
   * services/automationEngine.ts) : simple lien de flux, sans port/badge (même sobriété que
   * "hosts" ci-dessus).
   */
  kind: "mount" | "network" | "hosts" | "automation-flow";
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
  /**
   * Ids RÉELS regroupés — toujours >= 2 (voir topologyGroupsStore.ts#createGroup) : soit l'id d'un
   * vrai TopologyNode existant dans le graphe actuel (ex "container:<id>"), soit l'id d'un AUTRE
   * TopologyGroup déjà existant (ex "group:<uuid>") — groupes imbriqués (13/08/2026) : un groupe
   * peut légitimement contenir d'autres groupes, jusqu'à 5 niveaux de profondeur et 256 vrais
   * TopologyNode transitivement atteignables au total (voir topologyGroupsStore.ts#createGroup,
   * CyclicGroupError/MaxGroupDepthExceededError/MaxGroupSizeExceededError). Jamais un id inventé ;
   * un membre (nœud OU groupe) ne peut jamais être déjà membre d'un AUTRE groupe à la fois — cette
   * règle-là reste vraie même pour un sous-groupe : il ne peut avoir qu'un seul parent.
   */
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

// --- Fichiers réels d'un paquet vulnérable dans une image (voir
// apps/api/src/services/packageInspector.ts, GET /api/images/:id/packages/:packageName/files) ---
// Complète scan.ts : Grype/OSV-Scanner rapportent un `Vulnerability#packageName` mais jamais SES
// fichiers réels dans l'image. Ce module retrouve cette information EN INSPECTANT RÉELLEMENT
// l'image (`docker run --rm --entrypoint sh <image> -c "..."`, jamais une supposition sur la
// présence d'un outil sans l'avoir testé) : apt/dpkg, npm (node_modules), pip, dans cet ordre,
// en s'arrêtant à la première stratégie qui trouve réellement quelque chose.
//
// Honnêteté : un paquet Go (chemin de module type "github.com/...") ou un crate Rust compilé
// n'a JAMAIS de code source récupérable dans l'image finale (compilé statiquement dans le
// binaire) — `available: false` avec un `reason` concret dans ce cas, JAMAIS un `files: []` qui
// laisserait croire à tort à un paquet réellement vide plutôt qu'à une impossibilité technique.

export type PackageEcosystem = "apt" | "npm" | "pip" | "unknown";

export interface PackageFilesResult {
  ecosystem: PackageEcosystem;
  available: boolean;
  /** Message honnête et concret expliquant pourquoi `available` est false (ou une précision sur
   * la résolution, ex: nom de paquet Debian réel utilisé s'il diffère du nom Grype/OSV d'origine)
   * — absent si tout s'est bien passé sans rien à préciser. */
  reason?: string;
  /** Chemins réels à l'intérieur de l'image — absent/vide si `available` est false. */
  files?: string[];
  /** Racine réelle sous laquelle `files` a été trouvé (ex: "node_modules/<pkg>" pour npm,
   * `Location:` de `pip show` pour pip) — absent pour apt (dpkg -L liste des chemins dispersés
   * sous /usr, /etc, /lib... : aucune racine unique n'existe pour un paquet système). */
  packageRoot?: string;
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
  | "vulnerability_detected"
  // Émis par une action "send-notification" du moteur d'automatisation (voir
  // services/automationEngine.ts) sur transition RÉELLE d'un trigger vers l'échec — jamais
  // persisté dans le journal de notifications système (envoi direct au canal choisi, même
  // principe que le test de canal, voir notificationDispatch.ts#sendChannelNotification), mais
  // partage la même forme d'événement pour rester cohérent avec les autres kinds.
  | "automation_triggered";

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
 * Un emplacement (racine ou sous-dossier) où quelque chose de déployable a été trouvé lors du
 * parcours borné de sous-dossiers (voir services/github.ts#scanSubfoldersForCandidates) —
 * uniquement peuplé quand la racine elle-même n'a RIEN (voir GithubRepoDetection#candidates
 * ci-dessous). Résumé volontairement superficiel (pas de exposedPort/composeServices ici) : le
 * détail complet n'est calculé qu'une fois un candidat précis choisi explicitement par
 * l'utilisateur (nouvel appel à GET .../detect?path=..., voir GitHubDeployPage.tsx).
 */
export interface GithubDetectionCandidate {
  /** Chemin relatif depuis la racine du dépôt, SANS "/" final (ex: "docker", "apps/api"). */
  path: string;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[];
  hasAnsible: boolean;
}

/** Un service docker-compose candidat pour recevoir la route de sous-domaine — services qui ne
 * déclarent AUCUN port (`ports:`/`expose:`) ne sont jamais candidats (base de données interne
 * typique, jamais routable en HTTP). Voir services/github.ts#parseComposeServiceCandidates. */
export interface GithubComposeServiceCandidate {
  name: string;
  /** Port CONTENEUR (jamais le port hôte — Caddy connecte directement le conteneur sur le réseau
   * docker, voir services/reverseProxy.ts) du premier port déclaré pour ce service — absent si
   * indéterminable depuis le YAML (ex: variable d'environnement non résolue dans le mapping). */
  port?: number;
}

/**
 * GET /api/github/repos/:owner/:repo/detect — résumé honnête de ce qui est réellement présent à
 * la racine du repo, ou dans le sous-dossier explicitement demandé (`?path=`), ou (racine vide
 * uniquement) dans l'unique sous-dossier candidat trouvé par un parcours BORNÉ (2-3 niveaux, voir
 * services/github.ts#scanSubfoldersForCandidates) — un repo sans aucun de ces fichiers ne doit
 * jamais faire remonter un booléen à `true`.
 */
export interface GithubRepoDetection {
  ref: string; // branche/commit effectivement inspecté (résolu à la branche par défaut si omis)
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[]; // noms de fichiers *.tf trouvés à l'emplacement retenu
  hasAnsible: boolean;
  /** Nom du fichier playbook trouvé ("playbook.yml"/"site.yml"/variantes .yaml) — absent si hasAnsible est false. */
  ansiblePlaybook?: string;
  /** Dernière instruction EXPOSE trouvée dans le Dockerfile de l'emplacement retenu (lecture réelle du
   * contenu du fichier via l'API Contents GitHub) — absent si aucun Dockerfile ou aucune
   * instruction EXPOSE, jamais une valeur devinée par convention. Pré-remplit le champ "port"
   * du formulaire de déploiement (voir GitHubDeployPage.tsx), toujours éditable. */
  exposedPort?: number;
  /** Services docker-compose candidats pour le sous-domaine (voir GithubComposeServiceCandidate)
   * — absent/vide si hasCompose est false ou si aucun service ne déclare de port. Un seul élément
   * -> sélection automatique côté déploiement ; plusieurs -> l'utilisateur doit choisir
   * explicitement (`serviceForSubdomain`, voir POST .../deploy), jamais deviné silencieusement. */
  composeServices?: GithubComposeServiceCandidate[];
  /** Sous-dossier effectivement inspecté pour produire CE résumé (ex: "docker") — absent quand
   * c'est la racine (comportement historique inchangé). À repasser tel quel comme `configPath`
   * à POST .../deploy pour que le déploiement réel utilise le MÊME emplacement que celui inspecté ici. */
  detectedPath?: string;
  /** Plusieurs emplacements candidats trouvés à des endroits DIFFÉRENTS (racine vide, parcours de
   * sous-dossiers) — aucun n'a été choisi automatiquement, l'utilisateur doit trancher
   * explicitement (voir GitHubDeployPage.tsx, un simple choix dans une liste). Quand ce champ est
   * présent, tous les booléens ci-dessus valent `false`/vide : rien n'est encore résolu. Absent
   * si un seul emplacement a été retenu (racine, ou unique candidat de sous-dossier).
   */
  candidates?: GithubDetectionCandidate[];
}

/**
 * "needs-config" (14/08/2026) : le clone/la détection ont trouvé des variables d'environnement
 * requises SANS valeur résolue (voir DeployConfigSchema/GithubDeployment#missingConfigKeys) — le
 * déploiement s'arrête PROPREMENT avant tout `docker build`/`docker compose up`, jamais un échec
 * `docker compose` brut ("env file ... not found"). Distinct de "failed" : ce n'est pas une erreur,
 * c'est une étape "configuration requise" que le frontend affiche différemment (formulaire à
 * remplir plutôt qu'un journal d'échec), voir GitHubDeployPage.tsx.
 */
export type GithubDeploymentStatus = "running" | "success" | "failed" | "needs-config";

/**
 * "docker-build-run" : Dockerfile détecté (seul, ou prioritaire) -> vrai `docker build` + `docker
 * run` sur la cible.
 * "docker-compose" : docker-compose.yml/compose.yml détecté -> vrai `docker compose -p <projet
 * isolé> up -d --build` sur la cible (voir services/github.ts#deployViaDockerCompose). PRIORITAIRE
 * sur un Dockerfile isolé quand les deux sont présents au même emplacement : un docker-compose.yml
 * référence le plus souvent ce même Dockerfile (`build: .`) tout en décrivant en plus la topologie
 * complète voulue par le mainteneur (services dépendants, volumes, réseau, variables d'env) —
 * c'est un sur-ensemble strict d'un déploiement Dockerfile seul, jamais l'inverse (même logique que
 * Railway/Render : la présence d'un compose signale une intention multi-service explicite).
 * "iac-workspace" : *.tf (Terraform/OpenTofu) OU un playbook Ansible détecté, sans Dockerfile ni
 * compose -> workspace IaC créé (voir services/iac/), aucun "apply"/"ansible-playbook" automatique
 * — reporté à une action explicite ultérieure de l'utilisateur. Terraform et Ansible partagent ce
 * même kind (même mécanisme de suivi, moteur distingué par IacWorkspace#engine).
 * null tant que le clone/la détection n'a pas encore déterminé la voie suivie (déploiement
 * encore "running").
 */
export type GithubDeploymentKind = "docker-build-run" | "docker-compose" | "iac-workspace";

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
  /** Conteneur ayant reçu la route reverse-proxy de sous-domaine : LE conteneur unique pour un
   * déploiement "docker-build-run", ou le conteneur du service choisi/déduit pour un déploiement
   * "docker-compose" (voir serviceForSubdomain) — absent si aucun sous-domaine demandé/réussi, ou
   * kind "iac-workspace" (pas de conteneur applicable). */
  containerId?: string;
  containerName?: string;
  iacWorkspaceId?: string; // kind "iac-workspace" (Terraform ou Ansible, voir GithubDeploymentKind)
  /** kind "docker-compose" uniquement : nom du projet compose isolé (`docker compose -p`)
   * effectivement utilisé — dérivé de l'id de ce déploiement (voir sanitizeDockerName), jamais en
   * collision avec un autre déploiement compose sur ce même hôte Docker. Sert aussi à retrouver ce
   * déploiement pour l'arrêter proprement (`down`) avant un redéploiement du même dépôt. */
  composeProjectName?: string;
  /** kind "docker-compose" uniquement : noms des conteneurs RÉELLEMENT créés par `docker compose up`
   * (un par service défini dans le docker-compose.yml) — pour affichage, jamais une liste déduite du
   * seul contenu YAML (qui peut différer du résultat réel en cas d'échec partiel). */
  composeServices?: string[];
  /** Sous-dossier du dépôt utilisé pour la détection ET le déploiement réel (voir
   * GithubRepoDetection#detectedPath) — absent si racine (comportement historique inchangé). Rejoué
   * tel quel par un redéploiement (voir TopologyNodeDetailPanel.tsx#handleRedeployFromGithub) pour
   * cibler le même emplacement, jamais une racine par défaut qui serait fausse pour ce dépôt. */
  configPath?: string;
  /** Sous-domaine demandé pour ce déploiement (reverse proxy interne), s'il y en a un — voir
   * GitHubDeployPage.tsx. Présent même si la route n'a en fin de compte pas pu être créée
   * (ex: aucun port EXPOSE détecté ni fourni) : reverseProxyRouteId distingue les deux cas. */
  subdomain?: string;
  /** id de la route reverse-proxy (services/reverseProxy.ts) effectivement créée pour ce
   * déploiement — absent si aucun sous-domaine demandé, ou si la création a échoué (voir le log
   * du déploiement pour le détail dans ce dernier cas, jamais une route fantôme inventée ici). */
  reverseProxyRouteId?: string;
  /** status "needs-config" UNIQUEMENT : clés d'environnement requises encore sans valeur résolue
   * qui ont bloqué ce déploiement (voir DeployConfigSchema#missingRequiredKeys ci-dessous) —
   * l'utilisateur les renseigne via PUT .../config-values puis relance le MÊME déploiement (bouton
   * "Redéployer") : les valeurs fournies sont alors résolues automatiquement, sans re-demander. */
  missingConfigKeys?: string[];
}

/** GithubDeployment + le log complet (clone + build + run entrelacés) — chargé à la demande, même principe que IacRunDetail. */
export interface GithubDeploymentDetail extends GithubDeployment {
  log: string;
  /** status "failed" UNIQUEMENT : diagnostic(s) structuré(s) extraits du log complet par le moteur
   * générique de reconnaissance de motifs d'erreurs (voir services/deploymentDiagnostics.ts) —
   * calculé À LA DEMANDE à chaque lecture (jamais persisté), donc toujours cohérent avec le log
   * actuel. Absent pour tout autre statut. [] n'arrive jamais : au moins un diagnostic "unknown"
   * honnête est toujours renvoyé si aucun motif connu n'a matché — jamais un tableau vide qui
   * laisserait croire à une absence d'analyse. */
  diagnostics?: DeploymentDiagnostic[];
}

// --- Diagnostic générique des échecs de déploiement (retour utilisateur réel, 14/08/2026 : "un
// systeme si le build echoue... generer un rapport visible et claire detecte tout ce qui ne vas
// pas... puissant systeme generique") — voir apps/api/src/services/deploymentDiagnostics.ts.
// Moteur de RECONNAISSANCE DE MOTIFS sur le log brut existant (jamais une réimplémentation d'un
// vrai linter/compilateur) : chaque motif reconnu produit un diagnostic humain actionnable ; aucun
// motif reconnu -> un diagnostic honnête "cause non reconnue automatiquement", jamais une
// supposition plausible mais fausse.

export type DeploymentDiagnosticCategory =
  | "missing-header" // ex: "fatal error: ldap.h: No such file or directory" — paquet -dev manquant
  | "missing-dependency" // composer/npm/pip : paquet introuvable/non résolu
  | "image-not-found" // docker pull 401/404/"manifest unknown"
  | "syntax-error" // YAML compose / HCL Terraform invalide
  | "dependency-failed" // un service compose démarre mais un AUTRE dont il dépend (depends_on
  // condition: service_healthy) échoue/ne devient jamais sain — cas réel rencontré le 14/08/2026
  // (mairie-creusot/formulaire_hotline : service "db" MySQL sorti en erreur juste après démarrage)
  | "port-conflict" // ne devrait normalement plus jamais atteindre ce diagnostic (géré en amont),
  // reconnu quand même par cohérence si un cas limite l'a laissé passer jusqu'ici
  | "missing-config" // idem : géré en amont (status "needs-config"), reconnu par cohérence
  | "unknown"; // repli honnête : aucun motif connu n'a matché, jamais un diagnostic inventé

export interface DeploymentDiagnostic {
  category: DeploymentDiagnosticCategory;
  /** Titre court et humain, ex: "En-tête manquant pour compiler une extension PHP". */
  title: string;
  /** Explication de ce qui cloche probablement, en français clair. */
  explanation: string;
  /** Action concrète suggérée à l'utilisateur pour corriger le problème. */
  suggestedAction: string;
  /** Extrait du log (quelques lignes) ayant déclenché ce diagnostic — pour retrouver le contexte
   * exact dans le log complet, jamais une citation tronquée trompeuse. Absent pour "unknown". */
  evidence?: string;
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

// --- Configuration dynamique de déploiement (variables d'environnement manquantes, ports,
// volumes, ARG Dockerfile) — voir apps/api/src/services/github.ts § "Détection et résolution des
// variables d'environnement manquantes". Corrige un bug réel constaté le 14/08/2026
// (mairie-creusot/formulaire_hotline) : un docker-compose.yml référençant un fichier .env absent
// du clone frais (gitignored, jamais commité — pratique standard) faisait échouer platement
// `docker compose up` ("env file ... not found", code 14) au lieu d'une détection propre AVANT
// l'échec. GET .../config-schema calcule un résumé structuré de ce qui peut/doit être configuré
// pour CE dépôt/emplacement (jamais une vraie valeur de secret) ; PUT .../config-values enregistre
// les valeurs fournies comme un secret nommé "github-env:<owner>/<repo>" (secretsStore.ts, JSON
// multi-clé, chiffré au repos comme tout secret) réutilisé automatiquement à chaque redéploiement
// suivant — seul le tout premier déploiement d'un dépôt à variables manquantes demande une saisie.

export type EnvVarSource = "env_file" | "environment" | "dockerfile_arg";

export interface EnvVarRequirement {
  key: string;
  required: boolean;
  /** true si une valeur est déjà résolue (secret stocké, ou valeur par défaut légitime NON
   * sensible trouvée dans un .env.example/.env.sample du dépôt) — jamais la valeur elle-même. */
  hasValue: boolean;
  source: EnvVarSource;
  /** Service docker-compose concerné — absent pour "dockerfile_arg" (build sans compose). */
  service?: string;
  /** "env_file" uniquement : chemin relatif référencé par `env_file:` dans le fichier compose. */
  envFilePath?: string;
  /** Heuristique sur le NOM de la clé (PASSWORD/SECRET/TOKEN/API_KEY/DSN/...) — le frontend affiche
   * un champ masqué pour ces clés, jamais un texte en clair une fois saisi (même pattern que les
   * champs token/password des registres). */
  looksSensitive: boolean;
  /**
   * Résolution AUTOMATIQUE générique appliquée par services/github.ts (voir applyAutoResolutions)
   * — jamais un cas spécifique à un dépôt précis :
   * "db-provisioned" : QUAI a prouvé (référence `${clé}` littérale dans le MÊME compose) que cette
   * clé alimente le mot de passe d'un service base de données reconnu qu'il crée lui-même dans ce
   * déploiement — un mot de passe fort est généré et appliqué aux deux côtés via l'interpolation
   * compose native ; `hasValue` vaut alors true, rien à saisir, la valeur n'est jamais montrée.
   * "admin-seed" : clé qui ressemble à un compte admin par défaut d'une application déployée par
   * QUAI lui-même (ADMIN_DEFAULT_EMAIL/PASS...) — `hasValue` reste false (champ toujours visible/
   * éditable), voir `suggestedValue` ci-dessous.
   */
  autoResolution?: "db-provisioned" | "admin-seed";
  /** "admin-seed" uniquement : valeur PROPOSÉE à pré-remplir dans le formulaire (jamais une valeur
   * de secret préexistante — un email/mot de passe fraîchement suggéré pour un compte que QUAI
   * crée) — l'utilisateur peut la remplacer avant de valider, jamais appliquée sans qu'il la voie. */
  suggestedValue?: string;
}

export interface DeployPortRequirement {
  service?: string; // absent pour un déploiement Dockerfile seul (pas de notion de service)
  containerPort: number;
  /** Port hôte actuellement fixé dans le fichier compose, s'il y en a un — absent = Docker choisit
   * lui-même un port hôte libre (comportement historique inchangé), voir pickFreeHostPort. */
  hostPort?: number;
  /** true = surchargeable via `composePortOverrides` (POST .../deploy) — toujours true dans ce
   * premier lot (voir services/github.ts#applyComposeHostPortOverrides), champ conservé pour une
   * future restriction honnête plutôt qu'une supposition côté frontend. */
  overridable: boolean;
}

/** Lecture seule dans ce premier lot (voir mission) : affichée pour information, aucune route
 * d'édition ne consomme ce type — un montage de volume touche à des données potentiellement
 * existantes sur l'hôte, une édition à l'aveugle serait plus risquée qu'utile pour ce lot. */
export interface DeployVolumeInfo {
  service?: string;
  source: string;
  target: string;
  readOnly: boolean;
}

/**
 * GET /api/github/repos/:owner/:repo/config-schema — ce qui peut/doit être configuré pour CE
 * dépôt/emplacement avant déploiement, jamais une valeur de secret réelle. `envVars` ne liste QUE
 * les clés dont la valeur n'est PAS déjà résolue dans le fichier lui-même (une valeur littérale
 * dans `environment:`/compose n'a rien à demander) — voir services/github.ts#buildEnvRequirements.
 */
export interface DeployConfigSchema {
  owner: string;
  repo: string;
  ref: string;
  configPath?: string;
  envVars: EnvVarRequirement[];
  /** Raccourci pratique : clés requises sans valeur résolue — [] si tout est déjà prêt à déployer. */
  missingRequiredKeys: string[];
  ports: DeployPortRequirement[];
  volumes: DeployVolumeInfo[];
  /** Présent seulement si au moins un `env_file:` référence un fichier introuvable dans le dépôt ET
   * qu'aucun .env.example/.env.sample n'a été trouvé pour en déduire les clés attendues — limite
   * honnête où QUAI ne peut proposer aucun champ pour ce fichier précis (voir services/github.ts). */
  unresolvableEnvFile?: string;
}

// --- Surcharge du CONTENU de fichiers détectés au moment du build/déploiement (retour
// utilisateur réel, 14/08/2026 : "fait en sorte qu'ont puisse overide le dockerfile et les autre
// fichier de conf au moment du build") — voir apps/api/src/services/githubFileOverridesStore.ts.
// Corrige un problème ponctuel (ex: Dockerfile réellement buggé) SANS forker/committer sur le vrai
// dépôt : le fichier réellement utilisé pour build/déployer est TOUJOURS l'original du clone SAUF
// si une surcharge existe pour ce chemin exact, auquel cas elle le remplace ENTIÈREMENT (jamais un
// patch/diff partiel). Stocké EN CLAIR (non chiffré, contrairement aux secrets) — ces fichiers
// n'ont pas vocation à être des secrets et doivent rester consultables, voir le store pour la
// décision documentée.

export type OverridableFileKind = "dockerfile" | "compose" | "terraform" | "ansible-playbook" | "ansible-inventory";

/** Un fichier réellement détecté (voir GithubRepoDetection) et potentiellement surchargeable —
 * alimente le sélecteur "Fichiers" du formulaire de configuration. */
export interface OverridableFileRef {
  /** Chemin relatif au dépôt (incluant le sous-dossier détecté éventuel), ex: "Dockerfile",
   * "docker/docker-compose.yml", "main.tf". */
  path: string;
  kind: OverridableFileKind;
  /** true si une surcharge est ACTUELLEMENT active pour ce chemin exact sur ce dépôt. */
  hasOverride: boolean;
}

/** GET .../file-overrides — surcharge active pour un chemin donné, contenu INCLUS (ce contrat
 * n'est jamais write-only, contrairement aux secrets : voir githubFileOverridesStore.ts). */
export interface GithubFileOverride {
  path: string;
  content: string;
  updatedAt: string; // ISO 8601
  updatedBy: string; // username
}

/** GET .../file-content — contenu d'UN fichier, soit l'original du dépôt (API Contents GitHub),
 * soit la surcharge active — jamais les deux mélangés (voir `source` demandé par le client). */
export interface GithubFileContent {
  path: string;
  content: string;
  source: "original" | "override";
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
