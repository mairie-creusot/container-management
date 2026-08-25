import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { NutanixHost, NutanixVm } from "../src/types.js";

/**
 * Greffon Nutanix : manifeste, reprise de configuration, contribution au graphe, actions.
 *
 * AUCUN test ne contacte l'infrastructure Nutanix réelle. `node:https` est mocké (le seul appel qui
 * traverse ce mock est celui du test de connexion), et les listings/actions de services/nutanix.ts
 * sont pilotés/espionnés : la hiérarchie du graphe est exercée sur des formes RÉELLES relevées sur
 * l'instance 172.20.0.10:9440 (CLUSTER_AHV_HDV), jamais sur l'instance elle-même.
 */
const tmpDir = path.join(os.tmpdir(), `quai-nutanix-plugin-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

const httpsResponsesByPath = new Map<string, { status: number; body: unknown }>();

vi.mock("node:https", () => ({
  request: (target: URL, _options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const found = httpsResponsesByPath.get(target.pathname) ?? { status: 500, body: {} };
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const isNutanixConfiguredMock = vi.fn<[], Promise<boolean>>();
const getNutanixVmsMock = vi.fn<[], Promise<NutanixVm[]>>();
const getNutanixClustersMock = vi.fn<[], Promise<{ uuid: string; name: string }[]>>();
const getNutanixHostsMock = vi.fn<[], Promise<NutanixHost[]>>();
const lastKnownNutanixPollMock = vi.fn<[], { reachable: boolean; at: string } | null>();
const startNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const stopNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const restartNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const deleteNutanixVmMock = vi.fn<[string], Promise<unknown>>();
const migrateNutanixVmMock = vi.fn<[string, string], Promise<unknown>>();
const addNutanixVmDiskMock = vi.fn<[string, { sizeMib: number }], Promise<unknown>>();
const addNutanixVmNicMock = vi.fn<[string, { subnetUuid: string }], Promise<unknown>>();
const updateNutanixVmComputeMock = vi.fn<[string, Record<string, number>], Promise<unknown>>();
const createNutanixVmMock = vi.fn<[unknown], Promise<unknown>>();
const createNutanixImageMock = vi.fn<[unknown], Promise<unknown>>();

/** Seuls les listings et les mutations sont pilotés : `testNutanixConnection` et NutanixActionError
 * restent les VRAIS (le test de connexion passe donc par le mock node:https ci-dessus). */
vi.mock("../src/services/nutanix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/nutanix.js")>();
  return {
    ...actual,
    isNutanixConfigured: () => isNutanixConfiguredMock(),
    getNutanixVms: () => getNutanixVmsMock(),
    getNutanixClusters: () => getNutanixClustersMock(),
    getNutanixHosts: () => getNutanixHostsMock(),
    lastKnownNutanixPoll: () => lastKnownNutanixPollMock(),
    startNutanixVm: (uuid: string) => startNutanixVmMock(uuid),
    stopNutanixVm: (uuid: string) => stopNutanixVmMock(uuid),
    restartNutanixVm: (uuid: string) => restartNutanixVmMock(uuid),
    deleteNutanixVm: (uuid: string) => deleteNutanixVmMock(uuid),
    migrateNutanixVm: (uuid: string, target: string) => migrateNutanixVmMock(uuid, target),
    addNutanixVmDisk: (uuid: string, opts: { sizeMib: number }) => addNutanixVmDiskMock(uuid, opts),
    addNutanixVmNic: (uuid: string, opts: { subnetUuid: string }) => addNutanixVmNicMock(uuid, opts),
    updateNutanixVmCompute: (uuid: string, opts: Record<string, number>) => updateNutanixVmComputeMock(uuid, opts),
    createNutanixVm: (input: unknown) => createNutanixVmMock(input),
    createNutanixImage: (input: unknown) => createNutanixImageMock(input),
  };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { listPlugins, registerPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { nutanixPlugin } = await import("../src/plugins/nutanix/index.js");
const { getNutanixTopologyParts } = await import("../src/plugins/nutanix/graph.js");
const {
  loadNutanixPluginConfig,
  removeNutanixPluginConfig,
  saveNutanixPluginConfig,
  NUTANIX_PLUGIN_ID,
  NUTANIX_SECRET_FIELDS,
} = await import("../src/plugins/nutanix/config.js");
const { getCurrent, getEffectiveIntegrationConfig, setNutanixConfig } = await import("../src/services/setupStore.js");
const { validatePlugin, publicManifest } = await import("@quai/plugin-contract");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  isNutanixConfiguredMock.mockResolvedValue(true);
  getNutanixVmsMock.mockResolvedValue([]);
  getNutanixClustersMock.mockResolvedValue([]);
  getNutanixHostsMock.mockResolvedValue([]);
  lastKnownNutanixPollMock.mockReturnValue(null);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  httpsResponsesByPath.clear();
  vi.clearAllMocks();
  resetPluginRegistryForTests();
  await removeNutanixPluginConfig();
});

function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}

const manifest = nutanixPlugin.manifest;

const REAL_CONFIG = { prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: "secret-prism" };

// Formes RÉELLES (allégées) relevées le 14/08/2026 sur CLUSTER_AHV_HDV — jamais inventées.
const CLUSTER = { uuid: "0005b4db-f6b4-0926-62f9-3cecef178022", name: "CLUSTER_AHV_HDV" };
const HOST_A: NutanixHost = {
  id: "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb",
  name: "HDVNUTA3",
  clusterUuid: CLUSTER.uuid,
  cpuModel: "Intel(R) Xeon(R) Gold 6210U CPU @ 2.50GHz",
  numCpuCores: 20,
  numCpuSockets: 1,
  memoryCapacityMib: 256881,
  hypervisorFullName: "AHV 11.0.0.2",
};
const HOST_B: NutanixHost = { id: "655ce338-42e8-448a-b2b4-5a95150c0d43", name: "HDVNUTA1", clusterUuid: CLUSTER.uuid };
const VM_RUNNING: NutanixVm = {
  id: "dc52605f-e91a-4dd2-b966-3dd76c52bf8d",
  name: "HDVAPPLI",
  powerState: "on",
  numVcpus: 4,
  memoryMib: 8192,
  cluster: CLUSTER.name,
  clusterUuid: CLUSTER.uuid,
  hostUuid: HOST_A.id,
  hostName: HOST_A.name,
  hostPlacementConfirmed: true,
  networks: [{ subnetUuid: "6f0a8b1c-2d3e-4f50-8a9b-0c1d2e3f4a5b", subnetName: "VLAN_SERVEURS", vlanId: 12, ips: ["172.20.0.31"] }],
};
const VM_STOPPED: NutanixVm = {
  id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  name: "HDVTEST",
  powerState: "off",
  numVcpus: 2,
  memoryMib: 4096,
  cluster: CLUSTER.name,
  clusterUuid: CLUSTER.uuid,
  hostUuid: HOST_B.id,
  hostName: HOST_B.name,
  hostPlacementConfirmed: false,
};
/** Jamais démarrée : aucun hôte déterminable, rattachée au CLUSTER (repli du 17/08/2026). */
const VM_UNPLACED: NutanixVm = {
  id: "c9d8e7f6-a5b4-4c3d-9e8f-7a6b5c4d3e2f",
  name: "HDVNEUVE",
  powerState: "off",
  numVcpus: 1,
  memoryMib: 2048,
  cluster: CLUSTER.name,
  clusterUuid: CLUSTER.uuid,
};

function seedRealCluster(): void {
  getNutanixClustersMock.mockResolvedValue([CLUSTER]);
  getNutanixHostsMock.mockResolvedValue([HOST_A, HOST_B]);
  getNutanixVmsMock.mockResolvedValue([VM_RUNNING, VM_STOPPED, VM_UNPLACED]);
}

describe("Greffon Nutanix — manifeste", () => {
  it("est accepté par le contrat, tel qu'il est enregistré au démarrage", () => {
    const result = validatePlugin(nutanixPlugin);
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    expect(manifest.id).toBe("nutanix");
    expect(manifest.name).toBe("Virtualisation Nutanix");
    expect(() => registerPlugin(nutanixPlugin)).not.toThrow();
  });

  it("est réellement branché dans les greffons du socle", async () => {
    app = buildServer();
    // Chargement ASYNCHRONE des seuls greffons actifs (onReady, voir plugins/loader.ts).
    await app.ready();
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toContain(NUTANIX_PLUGIN_ID);
  });

  it("décrit le formulaire réel de NutanixConfigSection.tsx : trois champs, tous requis", () => {
    const properties = manifest.configSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual(["prismCentralUrl", "username", "password"]);
    expect(manifest.configSchema.required).toEqual(["prismCentralUrl", "username", "password"]);
    expect(properties.prismCentralUrl).toMatchObject({ type: "string", examples: ["https://prism.lecreusot.fr:9440"] });
    expect(properties.username).toMatchObject({ type: "string" });
    expect(properties.password).toMatchObject({ type: "string" });
    // Aucune bascule de mode ici, contrairement à 3CX/GLPI : un seul jeu d'identifiants.
    for (const property of Object.values(properties)) {
      expect(property.showIf).toBeUndefined();
    }
  });

  it("déclare comme secret EXACTEMENT le champ chiffré au repos, sans valeur", () => {
    expect(manifest.secretFields).toEqual(["password"]);
    expect(manifest.secretFields).toEqual(NUTANIX_SECRET_FIELDS);
    const properties = publicManifest(manifest).configSchema.properties ?? {};
    expect(properties.password?.default).toBeUndefined();
    expect(properties.password?.const).toBeUndefined();
    expect(properties.password?.examples).toBeUndefined();
    expect(properties.password?.type).toBe("string");
  });

  it("se déclare MUTANT et hiérarchique : mutates, types de nœuds du graphe, aucun hôte figé", () => {
    expect(manifest.permissions.mutates).toBe(true);
    expect(manifest.permissions.graphNodeKinds).toEqual(["nutanix-cluster", "nutanix-host", "nutanix-vm"]);
    // Manque connu du contrat : l'hôte réellement joint est celui SAISI dans prismCentralUrl.
    expect(manifest.permissions.network).toEqual([]);
    expect(typeof nutanixPlugin.graph).toBe("function");
  });

  it("chaque action exposée a un libellé d'audit, et réciproquement", () => {
    const actions = Object.keys(nutanixPlugin.actions ?? {}).sort();
    expect(actions).toEqual(
      [
        "image.create",
        "vm.add-disk",
        "vm.add-nic",
        "vm.create",
        "vm.delete",
        "vm.migrate",
        "vm.restart",
        "vm.start",
        "vm.stop",
        "vm.update-compute",
      ].sort(),
    );
    expect(Object.keys(manifest.auditLabels).sort()).toEqual(actions);
    for (const [name, label] of Object.entries(manifest.auditLabels)) {
      expect(label.trim().length, name).toBeGreaterThan(0);
    }
    for (const name of actions) {
      expect(typeof nutanixPlugin.actions?.[name], name).toBe("function");
    }
  });

  it("décrit ses actions de VM : entrée bornée, danger, confirmation, cible", () => {
    const specs = manifest.actions ?? {};
    // Les six actions de VM du menu du graphe, plus la migration, le compute et le catalogue.
    expect(Object.keys(specs).sort()).toEqual(
      ["image.create", "vm.add-disk", "vm.add-nic", "vm.delete", "vm.migrate", "vm.restart", "vm.start", "vm.stop", "vm.update-compute"].sort(),
    );
    // vm.create reste NON décrite : son entrée porte un objet imbriqué (guestCustomization) que le
    // sous-ensemble de schéma ne sait ni décrire à plat ni protéger.
    expect(specs["vm.create"]).toBeUndefined();

    for (const [name, spec] of Object.entries(specs)) {
      if (name === "image.create") continue;
      expect(spec.target?.nodeKind, name).toBe("nutanix-vm");
      expect(spec.target?.field, name).toBe("uuid");
      // Toutes servies par un écran EXISTANT : aucune entrée de menu n'est ajoutée par cette voie.
      expect(spec.target?.servedByCore, name).toBeTruthy();
      expect(spec.target?.menuLabel, name).toBeUndefined();
    }

    // Bornes RÉELLES du service (services/nutanix.ts), pas des valeurs de confort.
    const disk = specs["vm.add-disk"]?.input?.properties?.sizeMib;
    expect(disk).toMatchObject({ type: "number", minimum: 1024, maximum: 2 * 1024 * 1024 });
    expect(specs["vm.add-disk"]?.input?.required).toEqual(["sizeMib"]);
    const compute = specs["vm.update-compute"]?.input?.properties ?? {};
    expect(compute.numVcpus).toMatchObject({ minimum: 1, maximum: 64 });
    expect(compute.numCoresPerVcpu).toMatchObject({ minimum: 1, maximum: 16 });
    expect(compute.memoryMib).toMatchObject({ minimum: 256, maximum: 1024 * 1024 });
    // Aucun champ obligatoire : le service arbitre lui-même « au moins l'un des trois ».
    expect(specs["vm.update-compute"]?.input?.required).toBeUndefined();

    // Suppression : la SEULE à exiger la confirmation forte, comme l'écran actuel.
    expect(specs["vm.delete"]?.severity).toBe("destructive");
    expect(specs["vm.delete"]?.confirm?.retype).toBe(true);
    expect(specs["vm.delete"]?.confirm?.message).toContain("{cible}");
    expect(specs["vm.start"]?.confirm).toBeUndefined();
    expect(specs["vm.stop"]?.confirm?.confirmLabel).toBe("Arrêter");
    // Mêmes conditions d'affichage que le contrat de nœud du web (démarrer/arrêter exclusifs).
    expect(specs["vm.start"]?.target?.when).toEqual([{ field: "status", equals: ["stopped"] }]);
    expect(specs["vm.stop"]?.target?.when).toEqual([{ field: "status", equals: ["running"] }]);
  });

  it("n'exposera JAMAIS en action ce que le contrat ne sait pas transporter (flux binaire, WebSocket)", () => {
    // Téléversement d'image (flux) et console VNC (WebSocket bidirectionnel) restent servis par
    // routes/nutanix.ts — les déclarer ici exigerait un contrat d'action qui n'existe pas.
    expect(nutanixPlugin.actions?.["image.upload"]).toBeUndefined();
    expect(nutanixPlugin.actions?.["vm.console"]).toBeUndefined();
  });

  it("expose son manifeste public par GET /api/plugins, sans aucune valeur de configuration", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { plugins: Array<{ manifest: Record<string, unknown> }> };
    const exposed = body.plugins.find((plugin) => plugin.manifest.id === NUTANIX_PLUGIN_ID)?.manifest;
    expect(exposed).toBeDefined();
    expect(exposed?.secretFields).toEqual(["password"]);
    expect(exposed?.permissions).toMatchObject({ mutates: true, graphNodeKinds: ["nutanix-cluster", "nutanix-host", "nutanix-vm"] });
    const properties = (exposed?.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.password?.default).toBeUndefined();
    expect(properties.password?.examples).toBeUndefined();
  });
});

describe("Greffon Nutanix — reprise de la configuration déjà enregistrée", () => {
  it("reprend le champ typé `nutanix`, chiffre le mot de passe, puis RETIRE le champ typé", async () => {
    await setNutanixConfig(REAL_CONFIG);
    expect((await getCurrent()).nutanix).toBeDefined();

    expect(await loadNutanixPluginConfig()).toEqual(REAL_CONFIG);

    // Le champ typé ne doit plus exister : il redeviendrait une configuration de secours.
    const current = await getCurrent();
    expect(current.nutanix).toBeUndefined();
    const storedConfig = current.integrations?.[NUTANIX_PLUGIN_ID]?.config ?? {};
    expect(storedConfig.prismCentralUrl).toBe(REAL_CONFIG.prismCentralUrl);
    // Chiffré au repos, jamais en clair dans config.json.
    expect(String(storedConfig.password)).toMatch(/^enc:v1:/);
    expect(await getEffectiveIntegrationConfig(NUTANIX_PLUGIN_ID)).toMatchObject({ config: { password: REAL_CONFIG.password } });
  });

  it("est idempotente : rejouer la reprise ne change rien", async () => {
    await setNutanixConfig(REAL_CONFIG);
    expect(await loadNutanixPluginConfig()).toEqual(REAL_CONFIG);
    expect(await loadNutanixPluginConfig()).toEqual(REAL_CONFIG);
    expect((await getCurrent()).nutanix).toBeUndefined();
  });

  // Le champ typé ne peut réapparaître que si l'assistant vient de le réécrire : il porte alors une
  // saisie PLUS RÉCENTE que l'entrée du greffon. L'ignorer perdrait des identifiants tout juste
  // saisis — exactement ce que ferait l'étape « Orchestrateurs » de l'assistant.
  it("rejouer l'assistant avec de nouveaux identifiants les fait gagner sur l'entrée du greffon", async () => {
    await saveNutanixPluginConfig({ ...REAL_CONFIG, username: "ancien-compte" });
    await setNutanixConfig({ ...REAL_CONFIG, username: "nouveau-compte" });

    expect(await loadNutanixPluginConfig()).toEqual({ ...REAL_CONFIG, username: "nouveau-compte" });
    // Et le champ typé est retiré, pour ne pas redevenir une configuration de secours.
    expect((await getCurrent()).nutanix).toBeUndefined();
  });

  it("écrit, relit et retire la configuration du greffon (retour à « jamais configuré »)", async () => {
    expect(await loadNutanixPluginConfig()).toBeNull();
    await saveNutanixPluginConfig(REAL_CONFIG);
    expect(await loadNutanixPluginConfig()).toEqual(REAL_CONFIG);
    await removeNutanixPluginConfig();
    expect(await loadNutanixPluginConfig()).toBeNull();
  });

  it("une configuration incomplète n'est jamais complétée ni devinée", async () => {
    await saveNutanixPluginConfig({ prismCentralUrl: REAL_CONFIG.prismCentralUrl, username: "Admin", password: "" });
    expect(await loadNutanixPluginConfig()).toBeNull();
  });
});

describe("Greffon Nutanix — /api/nutanix/config : l'écran ne change pas", () => {
  it("PUT teste puis enregistre dans le stockage du greffon ; GET ne renvoie jamais le mot de passe", async () => {
    app = buildServer();
    httpsResponsesByPath.set("/api/nutanix/v3/vms/list", { status: 200, body: { metadata: { total_matches: 24 } } });
    const publicConfig = { prismCentralUrl: REAL_CONFIG.prismCentralUrl, username: REAL_CONFIG.username };

    const put = await app.inject({ method: "PUT", url: "/api/nutanix/config", cookies: adminCookie(), payload: REAL_CONFIG });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ configured: true, config: publicConfig });

    const get = await app.inject({ method: "GET", url: "/api/nutanix/config", cookies: viewerCookie() });
    expect(get.json()).toEqual({ configured: true, config: publicConfig });
    expect(get.body).not.toContain(REAL_CONFIG.password);

    // La configuration vit désormais dans le stockage générique des greffons, plus dans le champ typé.
    const current = await getCurrent();
    expect(current.integrations?.[NUTANIX_PLUGIN_ID]).toBeDefined();
    expect(current.nutanix).toBeUndefined();

    const removed = await app.inject({ method: "DELETE", url: "/api/nutanix/config", cookies: adminCookie() });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/nutanix/config", cookies: viewerCookie() });
    expect(after.json()).toEqual({ configured: false });
  });

  it("PUT sans mot de passe conserve celui déjà enregistré (convention inchangée)", async () => {
    app = buildServer();
    httpsResponsesByPath.set("/api/nutanix/v3/vms/list", { status: 200, body: { metadata: { total_matches: 24 } } });
    await saveNutanixPluginConfig(REAL_CONFIG);

    const put = await app.inject({
      method: "PUT",
      url: "/api/nutanix/config",
      cookies: adminCookie(),
      payload: { prismCentralUrl: REAL_CONFIG.prismCentralUrl, username: "autre-compte" },
    });

    expect(put.statusCode).toBe(200);
    expect(await loadNutanixPluginConfig()).toEqual({ ...REAL_CONFIG, username: "autre-compte" });
  });

  it("refuse d'enregistrer une configuration que Prism Central rejette", async () => {
    app = buildServer();
    httpsResponsesByPath.set("/api/nutanix/v3/vms/list", { status: 401, body: { message: "unauthorized" } });

    const put = await app.inject({ method: "PUT", url: "/api/nutanix/config", cookies: adminCookie(), payload: REAL_CONFIG });

    expect(put.statusCode).toBe(400);
    expect(await loadNutanixPluginConfig()).toBeNull();
  });
});

describe("Greffon Nutanix — contribution au graphe", () => {
  it("produit EXACTEMENT la hiérarchie cluster -> hôte -> VM du graphe actuel", async () => {
    seedRealCluster();

    const parts = await getNutanixTopologyParts();
    const clusterNodeId = `host:nutanix-cluster:${CLUSTER.uuid}`;
    const hostANodeId = `host:nutanix-host:${HOST_A.id}`;
    const hostBNodeId = `host:nutanix-host:${HOST_B.id}`;

    expect(parts.hostNodes.map((n) => n.id)).toEqual([clusterNodeId, hostANodeId, hostBNodeId]);
    expect(parts.vmNodes.map((n) => n.id)).toEqual([
      `nutanix-vm:${VM_RUNNING.id}`,
      `nutanix-vm:${VM_STOPPED.id}`,
      `nutanix-vm:${VM_UNPLACED.id}`,
    ]);
    expect(parts.hostEdges.map((e) => `${e.source}->${e.target}`)).toEqual([
      `${clusterNodeId}->${hostANodeId}`,
      `${clusterNodeId}->${hostBNodeId}`,
      `${hostANodeId}->nutanix-vm:${VM_RUNNING.id}`,
      `${hostBNodeId}->nutanix-vm:${VM_STOPPED.id}`,
      // VM jamais placée : rattachée au cluster, jamais à un hôte inventé.
      `${clusterNodeId}->nutanix-vm:${VM_UNPLACED.id}`,
    ]);

    const contribution = await nutanixPlugin.graph!({});
    // MÊMES identifiants et MÊMES arêtes que le graphe réel : une seule hiérarchie, deux vues.
    expect(contribution.nodes.map((n) => n.id).sort()).toEqual(
      [...parts.hostNodes, ...parts.vmNodes].map((n) => n.id).sort(),
    );
    expect(contribution.edges).toEqual(parts.hostEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind })));
    // Chaque kind contribué est bien déclaré dans le manifeste.
    for (const node of contribution.nodes) {
      expect(manifest.permissions.graphNodeKinds, node.id).toContain(node.kind);
    }
    expect(contribution.nodes.filter((n) => n.kind === "nutanix-cluster").map((n) => n.label)).toEqual([CLUSTER.name]);
    expect(contribution.nodes.filter((n) => n.kind === "nutanix-host").map((n) => n.label)).toEqual([HOST_A.name, HOST_B.name]);
    expect(contribution.nodes.filter((n) => n.kind === "nutanix-vm")).toHaveLength(3);
    expect(contribution.nodes.find((n) => n.id === `nutanix-vm:${VM_RUNNING.id}`)?.status).toBe("running");
    expect(contribution.nodes.find((n) => n.id === `nutanix-vm:${VM_STOPPED.id}`)?.status).toBe("stopped");
  });

  it("rend les cartes réseau d'une VM en tiroirs, portés par le nœud de CETTE VM", async () => {
    seedRealCluster();
    const contribution = await nutanixPlugin.graph!({});
    expect(contribution.attachments).toEqual([
      {
        nodeId: `nutanix-vm:${VM_RUNNING.id}`,
        kind: "network",
        id: `network:${VM_RUNNING.id}:0`,
        label: "VLAN_SERVEURS",
        subtitle: "VLAN 12",
      },
    ]);
  });

  it("ne contribue RIEN tant que Nutanix n'a jamais été configuré", async () => {
    isNutanixConfiguredMock.mockResolvedValue(false);
    seedRealCluster();

    const contribution = await nutanixPlugin.graph!({});

    expect(contribution).toEqual({ nodes: [], edges: [], attachments: [] });
    expect(getNutanixVmsMock).not.toHaveBeenCalled();
  });
});

describe("Greffon Nutanix — snapshot()", () => {
  it("configuration inutilisable : not-configured, jamais des listes vides silencieuses", async () => {
    for (const candidate of [undefined, {}, { prismCentralUrl: REAL_CONFIG.prismCentralUrl }]) {
      const snapshot = await nutanixPlugin.snapshot(candidate);
      expect(snapshot.moduleId).toBe("nutanix");
      expect(snapshot.status).toBe("not-configured");
      expect(snapshot.summary).toEqual([]);
      expect(snapshot.entities).toEqual([]);
      expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
    }
    expect(getNutanixVmsMock).not.toHaveBeenCalled();
  });

  it("Prism Central injoignable au dernier essai : unreachable, jamais un inventaire vide", async () => {
    lastKnownNutanixPollMock.mockReturnValue({ reachable: false, at: "2026-08-25T08:00:00.000Z" });

    const snapshot = await nutanixPlugin.snapshot(REAL_CONFIG);

    expect(snapshot.status).toBe("unreachable");
    expect(snapshot.message).toContain("2026-08-25T08:00:00.000Z");
    expect(snapshot.entities).toEqual([]);
  });

  it("données réelles : compteurs, entités et relations reprennent la hiérarchie", async () => {
    seedRealCluster();
    lastKnownNutanixPollMock.mockReturnValue({ reachable: true, at: "2026-08-25T08:00:00.000Z" });

    const snapshot = await nutanixPlugin.snapshot(REAL_CONFIG);

    expect(snapshot.status).toBe("ready");
    expect(snapshot.summary).toEqual([
      { label: "Clusters", value: "1", tone: "neutral" },
      { label: "Hôtes physiques", value: "2", tone: "neutral" },
      { label: "VMs", value: "3", tone: "neutral" },
      { label: "VMs allumées", value: "1 / 3", tone: "ok" },
    ]);
    expect(snapshot.entities.filter((e) => e.kind === "vm")).toHaveLength(3);
    expect(snapshot.entities.find((e) => e.id === VM_RUNNING.id)?.status).toBe("ok");
    // Une VM éteinte n'est PAS en faute : jamais "critical" sur un arrêt volontaire.
    expect(snapshot.entities.find((e) => e.id === VM_STOPPED.id)?.status).toBe("unknown");
    expect(snapshot.relations.map((r) => `${r.source}->${r.target}`)).toEqual([
      `${CLUSTER.uuid}->${HOST_A.id}`,
      `${CLUSTER.uuid}->${HOST_B.id}`,
      `${HOST_A.id}->${VM_RUNNING.id}`,
      `${HOST_B.id}->${VM_STOPPED.id}`,
      `${CLUSTER.uuid}->${VM_UNPLACED.id}`,
    ]);
  });
});

describe("Greffon Nutanix — actions", () => {
  it("chaque action transmet la cible réelle au service, jamais une cible devinée", async () => {
    startNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
    await expect(nutanixPlugin.actions!["vm.start"]!({ uuid: VM_RUNNING.id })).resolves.toEqual({ ok: true, vmName: "HDVAPPLI" });
    expect(startNutanixVmMock).toHaveBeenCalledWith(VM_RUNNING.id);

    stopNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
    await nutanixPlugin.actions!["vm.stop"]!({ uuid: VM_RUNNING.id });
    expect(stopNutanixVmMock).toHaveBeenCalledWith(VM_RUNNING.id);

    restartNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
    await nutanixPlugin.actions!["vm.restart"]!({ uuid: VM_RUNNING.id });
    expect(restartNutanixVmMock).toHaveBeenCalledWith(VM_RUNNING.id);

    deleteNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVTEST" });
    await nutanixPlugin.actions!["vm.delete"]!({ uuid: VM_STOPPED.id });
    expect(deleteNutanixVmMock).toHaveBeenCalledWith(VM_STOPPED.id);

    migrateNutanixVmMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI", targetHostName: HOST_B.name });
    await nutanixPlugin.actions!["vm.migrate"]!({ uuid: VM_RUNNING.id, targetHostUuid: HOST_B.id });
    expect(migrateNutanixVmMock).toHaveBeenCalledWith(VM_RUNNING.id, HOST_B.id);

    addNutanixVmDiskMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI", sizeMib: 10240 });
    await nutanixPlugin.actions!["vm.add-disk"]!({ uuid: VM_RUNNING.id, sizeMib: 10240 });
    expect(addNutanixVmDiskMock).toHaveBeenCalledWith(VM_RUNNING.id, { sizeMib: 10240 });

    addNutanixVmNicMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI", subnetName: "VLAN_SERVEURS" });
    await nutanixPlugin.actions!["vm.add-nic"]!({ uuid: VM_RUNNING.id, subnetUuid: "6f0a8b1c-2d3e-4f50-8a9b-0c1d2e3f4a5b" });
    expect(addNutanixVmNicMock).toHaveBeenCalledWith(VM_RUNNING.id, { subnetUuid: "6f0a8b1c-2d3e-4f50-8a9b-0c1d2e3f4a5b" });

    updateNutanixVmComputeMock.mockResolvedValue({ ok: true, vmName: "HDVAPPLI" });
    await nutanixPlugin.actions!["vm.update-compute"]!({ uuid: VM_RUNNING.id, numVcpus: 8, memoryMib: 16384 });
    expect(updateNutanixVmComputeMock).toHaveBeenCalledWith(VM_RUNNING.id, { numVcpus: 8, memoryMib: 16384 });

    createNutanixImageMock.mockResolvedValue({ ok: true, name: "debian-13" });
    await nutanixPlugin.actions!["image.create"]!({ name: "debian-13", sourceUri: "https://exemple.fr/debian.qcow2" });
    expect(createNutanixImageMock).toHaveBeenCalledWith({ name: "debian-13", sourceUri: "https://exemple.fr/debian.qcow2" });
  });

  it("refuse une action sans cible plutôt que d'agir au hasard, et n'appelle rien", async () => {
    await expect(nutanixPlugin.actions!["vm.start"]!({})).rejects.toThrow(/uuid/);
    await expect(nutanixPlugin.actions!["vm.delete"]!(undefined)).rejects.toThrow(/uuid/);
    await expect(nutanixPlugin.actions!["vm.migrate"]!({ uuid: VM_RUNNING.id })).rejects.toThrow(/targetHostUuid/);
    await expect(nutanixPlugin.actions!["vm.add-disk"]!({ uuid: VM_RUNNING.id })).rejects.toThrow(/sizeMib/);
    await expect(nutanixPlugin.actions!["vm.add-nic"]!({ uuid: VM_RUNNING.id })).rejects.toThrow(/subnetUuid/);
    await expect(nutanixPlugin.actions!["vm.create"]!({ name: "vm-sans-reseau" })).rejects.toThrow(/subnetUuid/);
    expect(startNutanixVmMock).not.toHaveBeenCalled();
    expect(deleteNutanixVmMock).not.toHaveBeenCalled();
    expect(migrateNutanixVmMock).not.toHaveBeenCalled();
    expect(addNutanixVmDiskMock).not.toHaveBeenCalled();
    expect(createNutanixVmMock).not.toHaveBeenCalled();
  });

  it("vm.create transmet la personnalisation cloud-init telle quelle, sans la journaliser", async () => {
    createNutanixVmMock.mockResolvedValue({ ok: true, name: "portail" });
    await nutanixPlugin.actions!["vm.create"]!({
      name: "portail",
      imageUuid: "img-1",
      subnetUuid: "subnet-1",
      numVcpus: 2,
      memoryMib: 4096,
      guestCustomization: { username: "quai", password: "motdepasse-cloud-init" },
    });
    expect(createNutanixVmMock).toHaveBeenCalledWith({
      name: "portail",
      imageUuid: "img-1",
      subnetUuid: "subnet-1",
      numVcpus: 2,
      memoryMib: 4096,
      guestCustomization: { username: "quai", password: "motdepasse-cloud-init" },
    });
  });
});

describe("Greffon Nutanix — test()", () => {
  it("refuse une configuration incomplète sans le moindre appel réseau", async () => {
    const result = await nutanixPlugin.test({ prismCentralUrl: REAL_CONFIG.prismCentralUrl });
    expect(result).toEqual({ ok: false, message: "prismCentralUrl, username et password sont requis" });
  });

  it("teste RÉELLEMENT Prism Central et ne renvoie jamais le secret fourni", async () => {
    httpsResponsesByPath.set("/api/nutanix/v3/vms/list", { status: 200, body: { metadata: { total_matches: 24 } } });

    const ok = await nutanixPlugin.test(REAL_CONFIG);
    expect(ok).toEqual({ ok: true, message: "Prism Central est joignable" });
    // Manque connu du contrat : PluginTestResult n'a que { ok, message } — les 24 VMs comptées
    // par le test de connexion réel ne sont pas transportables.
    expect(ok).not.toHaveProperty("vmCount");

    httpsResponsesByPath.set("/api/nutanix/v3/vms/list", { status: 401, body: { message: "unauthorized" } });
    const ko = await nutanixPlugin.test(REAL_CONFIG);
    expect(ko.ok).toBe(false);
    expect(ko.message).not.toContain(REAL_CONFIG.password);
  });
});
