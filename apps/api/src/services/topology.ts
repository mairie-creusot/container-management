/**
 * Graphe visuel de l'infrastructure (façon Railway) : conteneurs, volumes, networks et leurs
 * relations réelles — construit à partir d'UN SEUL appel `docker.listContainers({all:true})`
 * (son résumé inclut déjà Mounts et NetworkSettings.Networks, pas besoin d'un inspect() par
 * conteneur) + listVolumes()/listNetworks() pour les nœuds isolés (pas encore montés/attachés
 * à un conteneur, mais existants sur l'hôte).
 */

import { getClient, isDockerReachable } from "./docker.js";
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

export async function getTopology(): Promise<Topology> {
  const docker = await getClient();
  const empty: Topology = { nodes: [], edges: [], generatedAt: new Date().toISOString() };
  if (!(await isDockerReachable(docker))) return empty;

  try {
    const [containers, volumesResponse, networks] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listVolumes(),
      docker.listNetworks(),
    ]);

    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];
    const referencedVolumeNames = new Set<string>();
    const referencedNetworkIds = new Set<string>();

    for (const c of containers) {
      const containerNodeId = `container:${c.Id}`;
      nodes.push({
        id: containerNodeId,
        kind: "container",
        label: primaryContainerName(c.Names, c.Id),
        subtitle: c.Image,
        status: mapState(c.State),
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
    }

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
