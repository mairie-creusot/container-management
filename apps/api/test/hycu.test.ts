import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Intégration HYCU (LECTURE SEULE) — services/hycu.ts + routes/hycu.ts.
 *
 * Même montage EXACT que nutanixVmConfig.test.ts (isolement CONFIG_PATH, mock node:https routé
 * par `${method} ${pathname}`, buildServer()+inject() de bout en bout). AUCUN test ne touche
 * l'appliance HYCU réelle (production de la mairie) : tout est exercé contre des réponses
 * mockées dont chaque forme est sourcée ci-dessous.
 *
 * Provenance des formes mockées — honnêteté totale (voir services/hycu.ts, en-tête) :
 *  - Enveloppe { entities, metadata: { totalEntityCount } } + pagination pageSize/pageNumber
 *    (démarre à 1) : tusc/hycu#search_backups.py (fonction huRestEnt/boucle "pageNumber = 1",
 *    condition d'arrêt len(items) == data['metadata']['totalEntityCount']).
 *  - /vms : uuid, vmName, protectionGroupUuid — tusc/hycu#list_vm_backups_by_policy.sh
 *    (jq ".entities[] | select (.protectionGroupUuid==...)", ".entities[].vmName").
 *  - /policies : uuid, name — même script (jq ".entities[] | select (.name==...) | .uuid").
 *  - /targets : name, totalSizeInBytes, freeSizeInBytes (get_target_pct.py : used = total - free),
 *    totalUtilizationPct (get_target_pct.sh : jq ".entities[].totalUtilizationPct").
 *  - /jobs : status EXECUTING/OK/WARNING/ERROR — tusc/hycu#get_error_warn.py, search_backups.py.
 *  - /events : severity ERROR/WARNING — tusc/hycu#get_error_warn.sh
 *    (jq ".entities[] | select (.severity==\"ERROR\" or .severity==\"WARNING\")").
 *  - Chemins /rest/v1.0/{vms,policies,targets,jobs,events} confirmés EN CONDITIONS RÉELLES le
 *    18/08/2026 sur l'appliance 172.20.0.100:8443 (v5.2.1-1025) par leurs 401 sans identifiants ;
 *    /rest/v1.0/dashboard n'existe PAS (404) — d'où le résumé calculé testé plus bas.
 *  - Champs par-VM protectionStatus/complianceStatus/lastBackupInMillis et métadonnées de
 *    jobs/events au-delà de status/severity : SUPPOSÉS (mappés seulement si présents) — les mocks
 *    les incluent pour exercer le passthrough, à confirmer avec identifiants réels.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockResponse {
  status: number;
  body: unknown;
}

const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();
const seenSearchParamsByKey = new Map<string, string[]>();

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

vi.mock("node:https", () => ({
  request: (target: URL, options: { method?: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    const key = `${options.method ?? "GET"} ${target.pathname}`;
    const seen = seenSearchParamsByKey.get(key) ?? [];
    seen.push(target.search);
    seenSearchParamsByKey.set(key, seen);
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const found = nextResponse(key);
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setHycuConfig, getCurrent, getEffectiveHycuConfig, getSafeIntegrationConfig } = await import(
  "../src/services/setupStore.js"
);
const { HYCU_PLUGIN_ID, loadHycuPluginConfig, removeHycuPluginConfig, saveHycuPluginConfig } = await import(
  "../src/plugins/hycu/config.js"
);
const { getHycuTopologySnapshot, hycuVmProtectionState, lastKnownHycuPoll } = await import("../src/services/hycu.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  queuesByKey.clear();
  lastByKey.clear();
  seenSearchParamsByKey.clear();
  // Retire l'entrée du greffon ET tout reliquat du champ typé : aucun test n'hérite d'une appliance.
  await removeHycuPluginConfig();
});

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

const POLICY_GOLD = "11111111-aaaa-4bbb-8ccc-000000000001";
const POLICY_BRONZE = "11111111-aaaa-4bbb-8ccc-000000000002";

/** Config du GREFFON "hycu" — la voie normale depuis la migration (stockage générique). */
async function seedHycuConfig(): Promise<void> {
  await saveHycuPluginConfig({ url: "https://172.20.0.100:8443", username: "quai-ro", password: "hycu-secret" });
}

/** Config telle qu'une version ANTÉRIEURE au greffon l'écrivait : champ typé `hycu`. */
async function seedLegacyHycuConfig(): Promise<void> {
  await setHycuConfig({ url: "https://172.20.0.100:8443", username: "quai-ro", password: "hycu-secret" });
}

/** Formes /vms — champs confirmés (uuid/vmName/protectionGroupUuid) + supposés (voir en-tête). */
function seedVms(): void {
  queueResponse("GET /rest/v1.0/vms", {
    entities: [
      {
        uuid: "vm-1",
        vmName: "HDVAPPLI",
        protectionGroupUuid: POLICY_GOLD,
        protectionStatus: "PROTECTED",
        complianceStatus: "GREEN",
        lastBackupInMillis: 1755400000000,
      },
      { uuid: "vm-2", vmName: "HDVEXCH", protectionGroupUuid: POLICY_BRONZE },
      // protectionGroupUuid null : VM découverte mais non protégée (forme cohérente avec le
      // "select (.protectionGroupUuid==...)" de list_vm_backups_by_policy.sh).
      { uuid: "vm-3", vmName: "HDVTEST", protectionGroupUuid: null },
    ],
    metadata: { totalEntityCount: 3 },
  });
}

function seedPolicies(): void {
  queueResponse("GET /rest/v1.0/policies", {
    entities: [
      { uuid: POLICY_GOLD, name: "Gold" },
      { uuid: POLICY_BRONZE, name: "Bronze" },
    ],
    metadata: { totalEntityCount: 2 },
  });
}

/** Formes /targets — get_target_pct.py (totalSizeInBytes/freeSizeInBytes, used = total - free)
 * + get_target_pct.sh (totalUtilizationPct). Noms inspirés du dashboard réel observé. */
function seedTargets(): void {
  queueResponse("GET /rest/v1.0/targets", {
    entities: [
      { uuid: "target-1", name: "STORWIZE", type: "SMB", totalSizeInBytes: 1000, freeSizeInBytes: 120, totalUtilizationPct: 88 },
      // Sans totalUtilizationPct : le service calcule (used/total)*100 = 50 (calcul de
      // get_target_pct.py), jamais un pourcentage inventé.
      { uuid: "target-2", name: "HDVEXA", totalSizeInBytes: 200, freeSizeInBytes: 100 },
    ],
    metadata: { totalEntityCount: 2 },
  });
}

/** Formes /jobs — statuts réels EXECUTING/OK/WARNING/ERROR (get_error_warn.py). */
function seedJobs(): void {
  queueResponse("GET /rest/v1.0/jobs", {
    entities: [
      { uuid: "job-1", name: "Backup HDVAPPLI", type: "BACKUP", status: "OK", startTimeInMillis: 1755400000000, endTimeInMillis: 1755400100000 },
      { uuid: "job-2", status: "ERROR" },
      { uuid: "job-3", status: "OK" },
      { uuid: "job-4", status: "WARNING" },
      // Sans status : filtré (jamais un job sans statut réel dans la réponse QUAI).
      { uuid: "job-5" },
    ],
    metadata: { totalEntityCount: 5 },
  });
}

/** Formes /events — severity ERROR/WARNING (get_error_warn.sh) ; message/created supposés. */
function seedEvents(): void {
  queueResponse("GET /rest/v1.0/events", {
    entities: [
      { uuid: "event-1", severity: "WARNING", message: "Target NASCTM almost full", createdInMillis: 1755400000000 },
      { uuid: "event-2", severity: "INFO" },
    ],
    metadata: { totalEntityCount: 2 },
  });
}

describe("Routes HYCU — autorisation", () => {
  it("401 sans session sur toutes les routes de lecture", async () => {
    app = buildServer();
    for (const url of ["/api/hycu/status", "/api/hycu/vms", "/api/hycu/policies", "/api/hycu/targets", "/api/hycu/jobs", "/api/hycu/events", "/api/hycu/config"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("lecture accessible à un rôle viewer (tout rôle authentifié)", async () => {
    app = buildServer();
    for (const url of ["/api/hycu/status", "/api/hycu/vms", "/api/hycu/policies", "/api/hycu/targets", "/api/hycu/jobs", "/api/hycu/events", "/api/hycu/config"]) {
      const response = await app.inject({ method: "GET", url, cookies: viewerCookie() });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it("403 pour un rôle viewer sur la config (PUT/POST test/DELETE)", async () => {
    app = buildServer();
    for (const [method, url] of [
      ["PUT", "/api/hycu/config"],
      ["POST", "/api/hycu/config/test"],
      ["DELETE", "/api/hycu/config"],
    ] as const) {
      const response = await app.inject({ method, url, cookies: viewerCookie(), payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("Routes HYCU — jamais configuré (aucune donnée inventée)", () => {
  it("[] sur les listes, { configured: false } sur status et config", async () => {
    app = buildServer();
    for (const url of ["/api/hycu/vms", "/api/hycu/policies", "/api/hycu/targets", "/api/hycu/jobs", "/api/hycu/events"]) {
      const response = await app.inject({ method: "GET", url, cookies: adminCookie() });
      expect(response.json(), url).toEqual([]);
    }
    const status = await app.inject({ method: "GET", url: "/api/hycu/status", cookies: adminCookie() });
    expect(status.json()).toMatchObject({ configured: false });
    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });
});

describe("Service HYCU — parsing des formes tusc/hycu", () => {
  it("GET /api/hycu/vms : policy résolue par jointure, champs supposés en passthrough", async () => {
    await seedHycuConfig();
    seedVms();
    seedPolicies();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        uuid: "vm-1",
        vmName: "HDVAPPLI",
        protectionGroupUuid: POLICY_GOLD,
        policyName: "Gold",
        protectionStatus: "PROTECTED",
        complianceStatus: "GREEN",
        lastBackupInMillis: 1755400000000,
      },
      { uuid: "vm-2", vmName: "HDVEXCH", protectionGroupUuid: POLICY_BRONZE, policyName: "Bronze" },
      { uuid: "vm-3", vmName: "HDVTEST" },
    ]);
  });

  it("GET /api/hycu/vms : `compliancyStatus` (champ réel du contrôleur) l'emporte sur l'ancien nom supposé", async () => {
    await seedHycuConfig();
    queueResponse("GET /rest/v1.0/vms", {
      entities: [
        // Forme RÉELLE : externalId (uuid hyperviseur) + compliancyStatus.
        {
          uuid: "objet-hycu-1",
          externalId: "aaaaaaaa-1111-4222-8333-444444444444",
          vmName: "HDVAPPLI",
          protectionGroupUuid: POLICY_GOLD,
          compliancyStatus: "COMPLIANT",
          complianceStatus: "GREEN",
        },
      ],
      metadata: { totalEntityCount: 1 },
    });
    seedPolicies();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(response.json()).toEqual([
      {
        uuid: "objet-hycu-1",
        externalId: "aaaaaaaa-1111-4222-8333-444444444444",
        vmName: "HDVAPPLI",
        protectionGroupUuid: POLICY_GOLD,
        policyName: "Gold",
        complianceStatus: "COMPLIANT",
      },
    ]);
  });

  it("GET /api/hycu/policies : vmCount calculé (mécanisme list_vm_backups_by_policy.sh), jamais lu d'un champ supposé", async () => {
    await seedHycuConfig();
    seedVms();
    seedPolicies();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/policies", cookies: viewerCookie() });
    expect(response.json()).toEqual([
      { uuid: POLICY_GOLD, name: "Gold", vmCount: 1 },
      { uuid: POLICY_BRONZE, name: "Bronze", vmCount: 1 },
    ]);
  });

  it("GET /api/hycu/targets : used = total - free (calcul get_target_pct.py), pct réel prioritaire sur le calcul", async () => {
    await seedHycuConfig();
    seedTargets();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/targets", cookies: viewerCookie() });
    expect(response.json()).toEqual([
      { uuid: "target-1", name: "STORWIZE", type: "SMB", totalSizeInBytes: 1000, freeSizeInBytes: 120, usedSizeInBytes: 880, utilizationPct: 88 },
      { uuid: "target-2", name: "HDVEXA", totalSizeInBytes: 200, freeSizeInBytes: 100, usedSizeInBytes: 100, utilizationPct: 50 },
    ]);
  });

  it("GET /api/hycu/jobs : statuts réels, un job sans status est filtré", async () => {
    await seedHycuConfig();
    seedJobs();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/jobs", cookies: viewerCookie() });
    const jobs = response.json() as Array<{ uuid?: string; status: string }>;
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toEqual({
      uuid: "job-1",
      name: "Backup HDVAPPLI",
      type: "BACKUP",
      status: "OK",
      startTimeInMillis: 1755400000000,
      endTimeInMillis: 1755400100000,
    });
    expect(jobs.map((j) => j.status)).toEqual(["OK", "ERROR", "OK", "WARNING"]);
  });

  it("GET /api/hycu/events : severity obligatoire (un event sans severity est filtré), message en passthrough", async () => {
    await seedHycuConfig();
    seedEvents();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/events", cookies: viewerCookie() });
    expect(response.json()).toEqual([
      { uuid: "event-1", severity: "WARNING", message: "Target NASCTM almost full", createdInMillis: 1755400000000 },
      { uuid: "event-2", severity: "INFO" },
    ]);
  });

  it("GET /api/hycu/status : résumé calculé (protectedCount, byStatus, sommes targets) — /dashboard n'existe pas (404 réel observé)", async () => {
    await seedHycuConfig();
    seedVms();
    seedPolicies();
    seedTargets();
    seedJobs();
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/status", cookies: viewerCookie() });
    expect(response.json()).toMatchObject({
      configured: true,
      reachable: true,
      vms: { total: 3, protectedCount: 2 },
      policies: { count: 2 },
      targets: { count: 2, totalSizeInBytes: 1200, usedSizeInBytes: 980 },
      jobs: { total: 4, byStatus: { OK: 2, ERROR: 1, WARNING: 1 } },
    });
    expect(response.json().lastPoll).toMatchObject({ reachable: true });
  });

  it("pagination : suit metadata.totalEntityCount sur plusieurs pages (pageNumber démarre à 1 — search_backups.py)", async () => {
    await seedHycuConfig();
    const page1 = Array.from({ length: 500 }, (_, i) => ({ uuid: `vm-${i}`, vmName: `VM${i}` }));
    queueResponse("GET /rest/v1.0/vms", { entities: page1, metadata: { totalEntityCount: 502 } });
    queueResponse("GET /rest/v1.0/vms", { entities: [{ uuid: "vm-500", vmName: "VM500" }, { uuid: "vm-501", vmName: "VM501" }], metadata: { totalEntityCount: 502 } });
    queueResponse("GET /rest/v1.0/policies", { entities: [], metadata: { totalEntityCount: 0 } });
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(response.json()).toHaveLength(502);
    const searches = seenSearchParamsByKey.get("GET /rest/v1.0/vms") ?? [];
    expect(searches).toEqual(["?pageSize=500&pageNumber=1", "?pageSize=500&pageNumber=2"]);
  });

  it("configuré mais injoignable : [] + status { configured: true, reachable: false } — jamais de fausses données", async () => {
    await seedHycuConfig();
    queueResponse("GET /rest/v1.0/vms", { message: "boom" }, 500);
    queueResponse("GET /rest/v1.0/policies", { message: "boom" }, 500);
    queueResponse("GET /rest/v1.0/targets", { message: "boom" }, 500);
    queueResponse("GET /rest/v1.0/jobs", { message: "boom" }, 500);
    app = buildServer();
    const vms = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(vms.json()).toEqual([]);
    const status = await app.inject({ method: "GET", url: "/api/hycu/status", cookies: viewerCookie() });
    expect(status.json()).toMatchObject({ configured: true, reachable: false });
    expect(status.json().vms).toBeUndefined();
  });
});

describe("Config HYCU — test réel avant persistance, chiffrement au repos, jamais de secret renvoyé", () => {
  it("PUT /api/hycu/config : 400 si HYCU refuse les identifiants (401 amont), rien n'est persisté", async () => {
    queueResponse("GET /rest/v1.0/vms", { message: { titleDescriptionEn: "Invalid username or password" } }, 401);
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/hycu/config",
      cookies: adminCookie(),
      payload: { url: "https://172.20.0.100:8443", username: "quai-ro", password: "wrong" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("401");
    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("PUT /api/hycu/config : teste (GET /rest/v1.0/vms léger), persiste chiffré, ne renvoie jamais le mot de passe", async () => {
    queueResponse("GET /rest/v1.0/vms", { entities: [{ uuid: "vm-1", vmName: "HDVAPPLI" }], metadata: { totalEntityCount: 49 } });
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/hycu/config",
      cookies: adminCookie(),
      payload: { url: "https://172.20.0.100:8443", username: "quai-ro", password: "hycu-secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true, config: { url: "https://172.20.0.100:8443", username: "quai-ro" } });
    expect(JSON.stringify(response.json())).not.toContain("hycu-secret");

    // Chiffré AU REPOS : le fichier config.json ne contient jamais le mot de passe en clair.
    // Depuis la migration, la config vit sous l'identifiant du greffon (integrations.hycu).
    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain("hycu-secret");
    const onDisk = JSON.parse(raw) as {
      hycu?: unknown;
      integrations?: Record<string, { config?: { url?: string; password?: string }; secretFields?: string[] }>;
    };
    expect(onDisk.hycu).toBeUndefined();
    const entry = onDisk.integrations?.[HYCU_PLUGIN_ID];
    expect(entry?.config?.url).toBe("https://172.20.0.100:8443");
    expect(entry?.config?.password).toMatch(/^enc:v1:/);
    expect(entry?.secretFields).toEqual(["password"]);

    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: true, config: { url: "https://172.20.0.100:8443", username: "quai-ro" } });
  });

  it("PUT /api/hycu/config : password absent = conserver l'existant (changer l'URL sans ressaisir)", async () => {
    await seedHycuConfig();
    queueResponse("GET /rest/v1.0/vms", { entities: [], metadata: { totalEntityCount: 0 } });
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/hycu/config",
      cookies: adminCookie(),
      payload: { url: "https://hycu.lecreusot.fr:8443", username: "quai-ro" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().config.url).toBe("https://hycu.lecreusot.fr:8443");
    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain("hycu-secret");
    const stored = (JSON.parse(raw) as { integrations?: Record<string, { config?: { password?: string } }> })
      .integrations?.[HYCU_PLUGIN_ID];
    expect(stored?.config?.password).toMatch(/^enc:v1:/);
    // Le mot de passe conservé est bien l'ancien, réellement déchiffrable.
    expect(await loadHycuPluginConfig()).toMatchObject({ url: "https://hycu.lecreusot.fr:8443", password: "hycu-secret" });
  });

  it("POST /api/hycu/config/test : teste sans persister (config candidate ou existante)", async () => {
    queueResponse("GET /rest/v1.0/vms", { entities: [], metadata: { totalEntityCount: 12 } });
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/hycu/config/test",
      cookies: adminCookie(),
      payload: { url: "https://172.20.0.100:8443", username: "quai-ro", password: "candidate" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, vmCount: 12 });
    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("DELETE /api/hycu/config : retour à jamais configuré", async () => {
    await seedHycuConfig();
    app = buildServer();
    const response = await app.inject({ method: "DELETE", url: "/api/hycu/config", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
    const vms = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(vms.json()).toEqual([]);
  });
});

/**
 * Reprise de la configuration écrite AVANT la migration en greffon (champ typé `hycu`) — même
 * discipline exacte que 3CX : recopie sous l'identifiant du greffon, puis RETRAIT du champ typé.
 */
describe("Config HYCU — reprise du champ typé par le greffon", () => {
  it("une appliance configurée avant la migration reste jointe sans ressaisie", async () => {
    await seedLegacyHycuConfig();
    seedVms();
    seedPolicies();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/hycu/vms", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBe(3);
  });

  it("le champ typé est RETIRÉ une fois repris — plus aucune config de secours sur disque", async () => {
    await seedLegacyHycuConfig();
    await loadHycuPluginConfig();

    expect((await getCurrent()).hycu).toBeUndefined();
    expect(await getEffectiveHycuConfig()).toBeNull();
    expect(await loadHycuPluginConfig()).toMatchObject({
      url: "https://172.20.0.100:8443",
      username: "quai-ro",
      password: "hycu-secret",
    });
  });

  it("le secret repris est chiffré au repos et ne ressort jamais de la vue sûre", async () => {
    await seedLegacyHycuConfig();
    await loadHycuPluginConfig();

    const entry = (await getCurrent()).integrations?.[HYCU_PLUGIN_ID];
    expect(entry?.secretFields).toEqual(["password"]);
    expect(String(entry?.config.password).startsWith("enc:v1:")).toBe(true);

    const safe = await getSafeIntegrationConfig(HYCU_PLUGIN_ID);
    expect(safe?.config).toMatchObject({ url: "https://172.20.0.100:8443", username: "quai-ro", hasPassword: true });
    expect(JSON.stringify(safe)).not.toContain("hycu-secret");
  });

  it("une config de greffon déjà écrite l'emporte sur le champ typé, qui est retiré sans être lu", async () => {
    await seedHycuConfig();
    await setHycuConfig({ url: "https://ancienne-appliance:8443", username: "ancien", password: "ancien-secret" });

    expect(await loadHycuPluginConfig()).toMatchObject({ url: "https://172.20.0.100:8443", username: "quai-ro" });
    expect((await getCurrent()).hycu).toBeUndefined();
  });

  it("retirer la configuration ne fait pas ressusciter le champ typé", async () => {
    await seedLegacyHycuConfig();
    app = buildServer();

    const del = await app.inject({ method: "DELETE", url: "/api/hycu/config", cookies: adminCookie() });
    expect(del.json()).toEqual({ ok: true });

    const cfg = await app.inject({ method: "GET", url: "/api/hycu/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
    expect((await getCurrent()).hycu).toBeUndefined();
    expect(await loadHycuPluginConfig()).toBeNull();
  });
});

/**
 * Instantané dédié au graphe de topologie + règle de protection par VM (services/hycu.ts) —
 * toujours contre les mêmes réponses mockées, jamais l'appliance réelle.
 */
describe("getHycuTopologySnapshot / hycuVmProtectionState — projection graphe (lecture seule)", () => {
  it("null tant que HYCU n'a jamais été configuré : aucun appel réseau, donc aucun nœud possible", async () => {
    const snapshot = await getHycuTopologySnapshot();
    expect(snapshot).toBeNull();
    expect(seenSearchParamsByKey.size).toBe(0);
  });

  it("un SEUL poll alimente nœud + arêtes : VMs avec policy résolue et compteurs réels", async () => {
    await seedHycuConfig();
    seedVms();
    seedPolicies();
    seedTargets();
    seedJobs();

    const snapshot = await getHycuTopologySnapshot();

    expect(snapshot).toMatchObject({ url: "https://172.20.0.100:8443", reachable: true, lastBackupFieldPresent: true });
    expect(snapshot?.counts).toEqual({ vms: 3, protectedVms: 2, policies: 2, targets: 2, recentJobs: 4, failedJobs: 1 });
    expect(snapshot?.vms.find((v) => v.uuid === "vm-1")).toMatchObject({ vmName: "HDVAPPLI", policyName: "Gold" });
    expect(snapshot?.vms.find((v) => v.uuid === "vm-3")?.protectionGroupUuid).toBeUndefined();
  });

  it("configuré mais injoignable : reachable false, aucune VM, aucun compteur inventé", async () => {
    await seedHycuConfig();
    queueResponse("GET /rest/v1.0/vms", { message: "boom" }, 500);

    const snapshot = await getHycuTopologySnapshot();

    expect(snapshot).toMatchObject({ reachable: false, vms: [], lastBackupFieldPresent: false });
    expect(snapshot?.counts).toBeUndefined();
    expect(lastKnownHycuPoll()).toMatchObject({ reachable: false });
  });

  it("état de protection dérivé des SEULS champs réellement renvoyés", () => {
    // Aucune policy assignée (champ confirmé) -> non protégée.
    expect(hycuVmProtectionState({ uuid: "a", vmName: "A" }, true)).toBe("unprotected");
    // Conformité hors valeurs saines -> non conforme (même convention que la page Sauvegardes).
    expect(
      hycuVmProtectionState({ uuid: "b", vmName: "B", protectionGroupUuid: "p", complianceStatus: "NOT_COMPLIANT" }, true),
    ).toBe("non-compliant");
    expect(hycuVmProtectionState({ uuid: "c", vmName: "C", protectionGroupUuid: "p", complianceStatus: "GREEN" }, false)).toBe(
      "protected",
    );
    // Date absente ALORS que HYCU la renseigne ailleurs dans le même poll -> jamais sauvegardée.
    expect(hycuVmProtectionState({ uuid: "d", vmName: "D", protectionGroupUuid: "p" }, true)).toBe("never-backed-up");
    // Date absente et champ jamais renseigné par cette API : on ne conclut RIEN de négatif.
    expect(hycuVmProtectionState({ uuid: "e", vmName: "E", protectionGroupUuid: "p" }, false)).toBe("protected");
  });
});
