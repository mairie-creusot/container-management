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
const { CORE_API_VERSION, publicManifest, validateActionInput, validateManifest, validatePlugin } = await import(
  "@quai/plugin-contract"
);
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

  // Socle en 1.1.0 depuis l'ajout de `actions` au manifeste : une plage figée sur 1.0 exact
  // (« ~1.0 », « 1.0.0 ») n'est plus satisfaite, alors que « ^1.0 » — la plage de TOUS les greffons
  // du dépôt — l'est toujours, ce que vérifie la première boucle.
  it("accepte les plages réellement satisfaites par la version du socle", () => {
    for (const coreApi of ["^1.0", "~1.1", "1.1.0", "1.1"]) {
      expect(validateManifest({ ...validManifest(), coreApi }).ok, coreApi).toBe(true);
    }
    for (const coreApi of ["^0.9", "~1.0", "1.0.0", "2.0.0"]) {
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

/** Schéma d'objet nu — les libellés ne concernent pas le contrat, seule la FORME est validée ici. */
function objectSchema(properties: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  return { type: "object", properties, ...(required ? { required } : {}) };
}

/** Manifeste dont seul le configSchema varie : secretFields vidé pour n'éprouver que le schéma. */
function manifestWithSchema(configSchema: unknown, secretFields: string[] = []): Record<string, unknown> {
  return { ...validManifest(), configSchema, secretFields };
}

describe("condition d'affichage (showIf)", () => {
  const mode = { type: "string", enum: ["client-credentials", "user"], default: "client-credentials" };

  it("accepte les bascules RÉELLES de 3CX, GLPI et AD CS", () => {
    const threecx = objectSchema(
      {
        baseUrl: { type: "string" },
        authMode: mode,
        clientId: { type: "string", showIf: { field: "authMode", equals: "client-credentials" } },
        clientSecret: { type: "string", showIf: { field: "authMode", equals: "client-credentials" } },
        username: { type: "string", showIf: { field: "authMode", equals: "user" } },
        password: { type: "string", showIf: { field: "authMode", equals: "user" } },
        tlsRejectUnauthorized: { type: "boolean", default: true },
      },
      ["baseUrl", "clientId", "clientSecret", "username", "password"],
    );
    expect(validateManifest(manifestWithSchema(threecx, ["clientSecret", "password"])).ok).toBe(true);

    const glpi = objectSchema(
      {
        apiUrl: { type: "string" },
        appToken: { type: "string" },
        authMode: { type: "string", enum: ["user-token", "credentials"], default: "user-token" },
        userToken: { type: "string", showIf: { field: "authMode", equals: "user-token" } },
        username: { type: "string", showIf: { field: "authMode", equals: "credentials" } },
        password: { type: "string", showIf: { field: "authMode", equals: "credentials" } },
      },
      ["apiUrl", "appToken", "userToken", "username", "password"],
    );
    expect(validateManifest(manifestWithSchema(glpi, ["appToken", "userToken", "password"])).ok).toBe(true);

    const certificates = objectSchema(
      {
        caUrl: { type: "string" },
        template: { type: "string", default: "WebServer" },
        accountSource: { type: "string", enum: ["directory", "dedicated"], default: "directory" },
        username: { type: "string", showIf: { field: "accountSource", equals: "dedicated" } },
        password: { type: "string", showIf: { field: "accountSource", equals: "dedicated" } },
        renewBeforeDays: { type: "number", minimum: 1 },
        autoEnroll: { type: "boolean", default: true },
      },
      ["caUrl", "template", "username", "password"],
    );
    expect(validateManifest(manifestWithSchema(certificates, ["password"])).ok).toBe(true);
  });

  it("accepte une condition portée par un booléen ou par un nombre", () => {
    const schema = objectSchema({
      tls: { type: "boolean", default: true },
      port: { type: "number" },
      caBundle: { type: "string", showIf: { field: "tls", equals: true } },
      pipeline: { type: "string", showIf: { field: "port", equals: 8443 } },
    });
    expect(validateManifest(manifestWithSchema(schema)).ok).toBe(true);
  });

  it("refuse un showIf qui n'est pas un objet { field, equals }", () => {
    const issue = issueWithCode(
      validateManifest(manifestWithSchema(objectSchema({ authMode: mode, token: { type: "string", showIf: "authMode" } }))),
      "configSchema.showIf.type",
    );
    expect(issue.field).toBe("configSchema.properties.token.showIf");
  });

  it("refuse une clé inconnue dans showIf plutôt que de l'ignorer", () => {
    const schema = objectSchema({
      authMode: mode,
      token: { type: "string", showIf: { field: "authMode", equals: "user", equalsAny: ["user"] } },
    });
    expect(issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.unknownKey").message).toContain(
      "equalsAny",
    );
  });

  it("refuse une condition sans champ visé, ou visant la propriété elle-même", () => {
    const sansChamp = objectSchema({ token: { type: "string", showIf: { equals: "user" } } });
    expect(issueWithCode(validateManifest(manifestWithSchema(sansChamp)), "configSchema.showIf.field").message).toContain(
      "showIf.field",
    );

    const surSoi = objectSchema({ token: { type: "string", showIf: { field: "token", equals: "user" } } });
    expect(issueWithCode(validateManifest(manifestWithSchema(surSoi)), "configSchema.showIf.self").message).toContain("token");
  });

  it("refuse une condition visant une propriété non déclarée", () => {
    const schema = objectSchema({ token: { type: "string", showIf: { field: "authMode", equals: "user" } } });
    const issue = issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.unknown");
    expect(issue.message).toContain("authMode");
    expect(issue.message).toContain("configSchema.properties");
  });

  it("refuse une dépendance en CHAÎNE : le champ visé ne peut pas être lui-même conditionnel", () => {
    const schema = objectSchema({
      authMode: mode,
      username: { type: "string", showIf: { field: "authMode", equals: "user" } },
      password: { type: "string", showIf: { field: "username", equals: "1000" } },
    });
    const issue = issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.chain");
    expect(issue.message).toContain("password");
    expect(issue.message).toContain("username");
  });

  it("refuse une condition sans valeur attendue", () => {
    const schema = objectSchema({ authMode: mode, token: { type: "string", showIf: { field: "authMode" } } });
    expect(issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.equals").message).toContain(
      "obligatoire",
    );
  });

  it("refuse une valeur attendue du mauvais type", () => {
    const surBooleen = objectSchema({
      tls: { type: "boolean", default: true },
      caBundle: { type: "string", showIf: { field: "tls", equals: "true" } },
    });
    expect(issueWithCode(validateManifest(manifestWithSchema(surBooleen)), "configSchema.showIf.equalsType").message).toContain(
      "boolean",
    );

    const surNombre = objectSchema({
      port: { type: "number" },
      pipeline: { type: "string", showIf: { field: "port", equals: "8443" } },
    });
    expect(issueWithCode(validateManifest(manifestWithSchema(surNombre)), "configSchema.showIf.equalsType").message).toContain(
      "number",
    );
  });

  it("refuse une valeur absente de l'énumération visée", () => {
    const schema = objectSchema({ authMode: mode, token: { type: "string", showIf: { field: "authMode", equals: "oauth" } } });
    const issue = issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.equalsEnum");
    expect(issue.message).toContain("oauth");
    expect(issue.message).toContain("client-credentials");
  });

  it("refuse une condition pilotée par une propriété qui ne peut pas l'être", () => {
    const schema = objectSchema({
      hosts: { type: "array", items: { type: "string" } },
      token: { type: "string", showIf: { field: "hosts", equals: "a" } },
    });
    expect(issueWithCode(validateManifest(manifestWithSchema(schema)), "configSchema.showIf.target").message).toContain(
      "ne peut pas piloter",
    );
  });

  it("refuse un showIf enfoui, là où le formulaire ne le lirait jamais", () => {
    const nested = objectSchema({
      authMode: mode,
      proxy: { type: "object", properties: { host: { type: "string", showIf: { field: "authMode", equals: "user" } } } },
    });
    const issue = issueWithCode(validateManifest(manifestWithSchema(nested)), "configSchema.showIf.placement");
    expect(issue.field).toBe("configSchema.properties.proxy.properties.host");

    const racine = { ...objectSchema({ authMode: mode }), showIf: { field: "authMode", equals: "user" } };
    expect(issueWithCode(validateManifest(manifestWithSchema(racine)), "configSchema.showIf.placement").field).toBe(
      "configSchema.showIf",
    );
  });

  it("le manifeste public conserve les conditions : le formulaire du web en dépend", () => {
    const schema = objectSchema({
      authMode: mode,
      clientSecret: { type: "string", showIf: { field: "authMode", equals: "client-credentials" } },
    });
    const result = validateManifest(manifestWithSchema(schema, ["clientSecret"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = publicManifest(result.manifest).configSchema.properties ?? {};
    expect(properties.clientSecret?.showIf).toEqual({ field: "authMode", equals: "client-credentials" });
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

  it("refuse une action DÉCRITE que le greffon n'implémente pas", () => {
    const plugin = validPlugin();
    const manifest = validManifest();
    manifest.permissions = { mutates: true, graphNodeKinds: ["appliance"] };
    manifest.auditLabels = { restart: "Redémarrage de l'appliance" };
    manifest.actions = { restart: { severity: "caution" } };
    plugin.manifest = manifest;

    expect(issueWithCode(validatePlugin(plugin), "actions.notImplemented").message).toContain("restart");

    plugin.actions = { restart: async () => undefined };
    expect(validatePlugin(plugin).ok).toBe(true);
  });
});

/**
 * DESCRIPTION d'une action (contrat 1.1) : ce que le socle valide À L'ENREGISTREMENT — l'entrée,
 * le danger, la confirmation et le rattachement au graphe. Un greffon dont la description est
 * fausse est refusé en bloc, jamais chargé pour se révéler inutilisable au premier clic droit.
 */
describe("contrat : description des actions", () => {
  /** Manifeste MUTANT prêt à recevoir une description d'action. */
  function mutantManifest(actions: Record<string, unknown>): Record<string, unknown> {
    return {
      ...validManifest(),
      permissions: { network: [], mutates: true, graphNodeKinds: ["appliance-vm"] },
      auditLabels: { "vm.stop": "Arrêt d'une VM" },
      actions,
    };
  }

  const target = { nodeKind: "appliance-vm", field: "uuid", menuLabel: "Arrêter" };

  it("accepte une description complète et la conserve dans le manifeste validé", () => {
    const result = validateManifest(
      mutantManifest({
        "vm.stop": {
          severity: "destructive",
          confirm: { title: "Arrêter la VM", message: `Arrêter "{cible}" ?`, confirmLabel: "Arrêter", retype: true },
          input: {
            type: "object",
            properties: { sizeMib: { type: "number", title: "Taille (Mio)", minimum: 1024, maximum: 2048 } },
            required: ["sizeMib"],
          },
          target: { ...target, when: [{ field: "status", equals: ["running"] }] },
        },
      }),
    );

    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;
    const spec = result.manifest.actions?.["vm.stop"];
    expect(spec?.severity).toBe("destructive");
    expect(spec?.confirm?.retype).toBe(true);
    expect(spec?.target?.when).toEqual([{ field: "status", equals: ["running"] }]);
    // Le manifeste PUBLIC la transporte en entier : l'interface en déduit menu et formulaire.
    expect(publicManifest(result.manifest).actions?.["vm.stop"]?.input).toEqual(spec?.input);
  });

  it("refuse une description d'action sur un greffon en lecture seule", () => {
    const manifest = mutantManifest({ "vm.stop": { target } });
    manifest.permissions = { network: [], mutates: false, graphNodeKinds: ["appliance-vm"] };
    expect(issueWithCode(validateManifest(manifest), "actions.readOnly").message).toContain("lecture seule");
  });

  it("refuse un niveau de danger inventé", () => {
    const issue = issueWithCode(validateManifest(mutantManifest({ "vm.stop": { severity: "apocalyptique", target } })), "actions.severity");
    expect(issue.message).toContain("apocalyptique");
  });

  it("refuse une entrée hors du sous-ensemble affichable — le MÊME que configSchema", () => {
    const nested = mutantManifest({
      "vm.stop": { target, input: { type: "object", properties: { guest: { type: "object", properties: {} } } } },
    });
    expect(issueWithCode(validateManifest(nested), "actionInput.notRenderable").field).toBe(
      "actions.vm.stop.input.properties.guest",
    );

    const badLabels = mutantManifest({
      "vm.stop": { target, input: { type: "object", properties: { mode: { type: "string", enum: ["a", "b"], enumLabels: ["A"] } } } },
    });
    expect(issueWithCode(validateManifest(badLabels), "actionInput.enumLabels").message).toContain("1 libellés");
  });

  it("accepte showIf dans une entrée d'action, avec les mêmes règles que configSchema", () => {
    const ok = mutantManifest({
      "vm.stop": {
        target,
        input: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["dur", "gracieux"], enumLabels: ["Dur", "Gracieux"] },
            delaiSecondes: { type: "number", title: "Délai", showIf: { field: "mode", equals: "gracieux" } },
          },
        },
      },
    });
    expect(validateManifest(ok).ok).toBe(true);

    const inconnu = mutantManifest({
      "vm.stop": {
        target,
        input: { type: "object", properties: { delai: { type: "number", showIf: { field: "absent", equals: "x" } } } },
      },
    });
    expect(issueWithCode(validateManifest(inconnu), "actionInput.showIf.unknown").field).toBe(
      "actions.vm.stop.input.properties.delai.showIf.field",
    );
  });

  it("refuse un secret dans l'entrée d'une action : rien ne le chiffre ni ne le caviarde", () => {
    const manifest = mutantManifest({
      "vm.stop": { target, input: { type: "object", properties: { motDePasse: { type: "string", format: "password" } } } },
    });
    expect(issueWithCode(validateManifest(manifest), "actionInput.secret").message).toContain("secret");
  });

  it("refuse un rattachement à un type de nœud que le greffon ne contribue pas", () => {
    const manifest = mutantManifest({ "vm.stop": { target: { ...target, nodeKind: "container" } } });
    expect(issueWithCode(validateManifest(manifest), "actions.target").message).toContain("graphNodeKinds");
  });

  it("refuse que la CIBLE soit aussi un champ à saisir", () => {
    const manifest = mutantManifest({
      "vm.stop": { target, input: { type: "object", properties: { uuid: { type: "string", title: "UUID" } } } },
    });
    expect(issueWithCode(validateManifest(manifest), "actions.target").message).toContain("ne se saisit jamais");
  });

  it("exige qu'un rattachement dise s'il propose une entrée de menu ou ce qui la sert déjà", () => {
    const muet = mutantManifest({ "vm.stop": { target: { nodeKind: "appliance-vm", field: "uuid" } } });
    expect(issueWithCode(validateManifest(muet), "actions.target").message).toContain("servedByCore");

    const double = mutantManifest({ "vm.stop": { target: { ...target, servedByCore: "core-vm-stop" } } });
    expect(issueWithCode(validateManifest(double), "actions.target").message).toContain("deux fois");

    const servi = mutantManifest({ "vm.stop": { target: { nodeKind: "appliance-vm", field: "uuid", servedByCore: "core-vm-stop" } } });
    expect(validateManifest(servi).ok).toBe(true);
  });

  it("refuse une confirmation muette, et une confirmation FORTE sans cible à retaper", () => {
    const muette = mutantManifest({ "vm.stop": { target, confirm: { title: "", message: "", confirmLabel: "" } } });
    expect(issueWithCode(validateManifest(muette), "actions.confirm").message).toContain("non vide");

    const sansCible = mutantManifest({
      "vm.stop": { confirm: { title: "T", message: "M", confirmLabel: "C", retype: true } },
    });
    expect(issueWithCode(validateManifest(sansCible), "actions.confirm").message).toContain("retaper");
  });

  it("refuse une clé inconnue plutôt que de l'ignorer en silence", () => {
    const manifest = mutantManifest({ "vm.stop": { target, dangereux: true } });
    expect(issueWithCode(validateManifest(manifest), "actions.unknownKey").field).toBe("actions.vm.stop.dangereux");
  });

  it("un manifeste sans description d'action reste valide : la description est facultative", () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.actions).toBeUndefined();
  });
});

/** Validation de l'ENTRÉE d'une action contre le schéma déclaré — ce que le socle refuse avant
 * qu'une action MUTANTE ne soit jouée sur une machine réelle. */
describe("contrat : entrée d'une action", () => {
  const schema = {
    type: "object" as const,
    properties: {
      mode: { type: "string" as const, enum: ["gracieux", "dur"], default: "gracieux" },
      delaiSecondes: { type: "number" as const, title: "Délai", minimum: 5, maximum: 600, showIf: { field: "mode", equals: "gracieux" } },
      force: { type: "boolean" as const, title: "Forcer" },
    },
    required: ["mode"],
  };

  it("retient les valeurs valides et applique les valeurs par défaut déclarées", () => {
    const result = validateActionInput(schema, { delaiSecondes: 30, force: true });
    expect(result).toEqual({ ok: true, input: { mode: "gracieux", delaiSecondes: 30, force: true } });
  });

  it("écarte un champ masqué par sa condition, comme le ferait le formulaire", () => {
    const result = validateActionInput(schema, { mode: "dur", delaiSecondes: 30 });
    expect(result).toEqual({ ok: true, input: { mode: "dur" } });
  });

  it("refuse un champ inconnu, un type faux, une valeur hors bornes et un choix hors énumération", () => {
    for (const [candidate, expected] of [
      [{ ailleurs: 1 }, "ailleurs"],
      [{ delaiSecondes: "trente" }, "Délai"],
      [{ delaiSecondes: 1 }, "minimum 5"],
      [{ delaiSecondes: 900 }, "maximum 600"],
      [{ mode: "brutal" }, "hors des choix"],
    ] as Array<[Record<string, unknown>, string]>) {
      const result = validateActionInput(schema, candidate);
      expect(result.ok, JSON.stringify(candidate)).toBe(false);
      if (result.ok) continue;
      expect(result.issues.map((issue) => issue.message).join(" ; "), JSON.stringify(candidate)).toContain(expected);
    }
  });

  it("refuse un champ obligatoire laissé vide, jamais complété d'office", () => {
    const strict = { type: "object" as const, properties: { nom: { type: "string" as const, title: "Nom" } }, required: ["nom"] };
    for (const candidate of [{}, { nom: "" }, undefined]) {
      const result = validateActionInput(strict, candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.message).toContain("Nom est obligatoire");
    }
  });

  it("une action sans entrée déclarée ne retient rien", () => {
    expect(validateActionInput(undefined, { quoiQueCeSoit: 1 })).toEqual({ ok: true, input: {} });
    expect(validateActionInput({ type: "object", properties: {} }, {}).ok).toBe(true);
  });
});

describe("registre de greffons", () => {
  it("n'enregistre au démarrage que les greffons réels (le greffon d'exemple n'en est pas un)", async () => {
    app = buildServer();
    // Le chargement des greffons ACTIFS est asynchrone (onReady, voir plugins/loader.ts) : aucun
    // module de greffon n'est importé avant que le serveur ne soit prêt.
    await app.ready();
    // Seules les intégrations RÉELLEMENT migrées (plugins/builtins.ts) sont enregistrées.
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
    expect(getPlugin("example")).toBeUndefined();
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

  it("n'expose que les greffons réellement enregistrés, jamais une liste d'exemples", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { plugins: Array<{ manifest: { id: string }; enabled: boolean; configured: boolean }> };
    expect(body.plugins.map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
    // Rien n'est configuré dans ce CONFIG_PATH isolé — mais rien n'a été mis en pause non plus :
    // `enabled` reste vrai, seule une désactivation explicite le fait tomber.
    expect(body.plugins.every((plugin) => plugin.configured === false && plugin.enabled === true)).toBe(true);
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
    const entry = body.plugins.find((plugin) => (plugin.manifest as { id?: unknown } | undefined)?.id === "example")!;
    expect(entry, "le greffon d'exemple enregistré à la main doit être exposé").toBeDefined();
    // L'enveloppe porte l'état, le manifeste ne porte QUE la forme de la configuration.
    expect(Object.keys(entry).sort()).toEqual(["configured", "enabled", "manifest"]);
    const manifest = entry.manifest as Record<string, unknown>;
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
