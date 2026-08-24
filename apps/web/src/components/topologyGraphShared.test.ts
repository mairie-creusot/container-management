import { describe, expect, it } from "vitest";
import {
  AUTO_LAYOUT_LEVEL_SPACING,
  AUTO_LAYOUT_SIBLING_SPACING,
  EDGE_KIND_LABEL,
  buildTopologyEdges,
  edgeBadgeItems,
  hostHierarchyPositions,
  isActiveEdgeState,
  nutanixVmHostEdgeState,
} from "./topologyGraphShared";
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

  it("régression : le comportement conteneur (arête \"hosts\" Docker local -> conteneur) n'est pas affecté par cette extension", () => {
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
    const local: TopologyNode = {
      id: "host:docker-local",
      kind: "host",
      hostKind: "docker-env",
      label: "Docker local",
      subtitle: "local",
      status: "running",
    };
    const nodesById = new Map([
      [containerRunning.id, containerRunning],
      [containerStopped.id, containerStopped],
      [local.id, local],
    ]);
    const edges: TopologyEdge[] = [
      { id: "hosts:docker-local:c1", source: local.id, target: containerRunning.id, kind: "hosts" },
      { id: "hosts:docker-local:c2", source: local.id, target: containerStopped.id, kind: "hosts" },
    ];

    const [runningEdge, stoppedEdge] = buildTopologyEdges(edges, nodesById);

    expect(runningEdge?.data).toMatchObject({ state: "healthy" });
    expect(stoppedEdge?.data).toMatchObject({ state: "stopped" });
    // Relation structurelle : jamais de pointillé, quelle que soit la santé du conteneur.
    expect(stoppedEdge?.style).not.toHaveProperty("strokeDasharray");
  });
});

describe("EDGE_KIND_LABEL / edgeBadgeItems — pastille de nature du lien (maquette validée)", () => {
  const container: TopologyNode = { id: "container:c1", kind: "container", label: "app", subtitle: "app:latest", status: "running" };
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

  it("hosts : « hôte physique » vers un nœud host, « hébergement » vers un conteneur/une VM", () => {
    expect(EDGE_KIND_LABEL.hosts(cluster, host)).toBe("hôte physique");
    expect(EDGE_KIND_LABEL.hosts(host, container)).toBe("hébergement");
  });

  it("mount/automation-flow : libellés fixes", () => {
    expect(EDGE_KIND_LABEL.mount(undefined, container)).toBe("montage");
    expect(EDGE_KIND_LABEL["automation-flow"](undefined, undefined)).toBe("automatisation");
  });

  it("le badge spécifique prime : jamais de libellé générique empilé sur un placement Nutanix", () => {
    expect(edgeBadgeItems({ kindLabel: "hébergement", nutanixPlacementConfirmed: true }).map((i) => i.text)).toEqual([
      "Placement confirmé",
    ]);
  });

  it("sans badge spécifique, le libellé passe en tête et coexiste avec le qualificatif ro/rw", () => {
    // stopped -> critical : choix utilisateur explicite ("une machine éteinte doit être rouge").
    expect(edgeBadgeItems({ kindLabel: "montage", readOnly: false, state: "stopped" })).toEqual([
      { text: "montage", tone: "critical" },
      { text: "rw", tone: "neutral" },
    ]);
  });

  it("couleur héritée de l'état de l'arête : healthy -> good, starting -> warn, unhealthy/stopped -> critical, sinon neutre", () => {
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "healthy" })[0]).toMatchObject({ tone: "good" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "starting" })[0]).toMatchObject({ tone: "warn" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "unhealthy" })[0]).toMatchObject({ tone: "critical" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "none" })[0]).toMatchObject({ tone: "neutral" });
    expect(edgeBadgeItems({ kindLabel: "hébergement", state: "stopped" })[0]).toMatchObject({ tone: "critical" });
  });

  it("buildTopologyEdges pose le libellé dans edge.data pour chaque kind", () => {
    const volume: TopologyNode = { id: "volume:v1", kind: "volume", label: "pgdata", subtitle: "local", status: "running" };
    const nodesById = new Map([
      [container.id, container],
      [volume.id, volume],
      [cluster.id, cluster],
      [host.id, host],
    ]);
    const edges: TopologyEdge[] = [
      { id: "mount:c1:v1", source: volume.id, target: container.id, kind: "mount" },
      { id: "hosts:c1:h1", source: cluster.id, target: host.id, kind: "hosts" },
    ];

    const [mountEdge, hostsEdge] = buildTopologyEdges(edges, nodesById);

    expect(mountEdge?.data).toMatchObject({ kindLabel: "montage" });
    expect(hostsEdge?.data).toMatchObject({ kindLabel: "hôte physique" });
  });
});

// --- hostHierarchyPositions (mission du 18/08/2026 : "aucun cable ne se croise" + padding) ------

const hostsEdge = (source: string, target: string) => ({ source, target });

describe("hostHierarchyPositions — ordonnancement et croisements", () => {
  it("padding : les espacements élargis du 18/08/2026 sont bien ceux appliqués entre niveaux et frères", () => {
    const pos = hostHierarchyPositions(["root", "a", "b"], [hostsEdge("root", "a"), hostsEdge("root", "b")]);
    expect(pos.a!.x - pos.root!.x).toBe(AUTO_LAYOUT_LEVEL_SPACING);
    expect(Math.abs(pos.b!.y - pos.a!.y)).toBe(AUTO_LAYOUT_SIBLING_SPACING);
    expect(AUTO_LAYOUT_LEVEL_SPACING).toBeGreaterThanOrEqual(380);
    expect(AUTO_LAYOUT_SIBLING_SPACING).toBeGreaterThanOrEqual(280);
  });

  it("zéro croisement entre arêtes de l'arbre : les sous-arbres frères occupent des plages Y disjointes, parent centré dans la sienne", () => {
    // Cluster -> 3 hôtes -> VMs de tailles différentes (1/3/2) — le cas réel Nutanix.
    const nodeIds = ["cluster", "h1", "h2", "h3", "v1", "v2a", "v2b", "v2c", "v3a", "v3b"];
    const edges = [
      hostsEdge("cluster", "h1"),
      hostsEdge("cluster", "h2"),
      hostsEdge("cluster", "h3"),
      hostsEdge("h1", "v1"),
      hostsEdge("h2", "v2a"),
      hostsEdge("h2", "v2b"),
      hostsEdge("h2", "v2c"),
      hostsEdge("h3", "v3a"),
      hostsEdge("h3", "v3b"),
    ];
    const pos = hostHierarchyPositions(nodeIds, edges);
    const subtree = (root: string): string[] => [root, ...edges.filter((e) => e.source === root).flatMap((e) => subtree(e.target))];
    const range = (ids: string[]) => ({ min: Math.min(...ids.map((id) => pos[id]!.y)), max: Math.max(...ids.map((id) => pos[id]!.y)) });
    const r1 = range(subtree("h1"));
    const r2 = range(subtree("h2"));
    const r3 = range(subtree("h3"));
    // Plages disjointes entre frères = aucune arête d'un sous-arbre ne peut couper celles d'un autre.
    expect(r1.max).toBeLessThan(r2.min);
    expect(r2.max).toBeLessThan(r3.min);
    // Chaque parent est centré DANS la plage de son propre sous-arbre.
    for (const h of ["h1", "h2", "h3"]) {
      const r = range(subtree(h));
      expect(pos[h]!.y).toBeGreaterThanOrEqual(r.min);
      expect(pos[h]!.y).toBeLessThanOrEqual(r.max);
    }
    // Vérification géométrique directe : aucune paire d'arêtes parent->enfant ne se croise (deux
    // segments entre les mêmes colonnes X se croisent ssi leurs ordres Y s'inversent d'un bout à l'autre).
    const segments = edges.map((e) => ({ p: pos[e.source]!, c: pos[e.target]! }));
    for (const s1 of segments) {
      for (const s2 of segments) {
        if (s1 === s2 || s1.p.x !== s2.p.x || s1.c.x !== s2.c.x) continue;
        expect((s1.p.y - s2.p.y) * (s1.c.y - s2.c.y)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("tri barycentre : l'ordre des frères suit l'ordre d'apparition de leurs descendants, pas l'ordre des arêtes", () => {
    // Arêtes déclarées A avant B, mais les VMs de B apparaissent AVANT celles de A dans nodeIds.
    const nodeIds = ["root", "hostA", "hostB", "vmB1", "vmB2", "vmA1"];
    const pos = hostHierarchyPositions(nodeIds, [
      hostsEdge("root", "hostA"),
      hostsEdge("root", "hostB"),
      hostsEdge("hostA", "vmA1"),
      hostsEdge("hostB", "vmB1"),
      hostsEdge("hostB", "vmB2"),
    ]);
    expect(pos.hostB!.y).toBeLessThan(pos.hostA!.y);
    expect(pos.vmB1!.y).toBeLessThan(pos.vmA1!.y);
  });

  it("fratrie raisonnable (<= 10 feuilles) : colonne unique (zéro croisement), grille réservée aux très grandes fratries", () => {
    const tenKids = Array.from({ length: 10 }, (_, i) => `vm${i}`);
    const linePos = hostHierarchyPositions(["h", ...tenKids], tenKids.map((id) => hostsEdge("h", id)));
    expect(new Set(tenKids.map((id) => linePos[id]!.x)).size).toBe(1);

    const manyKids = Array.from({ length: 29 }, (_, i) => `vm${i}`);
    const gridPos = hostHierarchyPositions(["h", ...manyKids], manyKids.map((id) => hostsEdge("h", id)));
    expect(new Set(manyKids.map((id) => gridPos[id]!.x)).size).toBeGreaterThan(1);
  });
});
