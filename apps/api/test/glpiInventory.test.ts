import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { NutanixHost, NutanixVm } from "../src/types.js";

/**
 * Réconciliation d'inventaire QUAI <-> GLPI — services/glpiInventory.ts + routes/glpiInventory.ts.
 *
 * AUCUN test ne touche le GLPI réel (172.16.8.22) ni Prism Central : `fetch` est intégralement
 * mocké et services/nutanix.js est surchargé. Formes GLPI mockées = API REST apirest.php de GLPI 10
 * (initSession/session_token, listes `range=a-b`, POST/PUT `{ input }`, killSession).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const isNutanixConfiguredMock = vi.fn<[], Promise<boolean>>();
const getNutanixVmsMock = vi.fn<[], Promise<NutanixVm[]>>();
const getNutanixHostsMock = vi.fn<[], Promise<NutanixHost[]>>();
const getNutanixClustersMock = vi.fn<[], Promise<Array<{ uuid: string; name: string }>>>();
const lastKnownNutanixPollMock = vi.fn<[], { reachable: boolean; at: string } | null>();

// importOriginal : routes/nutanix.ts importe une trentaine d'autres exports, un mock partiel les
// casserait au chargement de buildServer().
vi.mock("../src/services/nutanix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/nutanix.js")>();
  return {
    ...actual,
    isNutanixConfigured: () => isNutanixConfiguredMock(),
    getNutanixVms: () => getNutanixVmsMock(),
    getNutanixHosts: () => getNutanixHostsMock(),
    getNutanixClusters: () => getNutanixClustersMock(),
    lastKnownNutanixPoll: () => lastKnownNutanixPollMock(),
  };
});

interface MockResponse {
  status: number;
  body: unknown;
}

interface RecordedRequest {
  key: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const API_URL = "http://glpi.test/apirest.php";
const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();
const recorded: RecordedRequest[] = [];

function queueResponse(key: string, body: unknown, status = 200): void {
  queuesByKey.set(key, [...(queuesByKey.get(key) ?? []), { status, body }]);
}

function nextResponse(key: string): MockResponse {
  const queue = queuesByKey.get(key);
  if (queue && queue.length > 0) {
    const found = queue.shift()!;
    lastByKey.set(key, found);
    return found;
  }
  // Itemtype non explicitement mocké : liste vide (200) — jamais une panne fabriquée.
  return lastByKey.get(key) ?? { status: 200, body: [] };
}

function keyOf(url: string, method: string): string {
  const parsed = new URL(url);
  return `${method} ${parsed.pathname.replace(/^\/apirest\.php\/?/, "")}`;
}

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const key = keyOf(url, method);
  recorded.push({ key, url, headers: init?.headers ?? {}, body: init?.body ? (JSON.parse(init.body) as unknown) : undefined });
  const found = nextResponse(key);
  return new Response(JSON.stringify(found.body), { status: found.status, headers: { "Content-Type": "application/json" } });
});
vi.stubGlobal("fetch", fetchMock);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { removeGlpiPluginConfig, saveGlpiPluginConfig } = await import("../src/plugins/glpi/config.js");
const { QUAI_PROVENANCE_PREFIX, reconcileInventory } = await import("../src/services/glpiInventory.js");
type RealResource = import("../src/services/glpiInventory.js").RealResource;
type GlpiComputerRecord = import("../src/services/glpiInventory.js").GlpiComputerRecord;

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  isNutanixConfiguredMock.mockResolvedValue(true);
  getNutanixVmsMock.mockResolvedValue([]);
  getNutanixHostsMock.mockResolvedValue([]);
  getNutanixClustersMock.mockResolvedValue([]);
  lastKnownNutanixPollMock.mockReturnValue({ reachable: true, at: "2026-08-19T08:00:00.000Z" });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  queuesByKey.clear();
  lastByKey.clear();
  recorded.length = 0;
  fetchMock.mockClear();
  vi.clearAllMocks();
  await removeGlpiPluginConfig();
});

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}
function viewerCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] }) };
}

async function seedGlpiConfig(): Promise<void> {
  await saveGlpiPluginConfig({ apiUrl: API_URL, appToken: "app-token-de-test", userToken: "user-token-de-test" });
}

const VM_APPLI = "0005c1f0-1111-4a2b-8c3d-000000000001";
const VM_EXCH = "0005c1f0-1111-4a2b-8c3d-000000000002";
const VM_DISPARUE = "0005c1f0-1111-4a2b-8c3d-000000000009";
const HOST_1 = "0005c1f0-2222-4a2b-8c3d-000000000001";

function vm(overrides: Partial<NutanixVm> & { id: string; name: string }): NutanixVm {
  return {
    powerState: "on",
    numVcpus: 4,
    memoryMib: 8192,
    cluster: "HDV",
    ...overrides,
  } as NutanixVm;
}

function realVm(overrides: Partial<RealResource> & { id: string; name: string }): RealResource {
  return { kind: "nutanix-vm", uuid: overrides.id, vcpu: 4, memoryMib: 8192, ...overrides };
}

function glpiComputer(overrides: Partial<GlpiComputerRecord> & { id: number; name: string }): GlpiComputerRecord {
  return { ...overrides };
}

// --- Fonction pure de réconciliation -----------------------------------------------------------

describe("reconcileInventory — les trois catégories d'écart", () => {
  it("missing-in-glpi : une VM réelle sans aucune fiche GLPI", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [],
      nutanixHostNames: ["HDVNUTA1"],
    });

    expect(result.missingInGlpi.map((r) => r.name)).toEqual(["HDVAPPLI"]);
    expect(result.drifted).toHaveLength(0);
    expect(result.staleInGlpi).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
  });

  it("drifted : fiche appariée par uuid, détail champ par champ (valeur GLPI vs valeur réelle)", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI", ipAddresses: ["172.20.1.10"], hostName: "HDVNUTA1" })],
      computers: [
        glpiComputer({
          id: 7,
          name: "HDVAPPLI",
          uuid: VM_APPLI,
          vcpu: 2,
          memoryMib: 4096,
          ipAddresses: ["172.20.1.99"],
          virtualizationHost: "HDVNUTA2",
        }),
      ],
      nutanixHostNames: ["HDVNUTA1", "HDVNUTA2"],
    });

    expect(result.drifted).toHaveLength(1);
    const pair = result.drifted[0]!;
    expect(pair.matchedBy).toBe("uuid");
    const byField = new Map(pair.differences.map((d) => [d.field, d]));
    expect(byField.get("vcpu")).toMatchObject({ glpiValue: 2, realValue: 4, fixable: false });
    expect(byField.get("memoryMib")).toMatchObject({ glpiValue: 4096, realValue: 8192, fixable: false });
    expect(byField.get("ipAddresses")).toMatchObject({ glpiValue: ["172.20.1.99"], realValue: ["172.20.1.10"] });
    expect(byField.get("host")).toMatchObject({ glpiValue: "HDVNUTA2", realValue: "HDVNUTA1" });
    // name/uuid identiques : jamais listés comme écart.
    expect(byField.has("name")).toBe(false);
    expect(byField.has("uuid")).toBe(false);
  });

  it("stale-in-glpi : fiche créée par QUAI dont la ressource réelle a disparu", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [
        glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_APPLI }),
        glpiComputer({ id: 12, name: "HDVOBSOLETE", comment: `${QUAI_PROVENANCE_PREFIX}nutanix-vm:${VM_DISPARUE}` }),
      ],
      nutanixHostNames: ["HDVNUTA1"],
    });

    expect(result.staleInGlpi).toHaveLength(1);
    expect(result.staleInGlpi[0]!.glpi.id).toBe(12);
    expect(result.staleInGlpi[0]!.scopeReason).toBe("provenance-marker");
    expect(result.outOfScopeGlpiCount).toBe(0);
  });

  it("stale-in-glpi : fiche que GLPI déclare VM d'un hôte Nutanix réel, sans VM réelle correspondante", () => {
    const result = reconcileInventory({
      resources: [],
      computers: [glpiComputer({ id: 21, name: "HDVANCIENNE", uuid: VM_DISPARUE, virtualizationHost: "HDVNUTA1" })],
      nutanixHostNames: ["HDVNUTA1"],
    });

    expect(result.staleInGlpi).toHaveLength(1);
    expect(result.staleInGlpi[0]!.scopeReason).toBe("glpi-virtual-machine-of-nutanix-host");
  });

  it("hors périmètre : une fiche GLPI non attribuable à QUAI n'est JAMAIS déclarée obsolète", () => {
    const result = reconcileInventory({
      resources: [],
      computers: [
        glpiComputer({ id: 30, name: "PC-ACCUEIL-01", uuid: "11111111-2222-3333-4444-555555555555" }),
        glpiComputer({ id: 31, name: "PC-URBANISME-04" }),
      ],
      nutanixHostNames: ["HDVNUTA1"],
    });

    expect(result.staleInGlpi).toHaveLength(0);
    expect(result.outOfScopeGlpiCount).toBe(2);
  });
});

describe("reconcileInventory — ambiguïté : ne conclut RIEN", () => {
  it("deux fiches GLPI partagent le même uuid", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_APPLI }), glpiComputer({ id: 8, name: "HDVAPPLI-COPIE", uuid: VM_APPLI })],
      nutanixHostNames: [],
    });

    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.glpiCandidates.map((c) => c.id).sort()).toEqual([7, 8]);
    expect(result.drifted).toHaveLength(0);
    expect(result.inSync).toHaveLength(0);
    // Surtout pas "missing" : l'ambiguïté n'est pas une absence.
    expect(result.missingInGlpi).toHaveLength(0);
  });

  it("homonymes côté GLPI : deux fiches portent le même nom", () => {
    const result = reconcileInventory({
      resources: [{ kind: "nutanix-vm", id: "vm-sans-uuid", name: "HDVAPPLI" }],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI" }), glpiComputer({ id: 8, name: "hdvappli" })],
      nutanixHostNames: [],
    });

    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.reason).toContain("HDVAPPLI");
    expect(result.drifted).toHaveLength(0);
    expect(result.inSync).toHaveLength(0);
  });

  it("homonymes côté réel : deux ressources réelles portent le même nom", () => {
    const result = reconcileInventory({
      resources: [
        { kind: "nutanix-vm", id: "vm-a", name: "SRVDOUBLON" },
        { kind: "nutanix-vm", id: "vm-b", name: "SRVDOUBLON" },
      ],
      computers: [glpiComputer({ id: 9, name: "SRVDOUBLON" })],
      nutanixHostNames: [],
    });

    expect(result.ambiguous).toHaveLength(2);
    expect(result.inSync).toHaveLength(0);
    expect(result.missingInGlpi).toHaveLength(0);
  });

  it("conflit d'identité : même nom mais uuid réels différents des deux côtés", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_EXCH })],
      nutanixHostNames: [],
    });

    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.reason).toContain("uuid différents");
    expect(result.drifted).toHaveLength(0);
  });

  it("une fiche déjà appariée par uuid n'est jamais réutilisée par un rapprochement de nom", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" }), { kind: "nutanix-vm", id: "vm-sans-uuid", name: "HDVAPPLI-BIS" }],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI-BIS", uuid: VM_APPLI })],
      nutanixHostNames: [],
    });

    expect(result.inSync).toHaveLength(0);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]!.resource.id).toBe(VM_APPLI);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.reason).toContain("déjà appariée");
  });
});

describe("reconcileInventory — un champ absent d'un côté n'est jamais un écart", () => {
  it("numéro de série présent seulement côté GLPI : absence, pas différence", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_APPLI, serial: "SN-12345" })],
      nutanixHostNames: [],
    });

    expect(result.drifted).toHaveLength(0);
    expect(result.inSync).toHaveLength(1);
    const absences = new Map(result.inSync[0]!.absences.map((a) => [a.field, a.missingOn]));
    expect(absences.get("serial")).toBe("real");
  });

  it("vCPU/RAM absents côté GLPI (enrichissement indisponible) : absence, pas différence", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI", ipAddresses: ["172.20.1.10"] })],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_APPLI })],
      nutanixHostNames: [],
    });

    expect(result.drifted).toHaveLength(0);
    const absences = new Map(result.inSync[0]!.absences.map((a) => [a.field, a.missingOn]));
    expect(absences.get("vcpu")).toBe("glpi");
    expect(absences.get("memoryMib")).toBe("glpi");
    expect(absences.get("ipAddresses")).toBe("glpi");
  });

  it("OS absent des DEUX côtés : absence 'both', jamais un écart", () => {
    const result = reconcileInventory({
      resources: [realVm({ id: VM_APPLI, name: "HDVAPPLI" })],
      computers: [glpiComputer({ id: 7, name: "HDVAPPLI", uuid: VM_APPLI })],
      nutanixHostNames: [],
    });

    const absences = new Map(result.inSync[0]!.absences.map((a) => [a.field, a.missingOn]));
    expect(absences.get("operatingSystem")).toBe("both");
    expect(result.drifted).toHaveLength(0);
  });
});

// --- Routes ------------------------------------------------------------------------------------

function seedGlpiComputers(rows: unknown[]): void {
  queueResponse("GET initSession", { session_token: "session-de-test" });
  queueResponse("GET killSession", {});
  queueResponse("GET Computer", rows);
}

describe("Routes /api/glpi/inventory — autorisation", () => {
  it("401 sans session", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/glpi/inventory/diff" });
    expect(response.statusCode).toBe(401);
  });

  it("lecture accessible à un rôle viewer, écriture refusée (403)", async () => {
    app = buildServer();
    const read = await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: viewerCookie() });
    expect(read.statusCode).toBe(200);

    const create = await app.inject({ method: "POST", url: "/api/glpi/inventory/computers", cookies: viewerCookie(), payload: { resourceId: VM_APPLI } });
    expect(create.statusCode).toBe(403);

    const update = await app.inject({ method: "PATCH", url: "/api/glpi/inventory/computers/7", cookies: viewerCookie(), payload: { resourceId: VM_APPLI } });
    expect(update.statusCode).toBe(403);
  });
});

describe("GET /api/glpi/inventory/diff — non configuré / injoignable", () => {
  it("GLPI jamais configuré : aucune requête émise, aucune conclusion", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.glpi.configured).toBe(false);
    expect(body.conclusive).toBe(false);
    expect(body.missingInGlpi).toEqual([]);
    expect(body.staleInGlpi).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GLPI configuré mais injoignable (initSession refusé) : reachable=false, aucune conclusion", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([vm({ id: VM_APPLI, name: "HDVAPPLI" })]);
    queueResponse("GET initSession", { session_token: "" }, 401);

    app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() })).json();

    expect(body.glpi.configured).toBe(true);
    expect(body.glpi.reachable).toBe(false);
    expect(body.conclusive).toBe(false);
    expect(body.glpi.error).toContain("401");
    expect(body.staleInGlpi).toEqual([]);
  });

  it("Prism Central injoignable : AUCUNE fiche GLPI n'est déclarée obsolète", async () => {
    await seedGlpiConfig();
    lastKnownNutanixPollMock.mockReturnValue({ reachable: false, at: "2026-08-19T08:00:00.000Z" });
    seedGlpiComputers([{ id: 12, name: "HDVOBSOLETE", uuid: VM_DISPARUE, comment: `${QUAI_PROVENANCE_PREFIX}nutanix-vm:${VM_DISPARUE}` }]);

    app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() })).json();

    expect(body.conclusive).toBe(false);
    expect(body.nutanix.reachable).toBe(false);
    expect(body.staleInGlpi).toEqual([]);
    expect(body.missingInGlpi).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Nutanix jamais configuré : aucune conclusion non plus", async () => {
    await seedGlpiConfig();
    isNutanixConfiguredMock.mockResolvedValue(false);

    app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() })).json();

    expect(body.conclusive).toBe(false);
    expect(body.nutanix.configured).toBe(false);
  });
});

describe("GET /api/glpi/inventory/diff — réconciliation de bout en bout", () => {
  beforeEach(() => {
    getNutanixVmsMock.mockResolvedValue([
      vm({
        id: VM_APPLI,
        name: "HDVAPPLI",
        numVcpus: 4,
        memoryMib: 8192,
        hostName: "HDVNUTA1",
        networks: [{ subnetName: "VLAN10", ips: ["172.20.1.10"] }],
      }),
      vm({ id: VM_EXCH, name: "HDVEXCH", numVcpus: 8, memoryMib: 16384, hostName: "HDVNUTA2" }),
    ]);
    getNutanixHostsMock.mockResolvedValue([
      { id: HOST_1, name: "HDVNUTA1", numCpuCores: 32, memoryCapacityMib: 393216, hypervisorFullName: "Nutanix 20230302.101" },
      { id: "0005c1f0-2222-4a2b-8c3d-000000000002", name: "HDVNUTA2" },
    ]);
    getNutanixClustersMock.mockResolvedValue([{ uuid: "cluster-1", name: "HDV" }]);
  });

  it("classe missing / drifted / stale / in-sync avec les vraies valeurs des deux côtés", async () => {
    await seedGlpiConfig();
    queueResponse("GET initSession", { session_token: "session-de-test" });
    queueResponse("GET killSession", {});
    queueResponse("GET Computer", [
      { id: 7, name: "HDVAPPLI", uuid: VM_APPLI, serial: "", comment: "", is_deleted: 0, is_template: 0 },
      { id: 8, name: "HDVEXCH", uuid: VM_EXCH, serial: "", comment: "", is_deleted: 0, is_template: 0 },
      { id: 12, name: "HDVOBSOLETE", uuid: VM_DISPARUE, comment: `${QUAI_PROVENANCE_PREFIX}nutanix-vm:${VM_DISPARUE}`, is_deleted: 0 },
      { id: 30, name: "PC-ACCUEIL-01", uuid: "", comment: "", is_deleted: 0 },
      { id: 99, name: "HDVSUPPRIMEE", uuid: "", comment: "", is_deleted: 1 },
    ]);
    // GLPI est en retard sur HDVAPPLI (2 vCPU / 4096 Mio) et à jour sur HDVEXCH.
    queueResponse("GET ComputerVirtualMachine", [
      { id: 1, computers_id: 50, name: "HDVAPPLI", uuid: VM_APPLI, vcpu: 2, ram: 4096 },
      { id: 2, computers_id: 50, name: "HDVEXCH", uuid: VM_EXCH, vcpu: 8, ram: 16384 },
    ]);
    queueResponse("GET IPAddress", [{ id: 1, name: "172.20.1.10", mainitemtype: "Computer", mainitems_id: 7 }]);
    queueResponse("GET Item_OperatingSystem", []);

    app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() })).json();

    expect(body.conclusive).toBe(true);
    expect(body.glpi.reachable).toBe(true);
    expect(body.counts.real).toBe(4);
    // La fiche supprimée (is_deleted) est ignorée, jamais comptée.
    expect(body.counts.glpiComputers).toBe(4);

    expect(body.drifted).toHaveLength(1);
    const drift = new Map(body.drifted[0].differences.map((d: { field: string }) => [d.field, d]));
    expect(drift.get("vcpu")).toMatchObject({ glpiValue: 2, realValue: 4 });
    expect(drift.get("memoryMib")).toMatchObject({ glpiValue: 4096, realValue: 8192 });

    expect(body.inSync.map((p: { resource: { name: string } }) => p.resource.name)).toEqual(["HDVEXCH"]);
    expect(body.missingInGlpi.map((r: { name: string }) => r.name).sort()).toEqual(["HDVNUTA1", "HDVNUTA2"]);
    expect(body.staleInGlpi).toHaveLength(1);
    expect(body.staleInGlpi[0].glpi.id).toBe(12);
    expect(body.counts.outOfScopeGlpi).toBe(1);
    expect(body.enrichment).toEqual({ virtualMachines: "ok", ipAddresses: "ok", operatingSystems: "ok" });
  });

  it("un enrichissement refusé par GLPI rend le champ ABSENT partout, jamais un écart", async () => {
    await seedGlpiConfig();
    queueResponse("GET initSession", { session_token: "session-de-test" });
    queueResponse("GET killSession", {});
    queueResponse("GET Computer", [{ id: 7, name: "HDVAPPLI", uuid: VM_APPLI, is_deleted: 0 }]);
    queueResponse("GET ComputerVirtualMachine", { message: "forbidden" }, 403);
    queueResponse("GET IPAddress", []);
    queueResponse("GET Item_OperatingSystem", []);

    app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() })).json();

    expect(body.enrichment.virtualMachines).toBe("unavailable");
    expect(body.drifted).toHaveLength(0);
    expect(body.inSync).toHaveLength(1);
    const absences = new Map(body.inSync[0].absences.map((a: { field: string; missingOn: string }) => [a.field, a.missingOn]));
    expect(absences.get("vcpu")).toBe("glpi");
  });

  it("ouvre puis referme la session GLPI (App-Token + Session-Token sur chaque lecture)", async () => {
    await seedGlpiConfig();
    seedGlpiComputers([]);

    app = buildServer();
    await app.inject({ method: "GET", url: "/api/glpi/inventory/diff", cookies: adminCookie() });

    const init = recorded.find((r) => r.key === "GET initSession")!;
    expect(init.headers["App-Token"]).toBe("app-token-de-test");
    expect(init.headers["Authorization"]).toBe("user_token user-token-de-test");
    const list = recorded.find((r) => r.key === "GET Computer")!;
    expect(list.headers["Session-Token"]).toBe("session-de-test");
    expect(list.url).toContain("range=0-199");
    expect(recorded.some((r) => r.key === "GET killSession")).toBe(true);
  });
});

// --- Écriture ----------------------------------------------------------------------------------

describe("POST /api/glpi/inventory/computers — création de fiche", () => {
  it("envoie exactement les champs portés par l'objet Computer + le marqueur de provenance", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([
      vm({
        id: VM_APPLI,
        name: "HDVAPPLI",
        numVcpus: 4,
        memoryMib: 8192,
        cluster: "HDV",
        hostName: "HDVNUTA1",
        networks: [{ subnetName: "VLAN10", ips: ["172.20.1.10"] }],
      }),
    ]);
    seedGlpiComputers([]);
    queueResponse("POST Computer", { id: 42, message: "" }, 201);

    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/glpi/inventory/computers", cookies: adminCookie(), payload: { resourceId: VM_APPLI } });

    expect(response.statusCode).toBe(201);
    expect(response.json().computerId).toBe(42);

    const sent = recorded.find((r) => r.key === "POST Computer")!;
    const input = (sent.body as { input: Record<string, string> }).input;
    expect(Object.keys(input).sort()).toEqual(["comment", "name", "uuid"]);
    expect(input.name).toBe("HDVAPPLI");
    expect(input.uuid).toBe(VM_APPLI);
    expect(input.comment).toContain(`${QUAI_PROVENANCE_PREFIX}nutanix-vm:${VM_APPLI}`);
    expect(input.comment).toContain("4 vCPU");
    expect(input.comment).toContain("8192 MiB");
    expect(input.comment).toContain("172.20.1.10");
    expect(input.comment).toContain("HDVNUTA1");
  });

  it("refuse de créer un doublon quand la ressource est déjà rapprochée (409)", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([vm({ id: VM_APPLI, name: "HDVAPPLI" })]);
    seedGlpiComputers([{ id: 7, name: "HDVAPPLI", uuid: VM_APPLI, is_deleted: 0 }]);

    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/glpi/inventory/computers", cookies: adminCookie(), payload: { resourceId: VM_APPLI } });

    expect(response.statusCode).toBe(409);
    expect(recorded.some((r) => r.key === "POST Computer")).toBe(false);
  });

  it("404 pour une ressource inconnue de QUAI, sans jamais écrire dans GLPI", async () => {
    await seedGlpiConfig();
    seedGlpiComputers([]);

    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/glpi/inventory/computers", cookies: adminCookie(), payload: { resourceId: "vm-inexistante" } });

    expect(response.statusCode).toBe(404);
    expect(recorded.some((r) => r.key === "POST Computer")).toBe(false);
  });

  it("400 si GLPI n'est pas configuré — aucune requête émise", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/glpi/inventory/computers", cookies: adminCookie(), payload: { resourceId: VM_APPLI } });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/glpi/inventory/computers/:id — alignement sur le réel", () => {
  it("envoie exactement les champs dérivés corrigeables via PUT Computer/:id", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([vm({ id: VM_APPLI, name: "HDVAPPLI" })]);
    // GLPI porte un nom périmé mais le bon uuid : le rapprochement reste certain.
    seedGlpiComputers([{ id: 7, name: "ancien-nom", uuid: VM_APPLI, is_deleted: 0 }]);
    queueResponse("PUT Computer/7", [{ "7": true, message: "" }]);

    app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/glpi/inventory/computers/7",
      cookies: adminCookie(),
      payload: { resourceId: VM_APPLI },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().appliedFields).toEqual(["name"]);

    const sent = recorded.find((r) => r.key === "PUT Computer/7")!;
    expect(sent.body).toEqual({ input: { id: 7, name: "HDVAPPLI" } });
  });

  it("400 quand seuls des écarts non portés par l'objet Computer subsistent (vCPU/RAM)", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([vm({ id: VM_APPLI, name: "HDVAPPLI", numVcpus: 4, memoryMib: 8192 })]);
    queueResponse("GET initSession", { session_token: "session-de-test" });
    queueResponse("GET killSession", {});
    queueResponse("GET Computer", [{ id: 7, name: "HDVAPPLI", uuid: VM_APPLI, is_deleted: 0 }]);
    queueResponse("GET ComputerVirtualMachine", [{ id: 1, computers_id: 50, uuid: VM_APPLI, vcpu: 2, ram: 4096 }]);

    app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/glpi/inventory/computers/7",
      cookies: adminCookie(),
      payload: { resourceId: VM_APPLI },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Aucun écart corrigeable");
    expect(recorded.some((r) => r.key.startsWith("PUT "))).toBe(false);
  });

  it("409 si l'id de fiche ne correspond pas au rapprochement certain de la ressource", async () => {
    await seedGlpiConfig();
    getNutanixVmsMock.mockResolvedValue([vm({ id: VM_APPLI, name: "HDVAPPLI" })]);
    seedGlpiComputers([{ id: 7, name: "ancien-nom", uuid: VM_APPLI, is_deleted: 0 }]);

    app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/glpi/inventory/computers/999",
      cookies: adminCookie(),
      payload: { resourceId: VM_APPLI },
    });

    expect(response.statusCode).toBe(409);
    expect(recorded.some((r) => r.key.startsWith("PUT "))).toBe(false);
  });

  it("aucune route de suppression n'est exposée", async () => {
    app = buildServer();
    const response = await app.inject({ method: "DELETE", url: "/api/glpi/inventory/computers/7", cookies: adminCookie() });
    expect(response.statusCode).toBe(404);
  });
});
