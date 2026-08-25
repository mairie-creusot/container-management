import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Intégration GLPI — services/glpi.ts + routes/glpi.ts.
 *
 * AUCUN test ne touche le GLPI de production de la mairie (172.16.8.22) : tout est exercé contre
 * un `fetch` mocké (même montage que github.test.ts/notificationDispatch.test.ts). Les écritures
 * (création de ticket, suivi, passage en résolu) ne s'exercent QUE contre ce mock.
 *
 * Provenance des formes mockées — doc officielle glpi-project/glpi/apirest.md (19/08/2026) :
 *  - /initSession -> { "session_token": "..." } ; /killSession -> corps vide.
 *  - /search/:itemtype -> { totalcount, count, range, data } où `data` est indexé par id d'item et
 *    chaque ligne par NUMÉRO d'option de recherche.
 *  - POST /:itemtype -> 201 { "id": 15 } ; PUT /:itemtype/:id -> [{ "<id>": true, "message": "" }].
 *  - Erreurs -> ["ERROR_CODE", "message"] (codes listés dans apirest.md).
 *  - Statuts SOLVED=5 / CLOSED=6 : src/CommonITILObject.php ; REQUESTER=1 : src/CommonITILActor.php.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-glpi-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.QUAI_PUBLIC_URL = "https://quai.lecreusot.fr";

const APP_TOKEN = "APP-TOKEN-SUPER-SECRET-0123456789";
const USER_TOKEN = "USER-TOKEN-SUPER-SECRET-9876543210";
const SERVICE_PASSWORD = "MotDePasseDeService-042";
const SESSION_TOKEN = "83af7e620c83a50a18d3eac2f6ed05a3ca0bea62";

interface RecordedCall {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const calls: RecordedCall[] = [];
const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();

function queue(key: string, body: unknown, status = 200, headers?: Record<string, string>): void {
  const list = queuesByKey.get(key) ?? [];
  list.push({ status, body, ...(headers ? { headers } : {}) });
  queuesByKey.set(key, list);
}

function callsTo(key: string): RecordedCall[] {
  return calls.filter((c) => `${c.method} ${c.path}` === key);
}

const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  const parsed = new URL(url);
  const relative = parsed.pathname.replace(/^\/apirest\.php\/?/, "");
  const method = (init.method ?? "GET").toUpperCase();
  const key = `${method} ${relative}`;
  calls.push({
    method,
    path: relative,
    search: parsed.search,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === "string" ? JSON.parse(init.body) : null,
  });
  const found: MockResponse = queuesByKey.get(key)?.shift() ?? lastByKey.get(key) ?? { status: 200, body: {} };
  lastByKey.set(key, found);
  return new Response(found.body === null ? "" : JSON.stringify(found.body), {
    status: found.status,
    ...(found.headers ? { headers: found.headers } : {}),
  });
});

vi.stubGlobal("fetch", fetchMock);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { removeGlpiPluginConfig, saveGlpiPluginConfig } = await import("../src/plugins/glpi/config.js");
const { listAuditEvents } = await import("../src/services/auditLog.js");
const glpi = await import("../src/services/glpi.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  calls.length = 0;
  queuesByKey.clear();
  lastByKey.clear();
  lastByKey.set("GET initSession", { status: 200, body: { session_token: SESSION_TOKEN } });
  lastByKey.set("GET killSession", { status: 200, body: null });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await glpi.releaseGlpiSession();
  // Retire l'entrée du greffon ET tout reliquat de l'ancien champ typé : sans quoi une config
  // survivrait d'un test à l'autre.
  await removeGlpiPluginConfig();
});

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function operatorCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["operator"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

async function seedUserTokenConfig(): Promise<void> {
  await saveGlpiPluginConfig({ apiUrl: "http://glpi.test/apirest.php", appToken: APP_TOKEN, userToken: USER_TOKEN });
}
async function seedCredentialsConfig(): Promise<void> {
  await saveGlpiPluginConfig({
    apiUrl: "http://glpi.test/apirest.php",
    appToken: APP_TOKEN,
    username: "svc-quai",
    password: SERVICE_PASSWORD,
  });
}

/** Ligne de résultat /search/Ticket : clé = id d'item, sous-clés = numéros d'options. */
function ticketRow(id: number, title: string, status = 2) {
  return { [String(id)]: { "2": id, "1": title, "12": status, "15": "2026-08-19 09:00:00", "19": "2026-08-19 09:30:00" } };
}

/** Même ligne, avec le demandeur (option 4) tel que GLPI le renvoie en `forcedisplay`. */
function ticketRowWithRequester(id: number, title: string, requester: unknown, status = 2) {
  return {
    [String(id)]: { "2": id, "1": title, "12": status, "15": "2026-08-19 09:00:00", "19": "2026-08-19 09:30:00", "4": requester },
  };
}

/** Objet /User tel que renvoyé par `GET /User` (getItems : champs NOMMÉS, pas d'options). */
function userItem(id: number, name: string, firstname?: string, realname?: string) {
  return { id, name, firstname: firstname ?? null, realname: realname ?? null, is_active: 1 };
}

function searchOf(key: string, index = 0): string {
  return decodeURIComponent(callsTo(key)[index]!.search);
}

/** Ids d'audit déjà présents : le journal est un fichier partagé et persiste entre les exécutions. */
async function auditIds(): Promise<Set<string>> {
  return new Set((await listAuditEvents()).map((event) => event.id));
}

/**
 * Le journal est un fichier PARTAGÉ par toutes les suites (même dossier que CONFIG_PATH) et le hook
 * onResponse écrit après que app.inject() a rendu la main : on ne garde que les lignes /browse/ et
 * on laisse le temps à l'écriture d'arriver, plutôt que de lire une seule fois au hasard.
 */
async function browseAuditEvents(before: Set<string>, expected: number) {
  let events = [] as Awaited<ReturnType<typeof listAuditEvents>>;
  for (let attempt = 0; attempt < 60; attempt++) {
    events = (await listAuditEvents()).filter(
      (event) => !before.has(event.id) && event.path.startsWith("/api/glpi/browse/"),
    );
    if (events.length >= expected) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events;
}

describe("GLPI — cycle de session", () => {
  it("ouvre la session avec App-Token + Authorization user_token et réutilise le session_token", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(42, "Imprimante HS") });

    const match = await glpi.resolveGlpiUserByLogin("ybanas");
    expect(match.outcome).toBe("found");
    await glpi.listGlpiTicketsForUser(7);

    const inits = callsTo("GET initSession");
    expect(inits).toHaveLength(1); // une seule session pour deux appels
    expect(inits[0]!.headers["App-Token"]).toBe(APP_TOKEN);
    expect(inits[0]!.headers.Authorization).toBe(`user_token ${USER_TOKEN}`);
    // Les jetons ne passent JAMAIS par l'URL.
    expect(inits[0]!.search).toBe("");
    for (const call of callsTo("GET search/Ticket")) {
      expect(call.headers["Session-Token"]).toBe(SESSION_TOKEN);
    }
  });

  it("s'authentifie en Basic quand la config porte un login/mot de passe de service", async () => {
    await seedCredentialsConfig();
    queue("GET search/User", { totalcount: 0, count: 0, data: [] });
    await glpi.resolveGlpiUserByLogin("inconnu");

    const expected = `Basic ${Buffer.from(`svc-quai:${SERVICE_PASSWORD}`).toString("base64")}`;
    expect(callsTo("GET initSession")[0]!.headers.Authorization).toBe(expected);
  });

  it("réinitialise la session UNE fois sur ERROR_SESSION_TOKEN_INVALID puis rejoue l'appel", async () => {
    await seedUserTokenConfig();
    queue("GET initSession", { session_token: SESSION_TOKEN });
    queue("GET initSession", { session_token: "session-neuve" });
    queue("GET search/User", ["ERROR_SESSION_TOKEN_INVALID", "session expirée"], 401);
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });

    const match = await glpi.resolveGlpiUserByLogin("ybanas");
    expect(match).toEqual({ outcome: "found", userId: 7, login: "ybanas" });
    expect(callsTo("GET initSession")).toHaveLength(2);
    expect(callsTo("GET killSession")).toHaveLength(1);
    expect(callsTo("GET search/User")[1]!.headers["Session-Token"]).toBe("session-neuve");
  });

  it("referme systématiquement la session ouverte pour un test de connexion", async () => {
    const result = await glpi.testGlpiConnection({
      apiUrl: "http://glpi.test/apirest.php",
      appToken: APP_TOKEN,
      userToken: USER_TOKEN,
    });
    expect(result.ok).toBe(true);
    expect(callsTo("GET killSession")).toHaveLength(1);
    expect(callsTo("GET killSession")[0]!.headers["Session-Token"]).toBe(SESSION_TOKEN);
  });
});

describe("GLPI — rapprochement du compte utilisateur (AD/LDAP -> /User.name)", () => {
  it("une seule correspondance -> found", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    expect(await glpi.resolveGlpiUserByLogin("ybanas")).toEqual({ outcome: "found", userId: 7, login: "ybanas" });
  });

  it("aucune correspondance -> not-found (y compris via ERROR_RANGE_EXCEED_TOTAL)", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 0, count: 0, data: [] });
    expect(await glpi.resolveGlpiUserByLogin("fantome")).toEqual({ outcome: "not-found", login: "fantome" });

    queue("GET search/User", ["ERROR_RANGE_EXCEED_TOTAL", "hors bornes"], 400);
    expect(await glpi.resolveGlpiUserByLogin("fantome2")).toEqual({ outcome: "not-found", login: "fantome2" });
  });

  it("plusieurs correspondances -> ambiguous, jamais un choix silencieux", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", {
      totalcount: 2,
      count: 2,
      data: { "7": { "2": 7, "1": "ybanas" }, "9": { "2": 9, "1": "ybanas" } },
    });
    const match = await glpi.resolveGlpiUserByLogin("ybanas");
    expect(match.outcome).toBe("ambiguous");
    expect(match).toMatchObject({ candidateIds: [7, 9] });
  });

  // Vérifié sur l'instance réelle le 21/08/2026 : `equals` sur l'option 1 renvoie 0 résultat alors
  // que le compte existe ; `contains` le trouve. Le filtrage exact se fait ensuite côté QUAI.
  it("interroge GLPI en 'contains' — 'equals' ne matche pas ce champ texte", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    await glpi.resolveGlpiUserByLogin("ybanas");
    const search = decodeURIComponent(callsTo("GET search/User")[0]!.search);
    expect(search).toContain("contains");
    expect(search).not.toContain("searchtype]=equals");
  });

  it("une sur-chaîne renvoyée par 'contains' n'est jamais retenue", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", {
      totalcount: 2,
      count: 2,
      data: { "587": { "2": 587, "1": "adminbanas" }, "319": { "2": 319, "1": "ybanas" } },
    });
    expect(await glpi.resolveGlpiUserByLogin("ybanas")).toEqual({ outcome: "found", userId: 319, login: "ybanas" });
  });

  it("aucune égalité exacte parmi les sur-chaînes -> not-found, jamais un compte approchant", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", {
      totalcount: 2,
      count: 2,
      data: { "587": { "2": 587, "1": "adminbanas" }, "319": { "2": 319, "1": "ybanas" } },
    });
    expect(await glpi.resolveGlpiUserByLogin("banas")).toEqual({ outcome: "not-found", login: "banas" });
  });

  it("égalité insensible à la casse (GLPI peut renvoyer une casse différente de la saisie)", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    expect(await glpi.resolveGlpiUserByLogin("YBanas")).toEqual({ outcome: "found", userId: 7, login: "YBanas" });
  });
});

describe("GLPI — anti-doublon par empreinte d'incident", () => {
  const incident = {
    resource: "container:abc123",
    alertType: "ressource-en-echec",
    title: "[QUAI] nginx-prod en échec",
    occurredAt: "2026-08-19T08:00:00.000Z",
  };

  it("crée un ticket portant l'empreinte quand aucun ticket ouvert ne la porte", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 0, count: 0, data: [] });
    queue("POST Ticket", { id: 4242 }, 201);

    const report = await glpi.reportGlpiIncident(incident);
    expect(report).toEqual({ action: "created", ticketId: 4242, fingerprint: glpi.incidentFingerprint(incident) });

    const search = callsTo("GET search/Ticket")[0]!;
    const marker = glpi.incidentMarker(glpi.incidentFingerprint(incident));
    // Recherche sur le CONTENU (option 21) + statut ni résolu (5) ni clos (6).
    expect(decodeURIComponent(search.search)).toContain("criteria[0][field]=21");
    expect(decodeURIComponent(search.search)).toContain("criteria[0][searchtype]=contains");
    expect(decodeURIComponent(search.search)).toContain(marker);
    expect(decodeURIComponent(search.search)).toContain("criteria[1][searchtype]=notequals");
    expect(decodeURIComponent(search.search)).toContain("criteria[1][value]=5");
    expect(decodeURIComponent(search.search)).toContain("criteria[2][value]=6");

    const created = callsTo("POST Ticket")[0]!.body as { input: { name: string; content: string } };
    expect(created.input.name).toBe(incident.title);
    expect(created.input.content).toContain(marker);
    expect(created.input.content).toContain("container:abc123");
    expect(created.input.content).toContain("ressource-en-echec");
    expect(created.input.content).toContain("2026-08-19T08:00:00.000Z");
  });

  it("ajoute un suivi \"+1 occurrence\" au lieu de créer un doublon", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(4242, "[QUAI] nginx-prod en échec") });
    queue("POST ITILFollowup", { id: 88 }, 201);

    const report = await glpi.reportGlpiIncident(incident);
    expect(report).toEqual({ action: "followup", ticketId: 4242, fingerprint: glpi.incidentFingerprint(incident) });
    expect(callsTo("POST Ticket")).toHaveLength(0); // AUCUNE création

    const followup = callsTo("POST ITILFollowup")[0]!.body as { input: { itemtype: string; items_id: number; content: string } };
    expect(followup.input).toMatchObject({ itemtype: "Ticket", items_id: 4242 });
    expect(followup.input.content).toContain("+1 occurrence");
  });

  it("l'empreinte est stable pour (ressource, type d'alerte) et distincte sinon", () => {
    const a = glpi.incidentFingerprint({ resource: "container:abc123", alertType: "ressource-en-echec" });
    const b = glpi.incidentFingerprint({ resource: "CONTAINER:ABC123", alertType: " ressource-en-echec " });
    const c = glpi.incidentFingerprint({ resource: "container:abc123", alertType: "upstream-injoignable" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("résolution automatique : suivi \"l'alerte a disparu\" puis passage en résolu (status 5)", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(4242, "[QUAI] nginx-prod en échec") });
    queue("POST ITILFollowup", { id: 89 }, 201);
    queue("PUT Ticket/4242", [{ "4242": true, message: "" }]);

    const report = await glpi.resolveGlpiIncident(incident, "2026-08-19T10:00:00.000Z");
    expect(report).toMatchObject({ action: "resolved", ticketId: 4242 });

    const followup = callsTo("POST ITILFollowup")[0]!.body as { input: { content: string } };
    expect(followup.input.content).toContain("L'alerte a disparu");

    // SEULE mutation possible d'un ticket existant : { id, status: 5 }, rien d'autre.
    const put = callsTo("PUT Ticket/4242")[0]!.body as { input: Record<string, unknown> };
    expect(put.input).toEqual({ id: 4242, status: 5 });
  });

  it("aucun ticket ouvert portant l'empreinte -> aucune écriture", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 0, count: 0, data: [] });
    const report = await glpi.resolveGlpiIncident(incident);
    expect(report.action).toBe("none");
    expect(callsTo("POST ITILFollowup")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});

describe("GLPI — action d'automatisation", () => {
  it("ne reconnaît que la config create-glpi-ticket", () => {
    expect(glpi.asGlpiAutomationAction({ kind: "send-notification", channelId: "c", message: "m" })).toBeNull();
    expect(glpi.asGlpiAutomationAction(null)).toBeNull();
    expect(glpi.asGlpiAutomationAction({ kind: "create-glpi-ticket" })).toEqual({ kind: "create-glpi-ticket" });
  });

  it("crée un ticket enrichi du contexte réel + lien de retour QUAI, avec anti-doublon", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 0, count: 0, data: [] });
    queue("POST Ticket", { id: 777 }, 201);

    const result = await glpi.runGlpiAutomationAction(
      { kind: "create-glpi-ticket" },
      {
        resource: "container:abc123",
        alertType: "ressource-en-echec",
        triggerLabel: "nginx-prod",
        occurredAt: "2026-08-19T08:00:00.000Z",
      },
    );
    expect(result.ok).toBe(true);
    const created = callsTo("POST Ticket")[0]!.body as { input: { name: string; content: string } };
    expect(created.input.name).toContain("nginx-prod");
    expect(created.input.content).toContain("container:abc123");
    expect(created.input.content).toContain("https://quai.lecreusot.fr/automation?resource=");
  });

  it("GLPI non configuré : échoue proprement sans jamais appeler le réseau", async () => {
    const result = await glpi.runGlpiAutomationAction(
      { kind: "create-glpi-ticket" },
      { resource: "container:x", alertType: "ressource-en-echec", triggerLabel: "x", occurredAt: "2026-08-19T08:00:00.000Z" },
    );
    expect(result).toEqual({ ok: false, message: "GLPI n'est pas configuré : aucun ticket créé" });
    expect(calls).toHaveLength(0);
  });
});

describe("GLPI — routes", () => {
  it("status : non configuré", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/status", cookies: viewerCookie() });
    expect(res.statusCode).toBe(200);
    // `lastPoll` (mémoire process, comme hycu.ts) peut subsister d'un test précédent ; ce qui
    // compte est qu'aucune information de configuration ne soit exposée.
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.reachable).toBeUndefined();
    expect(body.apiUrl).toBeUndefined();
    expect(body.authMode).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("status : configuré mais injoignable", async () => {
    await seedUserTokenConfig();
    queuesByKey.clear();
    lastByKey.set("GET initSession", { status: 500, body: ["ERROR", "boom"] });
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/status", cookies: viewerCookie() });
    expect(res.json()).toMatchObject({ configured: true, reachable: false, authMode: "user-token" });
    expect(res.json().lastPoll).toMatchObject({ reachable: false });
  });

  it("my-tickets : part de la session QUAI, jamais d'identifiant client", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(42, "Imprimante HS") });

    app = buildServer();
    // Un identifiant injecté dans la query est purement ignoré.
    const res = await app.inject({ method: "GET", url: "/api/glpi/my-tickets?username=autre", cookies: adminCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, account: "found" });
    expect(res.json().tickets).toEqual([
      {
        id: 42,
        title: "Imprimante HS",
        status: 2,
        statusLabel: "En cours (attribué)",
        openedAt: "2026-08-19 09:00:00",
        updatedAt: "2026-08-19 09:30:00",
      },
    ]);
    // La recherche porte bien sur le login de la SESSION.
    expect(decodeURIComponent(callsTo("GET search/User")[0]!.search)).toContain("criteria[0][value]=ybanas");
    expect(decodeURIComponent(callsTo("GET search/Ticket")[0]!.search)).toContain("criteria[0][value]=7");
  });

  it("my-tickets : compte introuvable / ambigu signalés honnêtement", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 0, count: 0, data: [] });
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/api/glpi/my-tickets", cookies: adminCookie() })).json()).toEqual({
      configured: true,
      reachable: true,
      account: "not-found",
      tickets: [],
    });

    queue("GET search/User", {
      totalcount: 2,
      count: 2,
      data: { "7": { "2": 7, "1": "ybanas" }, "9": { "2": 9, "1": "ybanas" } },
    });
    const ambiguous = (await app.inject({ method: "GET", url: "/api/glpi/my-tickets", cookies: adminCookie() })).json();
    expect(ambiguous).toEqual({ configured: true, reachable: true, account: "ambiguous", candidateCount: 2, tickets: [] });
    // Aucun identifiant de compte d'autrui n'est exposé.
    expect(JSON.stringify(ambiguous)).not.toContain("candidateIds");
  });

  it("my-tickets : non configuré -> liste vide honnête, aucun appel réseau", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/my-tickets", cookies: adminCookie() });
    expect(res.json()).toEqual({ configured: false, tickets: [] });
    expect(calls).toHaveLength(0);
  });

  it("détail : renvoie le ticket et ses suivis quand l'utilisateur en est demandeur", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET Ticket/42/Ticket_User", [{ tickets_id: 42, users_id: 7, type: 1 }]);
    queue("GET Ticket/42", { id: 42, name: "Imprimante HS", content: "bourrage", status: 2, date: "2026-08-19 09:00:00" });
    queue("GET Ticket/42/ITILFollowup", [{ id: 5, content: "pris en charge", date: "2026-08-19 10:00:00", users_id: 3 }]);

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/tickets/42", cookies: adminCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 42, title: "Imprimante HS", content: "bourrage", statusLabel: "En cours (attribué)" });
    expect(res.json().followups).toEqual([{ id: 5, content: "pris en charge", date: "2026-08-19 10:00:00", authorId: 3 }]);
  });

  it("détail : 404 si l'utilisateur n'est pas demandeur (sans révéler l'existence du ticket)", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET Ticket/42/Ticket_User", [{ tickets_id: 42, users_id: 99, type: 1 }]);

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/tickets/42", cookies: adminCookie() });
    expect(res.statusCode).toBe(404);
    expect(callsTo("GET Ticket/42")).toHaveLength(0); // le ticket n'est même pas lu
  });

  it("détail : id non numérique rejeté avant tout appel", async () => {
    await seedUserTokenConfig();
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/tickets/abc", cookies: adminCookie() });
    expect(res.statusCode).toBe(400);
    expect(callsTo("GET search/User")).toHaveLength(0);
  });

  it("suivi : ajouté au nom de l'utilisateur connecté, 404 s'il n'est pas demandeur", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET Ticket/42/Ticket_User", [{ tickets_id: 42, users_id: 7, type: 1 }]);
    queue("POST ITILFollowup", { id: 91 }, 201);

    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/glpi/tickets/42/followup",
      cookies: operatorCookie(),
      payload: { content: "toujours en panne" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 91 });
    const body = callsTo("POST ITILFollowup")[0]!.body as { input: Record<string, unknown> };
    expect(body.input).toEqual({ itemtype: "Ticket", items_id: 42, content: "toujours en panne", users_id: 7 });

    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET Ticket/50/Ticket_User", [{ tickets_id: 50, users_id: 99, type: 1 }]);
    const refused = await app.inject({
      method: "POST",
      url: "/api/glpi/tickets/50/followup",
      cookies: operatorCookie(),
      payload: { content: "curieux" },
    });
    expect(refused.statusCode).toBe(404);
  });

  it("config : GET/PUT/DELETE/test réservés à l'admin", async () => {
    app = buildServer();
    const reads = await Promise.all(
      (["/api/glpi/config", "/api/glpi/search-options"] as const).map((url) =>
        app!.inject({ method: "GET", url, cookies: operatorCookie() }),
      ),
    );
    for (const res of reads) expect(res.statusCode).toBe(403);

    for (const [method, url] of [
      ["PUT", "/api/glpi/config"],
      ["POST", "/api/glpi/config/test"],
      ["DELETE", "/api/glpi/config"],
    ] as const) {
      const res = await app.inject({ method, url, cookies: operatorCookie(), payload: {} });
      expect(res.statusCode).toBe(403);
    }
  });

  it("config : PUT teste réellement la connexion avant d'enregistrer", async () => {
    lastByKey.set("GET initSession", { status: 400, body: ["ERROR_WRONG_APP_TOKEN_PARAMETER", "app_token invalide"] });
    app = buildServer();
    const refused = await app.inject({
      method: "PUT",
      url: "/api/glpi/config",
      cookies: adminCookie(),
      payload: { apiUrl: "http://glpi.test/apirest.php", appToken: APP_TOKEN, userToken: USER_TOKEN },
    });
    expect(refused.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/glpi/config", cookies: adminCookie() })).json()).toEqual({
      configured: false,
    });

    lastByKey.set("GET initSession", { status: 200, body: { session_token: SESSION_TOKEN } });
    const accepted = await app.inject({
      method: "PUT",
      url: "/api/glpi/config",
      cookies: adminCookie(),
      payload: { apiUrl: "http://glpi.test/apirest.php", appToken: APP_TOKEN, userToken: USER_TOKEN },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      configured: true,
      config: { apiUrl: "http://glpi.test/apirest.php", authMode: "user-token", hasAppToken: true, hasUserToken: true, hasPassword: false },
    });
  });

  it("config : PUT sans jeton d'application est refusé", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/glpi/config",
      cookies: adminCookie(),
      payload: { apiUrl: "http://glpi.test/apirest.php" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("appToken");
  });
});

describe("GLPI — consultation des tickets d'autrui (/api/glpi/browse/*)", () => {
  const BROWSE_ROUTES = [
    "/api/glpi/browse/accounts",
    "/api/glpi/browse/accounts?q=ybanas",
    "/api/glpi/browse/tickets",
    "/api/glpi/browse/tickets?requesterId=7",
    "/api/glpi/browse/tickets/42",
  ] as const;

  it("un viewer reçoit 403 sur TOUTES les routes browse, sans qu'aucun appel GLPI ne parte", async () => {
    await seedUserTokenConfig();
    app = buildServer();
    for (const url of BROWSE_ROUTES) {
      const res = await app.inject({ method: "GET", url, cookies: viewerCookie() });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toContain("operator or admin");
    }
    expect(calls).toHaveLength(0);
  });

  it("operator et admin y ont accès (rôles élevés du projet, cf. PRIVILEGED_ROLES)", async () => {
    await seedUserTokenConfig();
    lastByKey.set("GET User", { status: 200, body: [userItem(7, "ybanas", "Yann", "Banas")] });
    app = buildServer();
    for (const cookies of [operatorCookie(), adminCookie()]) {
      const res = await app.inject({ method: "GET", url: "/api/glpi/browse/accounts?q=yb", cookies });
      expect(res.statusCode).toBe(200);
    }
  });

  it("recherche de comptes : filtre sur l'identifiant, nom réel affiché, total réel de GLPI", async () => {
    await seedUserTokenConfig();
    queue(
      "GET User",
      [userItem(7, "ybanas", "Yann", "Banas"), userItem(9, "mdupont", "Marie", "Dupont"), { id: 11, name: "" }],
      200,
      { "Content-Range": "0-1/312" },
    );

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/accounts?q=ban&limit=2", cookies: operatorCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, reachable: true, offset: 0, limit: 2, total: 312 });
    // Le compte sans identifiant exploitable est écarté, jamais affiché à moitié.
    expect(res.json().users).toEqual([
      { id: 7, login: "ybanas", firstName: "Yann", lastName: "Banas", displayName: "Yann Banas", active: true },
      { id: 9, login: "mdupont", firstName: "Marie", lastName: "Dupont", displayName: "Marie Dupont", active: true },
    ]);
    const search = searchOf("GET User");
    expect(search).toContain("searchText[name]=ban");
    expect(search).toContain("range=0-1");
  });

  it("recherche de comptes : sans nom réel, l'identifiant fait office de libellé (rien n'est inventé)", async () => {
    await seedUserTokenConfig();
    queue("GET User", [userItem(7, "ybanas")]);
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/accounts", cookies: adminCookie() });
    expect(res.json().users).toEqual([{ id: 7, login: "ybanas", displayName: "ybanas", active: true }]);
    // Aucun total inventé quand GLPI ne renvoie pas de Content-Range.
    expect(res.json().total).toBeUndefined();
  });

  it("pagination RÉELLE des comptes : offset/limit deviennent le range GLPI", async () => {
    await seedUserTokenConfig();
    queue("GET User", [userItem(60, "user60")], 200, { "Content-Range": "50-50/312" });
    app = buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/glpi/browse/accounts?offset=50&limit=25",
      cookies: adminCookie(),
    });
    expect(res.json()).toMatchObject({ offset: 50, limit: 25, total: 312 });
    expect(searchOf("GET User")).toContain("range=50-74");
  });

  it("une page hors bornes (ERROR_RANGE_EXCEED_TOTAL) est une page vide, jamais une panne", async () => {
    await seedUserTokenConfig();
    queue("GET User", ["ERROR_RANGE_EXCEED_TOTAL", "hors bornes"], 400);
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/accounts?offset=9000", cookies: adminCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ users: [], offset: 9000 });
  });

  it("offset/limit invalides ou hors plafond -> 400 avant tout appel GLPI", async () => {
    await seedUserTokenConfig();
    app = buildServer();
    for (const url of [
      "/api/glpi/browse/accounts?limit=201",
      "/api/glpi/browse/accounts?limit=abc",
      "/api/glpi/browse/accounts?offset=-1",
      "/api/glpi/browse/tickets?limit=5000",
      "/api/glpi/browse/tickets?requesterId=abc",
      "/api/glpi/browse/tickets?requesterId=0",
      "/api/glpi/browse/tickets/abc",
    ]) {
      const res = await app.inject({ method: "GET", url, cookies: adminCookie() });
      expect(res.statusCode, url).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("tickets d'un compte donné : critère demandeur = l'id demandé, pagination et total réels", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", {
      totalcount: 137,
      count: 2,
      data: {
        ...ticketRowWithRequester(42, "Imprimante HS", "Marie Dupont"),
        ...ticketRowWithRequester(43, "VPN lent", ["Marie Dupont", "Jean Martin"]),
      },
    });

    app = buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/glpi/browse/tickets?requesterId=9&offset=25&limit=25",
      cookies: operatorCookie(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: "requester", requesterId: 9, offset: 25, limit: 25, total: 137 });
    expect(res.json().tickets[0]).toMatchObject({ id: 42, title: "Imprimante HS", requesterLabel: "Marie Dupont" });
    // Plusieurs demandeurs : GLPI renvoie un tableau, repris tel quel sans en choisir un.
    expect(res.json().tickets[1].requesterLabel).toBe("Marie Dupont, Jean Martin");

    const search = searchOf("GET search/Ticket");
    expect(search).toContain("criteria[0][field]=4");
    expect(search).toContain("criteria[0][searchtype]=equals");
    expect(search).toContain("criteria[0][value]=9");
    expect(search).toContain("range=25-49");
  });

  it("tous les tickets : aucun critère de demandeur, mais toujours un range borné", async () => {
    await seedUserTokenConfig();
    queue("GET search/Ticket", { totalcount: 3412, count: 1, data: ticketRow(1, "Doléance") });

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/tickets?limit=50", cookies: adminCookie() });
    expect(res.json()).toMatchObject({ scope: "all", offset: 0, limit: 50, total: 3412 });
    expect(res.json().requesterId).toBeUndefined();

    const search = searchOf("GET search/Ticket");
    expect(search).not.toContain("criteria[0]");
    expect(search).toContain("range=0-49");
    // Le demandeur est demandé en affichage pour que la vue globale reste lisible.
    expect(search).toContain("forcedisplay");
    expect(search).toContain("=4");
  });

  it("détail d'un ticket d'autrui : lu sans restriction de demandeur, demandeurs exposés", async () => {
    await seedUserTokenConfig();
    queue("GET Ticket/42", { id: 42, name: "Imprimante HS", content: "bourrage", status: 2, date: "2026-08-19 09:00:00" });
    queue("GET Ticket/42/ITILFollowup", [{ id: 5, content: "pris en charge", date: "2026-08-19 10:00:00", users_id: 3 }]);
    queue("GET Ticket/42/Ticket_User", [
      { tickets_id: 42, users_id: 9, type: 1 },
      { tickets_id: 42, users_id: 3, type: 2 },
    ]);

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/tickets/42", cookies: operatorCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 42, title: "Imprimante HS", content: "bourrage", requesterIds: [9] });
    // Aucun rapprochement du compte QUAI n'est nécessaire : on ne cherche pas l'utilisateur connecté.
    expect(callsTo("GET search/User")).toHaveLength(0);
  });

  it("détail : un ticket inconnu de GLPI -> 404, jamais 502", async () => {
    await seedUserTokenConfig();
    queue("GET Ticket/9999", ["ERROR_ITEM_NOT_FOUND", "Item not found"], 404);
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/browse/tickets/9999", cookies: adminCookie() });
    expect(res.statusCode).toBe(404);
  });

  it("aucune écriture : parcourir comptes, tickets et détail ne produit que des GET", async () => {
    await seedUserTokenConfig();
    lastByKey.set("GET User", { status: 200, body: [userItem(9, "mdupont", "Marie", "Dupont")] });
    lastByKey.set("GET search/Ticket", { status: 200, body: { totalcount: 1, count: 1, data: ticketRow(42, "Imprimante HS") } });
    lastByKey.set("GET Ticket/42", { status: 200, body: { id: 42, name: "Imprimante HS", content: "bourrage" } });
    lastByKey.set("GET Ticket/42/ITILFollowup", { status: 200, body: [] });
    lastByKey.set("GET Ticket/42/Ticket_User", { status: 200, body: [{ users_id: 9, type: 1 }] });

    app = buildServer();
    for (const url of ["/api/glpi/browse/accounts?q=du", "/api/glpi/browse/tickets?requesterId=9", "/api/glpi/browse/tickets/42"]) {
      expect((await app.inject({ method: "GET", url, cookies: adminCookie() })).statusCode).toBe(200);
    }
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("GLPI non configuré -> 503 sans aucun appel réseau", async () => {
    app = buildServer();
    for (const url of BROWSE_ROUTES) {
      const res = await app.inject({ method: "GET", url, cookies: adminCookie() });
      expect(res.statusCode, url).toBe(503);
    }
    expect(calls).toHaveLength(0);
  });

  it("GLPI injoignable -> 502 portant reachable:false, jamais une liste vide trompeuse", async () => {
    await seedUserTokenConfig();
    lastByKey.set("GET initSession", { status: 500, body: ["ERROR", "boom"] });
    app = buildServer();

    const accounts = await app.inject({ method: "GET", url: "/api/glpi/browse/accounts", cookies: adminCookie() });
    expect(accounts.statusCode).toBe(502);
    expect(accounts.json()).toMatchObject({ configured: true, reachable: false, users: [] });

    const tickets = await app.inject({ method: "GET", url: "/api/glpi/browse/tickets?requesterId=9", cookies: adminCookie() });
    expect(tickets.statusCode).toBe(502);
    expect(tickets.json()).toMatchObject({ configured: true, reachable: false, tickets: [] });

    const detail = await app.inject({ method: "GET", url: "/api/glpi/browse/tickets/42", cookies: adminCookie() });
    expect(detail.statusCode).toBe(502);
  });

  it("l'accès aux tickets d'un tiers est journalisé — succès comme refus", async () => {
    await seedUserTokenConfig();
    lastByKey.set("GET search/Ticket", { status: 200, body: { totalcount: 0, count: 0, data: [] } });
    lastByKey.set("GET User", { status: 200, body: [] });
    app = buildServer();

    const before = await auditIds();
    await app.inject({ method: "GET", url: "/api/glpi/browse/tickets?requesterId=9", cookies: adminCookie() });
    await app.inject({ method: "GET", url: "/api/glpi/browse/tickets", cookies: adminCookie() });
    await app.inject({ method: "GET", url: "/api/glpi/browse/tickets/42", cookies: viewerCookie() });
    await app.inject({ method: "GET", url: "/api/glpi/browse/accounts", cookies: adminCookie() });
    const events = await browseAuditEvents(before, 3);

    // La recherche de comptes n'est pas dans la liste : seul l'accès aux TICKETS d'un tiers l'est.
    expect(events.map((e) => `${e.actor} ${e.path} ${e.statusCode}`).sort()).toEqual([
      "viewer /api/glpi/browse/tickets/42 403",
      "ybanas /api/glpi/browse/tickets?requesterId=9 200",
      "ybanas /api/glpi/browse/tickets?scope=all 200",
    ]);
  });

  it("/my-tickets ignore TOUT identifiant fourni par le client, y compris requesterId", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(42, "Imprimante HS") });

    app = buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/glpi/my-tickets?requesterId=9&userId=9&username=mdupont&scope=all",
      cookies: adminCookie(),
    });
    expect(res.statusCode).toBe(200);
    // Le login cherché est celui de la SESSION, et le demandeur est l'id qui en découle.
    expect(searchOf("GET search/User")).toContain("criteria[0][value]=ybanas");
    const ticketSearch = searchOf("GET search/Ticket");
    expect(ticketSearch).toContain("criteria[0][value]=7");
    expect(ticketSearch).not.toContain("criteria[0][value]=9");
  });

  it("un viewer garde ses propres tickets : /my-tickets et /tickets/:id lui restent ouverts", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "3": { "2": 3, "1": "viewer" } } });
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(11, "Souris HS") });

    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/my-tickets", cookies: viewerCookie() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ account: "found" });
    expect(searchOf("GET search/Ticket")).toContain("criteria[0][value]=3");
  });
});

describe("GLPI — aucun secret ne ressort jamais", () => {
  const SECRETS = [APP_TOKEN, USER_TOKEN, SERVICE_PASSWORD];

  function expectNoSecret(payload: string): void {
    for (const secret of SECRETS) expect(payload).not.toContain(secret);
    // Pas même un fragment : un préfixe de 8 caractères ne doit pas fuiter non plus.
    for (const secret of SECRETS) expect(payload).not.toContain(secret.slice(0, 8));
  }

  it("ni GET /config, ni /status, ni /my-tickets ne contiennent un secret", async () => {
    await seedCredentialsConfig();
    queue("GET search/User", { totalcount: 1, count: 1, data: { "7": { "2": 7, "1": "ybanas" } } });
    queue("GET search/Ticket", { totalcount: 1, count: 1, data: ticketRow(42, "Imprimante HS") });

    app = buildServer();
    for (const url of ["/api/glpi/config", "/api/glpi/status", "/api/glpi/my-tickets"]) {
      const res = await app.inject({ method: "GET", url, cookies: adminCookie() });
      expectNoSecret(res.body);
    }
    // Le compte de service (non secret) reste visible pour l'admin, le mot de passe jamais.
    const cfg = (await app.inject({ method: "GET", url: "/api/glpi/config", cookies: adminCookie() })).json();
    expect(cfg.config).toMatchObject({ authMode: "credentials", username: "svc-quai", hasPassword: true });
  });

  it("un message d'erreur renvoyé par GLPI qui contiendrait le jeton est caviardé", async () => {
    lastByKey.set("GET initSession", {
      status: 400,
      body: ["ERROR_WRONG_APP_TOKEN_PARAMETER", `parameter app_token=${APP_TOKEN} seems invalid`],
    });
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/glpi/config/test",
      cookies: adminCookie(),
      payload: { apiUrl: "http://glpi.test/apirest.php", appToken: APP_TOKEN, userToken: USER_TOKEN },
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().message).toContain("ERROR_WRONG_APP_TOKEN_PARAMETER");
    expect(res.json().message).toContain("***");
    expectNoSecret(res.body);
  });

  it("une erreur remontée par /my-tickets ne contient aucun secret", async () => {
    await seedUserTokenConfig();
    queue("GET search/User", ["ERROR_RIGHT_MISSING", `session ouverte avec ${USER_TOKEN}`], 403);
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/glpi/my-tickets", cookies: adminCookie() });
    expect(res.statusCode).toBe(502);
    expectNoSecret(res.body);
  });
});
