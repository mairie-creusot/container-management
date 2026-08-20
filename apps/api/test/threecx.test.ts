import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Intégration PBX 3CX (LECTURE SEULE) — services/threecx.ts + routes/threecx.ts.
 *
 * Même montage EXACT que hycu.test.ts (isolement CONFIG_PATH, mock node:https routé par
 * `${method} ${pathname}`, buildServer()+inject() de bout en bout). AUCUN test ne touche le PBX
 * réel de la mairie : tout est exercé contre des réponses mockées.
 *
 * Provenance des formes mockées — swagger officiel 3cx/xapi-tutorial (voir services/threecx.ts) :
 *  - POST /connect/token : securitySchemes.Application.flows.clientCredentials.tokenUrl.
 *  - POST /webclient/api/Login/GetAccessToken : { Status: "AuthSuccess", Token: { token_type,
 *    expires_in, access_token, refresh_token } } — forme relevée sur luxzg/3CX-XAPI_examples et le
 *    fil 3cx.com/community/threads/help-getting-the-api-token-on-v20-build-1620.125285.
 *  - GET /xapi/v1/ActiveCalls : Pbx.ActiveCallCollectionResponse { value: [...] }, Pbx.ActiveCall
 *    = { Id, Caller, Callee, Status, EstablishedAt, LastChangeStatus, ServerNow }.
 *  - GET /xapi/v1/Users : Pbx.User (via Pbx.DN) = { Id, Number, DisplayName, FirstName, LastName,
 *    IsRegistered, Enabled, Internal, CurrentProfileName, QueueStatus }.
 *  - GET /xapi/v1/Queues : Pbx.Queue = { Id, Number, Name, IsRegistered, PollingStrategy,
 *    MaxCallersInQueue }.
 *  - GET /xapi/v1/SystemStatus : Pbx.SystemStatus (singleton).
 *  - Erreurs : Pbx.ODataErrors.ODataError { error: { code, message } }.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-3cx-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockResponse {
  status: number;
  body: unknown;
}

const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();
const callsByKey = new Map<string, number>();
const bodiesByKey = new Map<string, string[]>();
const authHeadersByKey = new Map<string, string[]>();

function queueResponse(key: string, body: unknown, status = 200): void {
  const list = queuesByKey.get(key) ?? [];
  list.push({ status, body });
  queuesByKey.set(key, list);
}

function nextResponse(key: string): MockResponse {
  const queue = queuesByKey.get(key);
  if (queue && queue.length > 0) {
    const res = queue.shift()!;
    lastByKey.set(key, res);
    return res;
  }
  return lastByKey.get(key) ?? { status: 200, body: {} };
}

function callCount(key: string): number {
  return callsByKey.get(key) ?? 0;
}

vi.mock("node:https", () => ({
  request: (
    target: URL,
    options: { method?: string; headers?: Record<string, string> },
    callback: (res: EventEmitter & { statusCode: number }) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void; destroy: () => void };
    const key = `${options.method ?? "GET"} ${target.pathname}`;
    callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);
    const auth = options.headers?.Authorization;
    if (auth !== undefined) authHeadersByKey.set(key, [...(authHeadersByKey.get(key) ?? []), auth]);
    req.write = (body: string) => {
      bodiesByKey.set(key, [...(bodiesByKey.get(key) ?? []), body]);
    };
    req.destroy = () => {};
    req.end = () => {
      const found = nextResponse(key);
      if (found.status === 0) {
        req.emit("error", new Error("connect ECONNREFUSED"));
        return;
      }
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(typeof found.body === "string" ? found.body : JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setThreecxConfig, clearThreecxConfig, getEffectiveThreecxConfig, getCurrent } = await import("../src/services/setupStore.js");
const { getThreecxActiveCalls, getThreecxStatus, lastKnownThreecxPoll, resetThreecxCaches } = await import("../src/services/threecx.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  queuesByKey.clear();
  lastByKey.clear();
  callsByKey.clear();
  bodiesByKey.clear();
  authHeadersByKey.clear();
  resetThreecxCaches();
  await clearThreecxConfig();
});

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

const CLIENT_SECRET = "cle-api-3cx-remise-une-seule-fois";
const USER_PASSWORD = "M0tDeP@sse-proprietaire-systeme";
const TOKEN_KEY = "POST /connect/token";
const LOGIN_KEY = "POST /webclient/api/Login/GetAccessToken";
const ACTIVE_CALLS_KEY = "GET /xapi/v1/ActiveCalls";
const USERS_KEY = "GET /xapi/v1/Users";
const QUEUES_KEY = "GET /xapi/v1/Queues";
const SYSTEM_STATUS_KEY = "GET /xapi/v1/SystemStatus";

async function seedThreecxConfig(): Promise<void> {
  await setThreecxConfig({ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-xapi", clientSecret: CLIENT_SECRET });
}

/** Config en mode identifiant/mot de passe (extension avec droits propriétaire système). */
async function seedUserThreecxConfig(): Promise<void> {
  await setThreecxConfig({
    baseUrl: "https://pbx.exemple.fr:5001",
    authMode: "user",
    username: "900",
    password: USER_PASSWORD,
  });
}

function seedToken(expiresIn = 3600): void {
  queueResponse(TOKEN_KEY, { access_token: "jeton-xapi-1", token_type: "Bearer", expires_in: expiresIn });
}

/** Réponse d'un login réussi — forme exacte relevée sur les exemples publics 3CX V20. */
function seedUserLogin(accessToken = "jeton-user-1", options: { expiresIn?: number; refreshToken?: string } = {}): void {
  queueResponse(LOGIN_KEY, {
    Status: "AuthSuccess",
    Token: {
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      access_token: accessToken,
      ...(options.refreshToken ? { refresh_token: options.refreshToken } : {}),
    },
    TwoFactorAuth: null,
  });
}

/** Deux appels : un interne↔interne établi, un appel entrant encore en sonnerie (EstablishedAt null). */
function seedActiveCalls(): void {
  queueResponse(ACTIVE_CALLS_KEY, {
    value: [
      {
        Id: 42,
        Caller: "100",
        Callee: "205",
        Status: "Talking",
        EstablishedAt: "2026-08-19T09:00:00Z",
        LastChangeStatus: "2026-08-19T09:00:00Z",
        ServerNow: "2026-08-19T09:02:30Z",
      },
      {
        Id: 43,
        Caller: "0385551234",
        Callee: "100",
        Status: "Ringing",
        EstablishedAt: null,
        LastChangeStatus: "2026-08-19T09:02:20Z",
        ServerNow: "2026-08-19T09:02:30Z",
      },
      // Sans Id : filtré (jamais un appel sans identifiant réel dans la réponse QUAI).
      { Caller: "999", Callee: "888" },
    ],
  });
}

function seedUsers(): void {
  queueResponse(USERS_KEY, {
    value: [
      {
        Id: 1,
        Number: "100",
        DisplayName: "Accueil Mairie",
        FirstName: "Accueil",
        LastName: "Mairie",
        IsRegistered: true,
        Enabled: true,
        Internal: true,
        CurrentProfileName: "Available",
        QueueStatus: "LoggedIn",
      },
      { Id: 2, Number: "205", FirstName: "Yann", LastName: "Banas", IsRegistered: false, Enabled: true, CurrentProfileName: "Away" },
      // Sans Number : filtré.
      { Id: 3, DisplayName: "Poste fantôme" },
    ],
  });
}

function seedQueues(): void {
  queueResponse(QUEUES_KEY, {
    value: [
      { Id: 10, Number: "800", Name: "Standard", IsRegistered: true, PollingStrategy: "Hunt", MaxCallersInQueue: 25 },
      { Id: 11, Number: "801" },
    ],
  });
}

function seedSystemStatus(): void {
  queueResponse(SYSTEM_STATUS_KEY, {
    Version: "20.0.1.123",
    FQDN: "pbx.exemple.fr",
    Activated: true,
    CallsActive: 2,
    MaxSimCalls: 32,
    ExtensionsRegistered: 1,
    ExtensionsTotal: 2,
    TrunksRegistered: 1,
    TrunksTotal: 1,
    // Champs sensibles présents dans Pbx.SystemStatus : ne doivent JAMAIS ressortir.
    LicenseKey: "4CX-ENT-XXXX-SECRET",
    ProductCode: "3CXPSENTERP",
  });
}

describe("Routes 3CX — autorisation", () => {
  it("401 sans session sur toutes les routes de lecture", async () => {
    app = buildServer();
    for (const url of ["/api/3cx/status", "/api/3cx/active-calls", "/api/3cx/extensions", "/api/3cx/queues", "/api/3cx/config"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("lecture accessible à un rôle viewer (tout rôle authentifié)", async () => {
    app = buildServer();
    for (const url of ["/api/3cx/status", "/api/3cx/active-calls", "/api/3cx/extensions", "/api/3cx/queues", "/api/3cx/config"]) {
      const response = await app.inject({ method: "GET", url, cookies: viewerCookie() });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it("403 pour un rôle viewer sur la config (PUT/POST test/DELETE)", async () => {
    app = buildServer();
    for (const [method, url] of [
      ["PUT", "/api/3cx/config"],
      ["POST", "/api/3cx/config/test"],
      ["DELETE", "/api/3cx/config"],
    ] as const) {
      const response = await app.inject({ method, url, cookies: viewerCookie(), payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("Routes 3CX — jamais configuré (aucune donnée inventée, aucun appel réseau)", () => {
  it("listes vides + configured:false, et RIEN n'est envoyé au PBX", async () => {
    app = buildServer();
    const calls = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: adminCookie() });
    expect(calls.json()).toEqual({ configured: false, calls: [] });
    const extensions = await app.inject({ method: "GET", url: "/api/3cx/extensions", cookies: adminCookie() });
    expect(extensions.json()).toEqual({ configured: false, extensions: [] });
    const queues = await app.inject({ method: "GET", url: "/api/3cx/queues", cookies: adminCookie() });
    expect(queues.json()).toEqual({ configured: false, queues: [] });
    const status = await app.inject({ method: "GET", url: "/api/3cx/status", cookies: adminCookie() });
    expect(status.json()).toMatchObject({ configured: false });
    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });

    expect(callCount(TOKEN_KEY)).toBe(0);
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(0);
  });
});

describe("Service 3CX — jeton client credentials", () => {
  it("obtient le jeton une fois puis le RÉUTILISE : un second appel ne redemande pas de jeton", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    const first = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(first.statusCode).toBe(200);
    expect(callCount(TOKEN_KEY)).toBe(1);

    const second = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(second.statusCode).toBe(200);
    // LE point critique : le XAPI n'accepte qu'un seul jeton actif par instance.
    expect(callCount(TOKEN_KEY)).toBe(1);
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(2);
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-xapi-1", "Bearer jeton-xapi-1"]);
  });

  it("corps du POST /connect/token : grant_type=client_credentials + client_id + client_secret", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    app = buildServer();
    await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });

    const body = bodiesByKey.get(TOKEN_KEY)?.[0] ?? "";
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("quai-xapi");
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("401 sur une ressource : renouvelle le jeton UNE fois et rejoue la requête", async () => {
    await seedThreecxConfig();
    queueResponse(TOKEN_KEY, { access_token: "jeton-expire", expires_in: 3600 });
    queueResponse(TOKEN_KEY, { access_token: "jeton-neuf", expires_in: 3600 });
    queueResponse(ACTIVE_CALLS_KEY, { error: { code: "unauthorized", message: "Token expired" } }, 401);
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(callCount(TOKEN_KEY)).toBe(2);
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-expire", "Bearer jeton-neuf"]);
    expect((response.json() as { calls: unknown[] }).calls).toHaveLength(2);
  });

  it("401 persistant après renouvellement : refus honnête, jamais une boucle de jetons", async () => {
    await seedThreecxConfig();
    seedToken();
    queueResponse(ACTIVE_CALLS_KEY, { error: { code: "unauthorized", message: "Token rejected" } }, 401);
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    const body = response.json() as { configured: boolean; reachable?: boolean; accessError?: string; calls: unknown[] };
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.accessError).toContain("Token rejected");
    expect(body.calls).toEqual([]);
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(2);
    expect(callCount(TOKEN_KEY)).toBe(2);
  });

  it("jeton expiré : redemandé au poll suivant (horloge avancée, seul Date est simulé)", async () => {
    await seedThreecxConfig();
    queueResponse(TOKEN_KEY, { access_token: "jeton-court-1", expires_in: 1 });
    queueResponse(TOKEN_KEY, { access_token: "jeton-court-2", expires_in: 1 });
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-19T09:00:00Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
      expect(callCount(TOKEN_KEY)).toBe(1);

      vi.setSystemTime(new Date("2026-08-19T09:00:05Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
      expect(callCount(TOKEN_KEY)).toBe(2);
      expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-court-1", "Bearer jeton-court-2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Service 3CX — mode identifiant/mot de passe (GetAccessToken)", () => {
  it("obtient le jeton via GetAccessToken avec le corps JSON attendu, puis le RÉUTILISE", async () => {
    await seedUserThreecxConfig();
    seedUserLogin();
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });

    // Un seul jeton actif par instance : la contrainte vaut aussi pour ce mode.
    expect(callCount(LOGIN_KEY)).toBe(1);
    expect(callCount(TOKEN_KEY)).toBe(0);
    expect(JSON.parse(bodiesByKey.get(LOGIN_KEY)?.[0] ?? "{}")).toEqual({
      Username: "900",
      Password: USER_PASSWORD,
      SecurityCode: "",
    });
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-user-1", "Bearer jeton-user-1"]);
  });

  it("401 sur une ressource : re-login UNE fois et rejeu de la requête", async () => {
    await seedUserThreecxConfig();
    seedUserLogin("jeton-user-expire");
    seedUserLogin("jeton-user-neuf");
    queueResponse(ACTIVE_CALLS_KEY, { error: { code: "unauthorized", message: "Token expired" } }, 401);
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(callCount(LOGIN_KEY)).toBe(2);
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-user-expire", "Bearer jeton-user-neuf"]);
    expect((response.json() as { calls: unknown[] }).calls).toHaveLength(2);
  });

  it("identifiants refusés (HTTP 401) : message BRUT du PBX, jamais le mot de passe", async () => {
    await seedUserThreecxConfig();
    queueResponse(LOGIN_KEY, { Status: "AuthFailed", Token: null }, 401);
    app = buildServer();

    const result = await getThreecxActiveCalls();
    expect(result).toMatchObject({ configured: true, reachable: true, items: [] });
    expect(result.accessError).toContain("AuthFailed");
    expect(JSON.stringify(result)).not.toContain(USER_PASSWORD);
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(0);
  });

  it("HTTP 200 mais Status d'échec : refus explicite, aucune requête XAPI tentée", async () => {
    await seedUserThreecxConfig();
    queueResponse(LOGIN_KEY, { Status: "AuthenticationFailed", Token: null, TwoFactorAuth: null }, 200);
    app = buildServer();

    const result = await getThreecxActiveCalls();
    expect(result.accessError).toContain("AuthenticationFailed");
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(0);
  });

  it("Status AuthSuccess mais access_token absent : erreur explicite, jamais un Bearer vide", async () => {
    await seedUserThreecxConfig();
    queueResponse(LOGIN_KEY, { Status: "AuthSuccess", Token: { token_type: "Bearer", expires_in: 60 } }, 200);
    app = buildServer();

    const result = await getThreecxActiveCalls();
    expect(result).toMatchObject({ configured: true, reachable: true, items: [] });
    expect(result.accessError).toContain("refusé l'authentification par identifiant");
    expect(callCount(ACTIVE_CALLS_KEY)).toBe(0);
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toBeUndefined();
  });

  it("PBX injoignable au login : reachable=false, aucun accessError inventé", async () => {
    await seedUserThreecxConfig();
    queueResponse(LOGIN_KEY, {}, 0);
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.json()).toEqual({ configured: true, reachable: false, calls: [] });
    expect(lastKnownThreecxPoll()).toMatchObject({ reachable: false });
  });

  it("expiration : le refresh_token est utilisé s'il est accepté — pas de nouveau login complet", async () => {
    await seedUserThreecxConfig();
    seedUserLogin("jeton-court-1", { expiresIn: 1, refreshToken: "refresh-1" });
    queueResponse(TOKEN_KEY, { access_token: "jeton-rafraichi", token_type: "Bearer", expires_in: 3600 });
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-19T09:00:00Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
      vi.setSystemTime(new Date("2026-08-19T09:00:05Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    } finally {
      vi.useRealTimers();
    }

    expect(callCount(LOGIN_KEY)).toBe(1);
    expect(callCount(TOKEN_KEY)).toBe(1);
    const params = new URLSearchParams(bodiesByKey.get(TOKEN_KEY)?.[0] ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-1");
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual(["Bearer jeton-court-1", "Bearer jeton-rafraichi"]);
  });

  it("expiration : refresh refusé par le PBX = login complet en repli, sans boucle", async () => {
    await seedUserThreecxConfig();
    seedUserLogin("jeton-court-1", { expiresIn: 1, refreshToken: "refresh-1" });
    seedUserLogin("jeton-court-2", { expiresIn: 1, refreshToken: "refresh-2" });
    seedUserLogin("jeton-court-3", { expiresIn: 1, refreshToken: "refresh-3" });
    queueResponse(TOKEN_KEY, { error: "unsupported_grant_type" }, 400);
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-19T09:00:00Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
      vi.setSystemTime(new Date("2026-08-19T09:00:05Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
      vi.setSystemTime(new Date("2026-08-19T09:00:10Z"));
      await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    } finally {
      vi.useRealTimers();
    }

    // Le refresh n'est tenté qu'UNE fois : son premier échec le désactive pour ce process.
    expect(callCount(TOKEN_KEY)).toBe(1);
    expect(callCount(LOGIN_KEY)).toBe(3);
    expect(authHeadersByKey.get(ACTIVE_CALLS_KEY)).toEqual([
      "Bearer jeton-court-1",
      "Bearer jeton-court-2",
      "Bearer jeton-court-3",
    ]);
  });

  it("postes et résumé fonctionnent à l'identique dans ce mode (mêmes $select en liste blanche)", async () => {
    await seedUserThreecxConfig();
    seedUserLogin();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    seedSystemStatus();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/status", cookies: viewerCookie() });
    expect(response.json()).toMatchObject({ configured: true, reachable: true, activeCallCount: 2, extensionCount: 2, queueCount: 2 });
    expect(response.body).not.toContain("LicenseKey");
    expect(response.body).not.toContain(USER_PASSWORD);
  });
});

describe("Service 3CX — migration d'une config sans authMode", () => {
  it("une config déjà enregistrée sans authMode reste en client-credentials", async () => {
    await seedThreecxConfig();
    expect((await getCurrent()).threecx?.authMode).toBeUndefined();

    const effective = await getEffectiveThreecxConfig();
    expect(effective).toMatchObject({ authMode: "client-credentials", clientId: "quai-xapi", clientSecret: CLIENT_SECRET });
  });

  it("elle continue de s'authentifier sur /connect/token, jamais sur GetAccessToken", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(callCount(TOKEN_KEY)).toBe(1);
    expect(callCount(LOGIN_KEY)).toBe(0);
  });

  it("GET /api/3cx/config expose authMode=client-credentials pour cette config", async () => {
    await seedThreecxConfig();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(response.json()).toMatchObject({ configured: true, config: { authMode: "client-credentials" } });
  });
});

describe("Service 3CX — normalisation des appels en cours", () => {
  it("participants Caller/Callee, durée = ServerNow - EstablishedAt, nom résolu par /Users", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.json()).toEqual({
      configured: true,
      reachable: true,
      calls: [
        {
          id: "42",
          startedAt: "2026-08-19T09:00:00Z",
          participants: [
            { number: "100", direction: "caller", name: "Accueil Mairie" },
            { number: "205", direction: "callee", name: "Yann Banas" },
          ],
          durationSeconds: 150,
          status: "Talking",
          lastChangeAt: "2026-08-19T09:00:00Z",
        },
        {
          id: "43",
          participants: [
            // Numéro externe : aucun poste ne correspond, donc AUCUN nom inventé.
            { number: "0385551234", direction: "caller" },
            { number: "100", direction: "callee", name: "Accueil Mairie" },
          ],
          status: "Ringing",
          lastChangeAt: "2026-08-19T09:02:20Z",
        },
      ],
    });
  });

  it("annuaire /Users indisponible : les appels sortent quand même, sans nom", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    queueResponse(USERS_KEY, { error: { code: "forbidden", message: "Not licensed" } }, 403);
    app = buildServer();

    const body = (await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() })).json() as {
      calls: Array<{ participants: Array<{ name?: string }> }>;
    };
    expect(body.calls).toHaveLength(2);
    expect(body.calls.flatMap((c) => c.participants).every((p) => p.name === undefined)).toBe(true);
  });

  it("annuaire mis en cache : /Users n'est pas réinterrogé à chaque poll d'appels", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    app = buildServer();

    await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(callCount(USERS_KEY)).toBe(1);
  });
});

describe("Service 3CX — postes, files et résumé", () => {
  it("GET /api/3cx/extensions : présence réelle, aucun champ sensible, $select en liste blanche", async () => {
    await seedThreecxConfig();
    seedToken();
    seedUsers();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/extensions", cookies: viewerCookie() });
    expect(response.json()).toEqual({
      configured: true,
      reachable: true,
      extensions: [
        {
          id: 1,
          number: "100",
          displayName: "Accueil Mairie",
          firstName: "Accueil",
          lastName: "Mairie",
          registered: true,
          enabled: true,
          internal: true,
          currentProfileName: "Available",
          queueStatus: "LoggedIn",
        },
        {
          id: 2,
          number: "205",
          displayName: "Yann Banas",
          firstName: "Yann",
          lastName: "Banas",
          registered: false,
          enabled: true,
          currentProfileName: "Away",
        },
      ],
    });
    // Les mots de passe de Pbx.User ne sont même pas demandés au PBX.
    for (const field of ["AccessPassword", "AuthPassword", "DeskphonePassword", "VMPIN"]) {
      expect(response.body).not.toContain(field);
    }
  });

  it("GET /api/3cx/queues : Id/Number obligatoires, reste en passthrough", async () => {
    await seedThreecxConfig();
    seedToken();
    seedQueues();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/queues", cookies: viewerCookie() });
    expect(response.json()).toEqual({
      configured: true,
      reachable: true,
      queues: [
        { id: 10, number: "800", name: "Standard", registered: true, pollingStrategy: "Hunt", maxCallersInQueue: 25 },
        { id: 11, number: "801" },
      ],
    });
  });

  it("GET /api/3cx/status : appels en cours + postes joignables + état système (sans LicenseKey)", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    seedSystemStatus();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/status", cookies: viewerCookie() });
    expect(response.json()).toMatchObject({
      configured: true,
      reachable: true,
      activeCallCount: 2,
      extensionCount: 2,
      reachableExtensionCount: 1,
      queueCount: 2,
      system: {
        version: "20.0.1.123",
        fqdn: "pbx.exemple.fr",
        activated: true,
        callsActive: 2,
        maxSimCalls: 32,
        extensionsRegistered: 1,
        extensionsTotal: 2,
        trunksRegistered: 1,
        trunksTotal: 1,
      },
      lastPoll: { reachable: true },
    });
    expect(response.body).not.toContain("4CX-ENT-XXXX-SECRET");
    expect(response.body).not.toContain("LicenseKey");
    expect(lastKnownThreecxPoll()).toMatchObject({ reachable: true });
  });

  it("/SystemStatus refusé : le résumé reste honnête (compteurs réels, bloc système absent)", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    queueResponse(SYSTEM_STATUS_KEY, { error: { code: "forbidden", message: "Insufficient rights" } }, 403);
    app = buildServer();

    const status = await getThreecxStatus();
    expect(status).toMatchObject({ configured: true, reachable: true, activeCallCount: 2 });
    expect(status.system).toBeUndefined();
  });
});

describe("Service 3CX — licence Enterprise absente et PBX injoignable", () => {
  it("refus du PBX : le message est remonté TEL QUEL, jamais une liste vide silencieuse", async () => {
    await seedThreecxConfig();
    seedToken();
    queueResponse(
      ACTIVE_CALLS_KEY,
      { error: { code: "Forbidden", message: "XAPI access requires a 3CX Enterprise license" } },
      403,
    );
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    const body = response.json() as { configured: boolean; reachable?: boolean; accessError?: string; calls: unknown[] };
    expect(body).toMatchObject({ configured: true, reachable: true, calls: [] });
    expect(body.accessError).toContain("XAPI access requires a 3CX Enterprise license");
    expect(body.accessError).toContain("Forbidden");

    const status = await getThreecxStatus();
    expect(status.accessError).toContain("XAPI access requires a 3CX Enterprise license");
  });

  it("PBX injoignable : reachable=false, aucun accessError inventé, lastPoll négatif", async () => {
    await seedThreecxConfig();
    queueResponse(TOKEN_KEY, {}, 0);
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/active-calls", cookies: viewerCookie() });
    expect(response.json()).toEqual({ configured: true, reachable: false, calls: [] });
    expect(lastKnownThreecxPoll()).toMatchObject({ reachable: false });
  });

  it("identifiants refusés au /connect/token : message honnête, jamais le secret", async () => {
    await seedThreecxConfig();
    queueResponse(TOKEN_KEY, { error: "invalid_client", error_description: "Client authentication failed" }, 400);
    app = buildServer();

    const result = await getThreecxActiveCalls();
    expect(result).toMatchObject({ configured: true, reachable: true, items: [] });
    expect(result.accessError).toContain("Client authentication failed");
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });
});

describe("Routes 3CX — config (aucun secret ne ressort)", () => {
  it("GET /api/3cx/config : baseUrl + clientId, JAMAIS le clientSecret", async () => {
    await seedThreecxConfig();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(response.json()).toEqual({
      configured: true,
      config: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "client-credentials", clientId: "quai-xapi" },
    });
    expect(response.body).not.toContain(CLIENT_SECRET);
    expect(response.body).not.toContain("clientSecret");
  });

  it("PUT /api/3cx/config : teste la connexion AVANT de persister — échec = rien enregistré", async () => {
    queueResponse(TOKEN_KEY, { error: "invalid_client" }, 400);
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-xapi", clientSecret: CLIENT_SECRET },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(CLIENT_SECRET);

    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("PUT /api/3cx/config : connexion valide = persistée, réponse redactée", async () => {
    seedToken();
    queueResponse(ACTIVE_CALLS_KEY, { value: [] });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-xapi", clientSecret: CLIENT_SECRET, tlsRejectUnauthorized: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      config: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "client-credentials", clientId: "quai-xapi", tlsRejectUnauthorized: false },
    });
    expect(response.body).not.toContain(CLIENT_SECRET);
  });

  it("PUT /api/3cx/config : clientSecret vide conserve celui déjà enregistré", async () => {
    await seedThreecxConfig();
    seedToken();
    queueResponse(ACTIVE_CALLS_KEY, { value: [] });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx2.exemple.fr:5001", clientId: "quai-xapi" },
    });
    expect(response.statusCode).toBe(200);
    const params = new URLSearchParams(bodiesByKey.get(TOKEN_KEY)?.at(-1) ?? "");
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("POST /api/3cx/config/test : ne persiste rien et ne renvoie aucun secret", async () => {
    queueResponse(TOKEN_KEY, { access_token: "jeton-test", expires_in: 3600 });
    queueResponse(ACTIVE_CALLS_KEY, { value: [{ Id: 1, Caller: "100", Callee: "205" }] });
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-xapi", clientSecret: CLIENT_SECRET },
    });
    expect(response.json()).toMatchObject({ ok: true, activeCallCount: 1 });
    expect(response.body).not.toContain(CLIENT_SECRET);

    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("POST /api/3cx/config/test : licence absente = message brut du PBX", async () => {
    queueResponse(TOKEN_KEY, { access_token: "jeton-test", expires_in: 3600 });
    queueResponse(ACTIVE_CALLS_KEY, { error: { code: "Forbidden", message: "XAPI requires 3CX Enterprise" } }, 403);
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-xapi", clientSecret: CLIENT_SECRET },
    });
    expect(response.json()).toMatchObject({ ok: false });
    expect((response.json() as { message: string }).message).toContain("XAPI requires 3CX Enterprise");
  });

  it("POST /api/3cx/config/test : URL invalide refusée sans aucun appel réseau", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "pas-une-url", clientId: "quai-xapi", clientSecret: CLIENT_SECRET },
    });
    expect(response.json()).toMatchObject({ ok: false });
    expect(callCount(TOKEN_KEY)).toBe(0);
  });

  it("GET /api/3cx/config en mode identifiant : authMode + username, JAMAIS le mot de passe", async () => {
    await seedUserThreecxConfig();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(response.json()).toEqual({
      configured: true,
      config: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900" },
    });
    expect(response.body).not.toContain(USER_PASSWORD);
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("clientSecret");
  });

  it("PUT /api/3cx/config en mode identifiant : testé via GetAccessToken puis persisté, réponse redactée", async () => {
    seedUserLogin("jeton-test-user");
    queueResponse(ACTIVE_CALLS_KEY, { value: [] });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900", password: USER_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      config: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900" },
    });
    expect(response.body).not.toContain(USER_PASSWORD);
    expect(callCount(LOGIN_KEY)).toBe(1);
    expect(callCount(TOKEN_KEY)).toBe(0);
  });

  it("PUT /api/3cx/config en mode identifiant : identifiants refusés = message brut, rien de persisté", async () => {
    queueResponse(LOGIN_KEY, { Status: "AuthFailed", Token: null }, 401);
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900", password: USER_PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("AuthFailed");
    expect(response.body).not.toContain(USER_PASSWORD);

    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("PUT /api/3cx/config en mode identifiant : mot de passe vide conserve celui déjà enregistré", async () => {
    await seedUserThreecxConfig();
    seedUserLogin("jeton-test-user");
    queueResponse(ACTIVE_CALLS_KEY, { value: [] });
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx2.exemple.fr:5001", authMode: "user", username: "900" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(bodiesByKey.get(LOGIN_KEY)?.at(-1) ?? "{}")).toMatchObject({ Username: "900", Password: USER_PASSWORD });
  });

  it("PUT /api/3cx/config en mode identifiant : mot de passe manquant = 400 sans aucun appel réseau", async () => {
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/3cx/config",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900" },
    });
    expect(response.statusCode).toBe(400);
    expect(callCount(LOGIN_KEY)).toBe(0);
    expect(callCount(TOKEN_KEY)).toBe(0);
  });

  it("POST /api/3cx/config/test : teste le mode DEMANDÉ, pas celui déjà enregistré", async () => {
    await seedThreecxConfig();
    seedUserLogin("jeton-test-user");
    queueResponse(ACTIVE_CALLS_KEY, { value: [] });
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900", password: USER_PASSWORD },
    });
    expect(response.json()).toMatchObject({ ok: true });
    expect(callCount(LOGIN_KEY)).toBe(1);
    expect(callCount(TOKEN_KEY)).toBe(0);
    // Rien n'est persisté : la config enregistrée reste en client credentials.
    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toMatchObject({ config: { authMode: "client-credentials" } });
  });

  it("POST /api/3cx/config/test en mode identifiant : refus du PBX remonté BRUT, sans le mot de passe", async () => {
    queueResponse(LOGIN_KEY, { Status: "AuthFailed", Token: null, Message: "Insufficient rights for XAPI" }, 403);
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900", password: USER_PASSWORD },
    });
    const body = response.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Insufficient rights for XAPI");
    expect(response.body).not.toContain(USER_PASSWORD);
  });

  it("POST /api/3cx/config/test en mode identifiant : XAPI refusé après un login réussi = message brut", async () => {
    seedUserLogin("jeton-test-user");
    queueResponse(ACTIVE_CALLS_KEY, { error: { code: "Forbidden", message: "XAPI requires 3CX Enterprise" } }, 403);
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/3cx/config/test",
      cookies: adminCookie(),
      payload: { baseUrl: "https://pbx.exemple.fr:5001", authMode: "user", username: "900", password: USER_PASSWORD },
    });
    expect((response.json() as { message: string }).message).toContain("XAPI requires 3CX Enterprise");
  });

  it("aucune route ne laisse fuir un secret 3CX, quel que soit le mode", async () => {
    await seedUserThreecxConfig();
    seedUserLogin();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    seedSystemStatus();
    app = buildServer();

    for (const url of ["/api/3cx/status", "/api/3cx/active-calls", "/api/3cx/extensions", "/api/3cx/queues", "/api/3cx/config"]) {
      const response = await app.inject({ method: "GET", url, cookies: adminCookie() });
      expect(response.body, url).not.toContain(USER_PASSWORD);
      expect(response.body, url).not.toContain(CLIENT_SECRET);
    }
  });

  it("DELETE /api/3cx/config : retour à jamais configuré", async () => {
    await seedThreecxConfig();
    app = buildServer();

    const del = await app.inject({ method: "DELETE", url: "/api/3cx/config", cookies: adminCookie() });
    expect(del.json()).toEqual({ ok: true });
    const cfg = await app.inject({ method: "GET", url: "/api/3cx/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });
});

describe("Service 3CX — LECTURE SEULE", () => {
  it("aucune requête mutante vers le PBX : seuls GET /xapi/v1 et POST /connect/token sont émis", async () => {
    await seedThreecxConfig();
    seedToken();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    seedSystemStatus();
    app = buildServer();

    for (const url of ["/api/3cx/status", "/api/3cx/active-calls", "/api/3cx/extensions", "/api/3cx/queues"]) {
      await app.inject({ method: "GET", url, cookies: viewerCookie() });
    }
    for (const key of callsByKey.keys()) {
      expect(key === TOKEN_KEY || key.startsWith("GET /xapi/v1/"), key).toBe(true);
    }
  });

  it("mode identifiant : seuls GET /xapi/v1 et le POST de login sont émis", async () => {
    await seedUserThreecxConfig();
    seedUserLogin();
    seedActiveCalls();
    seedUsers();
    seedQueues();
    seedSystemStatus();
    app = buildServer();

    for (const url of ["/api/3cx/status", "/api/3cx/active-calls", "/api/3cx/extensions", "/api/3cx/queues"]) {
      await app.inject({ method: "GET", url, cookies: viewerCookie() });
    }
    for (const key of callsByKey.keys()) {
      expect(key === LOGIN_KEY || key === TOKEN_KEY || key.startsWith("GET /xapi/v1/"), key).toBe(true);
    }
  });
});
