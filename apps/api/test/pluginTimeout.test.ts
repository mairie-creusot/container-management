import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Plugin, PluginGraphContribution, PluginGraphLinks } from "@quai/plugin-contract";

/**
 * DÉLAIS D'EXPIRATION des appels aux greffons (plugins/guard.ts).
 *
 * Sans isolation hors processus, un greffon qui ne rend jamais la main figerait le graphe entier :
 * ces tests exercent des greffons FACTICES dont les appels ne se terminent jamais, et vérifient que
 * chacun est abandonné, tracé, et traité comme non contributif. Aucun accès réseau.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "9".repeat(64);
process.env.PLUGINS_PATH = path.join(tmpDir, "plugins");
// Délais volontairement courts : la suite doit constater l'abandon, pas l'attendre.
process.env.PLUGIN_TEST_TIMEOUT_MS = "150";
process.env.PLUGIN_GRAPH_TIMEOUT_MS = "150";
process.env.PLUGIN_SNAPSHOT_TIMEOUT_MS = "150";
process.env.PLUGIN_ACTION_TIMEOUT_MS = "150";

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { getPlugin, registerPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { collectPluginGraphParts } = await import("../src/services/topology.js");

let warnings: string[] = [];
let app: FastifyInstance | undefined;

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}

/** Ne se termine JAMAIS — exactement ce que fait une intégration qui ne répond plus. */
function jamais<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function greffonMuet(id: string, graph: () => Promise<PluginGraphContribution> = () => jamais()): Plugin {
  return {
    manifest: {
      id,
      name: `Greffon ${id}`,
      version: "1.0.0",
      coreApi: "^1.0",
      configSchema: { type: "object", properties: {} },
      secretFields: [],
      permissions: { network: [], mutates: true, graphNodeKinds: ["noeud-muet"] },
      auditLabels: { "ne-repond-pas": "Action qui ne répond jamais" },
    },
    test: () => jamais(),
    snapshot: () => jamais(),
    graph,
    actions: { "ne-repond-pas": () => jamais() },
  };
}

/** Greffon sain : il répond, et doit continuer de contribuer même quand un autre se tait. */
function greffonSain(): Plugin {
  return {
    manifest: {
      id: "greffon-sain",
      name: "Greffon sain",
      version: "1.0.0",
      coreApi: "^1.0",
      configSchema: { type: "object", properties: {} },
      secretFields: [],
      permissions: { network: [], mutates: false, graphNodeKinds: ["noeud-sain"] },
      auditLabels: {},
    },
    test: async () => ({ ok: true, message: "greffon de test, ne contacte rien" }),
    snapshot: async () => ({
      moduleId: "greffon-sain",
      generatedAt: new Date().toISOString(),
      status: "ready",
      summary: [],
      entities: [],
      relations: [],
    }),
    graph: async (): Promise<PluginGraphContribution> => ({
      nodes: [
        {
          id: "hycu-appliance:sain",
          kind: "noeud-sain",
          label: "Sain",
          subtitle: "présent",
          status: "running",
          fields: { kind: "hycu-appliance" },
        },
      ],
      edges: [],
      attachments: [],
    }),
  };
}

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Un greffon qui ne répond pas ne bloque jamais le socle", () => {
  it("abandonne son instantané et sa contribution au graphe, avec une trace, sans emporter les autres", async () => {
    registerPlugin(greffonMuet("greffon-muet"));
    registerPlugin(greffonSain());

    const parts = await collectPluginGraphParts();

    // Le greffon sain contribue quand même : un muet n'emporte pas le graphe.
    expect(parts.nodes.map((node) => node.id)).toEqual(["hycu-appliance:sain"]);
    expect(warnings.join("\n")).toContain(`Le greffon "greffon-muet" n'a pas répondu en 0.2 s (contribution au graphe)`);

    // Même règle pour l'instantané : un refus daté, jamais une attente infinie.
    await expect(getPlugin("greffon-muet")!.snapshot({})).rejects.toThrow(/n'a pas répondu/);
  });

  it("abandonne le SECOND TEMPS (liens vers les autres greffons), sans perdre les nœuds déjà contribués", async () => {
    registerPlugin(
      greffonMuet("greffon-muet", async (): Promise<PluginGraphContribution> => ({
        nodes: [
          {
            id: "nutanix-vm:muet",
            kind: "noeud-muet",
            label: "VM",
            subtitle: "contribuée",
            status: "running",
            fields: { kind: "nutanix-vm" },
          },
        ],
        edges: [],
        attachments: [],
        link: (): Promise<PluginGraphLinks> => jamais(),
      })),
    );

    const parts = await collectPluginGraphParts();

    expect(parts.nodes.map((node) => node.id)).toEqual(["nutanix-vm:muet"]);
    expect(parts.linkEdges).toEqual([]);
    expect(warnings.join("\n")).toContain("liens vers les autres greffons");
  });

  it("répond 504 sur une action qui ne rend jamais la main, jamais une requête suspendue", async () => {
    registerPlugin(greffonMuet("greffon-muet"));
    app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/plugins/greffon-muet/actions/ne-repond-pas",
      cookies: adminCookie(),
      payload: {},
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error).toContain(`Le greffon "greffon-muet" n'a pas répondu`);
    expect(response.json().error).toContain("action « ne-repond-pas »");
  });

  it("rapporte honnêtement un test de connexion qui ne revient pas, sans 500 anonyme", async () => {
    registerPlugin(greffonMuet("greffon-muet"));
    app = buildServer();
    await app.ready();

    const essai = await app.inject({
      method: "POST",
      url: "/api/plugins/greffon-muet/config/test",
      cookies: adminCookie(),
      payload: { config: {} },
    });
    expect(essai.statusCode).toBe(200);
    expect(essai.json()).toMatchObject({ ok: false });
    expect(essai.json().message).toContain("n'a pas répondu");

    const enregistrement = await app.inject({
      method: "PUT",
      url: "/api/plugins/greffon-muet/config",
      cookies: adminCookie(),
      payload: { config: {} },
    });
    expect(enregistrement.statusCode).toBe(504);
    expect(enregistrement.json().error).toContain("test de connexion");
  });

  it("ne pose aucun délai indu : un greffon qui répond répond, et son résultat est intact", async () => {
    registerPlugin(greffonSain());
    const plugin = getPlugin("greffon-sain")!;

    await expect(plugin.test({})).resolves.toEqual({ ok: true, message: "greffon de test, ne contacte rien" });
    expect((await plugin.snapshot({})).status).toBe("ready");
    expect((await plugin.graph!({})).nodes[0]?.id).toBe("hycu-appliance:sain");
    expect(warnings.join("\n")).not.toContain("n'a pas répondu");
  });
});
