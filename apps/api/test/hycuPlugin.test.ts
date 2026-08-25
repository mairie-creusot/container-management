import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { TopologyNode } from "../src/types.js";

/**
 * Greffon HYCU : manifeste, instantané et CONTRIBUTION AU GRAPHE. AUCUN test ici ne contacte
 * l'appliance réelle (elle protège la production de la mairie) : seules les branches qui refusent
 * AVANT toute requête réseau sont exercées, et l'instantané de topologie est entièrement mocké.
 * Le comportement réseau réel est couvert par hycu.test.ts, mocké de bout en bout.
 *
 * Les cas de graphe ci-dessous reprennent UN À UN ceux de topology.test.ts ("getTopology —
 * appliance HYCU et arêtes de sauvegarde") : la migration ne doit rien changer au graphe.
 */
const tmpDir = path.join(os.tmpdir(), `quai-hycu-plugin-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

type HycuService = typeof import("../src/services/hycu.js");

const getHycuTopologySnapshotMock = vi.fn<[], Promise<import("../src/services/hycu.js").HycuTopologySnapshot | null>>();
const lastKnownHycuPollMock = vi.fn<[], import("../src/services/hycu.js").HycuPollOutcome | null>();
const getHycuStatusMock = vi.fn<[], Promise<import("../src/types.js").HycuStatusSummary>>();

// Seules ces trois lectures sont pilotées par les tests : hycuVmProtectionState et
// testHycuConnection restent les VRAIES fonctions (la première est une règle pure, la seconde
// n'est jamais atteinte — aucun test ne lui fournit une configuration complète).
vi.mock("../src/services/hycu.js", async (importOriginal) => {
  const actual = await importOriginal<HycuService>();
  return {
    ...actual,
    getHycuTopologySnapshot: () => getHycuTopologySnapshotMock(),
    lastKnownHycuPoll: () => lastKnownHycuPollMock(),
    getHycuStatus: () => getHycuStatusMock(),
  };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { resetPluginRegistryForTests, registerPlugin, listPlugins } = await import("../src/plugins/registry.js");
const { BUILTIN_PLUGINS } = await import("../src/plugins/builtins.js");
const { hycuPlugin } = await import("../src/plugins/hycu/index.js");
const { buildHycuGraph, hycuTopologyParts, HYCU_GRAPH_NODE_KIND, HYCU_NODE_ID } = await import(
  "../src/plugins/hycu/graph.js"
);
const { HYCU_PLUGIN_ID, HYCU_SECRET_FIELDS, removeHycuPluginConfig, saveHycuPluginConfig } = await import(
  "../src/plugins/hycu/config.js"
);
const { validatePlugin, publicManifest } = await import("@quai/plugin-contract");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  getHycuTopologySnapshotMock.mockReset();
  getHycuTopologySnapshotMock.mockResolvedValue(null);
  lastKnownHycuPollMock.mockReset();
  lastKnownHycuPollMock.mockReturnValue(null);
  getHycuStatusMock.mockReset();
  getHycuStatusMock.mockResolvedValue({ configured: false });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
  await removeHycuPluginConfig();
});

function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

const manifest = hycuPlugin.manifest;

const VM_UUID = "aaaaaaaa-1111-4222-8333-444444444444";

function vmNode(uuid: string, label: string): TopologyNode {
  return { id: `nutanix-vm:${uuid}`, kind: "nutanix-vm", label, subtitle: "Cluster Mairie", status: "running" };
}

type Snapshot = import("../src/services/hycu.js").HycuTopologySnapshot;

function snapshot(
  overrides: {
    url?: string;
    reachable?: boolean;
    vms?: Snapshot["vms"];
    lastBackupFieldPresent?: boolean;
    counts?: NonNullable<Snapshot["counts"]>;
  } = {},
): Snapshot {
  return {
    url: overrides.url ?? "https://172.20.0.100:8443",
    reachable: overrides.reachable ?? true,
    vms: overrides.vms ?? [],
    lastBackupFieldPresent: overrides.lastBackupFieldPresent ?? false,
    ...(overrides.counts ? { counts: overrides.counts } : {}),
  };
}

describe("Greffon HYCU — manifeste", () => {
  it("est accepté par le contrat, tel qu'il est enregistré au démarrage", () => {
    const result = validatePlugin(hycuPlugin);
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    expect(manifest.id).toBe("hycu");
    expect(manifest.name).toBe("Sauvegarde HYCU");
    expect(() => registerPlugin(hycuPlugin)).not.toThrow();
  });

  it("est réellement branché dans les greffons du socle", () => {
    expect(BUILTIN_PLUGINS.map((plugin) => plugin.manifest.id)).toContain(HYCU_PLUGIN_ID);
    app = buildServer();
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toContain(HYCU_PLUGIN_ID);
  });

  it("décrit le formulaire réel des Réglages : URL, utilisateur, mot de passe, tous requis", () => {
    const properties = manifest.configSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual(["url", "username", "password"]);
    expect(manifest.configSchema.required).toEqual(["url", "username", "password"]);
    expect(properties.url).toMatchObject({ type: "string", examples: ["https://172.20.0.100:8443"] });
    expect(properties.username?.type).toBe("string");
    expect(properties.password?.type).toBe("string");
    // Aucune bascule de mode : le formulaire réel n'a qu'un seul jeu d'identifiants.
    for (const property of Object.values(properties)) expect(property.showIf).toBeUndefined();
  });

  it("déclare comme secret EXACTEMENT le champ chiffré au repos", () => {
    expect(manifest.secretFields).toEqual(["password"]);
    // La même liste pilote le chiffrement dans le stockage générique : elles ne peuvent pas diverger.
    expect(manifest.secretFields).toEqual(HYCU_SECRET_FIELDS);
  });

  it("aucun champ secret ne transporte de valeur, même par défaut", () => {
    const properties = publicManifest(manifest).configSchema.properties ?? {};
    for (const field of manifest.secretFields) {
      expect(properties[field]?.default, field).toBeUndefined();
      expect(properties[field]?.const, field).toBeUndefined();
      expect(properties[field]?.examples, field).toBeUndefined();
      expect(properties[field]?.type, field).toBe("string");
    }
  });

  it("est en LECTURE SEULE stricte, mais contribue au graphe", () => {
    expect(manifest.permissions.mutates).toBe(false);
    expect(hycuPlugin.actions).toBeUndefined();
    // Aucune action exposée, donc rien à tracer : un libellé d'audit ici serait inventé.
    expect(manifest.auditLabels).toEqual({});
    expect(manifest.permissions.graphNodeKinds).toEqual([HYCU_GRAPH_NODE_KIND]);
    expect(typeof hycuPlugin.graph).toBe("function");
  });
});

describe("Greffon HYCU — GET /api/plugins", () => {
  it("expose le manifeste public, sans la moindre valeur de configuration", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { plugins: Array<{ manifest: Record<string, unknown> }> };
    const exposed = body.plugins.find((plugin) => plugin.manifest.id === HYCU_PLUGIN_ID)?.manifest;
    expect(exposed).toBeDefined();
    expect(exposed?.secretFields).toEqual(["password"]);
    expect(exposed?.permissions).toMatchObject({ mutates: false, graphNodeKinds: ["hycu-appliance"] });

    const properties = (exposed?.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(properties)).toEqual(["url", "username", "password"]);
    expect(properties.password?.default).toBeUndefined();
    expect(properties.password?.examples).toBeUndefined();
  });
});

describe("Greffon HYCU — test() honnête, sans jamais contacter l'appliance à l'aveugle", () => {
  it("refuse une configuration incomplète avant toute requête", async () => {
    for (const candidate of [undefined, {}, { url: "https://172.20.0.100:8443" }, { url: "https://172.20.0.100:8443", username: "quai-ro" }]) {
      await expect(hycuPlugin.test(candidate)).resolves.toEqual({
        ok: false,
        message: "url, username et password sont requis",
      });
    }
  });

  it("ne renvoie jamais le secret qu'on lui a passé", async () => {
    const secret = "mot-de-passe-hycu-tres-secret";
    const result = await hycuPlugin.test({ url: "https://172.20.0.100:8443", password: secret });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(secret);
  });
});

describe("Greffon HYCU — snapshot()", () => {
  const COMPLETE = { url: "https://172.20.0.100:8443", username: "quai-ro", password: "hycu-secret" };

  it("configuration inutilisable : not-configured, jamais des listes vides silencieuses", async () => {
    for (const candidate of [undefined, {}, { url: "https://172.20.0.100:8443" }]) {
      const result = await hycuPlugin.snapshot(candidate);
      expect(result.moduleId).toBe("hycu");
      expect(result.status).toBe("not-configured");
      expect(result.message).toContain("non configurée");
      expect(result.summary).toEqual([]);
      expect(result.entities).toEqual([]);
      expect(result.relations).toEqual([]);
      expect(Date.parse(result.generatedAt)).not.toBeNaN();
    }
  });

  it("aucune configuration stockée : not-configured plutôt que des compteurs à zéro", async () => {
    getHycuStatusMock.mockResolvedValue({ configured: false });
    expect(await hycuPlugin.snapshot(COMPLETE)).toMatchObject({ status: "not-configured", summary: [] });
  });

  it("configurée mais injoignable : unreachable, aucun compteur inventé", async () => {
    getHycuStatusMock.mockResolvedValue({ configured: true, reachable: false });
    const result = await hycuPlugin.snapshot(COMPLETE);
    expect(result.status).toBe("unreachable");
    expect(result.summary).toEqual([]);
  });

  it("joignable : résumé calculé à partir des SEULS compteurs réels", async () => {
    getHycuStatusMock.mockResolvedValue({
      configured: true,
      reachable: true,
      vms: { total: 12, protectedCount: 9 },
      policies: { count: 3 },
      targets: { count: 2, totalSizeInBytes: 1200, usedSizeInBytes: 980 },
      jobs: { total: 5, byStatus: { OK: 4, ERROR: 1 } },
    });

    const result = await hycuPlugin.snapshot(COMPLETE);

    expect(result.status).toBe("ready");
    expect(result.summary).toEqual([
      { label: "VMs protégées", value: "9 / 12", tone: "warning" },
      { label: "Politiques", value: "3", tone: "neutral" },
      { label: "Cibles de sauvegarde", value: "2", tone: "neutral" },
      { label: "Occupation des cibles", value: "81.7 %", tone: "neutral" },
      { label: "Jobs OK", value: "4", tone: "ok" },
      { label: "Jobs ERROR", value: "1", tone: "critical" },
    ]);
    // Le détail par VM est contribué au graphe, jamais dupliqué en entités de module.
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });
});

/**
 * Parité STRICTE avec le graphe d'avant la migration : chaque cas reprend celui de topology.test.ts.
 */
describe("Greffon HYCU — contribution au graphe (mêmes nœuds et arêtes qu'avant la migration)", () => {
  it("configurée mais injoignable : nœud \"stopped\" SANS compteur ni arête", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({ reachable: false }),
      { reachable: false, at: "2026-08-18T06:00:00.000Z" },
      [],
    );

    expect(contribution.nodes).toHaveLength(1);
    expect(contribution.nodes[0]).toMatchObject({
      id: HYCU_NODE_ID,
      kind: "hycu-appliance",
      label: "HYCU",
      subtitle: "https://172.20.0.100:8443",
      status: "stopped",
    });
    expect(contribution.nodes[0]?.details).toEqual({ hycuLastPollAt: "2026-08-18T06:00:00.000Z" });
    expect(contribution.edges).toEqual([]);
    expect(vmAnnotations).toEqual([]);
  });

  it("joignable : compteurs réels portés par le nœud", () => {
    const { contribution } = buildHycuGraph(
      snapshot({ counts: { vms: 12, protectedVms: 9, policies: 3, targets: 2, recentJobs: 50, failedJobs: 4 } }),
      null,
      [],
    );

    expect(contribution.nodes[0]).toMatchObject({ status: "running" });
    expect(contribution.nodes[0]?.details).toEqual({
      hycuVmTotal: 12,
      hycuProtectedVmCount: 9,
      hycuPolicyCount: 3,
      hycuTargetCount: 2,
      hycuFailedJobCount: 4,
    });
  });

  it("rapprochement par uuid : arête \"protects\" de la VM VERS l'appliance + protection réelle", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({
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
      }),
      null,
      [vmNode(VM_UUID, "HDVAPPLI")],
    );

    expect(contribution.edges).toEqual([
      // Sens délibéré : la sauvegarde remonte de la VM vers l'appliance.
      { id: `protects:${VM_UUID}:nutanix-vm:${VM_UUID}`, source: `nutanix-vm:${VM_UUID}`, target: HYCU_NODE_ID, kind: "protects" },
    ]);
    expect(vmAnnotations).toEqual([
      {
        nodeId: `nutanix-vm:${VM_UUID}`,
        protection: "protected",
        policyName: "Gold",
        complianceStatus: "GREEN",
        lastBackupAt: new Date(Date.UTC(2026, 7, 18, 2, 0, 0)).toISOString(),
      },
    ]);
  });

  it("rapprochement par externalId (uuid hyperviseur) : la clé réelle prime sur l'id interne HYCU", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({
        vms: [{ uuid: "objet-hycu-1", externalId: VM_UUID, vmName: "AUTRE-NOM", protectionGroupUuid: "policy-1" }],
      }),
      null,
      [vmNode(VM_UUID, "HDVAPPLI")],
    );

    expect(contribution.edges).toHaveLength(1);
    expect(contribution.edges[0]).toMatchObject({ source: `nutanix-vm:${VM_UUID}`, target: HYCU_NODE_ID });
    expect(vmAnnotations[0]?.nodeId).toBe(`nutanix-vm:${VM_UUID}`);
  });

  it("rapprochement par NOM exact — et AUCUN rapprochement si le nom est ambigu", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({
        vms: [
          { uuid: "hycu-interne-1", vmName: "HDVAPPLI", protectionGroupUuid: "policy-1", policyName: "Gold" },
          { uuid: "hycu-interne-2", vmName: "DOUBLON", protectionGroupUuid: "policy-1" },
        ],
      }),
      null,
      [vmNode("uuid-a", "HDVAPPLI"), vmNode("uuid-b", "DOUBLON"), vmNode("uuid-c", "DOUBLON")],
    );

    expect(contribution.edges).toHaveLength(1);
    expect(contribution.edges[0]).toMatchObject({ source: "nutanix-vm:uuid-a", target: HYCU_NODE_ID });
    // Homonymes : ni arête, ni protection affichée — jamais un rapprochement au hasard.
    expect(vmAnnotations.map((a) => a.nodeId)).toEqual(["nutanix-vm:uuid-a"]);
  });

  it("VM connue de HYCU mais assignée à aucune policy : \"unprotected\", AUCUNE arête", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({ vms: [{ uuid: VM_UUID, vmName: "HDVAPPLI" }] }),
      null,
      [vmNode(VM_UUID, "HDVAPPLI")],
    );

    expect(contribution.edges).toEqual([]);
    expect(vmAnnotations).toEqual([{ nodeId: `nutanix-vm:${VM_UUID}`, protection: "unprotected" }]);
  });

  it("VM inconnue de HYCU : aucune annotation (une absence de donnée n'est pas une VM non sauvegardée)", () => {
    const { contribution, vmAnnotations } = buildHycuGraph(
      snapshot({ lastBackupFieldPresent: true, vms: [{ uuid: "autre-vm", vmName: "AUTRE", protectionGroupUuid: "policy-1" }] }),
      null,
      [vmNode(VM_UUID, "HDVAPPLI")],
    );

    expect(contribution.edges).toEqual([]);
    expect(vmAnnotations).toEqual([]);
  });

  it("sans contexte de graphe : le nœud SEUL, jamais une arête vers un identifiant supposé", () => {
    const { contribution } = buildHycuGraph(
      snapshot({ vms: [{ uuid: VM_UUID, vmName: "HDVAPPLI", protectionGroupUuid: "policy-1" }] }),
      null,
      [],
    );

    expect(contribution.nodes).toHaveLength(1);
    expect(contribution.edges).toEqual([]);
    expect(contribution.attachments).toEqual([]);
  });
});

describe("Greffon HYCU — projection sur le graphe de topologie", () => {
  it("aucun nœud tant que l'appliance n'a jamais été configurée", async () => {
    getHycuTopologySnapshotMock.mockResolvedValue(null);
    await expect(hycuTopologyParts([])).resolves.toEqual({ nodes: [], edges: [] });
  });

  it("compteurs typés sur le nœud, arête protects et annotations posées SUR les nœuds VM", async () => {
    getHycuTopologySnapshotMock.mockResolvedValue(
      snapshot({
        lastBackupFieldPresent: true,
        vms: [
          {
            uuid: VM_UUID,
            vmName: "HDVAPPLI",
            protectionGroupUuid: "policy-1",
            policyName: "Gold",
            complianceStatus: "GREEN",
            lastBackupInMillis: Date.UTC(2026, 7, 18, 2, 0, 0),
          },
        ],
        counts: { vms: 12, protectedVms: 9, policies: 3, targets: 2, recentJobs: 50, failedJobs: 4 },
      }),
    );
    lastKnownHycuPollMock.mockReturnValue({ reachable: true, at: "2026-08-18T06:00:00.000Z" });
    const nodes = [vmNode(VM_UUID, "HDVAPPLI")];

    const parts = await hycuTopologyParts(nodes);

    expect(parts.nodes).toEqual([
      {
        id: HYCU_NODE_ID,
        kind: "hycu-appliance",
        label: "HYCU",
        subtitle: "https://172.20.0.100:8443",
        status: "running",
        hycuVmTotal: 12,
        hycuProtectedVmCount: 9,
        hycuPolicyCount: 3,
        hycuTargetCount: 2,
        hycuFailedJobCount: 4,
        hycuLastPollAt: "2026-08-18T06:00:00.000Z",
      },
    ]);
    expect(parts.edges).toEqual([
      { id: `protects:${VM_UUID}:nutanix-vm:${VM_UUID}`, source: `nutanix-vm:${VM_UUID}`, target: HYCU_NODE_ID, kind: "protects" },
    ]);
    expect(nodes[0]).toMatchObject({
      hycuProtection: "protected",
      hycuPolicyName: "Gold",
      hycuComplianceStatus: "GREEN",
      hycuLastBackupAt: new Date(Date.UTC(2026, 7, 18, 2, 0, 0)).toISOString(),
    });
  });
});

describe("Greffon HYCU — graph() du contrat", () => {
  it("configuration inutilisable : aucune contribution, et l'appliance n'est pas interrogée", async () => {
    await expect(hycuPlugin.graph?.({})).resolves.toEqual({ nodes: [], edges: [], attachments: [] });
    expect(getHycuTopologySnapshotMock).not.toHaveBeenCalled();
  });

  it("configurée : le nœud de l'appliance, sans arête faute de contexte de graphe", async () => {
    await saveHycuPluginConfig({ url: "https://172.20.0.100:8443", username: "quai-ro", password: "hycu-secret" });
    getHycuTopologySnapshotMock.mockResolvedValue(
      snapshot({ vms: [{ uuid: VM_UUID, vmName: "HDVAPPLI", protectionGroupUuid: "policy-1" }] }),
    );

    const contribution = await hycuPlugin.graph?.({
      url: "https://172.20.0.100:8443",
      username: "quai-ro",
      password: "hycu-secret",
    });

    expect(contribution?.nodes.map((n) => n.kind)).toEqual(["hycu-appliance"]);
    expect(contribution?.edges).toEqual([]);
  });
});
