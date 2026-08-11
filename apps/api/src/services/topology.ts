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
 * Tous best-effort par nom — aucune donnée arbitraire n'est inventée si rien ne correspond (le
 * nœud reste simplement sans badge).
 *
 * Nœuds "nutanix-vm" (voir getNutanixVmNodes ci-dessous) : source totalement indépendante de
 * Docker — récupérés et ajoutés au graphe que Docker soit joignable ou non, jamais reliés par une
 * arête aux nœuds Docker (aucune relation réelle entre les deux dans ce projet), [] tant que
 * Nutanix n'a jamais été configuré ou si configuré mais injoignable (nutanix.ts#getNutanixVms).
 */

import { getClient, isDockerReachable, readContainerUsage } from "./docker.js";
import { getImages } from "./images.js";
import { listGitOpsFiles } from "./gitops.js";
import { listAllScans } from "./scan.js";
import { getNutanixVms, isNutanixConfigured } from "./nutanix.js";
import type { NutanixVm, ScanResult, Topology, TopologyEdge, TopologyNode } from "../types.js";

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
function vulnSummaryForImage(image: string, scans: ScanResult[]): { vulnCritical: number; vulnHigh: number } | null {
  const latestByScanner = new Map<string, ScanResult>();
  for (const scan of scans) {
    if (scan.image !== image || scan.status !== "success") continue;
    const current = latestByScanner.get(scan.scanner);
    if (!current || scan.startedAt > current.startedAt) latestByScanner.set(scan.scanner, scan);
  }
  if (latestByScanner.size === 0) return null;
  let vulnCritical = 0;
  let vulnHigh = 0;
  for (const scan of latestByScanner.values()) {
    vulnCritical = Math.max(vulnCritical, scan.summary.Critical);
    vulnHigh = Math.max(vulnHigh, scan.summary.High);
  }
  return { vulnCritical, vulnHigh };
}

function primaryContainerName(names: string[] | undefined, id: string): string {
  const name = names?.[0] ?? id.slice(0, 12);
  return name.startsWith("/") ? name.slice(1) : name;
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

export async function getTopology(): Promise<Topology> {
  const docker = await getClient();
  const nutanixVmNodes = await getNutanixVmNodes();
  const empty: Topology = { nodes: nutanixVmNodes, edges: [], generatedAt: new Date().toISOString() };
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

    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];
    const referencedVolumeNames = new Set<string>();
    const referencedNetworkIds = new Set<string>();

    containers.forEach((c, index) => {
      const containerNodeId = `container:${c.Id}`;
      const name = primaryContainerName(c.Names, c.Id);
      const usage = usages[index]!;
      const vulnSummary = vulnSummaryForImage(c.Image, allScans);
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
      });

      for (const mount of c.Mounts ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const volumeName: string | undefined = (mount as any).Name;
        if (!volumeName || mount.Type !== "volume") continue; // pas de nœud pour les bind mounts (chemins hôte, pas des ressources Docker)
        referencedVolumeNames.add(volumeName);
        edges.push({
          id: `mount:${c.Id}:${volumeName}`,
          source: `volume:${volumeName}`,
          target: containerNodeId,
          kind: "mount",
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containerNetworks: Record<string, { NetworkID?: string }> = (c as any).NetworkSettings?.Networks ?? {};
      for (const [networkName, net] of Object.entries(containerNetworks)) {
        const networkId = net.NetworkID ?? networkName;
        referencedNetworkIds.add(networkId);
        edges.push({
          id: `net:${c.Id}:${networkId}`,
          source: containerNodeId,
          target: `network:${networkId}`,
          kind: "network",
        });
      }
    });

    // Seuls les volumes/networks RATTACHÉS À AU MOINS UN CONTENEUR ci-dessus sont affichés —
    // avec des dizaines/centaines de volumes orphelins possibles sur un hôte de dev (cache
    // d'autres projets...), tout montrer noierait le graphe. Ce n'est pas "tous les volumes
    // Docker" mais "l'architecture réellement en jeu", comme Railway ne montre que les
    // ressources de ton projet.
    for (const v of volumesResponse.Volumes ?? []) {
      if (!referencedVolumeNames.has(v.Name)) continue;
      nodes.push({ id: `volume:${v.Name}`, kind: "volume", label: v.Name, subtitle: v.Driver, status: "running" });
    }

    for (const n of networks) {
      if (!referencedNetworkIds.has(n.Id)) continue;
      nodes.push({ id: `network:${n.Id}`, kind: "network", label: n.Name, subtitle: n.Driver, status: "running" });
    }

    return { nodes: [...nodes, ...nutanixVmNodes], edges, generatedAt: new Date().toISOString() };
  } catch {
    return empty;
  }
}
