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
 * Nœuds "nutanix-vm" (voir getNutanixVmNodes ci-dessous) : source totalement indépendante de
 * Docker — récupérés et ajoutés au graphe que Docker soit joignable ou non, jamais reliés par une
 * arête aux nœuds Docker (aucune relation réelle entre les deux dans ce projet), [] tant que
 * Nutanix n'a jamais été configuré ou si configuré mais injoignable (nutanix.ts#getNutanixVms).
 *
 * Nœud "ad-server" (voir getAdServerNodes ci-dessous) : le contrôleur de domaine/DNS Active
 * Directory synchronisé par les routes de reverse proxy (services/adDns.ts) — même principe que
 * "nutanix-vm" (indépendant de Docker, [] tant que jamais configuré), jamais relié par une arête
 * à un nœud Docker ou Nutanix (aucune donnée ne prouve que c'est la même machine physique/VM).
 *
 * Volumes/networks ORPHELINS (existants sur l'hôte Docker mais rattachés à AUCUN conteneur) :
 * délibérément EXCLUS de ce graphe (voir le filtre juste avant leur construction plus bas) pour
 * ne pas le noyer — un hôte de dev peut avoir des dizaines de volumes de cache d'autres projets.
 * Ça ne veut pas dire qu'ils sont invisibles pour l'utilisateur : GET /api/volumes et
 * GET /api/networks renvoient déjà TOUS les volumes/networks réels de l'hôte avec un champ
 * `inUseBy`/`containerCount` calculé à partir des mêmes conteneurs (docker.ts#listVolumes/
 * listNetworks — même logique de rapprochement que referencedVolumeNames/referencedNetworkIds
 * ci-dessous, pas dupliquée : ce fichier ne recalcule rien, il filtre juste le graphe). Un
 * volume/network orphelin est donc `inUseBy === 0` / `containerCount === 0` (networks internes
 * par défaut bridge/host/none exclus de cette notion, jamais des ressources à nettoyer — même
 * exclusion que TopologyGraph.tsx#nodeMenuItems côté suppression). Choix délibéré plutôt qu'une
 * route GET /api/orphans dédiée : VolumesPage.tsx/NetworksPage.tsx (déjà existantes, déjà
 * alimentées par ces mêmes champs) portent le badge "Orphelin" + le filtre + l'action groupée de
 * nettoyage — une vue séparée aurait été une simple redite de ces deux pages.
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

import { getClient, isDockerReachable, readContainerHealth, readContainerUsage } from "./docker.js";
import { getImages } from "./images.js";
import { listGitOpsFiles } from "./gitops.js";
import { listAllScans } from "./scan.js";
import { getNutanixVms, isNutanixConfigured } from "./nutanix.js";
import { getEffectiveAdDnsConfig } from "./setupStore.js";
import { lastKnownDnsSync } from "./reverseProxy.js";
import type { NutanixVm, ScanResult, Topology, TopologyEdge, TopologyEdgePort, TopologyNode } from "../types.js";

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
  };
}

/**
 * Nœuds VM Nutanix, indépendants de Docker (voir en-tête de fichier) — jamais d'arête forcée
 * vers les nœuds Docker, de simples nœuds isolés dans le graphe. [] si Nutanix n'a jamais été
 * configuré via l'assistant (isNutanixConfigured, même garde que nutanix.ts#getNutanixEnvironment)
 * ou si configuré mais injoignable (getNutanixVms() retombe déjà sur [] dans ce cas) — jamais de
 * VM inventée.
 */
async function getNutanixVmNodes(): Promise<TopologyNode[]> {
  if (!(await isNutanixConfigured())) return [];
  const vms = await getNutanixVms();
  return vms.map(nutanixVmToNode);
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

export async function getTopology(): Promise<Topology> {
  const docker = await getClient();
  const nutanixVmNodes = await getNutanixVmNodes();
  const adServerNodes = await getAdServerNodes();
  const empty: Topology = { nodes: [...nutanixVmNodes, ...adServerNodes], edges: [], generatedAt: new Date().toISOString() };
  if (!(await isDockerReachable(docker))) return empty;

  try {
    const [containers, volumesResponse, networks, imagesToUpdate, gitopsFiles, allScans] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listVolumes(),
      docker.listNetworks(),
      getImages("update").catch(() => []),
      listGitOpsFiles().catch(() => []),
      listAllScans().catch(() => []),
    ]);

    // "name:tag" des images ayant une mise à jour disponible — même format que ContainerInfo#Image.
    const updateAvailableImages = new Set(imagesToUpdate.map((i) => `${i.name}:${i.currentTag}`));
    const driftFilePaths = gitopsFiles.filter((f) => f.drift).map((f) => f.path);

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
      const vulnSummary = vulnSummaryByImage.get(c.Image) ?? null;
      nodes.push({
        id: containerNodeId,
        kind: "container",
        label: name,
        subtitle: c.Image,
        status: mapState(c.State),
        cpuPercent: usage.cpuPercent,
        memBytes: usage.memBytes,
        updateAvailable: updateAvailableImages.has(c.Image),
        drift: driftFilePaths.some((path) => containerMatchesGitOpsFile(name, path)),
        ...(vulnSummary ? { vulnCritical: vulnSummary.vulnCritical, vulnHigh: vulnSummary.vulnHigh } : {}),
        healthStatus: healthStatuses[index]!,
      });

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

    return { nodes: [...nodes, ...nutanixVmNodes, ...adServerNodes], edges, generatedAt: new Date().toISOString() };
  } catch {
    return empty;
  }
}
