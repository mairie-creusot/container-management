import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NutanixVm, DockerHostInfo, Environment } from "../src/types.js";
import type { RemoteDockerEnvironmentRef } from "../src/services/remoteDockerStore.js";
import type { EffectiveLxcConfig } from "../src/services/lxcStore.js";

/**
 * Docker forcé injoignable (isDockerReachable -> false) : getTopology() prend alors le chemin de
 * repli le plus court (voir services/topology.ts), qui inclut désormais les nœuds VM Nutanix —
 * exactement le point à vérifier ici (VMs Nutanix indépendantes de Docker, cf. en-tête de
 * topology.ts). getClient()/readContainerUsage() ne sont jamais atteints dans ce chemin, un stub
 * minimal suffit.
 */
const getDockerHostInfoMock = vi.fn<[string], Promise<DockerHostInfo | null>>();

vi.mock("../src/services/docker.js", () => ({
  getClient: vi.fn(async () => ({})),
  isDockerReachable: vi.fn(async () => false),
  readContainerUsage: vi.fn(async () => ({ cpuPercent: 0, memBytes: 0 })),
  getDockerHostInfo: (id: string) => getDockerHostInfoMock(id),
}));

const isNutanixConfiguredMock = vi.fn<[], Promise<boolean>>();
const getNutanixVmsMock = vi.fn<[], Promise<NutanixVm[]>>();
const getNutanixClustersMock = vi.fn<[], Promise<{ uuid: string; name: string }[]>>();

vi.mock("../src/services/nutanix.js", () => ({
  isNutanixConfigured: () => isNutanixConfiguredMock(),
  getNutanixVms: () => getNutanixVmsMock(),
  getNutanixClusters: () => getNutanixClustersMock(),
}));

// Isolation des nœuds "host" Docker distant/LXD (voir services/topology.ts) : sans ce mock,
// listRemoteDockerEnvironments()/getLxcEnvironment() liraient les VRAIES données de dev
// (apps/api/data/remote-docker.json, .../lxc.json) au lieu d'un jeu de données de test déterministe
// — même risque que si CONFIG_PATH n'était pas isolé pour setupStore.ts ailleurs dans ce fichier.
const listRemoteDockerEnvironmentsMock = vi.fn<[], Promise<RemoteDockerEnvironmentRef[]>>();
vi.mock("../src/services/remoteDockerStore.js", () => ({
  listRemoteDockerEnvironments: () => listRemoteDockerEnvironmentsMock(),
}));

const getLxcEnvironmentMock = vi.fn<[], Promise<Environment | null>>();
vi.mock("../src/services/lxc.js", () => ({
  getLxcEnvironment: () => getLxcEnvironmentMock(),
}));

const getEffectiveLxcConfigMock = vi.fn<[], Promise<EffectiveLxcConfig | null>>();
vi.mock("../src/services/lxcStore.js", () => ({
  getEffectiveLxcConfig: () => getEffectiveLxcConfigMock(),
}));

const { getTopology } = await import("../src/services/topology.js");

// Défauts "rien configuré" pour CHAQUE test — les describe dédiés aux nœuds "host" ci-dessous
// écrasent explicitement ce qu'il leur faut ; les tests VM Nutanix existants n'ont, eux, rien à
// changer (voir leur intention originale, inchangée).
beforeEach(() => {
  getNutanixClustersMock.mockResolvedValue([]);
  listRemoteDockerEnvironmentsMock.mockResolvedValue([]);
  getLxcEnvironmentMock.mockResolvedValue(null);
  getEffectiveLxcConfigMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getTopology — nœuds VM Nutanix (kind \"nutanix-vm\")", () => {
  it("n'ajoute aucun nœud si Nutanix n'a jamais été configuré (jamais de VM inventée)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([
      { id: "vm-1", name: "vm-1", powerState: "on", numVcpus: 2, memoryMib: 2048, cluster: "cluster-a" },
    ]);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "nutanix-vm")).toBe(false);
    // isNutanixConfigured() est bien la garde consultée avant tout appel réseau (getNutanixVms).
    expect(getNutanixVmsMock).not.toHaveBeenCalled();
    expect(getNutanixClustersMock).not.toHaveBeenCalled();
  });

  it("mappe chaque NutanixVm en TopologyNode (id, label, subtitle, status dérivé de powerState, vCPUs, mémoire)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([
      { id: "vm-uuid-1", name: "portail-citoyen-vm", powerState: "on", numVcpus: 4, memoryMib: 8192, cluster: "Cluster Mairie" },
      { id: "vm-uuid-2", name: "vm-eteinte", powerState: "off", numVcpus: 1, memoryMib: 1024, cluster: "Cluster Mairie" },
      { id: "vm-uuid-3", name: "vm-inconnue", powerState: "unknown", numVcpus: 2, memoryMib: 2048, cluster: "Cluster Mairie" },
    ]);

    const topology = await getTopology();
    const vmNodes = topology.nodes.filter((n) => n.kind === "nutanix-vm");

    expect(vmNodes).toHaveLength(3);
    expect(vmNodes[0]).toMatchObject({
      id: "nutanix-vm:vm-uuid-1",
      kind: "nutanix-vm",
      label: "portail-citoyen-vm",
      subtitle: "Cluster Mairie",
      status: "running",
      numVcpus: 4,
      memoryMib: 8192,
    });
    expect(vmNodes[1]).toMatchObject({ id: "nutanix-vm:vm-uuid-2", status: "stopped" });
    expect(vmNodes[2]).toMatchObject({ id: "nutanix-vm:vm-uuid-3", status: "neutral" });

    // Pas d'arête forcée vers des nœuds Docker, et pas d'arête "hosts" ici (getNutanixClusters()
    // renvoie [] par défaut dans ce test, voir beforeEach) — nœuds isolés (voir en-tête de topology.ts).
    expect(topology.edges.some((e) => e.source.startsWith("nutanix-vm:") || e.target.startsWith("nutanix-vm:"))).toBe(false);
  });

  it("liste vide si Nutanix est configuré mais getNutanixVms() retombe sur [] (injoignable)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([]);

    const topology = await getTopology();

    expect(topology.nodes.filter((n) => n.kind === "nutanix-vm")).toHaveLength(0);
  });
});

describe("getTopology — nœuds host cluster Nutanix (kind \"host\", hostKind \"nutanix-cluster\")", () => {
  it("n'ajoute aucun nœud host si Nutanix n'a jamais été configuré", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getNutanixClustersMock.mockResolvedValue([{ uuid: "cluster-uuid-1", name: "Cluster Mairie" }]);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "host" && n.hostKind === "nutanix-cluster")).toBe(false);
    expect(getNutanixClustersMock).not.toHaveBeenCalled();
  });

  it("un nœud host par cluster réel + une arête « hosts » vers chaque VM dont le clusterUuid correspond", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixClustersMock.mockResolvedValue([
      { uuid: "cluster-uuid-1", name: "Cluster Mairie" },
      { uuid: "cluster-uuid-2", name: "Cluster DSI" },
    ]);
    getNutanixVmsMock.mockResolvedValue([
      {
        id: "vm-uuid-1",
        name: "vm-a",
        powerState: "on",
        numVcpus: 2,
        memoryMib: 2048,
        cluster: "Cluster Mairie",
        clusterUuid: "cluster-uuid-1",
      },
      {
        id: "vm-uuid-2",
        name: "vm-b",
        powerState: "on",
        numVcpus: 2,
        memoryMib: 2048,
        cluster: "Cluster Mairie",
        clusterUuid: "cluster-uuid-1",
      },
      // clusterUuid absent (Prism Central ne l'a pas renvoyé) : jamais d'arête inventée pour elle.
      { id: "vm-uuid-3", name: "vm-c", powerState: "on", numVcpus: 1, memoryMib: 1024, cluster: "unknown-cluster" },
    ]);

    const topology = await getTopology();
    const hostNodes = topology.nodes.filter((n) => n.kind === "host" && n.hostKind === "nutanix-cluster");

    expect(hostNodes).toHaveLength(2);
    expect(hostNodes.find((n) => n.id === "host:nutanix-cluster:cluster-uuid-1")).toMatchObject({
      label: "Cluster Mairie",
      status: "running",
      subtitle: "Cluster Nutanix · 2 VMs",
    });
    expect(hostNodes.find((n) => n.id === "host:nutanix-cluster:cluster-uuid-2")).toMatchObject({
      label: "Cluster DSI",
      subtitle: "Cluster Nutanix · 0 VM",
    });

    const hostEdges = topology.edges.filter((e) => e.kind === "hosts");
    expect(hostEdges).toHaveLength(2);
    expect(hostEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-1" }),
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-2" }),
      ]),
    );
    // vm-c (clusterUuid absent) n'a produit aucune arête.
    expect(topology.edges.some((e) => e.target === "nutanix-vm:vm-uuid-3")).toBe(false);
  });
});

describe("getTopology — nœuds host Docker distant (kind \"host\", hostKind \"remote-docker\")", () => {
  it("[] si aucun environnement Docker distant n'a jamais été configuré", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "host" && n.hostKind === "remote-docker")).toBe(false);
  });

  it("un nœud host TOUJOURS présent par environnement configuré — status/hostInfo honnêtes selon la joignabilité réelle", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    listRemoteDockerEnvironmentsMock.mockResolvedValue([
      {
        id: "env-1",
        name: "VPS reachable",
        host: "10.0.0.5",
        port: 2376,
        transport: "tcp-tls",
        hasTls: true,
        hasSshCredentials: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "env-2",
        name: "VPS unreachable",
        host: "10.0.0.6",
        port: 22,
        transport: "ssh",
        sshUsername: "quai",
        hasTls: false,
        hasSshCredentials: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const hostInfo: DockerHostInfo = {
      serverVersion: "27.0.0",
      apiVersion: "1.46",
      os: "linux",
      kernelVersion: "6.1.0",
      architecture: "x86_64",
      cpus: 4,
      totalMemBytes: 8_000_000_000,
      containersRunning: 3,
      containersStopped: 1,
      imagesCount: 10,
      storageDriver: "overlay2",
      dockerRootDir: "/var/lib/docker",
      endpoint: "tcp://10.0.0.5:2376",
      swarmActive: false,
      volumesCount: 2,
    };
    getDockerHostInfoMock.mockImplementation(async (id: string) => (id === "env-1" ? hostInfo : null));

    const topology = await getTopology();
    const hostNodes = topology.nodes.filter((n) => n.kind === "host" && n.hostKind === "remote-docker");

    expect(hostNodes).toHaveLength(2);
    const reachable = hostNodes.find((n) => n.id === "host:remote-docker:env-1");
    const unreachable = hostNodes.find((n) => n.id === "host:remote-docker:env-2");
    expect(reachable).toMatchObject({ label: "VPS reachable", status: "running", subtitle: "tcp://10.0.0.5:2376", hostInfo });
    // Injoignable mais TOUJOURS présent (configuré = existant), jamais de hostInfo inventé.
    expect(unreachable).toMatchObject({ label: "VPS unreachable", status: "stopped", subtitle: "ssh://quai@10.0.0.6:22" });
    expect(unreachable?.hostInfo).toBeUndefined();
  });
});

describe("getTopology — nœud host LXD (kind \"host\", hostKind \"lxc\")", () => {
  it("[] si LXD n'a jamais été configuré", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getLxcEnvironmentMock.mockResolvedValue(null);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "host" && n.hostKind === "lxc")).toBe(false);
  });

  it("status honnête selon la joignabilité réelle (getLxcEnvironment)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getEffectiveLxcConfigMock.mockResolvedValue({
      endpoint: "https://lxd.lecreusot.priv:8443",
      clientCert: "cert",
      clientKey: "key",
    });
    getLxcEnvironmentMock.mockResolvedValue({
      id: "lxc",
      name: "LXC (LXD)",
      orchestrator: "lxc",
      status: "ok",
      nodes: [{ id: "lxd", environmentId: "lxc", role: "standalone", cpuPercent: 0, memPercent: 0, status: "ok", containerCount: 5 }],
    });

    const reachableTopology = await getTopology();
    const reachableNode = reachableTopology.nodes.find((n) => n.id === "host:lxc");
    expect(reachableNode).toMatchObject({
      kind: "host",
      hostKind: "lxc",
      status: "running",
      subtitle: "https://lxd.lecreusot.priv:8443 · 5 instance(s)",
    });

    getLxcEnvironmentMock.mockResolvedValue({ id: "lxc", name: "LXC (LXD)", orchestrator: "lxc", status: "warn", nodes: [] });
    const unreachableTopology = await getTopology();
    const unreachableNode = unreachableTopology.nodes.find((n) => n.id === "host:lxc");
    expect(unreachableNode).toMatchObject({ status: "stopped", subtitle: "https://lxd.lecreusot.priv:8443" });
  });
});
