import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * CANAL D'EXÉCUTION générique des actions de greffons — POST /api/plugins/:id/actions/:actionId.
 *
 * AUCUN test ne contacte l'infrastructure réelle : `node:https` est mocké (même dispositif que
 * nutanixPlugin.test.ts) et les mutations de services/nutanix.ts sont espionnées. Les refus, la
 * validation de l'entrée d'après le manifeste et l'écriture au journal d'audit sont exercés sur le
 * code RÉEL (route, registre, activation, hook d'audit).
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-actions-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "3".repeat(64);

/** Aucune requête ne doit atteindre ce mock : les actions passent toutes par les espions ci-dessous. */
vi.mock("node:https", () => ({
  request: (_target: URL, _options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode: 500 });
      callback(res);
      res.emit("data", Buffer.from("{}"));
      res.emit("end");
    };
    return req;
  },
}));

const startNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const stopNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const deleteNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const addNutanixVmDiskMock = vi.fn<[string, { sizeMib: number }], Promise<unknown>>();
const addNutanixVmNicMock = vi.fn<[string, { subnetUuid: string }], Promise<unknown>>();
const updateNutanixVmComputeMock = vi.fn<[string, Record<string, number>], Promise<unknown>>();
const createNutanixImageMock = vi.fn<[unknown], Promise<unknown>>();

vi.mock("../src/services/nutanix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/nutanix.js")>();
  return {
    ...actual,
    startNutanixVm: (uuid: string) => startNutanixVmMock(uuid),
    stopNutanixVm: (uuid: string) => stopNutanixVmMock(uuid),
    deleteNutanixVm: (uuid: string) => deleteNutanixVmMock(uuid),
    addNutanixVmDisk: (uuid: string, opts: { sizeMib: number }) => addNutanixVmDiskMock(uuid, opts),
    addNutanixVmNic: (uuid: string, opts: { subnetUuid: string }) => addNutanixVmNicMock(uuid, opts),
    updateNutanixVmCompute: (uuid: string, opts: Record<string, number>) => updateNutanixVmComputeMock(uuid, opts),
    createNutanixImage: (input: unknown) => createNutanixImageMock(input),
  };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { NutanixActionError } = await import("../src/services/nutanix.js");
const { listAuditEvents } = await import("../src/services/auditLog.js");
const { resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { removeNutanixPluginConfig, saveNutanixPluginConfig } = await import("../src/plugins/nutanix/config.js");
const { removeHycuPluginConfig, saveHycuPluginConfig } = await import("../src/plugins/hycu/config.js");
const { nutanixPlugin } = await import("../src/plugins/nutanix/index.js");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const VM_UUID = "dc52605f-e91a-4dd2-b966-3dd76c52bf8d";
const SUBNET_UUID = "6f0a8b1c-2d3e-4f50-8a9b-0c1d2e3f4a5b";
const NUTANIX_PASSWORD = "MotDePassePrism-tres-secret-0123";

let app: FastifyInstance | undefined;

beforeEach(() => {
  startNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
  stopNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
  deleteNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVTEST" });
  addNutanixVmDiskMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI", sizeMib: 10240 });
  addNutanixVmNicMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI", subnetName: "VLAN_SERVEURS" });
  updateNutanixVmComputeMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
  createNutanixImageMock.mockResolvedValue({ ok: true, name: "debian-13" });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
  resetPluginRegistryForTests();
  await fs.rm(path.join(tmpDir, "audit-log.jsonl"), { force: true });
  await removeNutanixPluginConfig();
  await removeHycuPluginConfig();
});

function cookieFor(roles: Array<"admin" | "operator" | "viewer">) {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles });
  return { [config.session.cookieName]: token };
}

const adminCookie = () => cookieFor(["admin"]);

function actionUrl(pluginId: string, actionId: string): string {
  return `/api/plugins/${pluginId}/actions/${actionId}`;
}

async function seedNutanix(): Promise<void> {
  await saveNutanixPluginConfig({ prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: NUTANIX_PASSWORD });
}

/** Identifiants déjà présents dans le journal — à relever AVANT l'appel étudié. */
async function auditEventIds(): Promise<Set<string>> {
  return new Set((await listAuditEvents()).map((e) => e.id));
}

/** Le hook d'audit écrit APRÈS l'envoi de la réponse (onResponse) : on repolle brièvement plutôt
 * que de supposer une écriture synchrone. `known` écarte les événements antérieurs — l'écriture
 * étant asynchrone, celle d'un test précédent peut atterrir ici, et un test voisin appelle la même
 * action volontairement en échec : sans ce filtre, les assertions porteraient sur SON événement. */
async function waitForAuditEvent(
  predicate: (e: Awaited<ReturnType<typeof listAuditEvents>>[number]) => boolean,
  known: Set<string> = new Set(),
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await listAuditEvents()).find((e) => !known.has(e.id) && predicate(e));
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function expectNoService(): void {
  expect(startNutanixVmMock).not.toHaveBeenCalled();
  expect(stopNutanixVmMock).not.toHaveBeenCalled();
  expect(deleteNutanixVmMock).not.toHaveBeenCalled();
  expect(addNutanixVmDiskMock).not.toHaveBeenCalled();
  expect(addNutanixVmNicMock).not.toHaveBeenCalled();
  expect(updateNutanixVmComputeMock).not.toHaveBeenCalled();
}

describe("POST /api/plugins/:id/actions/:actionId — refus explicites", () => {
  it("exige une session, puis le rôle admin", async () => {
    app = buildServer();

    const anonymous = await app.inject({ method: "POST", url: actionUrl("nutanix", "vm.start"), payload: { nodeId: VM_UUID } });
    expect(anonymous.statusCode).toBe(401);

    for (const roles of [["viewer"], ["operator"]] as Array<Array<"admin" | "operator" | "viewer">>) {
      const refused = await app.inject({
        method: "POST",
        url: actionUrl("nutanix", "vm.start"),
        cookies: cookieFor(roles),
        payload: { nodeId: VM_UUID },
      });
      expect(refused.statusCode, roles.join()).toBe(403);
    }
    expectNoService();
  });

  it("404 pour un greffon inconnu", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: actionUrl("inexistant", "vm.start"), cookies: adminCookie(), payload: {} });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toContain("inexistant");
  });

  it("409 pour un greffon DÉSACTIVÉ — sans le moindre appel à l'intégration", async () => {
    await seedNutanix();
    app = buildServer();

    const off = await app.inject({ method: "PUT", url: "/api/plugins/nutanix/enabled", cookies: adminCookie(), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.start"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toContain("désactivé");
    expectNoService();
  });

  it("403 pour un greffon en LECTURE SEULE (HYCU n'expose aucune action)", async () => {
    await saveHycuPluginConfig({ url: "https://172.20.0.100:8443", username: "quai-ro", password: "MotDePasseHycu-0123456789" });
    app = buildServer();

    const response = await app.inject({ method: "POST", url: actionUrl("hycu", "backup.run"), cookies: adminCookie(), payload: {} });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toContain("lecture seule");
  });

  it("404 pour une action inconnue d'un greffon mutant", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: actionUrl("nutanix", "vm.teleporter"), cookies: adminCookie(), payload: {} });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toContain("vm.teleporter");
    expectNoService();
  });

  it("400 quand la cible manque : une action de VM ne s'exécute jamais sur une cible devinée", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: actionUrl("nutanix", "vm.start"), cookies: adminCookie(), payload: {} });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("nodeId");
    expectNoService();
  });
});

describe("POST /api/plugins/:id/actions/:actionId — l'entrée est validée d'après le manifeste", () => {
  it("champ obligatoire absent : 400, et l'intégration n'est pas appelée", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: {} },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("Taille du disque");
    expectNoService();
  });

  it("valeur hors des bornes RÉELLES du service : 400 avant tout appel", async () => {
    app = buildServer();
    const tooSmall = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { sizeMib: 512 } },
    });
    expect(tooSmall.statusCode).toBe(400);
    expect((tooSmall.json() as { error: string }).error).toContain("1024");

    const tooBig = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { sizeMib: 3 * 1024 * 1024 } },
    });
    expect(tooBig.statusCode).toBe(400);
    expectNoService();
  });

  it("champ non déclaré : refusé, jamais transmis en douce à une action mutante", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { sizeMib: 10240, storageContainerUuid: "choisi-a-la-main" } },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("storageContainerUuid");
    expectNoService();
  });

  it("la cible ne peut pas être ré-écrite par l'entrée : elle vient TOUJOURS de nodeId", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.start"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { uuid: "une-autre-vm-de-production" } },
    });

    expect(response.statusCode).toBe(400);
    expectNoService();
  });
});

describe("POST /api/plugins/:id/actions/:actionId — exécution réelle du greffon Nutanix", () => {
  it("action sans paramètre : la cible du corps atteint le service, telle quelle", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.start"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, result: { ok: true, vmName: "HDVAPPLI" } });
    expect(startNutanixVmMock).toHaveBeenCalledWith(VM_UUID);
  });

  it("action à paramètres : entrée validée puis transmise, cible comprise", async () => {
    app = buildServer();

    const disk = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { sizeMib: 10240 } },
    });
    expect(disk.statusCode).toBe(200);
    expect(addNutanixVmDiskMock).toHaveBeenCalledWith(VM_UUID, { sizeMib: 10240 });

    const nic = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-nic"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { subnetUuid: SUBNET_UUID } },
    });
    expect(nic.statusCode).toBe(200);
    expect(addNutanixVmNicMock).toHaveBeenCalledWith(VM_UUID, { subnetUuid: SUBNET_UUID });

    // Les trois champs de vm.update-compute sont facultatifs : n'en fournir qu'un reste valide.
    const compute = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.update-compute"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, input: { memoryMib: 16384 } },
    });
    expect(compute.statusCode).toBe(200);
    expect(updateNutanixVmComputeMock).toHaveBeenCalledWith(VM_UUID, { memoryMib: 16384 });
  });

  it("action SANS cible (catalogue d'images) : aucun nodeId exigé", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "image.create"),
      cookies: adminCookie(),
      payload: { input: { name: "debian-13", sourceUri: "https://exemple.fr/debian-13.qcow2" } },
    });

    expect(response.statusCode).toBe(200);
    expect(createNutanixImageMock).toHaveBeenCalledWith({ name: "debian-13", sourceUri: "https://exemple.fr/debian-13.qcow2" });
  });

  it("accepte aussi un corps qui porte directement les champs de l'action", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.add-disk"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID, sizeMib: 20480 },
    });

    expect(response.statusCode).toBe(200);
    expect(addNutanixVmDiskMock).toHaveBeenCalledWith(VM_UUID, { sizeMib: 20480 });
  });

  it("l'erreur du greffon garde son statut HTTP et son message réels", async () => {
    deleteNutanixVmMock.mockRejectedValue(new NutanixActionError("VM is powered on — stop it before deleting", 409));
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.delete"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("VM is powered on — stop it before deleting");
  });

  it("une erreur sans statut ne passe jamais pour un succès", async () => {
    stopNutanixVmMock.mockRejectedValue(new Error("ECONNRESET"));
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.stop"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID },
    });

    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: string }).error).toBe("ECONNRESET");
  });
});

describe("Journal de traçabilité", () => {
  it("journalise l'action par le hook existant, avec de quoi la nommer — jamais le corps", async () => {
    await seedNutanix();
    app = buildServer();
    const known = await auditEventIds();

    await app.inject({
      method: "POST",
      url: actionUrl("nutanix", "vm.stop"),
      cookies: adminCookie(),
      payload: { nodeId: VM_UUID },
    });

    const event = await waitForAuditEvent((e) => e.path === "/api/plugins/nutanix/actions/vm.stop", known);
    expect(event).toBeDefined();
    expect(event?.method).toBe("POST");
    expect(event?.actor).toBe("ybanas");
    expect(event?.ok).toBe(true);
    // Le chemin porte l'identifiant EXACT de l'action : c'est lui que l'interface traduit par le
    // libellé du manifeste (apps/web/src/features/audit/auditMessage.ts).
    expect(nutanixPlugin.manifest.auditLabels["vm.stop"]).toBe("Arrêter (ACPI) une VM Nutanix");
    expect(JSON.stringify(event)).not.toContain(NUTANIX_PASSWORD);
  });

  it("journalise aussi un refus, avec son statut réel", async () => {
    app = buildServer();
    const known = await auditEventIds();
    await app.inject({ method: "POST", url: actionUrl("nutanix", "vm.teleporter"), cookies: adminCookie(), payload: {} });

    const event = await waitForAuditEvent((e) => e.path === "/api/plugins/nutanix/actions/vm.teleporter", known);
    expect(event?.ok).toBe(false);
    expect(event?.statusCode).toBe(404);
  });
});
