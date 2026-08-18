import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Étage "déploiement" Nutanix : GET/POST /api/nutanix/images, POST /api/nutanix/vms (cloud-init),
 * GET /api/nutanix/tasks/:uuid — voir services/nutanix.ts (section du 18/08/2026). Même harnais
 * que nutanixVmActions.test.ts : node:https mocké (JAMAIS un vrai socket vers Prism Central — les
 * mutations POST /images et POST /vms ne sont exercées QUE contre ce mock), file de réponses par
 * `${method} ${pathname}`, setupStore réel seedé dans un CONFIG_PATH temporaire isolé.
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

const IMAGE_UUID = "9f8e7d6c-1111-2222-3333-444455556666";
const SUBNET_UUID = "1a2b3c4d-aaaa-bbbb-cccc-ddddeeeeffff";
const CLUSTER_UUID = "0005b4db-f6b4-0926-62f9-3cecef178022";
const TASK_UUID = "4656bab7-ed37-437a-6059-e82fc425e420";

async function seedNutanixConfig(): Promise<void> {
  await setNutanixConfig({ prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: "secret" });
}

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

/** Entités image reproduisant la forme RÉELLE observée en lecture seule le 18/08/2026 (POST
 * /images/list sur l'instance 172.20.0.10:9440 — metadata/spec/status, size_bytes côté status). */
function seedImagesList(): void {
  queueResponse("POST /api/nutanix/v3/images/list", {
    entities: [
      {
        metadata: { uuid: IMAGE_UUID, kind: "image", spec_version: 0 },
        spec: { name: "ubuntu-24.04-cloudimg", resources: { image_type: "DISK_IMAGE", architecture: "X86_64" } },
        status: { name: "ubuntu-24.04-cloudimg", state: "COMPLETE", resources: { image_type: "DISK_IMAGE", size_bytes: 3758096384 } },
      },
      {
        metadata: { uuid: "0366005c-515c-4ee7-ba6e-379da8084255", kind: "image" },
        spec: { name: "Windows 2019 FR Server", resources: { image_type: "ISO_IMAGE" } },
        status: { name: "Windows 2019 FR Server", state: "COMPLETE", resources: { image_type: "ISO_IMAGE", size_bytes: 5367431168 } },
      },
    ],
    metadata: { kind: "image", total_matches: 2 },
  });
}

function seedSubnetsList(): void {
  queueResponse("POST /api/nutanix/v3/subnets/list", {
    entities: [{ metadata: { uuid: SUBNET_UUID }, status: { name: "VLAN_SERVEURS", resources: { vlan_id: 12 } } }],
  });
}

function seedClustersList(entities?: unknown[]): void {
  queueResponse("POST /api/nutanix/v3/clusters/list", {
    entities: entities ?? [{ metadata: { uuid: CLUSTER_UUID }, status: { name: "CLUSTER_AHV_HDV" } }],
  });
}

describe("Déploiement Nutanix — autorisation", () => {
  it("401 sans session sur GET /api/nutanix/images", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/images" });
    expect(response.statusCode).toBe(401);
  });

  it("403 pour un rôle viewer sur POST /api/nutanix/images (operator/admin requis)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/images",
      cookies: viewerCookie(),
      payload: { name: "x", sourceUri: "https://example.org/img.qcow2" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("403 pour un rôle viewer sur POST /api/nutanix/vms", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: viewerCookie(), payload: {} });
    expect(response.statusCode).toBe(403);
  });

  it("401 sans session sur GET /api/nutanix/tasks/:uuid", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: `/api/nutanix/tasks/${TASK_UUID}` });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/nutanix/images", () => {
  it("liste les images (forme réelle : uuid/nom/taille/type) — accessible à un simple viewer", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedImagesList();

    const response = await app.inject({ method: "GET", url: "/api/nutanix/images", cookies: viewerCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { uuid: IMAGE_UUID, name: "ubuntu-24.04-cloudimg", sizeBytes: 3758096384, imageType: "DISK_IMAGE" },
      { uuid: "0366005c-515c-4ee7-ba6e-379da8084255", name: "Windows 2019 FR Server", sizeBytes: 5367431168, imageType: "ISO_IMAGE" },
    ]);
  });

  it("[] si Nutanix n'a jamais été configuré (jamais de fausses images)", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/images", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("POST /api/nutanix/images", () => {
  it("400 si name ou sourceUri manquant", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({ method: "POST", url: "/api/nutanix/images", cookies: adminCookie(), payload: { name: "ubuntu" } });
    expect(response.statusCode).toBe(400);
  });

  it("400 si sourceUri n'est pas une URL http(s)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/images",
      cookies: adminCookie(),
      payload: { name: "ubuntu", sourceUri: "ftp://example.org/img.qcow2" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("crée une image DISK_IMAGE depuis une URL et renvoie le taskUuid", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(
      "POST /api/nutanix/v3/images",
      { metadata: { uuid: "new-image-uuid" }, status: { execution_context: { task_uuid: "t-img" } } },
      202,
    );

    const sourceUri = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/images",
      cookies: adminCookie(),
      payload: { name: "ubuntu-24.04-cloudimg", sourceUri },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, name: "ubuntu-24.04-cloudimg", taskUuid: "t-img" });
    const body = lastRequestBodyByKey.get("POST /api/nutanix/v3/images") as {
      metadata: { kind: string };
      spec: { name: string; resources: { image_type: string; source_uri: string } };
    };
    expect(body.metadata.kind).toBe("image");
    expect(body.spec.name).toBe("ubuntu-24.04-cloudimg");
    expect(body.spec.resources.image_type).toBe("DISK_IMAGE");
    expect(body.spec.resources.source_uri).toBe(sourceUri);
  });

  it("405 REQUEST_NOT_SUPPORTED : 502 explicite, AUCUN repli v2.0 (forme v2 jamais vérifiée)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(
      "POST /api/nutanix/v3/images",
      { code: 405, message_list: [{ message: "not supported", reason: "REQUEST_NOT_SUPPORTED" }], state: "ERROR" },
      405,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/images",
      cookies: adminCookie(),
      payload: { name: "ubuntu", sourceUri: "https://example.org/img.qcow2" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(/REQUEST_NOT_SUPPORTED/);
    expect([...lastRequestBodyByKey.keys()].some((k) => k.includes("/PrismGateway/"))).toBe(false);
  });
});

describe("POST /api/nutanix/vms", () => {
  const vmPayload = {
    name: "web-01",
    imageUuid: IMAGE_UUID,
    subnetUuid: SUBNET_UUID,
    numVcpus: 2,
    numCoresPerVcpu: 2,
    memoryMib: 4096,
    diskSizeMib: 20480,
    guestCustomization: {
      hostname: "web-01",
      username: "ubuntu",
      password: "S3cret!pass",
      sshAuthorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExempleClef ubuntu@quai",
    },
  };

  function seedAll(): void {
    seedSubnetsList();
    seedImagesList();
    seedClustersList();
  }

  it("400 si numVcpus/memoryMib manquants", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { name: "web-01", imageUuid: IMAGE_UUID, subnetUuid: SUBNET_UUID },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400 si numVcpus hors bornes QUAI", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { ...vmPayload, numVcpus: 999 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400 si guestCustomization sans password NI sshAuthorizedKey", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { ...vmPayload, guestCustomization: { username: "ubuntu" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400 si username invalide (jamais échoïsé tel quel dans un YAML fragile)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { ...vmPayload, guestCustomization: { username: "Root User", password: "x" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404 si le subnet est inconnu", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse("POST /api/nutanix/v3/subnets/list", { entities: [] });
    seedImagesList();
    seedClustersList();

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });
    expect(response.statusCode).toBe(404);
  });

  it("404 si l'image est inconnue", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedSubnetsList();
    queueResponse("POST /api/nutanix/v3/images/list", { entities: [] });
    seedClustersList();

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });
    expect(response.statusCode).toBe(404);
  });

  it("409 si PLUSIEURS clusters existent (choix de cluster hors contrat — jamais un choix silencieux)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedSubnetsList();
    seedImagesList();
    seedClustersList([
      { metadata: { uuid: CLUSTER_UUID }, status: { name: "CLUSTER_AHV_HDV" } },
      { metadata: { uuid: "second-cluster" }, status: { name: "AUTRE" } },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });
    expect(response.statusCode).toBe(409);
  });

  it("crée la VM : spec complète (image, subnet, compute, cluster unique, power ON, cloud-init base64)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    queueResponse(
      "POST /api/nutanix/v3/vms",
      { metadata: { uuid: "new-vm-uuid" }, status: { execution_context: { task_uuid: "t-vm" } } },
      202,
    );

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, name: "web-01", vmUuid: "new-vm-uuid", taskUuid: "t-vm" });

    const body = lastRequestBodyByKey.get("POST /api/nutanix/v3/vms") as {
      api_version: string;
      metadata: { kind: string };
      spec: {
        name: string;
        cluster_reference: { kind: string; uuid: string; name: string };
        resources: {
          power_state: string;
          num_sockets: number;
          num_vcpus_per_socket: number;
          memory_size_mib: number;
          disk_list: {
            device_properties: { device_type: string; disk_address: { adapter_type: string; device_index: number } };
            data_source_reference: { kind: string; uuid: string };
            disk_size_mib: number;
          }[];
          nic_list: { nic_type: string; subnet_reference: { kind: string; uuid: string }; is_connected: boolean }[];
          guest_customization: { cloud_init: { user_data: string } };
        };
      };
    };
    expect(body.metadata.kind).toBe("vm");
    expect(body.spec.name).toBe("web-01");
    expect(body.spec.cluster_reference).toEqual({ kind: "cluster", uuid: CLUSTER_UUID, name: "CLUSTER_AHV_HDV" });
    expect(body.spec.resources.power_state).toBe("ON");
    expect(body.spec.resources.num_sockets).toBe(2);
    expect(body.spec.resources.num_vcpus_per_socket).toBe(2);
    expect(body.spec.resources.memory_size_mib).toBe(4096);
    expect(body.spec.resources.disk_list).toHaveLength(1);
    expect(body.spec.resources.disk_list[0].device_properties).toEqual({
      device_type: "DISK",
      disk_address: { adapter_type: "SCSI", device_index: 0 },
    });
    expect(body.spec.resources.disk_list[0].data_source_reference).toEqual({ kind: "image", uuid: IMAGE_UUID });
    expect(body.spec.resources.disk_list[0].disk_size_mib).toBe(20480);
    expect(body.spec.resources.nic_list[0].subnet_reference).toEqual({ kind: "subnet", uuid: SUBNET_UUID });
    expect(body.spec.resources.nic_list[0].is_connected).toBe(true);

    const userData = Buffer.from(body.spec.resources.guest_customization.cloud_init.user_data, "base64").toString("utf-8");
    expect(userData.startsWith("#cloud-config")).toBe(true);
    expect(userData).toContain("hostname: 'web-01'");
    expect(userData).toContain("- name: 'ubuntu'");
    expect(userData).toContain("sudo: 'ALL=(ALL) NOPASSWD:ALL'");
    expect(userData).toContain("ssh_authorized_keys:");
    expect(userData).toContain("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExempleClef ubuntu@quai");
    expect(userData).toContain("ssh_pwauth: true");
    expect(userData).toContain("chpasswd:");
    expect(userData).toContain("password: 'S3cret!pass'");
  });

  it("crée une VM SANS guestCustomization : aucun guest_customization dans la spec", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    queueResponse("POST /api/nutanix/v3/vms", { metadata: { uuid: "new-vm-uuid" } }, 202);

    const { guestCustomization: _gc, ...noGc } = vmPayload;
    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: noGc });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, name: "web-01", vmUuid: "new-vm-uuid" });
    const body = lastRequestBodyByKey.get("POST /api/nutanix/v3/vms") as { spec: { resources: Record<string, unknown> } };
    expect(body.spec.resources.guest_customization).toBeUndefined();
  });

  it("un refus Prism ne contient JAMAIS le mot de passe ni le user_data (redaction)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    // Erreur Prism qui échoïse le mot de passe — le message renvoyé à l'UI doit le masquer.
    queueResponse(
      "POST /api/nutanix/v3/vms",
      { code: 422, message_list: [{ message: "invalid spec: bad password S3cret!pass in user_data", reason: "INVALID_SPEC" }], state: "ERROR" },
      422,
    );

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });

    expect(response.statusCode).toBe(502);
    const error = response.json().error as string;
    expect(error).not.toContain("S3cret!pass");
    expect(error).not.toContain("cloud-config");
    expect(error).toContain("[REDACTED]");
    expect(error).toMatch(/INVALID_SPEC/);
  });

  it("405 REQUEST_NOT_SUPPORTED : 502 explicite, AUCUN repli v2.0 tenté (forme v2 jamais vérifiée)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    queueResponse(
      "POST /api/nutanix/v3/vms",
      { code: 405, message_list: [{ message: "not supported", reason: "REQUEST_NOT_SUPPORTED" }], state: "ERROR" },
      405,
    );

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: vmPayload });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(/REQUEST_NOT_SUPPORTED/);
    expect([...lastRequestBodyByKey.keys()].some((k) => k.includes("/PrismGateway/"))).toBe(false);
  });
});

describe("POST /api/nutanix/vms — variant ISO (isoImageUuid + diskSizeMib)", () => {
  const ISO_UUID = "0366005c-515c-4ee7-ba6e-379da8084255";
  const isoPayload = {
    name: "win-01",
    isoImageUuid: ISO_UUID,
    subnetUuid: SUBNET_UUID,
    numVcpus: 4,
    memoryMib: 8192,
    diskSizeMib: 102400,
  };

  function seedAll(): void {
    seedSubnetsList();
    seedImagesList();
    seedClustersList();
  }

  it("400 si imageUuid ET isoImageUuid fournis (exclusifs)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { ...isoPayload, imageUuid: IMAGE_UUID },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/imageUuid|isoImageUuid/);
  });

  it("400 si NI imageUuid NI isoImageUuid", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const { isoImageUuid: _iso, ...neither } = isoPayload;
    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: neither });
    expect(response.statusCode).toBe(400);
  });

  it("400 si isoImageUuid sans diskSizeMib (taille du disque vide requise)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const { diskSizeMib: _d, ...noDisk } = isoPayload;
    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: noDisk });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/diskSizeMib/);
  });

  it("400 si isoImageUuid pointe une image DISK_IMAGE (pas un ISO)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    const response = await app.inject({
      method: "POST",
      url: "/api/nutanix/vms",
      cookies: adminCookie(),
      payload: { ...isoPayload, isoImageUuid: IMAGE_UUID },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/ISO_IMAGE/);
  });

  it("404 si l'ISO est inconnu du catalogue", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedSubnetsList();
    queueResponse("POST /api/nutanix/v3/images/list", { entities: [] });
    seedClustersList();
    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: isoPayload });
    expect(response.statusCode).toBe(404);
  });

  it("crée la VM ISO : disque SCSI VIDE + CDROM sur l'ISO, boot CDROM puis DISK, sans guest_customization", async () => {
    app = buildServer();
    await seedNutanixConfig();
    seedAll();
    queueResponse(
      "POST /api/nutanix/v3/vms",
      { metadata: { uuid: "new-iso-vm" }, status: { execution_context: { task_uuid: "t-iso" } } },
      202,
    );

    const response = await app.inject({ method: "POST", url: "/api/nutanix/vms", cookies: adminCookie(), payload: isoPayload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, name: "win-01", vmUuid: "new-iso-vm", taskUuid: "t-iso" });

    const body = lastRequestBodyByKey.get("POST /api/nutanix/v3/vms") as {
      spec: {
        resources: {
          disk_list: {
            device_properties: { device_type: string; disk_address: { adapter_type: string; device_index: number } };
            data_source_reference?: { kind: string; uuid: string };
            disk_size_mib?: number;
          }[];
          boot_config?: { boot_device_order_list: string[] };
          guest_customization?: unknown;
        };
      };
    };
    expect(body.spec.resources.disk_list).toHaveLength(2);
    const [disk, cdrom] = body.spec.resources.disk_list;
    expect(disk!.device_properties).toEqual({ device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: 0 } });
    expect(disk!.disk_size_mib).toBe(102400);
    expect(disk!.data_source_reference).toBeUndefined();
    expect(cdrom!.device_properties.device_type).toBe("CDROM");
    expect(cdrom!.data_source_reference).toEqual({ kind: "image", uuid: ISO_UUID });
    expect(cdrom!.disk_size_mib).toBeUndefined();
    expect(body.spec.resources.boot_config).toEqual({ boot_device_order_list: ["CDROM", "DISK"] });
    expect(body.spec.resources.guest_customization).toBeUndefined();
  });
});

describe("GET /api/nutanix/tasks/:uuid", () => {
  it("renvoie l'état de la tâche (réponse v3 PLATE, forme réelle vérifiée le 18/08/2026) — accessible à un viewer", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/tasks/${TASK_UUID}`, {
      api_version: "3.1",
      uuid: TASK_UUID,
      status: "RUNNING",
      percentage_complete: 42,
      operation_type: "create_image_intentful",
      progress_message: "Creating image",
    });

    const response = await app.inject({ method: "GET", url: `/api/nutanix/tasks/${TASK_UUID}`, cookies: viewerCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ uuid: TASK_UUID, status: "RUNNING", percentageComplete: 42 });
  });

  it("404 si la tâche est inconnue", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/tasks/${TASK_UUID}`, { state: "ERROR", code: 404 }, 404);

    const response = await app.inject({ method: "GET", url: `/api/nutanix/tasks/${TASK_UUID}`, cookies: viewerCookie() });
    expect(response.statusCode).toBe(404);
  });

  it("400 si Nutanix n'a jamais été configuré", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: `/api/nutanix/tasks/${TASK_UUID}`, cookies: viewerCookie() });
    expect(response.statusCode).toBe(400);
  });
});
