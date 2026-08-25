import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin, PluginGraphContribution, PluginGraphLinks } from "@quai/plugin-contract";

/**
 * Chargement À LA DEMANDE des greffons (plugins/loader.ts) et AGRÉGATION de leurs contributions au
 * graphe (services/topology.ts#collectPluginGraphParts).
 *
 * Aucun test ne contacte quoi que ce soit : les greffons exercés ici sont FACTICES, et les quatre
 * greffons livrés ne sont jamais configurés dans ce CONFIG_PATH isolé — ils ne contribuent donc
 * rien et n'émettent aucune requête.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-loader-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "3".repeat(64);

const { buildServer } = await import("../src/index.js");
const { loadActivePlugins, loadPluginForAdmin, refreshPluginActivation } = await import("../src/plugins/loader.js");
const { BUILTIN_PLUGINS, isBuiltinPluginId } = await import("../src/plugins/builtins.js");
const { getPlugin, hasPlugin, listPlugins, registerPlugin, resetPluginRegistryForTests } = await import(
  "../src/plugins/registry.js"
);
const { collectPluginGraphParts } = await import("../src/services/topology.js");
const { clearIntegrationConfig, setIntegrationConfig, setIntegrationEnabled } = await import("../src/services/setupStore.js");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRegistryForTests();
  for (const id of ["faux-vm", "faux-sauvegarde", "faux-casse", "hycu"]) await clearIntegrationConfig(id);
});

/** Greffon factice minimal, accepté par le contrat. */
function fakePlugin(
  id: string,
  graphNodeKinds: string[],
  graph?: (config: unknown) => Promise<PluginGraphContribution>,
): Plugin {
  return {
    manifest: {
      id,
      name: `Greffon ${id}`,
      version: "1.0.0",
      coreApi: "^1.0",
      configSchema: { type: "object", properties: {} },
      secretFields: [],
      permissions: { network: [], mutates: false, ...(graph ? { graphNodeKinds } : {}) },
      auditLabels: {},
    },
    test: async () => ({ ok: true, message: "greffon de test, ne contacte rien" }),
    snapshot: async () => ({
      moduleId: id,
      generatedAt: new Date().toISOString(),
      status: "ready",
      summary: [],
      entities: [],
      relations: [],
    }),
    ...(graph ? { graph } : {}),
  };
}

/** Entrée de catalogue factice : `load` compte ses appels, ce qui prouve qu'un greffon en pause
 * n'est même pas IMPORTÉ (et pas seulement « non enregistré »). */
function fakeEntry(plugin: Plugin): { entry: { id: string; exportName: string; load: () => Promise<unknown> }; loads: number[] } {
  const loads: number[] = [];
  return {
    entry: {
      id: plugin.manifest.id,
      exportName: "monGreffon",
      load: async () => {
        loads.push(1);
        return { monGreffon: plugin };
      },
    },
    loads,
  };
}

/** Met le greffon en pause EXPLICITE : une entrée existe et porte `enabled: false`. */
async function pause(id: string): Promise<void> {
  await setIntegrationConfig(id, { jeton: "peu importe" });
  await setIntegrationEnabled(id, false);
}

describe("Chargement à la demande des greffons", () => {
  it("importe et enregistre un greffon actif", async () => {
    const { entry, loads } = fakeEntry(fakePlugin("faux-vm", []));

    const outcome = await loadActivePlugins([entry]);

    expect(outcome).toMatchObject({ loaded: ["faux-vm"], paused: [], failed: [] });
    expect(loads).toHaveLength(1);
    expect(getPlugin("faux-vm")?.manifest.name).toBe("Greffon faux-vm");
  });

  it("n'importe MÊME PAS le module d'un greffon mis en pause", async () => {
    await pause("faux-vm");
    const { entry, loads } = fakeEntry(fakePlugin("faux-vm", []));

    const outcome = await loadActivePlugins([entry]);

    // Le point de toute la mission : pas seulement « masqué », mais jamais chargé.
    expect(loads).toEqual([]);
    expect(outcome).toMatchObject({ loaded: [], paused: ["faux-vm"] });
    expect(hasPlugin("faux-vm")).toBe(false);
  });

  it("jamais configuré n'est PAS en pause : le greffon est chargé (règle de plugins/activation.ts)", async () => {
    const { entry, loads } = fakeEntry(fakePlugin("faux-vm", []));
    await loadActivePlugins([entry]);
    expect(loads).toHaveLength(1);
    expect(hasPlugin("faux-vm")).toBe(true);
  });

  it("un import qui échoue est signalé et ignoré — les autres greffons se chargent quand même", async () => {
    const casse = {
      id: "faux-casse",
      exportName: "monGreffon",
      load: async () => {
        throw new Error("Cannot find module './faux-casse/index.js'");
      },
    };
    const { entry: sain } = fakeEntry(fakePlugin("faux-vm", []));

    const outcome = await loadActivePlugins([casse, sain]);

    expect(outcome.loaded).toEqual(["faux-vm"]);
    expect(outcome.failed).toEqual([{ id: "faux-casse", reason: "Cannot find module './faux-casse/index.js'" }]);
    expect(hasPlugin("faux-casse")).toBe(false);
    expect(hasPlugin("faux-vm")).toBe(true);
    expect(warnings.join("\n")).toContain('[greffons] "faux-casse" ignoré');
  });

  it("un module sans l'export attendu, ou dont le manifeste annonce un autre identifiant, est refusé", async () => {
    const sansExport = { id: "faux-vm", exportName: "monGreffon", load: async () => ({}) };
    expect((await loadActivePlugins([sansExport])).failed[0]?.reason).toContain('n\'exporte pas "monGreffon"');
    expect(hasPlugin("faux-vm")).toBe(false);

    const usurpateur = {
      id: "faux-vm",
      exportName: "monGreffon",
      load: async () => ({ monGreffon: fakePlugin("faux-sauvegarde", []) }),
    };
    expect((await loadActivePlugins([usurpateur])).failed[0]?.reason).toContain('attendu "faux-vm"');
    expect(hasPlugin("faux-sauvegarde")).toBe(false);
  });

  it("le démarrage de l'API n'attend jamais qu'un greffon veuille bien se charger", async () => {
    const app = buildServer();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it("mettre en pause puis réactiver prend effet SANS redémarrage", async () => {
    const { entry, loads } = fakeEntry(fakePlugin("faux-vm", []));
    await loadActivePlugins([entry]);
    expect(hasPlugin("faux-vm")).toBe(true);

    await pause("faux-vm");
    await refreshPluginActivation("faux-vm", [entry]);
    expect(hasPlugin("faux-vm")).toBe(false);

    await setIntegrationEnabled("faux-vm", true);
    await refreshPluginActivation("faux-vm", [entry]);
    expect(hasPlugin("faux-vm")).toBe(true);
    // Deux imports au total : celui du départ, celui de la réactivation — jamais un par passe.
    expect(loads).toHaveLength(2);
  });

  it("le catalogue connaît un greffon même en pause, et sait le charger pour l'administration", async () => {
    expect(BUILTIN_PLUGINS.map((entry) => entry.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
    expect(isBuiltinPluginId("hycu")).toBe(true);
    expect(isBuiltinPluginId("inexistant")).toBe(false);

    await pause("hycu");
    await loadActivePlugins();
    expect(hasPlugin("hycu")).toBe(false);

    // Sans cette porte, un greffon en pause n'aurait plus de manifeste à présenter et resterait
    // impossible à réactiver depuis l'interface.
    expect(await loadPluginForAdmin("hycu")).toBe(true);
    expect(getPlugin("hycu")?.manifest.id).toBe("hycu");
    expect(await loadPluginForAdmin("inexistant")).toBe(false);
  });
});

/** Nœud d'un greffon « fournisseur », et greffon « consommateur » qui s'y raccroche en phase 2. */
function vmProviderPlugin(): Plugin {
  return fakePlugin("faux-vm", ["faux-machine"], async () => ({
    nodes: [
      {
        id: "nutanix-vm:uuid-a",
        kind: "faux-machine",
        label: "HDVAPPLI",
        subtitle: "Cluster Mairie",
        status: "running",
        // `fields` recopié tel quel : c'est ainsi qu'un greffon porte ce que le contrat ne décrit
        // pas, et qu'il choisit le type de nœud RENDU par le graphe.
        fields: { kind: "nutanix-vm", numVcpus: 4, nutanixDisks: [{ uuid: "disk-1", sizeBytes: 42 }] },
      },
      {
        id: "host:faux-cluster",
        kind: "faux-machine",
        label: "CLUSTER",
        subtitle: "Cluster",
        status: "running",
        rootAttachment: "environment",
        fields: { kind: "host", hostKind: "nutanix-cluster" },
      },
    ],
    edges: [{ id: "hosts:cluster:uuid-a", source: "host:faux-cluster", target: "nutanix-vm:uuid-a", kind: "hosts" }],
    attachments: [
      { nodeId: "nutanix-vm:uuid-a", kind: "network", id: "network:uuid-a:0", label: "VLAN_SERVEURS", subtitle: "VLAN 12" },
    ],
  }));
}

function backupConsumerPlugin(seen: string[][]): Plugin {
  return fakePlugin("faux-sauvegarde", ["faux-appliance"], async () => ({
    nodes: [
      {
        id: "hycu-appliance:main",
        kind: "faux-appliance",
        label: "Sauvegarde",
        subtitle: "https://exemple.priv",
        status: "running",
        rootAttachment: "integration",
        fields: { kind: "hycu-appliance", hycuVmTotal: 1 },
      },
    ],
    edges: [],
    attachments: [],
    link: (context): PluginGraphLinks => {
      const vms = context.nodesOfKind("faux-machine");
      seen.push(vms.map((node) => node.id));
      return {
        edges: vms
          .filter((node) => node.id.startsWith("nutanix-vm:"))
          .map((node) => ({ id: `protects:${node.id}`, source: node.id, target: "hycu-appliance:main", kind: "protects" })),
        annotations: vms
          .filter((node) => node.id.startsWith("nutanix-vm:"))
          .map((node) => ({ nodeId: node.id, fields: { hycuProtection: "protected", hycuPolicyName: "Gold" } })),
      };
    },
  }));
}

describe("Agrégation des contributions au graphe", () => {
  it("collecte DEUX greffons et laisse l'un relier/annoter les nœuds de l'autre", async () => {
    const seen: string[][] = [];
    // Enregistrés dans cet ordre, mais listPlugins() trie par identifiant : "faux-sauvegarde" passe
    // AVANT "faux-vm". Si le contexte était rempli au fil de l'eau, il ne verrait aucune VM.
    registerPlugin(vmProviderPlugin());
    registerPlugin(backupConsumerPlugin(seen));

    const parts = await collectPluginGraphParts();

    expect(listPlugins().map((p) => p.manifest.id).filter((id) => id.startsWith("faux-"))).toEqual([
      "faux-sauvegarde",
      "faux-vm",
    ]);
    expect(seen).toEqual([["nutanix-vm:uuid-a", "host:faux-cluster"]]);
    expect(parts.nodes.map((node) => node.id)).toEqual(["hycu-appliance:main", "nutanix-vm:uuid-a", "host:faux-cluster"]);
    // Phase 1 et phase 2 restent séparées : le socle les remet dans l'ordre du graphe.
    expect(parts.edges).toEqual([
      { id: "hosts:cluster:uuid-a", source: "host:faux-cluster", target: "nutanix-vm:uuid-a", kind: "hosts" },
    ]);
    expect(parts.linkEdges).toEqual([
      { id: "protects:nutanix-vm:uuid-a", source: "nutanix-vm:uuid-a", target: "hycu-appliance:main", kind: "protects" },
    ]);
    // Le rattachement à la racine est DÉCLARÉ par les greffons, jamais deviné par le socle.
    expect(parts.environmentNodeIds).toEqual(["host:faux-cluster"]);
    expect(parts.integrationNodeIds).toEqual(["hycu-appliance:main"]);
  });

  it("projette `fields` tel quel : type rendu, hostKind, données réelles et annotations posées sur le nœud", async () => {
    registerPlugin(vmProviderPlugin());
    registerPlugin(backupConsumerPlugin([]));

    const parts = await collectPluginGraphParts();
    const vm = parts.nodes.find((node) => node.id === "nutanix-vm:uuid-a");
    const cluster = parts.nodes.find((node) => node.id === "host:faux-cluster");

    expect(vm).toMatchObject({
      kind: "nutanix-vm",
      label: "HDVAPPLI",
      subtitle: "Cluster Mairie",
      status: "running",
      numVcpus: 4,
      nutanixDisks: [{ uuid: "disk-1", sizeBytes: 42 }],
      // Posé par l'AUTRE greffon, en phase 2.
      hycuProtection: "protected",
      hycuPolicyName: "Gold",
    });
    // Le vocabulaire du greffon ("faux-machine") est plus fin que celui du graphe : `fields.kind`
    // dit ce que le graphe doit rendre.
    expect(cluster).toMatchObject({ kind: "host", hostKind: "nutanix-cluster" });
    // Tiroir porté par la vue portable du contrat, faute de charge utile `fields.attachments`.
    expect(vm?.attachments).toEqual([
      { kind: "network", id: "network:uuid-a:0", label: "VLAN_SERVEURS", subtitle: "VLAN 12" },
    ]);
  });

  it("un greffon dont la contribution est invalide est ignoré AVEC UNE TRACE, jamais en silence", async () => {
    registerPlugin(
      fakePlugin("faux-vm", ["faux-machine"], async () => ({
        nodes: [
          // Type de nœud non déclaré dans le manifeste.
          { id: "intrus:1", kind: "type-non-declare", label: "x", subtitle: "", status: "running" },
          // Type que le graphe ne sait pas rendre.
          { id: "intrus:2", kind: "faux-machine", label: "x", subtitle: "", status: "running", fields: { kind: "licorne" } },
          // Sans identifiant.
          { id: "", kind: "faux-machine", label: "x", subtitle: "", status: "running" },
          { id: "ok:1", kind: "faux-machine", label: "x", subtitle: "", status: "running", fields: { kind: "hycu-appliance" } },
          // Doublon d'identifiant.
          { id: "ok:1", kind: "faux-machine", label: "y", subtitle: "", status: "running", fields: { kind: "hycu-appliance" } },
        ],
        // Arête vers un nœud absent du graphe : jamais projetée.
        edges: [{ id: "e1", source: "ok:1", target: "fantome", kind: "hosts" }],
        attachments: [{ nodeId: "fantome", kind: "network", id: "n1", label: "x", subtitle: "" }],
      })),
    );

    const parts = await collectPluginGraphParts();

    expect(parts.nodes.map((node) => node.id)).toEqual(["ok:1"]);
    expect(parts.edges).toEqual([]);
    const trace = warnings.join("\n");
    expect(trace).toContain("permissions.graphNodeKinds");
    expect(trace).toContain("le graphe ne sait pas rendre un nœud de type");
    expect(trace).toContain("il n'a pas d'identifiant");
    expect(trace).toContain("déjà porté par un autre nœud du graphe");
    expect(trace).toContain("elle relie un nœud absent du graphe");
    expect(trace).toContain("absent du graphe");
  });

  it("un greffon dont graph() lève n'emporte pas les contributions des autres", async () => {
    registerPlugin(
      fakePlugin("faux-casse", ["faux-machine"], async () => {
        throw new Error("Prism Central a répondu 500");
      }),
    );
    registerPlugin(vmProviderPlugin());

    const parts = await collectPluginGraphParts();

    expect(parts.nodes.map((node) => node.id)).toEqual(["nutanix-vm:uuid-a", "host:faux-cluster"]);
    expect(warnings.join("\n")).toContain("Prism Central a répondu 500");
  });

  it("une annotation ne peut ni renommer ni requalifier le nœud d'un autre greffon", async () => {
    registerPlugin(vmProviderPlugin());
    registerPlugin(
      fakePlugin("faux-sauvegarde", ["faux-appliance"], async () => ({
        nodes: [],
        edges: [],
        attachments: [],
        link: (): PluginGraphLinks => ({
          edges: [],
          annotations: [{ nodeId: "nutanix-vm:uuid-a", fields: { label: "PIRATÉ", kind: "volume", hycuProtection: "protected" } }],
        }),
      })),
    );

    const parts = await collectPluginGraphParts();
    const vm = parts.nodes.find((node) => node.id === "nutanix-vm:uuid-a");

    expect(vm).toMatchObject({ label: "HDVAPPLI", kind: "nutanix-vm", hycuProtection: "protected" });
    expect(warnings.join("\n")).toContain("l'identité d'un nœud n'appartient qu'au greffon qui l'a contribué");
  });

  it("mettre un greffon en pause le fait disparaître du graphe, sans qu'une ligne du socle le nomme", async () => {
    const { entry } = fakeEntry(vmProviderPlugin());
    await loadActivePlugins([entry]);
    expect((await collectPluginGraphParts()).nodes.map((node) => node.id)).toContain("nutanix-vm:uuid-a");

    await pause("faux-vm");
    await refreshPluginActivation("faux-vm", [entry]);

    const parts = await collectPluginGraphParts();
    expect(parts.nodes).toEqual([]);
    expect(parts.edges).toEqual([]);
  });
});
