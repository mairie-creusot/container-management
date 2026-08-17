import { describe, expect, it } from "vitest";
import { EDGE_KIND_LABEL, buildTopologyEdges, edgeBadgeItems, isActiveEdgeState, nutanixVmHostEdgeState } from "./topologyGraphShared";
import type { TopologyEdge, TopologyNode } from "@/types";

/**
 * Mission du 17/08/2026 : "j'ai impression que le systeme n'est pas coherent entre nutanyx et le
 * systeme de container c'est comme si la logique etait seprarer en deux" — une arête "hosts" hôte
 * physique -> VM Nutanix doit désormais lire la MÊME grille couleur/pointillé que les arêtes
 * conteneur (EdgeHealthState/EDGE_STATE_COLOR), jamais un second système parallèle. Ces tests
 * couvrent exactement la grille validée par l'utilisateur :
 *  - VM allumée, placement confirmé en direct -> vert ("healthy"), plein.
 *  - VM allumée, placement replié sur le dernier hôte assigné -> orange ("starting"), tirets fins.
 *  - VM éteinte -> gris ("stopped"), tirets larges — EXACTEMENT le même code visuel qu'un
 *    conteneur arrêté.
 *  - VRAI échec Prism Central (jamais un simple arrêt) -> rouge ("unhealthy").
 *  - Cluster -> hôte physique (PAS hôte -> VM) : reste neutre/gris/plein, INCHANGÉ.
 */

function vmNode(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id: "nutanix-vm:vm-1",
    kind: "nutanix-vm",
    label: "vm-1",
    subtitle: "Cluster Mairie",
    status: "running",
    ...overrides,
  };
}

describe("nutanixVmHostEdgeState", () => {
  it("VM éteinte -> stopped, tirets larges (même code visuel qu'un conteneur arrêté), quel que soit le placement", () => {
    expect(nutanixVmHostEdgeState(vmNode({ status: "stopped", nutanixHostPlacementConfirmed: true }))).toEqual({
      state: "stopped",
      strokeDasharray: "2 8",
    });
    expect(nutanixVmHostEdgeState(vmNode({ status: "stopped", nutanixHostPlacementConfirmed: false }))).toEqual({
      state: "stopped",
      strokeDasharray: "2 8",
    });
  });

  it("VM allumée, placement confirmé en direct -> healthy, plein", () => {
    expect(nutanixVmHostEdgeState(vmNode({ status: "running", nutanixHostPlacementConfirmed: true }))).toEqual({
      state: "healthy",
      strokeDasharray: undefined,
    });
  });

  it("VM allumée, placement replié sur le dernier hôte assigné -> starting, tirets fins", () => {
    expect(nutanixVmHostEdgeState(vmNode({ status: "running", nutanixHostPlacementConfirmed: false }))).toEqual({
      state: "starting",
      strokeDasharray: "4 4",
    });
  });

  it("VM allumée avec un VRAI échec Prism Central -> unhealthy, jamais pour un simple arrêt", () => {
    expect(
      nutanixVmHostEdgeState(vmNode({ status: "running", nutanixHostPlacementConfirmed: true, nutanixApiError: true })),
    ).toEqual({ state: "unhealthy", strokeDasharray: undefined });
    expect(
      nutanixVmHostEdgeState(vmNode({ status: "running", nutanixHostPlacementConfirmed: false, nutanixApiError: true })),
    ).toEqual({ state: "unhealthy", strokeDasharray: "4 4" });
    // "stopped" prime toujours sur apiError (même règle que "stopped" != healthStatus côté
    // conteneurs) — un arrêt volontaire n'est jamais une panne, même si un état d'erreur résiduel
    // traînait par ailleurs.
    expect(nutanixVmHostEdgeState(vmNode({ status: "stopped", nutanixApiError: true }))).toEqual({
      state: "stopped",
      strokeDasharray: "2 8",
    });
  });

  it("power_state \"unknown\" (status neutral) -> none, plein : aucun signal exploitable, jamais un état inventé", () => {
    expect(nutanixVmHostEdgeState(vmNode({ status: "neutral" }))).toEqual({ state: "none", strokeDasharray: undefined });
  });
});

describe("isActiveEdgeState — particules de flux réservées aux arêtes actives (vague 3)", () => {
  it("healthy/starting sont actifs ; stopped/none/unhealthy (et l'absence d'état) jamais", () => {
    expect(isActiveEdgeState("healthy")).toBe(true);
    expect(isActiveEdgeState("starting")).toBe(true);
    expect(isActiveEdgeState("stopped")).toBe(false);
    expect(isActiveEdgeState("none")).toBe(false);
    expect(isActiveEdgeState("unhealthy")).toBe(false);
    expect(isActiveEdgeState(undefined)).toBe(false);
  });
});

describe("buildTopologyEdges — arêtes \"hosts\"", () => {
  it("cluster -> hôte physique (target kind \"host\") reste neutre/gris/plein, INCHANGÉ", () => {
    const clusterNode: TopologyNode = {
      id: "host:nutanix-cluster:c1",
      kind: "host",
      hostKind: "nutanix-cluster",
      label: "Cluster",
      subtitle: "Cluster Nutanix",
      status: "running",
    };
    const hostNode: TopologyNode = {
      id: "host:nutanix-host:h1",
      kind: "host",
      hostKind: "nutanix-host",
      label: "HDVNUTA1",
      subtitle: "1 VM",
      status: "running",
    };
    const nodesById = new Map([
      [clusterNode.id, clusterNode],
      [hostNode.id, hostNode],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:c1:h1", source: clusterNode.id, target: hostNode.id, kind: "hosts" }];

    const [edge] = buildTopologyEdges(edges, nodesById);

    expect(edge?.data).toMatchObject({ state: "none" });
    expect(edge?.style).not.toHaveProperty("strokeDasharray");
    expect(edge?.animated).toBe(false);
    expect(edge?.data).not.toHaveProperty("nutanixPlacementConfirmed");
  });

  it("hôte physique -> VM confirmée en direct -> healthy, plein, badge \"placement confirmé\"", () => {
    const hostNode: TopologyNode = {
      id: "host:nutanix-host:h1",
      kind: "host",
      hostKind: "nutanix-host",
      label: "HDVNUTA1",
      subtitle: "1 VM",
      status: "running",
    };
    const vm = vmNode({ status: "running", nutanixHostPlacementConfirmed: true });
    const nodesById = new Map([
      [hostNode.id, hostNode],
      [vm.id, vm],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:h1:vm-1", source: hostNode.id, target: vm.id, kind: "hosts" }];

    const [edge] = buildTopologyEdges(edges, nodesById);

    expect(edge?.data).toMatchObject({ state: "healthy", nutanixPlacementConfirmed: true });
    expect((edge?.style as { strokeDasharray?: string })?.strokeDasharray).toBeUndefined();
    expect(edge?.animated).toBe(false); // structurel, jamais de flux animé même pour ce cas
    expect(edge?.className).toContain("topology-edge--healthy");
  });

  it("hôte physique -> VM repliée sur le dernier hôte assigné -> starting, tirets fins, badge \"dernier hôte connu\"", () => {
    const hostNode: TopologyNode = {
      id: "host:nutanix-host:h1",
      kind: "host",
      hostKind: "nutanix-host",
      label: "HDVNUTA1",
      subtitle: "1 VM",
      status: "running",
    };
    const vm = vmNode({ status: "running", nutanixHostPlacementConfirmed: false });
    const nodesById = new Map([
      [hostNode.id, hostNode],
      [vm.id, vm],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:h1:vm-1", source: hostNode.id, target: vm.id, kind: "hosts" }];

    const [edge] = buildTopologyEdges(edges, nodesById);

    expect(edge?.data).toMatchObject({ state: "starting", nutanixPlacementConfirmed: false });
    expect(edge?.style).toMatchObject({ strokeDasharray: "4 4" });
    expect(edge?.className).toContain("topology-edge--starting");
  });

  it("hôte physique -> VM éteinte -> stopped, tirets larges — EXACTEMENT le même code visuel qu'un conteneur arrêté", () => {
    const hostNode: TopologyNode = {
      id: "host:nutanix-host:h1",
      kind: "host",
      hostKind: "nutanix-host",
      label: "HDVNUTA1",
      subtitle: "1 VM",
      status: "running",
    };
    const vm = vmNode({ status: "stopped" });
    const nodesById = new Map([
      [hostNode.id, hostNode],
      [vm.id, vm],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:h1:vm-1", source: hostNode.id, target: vm.id, kind: "hosts" }];

    const [edge] = buildTopologyEdges(edges, nodesById);

    expect(edge?.data).toMatchObject({ state: "stopped" });
    expect(edge?.data).not.toHaveProperty("nutanixPlacementConfirmed"); // pas de badge sur une VM éteinte
    expect(edge?.style).toMatchObject({ strokeDasharray: "2 8" });
    expect(edge?.className).toContain("topology-edge--stopped");
  });

  it("hôte physique -> VM avec un VRAI échec Prism Central -> unhealthy (rouge), pas de badge de placement", () => {
    const hostNode: TopologyNode = {
      id: "host:nutanix-host:h1",
      kind: "host",
      hostKind: "nutanix-host",
      label: "HDVNUTA1",
      subtitle: "1 VM",
      status: "running",
    };
    const vm = vmNode({ status: "running", nutanixHostPlacementConfirmed: true, nutanixApiError: true, nutanixApiErrorMessage: "disk unavailable" });
    const nodesById = new Map([
      [hostNode.id, hostNode],
      [vm.id, vm],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:h1:vm-1", source: hostNode.id, target: vm.id, kind: "hosts" }];

    const [edge] = buildTopologyEdges(edges, nodesById);

    expect(edge?.data).toMatchObject({ state: "unhealthy" });
    expect(edge?.data).not.toHaveProperty("nutanixPlacementConfirmed");
    expect(edge?.className).toContain("topology-edge--unhealthy");
  });

  it("régression : le comportement conteneur (mount/network) n'est pas affecté par cette extension", () => {
    const containerRunning: TopologyNode = {
      id: "container:c1",
      kind: "container",
      label: "app",
      subtitle: "app:latest",
      status: "running",
      healthStatus: "healthy",
    };
    const containerStopped: TopologyNode = {
      id: "container:c2",
      kind: "container",
      label: "worker",
      subtitle: "worker:latest",
      status: "stopped",
      healthStatus: "healthy",
    };
    const network: TopologyNode = { id: "network:n1", kind: "network", label: "app-net", subtitle: "bridge", status: "running" };
    const nodesById = new Map([
      [containerRunning.id, containerRunning],
      [containerStopped.id, containerStopped],
      [network.id, network],
    ]);
    const edges: TopologyEdge[] = [
      { id: "net:c1:n1", source: containerRunning.id, target: network.id, kind: "network" },
      { id: "net:c2:n1", source: containerStopped.id, target: network.id, kind: "network" },
    ];

    const [runningEdge, stoppedEdge] = buildTopologyEdges(edges, nodesById);

    expect(runningEdge?.data).toMatchObject({ state: "healthy" });
    expect(stoppedEdge?.data).toMatchObject({ state: "stopped" });
    expect(stoppedEdge?.style).toMatchObject({ strokeDasharray: "2 8" });
  });
});

describe("EDGE_KIND_LABEL / edgeBadgeItems — pastille de nature du lien (maquette validée)", () => {
  const container: TopologyNode = { id: "container:c1", kind: "container", label: "app", subtitle: "app:latest", status: "running" };
  const network: TopologyNode = { id: "network:n1", kind: "network", label: "app-net", subtitle: "bridge", status: "running" };
  const cluster: TopologyNode = {
    id: "host:nutanix-cluster:c1",
    kind: "host",
    hostKind: "nutanix-cluster",
    label: "Cluster",
    subtitle: "Cluster Nutanix",
    status: "running",
  };
  const host: TopologyNode = {
    id: "host:nutanix-host:h1",
    kind: "host",
    hostKind: "nutanix-host",
    label: "HDVNUTA1",
    subtitle: "1 VM",
    status: "running",
  };

  it("network : NOM RÉEL du network à l'extrémité, repli générique seulement si le nœud est inconnu", () => {
    expect(EDGE_KIND_LABEL.network(container, network)).toBe("réseau app-net");
    expect(EDGE_KIND_LABEL.network(network, container)).toBe("réseau app-net");
    expect(EDGE_KIND_LABEL.network(undefined, undefined)).toBe("réseau");
  });

  it("hosts : « hôte physique » vers un nœud host, « hébergement » vers un conteneur/une VM", () => {
    expect(EDGE_KIND_LABEL.hosts(cluster, host)).toBe("hôte physique");
    expect(EDGE_KIND_LABEL.hosts(host, container)).toBe("hébergement");
  });

  it("mount/automation-flow : libellés fixes", () => {
    expect(EDGE_KIND_LABEL.mount(undefined, container)).toBe("montage");
    expect(EDGE_KIND_LABEL["automation-flow"](undefined, undefined)).toBe("automatisation");
  });

  it("le badge spécifique prime : jamais de libellé générique empilé sur un port publié ou un placement Nutanix", () => {
    expect(
      edgeBadgeItems({ kindLabel: "réseau app-net", ports: [{ protocol: "tcp", privatePort: 5432, publicPort: 5432 }] }).map((i) => i.text),
    ).toEqual(["TCP:5432"]);
    expect(edgeBadgeItems({ kindLabel: "hébergement", nutanixPlacementConfirmed: true }).map((i) => i.text)).toEqual([
      "Placement confirmé",
    ]);
  });

  it("sans badge spécifique, le libellé passe en tête et coexiste avec les qualificatifs (Privé/ro-rw)", () => {
    expect(edgeBadgeItems({ kindLabel: "réseau app-net", private: false, state: "healthy" })).toEqual([
      { text: "réseau app-net", tone: "good" },
      { text: "Public", tone: "neutral" },
    ]);
    expect(edgeBadgeItems({ kindLabel: "montage", readOnly: false, state: "stopped" })).toEqual([
      { text: "montage", tone: "neutral" },
      { text: "rw", tone: "neutral" },
    ]);
  });

  it("couleur héritée de l'état de l'arête : healthy -> good, starting -> warn, unhealthy -> critical, sinon neutre", () => {
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "healthy" })[0]).toMatchObject({ tone: "good" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "starting" })[0]).toMatchObject({ tone: "warn" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "unhealthy" })[0]).toMatchObject({ tone: "critical" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "none" })[0]).toMatchObject({ tone: "neutral" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "stopped" })[0]).toMatchObject({ tone: "neutral" });
  });

  it("buildTopologyEdges pose le libellé dans edge.data pour chaque kind", () => {
    const nodesById = new Map([
      [container.id, container],
      [network.id, network],
      [cluster.id, cluster],
      [host.id, host],
    ]);
    const edges: TopologyEdge[] = [
      { id: "net:c1:n1", source: container.id, target: network.id, kind: "network" },
      { id: "hosts:c1:h1", source: cluster.id, target: host.id, kind: "hosts" },
    ];

    const [networkEdge, hostsEdge] = buildTopologyEdges(edges, nodesById);

    expect(networkEdge?.data).toMatchObject({ kindLabel: "réseau app-net" });
    expect(hostsEdge?.data).toMatchObject({ kindLabel: "hôte physique" });
  });
});
