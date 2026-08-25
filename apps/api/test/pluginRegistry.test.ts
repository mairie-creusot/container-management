import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONFIG_PATH isolé (même pattern que serviceModules.test.ts) : buildServer() charge config.ts.
 * Couvre le contrat (@quai/plugin-contract), le registre (src/plugins/registry.ts) et la route
 * GET /api/plugins — y compris qu'aucun secret ni aucune valeur de configuration n'en sort.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugins-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const {
  getPlugin,
  listPluginManifests,
  listPlugins,
  PluginRegistrationError,
  registerPlugin,
  resetPluginRegistryForTests,
} = await import("../src/plugins/registry.js");
const { examplePlugin } = await import("../src/plugins/example/index.js");
const { CORE_API_VERSION, publicManifest, validateManifest, validatePlugin } = await import("@quai/plugin-contract");
type PluginValidationIssue = { code: string; field: string; message: string };

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

/** Manifeste valide de référence, recréé à chaque appel pour que chaque test le torde isolément. */
function validManifest(): Record<string, unknown> {
  return {
    id: "hycu",
    name: "HYCU",
    version: "1.2.3",
    coreApi: "^1.0",
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", title: "URL de l'appliance" },
        apiToken: { type: "string", title: "Jeton d'API" },
      },
      required: ["baseUrl", "apiToken"],
    },
    secretFields: ["apiToken"],
    permissions: { network: ["hycu.exemple.priv:8443"], mutates: false },
    auditLabels: {},
  };
}

function issuesOf(result: { ok: boolean; issues?: PluginValidationIssue[] }): PluginValidationIssue[] {
  expect(result.ok).toBe(false);
  return result.issues ?? [];
}

function issueWithCode(result: { ok: boolean; issues?: PluginValidationIssue[] }, code: string): PluginValidationIssue {
  const issue = issuesOf(result).find((candidate) => candidate.code === code);
  expect(issue, `aucun refus de code "${code}" : ${JSON.stringify(issuesOf(result))}`).toBeDefined();
  return issue as PluginValidationIssue;
}

describe("contrat de manifeste", () => {
  it("accepte un manifeste valide", () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("hycu");
      expect(result.manifest.secretFields).toEqual(["apiToken"]);
      expect(result.manifest.permissions.mutates).toBe(false);
    }
  });

  it("accepte un identifiant commençant par un chiffre (« 3cx »)", () => {
    expect(validateManifest({ ...validManifest(), id: "3cx" }).ok).toBe(true);
  });

  it("refuse un identifiant malformé avec son propre message", () => {
    const issue = issueWithCode(validateManifest({ ...validManifest(), id: "HYCU Backup" }), "id.pattern");
    expect(issue.field).toBe("id");
    expect(issue.message).toContain("HYCU Backup");
    expect(issue.message).toContain("minuscules");
  });

  it("refuse une version qui n'est pas un semver", () => {
    const issue = issueWithCode(validateManifest({ ...validManifest(), version: "1.2" }), "version.semver");
    expect(issue.message).toContain("semver");
    expect(issue.message).toContain("1.2");
  });

  it("refuse une plage coreApi malformée", () => {
    const issue = issueWithCode(validateManifest({ ...validManifest(), coreApi: ">=1" }), "coreApi.range");
    expect(issue.message).toContain("formats acceptés");
  });

  it("refuse un coreApi incompatible avec la version du socle", () => {
    const issue = issueWithCode(validateManifest({ ...validManifest(), coreApi: "^2.0" }), "coreApi.incompatible");
    expect(issue.message).toContain("^2.0");
    expect(issue.message).toContain(CORE_API_VERSION);
  });

  it("accepte les plages réellement satisfaites par la version du socle", () => {
    for (const coreApi of ["^1.0", "~1.0", "1.0.0", "1.0"]) {
      expect(validateManifest({ ...validManifest(), coreApi }).ok, coreApi).toBe(true);
    }
    for (const coreApi of ["^0.9", "~1.1", "2.0.0"]) {
      expect(validateManifest({ ...validManifest(), coreApi }).ok, coreApi).toBe(false);
    }
  });

  it("refuse un secretFields désignant un champ absent du schéma", () => {
    const manifest = validManifest();
    manifest.secretFields = ["jetonInexistant"];
    const issue = issueWithCode(validateManifest(manifest), "secretFields.unknown");
    expect(issue.message).toContain("jetonInexistant");
    expect(issue.message).toContain("configSchema.properties");
  });

  it("refuse un champ secret porteur d'une valeur par défaut", () => {
    const manifest = validManifest();
    manifest.configSchema = {
      type: "object",
      properties: { apiToken: { type: "string", default: "jeton-en-clair" } },
    };
    const issue = issueWithCode(validateManifest(manifest), "secretFields.value");
    expect(issue.message).toContain("apiToken");
  });

  it("refuse un configSchema qui n'est pas un schéma d'objet", () => {
    const manifest = validManifest();
    manifest.configSchema = { type: "string" };
    expect(issueWithCode(validateManifest(manifest), "configSchema.type").field).toBe("configSchema");
  });

  it("refuse une permission inconnue et un hôte réseau qui n'en est pas un", () => {
    const withUnknownKey = validManifest();
    withUnknownKey.permissions = { netwrok: ["x"] };
    expect(issueWithCode(validateManifest(withUnknownKey), "permissions.unknownKey").message).toContain("netwrok");

    const withUrl = validManifest();
    withUrl.permissions = { network: ["https://hycu.exemple.priv/api"] };
    expect(issueWithCode(validateManifest(withUrl), "permissions.network").message).toContain("hôte");
  });

  it("refuse une clé de manifeste inconnue plutôt que de l'ignorer", () => {
    const manifest = { ...validManifest(), configSchemas: {} };
    expect(issueWithCode(validateManifest(manifest), "manifest.unknownKey").message).toContain("configSchemas");
  });

  it("signale TOUS les motifs de refus d'un coup, jamais un chargement à moitié", () => {
    const issues = issuesOf(validateManifest({ ...validManifest(), id: "X", version: "nope" }));
    expect(issues.map((issue) => issue.code).sort()).toEqual(["id.pattern", "version.semver"]);
  });
});

describe("contrat de greffon", () => {
  function validPlugin(): Record<string, unknown> {
    return {
      manifest: validManifest(),
      test: async () => ({ ok: true, message: "ok" }),
      snapshot: async () => ({
        moduleId: "hycu",
        generatedAt: new Date().toISOString(),
        status: "not-configured",
        summary: [],
        entities: [],
        relations: [],
      }),
    };
  }

  it("accepte un greffon minimal en lecture seule", () => {
    expect(validatePlugin(validPlugin()).ok).toBe(true);
  });

  it("refuse un greffon sans snapshot()", () => {
    const plugin = validPlugin();
    delete plugin.snapshot;
    expect(issueWithCode(validatePlugin(plugin), "plugin.snapshot").message).toContain("snapshot");
  });

  it("impose la lecture seule à un greffon qui expose des actions sans permissions.mutates", () => {
    const plugin = validPlugin();
    plugin.actions = { restart: async () => undefined };
    const issue = issueWithCode(validatePlugin(plugin), "actions.readOnly");
    expect(issue.message).toContain("lecture seule");
  });

  it("exige un libellé d'audit pour chaque action", () => {
    const plugin = validPlugin();
    const manifest = validManifest();
    manifest.permissions = { mutates: true };
    plugin.manifest = manifest;
    plugin.actions = { restart: async () => undefined };
    expect(issueWithCode(validatePlugin(plugin), "actions.auditLabel").message).toContain("restart");

    manifest.auditLabels = { restart: "Redémarrage de l'appliance" };
    expect(validatePlugin(plugin).ok).toBe(true);
  });

  it("exige des graphNodeKinds dès qu'un greffon contribue au graphe", () => {
    const plugin = validPlugin();
    plugin.graph = async () => ({ nodes: [], edges: [], attachments: [] });
    expect(issueWithCode(validatePlugin(plugin), "graph.nodeKinds").message).toContain("graphNodeKinds");
  });
});

describe("registre de greffons", () => {
  it("n'enregistre AUCUN greffon au démarrage (le greffon d'exemple n'est pas une intégration)", () => {
    app = buildServer();
    expect(listPlugins()).toEqual([]);
  });

  it("enregistre le greffon d'exemple et le retrouve par son identifiant", () => {
    registerPlugin(examplePlugin);
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toEqual(["example"]);
    expect(getPlugin("example")?.manifest.name).toBe("Greffon d'exemple");
    expect(getPlugin("inconnu")).toBeUndefined();
  });

  it("refuse explicitement deux greffons portant le même identifiant", () => {
    registerPlugin(examplePlugin);
    const doublon = { ...examplePlugin, manifest: { ...examplePlugin.manifest, name: "Autre greffon" } };
    expect(() => registerPlugin(doublon)).toThrow(PluginRegistrationError);
    expect(() => registerPlugin(doublon)).toThrow(/déjà enregistré/);
    expect(listPlugins()).toHaveLength(1);
    expect(getPlugin("example")?.manifest.name).toBe("Greffon d'exemple");
  });

  it("refuse un greffon invalide sans jamais l'enregistrer à moitié", () => {
    const invalide = { ...examplePlugin, manifest: { ...examplePlugin.manifest, version: "1" } };
    expect(() => registerPlugin(invalide)).toThrow(/semver/);
    expect(listPlugins()).toEqual([]);
    expect(getPlugin("example")).toBeUndefined();
  });

  it("le greffon d'exemple ne contacte rien et rapporte honnêtement son état", async () => {
    await expect(examplePlugin.test({})).resolves.toEqual({
      ok: false,
      message: 'Configuration incomplète : "label" et "token" sont requis.',
    });

    const snapshot = await examplePlugin.snapshot({ label: "Démo", token: "jeton" });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.summary).toEqual([{ label: "Étiquette", value: "Démo", tone: "neutral" }]);

    const vide = await examplePlugin.snapshot(undefined);
    expect(vide.status).toBe("not-configured");
    expect(vide.summary).toEqual([]);
  });
});

describe("GET /api/plugins", () => {
  it("exige une session", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(response.statusCode).toBe(401);
  });

  it("renvoie une liste vide tant qu'aucun greffon n'est enregistré", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plugins: [] });
  });

  it("expose le manifeste public, sans le moindre secret ni valeur de configuration", async () => {
    registerPlugin(examplePlugin);
    const secret = "jeton-de-test-ultra-secret";
    await expect(examplePlugin.test({ label: "Démo", token: secret })).resolves.toEqual({
      ok: true,
      message: "Configuration valide — ce greffon d'exemple ne contacte aucun service.",
    });

    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { plugins: Array<Record<string, unknown>> };
    expect(body.plugins).toHaveLength(1);
    const manifest = body.plugins[0]!;
    expect(Object.keys(manifest).sort()).toEqual(
      ["auditLabels", "configSchema", "coreApi", "id", "name", "permissions", "secretFields", "version"],
    );
    expect(manifest.id).toBe("example");
    expect(manifest.secretFields).toEqual(["token"]);

    // Le jeton passé à test() ne doit apparaître NULLE PART dans la réponse, ni sous forme de
    // valeur par défaut du schéma : le manifeste public ne transporte que la FORME de la config.
    expect(response.payload).not.toContain(secret);
    const properties = (manifest.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.token?.default).toBeUndefined();
    expect(properties.token?.const).toBeUndefined();
    expect(properties.token?.examples).toBeUndefined();
    expect(properties.token?.title).toBe("Jeton");
  });

  it("le manifeste public est une copie : le modifier ne touche pas le greffon enregistré", () => {
    registerPlugin(examplePlugin);
    const [manifest] = listPluginManifests();
    manifest!.secretFields.push("intrus");
    expect(examplePlugin.manifest.secretFields).toEqual(["token"]);
    expect(publicManifest(examplePlugin.manifest).secretFields).toEqual(["token"]);
  });
});
