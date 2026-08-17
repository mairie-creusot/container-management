import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupNutanixConfig } from "../src/services/setupStore.js";

/**
 * Sonde de conditions réelles (14/08/2026, instance 172.20.0.10:9440, CLUSTER_AHV_HDV) : les
 * formes brutes ci-dessous sont des extraits RÉELS (jamais inventés) des réponses Prism Central
 * v3, uniquement allégés des champs non consommés par nutanix.ts — voir services/nutanix.ts pour
 * les interfaces `NutanixHostEntity`/`NutanixVmEntity`/`NutanixSubnetEntity` correspondantes.
 *
 * `node:https` est mocké ICI (jamais un vrai socket ouvert) : le mock route chaque requête selon
 * `target.pathname` (indépendant de l'ordre d'exécution réel des trois appels parallèles de
 * getNutanixVms — vms/list, hosts/list, subnets/list, voir Promise.all dans nutanix.ts), pour
 * rester robuste même si Node change un jour l'ordre d'évaluation d'un Promise.all.
 */
const responsesByPath = new Map<string, { status: number; body: unknown }>();
function setResponse(path: string, body: unknown, status = 200): void {
  responsesByPath.set(path, { status, body });
}

vi.mock("node:https", () => ({
  request: (target: URL, _options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const found = responsesByPath.get(target.pathname) ?? { status: 200, body: {} };
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const getEffectiveNutanixConfigMock = vi.fn<[], Promise<SetupNutanixConfig | null>>();
vi.mock("../src/services/setupStore.js", () => ({
  getEffectiveNutanixConfig: () => getEffectiveNutanixConfigMock(),
}));

const { getNutanixHosts, getNutanixVms, lastKnownNutanixPoll } = await import("../src/services/nutanix.js");

const VALID_CONFIG: SetupNutanixConfig = {
  prismCentralUrl: "https://172.20.0.10:9440",
  username: "Admin",
  password: "secret",
};

afterEach(() => {
  responsesByPath.clear();
  vi.clearAllMocks();
});

describe("getNutanixHosts", () => {
  it("[] si Nutanix n'a jamais été configuré (aucune requête réseau)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(null);
    expect(await getNutanixHosts()).toEqual([]);
  });

  it("mappe un hôte physique réel (uuid, nom, cluster, capacité) — extrait réel de /hosts/list", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [
        {
          metadata: { uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb" },
          status: {
            name: "HDVNUTA3",
            // Vérifié en conditions réelles : le cluster_reference d'un HÔTE ne porte JAMAIS de
            // `name` (contrairement à celui d'une VM) — uuid seul.
            cluster_reference: { kind: "cluster", uuid: "0005b4db-f6b4-0926-62f9-3cecef178022" },
            resources: {
              cpu_model: "Intel(R) Xeon(R) Gold 6210U CPU @ 2.50GHz",
              num_cpu_cores: 20,
              num_cpu_sockets: 1,
              memory_capacity_mib: 256881,
              hypervisor: { num_vms: 8, hypervisor_full_name: "AHV 11.0.0.2" },
            },
          },
        },
        // Hôte sans uuid (jamais censé arriver, garde défensive) : exclu du résultat.
        { metadata: {}, status: { name: "hote-sans-uuid" } },
      ],
    });

    const hosts = await getNutanixHosts();

    expect(hosts).toEqual([
      {
        id: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb",
        name: "HDVNUTA3",
        clusterUuid: "0005b4db-f6b4-0926-62f9-3cecef178022",
        cpuModel: "Intel(R) Xeon(R) Gold 6210U CPU @ 2.50GHz",
        numCpuCores: 20,
        numCpuSockets: 1,
        memoryCapacityMib: 256881,
        hypervisorNumVms: 8,
        hypervisorFullName: "AHV 11.0.0.2",
      },
    ]);
  });

  it("[] si Prism Central injoignable (jamais d'hôte inventé)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { message: "unreachable" }, 500);
    expect(await getNutanixHosts()).toEqual([]);
  });

  it("champs de capacité absents proprement omis (jamais 0/vide fabriqué)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [{ metadata: { uuid: "host-minimal" }, status: { name: "hote-minimal" } }],
    });

    const hosts = await getNutanixHosts();

    expect(hosts).toEqual([{ id: "host-minimal", name: "hote-minimal" }]);
    expect(hosts[0]).not.toHaveProperty("cpuModel");
    expect(hosts[0]).not.toHaveProperty("memoryCapacityMib");
  });
});

describe("getNutanixVms — résolution hôte/disques/VLAN (host_reference, disk_list, nic_list)", () => {
  it("résout hostUuid/hostName (via getNutanixHosts, PAS l'IP brute de host_reference.name), disques et réseaux réels", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [{ metadata: { uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb" }, status: { name: "HDVNUTA3" } }],
    });
    setResponse("/api/nutanix/v3/subnets/list", {
      entities: [
        {
          metadata: { uuid: "15167a39-c4c5-401d-8847-1878322a90b4" },
          status: { name: "VLAN 1", resources: { vlan_id: 1 } },
        },
      ],
    });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "94f2a9c1-8080-4d8c-b243-ee82701ec262" },
          status: {
            name: "HDVGMA",
            cluster_reference: { kind: "cluster", uuid: "0005b4db-f6b4-0926-62f9-3cecef178022", name: "CLUSTER_AHV_HDV" },
            resources: {
              power_state: "ON",
              num_sockets: 1,
              num_vcpus_per_socket: 1,
              memory_size_mib: 7072,
              // Vérifié en conditions réelles : `name` ici est l'IP de l'hyperviseur, pas un nom lisible.
              host_reference: { kind: "host", uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", name: "172.20.0.5" },
              disk_list: [
                {
                  uuid: "2f9f56f2-64b3-4b3a-9bf1-37ef0e770c3b",
                  device_properties: { device_type: "DISK" },
                  disk_size_bytes: 805306368000,
                },
                { uuid: "fdda4da4-a6b1-4353-9f86-744bff8e0a05", device_properties: { device_type: "CDROM" } },
              ],
              nic_list: [
                {
                  subnet_reference: { kind: "subnet", uuid: "15167a39-c4c5-401d-8847-1878322a90b4", name: "VLAN 1" },
                  ip_endpoint_list: [{ type: "LEARNED", ip: "172.16.8.48" }],
                },
              ],
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({
      id: "94f2a9c1-8080-4d8c-b243-ee82701ec262",
      hostUuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb",
      hostName: "HDVNUTA3", // résolu via getNutanixHosts(), PAS "172.20.0.5"
      disks: [
        { uuid: "2f9f56f2-64b3-4b3a-9bf1-37ef0e770c3b", deviceType: "DISK", sizeBytes: 805306368000 },
        { uuid: "fdda4da4-a6b1-4353-9f86-744bff8e0a05", deviceType: "CDROM" },
      ],
      networks: [{ subnetUuid: "15167a39-c4c5-401d-8847-1878322a90b4", subnetName: "VLAN 1", vlanId: 1, ips: ["172.16.8.48"] }],
    });
    // Le CDROM sans média n'a pas de disk_size_bytes réel : jamais 0 fabriqué.
    expect(vm.disks?.[1]).not.toHaveProperty("sizeBytes");
  });

  it("repli sur l'IP brute de host_reference.name si l'hôte n'est pas dans la liste résolue (course)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] }); // hôte introuvable à cet instant
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-1" },
          status: {
            name: "vm-1",
            resources: {
              power_state: "ON",
              host_reference: { kind: "host", uuid: "host-disparu", name: "172.20.0.9" },
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({ hostUuid: "host-disparu", hostName: "172.20.0.9" });
  });

  it("VM éteinte sans host_reference (ni status ni spec) : hostUuid/hostName absents, jamais inventés", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        { metadata: { uuid: "vm-off" }, status: { name: "vm-off", resources: { power_state: "OFF" } } },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).not.toHaveProperty("hostUuid");
    expect(vm).not.toHaveProperty("hostName");
    expect(vm).not.toHaveProperty("disks");
    expect(vm).not.toHaveProperty("networks");
  });

  /**
   * Retour utilisateur du 17/08/2026, capture d'écran à l'appui : "ya des edge en trop... je doi
   * en avoir que troie [arêtes] la entre ahv et nut 1 nut 2 nut 3" — une VM éteinte (donc sans
   * status.resources.host_reference, jamais rapporté pour une VM éteinte par Prism Central) doit
   * quand même résoudre son hôte via spec.resources.host_reference (dernier hôte assigné/déclaré,
   * conservé même VM éteinte) AVANT de renoncer, pour ne plus jamais retomber sur un rattachement
   * direct au cluster côté services/topology.ts#getNutanixTopologyParts.
   */
  it("VM éteinte SANS status.resources.host_reference mais AVEC spec.resources.host_reference : résout hostUuid/hostName via le repli spec", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [{ metadata: { uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb" }, status: { name: "HDVNUTA3" } }],
    });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-off-with-spec-host" },
          status: { name: "vm-off-with-spec-host", resources: { power_state: "OFF" } },
          spec: {
            name: "vm-off-with-spec-host",
            resources: {
              power_state: "OFF",
              host_reference: { kind: "host", uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", name: "172.20.0.5" },
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({ hostUuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", hostName: "HDVNUTA3" });
  });

  /**
   * Mission du 17/08/2026 : distingue le placement CONFIRMÉ en direct (status.resources.
   * host_reference) du placement REPLIÉ sur le dernier hôte assigné (spec.resources.host_reference)
   * — consommé par services/topology.ts#nutanixVmToNode puis topologyGraphShared.tsx (couleur/
   * pointillé de l'arête "hosts" hôte -> VM).
   */
  it("hostPlacementConfirmed: true quand le placement vient de status.resources.host_reference (direct)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [{ metadata: { uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb" }, status: { name: "HDVNUTA3" } }],
    });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-live" },
          status: {
            name: "vm-live",
            resources: {
              power_state: "ON",
              host_reference: { kind: "host", uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", name: "172.20.0.5" },
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({ hostUuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", hostPlacementConfirmed: true });
  });

  it("hostPlacementConfirmed: false quand le placement vient UNIQUEMENT du repli spec.resources.host_reference", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", {
      entities: [{ metadata: { uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb" }, status: { name: "HDVNUTA3" } }],
    });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-off-with-spec-host" },
          status: { name: "vm-off-with-spec-host", resources: { power_state: "OFF" } },
          spec: {
            name: "vm-off-with-spec-host",
            resources: {
              power_state: "OFF",
              host_reference: { kind: "host", uuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", name: "172.20.0.5" },
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({ hostUuid: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb", hostPlacementConfirmed: false });
  });

  it("hostPlacementConfirmed absent quand hostUuid lui-même est absent (VM jamais démarrée)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [{ metadata: { uuid: "vm-never-started" }, status: { name: "vm-never-started", resources: { power_state: "OFF" } } }],
    });

    const [vm] = await getNutanixVms();

    expect(vm).not.toHaveProperty("hostPlacementConfirmed");
  });

  /**
   * Mission du 17/08/2026, point 1 : `status.state === "ERROR"` (vérifié en conditions réelles le
   * 17/08/2026 sur l'instance 172.20.0.10:9440 — le champ `status.state` existe bel et bien,
   * "COMPLETE" sur les 24 VMs réelles observées, aucune en erreur à cet instant) est un signal
   * DISTINCT du simple power_state, jamais déduit d'une VM éteinte.
   */
  it("apiError: true + apiErrorMessage quand status.state === \"ERROR\" (signal Prism Central distinct de power_state)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-error" },
          status: {
            name: "vm-error",
            state: "ERROR",
            message_list: [{ message: "disk unavailable", reason: "kInternalError" }],
            resources: { power_state: "ON" },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).toMatchObject({ apiError: true, apiErrorMessage: "disk unavailable" });
  });

  it("apiError absent pour une VM simplement éteinte (status.state reste COMPLETE) — jamais déduit du power_state", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        { metadata: { uuid: "vm-off" }, status: { name: "vm-off", state: "COMPLETE", resources: { power_state: "OFF" } } },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm).not.toHaveProperty("apiError");
    expect(vm).not.toHaveProperty("apiErrorMessage");
  });

  it("subnet non résolu (course) : repli sur le nom brut de subnet_reference, VLAN absent (jamais inventé)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] }); // subnet supprimé entre-temps
    setResponse("/api/nutanix/v3/vms/list", {
      entities: [
        {
          metadata: { uuid: "vm-2" },
          status: {
            name: "vm-2",
            resources: {
              power_state: "ON",
              nic_list: [{ subnet_reference: { kind: "subnet", uuid: "subnet-disparu", name: "VLAN 7 (nom en cache)" }, ip_endpoint_list: [] }],
            },
          },
        },
      ],
    });

    const [vm] = await getNutanixVms();

    expect(vm.networks).toEqual([{ subnetUuid: "subnet-disparu", subnetName: "VLAN 7 (nom en cache)", ips: [] }]);
    expect(vm.networks?.[0]).not.toHaveProperty("vlanId");
  });
});

/**
 * Mission du 17/08/2026, point 2 : sans caching d'aucune sorte (voir en-tête de nutanix.ts),
 * lastKnownNutanixPoll() est le SEUL moyen pour services/topology.ts/le frontend de distinguer
 * "ce poll a échoué" de "Nutanix n'a simplement aucune VM" — mis à jour à CHAQUE appel de
 * getNutanixVms(), jamais pour "jamais configuré" (pas une notion de joignabilité).
 */
describe("lastKnownNutanixPoll", () => {
  it("jamais mis à jour pour \"jamais configuré\" (pas une notion de joignabilité) — reste EXACTEMENT ce qu'il était avant cet appel", async () => {
    // Capture AVANT plutôt que d'attendre `null` : ce module partage un état en mémoire process
    // avec les autres tests de ce fichier (même `let lastPollOutcome`, jamais réinitialisé entre
    // deux `it` du même fichier) — un poll RÉUSSI par un test précédent peut donc déjà l'avoir
    // renseigné avant que ce test-ci ne s'exécute. Le VRAI invariant à vérifier est que "jamais
    // configuré" ne le TOUCHE PAS du tout (voir services/nutanix.ts#getNutanixVms, retour avant
    // le try/catch qui seul écrit lastPollOutcome), pas sa valeur absolue.
    const before = lastKnownNutanixPoll();
    getEffectiveNutanixConfigMock.mockResolvedValue(null);
    expect(await getNutanixVms()).toEqual([]);
    expect(lastKnownNutanixPoll()).toBe(before);
  });

  it("reachable: true après un poll réussi", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/hosts/list", { entities: [] });
    setResponse("/api/nutanix/v3/subnets/list", { entities: [] });
    setResponse("/api/nutanix/v3/vms/list", { entities: [] });

    await getNutanixVms();

    const outcome = lastKnownNutanixPoll();
    expect(outcome?.reachable).toBe(true);
    expect(typeof outcome?.at).toBe("string");
  });

  it("reachable: false après un poll en échec (Prism Central injoignable/en erreur)", async () => {
    getEffectiveNutanixConfigMock.mockResolvedValue(VALID_CONFIG);
    setResponse("/api/nutanix/v3/vms/list", { message: "unreachable" }, 500);

    expect(await getNutanixVms()).toEqual([]);
    expect(lastKnownNutanixPoll()?.reachable).toBe(false);
  });
});
