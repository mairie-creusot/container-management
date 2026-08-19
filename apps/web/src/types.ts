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
  // Organisation GitHub (ghcr) ou namespace/compte (dockerhub) explicitement configuré —
  // indépendant de `username` (identité de connexion). Pas un secret. Voir ARCHITECTURE.md.
  org?: string;
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
// ca/cert/key/password/privateKey ne transitent jamais par ce contrat (write-only), seuls
// `hasTls`/`hasSshCredentials` indiquent leur présence.

/** Deux transports vers le démon Docker distant — voir remoteDockerStore.ts en-tête pour le
 * détail complet. "tcp-tls" : host/port du démon exposé directement (TCP+TLS classique).
 * "ssh" : host/port SSH déjà ouvert pour l'admin de la machine, Docker tunnelisé au travers —
 * aucun port Docker exposé sur le réseau (cas typique : VPS joignable uniquement en SSH). */
export type RemoteDockerTransport = "tcp-tls" | "ssh";

export interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  // Absent sur les environnements créés avant l'introduction du transport SSH : traiter comme
  // "tcp-tls" (comportement historique, voir remoteDockerStore.ts#toRef) — optionnel ici pour
  // ne pas casser un composant qui ne connaîtrait pas encore ce champ, mais toujours présent en
  // pratique depuis la réponse actuelle de l'API.
  transport: RemoteDockerTransport;
  hasTls: boolean;
  /** transport "ssh" uniquement — le login n'est pas un secret. */
  sshUsername?: string;
  hasSshCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteDockerTestResult {
  ok: boolean;
  message: string;
}

/** Un disque réel d'une VM Nutanix — voir apps/api/src/types.ts#NutanixVmDisk. `deviceType` vaut
 * "DISK"/"CDROM" en pratique (valeur brute Prism Central, jamais traduite). */
export interface NutanixVmDisk {
  uuid?: string;
  deviceType: string;
  sizeBytes?: number;
}

/** Une interface réseau réelle d'une VM Nutanix, VLAN/subnet déjà résolus côté API — voir
 * apps/api/src/types.ts#NutanixVmNetwork. */
export interface NutanixVmNetwork {
  subnetUuid?: string;
  subnetName?: string;
  vlanId?: number;
  ips: string[];
}

/** Un subnet réel (uuid/nom/VLAN) — GET /api/nutanix/subnets, pour le sélecteur "Ajouter une
 * carte réseau" (voir apps/api/src/services/nutanix.ts#getNutanixSubnets). */
export interface NutanixSubnetSummary {
  uuid: string;
  name: string;
  vlanId?: number;
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
  /** uuid réel de l'hôte physique AHV qui exécute ACTUELLEMENT cette VM — recalculé à chaque poll
   * (jamais figé, une VM peut migrer d'un hôte à l'autre en live migration). */
  hostUuid?: string;
  /** Nom réel de l'hôte (résolu côté API, PAS l'IP brute de host_reference.name). */
  hostName?: string;
  /** true si `hostUuid` vient du placement CONSTATÉ en direct (status.resources.host_reference) ;
   * false si repli sur le dernier hôte ASSIGNÉ/déclaré (spec.resources.host_reference, pas
   * confirmé en direct) — absent dans les mêmes conditions que `hostUuid`. Voir
   * apps/api/src/services/nutanix.ts#mapVmEntity. */
  hostPlacementConfirmed?: boolean;
  disks?: NutanixVmDisk[];
  networks?: NutanixVmNetwork[];
  /** true si Prism Central rapporte un VRAI état d'erreur pour cette VM (status.state === "ERROR",
   * distinct du power_state — jamais vrai pour un simple arrêt volontaire). Voir
   * apps/api/src/services/nutanix.ts#mapVmEntity. */
  apiError?: boolean;
  apiErrorMessage?: string;
}

/** Une image disque/ISO réelle du catalogue Prism Central — GET /api/nutanix/images. */
export interface NutanixImageSummary {
  uuid: string;
  name: string;
  sizeBytes?: number;
  imageType?: string;
}

/** POST /api/nutanix/vms — `guestCustomization.password`/`sshAuthorizedKey` sont write-only.
 * Exactement l'un des deux : `imageUuid` (clone d'image disque, déploiement classique) OU
 * `isoImageUuid` (template base "iso" en installation MANUELLE : disque système vide de
 * `diskSizeMib` requis + CD-ROM sur l'ISO, pas de guestCustomization — l'OS n'est pas encore
 * installé ; un ISO en installation automatisée se déploie depuis l'image construite via
 * `imageUuid`). */
export interface NutanixVmCreateInput {
  name: string;
  imageUuid?: string;
  isoImageUuid?: string;
  subnetUuid: string;
  numVcpus: number;
  numCoresPerVcpu?: number;
  memoryMib: number;
  diskSizeMib?: number;
  guestCustomization?: {
    hostname?: string;
    username: string;
    password?: string;
    sshAuthorizedKey?: string;
  };
}

/** GET /api/nutanix/tasks/:uuid — `status` brut Prism Central (RUNNING/SUCCEEDED/FAILED...),
 * projeté côté client par templateCatalog.ts#nutanixTaskOutcome, jamais traduit ici. */
export interface NutanixTaskStatus {
  uuid: string;
  status: string;
  percentageComplete?: number;
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

/**
 * Détail enrichi d'UN process RÉEL en cours d'exécution DANS le conteneur cible — voir GET
 * /api/containers/:id/processes/detailed (apps/api/src/services/containerInternals.ts).
 * Contrairement à ContainerProcessList ci-dessus (docker top, PID côté HÔTE), `pid`/`ppid` ici
 * sont lus DEPUIS `/proc` À L'INTÉRIEUR du conteneur cible : ce sont les PID tels que le
 * conteneur se voit lui-même — les SEULS utilisables pour inspecter/tuer/relancer un process
 * (voir ContainerProcessInspection plus bas), jamais les PID hôte de ContainerProcessList.
 */
export interface ContainerProcessDetail {
  pid: number;
  ppid: number;
  /** Nom résolu depuis /etc/passwd si lisible (best-effort) ; sinon l'uid numérique brut en
   * chaîne — jamais un nom fabriqué. */
  user: string;
  /** `comm` tel que rapporté par /proc/<pid>/stat — peut contenir espaces/parenthèses. */
  command: string;
  /** Code d'état process brut (`man 5 proc`, ex: "S", "R", "Z"...), jamais traduit/deviné. */
  state: string;
  /** Temps CPU cumulé RÉEL (utime+stime) en millisecondes. */
  cpuTimeMs: number;
  /** Âge réel du process en secondes (uptime système - starttime du process). */
  ageSeconds: number;
  /** Ports RÉELLEMENT en LISTEN possédés par ce process — absent si aucun. Sert de "carte réseau
   * interne" (aucune route réseau séparée n'existe côté API, voir TopologySubGraphPanel.tsx). */
  listenPorts?: number[];
}

/** Voir GET /api/containers/:id/processes/detailed. `shellAvailable: false` (processes toujours
 * []) signifie qu'aucun shell POSIX (`sh`) n'a pu être exécuté dans le conteneur cible (image
 * "distroless"/scratch typiquement) — à distinguer explicitement côté UI d'une liste vide
 * silencieuse qui laisserait croire qu'aucun processus ne tourne. */
export interface ContainerProcessDetailList {
  processes: ContainerProcessDetail[];
  shellAvailable: boolean;
}

/**
 * cmdline/environ/fichiers ouverts RÉELS d'UN process précis, lus DEPUIS `/proc/<pid>` À
 * L'INTÉRIEUR du conteneur cible — voir GET /api/containers/:id/processes/:pid/inspect. `pid`
 * suit la même numérotation que ContainerProcessDetail ci-dessus (namespace PID du conteneur),
 * PAS celle de ContainerProcessList (docker top, PID hôte).
 */
export interface ContainerProcessInspection {
  pid: number;
  /** Ligne de commande RÉELLE (/proc/<pid>/cmdline, champs déjà séparés) — toujours présente si
   * le process existe encore. */
  cmdline: string[];
  /** Variables d'environnement RÉELLES (/proc/<pid>/environ) — absent si le noyau a refusé la
   * lecture pour CE process précis (permission refusée) : jamais un objet vide fabriqué. */
  environ?: Record<string, string>;
  /** Cibles réelles des descripteurs de fichier ouverts (/proc/<pid>/fd/*) — chemins réels, ou
   * `socket:[inode]`/`pipe:[inode]`. Mêmes conditions d'absence qu'`environ` ci-dessus. */
  openFiles?: string[];
  /** true si `environ` et/ou `openFiles` a dû être omis faute de permission — honnêteté
   * explicite plutôt qu'un échec silencieux ; `cmdline` reste fiable dans tous les cas. */
  partial?: boolean;
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
  | "automation-action"
  | "image-template"
  // Appliance HYCU (contrôleur de sauvegarde des VMs Nutanix) — kind à part, jamais un `hostKind`
  // de "host" : elle protège des VMs, elle n'en héberge aucune. Voir apps/api/src/types.ts.
  | "hycu-appliance";

/** Sous-type d'un nœud "host" — voir TopologyNode#hostKind ci-dessous et
 * apps/api/src/services/topology.ts. Champ explicite plutôt qu'une convention dans `subtitle`. */
/** "nutanix-host" (14/08/2026) : hôte physique AHV réel — niveau intermédiaire entre "nutanix-
 * cluster" (le cluster tout entier) et les VMs qu'il héberge, voir apps/api/src/services/
 * topology.ts#getNutanixTopologyParts. */
/** "quai-master" : nœud racine unique "QUAI" ; "docker-env" : le démon Docker local. */
export type TopologyHostKind = "quai-master" | "docker-env" | "nutanix-cluster" | "nutanix-host" | "remote-docker" | "lxc";

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
  /** VM Nutanix uniquement : nom réel de l'hôte physique AHV qui l'exécute ACTUELLEMENT — recalculé
   * à chaque rafraîchissement du graphe, absent si la VM est éteinte ou si Prism Central n'a pas
   * renvoyé host_reference. Voir apps/api/src/types.ts#TopologyNode#nutanixHostName. */
  nutanixHostName?: string;
  /** VM Nutanix uniquement : true = placement CONSTATÉ en direct (status.resources.host_reference) ;
   * false = repli sur le dernier hôte ASSIGNÉ/déclaré (spec.resources.host_reference, pas confirmé
   * en direct). Absent dans les mêmes conditions que `nutanixHostName`. Consommé par
   * topologyGraphShared.tsx pour la couleur/le pointillé d'une arête "hosts" hôte -> VM (vert
   * "confirmé" vs orange "incertain") — voir apps/api/src/types.ts#TopologyNode pour le détail
   * complet. */
  nutanixHostPlacementConfirmed?: boolean;
  /** VM Nutanix uniquement : disques réels — voir apps/api/src/types.ts#NutanixVmDisk. */
  nutanixDisks?: NutanixVmDisk[];
  /** VM Nutanix uniquement : interfaces réseau réelles (VLAN/subnet/IP résolus) — voir
   * apps/api/src/types.ts#NutanixVmNetwork. */
  nutanixNetworks?: NutanixVmNetwork[];
  /** VM Nutanix uniquement : true si Prism Central rapporte un VRAI état d'erreur (status.state ===
   * "ERROR"), DISTINCT d'une VM simplement éteinte — jamais déduit du power_state. Mappé sur la
   * couleur rouge ("unhealthy") d'une arête "hosts" hôte -> VM. Voir apps/api/src/types.ts#
   * TopologyNode pour le détail complet. */
  nutanixApiError?: boolean;
  nutanixApiErrorMessage?: string;
  /** Nœuds "host" de sous-type "nutanix-host" uniquement : capacité RÉELLE rapportée par Prism
   * Central — PAS d'utilisation courante (%CPU/mem, non exposée par cet endpoint), absente plutôt
   * qu'une valeur à 0 qui laisserait croire à une vraie mesure. */
  nutanixHostCpuModel?: string;
  nutanixHostNumCpuCores?: number;
  nutanixHostNumCpuSockets?: number;
  nutanixHostMemoryCapacityMib?: number;
  nutanixHostHypervisorFullName?: string;
  /** Nœud "hycu-appliance" uniquement : compteurs RÉELS du dernier poll HYCU réussi — tous absents
   * si l'appliance est configurée mais injoignable (status "stopped" seul), jamais des zéros. */
  hycuVmTotal?: number;
  hycuProtectedVmCount?: number;
  hycuPolicyCount?: number;
  hycuTargetCount?: number;
  hycuFailedJobCount?: number;
  /** Nœud "hycu-appliance" uniquement : dernier essai réel de poll (ISO). */
  hycuLastPollAt?: string;
  /** VMs Nutanix uniquement, et seulement si HYCU est configuré/joignable et connaît réellement
   * cette VM (rapprochement uuid, sinon nom exact non ambigu) — absent = QUAI ne sait rien de sa
   * protection, jamais interprété comme "non sauvegardée". Voir apps/api/src/types.ts. */
  hycuProtection?: HycuVmProtectionState;
  /** VMs Nutanix uniquement : dernière sauvegarde rapportée par HYCU (ISO), absente si non fournie. */
  hycuLastBackupAt?: string;
  /** VMs Nutanix uniquement : nom réel de la policy HYCU qui la protège. */
  hycuPolicyName?: string;
  /** VMs Nutanix uniquement : valeur BRUTE de complianceStatus renvoyée par HYCU, jamais traduite. */
  hycuComplianceStatus?: string;
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
  /** Nœuds "image-template" uniquement (fabrique de templates) : projection du ImageTemplate réel
   * posée par le backend topologie — absents tant qu'il ne fournit pas ce nœud (aucune donnée
   * inventée côté client). `templateKind` est optionnel et déduit de `base.type` côté backend
   * (chaîne libre, tolérée telle quelle — anciens kinds v1 compris). */
  templateKind?: string;
  templateStatus?: ImageTemplateStatus;
  /** Workspace IaC (Packer) du template — permet de réutiliser IacWorkspacePanel pour ses
   * fichiers/logs de build. */
  templateWorkspaceId?: string;
  /** Artifact du dernier build réussi — absent tant qu'aucun build n'a produit d'artifact. */
  templateArtifactType?: ImageTemplateArtifactType;
  templateArtifactReference?: string;
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
  /** "uses-artifact" : template producteur (source) -> template consommateur (target), issue d'une
   * étape "artifact" réelle de la recette — voir apps/api/src/types.ts. */
  /** "protects" : appliance HYCU (source) -> VM Nutanix qu'elle sauvegarde RÉELLEMENT (target),
   * rapprochement par uuid ou nom exact non ambigu — voir apps/api/src/types.ts. */
  kind: "mount" | "network" | "hosts" | "automation-flow" | "uses-artifact" | "protects";
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
  /** Dernier essai RÉEL de rafraîchissement de l'intégration Nutanix — absent tant que jamais
   * configuré/jamais encore pollé. `reachable: false` = CE poll a échoué (les nœuds Nutanix de
   * cette réponse sont vides pour ce cycle, jamais une valeur mise en cache) — sert à distinguer
   * "aucune VM" de "Nutanix peut-être injoignable" côté panneau "Légende" du graphe
   * (topologyGraphShared.tsx). Voir apps/api/src/types.ts#Topology pour le détail complet. */
  nutanixLastPoll?: { reachable: boolean; at: string };
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

// --- Fabrique de templates d'images (studio de recettes + déploiement en VM) -------------------
// Contrat FIGÉ v2 : les deux backends (templates + topologie) sont développés EN PARALLÈLE contre
// ces formes exactes — un 404 signifie "backend pas encore là", jamais masqué par de fausses données.

/** Base d'une recette. ISO, deux modes : `install` absent/"manual" = prêt sans build (POST
 * .../build → 400), OS installé via la console VNC ; "unattended" = installation scriptée
 * (`osFamily` REQUIS), build et étapes comme une base cloud-image (artefact nutanix-image). */
export type TemplateBase =
  | { type: "cloud-image"; distro: string; version: string; imageUrl?: string }
  | { type: "container"; image: string }
  | { type: "mkosi"; distro: "debian" | "ubuntu" | "fedora" | "arch"; release: string }
  | { type: "iso"; imageUuid: string; install?: "manual" | "unattended"; osFamily?: "debian" | "ubuntu" | "rhel" };

export type IsoInstallMode = NonNullable<Extract<TemplateBase, { type: "iso" }>["install"]>;
export type IsoOsFamily = NonNullable<Extract<TemplateBase, { type: "iso" }>["osFamily"]>;

/** Une étape ORDONNÉE de la recette — exécutée dans l'ordre du tableau `steps`.
 * `user.passwordSecretName` : NOM d'un secret QUAI existant (jamais sa valeur). */
export type TemplateStep =
  | { type: "packages"; packages: string[] }
  | { type: "script"; content: string }
  | { type: "file"; path: string; content: string; mode?: string }
  | { type: "artifact"; templateId: string; destPath: string; dockerLoad?: boolean }
  | { type: "user"; username: string; sudo?: boolean; sshAuthorizedKey?: string; passwordSecretName?: string }
  | { type: "service"; name: string; enable: boolean };

export type ImageTemplateStatus = "draft" | "building" | "ready" | "error";

/** "raw-image" : image disque brute produite par un build mkosi. */
export type ImageTemplateArtifactType = "nutanix-image" | "docker-image" | "raw-image";

export interface ImageTemplateArtifact {
  type: ImageTemplateArtifactType;
  reference: string;
}

/** Statut d'un build — même grille que IacRunStatus (les builds VM passent par Packer). */
export type ImageTemplateBuildStatus = "running" | "success" | "failed";

/** Un build réel d'un template — GET /api/templates/:id/builds, et `ImageTemplate#lastBuild`. */
export interface ImageTemplateBuild {
  runId: string;
  status: ImageTemplateBuildStatus;
  finishedAt?: string;
  artifact?: ImageTemplateArtifact;
}

/** GET/POST /api/templates, GET/DELETE /api/templates/:id, POST /api/templates/:id/build. */
export interface ImageTemplate {
  id: string;
  name: string;
  base: TemplateBase;
  steps: TemplateStep[];
  status: ImageTemplateStatus;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  lastBuild?: ImageTemplateBuild;
}

/** Corps de POST /api/templates. */
export interface ImageTemplateCreateInput {
  name: string;
  base: TemplateBase;
  steps: TemplateStep[];
}

/** Corps de PUT /api/templates/:id (édition de recette depuis le sous-graphe) — seules les étapes
 * sont modifiables par cette route, la base reste du ressort du studio. */
export interface ImageTemplateUpdateInput {
  steps: TemplateStep[];
}

/** GET /api/templates/presets — recettes de départ servies par le backend (scratch + mkosi minimal),
 * l'accueil du studio affiche ce qui vient sans carte codée en dur (+ la recette vierge). */
export interface TemplatePreset {
  id: string;
  label: string;
  description: string;
  base: TemplateBase;
  steps: TemplateStep[];
}

/** GET /api/templates/artifact-sources — artefacts d'autres templates injectables dans une recette. */
export interface TemplateArtifactSource {
  templateId: string;
  name: string;
  artifactType: ImageTemplateArtifactType;
  reference: string;
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

/**
 * Hexdump en lecture seule d'une fenêtre d'octets d'un fichier ARBITRAIRE dans un conteneur —
 * voir GET /api/containers/:id/files/hexdump. ADMIN UNIQUEMENT côté route (surface plus
 * sensible qu'un simple listing de noms/tailles : lecture de contenu binaire brut, peut exposer
 * un secret sur disque).
 */
export interface FileHexdump {
  /** Chemin absolu normalisé réellement lu. */
  path: string;
  /** Taille RÉELLE et totale du fichier dans le conteneur (indépendante de `length`/`offset`). */
  sizeBytes: number;
  /** true si le fichier est plus gros que la fenêtre lue (demande partielle, ou `length`
   * plafonné côté serveur) — le frontend s'en sert pour afficher "fichier tronqué" plutôt que
   * de laisser croire que `bytes` est le fichier entier. */
  truncated: boolean;
  offset: number;
  /** Nombre d'octets RÉELLEMENT renvoyés dans `bytes` (bytes.length === length * 2). */
  length: number;
  /** Représentation hexadécimale minuscule, sans espaces ni séparateurs — le frontend formate
   * lui-même l'affichage colonnes/ASCII à partir de cette chaîne brute. */
  bytes: string;
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

// --- Fichiers réels d'un paquet vulnérable dans une image (voir
// apps/api/src/services/packageInspector.ts, GET /api/images/:id/packages/:packageName/files) —
// Grype/OSV-Scanner rapportent un Vulnerability#packageName mais jamais SES fichiers réels dans
// l'image ; ce module retrouve cette information EN INSPECTANT RÉELLEMENT l'image (apt/dpkg, npm,
// pip, dans cet ordre). Un paquet Go/Rust compilé statiquement n'a JAMAIS de code source
// récupérable dans l'image finale — `available: false` avec un `reason` concret dans ce cas,
// jamais un `files: []` qui laisserait croire à tort à un paquet réellement vide.

export type PackageEcosystem = "apt" | "npm" | "pip" | "unknown";

export interface PackageFilesResult {
  ecosystem: PackageEcosystem;
  available: boolean;
  /** Message honnête et concret expliquant pourquoi `available` est false (ou une précision sur
   * la résolution) — absent si tout s'est bien passé sans rien à préciser. */
  reason?: string;
  /** Chemins réels à l'intérieur de l'image — absent/vide si `available` est false. */
  files?: string[];
  /** Racine réelle sous laquelle `files` a été trouvé — absent pour apt (aucune racine unique
   * n'existe pour un paquet système, ses fichiers sont dispersés sous /usr, /etc, /lib...). */
  packageRoot?: string;
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

/** Voir apps/api/src/types.ts#GithubDetectionCandidate (contrat en miroir). */
export interface GithubDetectionCandidate {
  path: string; // relatif depuis la racine, sans "/" final (ex: "docker", "apps/api")
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[];
  hasAnsible: boolean;
}

/** Voir apps/api/src/types.ts#GithubComposeServiceCandidate (contrat en miroir). */
export interface GithubComposeServiceCandidate {
  name: string;
  port?: number; // port CONTENEUR (jamais le port hôte)
}

export interface GithubRepoDetection {
  ref: string;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasTerraform: boolean;
  terraformFiles: string[];
  hasAnsible: boolean;
  ansiblePlaybook?: string;
  /** Dernière instruction EXPOSE trouvée dans le Dockerfile de l'emplacement retenu — absent si aucun
   * Dockerfile ou aucun EXPOSE, jamais deviné. Pré-remplit le champ "port" (toujours éditable). */
  exposedPort?: number;
  /** Services compose candidats pour le sous-domaine — un seul -> sélection automatique côté
   * déploiement ; plusieurs -> l'utilisateur doit choisir explicitement (voir GitHubDeployPage.tsx). */
  composeServices?: GithubComposeServiceCandidate[];
  /** Sous-dossier effectivement inspecté (absent = racine) — à repasser tel quel comme `configPath`
   * à POST .../deploy. */
  detectedPath?: string;
  /** Plusieurs emplacements candidats trouvés (racine vide, parcours de sous-dossiers) — aucun
   * choisi automatiquement, l'utilisateur doit trancher explicitement dans une liste. */
  candidates?: GithubDetectionCandidate[];
}

/** "needs-config" : variables d'environnement requises sans valeur résolue — déploiement arrêté
 * PROPREMENT avant tout docker build/compose up (jamais un échec docker brut), voir
 * GithubDeployment#missingConfigKeys et DeployConfigSchema. */
export type GithubDeploymentStatus = "running" | "success" | "failed" | "needs-config";
export type GithubDeploymentKind = "docker-build-run" | "docker-compose" | "iac-workspace";
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
  /** Conteneur ayant reçu la route reverse-proxy de sous-domaine (unique conteneur pour
   * "docker-build-run", service choisi/déduit pour "docker-compose") — absent si aucun sous-domaine
   * demandé/réussi, ou kind "iac-workspace". */
  containerId?: string;
  containerName?: string;
  iacWorkspaceId?: string; // kind "iac-workspace" (Terraform ou Ansible)
  composeProjectName?: string; // kind "docker-compose" : nom du projet compose isolé (docker compose -p)
  composeServices?: string[]; // kind "docker-compose" : conteneurs réellement créés
  /** Sous-dossier du dépôt utilisé pour la détection ET le déploiement (voir
   * GithubRepoDetection#detectedPath) — absent si racine. Rejoué tel quel par "Redéployer". */
  configPath?: string;
  subdomain?: string;
  reverseProxyRouteId?: string;
  /** status "needs-config" uniquement : clés requises sans valeur résolue — à renseigner via
   * PUT .../config-values puis "Redéployer" (réutilisées automatiquement ensuite). */
  missingConfigKeys?: string[];
}

export interface GithubDeploymentDetail extends GithubDeployment {
  log: string;
  /** status "failed" uniquement : diagnostic(s) structuré(s) extraits du log par le moteur
   * générique de reconnaissance de motifs — calculé à la demande, jamais persisté. */
  diagnostics?: DeploymentDiagnostic[];
}

// --- Diagnostic générique des échecs de déploiement — voir apps/api/src/services/deploymentDiagnostics.ts.

export type DeploymentDiagnosticCategory =
  | "missing-header"
  | "missing-dependency"
  | "image-not-found"
  | "syntax-error"
  | "dependency-failed"
  | "port-conflict"
  | "missing-config"
  | "unknown";

export interface DeploymentDiagnostic {
  category: DeploymentDiagnosticCategory;
  title: string;
  explanation: string;
  suggestedAction: string;
  evidence?: string;
}

// --- Configuration dynamique de déploiement (variables d'environnement manquantes, ports,
// volumes, ARG Dockerfile) — voir apps/api/src/services/github.ts. Corrige un bug réel constaté le
// 14/08/2026 (mairie-creusot/formulaire_hotline) : un docker-compose.yml référençant un .env absent
// du clone frais (gitignored) faisait échouer platement `docker compose up` au lieu d'une détection
// propre AVANT l'échec. GET .../config-schema décrit ce qui peut/doit être configuré (jamais une
// vraie valeur de secret) ; PUT .../config-values enregistre les valeurs comme secret nommé
// "github-env:<owner>/<repo>" (secretsStore.ts), réutilisé automatiquement au redéploiement suivant.

export type EnvVarSource = "env_file" | "environment" | "dockerfile_arg";

export interface EnvVarRequirement {
  key: string;
  required: boolean;
  /** true si déjà résolue (secret stocké, ou défaut légitime non sensible d'un .env.example) —
   * jamais la valeur elle-même. */
  hasValue: boolean;
  source: EnvVarSource;
  service?: string; // absent pour "dockerfile_arg"
  envFilePath?: string; // "env_file" uniquement
  /** Heuristique sur le NOM de la clé — champ masqué côté formulaire pour ces clés. */
  looksSensitive: boolean;
  /** "db-provisioned" : mot de passe généré et appliqué automatiquement (preuve dans le même
   * compose) — hasValue true, rien à saisir, jamais montré. "admin-seed" : compte admin par
   * défaut d'une app déployée par QUAI — hasValue reste false, voir suggestedValue. */
  autoResolution?: "db-provisioned" | "admin-seed";
  /** "admin-seed" uniquement : valeur proposée à pré-remplir (jamais un secret préexistant),
   * toujours modifiable avant validation. */
  suggestedValue?: string;
}

export interface DeployPortRequirement {
  service?: string; // absent pour un déploiement Dockerfile seul
  containerPort: number;
  hostPort?: number; // port hôte actuellement fixé dans le compose, s'il y en a un
  overridable: boolean;
}

/** Lecture seule dans ce premier lot — affichée pour information uniquement. */
export interface DeployVolumeInfo {
  service?: string;
  source: string;
  target: string;
  readOnly: boolean;
}

/** GET /api/github/repos/:owner/:repo/config-schema. */
export interface DeployConfigSchema {
  owner: string;
  repo: string;
  ref: string;
  configPath?: string;
  envVars: EnvVarRequirement[];
  missingRequiredKeys: string[];
  ports: DeployPortRequirement[];
  volumes: DeployVolumeInfo[];
  /** Présent seulement si un `env_file:` référence un fichier introuvable ET qu'aucun
   * .env.example/.env.sample n'a été trouvé pour en déduire les clés attendues. */
  unresolvableEnvFile?: string;
}

// --- Surcharge du CONTENU de fichiers détectés au moment du build/déploiement — voir
// apps/api/src/services/githubFileOverridesStore.ts. Le fichier réellement utilisé pour build/
// déployer est TOUJOURS l'original du clone SAUF si une surcharge existe pour ce chemin exact,
// auquel cas elle le remplace ENTIÈREMENT (jamais un patch/diff partiel).

export type OverridableFileKind = "dockerfile" | "compose" | "terraform" | "ansible-playbook" | "ansible-inventory";

export interface OverridableFileRef {
  path: string;
  kind: OverridableFileKind;
  hasOverride: boolean;
}

export interface GithubFileOverride {
  path: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
}

export interface GithubFileContent {
  path: string;
  content: string;
  source: "original" | "override";
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

// --- HYCU (contrôleur de sauvegarde des VMs Nutanix, LECTURE SEULE) — miroir de
// apps/api/src/types.ts (routes/hycu.ts) ; les champs optionnels sont absents si HYCU ne les
// expose pas, jamais fabriqués.

/** Jamais le mot de passe (write-only). */
export interface HycuConfig {
  url: string;
  username: string;
}

/** GET /api/hycu/config */
export interface HycuConfigStatus {
  configured: boolean;
  config?: HycuConfig;
}

export interface HycuVm {
  uuid: string;
  vmName: string;
  protectionGroupUuid?: string;
  policyName?: string;
  protectionStatus?: string;
  complianceStatus?: string;
  lastBackupInMillis?: number;
  status?: string;
}

export interface HycuPolicy {
  uuid: string;
  name: string;
  vmCount: number;
}

export interface HycuTarget {
  uuid?: string;
  name: string;
  type?: string;
  totalSizeInBytes?: number;
  freeSizeInBytes?: number;
  usedSizeInBytes?: number;
  utilizationPct?: number;
}

export interface HycuJob {
  uuid?: string;
  name?: string;
  type?: string;
  status: string;
  startTimeInMillis?: number;
  endTimeInMillis?: number;
}

export interface HycuEvent {
  uuid?: string;
  severity: string;
  message?: string;
  category?: string;
  createdInMillis?: number;
}

/** État de protection d'une VM tel que HYCU le rapporte (voir apps/api/src/services/hycu.ts#
 * hycuVmProtectionState) — "never-backed-up" n'est jamais déduit d'un champ simplement absent de
 * l'API, seulement quand HYCU renseigne cette date pour d'autres VMs du même poll. */
export type HycuVmProtectionState = "protected" | "non-compliant" | "never-backed-up" | "unprotected";

/** Dernier essai réel de poll HYCU — distingue "liste vide" d'"appliance injoignable". */
export interface HycuPollOutcome {
  reachable: boolean;
  at: string; // ISO 8601
}

/** GET /api/hycu/status — blocs absents plutôt que des zéros inventés si l'appel a échoué. */
export interface HycuStatusSummary {
  configured: boolean;
  reachable?: boolean;
  vms?: { total: number; protectedCount: number };
  policies?: { count: number };
  targets?: { count: number; totalSizeInBytes: number; usedSizeInBytes: number };
  jobs?: { total: number; byStatus: Record<string, number> };
  lastPoll?: HycuPollOutcome;
}

/** POST /api/hycu/config/test */
export interface HycuTestResult {
  ok: boolean;
  message: string;
  vmCount?: number;
}

// --- ExaGrid (appliance de stockage de sauvegarde) — interrogée en SNMP (MIB officielle), pas
// d'API REST. Tout champ optionnel est ABSENT quand la MIB ne l'a pas renvoyé : ne jamais le
// remplacer par 0 à l'affichage.

// Valeurs d'énumération EXACTES acceptées par PUT /api/exagrid/config (minuscules — voir
// EXAGRID_AUTH_PROTOCOLS/EXAGRID_PRIV_PROTOCOLS dans apps/api/src/services/exagrid.ts) : toute
// autre casse est silencieusement ignorée par le serveur.
export type ExagridSnmpVersion = "2c" | "3";
export type ExagridSecurityLevel = "noAuthNoPriv" | "authNoPriv" | "authPriv";
export type ExagridAuthProtocol = "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
export type ExagridPrivProtocol = "des" | "aes" | "aes256b" | "aes256r";

/** Identité NON secrète de l'appliance — jamais community/authKey/privKey. */
export interface ExagridEndpoint {
  host: string;
  port: number;
  version: ExagridSnmpVersion;
  username?: string;
  securityLevel?: ExagridSecurityLevel;
  authProtocol?: ExagridAuthProtocol;
  privProtocol?: ExagridPrivProtocol;
}

/** GET/PUT /api/exagrid/config — `config` n'est présent que si `configured`. */
export interface ExagridConfigStatus {
  configured: boolean;
  config?: ExagridEndpoint;
}

/** Une zone (atterrissage ou rétention) — `usedBytes`/`usedPct` sont dérivés côté serveur et
 * absents si l'une des lectures manque. */
export interface ExagridCapacityZone {
  configuredBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  usedPct?: number;
}

export interface ExagridBackupData {
  availableForRestoreBytes?: number;
  retentionConsumedBytes?: number;
}

/** Volume en attente de traitement + ancienneté de la donnée la plus ancienne de la file. */
export interface ExagridPendingWork {
  bytes?: number;
  ageSeconds?: number;
}

export type ExagridAlarmState = "ok" | "warning" | "error";

/** `state` n'existe que pour les valeurs définies par la MIB (1/2/3) — toute autre valeur reste
 * brute dans `raw`, sans étiquette inventée. */
export interface ExagridAlarm {
  raw?: number;
  state?: ExagridAlarmState;
}

export interface ExagridReadings {
  landing: ExagridCapacityZone;
  retention: ExagridCapacityZone;
  backupData: ExagridBackupData;
  pendingDeduplication: ExagridPendingWork;
  pendingReplication: ExagridPendingWork;
  alarm?: ExagridAlarm;
}

/** Dernier essai réel de poll SNMP — distingue "valeur absente de la MIB" d'"appliance injoignable". */
export interface ExagridPollOutcome {
  reachable: boolean;
  at: string; // ISO 8601
}

/** GET /api/exagrid/status */
export interface ExagridStatusSummary {
  configured: boolean;
  reachable?: boolean;
  endpoint?: ExagridEndpoint;
  readings?: ExagridReadings;
  lastPoll?: ExagridPollOutcome;
}

/** POST /api/exagrid/config/test */
export interface ExagridTestResult {
  ok: boolean;
  message: string;
  alarm?: ExagridAlarm;
}
