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
const getDockerHostInfoMock = vi.fn<[string | undefined], Promise<DockerHostInfo | null>>();
// Joignabilité/client pilotables par test — false/{} par défaut (chemin de repli, comme avant) ;
// le describe "master QUAI" ci-dessous les bascule pour couvrir le rattachement des conteneurs.
const isDockerReachableMock = vi.fn<[], Promise<boolean>>();
const getClientMock = vi.fn<[], Promise<unknown>>();

vi.mock("../src/services/docker.js", () => ({
  getClient: () => getClientMock(),
  isDockerReachable: () => isDockerReachableMock(),
  readContainerUsage: vi.fn(async () => ({ cpuPercent: 0, memBytes: 0 })),
  readContainerHealth: vi.fn(async () => ({ healthStatus: "none" })),
  getDockerHostInfo: (id?: string) => getDockerHostInfoMock(id),
}));

// Dépendances du chemin "Docker joignable" (badges MàJ/dérive/vulnérabilités/domaines) — [] partout :
// hors sujet ici, et jamais d'accès réel aux stores/au dépôt GitOps depuis un test.
vi.mock("../src/services/images.js", () => ({ getImages: vi.fn(async () => []) }));
vi.mock("../src/services/gitops.js", () => ({ listGitOpsFiles: vi.fn(async () => []) }));
vi.mock("../src/services/scan.js", () => ({ listAllScans: vi.fn(async () => []) }));
vi.mock("../src/services/reverseProxy.js", () => ({ listRoutes: vi.fn(async () => []), lastKnownDnsSync: vi.fn(() => null) }));

const isNutanixConfiguredMock = vi.fn<[], Promise<boolean>>();
const getNutanixVmsMock = vi.fn<[], Promise<NutanixVm[]>>();
const getNutanixClustersMock = vi.fn<[], Promise<{ uuid: string; name: string }[]>>();
const getNutanixHostsMock = vi.fn<[], Promise<import("../src/types.js").NutanixHost[]>>();
// Voir services/nutanix.ts#lastKnownNutanixPoll (mission du 17/08/2026, point 2 — distinguer "ce
// poll a échoué" de "aucune VM") : `null` par défaut (jamais configuré/jamais pollé), écrasé
// explicitement par les tests dédiés à getTopology()#nutanixLastPoll ci-dessous.
const lastKnownNutanixPollMock = vi.fn<[], import("../src/services/nutanix.js").NutanixPollOutcome | null>();

vi.mock("../src/services/nutanix.js", () => ({
  isNutanixConfigured: () => isNutanixConfiguredMock(),
  getNutanixVms: () => getNutanixVmsMock(),
  getNutanixClusters: () => getNutanixClustersMock(),
  getNutanixHosts: () => getNutanixHostsMock(),
  lastKnownNutanixPoll: () => lastKnownNutanixPollMock(),
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

// HYCU : le snapshot est piloté par test — SANS ce mock, getHycuTopologySnapshot lirait la vraie
// config persistée et pourrait interroger l'appliance RÉELLE de production depuis un test.
// hycuVmProtectionState reste la VRAIE fonction (la règle de protection est testée telle quelle).
const getHycuTopologySnapshotMock = vi.fn<[], Promise<import("../src/services/hycu.js").HycuTopologySnapshot | null>>();
const lastKnownHycuPollMock = vi.fn<[], import("../src/services/hycu.js").HycuPollOutcome | null>();
vi.mock("../src/services/hycu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/hycu.js")>();
  return {
    ...actual,
    getHycuTopologySnapshot: () => getHycuTopologySnapshotMock(),
    lastKnownHycuPoll: () => lastKnownHycuPollMock(),
  };
});

const { getTopology } = await import("../src/services/topology.js");

// Défauts "rien configuré" pour CHAQUE test — les describe dédiés aux nœuds "host" ci-dessous
// écrasent explicitement ce qu'il leur faut ; les tests VM Nutanix existants n'ont, eux, rien à
// changer (voir leur intention originale, inchangée).
beforeEach(() => {
  getNutanixClustersMock.mockResolvedValue([]);
  getNutanixHostsMock.mockResolvedValue([]);
  listRemoteDockerEnvironmentsMock.mockResolvedValue([]);
  getLxcEnvironmentMock.mockResolvedValue(null);
  getEffectiveLxcConfigMock.mockResolvedValue(null);
  lastKnownNutanixPollMock.mockReturnValue(null);
  getHycuTopologySnapshotMock.mockResolvedValue(null);
  lastKnownHycuPollMock.mockReturnValue(null);
  getDockerHostInfoMock.mockResolvedValue(null);
  isDockerReachableMock.mockResolvedValue(false);
  getClientMock.mockResolvedValue({});
});

/** Arêtes "hosts" HORS rattachements du master QUAI — pour les assertions historiques sur la seule
 * hiérarchie Nutanix. */
function nonMasterHostEdges(edges: { kind: string; source: string }[]) {
  return edges.filter((e) => e.kind === "hosts" && e.source !== "host:quai-master");
}

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

  /**
   * Mission du 17/08/2026 : propage `hostPlacementConfirmed`/`apiError` (services/nutanix.ts#
   * NutanixVm, déjà résolus par mapVmEntity) sur le TopologyNode sans les recalculer ici — même
   * principe de simple report que `nutanixHostName`/`nutanixDisks` déjà en place. Consommé
   * uniquement par topologyGraphShared.tsx#nutanixVmHostEdgeState (couleur/pointillé de l'arête
   * "hosts" hôte -> VM), jamais recalculé côté API au-delà de ce simple passage de champ.
   */
  it("propage nutanixHostPlacementConfirmed (placement confirmé en direct vs replié) sur le TopologyNode", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([
      { id: "vm-confirmed", name: "vm-confirmed", powerState: "on", numVcpus: 1, memoryMib: 1024, cluster: "c", hostUuid: "h1", hostPlacementConfirmed: true },
      { id: "vm-fallback", name: "vm-fallback", powerState: "off", numVcpus: 1, memoryMib: 1024, cluster: "c", hostUuid: "h1", hostPlacementConfirmed: false },
      { id: "vm-never-started", name: "vm-never-started", powerState: "off", numVcpus: 1, memoryMib: 1024, cluster: "c" },
    ]);

    const topology = await getTopology();
    const byId = (id: string) => topology.nodes.find((n) => n.id === id);

    expect(byId("nutanix-vm:vm-confirmed")).toMatchObject({ nutanixHostPlacementConfirmed: true });
    expect(byId("nutanix-vm:vm-fallback")).toMatchObject({ nutanixHostPlacementConfirmed: false });
    // Jamais un booléen fabriqué quand hostUuid lui-même est absent (VM jamais démarrée).
    expect(byId("nutanix-vm:vm-never-started")).not.toHaveProperty("nutanixHostPlacementConfirmed");
  });

  it("propage nutanixApiError/nutanixApiErrorMessage (vrai échec Prism Central, distinct d'un simple arrêt)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([
      { id: "vm-error", name: "vm-error", powerState: "on", numVcpus: 1, memoryMib: 1024, cluster: "c", apiError: true, apiErrorMessage: "disk unavailable" },
      { id: "vm-off", name: "vm-off", powerState: "off", numVcpus: 1, memoryMib: 1024, cluster: "c" },
    ]);

    const topology = await getTopology();

    expect(topology.nodes.find((n) => n.id === "nutanix-vm:vm-error")).toMatchObject({
      nutanixApiError: true,
      nutanixApiErrorMessage: "disk unavailable",
    });
    // Un simple arrêt volontaire n'est JAMAIS une erreur API (même règle que côté conteneurs).
    expect(topology.nodes.find((n) => n.id === "nutanix-vm:vm-off")).not.toHaveProperty("nutanixApiError");
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

  it("un nœud host par cluster réel ; VMs sans hôte physique déterminable (hostUuid) n'ont plus AUCUNE arête « hosts » directe (retrait du repli cluster -> VM, 17/08/2026)", async () => {
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

    // Repli cluster -> VM réintroduit le 17/08/2026 (voir tests ci-dessus) : vm-uuid-1/vm-uuid-2 ont
    // bien un clusterUuid réel (voir subtitle "2 VMs" ci-dessus, dérivé indépendamment de
    // vmCountByClusterUuid) mais AUCUN hostUuid déterminable ici (aucun hôte physique mocké dans ce
    // bloc de test) — se rattachent donc au cluster plutôt que de rester flottantes.
    const hostEdges = nonMasterHostEdges(topology.edges);
    expect(hostEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-1" }),
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-2" }),
      ]),
    );
    expect(hostEdges).toHaveLength(2);
    // vm-c (clusterUuid ABSENT, pas seulement l'hôte) : aucun cluster vers lequel se replier, donc
    // toujours aucune arête — seul ce cas précis reste sans arête "hosts".
    expect(topology.edges.some((e) => e.target === "nutanix-vm:vm-uuid-3")).toBe(false);
  });
});

describe("getTopology — nœuds host physique Nutanix (kind \"host\", hostKind \"nutanix-host\")", () => {
  it("n'ajoute aucun nœud hôte physique si Nutanix n'a jamais été configuré", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getNutanixHostsMock.mockResolvedValue([{ id: "host-uuid-1", name: "HDVNUTA3", clusterUuid: "cluster-uuid-1" }]);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "host" && n.hostKind === "nutanix-host")).toBe(false);
    expect(getNutanixHostsMock).not.toHaveBeenCalled();
  });

  it("un nœud par hôte physique réel, relié à son cluster et à chaque VM qu'il exécute ACTUELLEMENT (hostUuid)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixClustersMock.mockResolvedValue([{ uuid: "cluster-uuid-1", name: "CLUSTER_AHV_HDV" }]);
    getNutanixHostsMock.mockResolvedValue([
      {
        id: "host-uuid-1",
        name: "HDVNUTA3",
        clusterUuid: "cluster-uuid-1",
        cpuModel: "Intel(R) Xeon(R) Gold 6210U CPU @ 2.50GHz",
        numCpuCores: 20,
        numCpuSockets: 1,
        memoryCapacityMib: 256881,
        hypervisorFullName: "AHV 11.0.0.2",
      },
      { id: "host-uuid-2", name: "HDVNUTA4", clusterUuid: "cluster-uuid-1" },
    ]);
    getNutanixVmsMock.mockResolvedValue([
      {
        id: "vm-uuid-1",
        name: "vm-a",
        powerState: "on",
        numVcpus: 2,
        memoryMib: 2048,
        cluster: "CLUSTER_AHV_HDV",
        clusterUuid: "cluster-uuid-1",
        hostUuid: "host-uuid-1",
        hostName: "HDVNUTA3",
        disks: [{ uuid: "disk-1", deviceType: "DISK", sizeBytes: 805306368000 }],
        networks: [{ subnetUuid: "subnet-1", subnetName: "VLAN 1", vlanId: 1, ips: ["172.16.8.48"] }],
      },
      // VM éteinte, hostUuid absent (ni status ni spec côté nutanix.ts#mapVmEntity, VM jamais
      // démarrée) : se rattache au CLUSTER (repli réintroduit le 17/08/2026 après retour
      // utilisateur — "les vm arreter ici se sont pas relier", un nœud totalement flottant sans la
      // moindre arête est pire qu'un rattachement honnêtement affiché comme non confirmé côté
      // frontend, voir nutanixVmHostEdgeState/topologyGraphShared.tsx).
      { id: "vm-uuid-2", name: "vm-b", powerState: "off", numVcpus: 1, memoryMib: 1024, cluster: "CLUSTER_AHV_HDV", clusterUuid: "cluster-uuid-1" },
    ]);

    const topology = await getTopology();
    const physicalHostNodes = topology.nodes.filter((n) => n.kind === "host" && n.hostKind === "nutanix-host");

    expect(physicalHostNodes).toHaveLength(2);
    const host1 = physicalHostNodes.find((n) => n.id === "host:nutanix-host:host-uuid-1");
    expect(host1).toMatchObject({
      label: "HDVNUTA3",
      status: "running",
      nutanixHostCpuModel: "Intel(R) Xeon(R) Gold 6210U CPU @ 2.50GHz",
      nutanixHostNumCpuCores: 20,
      nutanixHostNumCpuSockets: 1,
      nutanixHostMemoryCapacityMib: 256881,
      nutanixHostHypervisorFullName: "AHV 11.0.0.2",
    });
    expect(host1?.subtitle).toContain("1 VM");

    const hostEdges = nonMasterHostEdges(topology.edges);
    // cluster -> host-uuid-1, cluster -> host-uuid-2, host-uuid-1 -> vm-uuid-1 (placement réel),
    // cluster -> vm-uuid-2 (repli, VM éteinte sans hôte déterminable — voir commentaire ci-dessus).
    expect(hostEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "host:nutanix-host:host-uuid-1" }),
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "host:nutanix-host:host-uuid-2" }),
        expect.objectContaining({ source: "host:nutanix-host:host-uuid-1", target: "nutanix-vm:vm-uuid-1" }),
        expect.objectContaining({ source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-2" }),
      ]),
    );
    expect(hostEdges).toHaveLength(4);
    // Jamais un rattachement DOUBLE (host ET cluster en même temps) pour la même VM placée.
    expect(topology.edges.filter((e) => e.target === "nutanix-vm:vm-uuid-1")).toHaveLength(1);

    // Le placement/disques/réseau réels sont bien reportés tels quels sur le nœud VM lui-même
    // (voir services/topology.ts#nutanixVmToNode) — mission "corrige le j'ai rien".
    const vmNode = topology.nodes.find((n) => n.id === "nutanix-vm:vm-uuid-1");
    expect(vmNode).toMatchObject({
      nutanixHostName: "HDVNUTA3",
      nutanixDisks: [{ uuid: "disk-1", deviceType: "DISK", sizeBytes: 805306368000 }],
      nutanixNetworks: [{ subnetUuid: "subnet-1", subnetName: "VLAN 1", vlanId: 1, ips: ["172.16.8.48"] }],
    });
  });

  it("si l'hôte visé par une VM n'est plus dans la liste réellement retournée (course), la VM se rattache au cluster (repli, jamais flottante)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixClustersMock.mockResolvedValue([{ uuid: "cluster-uuid-1", name: "CLUSTER_AHV_HDV" }]);
    getNutanixHostsMock.mockResolvedValue([]); // hôte supprimé/injoignable entre les deux appels
    getNutanixVmsMock.mockResolvedValue([
      {
        id: "vm-uuid-1",
        name: "vm-a",
        powerState: "on",
        numVcpus: 2,
        memoryMib: 2048,
        cluster: "CLUSTER_AHV_HDV",
        clusterUuid: "cluster-uuid-1",
        hostUuid: "host-uuid-inconnu",
      },
    ]);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "host" && n.hostKind === "nutanix-host")).toBe(false);
    // Repli cluster -> VM réintroduit le 17/08/2026 (voir commentaire du test précédent) : cette VM
    // n'obtient plus jamais une arête vers un hôte disparu de la liste réelle, mais reste rattachée
    // au cluster plutôt que de rester un nœud totalement flottant sans la moindre arête "hosts".
    expect(topology.edges).toContainEqual(
      expect.objectContaining({ kind: "hosts", source: "host:nutanix-cluster:cluster-uuid-1", target: "nutanix-vm:vm-uuid-1" }),
    );
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

/**
 * Mission du 17/08/2026, point 2 : sans caching d'aucune sorte côté services/nutanix.ts (voir son
 * en-tête), un poll Nutanix en échec fait DISPARAÎTRE tous les nœuds VM/cluster/hôte de la réponse
 * plutôt que d'en afficher une valeur obsolète — `Topology#nutanixLastPoll` est le SEUL moyen pour
 * le frontend de distinguer "aucune VM réellement" de "Nutanix injoignable à ce poll précis".
 */
describe("getTopology — Topology#nutanixLastPoll (fraîcheur du dernier poll Nutanix)", () => {
  it("absent si Nutanix n'a jamais été configuré/jamais encore pollé", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    lastKnownNutanixPollMock.mockReturnValue(null);

    const topology = await getTopology();

    expect(topology).not.toHaveProperty("nutanixLastPoll");
  });

  it("reachable: true après un poll réussi (simple report de services/nutanix.ts#lastKnownNutanixPoll)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([]);
    lastKnownNutanixPollMock.mockReturnValue({ reachable: true, at: "2026-08-17T10:00:00.000Z" });

    const topology = await getTopology();

    expect(topology.nutanixLastPoll).toEqual({ reachable: true, at: "2026-08-17T10:00:00.000Z" });
  });

  it("reachable: false après un poll en échec — jamais une VM inventée pour combler l'absence", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([]); // échec du poll -> [] (voir services/nutanix.ts#getNutanixVms)
    lastKnownNutanixPollMock.mockReturnValue({ reachable: false, at: "2026-08-17T10:05:00.000Z" });

    const topology = await getTopology();

    expect(topology.nutanixLastPoll).toEqual({ reachable: false, at: "2026-08-17T10:05:00.000Z" });
    expect(topology.nodes.some((n) => n.kind === "nutanix-vm")).toBe(false);
  });
});

describe("getTopology — nœud master QUAI (hostKind \"quai-master\") et rattachement des environnements", () => {
  it("master toujours présent et relié à \"Docker local\" — lui-même toujours présent, stopped sans hostInfo si le démon local est injoignable", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);

    const topology = await getTopology();

    expect(topology.nodes.filter((n) => n.hostKind === "quai-master")).toHaveLength(1);
    expect(topology.nodes.find((n) => n.id === "host:quai-master")).toMatchObject({
      kind: "host",
      hostKind: "quai-master",
      label: "QUAI",
      status: "running",
      subtitle: "1 environnement",
    });
    const local = topology.nodes.find((n) => n.id === "host:docker-local");
    expect(local).toMatchObject({ kind: "host", hostKind: "docker-env", label: "Docker local", status: "stopped" });
    expect(local?.hostInfo).toBeUndefined();
    expect(topology.edges).toContainEqual(
      expect.objectContaining({ kind: "hosts", source: "host:quai-master", target: "host:docker-local" }),
    );
  });

  it("Docker local joignable : status running + hostInfo réel (getDockerHostInfo appelé SANS id d'environnement distant)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    const hostInfo: DockerHostInfo = {
      serverVersion: "27.0.0",
      apiVersion: "1.46",
      os: "linux",
      kernelVersion: "6.1.0",
      architecture: "x86_64",
      cpus: 8,
      totalMemBytes: 16_000_000_000,
      containersRunning: 2,
      containersStopped: 0,
      imagesCount: 5,
      storageDriver: "overlay2",
      dockerRootDir: "/var/lib/docker",
      endpoint: "unix:///var/run/docker.sock",
      swarmActive: false,
      volumesCount: 1,
    };
    getDockerHostInfoMock.mockImplementation(async (id) => (id === undefined ? hostInfo : null));

    const topology = await getTopology();

    expect(topology.nodes.find((n) => n.id === "host:docker-local")).toMatchObject({
      status: "running",
      subtitle: "unix:///var/run/docker.sock",
      hostInfo,
    });
  });

  it("master relié à CHAQUE environnement (Docker local, Docker distant, cluster Nutanix, LXD) — jamais aux hôtes physiques/VMs ni aux nœuds hors-infra", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixClustersMock.mockResolvedValue([{ uuid: "cluster-uuid-1", name: "CLUSTER_AHV_HDV" }]);
    getNutanixHostsMock.mockResolvedValue([{ id: "host-uuid-1", name: "HDVNUTA3", clusterUuid: "cluster-uuid-1" }]);
    getNutanixVmsMock.mockResolvedValue([
      { id: "vm-uuid-1", name: "vm-a", powerState: "on", numVcpus: 1, memoryMib: 1024, cluster: "CLUSTER_AHV_HDV", clusterUuid: "cluster-uuid-1", hostUuid: "host-uuid-1" },
    ]);
    listRemoteDockerEnvironmentsMock.mockResolvedValue([
      {
        id: "env-1",
        name: "VPS",
        host: "10.0.0.5",
        port: 2376,
        transport: "tcp-tls",
        hasTls: true,
        hasSshCredentials: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    getEffectiveLxcConfigMock.mockResolvedValue({ endpoint: "https://lxd:8443", clientCert: "c", clientKey: "k" });
    getLxcEnvironmentMock.mockResolvedValue({ id: "lxc", name: "LXC (LXD)", orchestrator: "lxc", status: "ok", nodes: [] });

    const topology = await getTopology();
    const masterEdges = topology.edges.filter((e) => e.kind === "hosts" && e.source === "host:quai-master");

    expect(masterEdges.map((e) => e.target).sort()).toEqual(
      ["host:docker-local", "host:lxc", "host:nutanix-cluster:cluster-uuid-1", "host:remote-docker:env-1"].sort(),
    );
    // Aucun doublon d'arête, aucun rattachement direct master -> hôte physique/VM.
    expect(new Set(masterEdges.map((e) => e.id)).size).toBe(masterEdges.length);
    expect(topology.nodes.find((n) => n.id === "host:quai-master")?.subtitle).toBe("4 environnements");
  });

  it("Docker local joignable : chaque conteneur se rattache à \"Docker local\" — jamais les volumes/networks (déjà couverts par mount/network)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    isDockerReachableMock.mockResolvedValue(true);
    getClientMock.mockResolvedValue({
      listContainers: async () => [
        {
          Id: "c1",
          Names: ["/web"],
          Image: "nginx:latest",
          State: "running",
          Mounts: [{ Type: "volume", Name: "shared-data", Destination: "/data", RW: true }],
          NetworkSettings: { Networks: { "app-net": { NetworkID: "n1" } } },
          Ports: [],
        },
        {
          Id: "c2",
          Names: ["/worker"],
          Image: "worker:latest",
          State: "exited",
          Mounts: [{ Type: "volume", Name: "shared-data", Destination: "/data", RW: true }],
          NetworkSettings: { Networks: { "app-net": { NetworkID: "n1" } } },
          Ports: [],
        },
      ],
      listVolumes: async () => ({ Volumes: [{ Name: "shared-data", Driver: "local" }] }),
      listNetworks: async () => [{ Id: "n1", Name: "app-net", Driver: "bridge" }],
    });

    const topology = await getTopology();
    const localEdges = topology.edges.filter((e) => e.kind === "hosts" && e.source === "host:docker-local");

    expect(localEdges.map((e) => e.target).sort()).toEqual(["container:c1", "container:c2"]);
    // Les ressources partagées restent de vrais nœuds reliés par leurs arêtes mount/network — jamais
    // rattachées en plus au nœud "Docker local".
    expect(topology.edges.some((e) => e.kind === "hosts" && (e.target === "volume:shared-data" || e.target === "network:n1"))).toBe(false);
    expect(topology.edges).toContainEqual(expect.objectContaining({ kind: "mount", source: "volume:shared-data", target: "container:c1" }));
    expect(topology.edges).toContainEqual(expect.objectContaining({ kind: "network", source: "container:c1", target: "network:n1" }));
  });
});

/**
 * Nœud "hycu-appliance" + arêtes "protects" (voir services/topology.ts#getHycuTopologyParts).
 * AUCUN test ne touche l'appliance réelle : le snapshot HYCU est entièrement mocké plus haut.
 */
describe("getTopology — appliance HYCU et arêtes de sauvegarde", () => {
  const VM_UUID = "aaaaaaaa-1111-4222-8333-444444444444";

  function vmListedByNutanix(name = "HDVAPPLI") {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([
      { id: VM_UUID, name, powerState: "on", numVcpus: 2, memoryMib: 2048, cluster: "Cluster Mairie" },
    ]);
  }

  it("aucun nœud HYCU tant que l'appliance n'a jamais été configurée (jamais de sauvegarde inventée)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getHycuTopologySnapshotMock.mockResolvedValue(null);

    const topology = await getTopology();

    expect(topology.nodes.some((n) => n.kind === "hycu-appliance")).toBe(false);
    expect(topology.edges.some((e) => e.kind === "protects")).toBe(false);
  });

  it("configurée mais injoignable : nœud \"stopped\" SANS compteur ni arête (jamais de zéros ni de valeur mise en cache)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://172.20.0.100:8443",
      reachable: false,
      vms: [],
      lastBackupFieldPresent: false,
    });
    lastKnownHycuPollMock.mockReturnValue({ reachable: false, at: "2026-08-18T06:00:00.000Z" });

    const topology = await getTopology();
    const hycu = topology.nodes.find((n) => n.kind === "hycu-appliance");

    expect(hycu).toMatchObject({ id: "hycu-appliance:main", label: "HYCU", subtitle: "https://172.20.0.100:8443", status: "stopped" });
    expect(hycu?.hycuVmTotal).toBeUndefined();
    expect(hycu?.hycuProtectedVmCount).toBeUndefined();
    expect(hycu?.hycuFailedJobCount).toBeUndefined();
    expect(hycu?.hycuLastPollAt).toBe("2026-08-18T06:00:00.000Z");
    expect(topology.edges.some((e) => e.kind === "protects")).toBe(false);
  });

  it("joignable : compteurs réels sur le nœud + rattachement au master QUAI", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://172.20.0.100:8443",
      reachable: true,
      vms: [],
      lastBackupFieldPresent: false,
      counts: { vms: 12, protectedVms: 9, policies: 3, targets: 2, recentJobs: 50, failedJobs: 4 },
    });

    const topology = await getTopology();
    const hycu = topology.nodes.find((n) => n.kind === "hycu-appliance");

    expect(hycu).toMatchObject({
      status: "running",
      hycuVmTotal: 12,
      hycuProtectedVmCount: 9,
      hycuPolicyCount: 3,
      hycuTargetCount: 2,
      hycuFailedJobCount: 4,
    });
    expect(topology.edges).toContainEqual(
      expect.objectContaining({ kind: "hosts", source: "host:quai-master", target: "hycu-appliance:main" }),
    );
  });

  it("rapprochement par uuid : arête \"protects\" + protection réelle posée sur la VM Nutanix", async () => {
    vmListedByNutanix();
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://hycu",
      reachable: true,
      lastBackupFieldPresent: true,
      vms: [
        {
          uuid: VM_UUID,
          vmName: "nom-different-cote-hycu",
          protectionGroupUuid: "policy-1",
          policyName: "Gold",
          complianceStatus: "GREEN",
          lastBackupInMillis: Date.UTC(2026, 7, 18, 2, 0, 0),
        },
      ],
      counts: { vms: 1, protectedVms: 1, policies: 1, targets: 1, recentJobs: 1, failedJobs: 0 },
    });

    const topology = await getTopology();
    const vm = topology.nodes.find((n) => n.kind === "nutanix-vm");

    expect(topology.edges).toContainEqual(
      expect.objectContaining({ kind: "protects", source: "hycu-appliance:main", target: `nutanix-vm:${VM_UUID}` }),
    );
    expect(vm).toMatchObject({
      hycuProtection: "protected",
      hycuPolicyName: "Gold",
      hycuComplianceStatus: "GREEN",
      hycuLastBackupAt: new Date(Date.UTC(2026, 7, 18, 2, 0, 0)).toISOString(),
    });
  });

  it("rapprochement par NOM exact quand l'uuid ne correspond pas — et AUCUN rapprochement si le nom est ambigu", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([
      { id: "uuid-a", name: "HDVAPPLI", powerState: "on", numVcpus: 2, memoryMib: 2048, cluster: "c" },
      { id: "uuid-b", name: "DOUBLON", powerState: "on", numVcpus: 2, memoryMib: 2048, cluster: "c" },
      { id: "uuid-c", name: "DOUBLON", powerState: "on", numVcpus: 2, memoryMib: 2048, cluster: "c" },
    ]);
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://hycu",
      reachable: true,
      lastBackupFieldPresent: false,
      vms: [
        { uuid: "hycu-interne-1", vmName: "HDVAPPLI", protectionGroupUuid: "policy-1", policyName: "Gold" },
        { uuid: "hycu-interne-2", vmName: "DOUBLON", protectionGroupUuid: "policy-1" },
      ],
      counts: { vms: 2, protectedVms: 2, policies: 1, targets: 1, recentJobs: 0, failedJobs: 0 },
    });

    const topology = await getTopology();
    const protects = topology.edges.filter((e) => e.kind === "protects");

    expect(protects).toHaveLength(1);
    expect(protects[0]).toMatchObject({ target: "nutanix-vm:uuid-a" });
    expect(topology.nodes.find((n) => n.id === "nutanix-vm:uuid-a")?.hycuProtection).toBe("protected");
    // Homonymes : ni arête, ni protection affichée — jamais un rapprochement au hasard.
    expect(topology.nodes.find((n) => n.id === "nutanix-vm:uuid-b")?.hycuProtection).toBeUndefined();
    expect(topology.nodes.find((n) => n.id === "nutanix-vm:uuid-c")?.hycuProtection).toBeUndefined();
  });

  it("VM connue de HYCU mais assignée à aucune policy : \"unprotected\", AUCUNE arête de sauvegarde", async () => {
    vmListedByNutanix();
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://hycu",
      reachable: true,
      lastBackupFieldPresent: false,
      vms: [{ uuid: VM_UUID, vmName: "HDVAPPLI" }],
      counts: { vms: 1, protectedVms: 0, policies: 0, targets: 1, recentJobs: 0, failedJobs: 0 },
    });

    const topology = await getTopology();

    expect(topology.nodes.find((n) => n.kind === "nutanix-vm")?.hycuProtection).toBe("unprotected");
    expect(topology.edges.some((e) => e.kind === "protects")).toBe(false);
  });

  it("VM inconnue de HYCU : aucun champ de protection posé (une absence de donnée n'est jamais une VM non sauvegardée)", async () => {
    vmListedByNutanix();
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://hycu",
      reachable: true,
      lastBackupFieldPresent: true,
      vms: [{ uuid: "autre-vm", vmName: "AUTRE", protectionGroupUuid: "policy-1" }],
      counts: { vms: 1, protectedVms: 1, policies: 1, targets: 1, recentJobs: 0, failedJobs: 0 },
    });

    const topology = await getTopology();
    const vm = topology.nodes.find((n) => n.kind === "nutanix-vm");

    expect(vm?.hycuProtection).toBeUndefined();
    expect(vm?.hycuLastBackupAt).toBeUndefined();
    expect(topology.edges.some((e) => e.kind === "protects")).toBe(false);
  });

  it("?scope=local (premier rendu rapide) : HYCU n'est jamais interrogé — source externe lente comme Nutanix", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    getNutanixVmsMock.mockResolvedValue([]);
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: "https://hycu",
      reachable: true,
      vms: [],
      lastBackupFieldPresent: false,
      counts: { vms: 1, protectedVms: 1, policies: 1, targets: 1, recentJobs: 0, failedJobs: 0 },
    });

    const topology = await getTopology("local");

    expect(getHycuTopologySnapshotMock).not.toHaveBeenCalled();
    expect(topology.nodes.some((n) => n.kind === "hycu-appliance")).toBe(false);
  });
});
