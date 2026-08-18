import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Configuration matérielle d'une VM Nutanix (ajout disque/NIC, vCPU/mémoire) + GET /subnets —
 * voir services/nutanix.ts (section "Configuration matérielle...") et routes/nutanix.ts.
 *
 * Même montage EXACT que nutanixVmActions.test.ts (isolement CONFIG_PATH, mock node:https routé
 * par `${method} ${pathname}` avec file de réponses, buildServer()+inject() de bout en bout).
 * Les entités mockées REPRODUISENT la forme réelle vérifiée EN LECTURE SEULE le 18/08/2026 sur
 * l'instance 172.20.0.10:9440 (GET /vms/{uuid} sur 2 VMs réelles, POST /subnets/list) — AUCUNE
 * mutation n'a jamais touché une VM réelle : les PUT ne sont exercés QUE contre ce mock.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockResponse {
  status: number;
  body: unknown;
}

const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();
const lastRequestBodyByKey = new Map<string, unknown>();

function queueResponse(key: string, body: unknown, status = 200): void {
  const list = queuesByKey.get(key) ?? [];
  list.push({ status, body });
  queuesByKey.set(key, list);
}

function nextResponse(key: string): MockResponse {
  const queue = queuesByKey.get(key);
  if (queue && queue.length > 0) {
    const res = queue.shift()!;
    lastByKey.set(key, res);
    return res;
  }
  return lastByKey.get(key) ?? { status: 200, body: {} };
}

vi.mock("node:https", () => ({
  request: (target: URL, options: { method?: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    const key = `${options.method ?? "GET"} ${target.pathname}`;
    let written = "";
    req.write = (chunk: unknown) => {
      written += typeof chunk === "string" ? chunk : String(chunk);
    };
    req.destroy = () => {};
    req.end = () => {
      if (written) {
        try {
          lastRequestBodyByKey.set(key, JSON.parse(written));
        } catch {
          lastRequestBodyByKey.set(key, written);
        }
      }
      const found = nextResponse(key);
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setNutanixConfig, clearNutanixConfig } = await import("../src/services/setupStore.js");
const { listAuditEvents } = await import("../src/services/auditLog.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  queuesByKey.clear();
  lastByKey.clear();
  lastRequestBodyByKey.clear();
});

const VM_UUID = "dc52605f-e91a-4dd2-b966-3dd76c52bf8d";
const CLUSTER_UUID = "0005b4db-f6b4-0926-62f9-3cecef178022";
const STORAGE_CONTAINER_UUID = "696a68d6-1ecf-4393-8dac-cdbd545136f2";
const SUBNET_VLAN1 = "15167a39-c4c5-401d-8847-1878322a90b4";
const SUBNET_VLAN10 = "4dada0f5-72b4-4e8c-944e-255d1869b47d";

/** Entrée DISQUE réelle (forme vérifiée en lecture seule le 18/08/2026 — VM "HDVAPPLI"). */
function realDiskEntry(deviceIndex: number): unknown {
  return {
    uuid: `disk-${deviceIndex}-uuid`,
    device_properties: { disk_address: { adapter_type: "SCSI", device_index: deviceIndex }, device_type: "DISK" },
    disk_size_mib: 130048,
    disk_size_bytes: 136365211648,
    storage_config: { storage_container_reference: { kind: "storage_container", uuid: STORAGE_CONTAINER_UUID } },
  };
}

/** Entrée CDROM réelle (IDE, sans taille) — même vérification. */
const realCdromEntry = {
  uuid: "cdrom-uuid",
  device_properties: { disk_address: { adapter_type: "IDE", device_index: 0 }, device_type: "CDROM" },
};

/** Entrée NIC réelle — même vérification. */
const realNicEntry = {
  uuid: "07a1861c-1bce-4f24-a1e9-487f8fffd742",
  nic_type: "NORMAL_NIC",
  vlan_mode: "ACCESS",
  trunked_vlan_list: [],
  num_queues: 1,
  mac_address: "00:15:5d:6b:85:0c",
  ip_endpoint_list: [],
  subnet_reference: { kind: "subnet", name: "VLAN 1", uuid: SUBNET_VLAN1 },
  is_connected: true,
};

function vmEntity(overrides: { powerState?: "ON" | "OFF"; diskList?: unknown[]; nicList?: unknown[] } = {}): unknown {
  const powerState = overrides.powerState ?? "ON";
  return {
    api_version: "3.1",
    metadata: { uuid: VM_UUID, spec_version: 5, kind: "vm" },
    spec: {
      name: "HDVAPPLI",
      resources: {
        power_state: powerState,
        power_state_mechanism: { mechanism: "HARD" },
        num_sockets: 2,
        num_vcpus_per_socket: 2,
        num_threads_per_core: 1,
        memory_size_mib: 8192,
        boot_config: { boot_device: { disk_address: { adapter_type: "SCSI", device_index: 0 } }, boot_type: "UEFI" },
        disk_list: overrides.diskList ?? [realDiskEntry(0), realCdromEntry],
        nic_list: overrides.nicList ?? [realNicEntry],
      },
      cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID, name: "CLUSTER_AHV_HDV" },
    },
    status: {
      name: "HDVAPPLI",
      resources: { power_state: powerState },
      cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID, name: "CLUSTER_AHV_HDV" },
    },
  };
}

function seedSubnets(): void {
  queueResponse("POST /api/nutanix/v3/subnets/list", {
    entities: [
      { metadata: { uuid: SUBNET_VLAN1 }, status: { name: "VLAN 1", resources: { vlan_id: 1 } } },
      { metadata: { uuid: SUBNET_VLAN10 }, status: { name: "VLAN 10", resources: { vlan_id: 10 } } },
    ],
  });
}

async function seedNutanixConfig(): Promise<void> {
  await setNutanixConfig({ prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: "secret" });
}

async function waitForAuditEvent(predicate: (e: Awaited<ReturnType<typeof listAuditEvents>>[number]) => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await listAuditEvents();
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

const GET_KEY = `GET /api/nutanix/v3/vms/${VM_UUID}`;
const PUT_KEY = `PUT /api/nutanix/v3/vms/${VM_UUID}`;

describe("Configuration matérielle d'une VM Nutanix — autorisation", () => {
  it("401 sans session sur POST .../disks", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/disks`, payload: { sizeMib: 51200 } });
    expect(response.statusCode).toBe(401);
  });

  it("403 pour un rôle viewer sur les trois routes mutantes (garde globale plugins/auth.ts)", async () => {
    app = buildServer();
    for (const [method, url] of [
      ["POST", `/api/nutanix/vms/${VM_UUID}/disks`],
      ["POST", `/api/nutanix/vms/${VM_UUID}/nics`],
      ["PATCH", `/api/nutanix/vms/${VM_UUID}/compute`],
    ] as const) {
      const response = await app.inject({ method, url, cookies: viewerCookie(), payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("400 si Nutanix n'a jamais été configuré", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/disks`,
      cookies: adminCookie(),
      payload: { sizeMib: 51200 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/nutanix/subnets", () => {
  it("renvoie les subnets réels (uuid/nom/VLAN) mappés depuis /subnets/list", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedSubnets();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/subnets", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { uuid: SUBNET_VLAN1, name: "VLAN 1", vlanId: 1 },
      { uuid: SUBNET_VLAN10, name: "VLAN 10", vlanId: 10 },
    ]);
  });

  it("[] si Nutanix n'a jamais été configuré (jamais une erreur pour un simple listing)", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/subnets", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("POST /api/nutanix/vms/:uuid/disks", () => {
  it("400 si sizeMib absent, hors bornes basses ou hautes (garde-fous QUAI)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    for (const payload of [{}, { sizeMib: 512 }, { sizeMib: 3 * 1024 * 1024 }, { sizeMib: 1.5 }]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/nutanix/vms/${VM_UUID}/disks`,
        cookies: adminCookie(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("ajoute un disque SCSI au prochain device_index libre, storage container recopié du disque existant, CDROM/NICs intacts", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    queueResponse(PUT_KEY, vmEntity());

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/disks`,
      cookies: adminCookie(),
      payload: { sizeMib: 51200 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI", sizeMib: 51200 });
    const body = lastRequestBodyByKey.get(PUT_KEY) as {
      api_version: string;
      metadata: { uuid: string; spec_version: number };
      spec: { resources: { disk_list: any[]; nic_list: unknown[]; boot_config: unknown; power_state: string } };
    };
    // Entité complète renvoyée (concurrence optimiste v3) — jamais un spec partiel.
    expect(body.api_version).toBe("3.1");
    expect(body.metadata.uuid).toBe(VM_UUID);
    expect(body.metadata.spec_version).toBe(5);
    const diskList = body.spec.resources.disk_list;
    expect(diskList).toHaveLength(3); // disque existant + CDROM + nouveau
    const added = diskList[2];
    expect(added).toEqual({
      device_properties: { device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: 1 } },
      disk_size_mib: 51200,
      storage_config: { storage_container_reference: { kind: "storage_container", uuid: STORAGE_CONTAINER_UUID } },
    });
    // Les entrées existantes passent TELLES QUELLES (jamais reconstruites champ par champ).
    expect(diskList[0]).toEqual(realDiskEntry(0));
    expect(diskList[1]).toEqual(realCdromEntry);
    expect(body.spec.resources.nic_list).toEqual([realNicEntry]);
    expect(body.spec.resources.boot_config).toEqual({
      boot_device: { disk_address: { adapter_type: "SCSI", device_index: 0 } },
      boot_type: "UEFI",
    });
    expect(body.spec.resources.power_state).toBe("ON");
  });

  it("VM sans aucun disque : device_index 0 et AUCUN storage_config inventé (container par défaut du cluster)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ diskList: [] }));
    queueResponse(PUT_KEY, vmEntity());

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/disks`,
      cookies: adminCookie(),
      payload: { sizeMib: 10240 },
    });

    expect(response.statusCode).toBe(200);
    const body = lastRequestBodyByKey.get(PUT_KEY) as { spec: { resources: { disk_list: any[] } } };
    expect(body.spec.resources.disk_list).toEqual([
      { device_properties: { device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: 0 } }, disk_size_mib: 10240 },
    ]);
  });

  it("enregistre l'action dans le journal d'audit (mécanisme automatique plugins/audit.ts)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    queueResponse(PUT_KEY, vmEntity());

    await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/disks`, cookies: adminCookie(), payload: { sizeMib: 51200 } });

    const event = await waitForAuditEvent((e) => e.path === `/api/nutanix/vms/${VM_UUID}/disks` && e.ok);
    expect(event).toBeDefined();
    expect(event?.actor).toBe("ybanas");
    expect(event?.method).toBe("POST");
  });
});

describe("POST /api/nutanix/vms/:uuid/nics", () => {
  it("400 si subnetUuid absent", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/nics`, cookies: adminCookie(), payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("404 si le subnet n'existe pas sur Prism Central (jamais un uuid accepté à l'aveugle)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    seedSubnets();

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/nics`,
      cookies: adminCookie(),
      payload: { subnetUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("ajoute une carte réseau NORMAL_NIC/ACCESS connectée au subnet vérifié, NIC existante intacte", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    seedSubnets();
    queueResponse(PUT_KEY, vmEntity());

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/nics`,
      cookies: adminCookie(),
      payload: { subnetUuid: SUBNET_VLAN10 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI", subnetName: "VLAN 10" });
    const body = lastRequestBodyByKey.get(PUT_KEY) as { spec: { resources: { nic_list: any[]; disk_list: unknown[] } } };
    expect(body.spec.resources.nic_list).toHaveLength(2);
    expect(body.spec.resources.nic_list[0]).toEqual(realNicEntry);
    expect(body.spec.resources.nic_list[1]).toEqual({
      nic_type: "NORMAL_NIC",
      vlan_mode: "ACCESS",
      subnet_reference: { kind: "subnet", uuid: SUBNET_VLAN10 },
      is_connected: true,
    });
    expect(body.spec.resources.disk_list).toEqual([realDiskEntry(0), realCdromEntry]);
  });
});

describe("PATCH /api/nutanix/vms/:uuid/compute", () => {
  it("400 si aucun champ fourni", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({ method: "PATCH", url: `/api/nutanix/vms/${VM_UUID}/compute`, cookies: adminCookie(), payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("400 hors bornes (vCPU 0, cœurs 32, mémoire 100 Mio, non-entier)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    for (const payload of [{ numVcpus: 0 }, { numCoresPerVcpu: 32 }, { memoryMib: 100 }, { numVcpus: 2.5 }]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/nutanix/vms/${VM_UUID}/compute`,
        cookies: adminCookie(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("met à jour num_sockets/num_vcpus_per_socket/memory_size_mib — champs fournis uniquement, reste du spec intact", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    queueResponse(PUT_KEY, vmEntity());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/nutanix/vms/${VM_UUID}/compute`,
      cookies: adminCookie(),
      payload: { numVcpus: 4, memoryMib: 16384 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
    const body = lastRequestBodyByKey.get(PUT_KEY) as {
      spec: {
        resources: {
          num_sockets: number;
          num_vcpus_per_socket: number;
          memory_size_mib: number;
          boot_config: unknown;
          disk_list: unknown[];
          power_state: string;
        };
      };
    };
    expect(body.spec.resources.num_sockets).toBe(4);
    expect(body.spec.resources.memory_size_mib).toBe(16384);
    // Champ NON fourni : valeur d'origine, jamais touchée.
    expect(body.spec.resources.num_vcpus_per_socket).toBe(2);
    // boot_config JAMAIS touché ("Boot Configuration cannot be updated while the VM is running").
    expect(body.spec.resources.boot_config).toEqual({
      boot_device: { disk_address: { adapter_type: "SCSI", device_index: 0 } },
      boot_type: "UEFI",
    });
    expect(body.spec.resources.disk_list).toEqual([realDiskEntry(0), realCdromEntry]);
    expect(body.spec.resources.power_state).toBe("ON");
  });

  it("refus à-chaud de Prism Central : l'erreur réelle remonte TELLE QUELLE (502 + message), jamais masquée", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity());
    queueResponse(PUT_KEY, { state: "ERROR", message_list: [{ message: "Cannot decrease memory on a powered on VM" }] }, 422);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/nutanix/vms/${VM_UUID}/compute`,
      cookies: adminCookie(),
      payload: { memoryMib: 4096 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("Cannot decrease memory on a powered on VM");
  });
});
