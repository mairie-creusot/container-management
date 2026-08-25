import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Greffon GLPI : manifeste, actions MUTANTES déclarées et auditées, reprise de la configuration du
 * champ typé, instantané. AUCUN test ne touche le GLPI de la mairie — `fetch` est mocké de bout en
 * bout (même montage que glpi.test.ts), et les branches qui refusent avant toute requête réseau le
 * prouvent en vérifiant que `fetch` n'a jamais été appelé.
 *
 * Formes mockées : doc officielle glpi-project/glpi/apirest.md — `/initSession` -> { session_token },
 * `/search/Ticket` -> { totalcount, data }, `POST /Ticket` -> 201 { id }, `PUT /Ticket/:id` ->
 * [{ "<id>": true }], erreurs -> ["ERROR_CODE", "message"].
 */
const tmpDir = path.join(os.tmpdir(), `quai-glpi-plugin-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "6".repeat(64);

const API_URL = "http://glpi.test/apirest.php";
const APP_TOKEN = "APP-TOKEN-GREFFON-0123456789";
const USER_TOKEN = "USER-TOKEN-GREFFON-9876543210";
const SERVICE_PASSWORD = "MotDePasseDeService-greffon";
const SESSION_TOKEN = "0123456789abcdef0123456789abcdef01234567";

interface MockResponse {
  status: number;
  body: unknown;
}

interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

const responses = new Map<string, MockResponse>();
const calls: RecordedCall[] = [];
/** GLPI injoignable : `fetch` lui-même échoue, comme une résolution DNS ratée. */
let networkDown = false;

function reply(key: string, body: unknown, status = 200): void {
  responses.set(key, { status, body });
}

const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  const parsed = new URL(url);
  const relative = parsed.pathname.replace(/^\/apirest\.php\/?/, "");
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({
    method,
    path: relative,
    search: parsed.search,
    body: typeof init.body === "string" ? JSON.parse(init.body) : null,
  });
  if (networkDown) throw new Error("getaddrinfo ENOTFOUND glpi.test");
  const found = responses.get(`${method} ${relative}`) ?? { status: 200, body: {} };
  return new Response(found.body === null ? "" : JSON.stringify(found.body), { status: found.status });
});
vi.stubGlobal("fetch", fetchMock);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { listPlugins, registerPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { BUILTIN_PLUGINS } = await import("../src/plugins/builtins.js");
const { glpiPlugin } = await import("../src/plugins/glpi/index.js");
const { GLPI_PLUGIN_ID, GLPI_SECRET_FIELDS, loadGlpiPluginConfig, removeGlpiPluginConfig, saveGlpiPluginConfig } =
  await import("../src/plugins/glpi/config.js");
const { getCurrent, getEffectiveGlpiConfig, getSafeIntegrationConfig, setGlpiConfig } = await import(
  "../src/services/setupStore.js"
);
const { releaseGlpiSession } = await import("../src/services/glpi.js");
const { publicManifest, validatePlugin } = await import("@quai/plugin-contract");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  calls.length = 0;
  responses.clear();
  networkDown = false;
  fetchMock.mockClear();
  reply("GET initSession", { session_token: SESSION_TOKEN });
  reply("GET killSession", null);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  networkDown = false;
  resetPluginRegistryForTests();
  await releaseGlpiSession();
  await removeGlpiPluginConfig();
});

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}
function viewerCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] }) };
}

const manifest = glpiPlugin.manifest;
const actions: Record<string, (input: unknown) => Promise<unknown>> = glpiPlugin.actions ?? {};

function run(name: string, input: unknown): Promise<unknown> {
  const action = actions[name];
  if (!action) throw new Error(`Le greffon GLPI n'expose pas l'action "${name}"`);
  return action(input);
}

async function seedUserTokenConfig(): Promise<void> {
  await saveGlpiPluginConfig({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
}

/** Configuration écrite AVANT la migration, dans le champ typé `glpi` de setupStore. */
async function seedLegacyConfig(): Promise<void> {
  await setGlpiConfig({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
}

describe("Greffon GLPI — manifeste", () => {
  it("est accepté par le contrat, tel qu'il est enregistré au démarrage", () => {
    const result = validatePlugin(glpiPlugin);
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    expect(manifest.id).toBe("glpi");
    expect(manifest.name).toBe("Assistance GLPI");
    expect(() => registerPlugin(glpiPlugin)).not.toThrow();
  });

  it("est réellement branché dans les greffons du socle", () => {
    expect(BUILTIN_PLUGINS.map((plugin) => plugin.manifest.id)).toContain(GLPI_PLUGIN_ID);
    app = buildServer();
    expect(listPlugins().map((plugin) => plugin.manifest.id)).toContain(GLPI_PLUGIN_ID);
  });

  it("décrit le formulaire réel de GlpiConfigSection : mêmes champs, même bascule de mode", () => {
    const properties = manifest.configSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual(["apiUrl", "appToken", "authMode", "userToken", "username", "password"]);
    expect(manifest.configSchema.required).toEqual(["apiUrl", "appToken", "userToken", "username", "password"]);

    // L'URL doit contenir apirest.php : sans lui GLPI répond 403 (constaté sur l'instance réelle).
    expect(String(properties.apiUrl?.examples?.[0])).toContain("apirest.php");
    expect(properties.apiUrl?.description).toContain("apirest.php");

    expect(properties.authMode).toMatchObject({ type: "string", enum: ["user-token", "credentials"], default: "user-token" });
    // Le cas qui avait motivé enumLabels : le mode d'authentification s'affiche en clair.
    expect(properties.authMode?.enumLabels).toEqual([
      "Jeton utilisateur (user_token)",
      "Compte de service (login et mot de passe)",
    ]);

    // Les identifiants de chaque mode ne sont demandés que dans ce mode.
    expect(properties.userToken?.showIf).toEqual({ field: "authMode", equals: "user-token" });
    expect(properties.username?.showIf).toEqual({ field: "authMode", equals: "credentials" });
    expect(properties.password?.showIf).toEqual({ field: "authMode", equals: "credentials" });
    // L'app_token ne dépend d'aucun mode : il est toujours requis.
    expect(properties.appToken?.showIf).toBeUndefined();
  });

  it("déclare comme secrets EXACTEMENT les champs chiffrés au repos", () => {
    expect(manifest.secretFields).toEqual(["appToken", "userToken", "password"]);
    // La même liste pilote le chiffrement dans le stockage générique : elles ne peuvent pas diverger.
    expect(manifest.secretFields).toEqual(GLPI_SECRET_FIELDS);
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

  it("n'exige aucun hôte : le GLPI joint est celui saisi par l'admin", () => {
    // Le contrat ne sait pas désigner l'hôte porté par un champ de configuration : la liste reste
    // vide plutôt que d'y inscrire un hôte inventé.
    expect(manifest.permissions.network).toEqual([]);
    expect(manifest.permissions.graphNodeKinds).toBeUndefined();
    expect(glpiPlugin.graph).toBeUndefined();
  });
});

describe("Greffon GLPI — intégration MUTANTE : actions déclarées et auditées", () => {
  it("déclare permissions.mutates et expose les mutations réellement implémentées", () => {
    expect(manifest.permissions.mutates).toBe(true);
    expect(Object.keys(actions).sort()).toEqual([
      "add-followup",
      "create-inventory-computer",
      "create-ticket",
      "report-incident",
      "resolve-incident",
      "resolve-ticket",
      "update-inventory-computer",
    ]);
  });

  it("chaque action porte son libellé d'audit, et aucun libellé n'est orphelin", () => {
    expect(Object.keys(manifest.auditLabels).sort()).toEqual(Object.keys(actions).sort());
    for (const [name, label] of Object.entries(manifest.auditLabels)) {
      expect(label.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("le socle refuse ces mêmes actions sans mutates ni libellé — c'est ce qui rend la lecture seule structurelle", () => {
    const readOnly = { ...glpiPlugin, manifest: { ...manifest, permissions: { ...manifest.permissions, mutates: false } } };
    const refus = validatePlugin(readOnly);
    expect(refus.ok).toBe(false);
    expect(refus.ok ? [] : refus.issues.map((issue) => issue.code)).toContain("actions.readOnly");

    const { "create-ticket": _retire, ...sansLibelle } = manifest.auditLabels;
    const untraced = { ...glpiPlugin, manifest: { ...manifest, auditLabels: sansLibelle } };
    const refusAudit = validatePlugin(untraced);
    expect(refusAudit.ok).toBe(false);
    expect(refusAudit.ok ? [] : refusAudit.issues.map((issue) => issue.field)).toContain("auditLabels.create-ticket");
  });
});

describe("Greffon GLPI — GET /api/plugins", () => {
  it("expose le manifeste public, sans la moindre valeur de configuration", async () => {
    await seedUserTokenConfig();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { plugins: Array<{ manifest: Record<string, unknown> }> };
    const exposed = body.plugins.find((plugin) => plugin.manifest.id === GLPI_PLUGIN_ID)?.manifest;
    expect(exposed).toBeDefined();
    expect(exposed?.secretFields).toEqual(["appToken", "userToken", "password"]);
    expect(exposed?.permissions).toMatchObject({ mutates: true });
    expect(exposed?.auditLabels).toMatchObject({ "create-ticket": "Création d'un ticket GLPI" });

    // Les conditions d'affichage doivent survivre : le formulaire du web en dépend.
    const properties = (exposed?.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.username?.showIf).toEqual({ field: "authMode", equals: "credentials" });
    expect(response.body).not.toContain(APP_TOKEN);
    expect(response.body).not.toContain(USER_TOKEN);
  });
});

describe("Greffon GLPI — test() honnête", () => {
  it("refuse une configuration sans URL, sans appeler le réseau", async () => {
    await expect(glpiPlugin.test({})).resolves.toEqual({ ok: false, message: "L'URL de l'API GLPI est requise" });
    await expect(glpiPlugin.test(undefined)).resolves.toEqual({ ok: false, message: "L'URL de l'API GLPI est requise" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse une configuration sans app_token ou sans moyen d'authentification, sans appeler le réseau", async () => {
    const attendu = { ok: false, message: "apiUrl, appToken et (userToken OU username+password) sont requis" };
    await expect(glpiPlugin.test({ apiUrl: API_URL })).resolves.toEqual(attendu);
    await expect(glpiPlugin.test({ apiUrl: API_URL, appToken: APP_TOKEN })).resolves.toEqual(attendu);
    await expect(glpiPlugin.test({ apiUrl: API_URL, appToken: APP_TOKEN, username: "svc-quai" })).resolves.toEqual(attendu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ouvre une session RÉELLE puis la referme, et ne renvoie jamais le secret reçu", async () => {
    const result = await glpiPlugin.test({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
    expect(result).toEqual({ ok: true, message: "Connexion GLPI établie (session ouverte puis refermée)" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET initSession", "GET killSession"]);

    reply("GET initSession", ["ERROR_WRONG_APP_TOKEN_PARAMETER", `jeton ${APP_TOKEN} refusé`], 400);
    const refus = await glpiPlugin.test({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
    expect(refus.ok).toBe(false);
    expect(refus.message).not.toContain(APP_TOKEN);
    expect(refus.message).toContain("ERROR_WRONG_APP_TOKEN_PARAMETER");
  });
});

describe("Greffon GLPI — snapshot()", () => {
  it("configuration inutilisable : not-configured, jamais des listes vides silencieuses", async () => {
    for (const candidate of [undefined, {}, { apiUrl: API_URL }, { apiUrl: API_URL, appToken: APP_TOKEN }]) {
      const snapshot = await glpiPlugin.snapshot(candidate);
      expect(snapshot.moduleId).toBe("glpi");
      expect(snapshot.status).toBe("not-configured");
      expect(snapshot.message).toContain("non configurée");
      expect(snapshot.summary).toEqual([]);
      expect(snapshot.entities).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aucune configuration stockée : not-configured plutôt que des données vides", async () => {
    const snapshot = await glpiPlugin.snapshot({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
    expect(snapshot).toMatchObject({ moduleId: "glpi", status: "not-configured", summary: [], entities: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GLPI répond : ready, avec le total RÉEL de tickets ouverts renvoyé par l'instance", async () => {
    await seedUserTokenConfig();
    reply("GET search/Ticket", { totalcount: 7, count: 1, data: { "12": { "2": 12, "1": "Imprimante HS", "12": 2 } } });

    const snapshot = await glpiPlugin.snapshot({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.summary).toEqual([
      { label: "URL de l'API", value: API_URL, tone: "neutral" },
      { label: "Authentification", value: "Jeton utilisateur (user_token)", tone: "neutral" },
      { label: "Tickets ouverts", value: "7", tone: "neutral" },
    ]);
    // Un ticket n'est pas un nœud de topologie : rien n'est inventé sous forme d'entité.
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.relations).toEqual([]);
  });

  it("sans totalcount, la ligne du total disparaît plutôt que d'être estimée", async () => {
    await saveGlpiPluginConfig({ apiUrl: API_URL, appToken: APP_TOKEN, username: "svc-quai", password: SERVICE_PASSWORD });
    reply("GET search/Ticket", { data: {} });

    const snapshot = await glpiPlugin.snapshot({
      apiUrl: API_URL,
      appToken: APP_TOKEN,
      username: "svc-quai",
      password: SERVICE_PASSWORD,
    });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.summary).toEqual([
      { label: "URL de l'API", value: API_URL, tone: "neutral" },
      { label: "Authentification", value: "Compte de service (login/mot de passe)", tone: "neutral" },
      { label: "Compte de service", value: "svc-quai", tone: "neutral" },
    ]);
  });

  it("distingue accès refusé, erreur de GLPI et injoignabilité — jamais tout écrasé en « injoignable »", async () => {
    await seedUserTokenConfig();
    const candidate = { apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN };

    reply("GET search/Ticket", ["ERROR_RIGHT_MISSING", "droits insuffisants"], 403);
    const denied = await glpiPlugin.snapshot(candidate);
    expect(denied.status).toBe("denied");
    expect(denied.message).toContain("ERROR_RIGHT_MISSING");

    await releaseGlpiSession();
    reply("GET search/Ticket", ["ERROR", "interne"], 500);
    expect((await glpiPlugin.snapshot(candidate)).status).toBe("failed");

    await releaseGlpiSession();
    networkDown = true;
    const unreachable = await glpiPlugin.snapshot(candidate);
    expect(unreachable.status).toBe("unreachable");
    expect(unreachable.message).toContain("injoignable");
  });
});

describe("Greffon GLPI — actions mutantes", () => {
  it("refuse une entrée invalide AVANT tout appel réseau", async () => {
    await seedUserTokenConfig();
    await expect(run("create-ticket", {})).rejects.toThrow(/"title" est requis/);
    await expect(run("create-ticket", "un texte")).rejects.toThrow(/objet d'entrée est requis/);
    await expect(run("add-followup", { ticketId: 12 })).rejects.toThrow(/"content" est requis/);
    await expect(run("resolve-ticket", { ticketId: "douze" })).rejects.toThrow(/identifiant entier positif/);
    await expect(run("report-incident", { resource: "srv-01" })).rejects.toThrow(/"alertType" est requis/);
    await expect(run("update-inventory-computer", { computerId: 3 })).rejects.toThrow(/"resourceId" est requis/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("créer un ticket délègue au service : POST /Ticket avec les seuls champs autorisés", async () => {
    await seedUserTokenConfig();
    reply("POST Ticket", { id: 42 }, 201);

    await expect(run("create-ticket", { title: "Imprimante HS", content: "Bourrage papier" })).resolves.toEqual({
      ticketId: 42,
    });
    const post = calls.find((call) => call.method === "POST" && call.path === "Ticket");
    expect(post?.body).toEqual({ input: { name: "Imprimante HS", content: "Bourrage papier" } });
  });

  it("résoudre un ticket n'écrit QUE le statut résolu (5), jamais un autre champ", async () => {
    await seedUserTokenConfig();
    reply("PUT Ticket/42", [{ "42": true, message: "" }]);

    await expect(run("resolve-ticket", { ticketId: 42 })).resolves.toEqual({ ticketId: 42, status: "solved" });
    const put = calls.find((call) => call.method === "PUT" && call.path === "Ticket/42");
    expect(put?.body).toEqual({ input: { id: 42, status: 5 } });
  });

});

describe("Greffon GLPI — reprise de la configuration déjà enregistrée dans le champ typé", () => {
  it("une config écrite avant le greffon est reprise telle quelle, sans rien ressaisir", async () => {
    await seedLegacyConfig();
    expect((await getCurrent()).glpi).toBeDefined();

    await expect(loadGlpiPluginConfig()).resolves.toMatchObject({
      apiUrl: API_URL,
      appToken: APP_TOKEN,
      userToken: USER_TOKEN,
    });
  });

  it("le champ typé est RETIRÉ une fois repris — plus aucune config de secours sur disque", async () => {
    await seedLegacyConfig();
    await loadGlpiPluginConfig();

    expect((await getCurrent()).glpi).toBeUndefined();
    expect(await getEffectiveGlpiConfig()).toBeNull();
    expect(await loadGlpiPluginConfig()).toMatchObject({ apiUrl: API_URL, userToken: USER_TOKEN });
  });

  it("le secret repris est chiffré au repos et ne ressort jamais de la vue sûre", async () => {
    await seedLegacyConfig();
    await loadGlpiPluginConfig();

    const entry = (await getCurrent()).integrations?.[GLPI_PLUGIN_ID];
    expect(entry?.secretFields).toEqual(["appToken", "userToken", "password"]);
    const stored = entry?.config.userToken;
    expect(typeof stored).toBe("string");
    expect(stored).not.toBe(USER_TOKEN);
    expect(String(stored).startsWith("enc:v1:")).toBe(true);
    // Le mode est explicité à la reprise, toujours déduit du jeton réellement enregistré.
    expect(entry?.config.authMode).toBe("user-token");

    const safe = await getSafeIntegrationConfig(GLPI_PLUGIN_ID);
    expect(safe?.config).toMatchObject({ apiUrl: API_URL, hasUserToken: true, hasAppToken: true });
    expect(JSON.stringify(safe)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(safe)).not.toContain(APP_TOKEN);
  });

  // Le champ typé ne réapparaît que si l'assistant vient de le réécrire : sa saisie est la plus
  // récente et l'emporte, faute de quoi des identifiants tout juste saisis seraient perdus.
  it("un champ typé réécrit après coup l'emporte, puis est retiré", async () => {
    await saveGlpiPluginConfig({ apiUrl: API_URL, appToken: APP_TOKEN, userToken: USER_TOKEN });
    await setGlpiConfig({ apiUrl: "http://nouveau-glpi.test/apirest.php", appToken: "nouvel-app-token", userToken: "nouveau-jeton" });

    await expect(loadGlpiPluginConfig()).resolves.toMatchObject({
      apiUrl: "http://nouveau-glpi.test/apirest.php",
      userToken: "nouveau-jeton",
    });
    expect((await getCurrent()).glpi).toBeUndefined();
  });

  it("retirer la configuration depuis l'interface ne fait pas ressusciter le champ typé", async () => {
    await seedLegacyConfig();
    app = buildServer();

    const del = await app.inject({ method: "DELETE", url: "/api/glpi/config", cookies: adminCookie() });
    expect(del.json()).toEqual({ ok: true });

    const cfg = await app.inject({ method: "GET", url: "/api/glpi/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
    expect((await getCurrent()).glpi).toBeUndefined();
    expect(await loadGlpiPluginConfig()).toBeNull();
  });

  it("PUT écrit dans le stockage générique, efface le champ typé et conserve les secrets non ressaisis", async () => {
    await seedLegacyConfig();
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/glpi/config",
      cookies: adminCookie(),
      payload: { apiUrl: "http://glpi2.test/apirest.php" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      config: { apiUrl: "http://glpi2.test/apirest.php", authMode: "user-token", hasAppToken: true, hasUserToken: true },
    });
    expect((await getCurrent()).glpi).toBeUndefined();
    expect(await loadGlpiPluginConfig()).toMatchObject({
      apiUrl: "http://glpi2.test/apirest.php",
      appToken: APP_TOKEN,
      userToken: USER_TOKEN,
    });
  });

  it("GET /api/glpi/config lit la config du greffon et ne renvoie jamais un secret", async () => {
    await seedUserTokenConfig();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/glpi/config", cookies: adminCookie() });
    expect(response.json()).toEqual({
      configured: true,
      config: { apiUrl: API_URL, authMode: "user-token", hasAppToken: true, hasUserToken: true, hasPassword: false },
    });
    expect(response.body).not.toContain(APP_TOKEN);
    expect(response.body).not.toContain(USER_TOKEN);
  });
});
