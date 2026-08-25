import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Routes GÉNÉRIQUES de configuration des greffons (routes/plugins.ts). Deux greffons de natures
 * opposées y passent en entier : HYCU (lecture seule) et GLPI (mutant). AUCUN test ne contacte quoi
 * que ce soit — seules les fonctions de test de connexion des services sont mockées, le reste
 * (stockage, chiffrement, fusion, activation) est le code réel.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-config-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "5".repeat(64);

interface ConnectionResult {
  ok: boolean;
  message: string;
}

type HycuService = typeof import("../src/services/hycu.js");
type GlpiService = typeof import("../src/services/glpi.js");
type NutanixService = typeof import("../src/services/nutanix.js");
type ThreecxService = typeof import("../src/services/threecx.js");

const testHycuConnectionMock = vi.fn<[string, string, string], Promise<ConnectionResult>>();
const getHycuTopologySnapshotMock = vi.fn<[], Promise<import("../src/services/hycu.js").HycuTopologySnapshot | null>>();
const testGlpiConnectionMock = vi.fn<[unknown], Promise<ConnectionResult>>();
const testNutanixConnectionMock = vi.fn<[string, string, string], Promise<ConnectionResult>>();
const testThreecxConnectionMock = vi.fn<[unknown], Promise<ConnectionResult>>();

vi.mock("../src/services/hycu.js", async (importOriginal) => {
  const actual = await importOriginal<HycuService>();
  return {
    ...actual,
    testHycuConnection: (url: string, username: string, password: string) =>
      testHycuConnectionMock(url, username, password),
    getHycuTopologySnapshot: () => getHycuTopologySnapshotMock(),
    lastKnownHycuPoll: () => null,
  };
});

vi.mock("../src/services/glpi.js", async (importOriginal) => {
  const actual = await importOriginal<GlpiService>();
  return { ...actual, testGlpiConnection: (candidate: unknown) => testGlpiConnectionMock(candidate) };
});

vi.mock("../src/services/nutanix.js", async (importOriginal) => {
  const actual = await importOriginal<NutanixService>();
  return {
    ...actual,
    testNutanixConnection: (url: string, username: string, password: string) =>
      testNutanixConnectionMock(url, username, password),
  };
});

vi.mock("../src/services/threecx.js", async (importOriginal) => {
  const actual = await importOriginal<ThreecxService>();
  return { ...actual, testThreecxConnection: (candidate: unknown) => testThreecxConnectionMock(candidate) };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { getCurrent, setHycuConfig } = await import("../src/services/setupStore.js");
const { isPluginDisabled } = await import("../src/plugins/activation.js");
const { resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { loadHycuPluginConfig, removeHycuPluginConfig, saveHycuPluginConfig } = await import(
  "../src/plugins/hycu/config.js"
);
const { hycuTopologyParts } = await import("../src/plugins/hycu/graph.js");
const { loadGlpiPluginConfig, removeGlpiPluginConfig, saveGlpiPluginConfig } = await import(
  "../src/plugins/glpi/config.js"
);
const { removeThreecxPluginConfig, saveThreecxPluginConfig } = await import("../src/plugins/threecx/config.js");
const { removeNutanixPluginConfig, saveNutanixPluginConfig } = await import("../src/plugins/nutanix/config.js");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const HYCU_URL = "https://172.20.0.100:8443";
const HYCU_USER = "quai-ro";
const HYCU_PASSWORD = "MotDePasseHycu-tres-secret-0123";
const GLPI_URL = "http://glpi.test/apirest.php";
const GLPI_APP_TOKEN = "APP-TOKEN-GENERIQUE-0123456789";
const GLPI_USER_TOKEN = "USER-TOKEN-GENERIQUE-9876543210";
const THREECX_URL = "https://pbx.test:5001";
const THREECX_SECRET = "CleApi3CX-tres-secrete-0123456789";
const NUTANIX_URL = "https://prism.test:9440";
const NUTANIX_PASSWORD = "MotDePasseNutanix-tres-secret-0123";

const ALL_SECRETS = [HYCU_PASSWORD, GLPI_APP_TOKEN, GLPI_USER_TOKEN, THREECX_SECRET, NUTANIX_PASSWORD];

let app: FastifyInstance | undefined;

beforeEach(() => {
  testHycuConnectionMock.mockReset();
  testHycuConnectionMock.mockResolvedValue({ ok: true, message: "Connexion réussie (12 VMs)" });
  getHycuTopologySnapshotMock.mockReset();
  getHycuTopologySnapshotMock.mockResolvedValue(null);
  testGlpiConnectionMock.mockReset();
  testGlpiConnectionMock.mockResolvedValue({ ok: true, message: "Connexion GLPI réussie" });
  testNutanixConnectionMock.mockReset();
  testNutanixConnectionMock.mockResolvedValue({ ok: true, message: "Connexion Prism Central réussie" });
  testThreecxConnectionMock.mockReset();
  testThreecxConnectionMock.mockResolvedValue({ ok: true, message: "Connexion 3CX réussie" });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
  await removeHycuPluginConfig();
  await removeGlpiPluginConfig();
  await removeThreecxPluginConfig();
  await removeNutanixPluginConfig();
});

function cookieFor(roles: Array<"admin" | "operator" | "viewer">) {
  const token = signSessionToken({ username: "demo", displayName: "Demo", roles });
  return { [config.session.cookieName]: token };
}

const adminCookie = () => cookieFor(["admin"]);
const viewerCookie = () => cookieFor(["viewer"]);

interface PluginStateBody {
  configured: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface PluginListBody {
  plugins: Array<{ manifest: { id: string; secretFields: string[] }; enabled: boolean; configured: boolean }>;
}

async function seedHycu(): Promise<void> {
  await saveHycuPluginConfig({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
}

async function seedGlpi(): Promise<void> {
  await saveGlpiPluginConfig({ apiUrl: GLPI_URL, appToken: GLPI_APP_TOKEN, userToken: GLPI_USER_TOKEN });
}

async function seedThreecx(): Promise<void> {
  await saveThreecxPluginConfig({
    baseUrl: THREECX_URL,
    authMode: "client-credentials",
    clientId: "quai-routing-point",
    clientSecret: THREECX_SECRET,
  });
}

async function seedNutanix(): Promise<void> {
  await saveNutanixPluginConfig({ prismCentralUrl: NUTANIX_URL, username: "quai", password: NUTANIX_PASSWORD });
}

/** Chaque secret enregistré doit être absent de la charge utile, en clair comme sous toute forme. */
function expectNoSecret(payload: string): void {
  for (const secret of ALL_SECRETS) expect(payload).not.toContain(secret);
}

describe("GET /api/plugins — manifeste public + état réel", () => {
  it("exige une session, et reste ouvert à tout rôle authentifié", async () => {
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/api/plugins" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() })).statusCode).toBe(200);
  });

  it("dit lesquels sont configurés et actifs, sans jamais transporter une valeur de configuration", async () => {
    await seedHycu();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/plugins", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as PluginListBody;

    expect(body.plugins.map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
    const hycu = body.plugins.find((plugin) => plugin.manifest.id === "hycu");
    expect(hycu).toMatchObject({ configured: true, enabled: true });
    expect(hycu?.manifest.secretFields).toEqual(["password"]);
    // Jamais configuré n'est PAS « mis en pause » : l'interface doit continuer d'afficher la page du
    // greffon pour qu'on puisse justement le configurer.
    expect(body.plugins.find((plugin) => plugin.manifest.id === "glpi")).toMatchObject({
      configured: false,
      enabled: true,
    });
    expectNoSecret(response.payload);
    expect(response.payload).not.toContain(HYCU_USER);
  });
});

describe("GET /api/plugins/:id/config — vue sûre", () => {
  it("greffon jamais configuré : configuration vide, mais actif (rien n'a été mis en pause)", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins/hycu/config", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, enabled: true, config: {} });
    expect(await isPluginDisabled("hycu")).toBe(false);
  });

  it("404 pour un identifiant inconnu", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/plugins/inexistant/config", cookies: viewerCookie() });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toContain("inexistant");
  });

  /** Règle n°1 du socle : un secret enregistré ne ressort jamais, pour AUCUN greffon. */
  it("aucun secret ne sort — les quatre greffons, chacun avec ses champs déclarés", async () => {
    await seedThreecx();
    await seedGlpi();
    await seedHycu();
    await seedNutanix();
    app = buildServer();

    const expected: Array<{ id: string; secretFields: string[]; visible: Record<string, unknown> }> = [
      {
        id: "3cx",
        secretFields: ["clientSecret", "password"],
        visible: { baseUrl: THREECX_URL, authMode: "client-credentials", clientId: "quai-routing-point" },
      },
      {
        id: "glpi",
        secretFields: ["appToken", "userToken", "password"],
        visible: { apiUrl: GLPI_URL, authMode: "user-token" },
      },
      { id: "hycu", secretFields: ["password"], visible: { url: HYCU_URL, username: HYCU_USER } },
      { id: "nutanix", secretFields: ["password"], visible: { prismCentralUrl: NUTANIX_URL, username: "quai" } },
    ];

    for (const { id, secretFields, visible } of expected) {
      const response = await app.inject({ method: "GET", url: `/api/plugins/${id}/config`, cookies: viewerCookie() });
      expect(response.statusCode, id).toBe(200);
      const body = response.json() as PluginStateBody;

      expect(body, id).toMatchObject({ configured: true, enabled: true });
      expect(body.config, id).toMatchObject(visible);
      for (const field of secretFields) {
        // Le champ secret a disparu, remplacé À SA PLACE par un booléen de présence.
        expect(body.config[field], `${id}.${field}`).toBeUndefined();
        const flag = `has${field.charAt(0).toUpperCase()}${field.slice(1)}`;
        expect(typeof body.config[flag], `${id}.${flag}`).toBe("boolean");
      }
      expectNoSecret(response.payload);
    }

    // Les booléens disent la VÉRITÉ : renseigné vs absent, jamais "true" par principe.
    const glpi = (await app.inject({ method: "GET", url: "/api/plugins/glpi/config", cookies: viewerCookie() }))
      .json() as PluginStateBody;
    expect(glpi.config.hasAppToken).toBe(true);
    expect(glpi.config.hasUserToken).toBe(true);
    expect(glpi.config.hasPassword).toBe(false);
  });
});

describe("PUT /api/plugins/:id/config — teste avant d'enregistrer", () => {
  it("HYCU (lecture seule) : teste réellement, enregistre, et ne renvoie que la vue sûre", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      enabled: true,
      config: { url: HYCU_URL, username: HYCU_USER, hasPassword: true },
    });
    expectNoSecret(response.payload);
    expect(testHycuConnectionMock).toHaveBeenCalledWith(HYCU_URL, HYCU_USER, HYCU_PASSWORD);
    // Écrit réellement, mot de passe compris (relu par la voie serveur, jamais par une route).
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
  });

  it("GLPI (mutant) : même discipline, jeton conservé et mode d'authentification déduit", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/glpi/config",
      cookies: adminCookie(),
      payload: { config: { apiUrl: GLPI_URL, appToken: GLPI_APP_TOKEN, userToken: GLPI_USER_TOKEN } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as PluginStateBody;
    expect(body).toMatchObject({ configured: true, enabled: true });
    expect(body.config).toEqual({
      apiUrl: GLPI_URL,
      authMode: "user-token",
      hasAppToken: true,
      hasUserToken: true,
      hasPassword: false,
    });
    expectNoSecret(response.payload);
    expect(testGlpiConnectionMock).toHaveBeenCalledTimes(1);
    expect(await loadGlpiPluginConfig()).toEqual({
      apiUrl: GLPI_URL,
      appToken: GLPI_APP_TOKEN,
      userToken: GLPI_USER_TOKEN,
    });
  });

  it("accepte aussi un corps qui porte directement les champs du formulaire", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(await loadHycuPluginConfig()).toMatchObject({ password: HYCU_PASSWORD });
  });

  it("champ secret vide = l'existant est CONSERVÉ, et c'est lui qui est testé", async () => {
    await seedHycu();
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: "quai-lecture", password: "" } },
    });

    expect(response.statusCode).toBe(200);
    // La connexion a été testée avec le mot de passe DÉJÀ enregistré : la fusion précède le test.
    expect(testHycuConnectionMock).toHaveBeenCalledWith(HYCU_URL, "quai-lecture", HYCU_PASSWORD);
    expect(await loadHycuPluginConfig()).toEqual({
      url: HYCU_URL,
      username: "quai-lecture",
      password: HYCU_PASSWORD,
    });
  });

  it("le booléen de présence renvoyé par l'API ne repart jamais en configuration", async () => {
    await seedHycu();
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      // Exactement ce que GET vient de renvoyer, réémis tel quel par le formulaire.
      payload: { config: { url: HYCU_URL, username: HYCU_USER, hasPassword: true } },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as PluginStateBody).config).toEqual({
      url: HYCU_URL,
      username: HYCU_USER,
      hasPassword: true,
    });
    const stored = (await getCurrent()).integrations?.hycu?.config ?? {};
    expect(stored.hasPassword).toBeUndefined();
  });

  it("test en échec : 400 avec le message du greffon, et RIEN n'est persisté", async () => {
    testHycuConnectionMock.mockResolvedValue({ ok: false, message: "401 Unauthorized — identifiants refusés" });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD } },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("401 Unauthorized — identifiants refusés");
    expect(await loadHycuPluginConfig()).toBeNull();
    expect((await getCurrent()).integrations?.hycu).toBeUndefined();
  });

  it("test en échec sur une configuration DÉJÀ enregistrée : l'ancienne survit intacte", async () => {
    await seedHycu();
    testHycuConnectionMock.mockResolvedValue({ ok: false, message: "Appliance injoignable" });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: "https://mauvaise.url:8443", username: "intrus", password: "autre" } },
    });

    expect(response.statusCode).toBe(400);
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
  });

  it("échappatoire explicite : skipTest enregistre sans contacter quoi que ce soit", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD }, skipTest: true },
    });

    expect(response.statusCode).toBe(200);
    expect(testHycuConnectionMock).not.toHaveBeenCalled();
    expect(await loadHycuPluginConfig()).toMatchObject({ password: HYCU_PASSWORD });
  });

  it("configuration inutilisable : refusée par le greffon, jamais écrite à moitié", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL }, skipTest: true },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("requis");
    expect((await getCurrent()).integrations?.hycu).toBeUndefined();
  });

  it("écrit par la voie du greffon : le champ typé hérité est PURGÉ, jamais laissé en secours", async () => {
    await setHycuConfig({ url: HYCU_URL, username: "ancien-compte", password: HYCU_PASSWORD });
    expect((await getCurrent()).hycu).toBeDefined();
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: "" } },
    });

    expect(response.statusCode).toBe(200);
    const current = await getCurrent();
    expect(current.hycu).toBeUndefined();
    expect(current.integrations?.hycu).toBeDefined();
    // Le mot de passe du champ typé a été repris puis conservé : aucune ressaisie.
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
  });

  it("403 pour un viewer, 404 pour un greffon inconnu", async () => {
    app = buildServer();
    const refused = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: viewerCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD } },
    });
    expect(refused.statusCode).toBe(403);
    expect((await getCurrent()).integrations?.hycu).toBeUndefined();

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/plugins/inexistant/config",
      cookies: adminCookie(),
      payload: { config: {} },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("POST /api/plugins/:id/config/test — ne persiste rien", () => {
  it("candidat complet : résultat réel du greffon, aucune écriture", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/plugins/hycu/config/test",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: "Connexion réussie (12 VMs)" });
    expectNoSecret(response.payload);
    expect(await loadHycuPluginConfig()).toBeNull();
  });

  it("échec : ok false et le message réel, toujours en 200 et toujours sans rien écrire", async () => {
    testGlpiConnectionMock.mockResolvedValue({ ok: false, message: "ERROR_GLPI_LOGIN_PARAMETERS_MISSING" });
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/plugins/glpi/config/test",
      cookies: adminCookie(),
      payload: { config: { apiUrl: GLPI_URL, appToken: GLPI_APP_TOKEN, userToken: GLPI_USER_TOKEN } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, message: "ERROR_GLPI_LOGIN_PARAMETERS_MISSING" });
    expect(await loadGlpiPluginConfig()).toBeNull();
  });

  it("corps vide : teste la configuration ENREGISTRÉE, sans ressaisir le secret", async () => {
    await seedHycu();
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/plugins/hycu/config/test",
      cookies: adminCookie(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(testHycuConnectionMock).toHaveBeenCalledWith(HYCU_URL, HYCU_USER, HYCU_PASSWORD);
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
  });

  it("403 pour un viewer, 404 pour un greffon inconnu", async () => {
    app = buildServer();
    const refused = await app.inject({
      method: "POST",
      url: "/api/plugins/hycu/config/test",
      cookies: viewerCookie(),
      payload: { config: {} },
    });
    expect(refused.statusCode).toBe(403);
    expect(testHycuConnectionMock).not.toHaveBeenCalled();

    const unknown = await app.inject({
      method: "POST",
      url: "/api/plugins/inexistant/config/test",
      cookies: adminCookie(),
      payload: { config: {} },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("DELETE /api/plugins/:id/config", () => {
  it("retire la configuration ET le reliquat du champ typé, puis reste idempotent", async () => {
    await setHycuConfig({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
    app = buildServer();

    const response = await app.inject({ method: "DELETE", url: "/api/plugins/hycu/config", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const current = await getCurrent();
    expect(current.hycu).toBeUndefined();
    expect(current.integrations?.hycu).toBeUndefined();
    expect(await loadHycuPluginConfig()).toBeNull();

    const again = await app.inject({ method: "DELETE", url: "/api/plugins/hycu/config", cookies: adminCookie() });
    expect(again.statusCode).toBe(200);

    const state = await app.inject({ method: "GET", url: "/api/plugins/hycu/config", cookies: adminCookie() });
    expect(state.json()).toEqual({ configured: false, enabled: true, config: {} });
  });

  it("403 pour un viewer, 404 pour un greffon inconnu", async () => {
    await seedGlpi();
    app = buildServer();

    const refused = await app.inject({ method: "DELETE", url: "/api/plugins/glpi/config", cookies: viewerCookie() });
    expect(refused.statusCode).toBe(403);
    expect(await loadGlpiPluginConfig()).not.toBeNull();

    const unknown = await app.inject({ method: "DELETE", url: "/api/plugins/inexistant/config", cookies: adminCookie() });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("PUT /api/plugins/:id/enabled — activer/désactiver sans rien perdre", () => {
  it("désactive puis réactive : la configuration, secret compris, ne bouge pas", async () => {
    await seedHycu();
    app = buildServer();

    const off = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({
      configured: true,
      enabled: false,
      config: { url: HYCU_URL, username: HYCU_USER, hasPassword: true },
    });
    expectNoSecret(off.payload);
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });

    const on = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ configured: true, enabled: true });
    expect(await loadHycuPluginConfig()).toEqual({ url: HYCU_URL, username: HYCU_USER, password: HYCU_PASSWORD });
  });

  it("le socle LIT réellement l'état : un greffon désactivé ne contribue plus au graphe", async () => {
    await seedHycu();
    getHycuTopologySnapshotMock.mockResolvedValue({
      url: HYCU_URL,
      reachable: true,
      vms: [],
      lastBackupFieldPresent: false,
    });
    app = buildServer();

    expect((await hycuTopologyParts([])).nodes).toHaveLength(1);

    await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });

    expect(await isPluginDisabled("hycu")).toBe(true);
    expect(await hycuTopologyParts([])).toEqual({ nodes: [], edges: [] });

    await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: true },
    });
    expect((await hycuTopologyParts([])).nodes).toHaveLength(1);
  });

  it("désactivé, la route dédiée voit toujours la configuration — l'écran des Réglages ne change pas", async () => {
    await seedHycu();
    app = buildServer();

    await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });

    const dedicated = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(dedicated.statusCode).toBe(200);
    expect(dedicated.json()).toEqual({ configured: true, config: { url: HYCU_URL, username: HYCU_USER } });
    expectNoSecret(dedicated.payload);
  });

  it("modifier la configuration d'un greffon désactivé ne le réactive pas en douce", async () => {
    await seedHycu();
    app = buildServer();
    await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/hycu/config",
      cookies: adminCookie(),
      payload: { config: { url: HYCU_URL, username: "autre-compte", password: "" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, enabled: false });
  });

  it("409 tant que rien n'est configuré : on ne crée jamais une entrée vide pour porter un booléen", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/glpi/enabled",
      cookies: adminCookie(),
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toContain("glpi");
    expect((await getCurrent()).integrations?.glpi).toBeUndefined();
  });

  it("400 si `enabled` n'est pas un booléen", async () => {
    await seedGlpi();
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/plugins/glpi/enabled",
      cookies: adminCookie(),
      payload: { enabled: "false" },
    });

    expect(response.statusCode).toBe(400);
    expect(await isPluginDisabled("glpi")).toBe(false);
  });

  it("403 pour un viewer, 404 pour un greffon inconnu", async () => {
    await seedGlpi();
    app = buildServer();

    const refused = await app.inject({
      method: "PUT",
      url: "/api/plugins/glpi/enabled",
      cookies: viewerCookie(),
      payload: { enabled: false },
    });
    expect(refused.statusCode).toBe(403);
    expect(await isPluginDisabled("glpi")).toBe(false);

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/plugins/inexistant/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
