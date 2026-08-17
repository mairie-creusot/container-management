/**
 * Graphe visuel de l'infrastructure (façon Railway) : conteneurs, volumes, networks et leurs
 * relations réelles — construit à partir d'UN SEUL appel `docker.listContainers({all:true})`
 * (son résumé inclut déjà Mounts et NetworkSettings.Networks, pas besoin d'un inspect() par
 * conteneur) + listVolumes()/listNetworks() pour les nœuds isolés (pas encore montés/attachés
 * à un conteneur, mais existants sur l'hôte).
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
 * Arêtes "network" enrichies (badge flottant façon Railway, cf. TopologyEdge#ports/private/
 * encrypted dans types.ts et topologyGraphShared.tsx#EdgeBadge) : ports réellement publiés par le
 * conteneur, `Internal` réel du network (Private/Public) et chiffrement natif Docker (`--opt
 * encrypted` d'un network overlay uniquement — absent pour tout autre driver, jamais un "non
 * chiffré" inventé hors sujet). Aucune mesure de latence : QUAI ne fait aucun sondage réseau actif,
 * ce chiffre serait inventé — volontairement absent du badge plutôt que fabriqué.
 *
 * Nœuds "nutanix-vm" (voir getNutanixTopologyParts ci-dessous) : source totalement indépendante de
 * Docker — récupérés et ajoutés au graphe que Docker soit joignable ou non, [] tant que Nutanix
 * n'a jamais été configuré ou si configuré mais injoignable (nutanix.ts#getNutanixVms). Reliées à
 * leur nœud "host" de cluster (voir juste en dessous) par une VRAIE arête `kind: "hosts"` quand le
 * cluster de la VM est déterminable — jamais reliées aux nœuds Docker (aucune relation réelle).
 *
 * Nœud "ad-server" (voir getAdServerNodes ci-dessous) : le contrôleur de domaine/DNS Active
 * Directory synchronisé par les routes de reverse proxy (services/adDns.ts) — même principe que
 * "nutanix-vm" (indépendant de Docker, [] tant que jamais configuré), jamais relié par une arête
 * à un nœud Docker ou Nutanix (aucune donnée ne prouve que c'est la même machine physique/VM).
 *
 * Nœuds "host" (kind "host", champ `hostKind` — voir getNutanixTopologyParts/
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
 *    d'arête "hosts" DU TOUT (voir getNutanixTopologyParts ci-dessous) : jamais de rattachement
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
 * ne sont pas des ressources connectables comme un conteneur/volume/network.
 *
 * Volumes/networks ORPHELINS (existants sur l'hôte Docker mais rattachés à AUCUN conteneur) :
 * décision produit du 13/08/2026 (VolumesPage.tsx/NetworksPage.tsx supprimées, "tout est dans le
 * graphe") — restent de VRAIS nœuds top-level, `orphan: true`, SANS AUCUNE arête (par construction :
 * une arête suppose un conteneur qui référence la ressource, un orphelin n'en a aucun). Le frontend
 * les rend visuellement atténués (topologyGraphShared.tsx) plutôt que de les cacher — un hôte de dev
 * peut en accumuler des dizaines d'autres projets, c'est un compromis de clarté assumé, pas un bug.
 * `inUseBy === 0` / `containerCount === 0` déterminent l'orphelinage (networks internes par défaut
 * bridge/host/none jamais orphelins par convention, voir DEFAULT_NETWORK_NAMES — mêmes réseaux déjà
 * exclus de la notion de "ressource à nettoyer" par TopologyGraph.tsx#nodeMenuItems côté suppression).
 *
 * "Briques" (volumes/networks à conteneur UNIQUE, voir TopologyNode#attachments) : décision prise
 * ICI, côté backend, par ressource — pas au frontend, pour que GET /api/topology reflète déjà le
 * modèle final (le frontend n'a pas à recalculer une notion de "partage" qu'il ne peut pas dériver
 * sans reparcourir toutes les arêtes lui-même). Choix (b) du cahier des charges : un volume/network
 * monté par UN SEUL conteneur (cas de loin le plus fréquent — une stack `docker compose` typique)
 * devient une "brique" listée dans `attachments` du nœud conteneur plutôt qu'un nœud top-level relié
 * par une arête, façon Railway (la ressource s'affiche comme une propriété du service, pas comme un
 * élément du graphe) ; un volume/network RÉELLEMENT partagé par ≥2 conteneurs reste un vrai nœud +
 * arêtes — cette relation-là garde un sens graphique réel (ex : un network applicatif traversé par
 * 5 conteneurs). Un network Docker par défaut (bridge/host/none) reste toujours un vrai nœud, même
 * mono-conteneur : partagé par nature au niveau de l'hôte, et c'est lui qui porte encore le port de
 * connexion glissé-déposé. Pour une ressource "briquée", le glisser-déposer inter-nœuds n'a plus de
 * cible : côté frontend, la connexion container<->network passe désormais AUSSI par une action du
 * menu contextuel du conteneur ("Connecter à un network…", TopologyGraph.tsx), qui fonctionne que le
 * network visé soit une brique ou un vrai nœud — le glisser-déposer historique continue de marcher
 * en plus pour les networks restés des nœuds (partagés/par défaut).
 */

import { config } from "../config.js";
import { getClient, getDockerHostInfo, isDockerReachable, readContainerHealth, readContainerUsage } from "./docker.js";
import { getImages } from "./images.js";
import { listGitOpsFiles } from "./gitops.js";
import { listAllScans } from "./scan.js";
import { getNutanixClusters, getNutanixHosts, getNutanixVms, isNutanixConfigured, lastKnownNutanixPoll } from "./nutanix.js";
import { getEffectiveAdDnsConfig } from "./setupStore.js";
import { lastKnownDnsSync, listRoutes } from "./reverseProxy.js";
import { listGroups } from "./topologyGroupsStore.js";
import { listRemoteDockerEnvironments } from "./remoteDockerStore.js";
import { getLxcEnvironment } from "./lxc.js";
import { getEffectiveLxcConfig } from "./lxcStore.js";
import { listCronJobs } from "./cronJobsStore.js";
import { listCronJobRuns } from "./cronJobsScheduler.js";
import { listBackupDefinitions, listBackupRuns } from "./backupsStore.js";
import { listWorkspaces } from "./iac/workspaces.js";
import { listRuns } from "./iac/runner.js";
import { listAutomationEdges, listAutomationNodes } from "./automationStore.js";
import type { AutomationNode } from "./automationStore.js";
import type {
  AutomationActionConfig,
  AutomationTriggerSource,
  IacEngine,
  NutanixHost,
  NutanixVm,
  ScanResult,
  Topology,
  TopologyEdge,
  TopologyEdgePort,
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

function mapNutanixPowerState(powerState: NutanixVm["powerState"]): TopologyNode["status"] {
  if (powerState === "on") return "running";
  if (powerState === "off") return "stopped";
  return "neutral";
}

function nutanixVmToNode(vm: NutanixVm): TopologyNode {
  return {
    id: `nutanix-vm:${vm.id}`,
    kind: "nutanix-vm",
    label: vm.name,
    subtitle: vm.cluster,
    status: mapNutanixPowerState(vm.powerState),
    numVcpus: vm.numVcpus,
    memoryMib: vm.memoryMib,
    // Placement réel + disques/réseau (voir nutanix.ts#NutanixVm, mission "corrige le j'ai rien" —
    // retour utilisateur du 14/08/2026) : simple report des champs déjà résolus par nutanix.ts,
    // aucun recalcul ici — TopologyNodeDetailPanel.tsx les affiche tels quels.
    ...(vm.hostName ? { nutanixHostName: vm.hostName } : {}),
    // Placement CONFIRMÉ en direct (status.resources.host_reference) vs REPLI sur le dernier hôte
    // assigné/déclaré (spec.resources.host_reference) — voir nutanix.ts#mapVmEntity pour le calcul
    // complet. Consommé UNIQUEMENT par topologyGraphShared.tsx (web) pour la couleur/le pointillé
    // d'une arête "hosts" hôte physique -> VM, jamais recalculé ici.
    ...(typeof vm.hostPlacementConfirmed === "boolean" ? { nutanixHostPlacementConfirmed: vm.hostPlacementConfirmed } : {}),
    ...(vm.disks && vm.disks.length > 0 ? { nutanixDisks: vm.disks } : {}),
    ...(vm.networks && vm.networks.length > 0 ? { nutanixNetworks: vm.networks } : {}),
    // VRAI état d'erreur Prism Central (status.state === "ERROR"), DISTINCT d'une VM simplement
    // éteinte — voir nutanix.ts#mapVmEntity. Absent (pas false) si aucune erreur.
    ...(vm.apiError ? { nutanixApiError: true, ...(vm.apiErrorMessage ? { nutanixApiErrorMessage: vm.apiErrorMessage } : {}) } : {}),
  };
}

function nutanixClusterHostNodeId(clusterUuid: string): string {
  return `host:nutanix-cluster:${clusterUuid}`;
}

/** "host:nutanix-host:<uuid>" — voir nutanixClusterHostNodeId ci-dessus pour le même principe au
 * niveau cluster (préfixe distinct : un cluster ET un hôte physique ne partagent jamais le même
 * uuid côté Prism Central, mais le préfixe garde les deux espaces d'id lisiblement séparés). */
function nutanixHostNodeId(hostUuid: string): string {
  return `host:nutanix-host:${hostUuid}`;
}

/** "256881 Mio" -> "251 Go RAM" (arrondi à l'entier, cohérent avec l'affichage frontend
 * formatMem/topologyGraphShared.tsx) — formaté ici côté backend car ce n'est qu'un sous-titre
 * informatif de nœud, pas une donnée structurée à retraiter côté client (comme pour les autres
 * subtitles de ce fichier, ex: "Cluster Nutanix · N VMs"). */
function formatHostMemorySubtitle(memoryCapacityMib: number): string {
  return `${(memoryCapacityMib / 1024).toFixed(0)} Go RAM`;
}

/**
 * Nœuds VM Nutanix + nœuds "host" (cluster physique ET, niveau intermédiaire, hôte physique AHV) +
 * arêtes réelles qui les relient — une seule fonction pour l'ensemble (plutôt que des appels
 * séparés) : les arêtes ont besoin des VMs, des clusters ET des hôtes physiques en même temps,
 * autant récupérer les trois d'un coup et les combiner ici.
 *
 * Hiérarchie (retour utilisateur du 14/08/2026 : "je devrais voir ce node plus 3 autre vue que jai
 * 3 nutanix et ensuite tout les node vm" / "je doit pouvoir voir sur quelle cluster et sur quelle
 * node chaque vm tourne car defois elle se deplace" — 3 hôtes physiques confirmés en conditions
 * réelles sur l'instance 172.20.0.10:9440) : cluster (nœud "host"/hostKind "nutanix-cluster", déjà
 * existant) -> hôte physique AHV (nœud "host"/hostKind "nutanix-host", NOUVEAU) -> VM. Le
 * rattachement VM -> hôte est réévalué à CHAQUE appel (jamais figé) : `vm.hostUuid` vient de
 * nutanix.ts#getNutanixVms, recalculé à chaque poll depuis `status.resources.host_reference`
 * (placement live) avec repli sur `spec.resources.host_reference` (dernier hôte assigné/déclaré)
 * pour une VM éteinte — voir nutanix.ts#mapVmEntity. Une VM qui a migré en live migration change
 * donc d'arête dès le prochain rafraîchissement du graphe.
 *
 * Bug réel corrigé le 17/08/2026 (retour utilisateur, capture d'écran à l'appui : "ya un probleme
 * dans les edge normalement je doi en avoir que troie la entre ahv et nut 1 nut 2 nut 3 car les vm
 * sont atacher e ceux ci donc ya des edge en trop") : si `vm.hostUuid` est absent OU que l'hôte
 * visé n'est plus dans la liste réellement retournée par getNutanixHosts() à cet instant (course
 * entre deux requêtes), on NE FABRIQUE PLUS d'arête "hosts" DU TOUT pour cette VM — l'ancien repli
 * "rattachement direct au nœud cluster" produisait jusqu'à 6 arêtes en trop sur le nœud cluster
 * (une par VM éteinte sans hôte déterminable, confirmé en conditions réelles sur CLUSTER_AHV_HDV),
 * polluant visuellement le seul invariant que l'utilisateur attend du nœud cluster : au plus une
 * arête PAR HÔTE PHYSIQUE réel, jamais une arête directe vers une VM. Une VM qui reste sans la
 * moindre donnée de placement (jamais démarrée, ou instance Nutanix injoignable) reste un nœud
 * visible dans le graphe, simplement sans arête "hosts" tant qu'aucun placement n'est connu —
 * cohérent avec le reste de ce fichier ("jamais une relation inventée").
 *
 * [] partout si Nutanix n'a jamais été configuré via l'assistant (isNutanixConfigured, même garde
 * que nutanix.ts#getNutanixEnvironment) — ni VM, ni cluster, ni hôte, ni arête inventée. Si
 * configuré mais injoignable, getNutanixVms()/getNutanixClusters()/getNutanixHosts() retombent
 * chacun sur [] indépendamment (même garde intrinsèque à chacun) : le graphe reste honnêtement
 * vide plutôt que partiellement peuplé avec des données obsolètes.
 */
async function getNutanixTopologyParts(): Promise<{ vmNodes: TopologyNode[]; hostNodes: TopologyNode[]; hostEdges: TopologyEdge[] }> {
  if (!(await isNutanixConfigured())) return { vmNodes: [], hostNodes: [], hostEdges: [] };

  const [vms, clusters, hosts] = await Promise.all([getNutanixVms(), getNutanixClusters(), getNutanixHosts()]);
  const vmNodes = vms.map(nutanixVmToNode);

  // Nombre RÉEL de VMs par cluster, déduit des VMs déjà récupérées ci-dessus (pas un second appel
  // réseau) — utilisé uniquement pour un sous-titre informatif sur le nœud "host".
  const vmCountByClusterUuid = new Map<string, number>();
  const vmCountByHostUuid = new Map<string, number>();
  for (const vm of vms) {
    if (vm.clusterUuid) vmCountByClusterUuid.set(vm.clusterUuid, (vmCountByClusterUuid.get(vm.clusterUuid) ?? 0) + 1);
    if (vm.hostUuid) vmCountByHostUuid.set(vm.hostUuid, (vmCountByHostUuid.get(vm.hostUuid) ?? 0) + 1);
  }

  const clusterNodes: TopologyNode[] = clusters.map((c) => {
    const vmCount = vmCountByClusterUuid.get(c.uuid) ?? 0;
    return {
      id: nutanixClusterHostNodeId(c.uuid),
      kind: "host",
      hostKind: "nutanix-cluster",
      label: c.name,
      subtitle: `Cluster Nutanix · ${vmCount} VM${vmCount > 1 ? "s" : ""}`,
      // Un cluster qu'on vient de lister via l'API v3 est par définition joignable à cet instant —
      // pas de notion de "cluster configuré mais injoignable" séparée ici (contrairement à
      // "remote-docker"/"lxc" ci-dessous) : s'il ne l'était pas, getNutanixClusters() ne l'aurait
      // simplement pas renvoyé.
      status: "running",
    };
  });

  const hostPhysicalNodes: TopologyNode[] = hosts.map((h) => {
    const vmCount = vmCountByHostUuid.get(h.id) ?? 0;
    const specParts = [
      typeof h.numCpuCores === "number" ? `${h.numCpuCores} cœurs` : null,
      typeof h.memoryCapacityMib === "number" ? formatHostMemorySubtitle(h.memoryCapacityMib) : null,
    ].filter((p): p is string => p !== null);
    return {
      id: nutanixHostNodeId(h.id),
      kind: "host",
      hostKind: "nutanix-host",
      label: h.name,
      subtitle: [`${vmCount} VM${vmCount > 1 ? "s" : ""}`, ...specParts].join(" · "),
      // Un hôte qu'on vient de lister via l'API v3 est par définition joignable à cet instant —
      // même principe que les nœuds cluster ci-dessus.
      status: "running",
      ...(h.cpuModel ? { nutanixHostCpuModel: h.cpuModel } : {}),
      ...(typeof h.numCpuCores === "number" ? { nutanixHostNumCpuCores: h.numCpuCores } : {}),
      ...(typeof h.numCpuSockets === "number" ? { nutanixHostNumCpuSockets: h.numCpuSockets } : {}),
      ...(typeof h.memoryCapacityMib === "number" ? { nutanixHostMemoryCapacityMib: h.memoryCapacityMib } : {}),
      ...(h.hypervisorFullName ? { nutanixHostHypervisorFullName: h.hypervisorFullName } : {}),
    };
  });

  const knownClusterUuids = new Set(clusters.map((c) => c.uuid));
  const knownHostUuids = new Set(hosts.map((h) => h.id));
  const hostEdges: TopologyEdge[] = [];

  // Cluster -> hôte physique (niveau intermédiaire NOUVEAU) — jamais d'arête vers un cluster qu'on
  // n'a pas pu lister soi-même (course entre les deux appels, cluster supprimé entre-temps...).
  for (const h of hosts) {
    if (!h.clusterUuid || !knownClusterUuids.has(h.clusterUuid)) continue;
    hostEdges.push({ id: `hosts:${h.clusterUuid}:${h.id}`, source: nutanixClusterHostNodeId(h.clusterUuid), target: nutanixHostNodeId(h.id), kind: "hosts" });
  }

  // Hôte physique -> VM (placement réel, voir JSDoc ci-dessus : status.resources.host_reference en
  // priorité, repli spec.resources.host_reference pour une VM éteinte).
  //
  // Repli cluster -> VM RÉINTRODUIT le 17/08/2026 (retiré plus tôt le même jour, puis remis après
  // retour utilisateur : "les vm arreter ici se sont pas relier" — un nœud totalement flottant,
  // sans AUCUNE arête, est pire qu'un rattachement honnêtement affiché comme non confirmé). Ce qui
  // a changé entre-temps : buildTopologyEdges (topologyGraphShared.tsx) sait maintenant distinguer
  // visuellement un placement confirmé en direct (vert plein) d'un placement incertain (gris,
  // tirets larges pour une VM éteinte) — le problème d'origine n'était donc pas "une arête
  // cluster->VM existe", mais "elle ressemblait exactement à une arête hôte->VM confirmée". Une VM
  // sans hôte déterminable par AUCUN des deux champs (status ni spec), ou dont l'hôte référencé
  // n'est plus dans la liste réellement retournée par getNutanixHosts() à cet instant (course entre
  // deux requêtes), se rattache donc au CLUSTER plutôt qu'à un hôte précis — jamais inventé,
  // toujours visuellement distingué comme non confirmé côté frontend.
  for (const vm of vms) {
    if (vm.hostUuid && knownHostUuids.has(vm.hostUuid)) {
      hostEdges.push({ id: `hosts:${vm.hostUuid}:${vm.id}`, source: nutanixHostNodeId(vm.hostUuid), target: `nutanix-vm:${vm.id}`, kind: "hosts" });
    } else if (vm.clusterUuid && knownClusterUuids.has(vm.clusterUuid)) {
      hostEdges.push({ id: `hosts:${vm.clusterUuid}:${vm.id}`, source: nutanixClusterHostNodeId(vm.clusterUuid), target: `nutanix-vm:${vm.id}`, kind: "hosts" });
    }
  }

  return { vmNodes, hostNodes: [...clusterNodes, ...hostPhysicalNodes], hostEdges };
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
 * Nœud "ad-server" (voir services/adDns.ts, types.ts#AdDnsConfig) : le contrôleur de domaine/DNS
 * AD que QUAI synchronise pour les routes de reverse proxy — indépendant de Docker (comme les VMs
 * Nutanix ci-dessus), [] si jamais configuré. `status` reflète le DERNIER essai réel de
 * synchronisation (lastKnownDnsSync, en mémoire process — voir reverseProxy.ts) : "running" =
 * dernière synchro réussie, "stopped" = dernière synchro en échec (KDC injoignable, droits
 * insuffisants...), "neutral" = configuré mais aucune route créée/supprimée depuis le démarrage du
 * process (aucune tentative encore faite, honnêtement "indéterminé" plutôt qu'un statut inventé).
 * PAS de lien/arête vers un éventuel nœud "nutanix-vm" : QUAI n'a aucune donnée reliant réellement
 * ce contrôleur de domaine à une VM Nutanix précise (même principe que l'absence d'arête entre
 * nœuds Docker et VMs Nutanix, voir en-tête de fichier) — à l'utilisateur de le reconnaître
 * visuellement via le libellé (hostname du KDC) si c'est bien la même machine.
 */
async function getAdServerNodes(): Promise<TopologyNode[]> {
  const adDnsConfig = await getEffectiveAdDnsConfig();
  if (!adDnsConfig) return [];
  const lastSync = lastKnownDnsSync();
  const status: TopologyNode["status"] = lastSync ? (lastSync.status === "synced" ? "running" : "stopped") : "neutral";
  return [
    {
      id: `ad-server:${adDnsConfig.kdcHost}`,
      kind: "ad-server",
      label: adDnsConfig.kdcHost,
      subtitle: `Zone DNS ${adDnsConfig.zone}`,
      status,
    },
  ];
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
 * voir mission "tout devient un nœud du graphe") — indépendant de Docker (comme "ad-server" ci-
 * dessus, récupéré que le démon local soit joignable ou non) : la LISTE des définitions ne dépend
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
const IAC_ENGINE_LABEL: Record<IacEngine, string> = { tofu: "OpenTofu", ansible: "Ansible", packer: "Packer" };

/**
 * Un nœud "iac-workspace" par workspace Infra-as-code RÉEL (services/iac/workspaces.ts) — TOUJOURS
 * présent dès qu'il est créé (l'utilisateur l'a explicitement créé via POST /api/iac/workspaces),
 * indépendant de Docker/Nutanix/AD comme "ad-server"/"cron-job"/"backup" ci-dessus (récupéré que
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
 * Nutanix précise (même principe que "ad-server" ci-dessus) — à l'utilisateur de le reconnaître
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

/**
 * Nœud "gitops-source" (voir services/gitops.ts, config.ts#gitops) : LE dépôt Git configuré comme
 * source de vérité GitOps — une config globale UNIQUE (comme "ad-server" pour AD DNS ci-dessus),
 * jamais une liste d'items malgré le nom pluriel du chantier "tout devient un nœud du graphe".
 *
 * Gardé sur `config.gitops.repoUrl` précisément (pas juste "un dépôt local existe") : GITOPS_REPO_PATH
 * a TOUJOURS une valeur par défaut ("./data/gitops", voir config.ts) et gitops.ts l'auto-amorce
 * silencieusement (bootstrapLocalRepo) même sans configuration explicite de l'utilisateur — ce
 * comportement de repli reste inchangé (le badge "Dérive GitOps" des conteneurs, ci-dessous, continue
 * d'en profiter), mais ne justifie PAS d'afficher un nœud dans le graphe : comme pour "ad-server",
 * un nœud représente une INTÉGRATION EXTERNE délibérément configurée, jamais un mécanisme de repli
 * automatique. [] si GITOPS_REPO_URL n'a jamais été renseigné.
 *
 * `status` dérivé du nombre RÉEL de fichiers actuellement en dérive (listGitOpsFiles().filter(f =>
 * f.drift), même source que driftFilePaths ci-dessous) : "running" si aucune dérive (sain), "stopped"
 * dès qu'au moins un fichier dérive (alerte) — toujours déterminable une fois le dépôt configuré,
 * donc jamais de troisième état "neutral" ici (contrairement à "ad-server", où "neutral" couvre
 * l'absence de toute tentative de synchro depuis le démarrage du process).
 *
 * Appel dédié à listGitOpsFiles() (indépendant de celui du bloc Docker plus bas, qui ne tourne que
 * si Docker est joignable ET sert un autre usage — le rapprochement de dérive PAR CONTENEUR) : même
 * principe qu'ad-server/nutanix-vm/host, chaque nœud "statique" récupère sa propre donnée sans
 * dépendre de la disponibilité de Docker. `ensureRepoReady()` (gitops.ts) protège déjà les appels
 * concurrents entre eux (garde anti-chevauchement) ; les deux appels ici restent séquentiels, donc
 * un léger surcoût réseau (un second fetch/pull) uniquement quand GITOPS_REPO_URL est réellement
 * configuré ET Docker joignable au même cycle — accepté pour ce premier lot plutôt que de complexifier
 * la fonction pour partager un résultat entre deux préoccupations indépendantes.
 *
 * PAS d'arête vers un nœud Docker/Nutanix/host : aucune donnée ne prouve un lien réel (même principe
 * que "ad-server" ci-dessus).
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

export async function getTopology(): Promise<Topology> {
  const docker = await getClient();
  const { vmNodes: nutanixVmNodes, hostNodes: nutanixHostNodes, hostEdges: nutanixHostEdges } = await getNutanixTopologyParts();
  const adServerNodes = await getAdServerNodes();
  // Nœuds "host" Docker distant/LXD : indépendants eux aussi de la joignabilité du démon LOCAL
  // (ce sont d'autres hôtes) — récupérés que Docker local soit joignable ou non, même principe que
  // Nutanix/ad-server ci-dessus.
  const remoteDockerHostNodes = await getRemoteDockerHostNodes();
  const lxcHostNodes = await getLxcHostNodes();
  const localDockerNode = await getLocalDockerEnvNode();
  // Racine MASTER "QUAI" : chaque ENVIRONNEMENT (Docker local/distant, cluster Nutanix, LXD) s'y
  // rattache par une arête "hosts" — jamais les nœuds hors-infra (ad-server, cron, backup, iac,
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
  const masterEdges: TopologyEdge[] = environmentNodeIds.map((id) => ({
    id: `hosts:quai-master:${id}`,
    source: QUAI_MASTER_NODE_ID,
    target: id,
    kind: "hosts",
  }));
  // Cron jobs/sauvegardes (voir getCronJobNodes/getBackupNodes ci-dessus) : indépendants eux
  // aussi de la joignabilité Docker locale — leurs DÉFINITIONS sont de simples lectures JSON,
  // même principe que Nutanix/ad-server/host ci-dessus.
  const cronJobNodes = await getCronJobNodes();
  const backupNodes = await getBackupNodes();
  // Workspaces Infra-as-code (voir getIacWorkspaceNodes ci-dessus) : indépendants eux aussi de la
  // joignabilité Docker locale — une DÉFINITION de workspace est une simple lecture JSON, même
  // principe que cron jobs/sauvegardes ci-dessus (seule l'EXÉCUTION d'un run dépend d'un binaire
  // tofu/ansible-playbook/packer, jamais de Docker lui-même).
  const iacWorkspaceNodes = await getIacWorkspaceNodes();
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
    ...adServerNodes,
    ...remoteDockerHostNodes,
    ...lxcHostNodes,
    ...cronJobNodes,
    ...backupNodes,
    ...iacWorkspaceNodes,
    ...gitopsSourceNodes,
    ...automationParts.nodes,
  ];
  const staticEdges: TopologyEdge[] = [...masterEdges, ...nutanixHostEdges, ...automationParts.edges];
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
    for (const route of proxyRoutes) {
      if (!route.targetContainerId) continue;
      const list = domainsByContainerId.get(route.targetContainerId) ?? [];
      list.push(`https://${route.subdomain}`);
      domainsByContainerId.set(route.targetContainerId, list);
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
    }
    const containerMounts = new Map<string, MountRef[]>(); // containerNodeId -> ses montages volume
    const containerNets = new Map<string, NetworkRef[]>(); // containerNodeId -> ses attaches network
    const volumeContainerIds = new Map<string, Set<string>>(); // nom de volume -> conteneurs qui le montent
    const networkContainerIds = new Map<string, Set<string>>(); // id de network -> conteneurs attachés
    // containerNodeId -> ports RÉELLEMENT publiés (docker.listContainers()[].Ports, déjà dans le
    // résumé) — voir TopologyEdge#ports (apps/api/src/types.ts) pour la limite d'honnêteté du champ.
    const containerPorts = new Map<string, TopologyEdgePort[]>();
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
      const domains = domainsByContainerId.get(c.Id);
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
      });
      // Rattachement "Docker local" -> conteneur UNIQUEMENT (les volumes/networks ont déjà leurs
      // arêtes mount/network — pas de surcharge visuelle).
      edges.push({ id: `hosts:docker-local:${c.Id}`, source: LOCAL_DOCKER_NODE_ID, target: containerNodeId, kind: "hosts" });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPorts: any[] = (c as any).Ports ?? [];
      const seenPorts = new Set<string>();
      const ports: TopologyEdgePort[] = [];
      for (const p of rawPorts) {
        if (typeof p.PrivatePort !== "number") continue; // port privé absent = entrée inexploitable, jamais inventée
        const protocol: "tcp" | "udp" = p.Type === "udp" ? "udp" : "tcp";
        const publicPort: number | undefined = typeof p.PublicPort === "number" ? p.PublicPort : undefined;
        const key = `${protocol}:${p.PrivatePort}:${publicPort ?? ""}`;
        if (seenPorts.has(key)) continue; // Docker répète la même entrée pour 0.0.0.0 ET :: (IPv4/IPv6)
        seenPorts.add(key);
        ports.push({ protocol, privatePort: p.PrivatePort, ...(publicPort !== undefined ? { publicPort } : {}) });
      }
      containerPorts.set(containerNodeId, ports);

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
      const containerNetworks: Record<string, { NetworkID?: string }> = (c as any).NetworkSettings?.Networks ?? {};
      for (const [networkName, net] of Object.entries(containerNetworks)) {
        const networkId = net.NetworkID ?? networkName;
        nets.push({ networkId, networkName });
        if (!networkContainerIds.has(networkId)) networkContainerIds.set(networkId, new Set());
        networkContainerIds.get(networkId)!.add(containerNodeId);
      }
      containerNets.set(containerNodeId, nets);
    });

    // --- Étape 2 : décide, PAR RESSOURCE, "nœud top-level + arêtes" vs "brique attachée au seul
    // conteneur qui la monte" (voir TopologyNode#attachments, apps/api/src/types.ts) :
    //   - ≥ 2 conteneurs distincts la référencent -> reste un vrai nœud + arêtes (relation graphique
    //     utile, ex : un network applicatif partagé par 5 conteneurs).
    //   - exactement 1 conteneur -> devient une brique (le cas le plus fréquent, correspond à
    //     l'intention Railway : une ressource dédiée à UN service s'affiche comme une propriété de
    //     ce service, pas comme un nœud du graphe reliée par une arête).
    //   - 0 conteneur -> orphelin, exclu comme avant (voir en-tête de fichier).
    // Un network Docker PAR DÉFAUT (bridge/host/none) reste toujours un vrai nœud même à 1 seul
    // conteneur attaché : partagé "par nature" (toute l'infra Docker de l'hôte le traverse), et
    // c'est là que le glisser-connecter/clic droit "Déconnecter" doivent rester disponibles sans
    // détour — même exclusion que TopologyGraph.tsx#nodeMenuItems côté suppression.
    const DEFAULT_NETWORK_NAMES = new Set(["bridge", "host", "none"]);
    const networkNameById = new Map<string, string>();
    for (const nets of containerNets.values()) {
      for (const ref of nets) networkNameById.set(ref.networkId, ref.networkName);
    }
    function isSharedVolume(name: string): boolean {
      return (volumeContainerIds.get(name)?.size ?? 0) >= 2;
    }
    function isSharedOrDefaultNetwork(id: string): boolean {
      if ((networkContainerIds.get(id)?.size ?? 0) >= 2) return true;
      return DEFAULT_NETWORK_NAMES.has(networkNameById.get(id) ?? "");
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
        if (isSharedOrDefaultNetwork(ref.networkId)) continue;
        const n = networkById.get(ref.networkId);
        if (!n) continue;
        const list = attachmentsByContainer.get(containerNodeId) ?? [];
        list.push({ kind: "network", id: `network:${ref.networkId}`, label: n.Name, subtitle: n.Driver });
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
    for (const [containerNodeId, nets] of containerNets) {
      const containerId = idFromContainerNodeId(containerNodeId);
      const ports = containerPorts.get(containerNodeId) ?? [];
      for (const ref of nets) {
        if (!isSharedOrDefaultNetwork(ref.networkId)) continue;
        const n = networkById.get(ref.networkId);
        edges.push({
          id: `net:${containerId}:${ref.networkId}`,
          source: containerNodeId,
          target: `network:${ref.networkId}`,
          kind: "network",
          ...(ports.length > 0 ? { ports } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(n ? { private: !!(n as any).Internal } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(n && n.Driver === "overlay" ? { encrypted: (n as any).Options?.encrypted !== undefined } : {}),
        });
      }
    }

    // Volumes/networks restés "vrai nœud" (partagés par ≥2 conteneurs, ou network par défaut) —
    // les ressources à conteneur unique n'atteignent jamais cette liste, voir attachmentsByContainer
    // ci-dessus. Toujours pas "tous les volumes Docker" : un volume/network orphelin (0 conteneur)
    // reste exclu, comme avant.
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

    for (const n of networks) {
      if (!isSharedOrDefaultNetwork(n.Id)) continue;
      nodes.push({
        id: `network:${n.Id}`,
        kind: "network",
        label: n.Name,
        subtitle: n.Driver,
        status: "running",
        ...(n.Created ? { createdAt: n.Created } : {}),
      });
    }

    // Orphelins (0 conteneur) : voir en-tête de fichier — vrais nœuds top-level, jamais d'arête.
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
    for (const n of networks) {
      if (DEFAULT_NETWORK_NAMES.has(n.Name)) continue; // jamais orphelins par convention
      if ((networkContainerIds.get(n.Id)?.size ?? 0) > 0) continue;
      nodes.push({
        id: `network:${n.Id}`,
        kind: "network",
        label: n.Name,
        subtitle: n.Driver,
        status: "neutral",
        orphan: true,
        ...(n.Created ? { createdAt: n.Created } : {}),
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
