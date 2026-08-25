import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Greffon 3CX : manifeste, permissions et instantané. AUCUN test ici ne contacte le PBX — seules
 * les branches qui refusent AVANT toute requête réseau sont exercées (URL absente ou invalide,
 * identifiants manquants, aucune configuration stockée). Le comportement réseau réel est couvert
 * par threecx.test.ts, mocké de bout en bout.
 */
const tmpDir = path.join(os.tmpdir(), `quai-3cx-plugin-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "5".repeat(64);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { resetPluginRegistryForTests, registerPlugin, listPlugins } = await import("../src/plugins/registry.js");
const { BUILTIN_PLUGINS } = await import("../src/plugins/builtins.js");
const { threecxPlugin } = await import("../src/plugins/threecx/index.js");
const { removeThreecxPluginConfig, THREECX_PLUGIN_ID, THREECX_SECRET_FIELDS } = await import("../src/plugins/threecx/config.js");
const { validatePlugin, publicManifest } = await import("@quai/plugin-contract");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
  await removeThreecxPluginConfig();
});

function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

const manifest = threecxPlugin.manifest;

describe("Greffon 3CX — manifeste", () => {
  it("est accepté par le contrat, tel qu'il est enregistré au démarrage", () => {
    const result = validatePlugin(threecxPlugin);
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    expect(manifest.id).toBe("3cx");
    expect(manifest.name).toBe("Téléphonie 3CX");
    expect(() => registerPlugin(threecxPlugin)).not.toThrow();
  });

  it("est réellement branché dans les greffons du socle", () => {
    // D'autres intégrations ont été migrées depuis : la liste reste EXACTE, jamais un « contient 3cx ».
    expect(BUILTIN_PLUGINS.map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
    app = buildServer();
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
  });

  it("décrit le formulaire réel : mêmes champs, même bascule de mode, mêmes valeurs par défaut", () => {
    const properties = manifest.configSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual([
      "baseUrl",
      "authMode",
      "clientId",
      "clientSecret",
      "username",
      "password",
      "tlsRejectUnauthorized",
    ]);
    expect(manifest.configSchema.required).toEqual(["baseUrl", "clientId", "clientSecret", "username", "password"]);

    expect(properties.authMode).toMatchObject({
      type: "string",
      enum: ["client-credentials", "user"],
      default: "client-credentials",
    });
    expect(properties.authMode?.enumLabels).toHaveLength(2);
    // Les identifiants de chaque mode ne sont demandés que dans ce mode.
    expect(properties.clientId?.showIf).toEqual({ field: "authMode", equals: "client-credentials" });
    expect(properties.clientSecret?.showIf).toEqual({ field: "authMode", equals: "client-credentials" });
    expect(properties.username?.showIf).toEqual({ field: "authMode", equals: "user" });
    expect(properties.password?.showIf).toEqual({ field: "authMode", equals: "user" });
    expect(properties.tlsRejectUnauthorized).toMatchObject({ type: "boolean", default: true });
  });

  it("déclare comme secrets EXACTEMENT les champs chiffrés au repos", () => {
    expect(manifest.secretFields).toEqual(["clientSecret", "password"]);
    // La même liste pilote le chiffrement dans le stockage générique : elles ne peuvent pas diverger.
    expect(manifest.secretFields).toEqual(THREECX_SECRET_FIELDS);
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

  it("est en LECTURE SEULE stricte : aucune action, aucune mutation, aucun nœud de graphe", () => {
    expect(manifest.permissions.mutates).toBe(false);
    expect(manifest.permissions.graphNodeKinds).toBeUndefined();
    expect(threecxPlugin.actions).toBeUndefined();
    expect(threecxPlugin.graph).toBeUndefined();
    // Aucune action exposée, donc rien à tracer : un libellé d'audit ici serait inventé.
    expect(manifest.auditLabels).toEqual({});
  });
});

describe("Greffon 3CX — GET /api/plugins", () => {
  it("expose le manifeste public du greffon, sans la moindre valeur de configuration", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { plugins: Array<Record<string, unknown>> };
    const exposed = body.plugins.find((plugin) => plugin.id === THREECX_PLUGIN_ID);
    expect(exposed).toBeDefined();
    expect(exposed?.secretFields).toEqual(["clientSecret", "password"]);
    expect(exposed?.permissions).toMatchObject({ mutates: false });

    // Les conditions d'affichage doivent survivre : le formulaire du web en dépend.
    const properties = (exposed?.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.username?.showIf).toEqual({ field: "authMode", equals: "user" });
    for (const field of ["clientSecret", "password"]) {
      expect(properties[field]?.default, field).toBeUndefined();
      expect(properties[field]?.examples, field).toBeUndefined();
    }
  });
});

describe("Greffon 3CX — test() honnête, sans jamais contacter le PBX à l'aveugle", () => {
  it("refuse une configuration sans URL", async () => {
    await expect(threecxPlugin.test({})).resolves.toEqual({ ok: false, message: "L'URL du PBX est requise" });
    await expect(threecxPlugin.test(undefined)).resolves.toEqual({ ok: false, message: "L'URL du PBX est requise" });
  });

  it("refuse une configuration dont les identifiants du mode choisi manquent", async () => {
    await expect(threecxPlugin.test({ baseUrl: "https://pbx.exemple.fr:5001" })).resolves.toEqual({
      ok: false,
      message: "baseUrl, clientId et clientSecret sont requis",
    });
    await expect(
      threecxPlugin.test({ baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900" }),
    ).resolves.toEqual({ ok: false, message: "baseUrl, identifiant et mot de passe sont requis" });
  });

  it("refuse une URL qui n'en est pas une, sans rien inventer", async () => {
    const result = await threecxPlugin.test({
      baseUrl: "pas-une-url",
      authMode: "client-credentials",
      clientId: "quai-xapi",
      clientSecret: "cle",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("URL du PBX invalide");
  });

  it("ne renvoie jamais le secret qu'on lui a passé", async () => {
    const secret = "cle-api-3cx-tres-secrete";
    const result = await threecxPlugin.test({ baseUrl: "ftp://pbx.exemple.fr", authMode: "client-credentials", clientId: "x", clientSecret: secret });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(secret);
  });
});

describe("Greffon 3CX — snapshot()", () => {
  it("configuration inutilisable : not-configured, jamais des listes vides silencieuses", async () => {
    for (const candidate of [undefined, {}, { baseUrl: "https://pbx.exemple.fr:5001" }]) {
      const snapshot = await threecxPlugin.snapshot(candidate);
      expect(snapshot.moduleId).toBe("3cx");
      expect(snapshot.status).toBe("not-configured");
      expect(snapshot.message).toContain("non configurée");
      expect(snapshot.summary).toEqual([]);
      expect(snapshot.entities).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
    }
  });

  it("aucune configuration stockée : le module rapporte not-configured plutôt que des données vides", async () => {
    const snapshot = await threecxPlugin.snapshot({
      baseUrl: "https://pbx.exemple.fr:5001",
      authMode: "client-credentials",
      clientId: "quai-xapi",
      clientSecret: "cle",
    });
    expect(snapshot).toMatchObject({ moduleId: "3cx", status: "not-configured", summary: [], entities: [], relations: [] });
  });
});
