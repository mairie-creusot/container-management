import { afterEach, describe, expect, it, vi } from "vitest";
import type { NutanixVm } from "../src/types.js";

/**
 * Docker forcé injoignable (isDockerReachable -> false) : getTopology() prend alors le chemin de
 * repli le plus court (voir services/topology.ts), qui inclut désormais les nœuds VM Nutanix —
 * exactement le point à vérifier ici (VMs Nutanix indépendantes de Docker, cf. en-tête de
 * topology.ts). getClient()/readContainerUsage() ne sont jamais atteints dans ce chemin, un stub
 * minimal suffit.
 */
vi.mock("../src/services/docker.js", () => ({
  getClient: vi.fn(async () => ({})),
  isDockerReachable: vi.fn(async () => false),
  readContainerUsage: vi.fn(async () => ({ cpuPercent: 0, memBytes: 0 })),
}));

const isNutanixConfiguredMock = vi.fn<[], Promise<boolean>>();
const getNutanixVmsMock = vi.fn<[], Promise<NutanixVm[]>>();

vi.mock("../src/services/nutanix.js", () => ({
  isNutanixConfigured: () => isNutanixConfiguredMock(),
  getNutanixVms: () => getNutanixVmsMock(),
}));

const { getTopology } = await import("../src/services/topology.js");

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

    // Pas d'arête forcée vers des nœuds Docker — nœuds isolés (voir en-tête de topology.ts).
    expect(topology.edges.some((e) => e.source.startsWith("nutanix-vm:") || e.target.startsWith("nutanix-vm:"))).toBe(false);
  });

  it("liste vide si Nutanix est configuré mais getNutanixVms() retombe sur [] (injoignable)", async () => {
    isNutanixConfiguredMock.mockResolvedValue(true);
    getNutanixVmsMock.mockResolvedValue([]);

    const topology = await getTopology();

    expect(topology.nodes.filter((n) => n.kind === "nutanix-vm")).toHaveLength(0);
  });
});
