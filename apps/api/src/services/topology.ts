/**
 * Graphe visuel de l'infrastructure (façon Railway) : conteneurs, volumes et leurs relations
 * réelles — construit à partir d'UN SEUL appel `docker.listContainers({all:true})` (son résumé
 * inclut déjà Mounts et NetworkSettings.Networks avec l'IP réelle de chaque endpoint, pas besoin
 * d'un inspect() par conteneur) + listVolumes() pour les volumes isolés et listNetworks() pour le
 * driver réel de chaque réseau.
 *
 * Chaque nœud "conteneur" est en plus enrichi (dashboard vue d'ensemble, cf. ARCHITECTURE.md) :
 *  - cpuPercent/memBytes : snapshot d'utilisation réel (docker.ts#readContainerUsage).
 *  - updateAvailable : rapproché de GET /api/images (status "update") par "name:tag".
 *  - drift : rapproché de GET /api/gitops/files (drift=true) par nom de fichier ~ nom de conteneur.
 *  - vulnCritical/vulnHigh : rapproché du DERNIER scan RÉUSSI connu (Grype et/ou OSV-Scanner,
 *    services/scan.ts) pour l'image "name:tag" du conteneur — voir vulnSummaryForImage ci-dessous.
 *  - healthStatus : état de santé Docker NATIF (docker.ts#readContainerHealth, `State.Health.
 *    Status` via un inspect() par conteneur) — "none" si l'image ne définit aucun HEALTHCHECK,
 *    jamais deviné/fabriqué. Une arête ne le duplique pas : le frontend lit ce champ directement
 *    sur le(s) nœud(s) conteneur à ses deux bouts pour en dériver sa couleur (conception la plus
 *    simple — pas de donnée à garder synchronisée sur deux entités pour la même information).
 * Tous best-effort par nom — aucune donnée arbitraire n'est inventée si rien ne correspond (le
 * nœud reste simplement sans badge).
 *
 * RÉSEAUX (refonte du 24/08/2026) : plus AUCUN nœud ni arête de réseau — un réseau est porté par le
 * nœud qui y est réellement rattaché, sous forme de "tiroir" (TopologyNodeAttachment kind
 * "network", rendu sous la carte comme un volume dédié). Vaut pour TOUS les réseaux d'un conteneur
 * Docker (partagés, par défaut ou dédiés) ET pour chaque carte réseau réelle d'une VM Nutanix
 * (plugins/nutanix/graph.ts#nutanixVmNetworkAttachments). Données portées : nom, driver (ou VLAN côté Nutanix) et
 * IP RÉELLEMENT attribuée — jamais d'IP fabriquée quand aucune ne l'est. Aucune mesure de latence :
 * QUAI ne fait aucun sondage réseau actif, ce chiffre serait inventé.
 *
 * Nœuds "nutanix-vm" (voir plugins/nutanix/graph.ts) : source totalement indépendante de
 * Docker — récupérés et ajoutés au graphe que Docker soit joignable ou non, [] tant que Nutanix
 * n'a jamais été configuré ou si configuré mais injoignable (nutanix.ts#getNutanixVms). Reliées à
 * leur nœud "host" de cluster (voir juste en dessous) par une VRAIE arête `kind: "hosts"` quand le
 * cluster de la VM est déterminable — jamais reliées aux nœuds Docker (aucune relation réelle).
 *
 * PAS de nœud dédié au contrôleur de domaine/DNS Active Directory (retiré le 24/08/2026) : les
 * contrôleurs de domaine de la mairie SONT des VMs Nutanix, déjà présentes ci-dessus. Un second
 * nœud isolé portant le même hostname doublonnait la machine réelle — et rendait la liaison
 * automatique du module métier "ad-dns" AMBIGUË (deux nœuds candidats pour un même hôte configuré,
 * voir serviceModules.ts#resolveAutomaticBindings, qui ne lie rien dans ce cas). La configuration
 * AD/DNS elle-même vit dans les Réglages (web), et son module se rattache maintenant à la VRAIE VM.
 *
 * Nœud "hycu-appliance" (voir getHycuTopologyParts ci-dessous) : le contrôleur de sauvegarde HYCU
 * réel — aucun nœud tant qu'il n'a jamais été configuré, LECTURE SEULE stricte. Seul émetteur
 * d'arêtes `kind: "protects"` allant des VMs Nutanix réellement sauvegardées vers lui.
 *
 * Nœuds "host" (kind "host", champ `hostKind` — voir plugins/nutanix/graph.ts,
 * getRemoteDockerHostNodes/getLxcHostNodes ci-dessous) : une machine/cluster HÔTE réelle, PAS une
 * ressource applicative — trois sous-types possibles, un nœud par ressource RÉELLEMENT configurée,
 * jamais fabriquée :
 *  - "nutanix-cluster" : un nœud par cluster physique réellement listé par Prism Central
 *    (nutanix.ts#getNutanixClusters), status toujours "running" (un cluster qu'on a pu lister est
 *    par définition joignable) — [] si Nutanix n'a jamais été configuré ou si injoignable, comme
 *    les VMs. Relié à ses hôtes physiques (voir ci-dessous) par une arête "hosts".
 *  - "nutanix-host" (14/08/2026) : niveau intermédiaire NOUVEAU, un nœud par hôte AHV physique
 *    réellement listé (nutanix.ts#getNutanixHosts, endpoint /hosts/list) — 3 hôtes physiques
 *    confirmés en conditions réelles pour CLUSTER_AHV_HDV (172.20.0.10:9440). Relié à son cluster
 *    parent par une arête "hosts", et à chaque VM qu'il exécute (ou a exécutée en dernier, VM
 *    éteinte) par une autre arête "hosts" (`vm.hostUuid`, recalculé à CHAQUE poll, avec repli
 *    status -> spec côté nutanix.ts#mapVmEntity pour une VM éteinte — une VM qui migre en live
 *    migration change donc de rattachement dès le prochain rafraîchissement). Retour utilisateur
 *    du 17/08/2026, capture d'écran à l'appui : "ya des edge en trop... je doi en avoir que troie
 *    [arêtes] la entre ahv et nut 1 nut 2 nut 3" — une VM sans AUCUN hôte déterminable (ni
 *    status.resources.host_reference ni son repli spec, VM jamais démarrée) ne produit PLUS
 *    d'arête "hosts" DU TOUT (voir plugins/nutanix/graph.ts) : jamais de rattachement
 *    direct au nœud cluster, qui inventerait une relation "cluster héberge directement cette VM"
 *    fausse — un cluster ne doit visuellement porter QUE ses arêtes vers ses hôtes physiques réels
 *    (invariant explicitement demandé). Ce cas résiduel (VM restant sans la moindre arête "hosts")
 *    reste une carte de nœud visible dans le graphe, juste non reliée à sa hiérarchie physique
 *    tant qu'aucune donnée de placement n'existe pour elle.
 *  - "remote-docker" : un nœud par environnement Docker distant PERSISTÉ (remoteDockerStore.ts,
 *    SSH ou TCP+TLS) — TOUJOURS présent dès qu'il est configuré (l'utilisateur l'a créé, il
 *    existe), `status` reflète honnêtement la joignabilité RÉELLE au moment de la construction du
 *    graphe (docker.ts#getDockerHostInfo, même mécanisme que Environment#hostInfo) : "running" +
 *    `hostInfo` rempli si joignable, "stopped" + `hostInfo` absent sinon — jamais de hostInfo
 *    inventé/mis en cache pour un hôte injoignable.
 *  - "lxc" : au plus un nœud (LXD n'a qu'une seule config dans ce premier lot, comme Nutanix),
 *    présent dès que LXD est configuré (lxcStore.ts), status honnête selon la joignabilité réelle
 *    (lxc.ts#getLxcEnvironment).
 * Aucun nœud "host" n'a de port de connexion (NODE_CAPABILITIES["host"] = [] côté frontend) : ce
 * ne sont pas des ressources connectables comme un conteneur/volume.
 *
 * Volumes ORPHELINS (existants sur l'hôte Docker mais montés par AUCUN conteneur) : décision
 * produit du 13/08/2026 (VolumesPage.tsx supprimée, "tout est dans le graphe") — restent de VRAIS
 * nœuds top-level, `orphan: true`, SANS AUCUNE arête. Le frontend les rend visuellement atténués
 * plutôt que de les cacher. Un RÉSEAU orphelin n'apparaît en revanche plus du tout dans le graphe
 * depuis la refonte ci-dessus : sans nœud porteur, il n'a aucun tiroir où s'afficher (il reste
 * listé par GET /api/networks).
 *
 * Volumes en "tiroir" (à conteneur UNIQUE, voir TopologyNode#attachments) : décision prise ICI,
 * côté backend, pour que GET /api/topology reflète déjà le modèle final (le frontend n'a pas à
 * recalculer une notion de "partage" qu'il ne peut pas dériver sans reparcourir toutes les arêtes).
 * Un volume monté par UN SEUL conteneur (cas de loin le plus fréquent) s'affiche comme une
 * propriété du service, façon Railway ; RÉELLEMENT partagé par ≥2 conteneurs, il reste un vrai
 * nœud + arêtes "mount" — cette relation-là garde un sens graphique réel.
 */

import { config } from "../config.js";
import { getClient, getDockerHostInfo, isDockerReachable, readContainerHealth, readContainerUsage } from "./docker.js";
import { getImages } from "./images.js";
import { listGitOpsFiles } from "./gitops.js";
import { listAllScans } from "./scan.js";
import { lastKnownNutanixPoll } from "./nutanix.js";
import { getNutanixTopologyParts } from "../plugins/nutanix/graph.js";
import { hycuTopologyParts } from "../plugins/hycu/graph.js";
import { listRoutes } from "./reverseProxy.js";
import { listGroups } from "./topologyGroupsStore.js";
import { listRemoteDockerEnvironments } from "./remoteDockerStore.js";
import { getLxcEnvironment } from "./lxc.js";
import { getEffectiveLxcConfig } from "./lxcStore.js";
import { listCronJobs } from "./cronJobsStore.js";
import { listCronJobRuns } from "./cronJobsScheduler.js";
import { listBackupDefinitions, listBackupRuns } from "./backupsStore.js";
import { listWorkspaces } from "./iac/workspaces.js";
import { listRuns } from "./iac/runner.js";
import { listTemplates } from "./templates.js";
import { listAutomationEdges, listAutomationNodes } from "./automationStore.js";
import type { AutomationNode } from "./automationStore.js";
import type {
  AutomationActionConfig,
  AutomationTriggerSource,
  IacEngine,
  ImageTemplate,
  ScanResult,
  Topology,
  TopologyEdge,
  TopologyNode,
} from "../types.js";

/**
 * Bug réel corrigé le 14/08/2026 (retour utilisateur : "Image introuvable parmi les images
 * suivies" pour un conteneur pourtant bien tiré/suivi — vérifié en direct sur quai-dev-api-1 et
 * ferrite-sup-test) : `ContainerInfo#Image` (Docker) préserve la référence TELLE QUE DONNÉE à la
 * création du conteneur — un conteneur lancé sans tag explicite (`docker run quai-dev-api`, ou un
 * docker-compose référençant juste `image: quai-dev-api`) garde `Config.Image = "quai-dev-api"`
 * SANS ":latest", même si Docker résout bel et bien l'image "quai-dev-api:latest" en pratique
 * (confirmé en direct : `docker inspect ... --format '{{.Config.Image}}'` -> "quai-dev-api", alors
 * que `docker images` liste bien "quai-dev-api:latest"). Tout rapprochement par "name:tag" (badges
 * vulnérabilités/MàJ dispo ci-dessous, ET `node.subtitle` lui-même consommé par le frontend pour
 * retrouver l'ImageRef suivie — TopologyNodeDetailPanel.tsx/VulnerabilitiesPanel.tsx) échouait donc
 * silencieusement pour ces conteneurs. Ajoute ":latest" UNIQUEMENT si la partie après le DERNIER
 * "/" ne contient aucun ":" — un registry avec port ("host:5000/image") ne doit jamais être pris à
 * tort pour un tag.
 */
export function ensureImageTag(image: string): string {
  const afterLastSlash = image.slice(image.lastIndexOf("/") + 1);
  return afterLastSlash.includes(":") ? image : `${image}:latest`;
}

/**
 * Résumé Critical/High pour l'image `image` ("name:tag", même format que ContainerInfo#Image) à
 * partir de l'historique de scans complet — ou `null` si aucun scan RÉUSSI n'a jamais tourné pour
 * cette image précise (aucun badge affiché dans ce cas, plutôt que 0 inventé).
 *
 * Règle de rapprochement (documentée ici car ni Grype ni OSV-Scanner n'est "the" scanner de
 * référence pour QUAI, les deux coexistent) : on prend le dernier scan réussi de CHAQUE scanner
 * pour cette image (au plus un par scanner), puis on retient le plus sévère des deux — le MAX des
 * comptes Critical d'un côté, des comptes High de l'autre. Simple, jamais optimiste (un scanner
 * qui trouve une faille que l'autre a manquée reste visible), pas besoin de fusionner les listes
 * de CVE elles-mêmes puisque seul le compte par sévérité est affiché sur le badge.
 */
/**
 * Construit en UNE SEULE passe O(S) sur tout l'historique de scans une Map "name:tag" -> résumé
 * Critical/High, au lieu de reparcourir `scans` en entier pour CHAQUE conteneur (O(C×S) — voir
 * docs/reports/optimization-audit-2026-08-12.md §É2, `getTopology()` est pollée toutes les ~9s).
 * Même règle de rapprochement qu'avant (dernier scan RÉUSSI de chaque scanner, MAX des comptes
 * Critical/High entre scanners) — comportement strictement identique, juste précalculé une fois.
 */
function buildVulnSummaryByImage(scans: ScanResult[]): Map<string, { vulnCritical: number; vulnHigh: number }> {
  const latestByImageAndScanner = new Map<string, Map<string, ScanResult>>();
  for (const scan of scans) {
    if (scan.status !== "success") continue;
    let byScanner = latestByImageAndScanner.get(scan.image);
    if (!byScanner) {
      byScanner = new Map<string, ScanResult>();
      latestByImageAndScanner.set(scan.image, byScanner);
    }
    const current = byScanner.get(scan.scanner);
    if (!current || scan.startedAt > current.startedAt) byScanner.set(scan.scanner, scan);
  }
  const result = new Map<string, { vulnCritical: number; vulnHigh: number }>();
  for (const [image, byScanner] of latestByImageAndScanner) {
    let vulnCritical = 0;
    let vulnHigh = 0;
    for (const scan of byScanner.values()) {
      vulnCritical = Math.max(vulnCritical, scan.summary.Critical);
      vulnHigh = Math.max(vulnHigh, scan.summary.High);
    }
    result.set(image, { vulnCritical, vulnHigh });
  }
  return result;
}

function primaryContainerName(names: string[] | undefined, id: string): string {
  const name = names?.[0] ?? id.slice(0, 12);
  return name.startsWith("/") ? name.slice(1) : name;
}

/** "container:<id>" -> "<id>" — inverse de la construction de containerNodeId ci-dessus, pour
 * reconstruire les mêmes ids d'arêtes qu'avant (`mount:<containerId>:<volumeName>`) sans garder
 * le c.Id docker brut sous la main dans les boucles de l'étape 3. */
function idFromContainerNodeId(containerNodeId: string): string {
  return containerNodeId.slice("container:".length);
}

function mapState(state: string): TopologyNode["status"] {
  if (state === "running") return "running";
  if (state === "restarting") return "restarting";
  return "stopped";
}

/** "prod/nginx.yaml" -> "nginx" — pour un rapprochement approximatif fichier GitOps <-> conteneur. */
function gitOpsBaseName(filePath: string): string {
  const file = filePath.split("/").pop() ?? filePath;
  return file.replace(/\.(ya?ml)$/i, "").toLowerCase();
}

function containerMatchesGitOpsFile(containerName: string, filePath: string): boolean {
  const base = gitOpsBaseName(filePath);
  const name = containerName.toLowerCase();
  if (!base || !name) return false;
  return base === name || base.includes(name) || name.includes(base);
}

/**
 * Nœuds VM Nutanix + nœuds "host" (cluster physique ET, niveau intermédiaire, hôte physique AHV) +
 * arêtes réelles qui les relient : entièrement portés par le GREFFON Nutanix depuis sa migration
 * (voir plugins/nutanix/graph.ts, qui garde la hiérarchie cluster -> hôte -> VM, les identifiants
 * de nœuds et les règles de rattachement à l'identique).
 */

/**
 * Nœud "hycu-appliance" + arêtes "protects" VM Nutanix -> HYCU + annotation de protection posée SUR
 * les nœuds VM déjà construits : entièrement porté par le GREFFON HYCU depuis sa migration (voir
 * plugins/hycu/graph.ts, qui garde le mécanisme et les règles de rapprochement à l'identique).
 */
async function getHycuTopologyParts(nutanixVmNodes: TopologyNode[]): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[] }> {
  return await hycuTopologyParts(nutanixVmNodes);
}

/**
 * Un nœud "host" par environnement Docker distant PERSISTÉ (remoteDockerStore.ts, SSH ou
 * TCP+TLS) — TOUJOURS présent dès qu'il est configuré : contrairement à Nutanix/LXC, l'existence
 * du nœud ne dépend pas de la joignabilité (l'utilisateur a explicitement ajouté cet hôte, il doit
 * rester visible même injoignable), seul `status`/`hostInfo` en dépendent :
 *  - joignable : `status: "running"` + `hostInfo` réel (docker.ts#getDockerHostInfo — mêmes CPU/
 *    RAM/version/conteneurs que Environment#hostInfo pour ce même hôte, GET /api/environments) ;
 *  - injoignable : `status: "stopped"`, `hostInfo` absent (jamais de dernière valeur connue mise en
 *    cache : ce serait mentir sur l'état actuel).
 * [] si aucun environnement Docker distant n'a jamais été configuré.
 */
async function getRemoteDockerHostNodes(): Promise<TopologyNode[]> {
  const envs = await listRemoteDockerEnvironments();
  return Promise.all(
    envs.map(async (env) => {
      const hostInfo = await getDockerHostInfo(env.id);
      const endpoint =
        env.transport === "ssh" ? `ssh://${env.sshUsername ?? "?"}@${env.host}:${env.port}` : `tcp://${env.host}:${env.port}`;
      return {
        id: `host:remote-docker:${env.id}`,
        kind: "host",
        hostKind: "remote-docker",
        label: env.name,
        subtitle: endpoint,
        status: hostInfo ? "running" : "stopped",
        ...(hostInfo ? { hostInfo } : {}),
      } satisfies TopologyNode;
    }),
  );
}

/**
 * Nœud "host" LXD (au plus un — LXD n'a qu'une seule config dans ce premier lot, cf. lxcStore.ts,
 * même principe que Nutanix) — présent dès que LXD est configuré, `status` honnête selon la
 * joignabilité réelle au moment de la construction du graphe (lxc.ts#getLxcEnvironment, même appel
 * que GET /api/environments). [] si LXD n'a jamais été configuré.
 */
async function getLxcHostNodes(): Promise<TopologyNode[]> {
  const env = await getLxcEnvironment();
  if (!env) return [];
  const effective = await getEffectiveLxcConfig();
  const endpoint = effective?.endpoint ?? "LXD";
  const reachable = env.status === "ok";
  const instanceCount = env.nodes[0]?.containerCount;
  return [
    {
      id: "host:lxc",
      kind: "host",
      hostKind: "lxc",
      label: "LXD",
      subtitle: reachable && instanceCount !== undefined ? `${endpoint} · ${instanceCount} instance(s)` : endpoint,
      status: reachable ? "running" : "stopped",
    },
  ];
}

const QUAI_MASTER_NODE_ID = "host:quai-master";
const LOCAL_DOCKER_NODE_ID = "host:docker-local";

/** Nœud "Docker local" (hostKind "docker-env") : le démon local, toujours présent — status/hostInfo
 * honnêtes selon la joignabilité réelle (mêmes règles que "remote-docker" ci-dessus). */
async function getLocalDockerEnvNode(): Promise<TopologyNode> {
  const hostInfo = await getDockerHostInfo();
  return {
    id: LOCAL_DOCKER_NODE_ID,
    kind: "host",
    hostKind: "docker-env",
    label: "Docker local",
    subtitle: hostInfo ? hostInfo.endpoint : "Démon Docker local",
    status: hostInfo ? "running" : "stopped",
    ...(hostInfo ? { hostInfo } : {}),
  };
}

/**
 * Statut d'un nœud "cron-job"/"backup" dérivé de sa DERNIÈRE exécution réelle connue (le run le
 * plus récent, `runs[0]` — `listCronJobRuns`/`listBackupRuns` trient déjà du plus récent au plus
 * ancien) — jamais inventé, voir types.ts#TopologyNodeKind pour la règle complète. Partagée par
 * getCronJobNodes/getBackupNodes ci-dessous : même trio de statuts "success"/"failed"/"running"
 * des deux côtés (CronJobRunStatus et BackupRunStatus sont structurellement identiques).
 */
function lastRunNodeStatus(lastRun: { status: "running" | "success" | "failed" } | undefined): TopologyNode["status"] {
  if (!lastRun) return "neutral"; // jamais exécuté
  if (lastRun.status === "running") return "restarting"; // exécution en cours
  return lastRun.status === "success" ? "running" : "stopped";
}

/**
 * Un nœud "cron-job" par définition RÉELLE de cronJobsStore.ts (jamais modifié par ce chantier,
 * voir mission "tout devient un nœud du graphe") — indépendant de Docker (comme "nutanix-vm"
 * ci-dessus, récupéré que le démon local soit joignable ou non) : la LISTE des définitions ne dépend
 * pas de Docker, même si l'EXÉCUTION d'un job en dépend (docker exec sur son conteneur cible,
 * inchangé, voir cronJobsScheduler.ts). `status` dérivé de son dernier run réel connu
 * (listCronJobRuns, lastRunNodeStatus ci-dessus) — [] si aucun cron job n'a jamais été créé.
 */
async function getCronJobNodes(): Promise<TopologyNode[]> {
  const jobs = await listCronJobs();
  return Promise.all(
    jobs.map(async (job) => {
      const runs = await listCronJobRuns(job.id);
      return {
        id: `cron-job:${job.id}`,
        kind: "cron-job",
        label: job.name,
        subtitle: `${job.containerName} · ${job.schedule}${job.enabled ? "" : " · désactivé"}`,
        status: lastRunNodeStatus(runs[0]),
      } satisfies TopologyNode;
    }),
  );
}

/**
 * Un nœud "backup" par définition RÉELLE de backupsStore.ts (jamais modifié par ce chantier) —
 * même principe que getCronJobNodes ci-dessus : indépendant de la joignabilité Docker locale (une
 * sauvegarde peut cibler un volume/conteneur, mais la LISTE des définitions est une simple lecture
 * JSON), `status` dérivé du dernier run réel connu (listBackupRuns, lastRunNodeStatus). [] si
 * aucune définition de sauvegarde n'a jamais été créée.
 */
async function getBackupNodes(): Promise<TopologyNode[]> {
  const definitions = await listBackupDefinitions();
  return Promise.all(
    definitions.map(async (def) => {
      const runs = await listBackupRuns(def.id);
      const targetLabel = def.target.kind === "volume" ? "Volume" : "Base de données";
      return {
        id: `backup:${def.id}`,
        kind: "backup",
        label: def.name,
        subtitle: `${targetLabel} ${def.target.ref} · ${def.schedule}${def.enabled ? "" : " · désactivée"}`,
        status: lastRunNodeStatus(runs[0]),
      } satisfies TopologyNode;
    }),
  );
}

/** Libellé humain d'un moteur IaC — même table que côté frontend (TopologyNodeDetailPanel.tsx),
 * gardée locale ici : un simple sous-titre de nœud, pas une donnée de contrat exposée par types.ts. */
const IAC_ENGINE_LABEL: Record<IacEngine, string> = { tofu: "OpenTofu", ansible: "Ansible", packer: "Packer", docker: "Docker", mkosi: "mkosi" };

/**
 * Un nœud "iac-workspace" par workspace Infra-as-code RÉEL (services/iac/workspaces.ts) — TOUJOURS
 * présent dès qu'il est créé (l'utilisateur l'a explicitement créé via POST /api/iac/workspaces),
 * indépendant de Docker/Nutanix comme "cron-job"/"backup" ci-dessus (récupéré que
 * Docker local soit joignable ou non). [] si aucun workspace n'a jamais été créé.
 *
 * `status` dérivé du DERNIER run réel de ce workspace (services/iac/runner.ts#listRuns, déjà trié
 * le plus récent en tête, voir runner.ts#upsertRun) via lastRunNodeStatus ci-dessus — même
 * convention que getCronJobNodes/getBackupNodes (jamais exécuté -> "neutral" ; en cours ->
 * "restarting" ; dernier succès -> "running" ; dernier échec -> "stopped"). `iacLastRunStatus`
 * porte en plus le statut EXACT du dernier run (voir TopologyNode côté types.ts) : le frontend ne
 * peut pas le redériver depuis les 4 valeurs génériques de `status` (ex: distinguer "jamais
 * exécuté" de "en cours" nécessite cette valeur précise pour le panneau de détail).
 *
 * Aucune arête : QUAI n'a aucune donnée reliant réellement un workspace IaC à une ressource Docker/
 * Nutanix précise (même principe que "cron-job"/"backup" ci-dessus) — à l'utilisateur de le reconnaître
 * visuellement si un `tofu apply` a par exemple provisionné tel conteneur.
 */
async function getIacWorkspaceNodes(): Promise<TopologyNode[]> {
  const workspaces = await listWorkspaces();
  return Promise.all(
    workspaces.map(async (w) => {
      const runs = await listRuns(w.id);
      const lastRun = runs[0];
      return {
        id: `iac-workspace:${w.id}`,
        kind: "iac-workspace",
        label: w.name,
        subtitle: IAC_ENGINE_LABEL[w.engine],
        status: lastRunNodeStatus(lastRun),
        iacEngine: w.engine,
        iacLastRunStatus: lastRun?.status ?? null,
      } satisfies TopologyNode;
    }),
  );
}

/** Libellé humain de la base d'une recette — simple sous-titre de nœud, même principe que
 * IAC_ENGINE_LABEL ci-dessus (pas une donnée de contrat exposée par types.ts). */
function imageTemplateSubtitle(template: ImageTemplate): string {
  switch (template.base.type) {
    case "cloud-image":
      return `VM ${template.base.distro} ${template.base.version}`;
    case "container":
      return `Conteneur ${template.base.image}`;
    case "mkosi":
      return `OS mkosi ${template.base.distro} ${template.base.release}`;
    case "iso":
      return "ISO Prism (installation manuelle)";
  }
}

/**
 * Un nœud "image-template" par template d'images RÉEL (services/templates.ts, catalogue
 * "builder") — même pattern que getIacWorkspaceNodes ci-dessus : indépendant de la joignabilité
 * Docker/Nutanix (simple lecture JSON + réconciliation avec les runs déjà persistés), [] si aucun
 * template n'a jamais été créé. `status` générique projeté depuis le statut précis du template
 * (draft -> "neutral" ; building -> "restarting" ; ready -> "running" ; error -> "stopped"),
 * porté exactement par `templateStatus` pour le panneau de détail. Arêtes : UNIQUEMENT les
 * dépendances d'artefact réelles entre templates (étape "artifact" de la recette) — toujours
 * aucune arête inventée vers Docker/Nutanix.
 */
async function getImageTemplateParts(): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[] }> {
  const templates = await listTemplates().catch(() => []);
  const knownIds = new Set(templates.map((t) => t.id));
  const nodes = templates.map((t) => {
    const status: TopologyNode["status"] =
      t.status === "building" ? "restarting" : t.status === "ready" ? "running" : t.status === "error" ? "stopped" : "neutral";
    return {
      id: `image-template:${t.id}`,
      kind: "image-template",
      label: t.name,
      subtitle: imageTemplateSubtitle(t),
      status,
      templateKind: t.base.type,
      templateStatus: t.status,
      templateWorkspaceId: t.workspaceId,
      ...(t.lastBuild?.artifact
        ? { templateArtifactType: t.lastBuild.artifact.type, templateArtifactReference: t.lastBuild.artifact.reference }
        : {}),
    } satisfies TopologyNode;
  });
  // Interconnexion réelle : une étape "artifact" de la recette de B crée l'arête A -> B (une seule
  // par paire, jamais vers un template supprimé ni vers soi-même).
  const edges: TopologyEdge[] = [];
  const seenPairs = new Set<string>();
  for (const t of templates) {
    for (const step of t.steps) {
      if (step.type !== "artifact" || !knownIds.has(step.templateId) || step.templateId === t.id) continue;
      const pair = `${step.templateId}:${t.id}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      edges.push({ id: `uses-artifact:${pair}`, source: `image-template:${step.templateId}`, target: `image-template:${t.id}`, kind: "uses-artifact" });
    }
  }
  return { nodes, edges };
}

/**
 * Nœud "gitops-source" (voir services/gitops.ts, config.ts#gitops) : LE dépôt Git configuré comme
 * source de vérité GitOps — une config globale UNIQUE, pas une liste,
 * jamais une liste d'items malgré le nom pluriel du chantier "tout devient un nœud du graphe".
 *
 * Gardé sur `config.gitops.repoUrl` précisément (pas juste "un dépôt local existe") : GITOPS_REPO_PATH
 * a TOUJOURS une valeur par défaut ("./data/gitops", voir config.ts) et gitops.ts l'auto-amorce
 * silencieusement (bootstrapLocalRepo) même sans configuration explicite de l'utilisateur — ce
 * comportement de repli reste inchangé (le badge "Dérive GitOps" des conteneurs, ci-dessous, continue
 * d'en profiter), mais ne justifie PAS d'afficher un nœud dans le graphe : un nœud représente une
 * INTÉGRATION EXTERNE délibérément configurée, jamais un mécanisme de repli
 * automatique. [] si GITOPS_REPO_URL n'a jamais été renseigné.
 *
 * `status` dérivé du nombre RÉEL de fichiers actuellement en dérive (listGitOpsFiles().filter(f =>
 * f.drift), même source que driftFilePaths ci-dessous) : "running" si aucune dérive (sain), "stopped"
 * dès qu'au moins un fichier dérive (alerte) — toujours déterminable une fois le dépôt configuré,
 * donc jamais de troisième état "neutral" ici (contrairement à "cron-job"/"backup", où "neutral"
 * couvre l'absence de toute exécution connue).
 *
 * Appel dédié à listGitOpsFiles() (indépendant de celui du bloc Docker plus bas, qui ne tourne que
 * si Docker est joignable ET sert un autre usage — le rapprochement de dérive PAR CONTENEUR) : même
 * principe que nutanix-vm/host, chaque nœud "statique" récupère sa propre donnée sans
 * dépendre de la disponibilité de Docker. `ensureRepoReady()` (gitops.ts) protège déjà les appels
 * concurrents entre eux (garde anti-chevauchement) ; les deux appels ici restent séquentiels, donc
 * un léger surcoût réseau (un second fetch/pull) uniquement quand GITOPS_REPO_URL est réellement
 * configuré ET Docker joignable au même cycle — accepté pour ce premier lot plutôt que de complexifier
 * la fonction pour partager un résultat entre deux préoccupations indépendantes.
 *
 * PAS d'arête vers un nœud Docker/Nutanix/host : aucune donnée ne prouve un lien réel (même principe
 * que "iac-workspace" ci-dessus).
 */
async function getGitOpsSourceNode(): Promise<TopologyNode[]> {
  if (!config.gitops.repoUrl) return [];
  const files = await listGitOpsFiles().catch(() => []);
  const driftCount = files.filter((f) => f.drift).length;
  return [
    {
      id: `gitops-source:${config.gitops.repoUrl}`,
      kind: "gitops-source",
      label: config.gitops.repoUrl,
      subtitle: `Branche ${config.gitops.branch}`,
      status: driftCount > 0 ? "stopped" : "running",
    },
  ];
}

/** Libellé humain de la source d'un trigger — simple sous-titre de nœud (pas une donnée de
 * contrat exposée par types.ts, même principe que IAC_ENGINE_LABEL ci-dessus). */
function automationTriggerSourceLabel(source: AutomationTriggerSource | undefined): string {
  if (!source) return "Aucune source configurée";
  if (source.kind === "topology-node") return `Surveille ${source.nodeId}`;
  return `Surveille la route de reverse proxy ${source.routeId}`;
}

/** Libellé humain d'une action — même principe que automationTriggerSourceLabel ci-dessus. */
function automationActionConfigLabel(cfg: AutomationActionConfig | undefined): string {
  if (!cfg) return "Aucune action configurée";
  if (cfg.kind === "run-cron-job") return `Déclenche le cron job ${cfg.cronJobId}`;
  if (cfg.kind === "send-notification") return `Notifie via le canal ${cfg.channelId}`;
  return `Conteneur ${cfg.containerId} : ${cfg.action}`;
}

/**
 * Nœuds "automation-trigger"/"automation-condition"/"automation-action" + arêtes
 * "automation-flow" par nœud/arête RÉEL du moteur d'automatisation (services/automationStore.ts,
 * jamais modifié par ce chantier — même principe que getCronJobNodes/getBackupNodes ci-dessus :
 * simple projection de définitions déjà persistées). Indépendant de Docker (récupéré que le
 * démon local soit joignable ou non), comme les autres nœuds "statiques" de ce fichier.
 *
 * `status` d'un trigger dérivé de son DERNIER état réel connu par le moteur
 * (services/automationEngine.ts, `lastStatus`) : "unknown" -> "neutral" (jamais évalué depuis le
 * démarrage du process), "ok" -> "running", "failing" -> "stopped". Une condition/action n'a pas
 * d'état permanent qui lui soit propre (son "exécution" n'a de sens que ponctuellement, dans le
 * journal de runs — GET /api/automation/runs) : toujours "neutral", jamais un statut fabriqué.
 */
async function getAutomationNodes(): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[] }> {
  const [nodes, edges] = await Promise.all([listAutomationNodes(), listAutomationEdges()]);
  const topologyId = (node: AutomationNode) => `${node.kind}:${node.id}`;

  const topologyNodes: TopologyNode[] = nodes.map((node) => {
    if (node.kind === "automation-trigger") {
      const status: TopologyNode["status"] =
        node.lastStatus === "ok" ? "running" : node.lastStatus === "failing" ? "stopped" : "neutral";
      return {
        id: topologyId(node),
        kind: "automation-trigger",
        label: node.label,
        subtitle: automationTriggerSourceLabel(node.triggerConfig?.source),
        status,
        ...(node.triggerConfig ? { automationTriggerConfig: node.triggerConfig } : {}),
        automationLastFired: node.lastFired ?? null,
        automationLastStatus: node.lastStatus ?? "unknown",
      } satisfies TopologyNode;
    }
    if (node.kind === "automation-condition") {
      return {
        id: topologyId(node),
        kind: "automation-condition",
        label: node.label,
        subtitle: node.conditionInvert ? "Bloque la chaîne (condition inversée)" : "Laisse passer la chaîne",
        status: "neutral",
        automationConditionInvert: node.conditionInvert ?? false,
      } satisfies TopologyNode;
    }
    return {
      id: topologyId(node),
      kind: "automation-action",
      label: node.label,
      subtitle: automationActionConfigLabel(node.actionConfig),
      status: "neutral",
      ...(node.actionConfig ? { automationActionConfig: node.actionConfig } : {}),
    } satisfies TopologyNode;
  });

  const topologyIdByAutomationId = new Map(nodes.map((node) => [node.id, topologyId(node)]));
  const topologyEdges: TopologyEdge[] = edges
    .filter((edge) => topologyIdByAutomationId.has(edge.source) && topologyIdByAutomationId.has(edge.target))
    .map((edge) => ({
      id: `automation-flow:${edge.id}`,
      source: topologyIdByAutomationId.get(edge.source)!,
      target: topologyIdByAutomationId.get(edge.target)!,
      kind: "automation-flow",
    }));

  return { nodes: topologyNodes, edges: topologyEdges };
}

/** "local" (GET /api/topology?scope=local, premier rendu rapide) : saute les sources EXTERNES
 * lentes (Nutanix, Docker distants, LXD, AD) — le frontend enchaîne aussitôt le fetch complet et
 * remplace ce premier graphe partiel par le graphe entier dès qu'il est prêt. */
export type TopologyScope = "full" | "local";

/** Même ordre de préférence que la détection du port au déploiement (services/reverseProxy.ts). */
const PREFERRED_HTTP_PORTS = [80, 8080, 8000, 3000, 5000];

/**
 * Ports RÉELLEMENT publiés sur l'hôte (TCP uniquement), les ports HTTP usuels d'abord : de quoi
 * proposer un lien direct sur la carte du nœud quand aucun sous-domaine ne le sert. Un port
 * seulement exposé (jamais publié) n'est joignable depuis aucun navigateur : il n'apparaît pas.
 */
function publishedHttpPorts(ports: { PublicPort?: number; Type?: string }[] | undefined): number[] {
  const published = [...new Set((ports ?? []).filter((p) => p.Type !== "udp" && p.PublicPort).map((p) => p.PublicPort!))];
  return published.sort((a, b) => {
    const rankA = PREFERRED_HTTP_PORTS.indexOf(a);
    const rankB = PREFERRED_HTTP_PORTS.indexOf(b);
    if (rankA !== rankB) return (rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA) - (rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB);
    return a - b;
  });
}

export async function getTopology(scope: TopologyScope = "full"): Promise<Topology> {
  const docker = await getClient();
  const external = scope === "full";
  const { vmNodes: nutanixVmNodes, hostNodes: nutanixHostNodes, hostEdges: nutanixHostEdges } = external
    ? await getNutanixTopologyParts()
    : { vmNodes: [], hostNodes: [], hostEdges: [] };
  // Nœuds "host" Docker distant/LXD : indépendants eux aussi de la joignabilité du démon LOCAL
  // (ce sont d'autres hôtes) — récupérés que Docker local soit joignable ou non, même principe que
  // Nutanix ci-dessus.
  const remoteDockerHostNodes = external ? await getRemoteDockerHostNodes() : [];
  const lxcHostNodes = external ? await getLxcHostNodes() : [];
  // Appliance HYCU : source EXTERNE lente au même titre que Nutanix (appels HTTPS réels) — jamais
  // dans le premier rendu `?scope=local`, et annotée APRÈS les VMs Nutanix dont elle dépend.
  const hycuParts = external ? await getHycuTopologyParts(nutanixVmNodes) : { nodes: [], edges: [] };
  const localDockerNode = await getLocalDockerEnvNode();
  // Racine MASTER "QUAI" : chaque ENVIRONNEMENT (Docker local/distant, cluster Nutanix, LXD) s'y
  // rattache par une arête "hosts" — jamais les nœuds hors-infra (cron, backup, iac,
  // gitops, automation), qui ne sont pas des environnements.
  const environmentNodeIds = [
    localDockerNode.id,
    ...remoteDockerHostNodes.map((n) => n.id),
    ...nutanixHostNodes.filter((n) => n.hostKind === "nutanix-cluster").map((n) => n.id),
    ...lxcHostNodes.map((n) => n.id),
  ];
  const masterNode: TopologyNode = {
    id: QUAI_MASTER_NODE_ID,
    kind: "host",
    hostKind: "quai-master",
    label: "QUAI",
    subtitle: `${environmentNodeIds.length} environnement${environmentNodeIds.length > 1 ? "s" : ""}`,
    status: "running",
  };
  // L'appliance HYCU se rattache elle aussi au master (intégration à part entière) mais ne compte
  // PAS comme un environnement dans le sous-titre ci-dessus : elle n'héberge rien.
  const masterEdges: TopologyEdge[] = [...environmentNodeIds, ...hycuParts.nodes.map((n) => n.id)].map((id) => ({
    id: `hosts:quai-master:${id}`,
    source: QUAI_MASTER_NODE_ID,
    target: id,
    kind: "hosts",
  }));
  // Cron jobs/sauvegardes (voir getCronJobNodes/getBackupNodes ci-dessus) : indépendants eux
  // aussi de la joignabilité Docker locale — leurs DÉFINITIONS sont de simples lectures JSON,
  // même principe que Nutanix/host ci-dessus.
  const cronJobNodes = await getCronJobNodes();
  const backupNodes = await getBackupNodes();
  // Workspaces Infra-as-code (voir getIacWorkspaceNodes ci-dessus) : indépendants eux aussi de la
  // joignabilité Docker locale — une DÉFINITION de workspace est une simple lecture JSON, même
  // principe que cron jobs/sauvegardes ci-dessus (seule l'EXÉCUTION d'un run dépend d'un binaire
  // tofu/ansible-playbook/packer, jamais de Docker lui-même).
  const iacWorkspaceNodes = await getIacWorkspaceNodes();
  // Templates d'images (voir getImageTemplateParts ci-dessus) : mêmes propriétés d'indépendance
  // que les workspaces IaC — une simple lecture JSON, jamais dépendant de Docker/Nutanix.
  const imageTemplateParts = await getImageTemplateParts();
  // Dépôt Git source GitOps (voir getGitOpsSourceNode ci-dessus) : indépendant lui aussi de la
  // joignabilité Docker locale, [] tant que GITOPS_REPO_URL n'a jamais été configuré.
  const gitopsSourceNodes = await getGitOpsSourceNode();
  // Nœuds/arêtes du moteur d'automatisation (voir getAutomationNodes ci-dessus) : indépendants
  // eux aussi de la joignabilité Docker locale — une DÉFINITION de nœud est une simple lecture
  // JSON, seule l'EXÉCUTION d'une action en dépend parfois (ex: container-action), jamais la
  // liste elle-même.
  const automationParts = await getAutomationNodes();
  // Groupements (voir topologyGroupsStore.ts) : indépendants de la joignabilité Docker (une simple
  // lecture JSON en mémoire), inclus dans les deux chemins de retour pour que le frontend garde
  // toujours la même forme de réponse à traiter.
  const groups = await listGroups();
  const staticNodes: TopologyNode[] = [
    masterNode,
    localDockerNode,
    ...nutanixVmNodes,
    ...nutanixHostNodes,
    ...remoteDockerHostNodes,
    ...lxcHostNodes,
    ...cronJobNodes,
    ...backupNodes,
    ...iacWorkspaceNodes,
    ...imageTemplateParts.nodes,
    ...gitopsSourceNodes,
    ...automationParts.nodes,
    ...hycuParts.nodes,
  ];
  const staticEdges: TopologyEdge[] = [
    ...masterEdges,
    ...nutanixHostEdges,
    ...automationParts.edges,
    ...imageTemplateParts.edges,
    ...hycuParts.edges,
  ];
  // Dernier essai RÉEL de rafraîchissement Nutanix (voir services/nutanix.ts#lastKnownNutanixPoll,
  // mis à jour PAR getNutanixTopologyParts ci-dessus via getNutanixVms) — lu APRÈS, jamais avant,
  // l'appel qui vient de le produire. `undefined` (jamais un objet vide fabriqué) tant que Nutanix
  // n'a jamais été configuré ou jamais encore pollé depuis le démarrage du process.
  const nutanixLastPoll = lastKnownNutanixPoll() ?? undefined;
  const empty: Topology = {
    nodes: staticNodes,
    edges: staticEdges,
    generatedAt: new Date().toISOString(),
    groups,
    ...(nutanixLastPoll ? { nutanixLastPoll } : {}),
  };
  if (!(await isDockerReachable(docker))) return empty;

  try {
    const [containers, volumesResponse, networks, imagesToUpdate, gitopsFiles, allScans, proxyRoutes] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listVolumes(),
      docker.listNetworks(),
      getImages("update").catch(() => []),
      listGitOpsFiles().catch(() => []),
      listAllScans().catch(() => []),
      listRoutes().catch(() => []),
    ]);

    // "name:tag" des images ayant une mise à jour disponible — même format que ContainerInfo#Image.
    const updateAvailableImages = new Set(imagesToUpdate.map((i) => `${i.name}:${i.currentTag}`));
    const driftFilePaths = gitopsFiles.filter((f) => f.drift).map((f) => f.path);
    // Sous-domaines réellement associés à CE conteneur (rapprochement par targetContainerId — voir
    // services/reverseProxy.ts, id Docker brut, pas préfixé "container:") — plusieurs routes
    // peuvent cibler le même conteneur (rare mais valide), d'où un tableau. HTTPS : Caddy sert
    // désormais toujours en TLS interne pour les routes proxyfiées (voir reverseProxy.ts en-tête).
    const domainsByContainerId = new Map<string, string[]>();
    // Routes visant une adresse "hôte:port" plutôt qu'un conteneur (cas de QUAI se servant
    // lui-même) : le port publié sur cet hôte identifie le conteneur qui répond réellement.
    const subdomainsByPublishedPort = new Map<number, string[]>();
    for (const route of proxyRoutes) {
      if (route.targetContainerId) {
        const list = domainsByContainerId.get(route.targetContainerId) ?? [];
        list.push(`https://${route.subdomain}`);
        domainsByContainerId.set(route.targetContainerId, list);
      } else if (route.targetHost && route.targetPort) {
        const list = subdomainsByPublishedPort.get(route.targetPort) ?? [];
        list.push(`https://${route.subdomain}`);
        subdomainsByPublishedPort.set(route.targetPort, list);
      }
    }

    // Snapshot d'utilisation par conteneur, en parallèle (chaque appel est déjà borné par un
    // timeout côté docker.ts) — même approche que docker.ts#getDockerContainers.
    const usages = await Promise.all(containers.map((c) => readContainerUsage(docker, c.Id)));
    // État de santé Docker natif, en parallèle lui aussi — requête distincte de readContainerUsage
    // ci-dessus (inspect() vs stats(), voir docker.ts#readContainerHealth), pas de doublon réseau.
    const healthStatuses = await Promise.all(containers.map((c) => readContainerHealth(docker, c.Id)));

    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];

    // --- Étape 1 : un premier passage sur les conteneurs COLLECTE seulement (aucun edge/attachment
    // décidé ici) — savoir si une ressource est "partagée" exige d'avoir vu TOUS les conteneurs qui
    // la référencent, impossible à trancher pendant qu'on itère un seul conteneur à la fois.
    interface MountRef {
      volumeName: string;
      destination: string;
      readOnly: boolean;
    }
    interface NetworkRef {
      networkId: string;
      networkName: string;
      ipAddress?: string;
    }
    const containerMounts = new Map<string, MountRef[]>(); // containerNodeId -> ses montages volume
    const containerNets = new Map<string, NetworkRef[]>(); // containerNodeId -> ses attaches network
    const volumeContainerIds = new Map<string, Set<string>>(); // nom de volume -> conteneurs qui le montent
    // Une seule passe O(S) sur tout l'historique de scans (voir buildVulnSummaryByImage ci-dessus),
    // consultée en O(1) par conteneur ci-dessous plutôt que reparcourue C fois.
    const vulnSummaryByImage = buildVulnSummaryByImage(allScans);

    containers.forEach((c, index) => {
      const containerNodeId = `container:${c.Id}`;
      const name = primaryContainerName(c.Names, c.Id);
      const usage = usages[index]!;
      const healthAndLimits = healthStatuses[index]!;
      // Voir ensureImageTag ci-dessus (bug réel corrigé le 14/08/2026) — normalisé UNE FOIS ici,
      // réutilisé pour les trois rapprochements par "name:tag" ci-dessous (badge vulnérabilités,
      // subtitle exposé au frontend, badge MàJ dispo) plutôt que de répéter l'appel trois fois.
      const image = ensureImageTag(c.Image);
      const vulnSummary = vulnSummaryByImage.get(image) ?? null;
      const published = publishedHttpPorts(c.Ports);
      const viaPublishedPort = published.flatMap((port) => subdomainsByPublishedPort.get(port) ?? []);
      const domains = domainsByContainerId.get(c.Id) ?? (viaPublishedPort.length > 0 ? viaPublishedPort : undefined);
      const publishedPorts = domains?.length ? undefined : published;
      nodes.push({
        id: containerNodeId,
        kind: "container",
        label: name,
        subtitle: image,
        status: mapState(c.State),
        cpuPercent: usage.cpuPercent,
        memBytes: usage.memBytes,
        updateAvailable: updateAvailableImages.has(image),
        drift: driftFilePaths.some((path) => containerMatchesGitOpsFile(name, path)),
        ...(vulnSummary ? { vulnCritical: vulnSummary.vulnCritical, vulnHigh: vulnSummary.vulnHigh } : {}),
        healthStatus: healthAndLimits.healthStatus,
        // Limites RÉELLEMENT configurées (voir docker.ts#ContainerHealthAndLimits) — permettent au
        // frontend une carte d'alerte "Mémoire élevée" (façon Railway) UNIQUEMENT quand une vraie
        // limite existe, jamais un seuil absolu inventé en son absence (topologyGraphShared.tsx).
        ...(healthAndLimits.memoryLimitBytes ? { memoryLimitBytes: healthAndLimits.memoryLimitBytes } : {}),
        ...(healthAndLimits.nanoCpus ? { nanoCpus: healthAndLimits.nanoCpus } : {}),
        ...(domains && domains.length > 0 ? { domains } : {}),
        ...(publishedPorts && publishedPorts.length > 0 ? { publishedPorts } : {}),
      });
      // Rattachement "Docker local" -> conteneur UNIQUEMENT (un volume partagé a déjà son arête
      // "mount", un réseau est un tiroir — pas de surcharge visuelle).
      edges.push({ id: `hosts:docker-local:${c.Id}`, source: LOCAL_DOCKER_NODE_ID, target: containerNodeId, kind: "hosts" });

      const mounts: MountRef[] = [];
      for (const mount of c.Mounts ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = mount as any;
        const volumeName: string | undefined = m.Name;
        if (!volumeName || mount.Type !== "volume") continue; // pas de nœud/brique pour les bind mounts (chemins hôte, pas des ressources Docker)
        mounts.push({ volumeName, destination: m.Destination ?? "", readOnly: m.RW === false });
        if (!volumeContainerIds.has(volumeName)) volumeContainerIds.set(volumeName, new Set());
        volumeContainerIds.get(volumeName)!.add(containerNodeId);
      }
      containerMounts.set(containerNodeId, mounts);

      const nets: NetworkRef[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containerNetworks: Record<string, { NetworkID?: string; IPAddress?: string }> =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).NetworkSettings?.Networks ?? {};
      for (const [networkName, net] of Object.entries(containerNetworks)) {
        const networkId = net.NetworkID ?? networkName;
        // IPAddress est déjà dans le résumé listContainers() (EndpointSettings) — "" tant qu'aucune
        // IP n'est attribuée (conteneur arrêté), jamais une adresse fabriquée.
        nets.push({ networkId, networkName, ...(net.IPAddress ? { ipAddress: net.IPAddress } : {}) });
      }
      containerNets.set(containerNodeId, nets);
    });

    // --- Étape 2 : VOLUMES — décide "nœud top-level + arêtes" vs "tiroir attaché au seul conteneur
    // qui le monte" (voir TopologyNode#attachments) : ≥2 conteneurs -> vrai nœud + arêtes ;
    // exactement 1 -> tiroir ; 0 -> orphelin (voir en-tête de fichier).
    // RÉSEAUX — plus aucune décision : depuis le 24/08/2026 ils sont TOUJOURS des tiroirs, jamais
    // des nœuds ni des arêtes (le nœud porte lui-même nom/driver/IP réelle du réseau).
    function isSharedVolume(name: string): boolean {
      return (volumeContainerIds.get(name)?.size ?? 0) >= 2;
    }

    const volumeByName = new Map((volumesResponse.Volumes ?? []).map((v) => [v.Name, v]));
    const networkById = new Map(networks.map((n) => [n.Id, n]));
    const attachmentsByContainer = new Map<string, TopologyNode["attachments"]>();

    for (const [containerNodeId, mounts] of containerMounts) {
      for (const m of mounts) {
        if (isSharedVolume(m.volumeName)) continue; // reste/deviendra un vrai nœud, voir plus bas
        const v = volumeByName.get(m.volumeName);
        if (!v) continue; // n'existe plus réellement sur l'hôte (rare, course entre deux appels) : rien à inventer
        const list = attachmentsByContainer.get(containerNodeId) ?? [];
        list.push({
          kind: "volume",
          id: `volume:${m.volumeName}`,
          label: m.volumeName,
          subtitle: v.Driver,
          ...(m.destination ? { destination: m.destination } : {}),
          readOnly: m.readOnly,
        });
        attachmentsByContainer.set(containerNodeId, list);
      }
    }
    for (const [containerNodeId, nets] of containerNets) {
      for (const ref of nets) {
        // Le nom vient du conteneur lui-même (clé de NetworkSettings.Networks) : un network absent
        // de listNetworks() (course entre deux appels) reste donc affiché, juste sans son driver.
        const n = networkById.get(ref.networkId);
        const list = attachmentsByContainer.get(containerNodeId) ?? [];
        list.push({
          kind: "network",
          id: `network:${ref.networkId}`,
          label: n?.Name ?? ref.networkName,
          subtitle: n?.Driver ?? "",
          networkId: ref.networkId,
          ...(ref.ipAddress ? { ipAddress: ref.ipAddress } : {}),
        });
        attachmentsByContainer.set(containerNodeId, list);
      }
    }
    // Attachements posés sur le TopologyNode conteneur déjà poussé dans `nodes` ci-dessus (étape 1).
    for (const node of nodes) {
      if (node.kind !== "container") continue;
      const attachments = attachmentsByContainer.get(node.id);
      if (attachments && attachments.length > 0) node.attachments = attachments;
    }

    // --- Étape 3 : construit les arêtes UNIQUEMENT pour les ressources restées "vrai nœud". ------
    for (const [containerNodeId, mounts] of containerMounts) {
      const containerId = idFromContainerNodeId(containerNodeId);
      for (const m of mounts) {
        if (!isSharedVolume(m.volumeName)) continue;
        edges.push({
          id: `mount:${containerId}:${m.volumeName}`,
          source: `volume:${m.volumeName}`,
          target: containerNodeId,
          kind: "mount",
          readOnly: m.readOnly,
        });
      }
    }

    // Volumes restés "vrai nœud" (partagés par ≥2 conteneurs) — un volume à conteneur unique
    // n'atteint jamais cette liste (voir attachmentsByContainer ci-dessus), un volume orphelin
    // (0 conteneur) est traité juste après.
    for (const v of volumesResponse.Volumes ?? []) {
      if (!isSharedVolume(v.Name)) continue;
      nodes.push({
        id: `volume:${v.Name}`,
        kind: "volume",
        label: v.Name,
        subtitle: v.Driver,
        status: "running",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...((v as any).CreatedAt ? { createdAt: (v as any).CreatedAt as string } : {}),
      });
    }

    // Volumes orphelins (0 conteneur) : voir en-tête de fichier — vrais nœuds top-level, jamais
    // d'arête. Un RÉSEAU orphelin n'a plus de représentation dans le graphe (aucun nœud porteur sur
    // lequel poser son tiroir) : il reste listé par GET /api/networks, jamais inventé ici.
    for (const v of volumesResponse.Volumes ?? []) {
      if ((volumeContainerIds.get(v.Name)?.size ?? 0) > 0) continue; // référencé par ≥1 conteneur, déjà géré ci-dessus
      nodes.push({
        id: `volume:${v.Name}`,
        kind: "volume",
        label: v.Name,
        subtitle: v.Driver,
        status: "neutral",
        orphan: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...((v as any).CreatedAt ? { createdAt: (v as any).CreatedAt as string } : {}),
      });
    }

    return {
      nodes: [...nodes, ...staticNodes],
      edges: [...edges, ...staticEdges],
      generatedAt: new Date().toISOString(),
      groups,
      ...(nutanixLastPoll ? { nutanixLastPoll } : {}),
    };
  } catch {
    return empty;
  }
}
