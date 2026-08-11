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
 * Ces deux derniers sont du best-effort par nom — aucune donnée arbitraire n'est inventée si
 * rien ne correspond (le nœud reste simplement sans badge).
 */

import { getClient, isDockerReachable, readContainerUsage } from "./docker.js";
import { getImages } from "./images.js";
import { listGitOpsFiles } from "./gitops.js";
import type { Topology, TopologyEdge, TopologyNode } from "../types.js";

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

export async function getTopology(): Promise<Topology> {
  const docker = await getClient();
  const empty: Topology = { nodes: [], edges: [], generatedAt: new Date().toISOString() };
  if (!(await isDockerReachable(docker))) return empty;

  try {
    const [containers, volumesResponse, networks, imagesToUpdate, gitopsFiles] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listVolumes(),
      docker.listNetworks(),
      getImages("update").catch(() => []),
      listGitOpsFiles().catch(() => []),
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

    return { nodes, edges, generatedAt: new Date().toISOString() };
  } catch {
    return empty;
  }
}
