import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Intégration ExaGrid (LECTURE SEULE) — services/exagrid.ts + routes/exagrid.ts.
 *
 * ExaGrid n'expose AUCUNE API REST : la seule interface est SNMP (EXAGRID-MIB, entreprise
 * 1.3.6.1.4.1.14941). Le module `net-snmp` est INTÉGRALEMENT mocké ici : aucune socket UDP n'est
 * ouverte, aucun paquet ne part vers l'appliance réelle de la mairie. L'agent simulé répond
 * `noSuchInstance` (type 129) pour tout OID non explicitement semé — exactement comme un agent
 * qui n'implémente pas l'objet demandé — pour exercer le chemin "valeur absente".
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-exagrid-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockVarbind {
  oid: string;
  type?: number;
  value?: number | string | bigint | null;
}

const OBJECT_TYPE = { Integer: 2, Gauge: 66, TimeTicks: 67, NoSuchObject: 128, NoSuchInstance: 129, EndOfMibView: 130 };

const seeded = new Map<string, MockVarbind>();
const sessionCalls: Array<{ kind: "v2c" | "v3"; target: string; community?: string; user?: unknown; options: Record<string, unknown> }> = [];
const getCalls: string[][] = [];
let setCallCount = 0;
let closeCount = 0;
let pendingError: Error | null = null;

function seedOid(oid: string, value: number, type = OBJECT_TYPE.Gauge): void {
  seeded.set(oid, { oid, type, value });
}

vi.mock("net-snmp", () => {
  function makeSession() {
    return {
      get(oids: string[], callback: (error: Error | null, varbinds?: MockVarbind[]) => void) {
        getCalls.push(oids);
        // Asynchrone comme la vraie lib (le callback ne doit jamais être rappelé après close()).
        setTimeout(() => {
          if (pendingError) return callback(pendingError);
          callback(
            null,
            oids.map((oid) => seeded.get(oid) ?? { oid, type: OBJECT_TYPE.NoSuchInstance, value: null }),
          );
        }, 0);
        return this;
      },
      // Présent uniquement pour PROUVER qu'il n'est jamais appelé (lecture seule stricte).
      set() {
        setCallCount++;
        return this;
      },
      close() {
        closeCount++;
        return this;
      },
      on() {
        return this;
      },
    };
  }

  return {
    createSession: (target: string, community: string, options: Record<string, unknown>) => {
      sessionCalls.push({ kind: "v2c", target, community, options });
      return makeSession();
    },
    createV3Session: (target: string, user: unknown, options: Record<string, unknown>) => {
      sessionCalls.push({ kind: "v3", target, user, options });
      return makeSession();
    },
    Version1: 0,
    Version2c: 1,
    Version3: 3,
    SecurityLevel: { noAuthNoPriv: 1, authNoPriv: 2, authPriv: 3 },
    AuthProtocols: { none: 1, md5: 2, sha: 3, sha224: 4, sha256: 5, sha384: 6, sha512: 7 },
    PrivProtocols: { none: 1, des: 2, aes: 4, aes256b: 6, aes256r: 8 },
    ObjectType: OBJECT_TYPE,
    isVarbindError: (varbind: MockVarbind) =>
      varbind.type === OBJECT_TYPE.NoSuchObject || varbind.type === OBJECT_TYPE.NoSuchInstance || varbind.type === OBJECT_TYPE.EndOfMibView,
    varbindError: (varbind: MockVarbind) => `NoSuchInstance: ${varbind.oid}`,
  };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setExagridConfig, clearExagridConfig } = await import("../src/services/setupStore.js");
const { mapExagridAlarm, pollExagrid, lastKnownExagridPoll, validateExagridConfig } = await import("../src/services/exagrid.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

beforeEach(() => {
  seeded.clear();
  sessionCalls.length = 0;
  getCalls.length = 0;
  setCallCount = 0;
  closeCount = 0;
  pendingError = null;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await clearExagridConfig();
});

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}
function viewerCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] }) };
}

/** OIDs RELEVÉS dans l'EXAGRID-MIB (librenms/mibs/exagrid) + profil DataDog — aucun deviné. */
const E = "1.3.6.1.4.1.14941";
const OID = {
  landingConfiguredGb: `${E}.4.1.1.0`,
  landingConfiguredRest: `${E}.4.1.2.0`,
  landingAvailableGb: `${E}.4.1.3.0`,
  landingAvailableRest: `${E}.4.1.4.0`,
  retentionConfiguredGb: `${E}.4.2.1.0`,
  retentionConfiguredRest: `${E}.4.2.2.0`,
  retentionAvailableGb: `${E}.4.2.3.0`,
  retentionAvailableRest: `${E}.4.2.4.0`,
  restorableGb: `${E}.4.3.1.0`,
  restorableRest: `${E}.4.3.2.0`,
  retentionConsumedGb: `${E}.4.3.3.0`,
  retentionConsumedRest: `${E}.4.3.4.0`,
  pendingDedupGb: `${E}.4.4.1.0`,
  pendingDedupRest: `${E}.4.4.2.0`,
  pendingDedupAgeTicks: `${E}.4.4.3.0`,
  pendingReplicationGb: `${E}.4.5.1.0`,
  pendingReplicationRest: `${E}.4.5.2.0`,
  pendingReplicationAgeTicks: `${E}.4.5.3.0`,
  alarmState: `${E}.4.6.1.0`,
};

const V2C_COMMUNITY = "s3cr3t-community";
const V3_AUTH_KEY = "s3cr3t-auth-key";
const V3_PRIV_KEY = "s3cr3t-priv-key";

async function seedV2cConfig(): Promise<void> {
  await setExagridConfig({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });
}

async function seedV3Config(): Promise<void> {
  await setExagridConfig({
    host: "10.10.0.42",
    port: 1161,
    version: "3",
    username: "quai-ro",
    securityLevel: "authPriv",
    authProtocol: "sha256",
    authKey: V3_AUTH_KEY,
    privProtocol: "aes",
    privKey: V3_PRIV_KEY,
  });
}

/** Jeu complet : chaque grandeur est un COUPLE (gigaoctets entiers 10^9 + reste en octets). */
function seedFullMib(): void {
  seedOid(OID.landingConfiguredGb, 1000);
  seedOid(OID.landingConfiguredRest, 0);
  seedOid(OID.landingAvailableGb, 250);
  seedOid(OID.landingAvailableRest, 0);
  seedOid(OID.retentionConfiguredGb, 2000);
  seedOid(OID.retentionConfiguredRest, 0);
  seedOid(OID.retentionAvailableGb, 1500);
  seedOid(OID.retentionAvailableRest, 0);
  seedOid(OID.restorableGb, 12);
  seedOid(OID.restorableRest, 345678901);
  seedOid(OID.retentionConsumedGb, 750);
  seedOid(OID.retentionConsumedRest, 500);
  seedOid(OID.pendingDedupGb, 3);
  seedOid(OID.pendingDedupRest, 250000000);
  seedOid(OID.pendingDedupAgeTicks, 360000, OBJECT_TYPE.TimeTicks);
  seedOid(OID.pendingReplicationGb, 0);
  seedOid(OID.pendingReplicationRest, 4096);
  seedOid(OID.pendingReplicationAgeTicks, 150, OBJECT_TYPE.TimeTicks);
  seedOid(OID.alarmState, 1, OBJECT_TYPE.Integer);
}

describe("Service ExaGrid — recomposition octets, pourcentages, alarme (SNMP mocké)", () => {
  it("recompose la valeur EXACTE en octets de chaque couple (gigaoctets décimaux + reste)", async () => {
    const readings = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });
    expect(readings.landing).toEqual({});

    seedFullMib();
    const full = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });

    expect(full.landing.configuredBytes).toBe(1000 * 1e9);
    expect(full.backupData.availableForRestoreBytes).toBe(12 * 1e9 + 345678901);
    expect(full.backupData.retentionConsumedBytes).toBe(750 * 1e9 + 500);
    expect(full.pendingDeduplication.bytes).toBe(3 * 1e9 + 250000000);
    // 0 gigaoctet entier + 4096 octets de reste : une valeur réelle, pas une absence.
    expect(full.pendingReplication.bytes).toBe(4096);
  });

  it("pourcentages d'occupation calculés depuis les valeurs réelles (landing et rétention)", async () => {
    seedFullMib();
    const readings = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });

    expect(readings.landing).toEqual({
      configuredBytes: 1e12,
      availableBytes: 250e9,
      usedBytes: 750e9,
      usedPct: 75,
    });
    expect(readings.retention).toEqual({
      configuredBytes: 2e12,
      availableBytes: 1.5e12,
      usedBytes: 500e9,
      usedPct: 25,
    });
  });

  it("âges de dédup/réplication : TimeTicks (centièmes de seconde) convertis en secondes", async () => {
    seedFullMib();
    const readings = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });
    expect(readings.pendingDeduplication.ageSeconds).toBe(3600);
    expect(readings.pendingReplication.ageSeconds).toBe(1.5);
  });

  it("mapping d'alarme : 1/2/3 seulement, toute autre valeur reste BRUTE sans étiquette inventée", () => {
    expect(mapExagridAlarm(1)).toEqual({ raw: 1, state: "ok" });
    expect(mapExagridAlarm(2)).toEqual({ raw: 2, state: "warning" });
    expect(mapExagridAlarm(3)).toEqual({ raw: 3, state: "error" });
    expect(mapExagridAlarm(0)).toEqual({ raw: 0 });
    expect(mapExagridAlarm(7)).toEqual({ raw: 7 });
    expect(mapExagridAlarm(7).state).toBeUndefined();
  });

  it("valeurs manquantes : `undefined` honnête (clé absente), JAMAIS un 0 de remplissage", async () => {
    // Seule la moitié "gigaoctets" du couple landing est servie : la valeur serait FAUSSE, pas
    // approximative — donc absente. Le reste de la MIB n'est pas implémenté (noSuchInstance).
    seedOid(OID.landingConfiguredGb, 1000);
    seedOid(OID.retentionConfiguredGb, 2000);
    seedOid(OID.retentionConfiguredRest, 0);
    seedOid(OID.alarmState, 3, OBJECT_TYPE.Integer);

    const readings = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });

    expect(readings.landing).toEqual({});
    expect(readings.retention).toEqual({ configuredBytes: 2e12 });
    expect(readings.retention.availableBytes).toBeUndefined();
    expect(readings.retention.usedBytes).toBeUndefined();
    expect(readings.retention.usedPct).toBeUndefined();
    expect(readings.backupData).toEqual({});
    expect(readings.pendingDeduplication).toEqual({});
    expect(readings.pendingReplication).toEqual({});
    expect(readings.alarm).toEqual({ raw: 3, state: "error" });
  });

  it("espace disponible incohérent (> configuré) : aucun `usedBytes`/`usedPct` inventé", async () => {
    seedOid(OID.landingConfiguredGb, 100);
    seedOid(OID.landingConfiguredRest, 0);
    seedOid(OID.landingAvailableGb, 400);
    seedOid(OID.landingAvailableRest, 0);

    const readings = await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });
    expect(readings.landing).toEqual({ configuredBytes: 100e9, availableBytes: 400e9 });
  });

  it("un SEUL GET pour les 19 objets de l'EXAGRID-MIB, aucun SET, session toujours refermée", async () => {
    seedFullMib();
    await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });

    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]).toHaveLength(19);
    expect(new Set(getCalls[0])).toEqual(new Set(Object.values(OID)));
    expect(getCalls[0]!.every((oid) => oid.startsWith(`${E}.4.`) && oid.endsWith(".0"))).toBe(true);
    expect(setCallCount).toBe(0);
    expect(closeCount).toBe(1);
  });
});

describe("Service ExaGrid — sessions SNMP v2c et v3", () => {
  it("v2c : createSession(host, community, { port, version, timeout, retries })", async () => {
    seedFullMib();
    await pollExagrid({ host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY });

    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toMatchObject({ kind: "v2c", target: "10.10.0.42", community: V2C_COMMUNITY });
    expect(sessionCalls[0]!.options).toMatchObject({ port: 161, version: 1, timeout: config.exagrid.requestTimeoutMs, retries: config.exagrid.retries });
  });

  it("v3 : createV3Session avec niveau de sécurité et protocoles traduits en constantes net-snmp", async () => {
    seedFullMib();
    await pollExagrid({
      host: "10.10.0.42",
      port: 1161,
      version: "3",
      username: "quai-ro",
      securityLevel: "authPriv",
      authProtocol: "sha256",
      authKey: V3_AUTH_KEY,
      privProtocol: "aes",
      privKey: V3_PRIV_KEY,
    });

    expect(sessionCalls[0]).toMatchObject({ kind: "v3", target: "10.10.0.42" });
    expect(sessionCalls[0]!.user).toEqual({
      name: "quai-ro",
      level: 3, // authPriv
      authProtocol: 5, // sha256
      authKey: V3_AUTH_KEY,
      privProtocol: 4, // aes
      privKey: V3_PRIV_KEY,
    });
    expect(sessionCalls[0]!.options).toMatchObject({ port: 1161, version: 3 });
  });

  it("validation : refus explicite d'une config v3 incomplète (jamais de repli silencieux)", () => {
    expect(validateExagridConfig({ host: "10.10.0.42", port: 161, version: "2c" })).toContain("community");
    expect(validateExagridConfig({ host: "", port: 161, version: "2c", community: "x" })).toContain("host");
    expect(validateExagridConfig({ host: "h", port: 0, version: "2c", community: "x" })).toContain("port");
    expect(validateExagridConfig({ host: "h", port: 161, version: "3" })).toContain("username");
    expect(validateExagridConfig({ host: "h", port: 161, version: "3", username: "u" })).toContain("securityLevel");
    expect(validateExagridConfig({ host: "h", port: 161, version: "3", username: "u", securityLevel: "authPriv", authProtocol: "sha256" })).toContain("authKey");
    expect(
      validateExagridConfig({ host: "h", port: 161, version: "3", username: "u", securityLevel: "authPriv", authProtocol: "sha256", authKey: "k", privProtocol: "aes" }),
    ).toContain("privKey");
    expect(
      validateExagridConfig({ host: "h", port: 161, version: "3", username: "u", securityLevel: "noAuthNoPriv" }),
    ).toBeNull();
  });
});

describe("Routes ExaGrid — autorisation", () => {
  it("401 sans session sur les routes de lecture", async () => {
    app = buildServer();
    for (const url of ["/api/exagrid/status", "/api/exagrid/config"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("lecture accessible à un rôle viewer (tout rôle authentifié)", async () => {
    app = buildServer();
    for (const url of ["/api/exagrid/status", "/api/exagrid/config"]) {
      const response = await app.inject({ method: "GET", url, cookies: viewerCookie() });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it("403 pour un rôle viewer sur la config (PUT/POST test/DELETE)", async () => {
    app = buildServer();
    for (const [method, url] of [
      ["PUT", "/api/exagrid/config"],
      ["POST", "/api/exagrid/config/test"],
      ["DELETE", "/api/exagrid/config"],
    ] as const) {
      const response = await app.inject({ method, url, cookies: viewerCookie(), payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("Routes ExaGrid — état honnête (non configuré, injoignable)", () => {
  it("jamais configuré : { configured: false } et AUCUNE session SNMP ouverte", async () => {
    app = buildServer();
    const status = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: viewerCookie() });
    expect(status.json()).toEqual({ configured: false });

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: viewerCookie() });
    expect(cfg.json()).toEqual({ configured: false });
    expect(sessionCalls).toHaveLength(0);
  });

  it("configuré et joignable : capacités réelles + alarme + dernier poll", async () => {
    await seedV2cConfig();
    seedFullMib();
    seedOid(OID.alarmState, 2, OBJECT_TYPE.Integer);
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      reachable: true,
      endpoint: { host: "10.10.0.42", port: 161, version: "2c" },
      readings: {
        landing: { configuredBytes: 1e12, availableBytes: 250e9, usedBytes: 750e9, usedPct: 75 },
        retention: { usedPct: 25 },
        alarm: { raw: 2, state: "warning" },
      },
      lastPoll: { reachable: true },
    });
  });

  it("config persistée devenue inutilisable : motif explicite, aucun poll à l'aveugle, jamais un faux « non configuré »", async () => {
    // v2c sans community (config.json édité à la main) : /status ne doit pas contredire /config.
    await setExagridConfig({ host: "10.10.0.42", port: 161, version: "2c" });
    app = buildServer();

    const status = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: viewerCookie() });
    expect(status.json()).toMatchObject({ configured: true, reachable: false, endpoint: { host: "10.10.0.42" } });
    expect(status.json().configError).toContain("community");
    expect(status.json().readings).toBeUndefined();
    expect(sessionCalls).toHaveLength(0);

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: viewerCookie() });
    expect(cfg.json().configured).toBe(true);
  });

  it("configuré mais injoignable : reachable false, aucune capacité inventée, dernier poll conservé", async () => {
    await seedV2cConfig();
    pendingError = new Error("Request timed out");
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: viewerCookie() });
    expect(response.json()).toMatchObject({ configured: true, reachable: false, endpoint: { host: "10.10.0.42" } });
    expect(response.json().readings).toBeUndefined();
    expect(lastKnownExagridPoll()).toMatchObject({ reachable: false });
    expect(closeCount).toBe(1);
  });
});

describe("Config ExaGrid — test avant persistance, chiffrement au repos, aucun secret renvoyé", () => {
  it("PUT : teste réellement la session SNMP ; si l'appliance ne répond pas, rien n'est persisté", async () => {
    pendingError = new Error("Request timed out");
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: { host: "10.10.0.42", port: 161, version: "2c", community: V2C_COMMUNITY },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("injoignable");

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("PUT : un hôte qui répond en SNMP sans servir l'EXAGRID-MIB est refusé (pas un ExaGrid)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: { host: "10.10.0.99", port: 161, version: "2c", community: V2C_COMMUNITY },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("EXAGRID-MIB");
  });

  it("PUT v2c : persiste la community CHIFFRÉE et ne la renvoie jamais", async () => {
    seedOid(OID.alarmState, 1, OBJECT_TYPE.Integer);
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: { host: "10.10.0.42", version: "2c", community: V2C_COMMUNITY },
    });
    expect(response.statusCode).toBe(200);
    // port omis dans le corps -> 161 (port SNMP standard), jamais une valeur devinée ailleurs.
    expect(response.json()).toEqual({ configured: true, config: { host: "10.10.0.42", port: 161, version: "2c" } });
    expect(JSON.stringify(response.json())).not.toContain(V2C_COMMUNITY);

    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain(V2C_COMMUNITY);
    const onDisk = JSON.parse(raw) as { exagrid?: { community?: string; host?: string } };
    expect(onDisk.exagrid?.host).toBe("10.10.0.42");
    expect(onDisk.exagrid?.community).toMatch(/^enc:v1:/);
  });

  it("PUT v3 : authKey/privKey chiffrées au repos ; la config renvoyée ne montre que host/port/version/user/protocoles", async () => {
    seedOid(OID.alarmState, 1, OBJECT_TYPE.Integer);
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: {
        host: "10.10.0.42",
        port: 1161,
        version: "3",
        username: "quai-ro",
        securityLevel: "authPriv",
        authProtocol: "sha256",
        authKey: V3_AUTH_KEY,
        privProtocol: "aes",
        privKey: V3_PRIV_KEY,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      config: { host: "10.10.0.42", port: 1161, version: "3", username: "quai-ro", securityLevel: "authPriv", authProtocol: "sha256", privProtocol: "aes" },
    });
    const body = JSON.stringify(response.json());
    expect(body).not.toContain(V3_AUTH_KEY);
    expect(body).not.toContain(V3_PRIV_KEY);

    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain(V3_AUTH_KEY);
    expect(raw).not.toContain(V3_PRIV_KEY);
    const onDisk = JSON.parse(raw) as { exagrid?: { authKey?: string; privKey?: string } };
    expect(onDisk.exagrid?.authKey).toMatch(/^enc:v1:/);
    expect(onDisk.exagrid?.privKey).toMatch(/^enc:v1:/);
  });

  it("PUT v3 incomplet : 400 explicite, aucun repli silencieux sur un niveau de sécurité par défaut", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: { host: "10.10.0.42", version: "3", username: "quai-ro" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("securityLevel");
    expect(sessionCalls).toHaveLength(0);
  });

  it("PUT : secret absent du corps = conserver l'existant (changer l'hôte sans ressaisir la community)", async () => {
    await seedV2cConfig();
    seedOid(OID.alarmState, 1, OBJECT_TYPE.Integer);
    app = buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/api/exagrid/config",
      cookies: adminCookie(),
      payload: { host: "exagrid.lecreusot.fr" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().config).toEqual({ host: "exagrid.lecreusot.fr", port: 161, version: "2c" });
    expect(sessionCalls[0]).toMatchObject({ community: V2C_COMMUNITY });

    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain(V2C_COMMUNITY);
    expect((JSON.parse(raw) as { exagrid?: { community?: string } }).exagrid?.community).toMatch(/^enc:v1:/);
  });

  it("aucun secret ne sort par GET /config ni par GET /status, même partiellement", async () => {
    await seedV3Config();
    seedFullMib();
    app = buildServer();

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: viewerCookie() });
    const status = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: viewerCookie() });

    for (const payload of [cfg.body, status.body]) {
      expect(payload).not.toContain(V3_AUTH_KEY);
      expect(payload).not.toContain(V3_PRIV_KEY);
      expect(payload).not.toContain("authKey");
      expect(payload).not.toContain("privKey");
      expect(payload).not.toContain("community");
      // Aucun fragment non plus : la moitié d'une clé reste une fuite.
      expect(payload).not.toContain(V3_AUTH_KEY.slice(0, 8));
    }
    expect(cfg.json()).toEqual({
      configured: true,
      config: { host: "10.10.0.42", port: 1161, version: "3", username: "quai-ro", securityLevel: "authPriv", authProtocol: "sha256", privProtocol: "aes" },
    });
  });

  it("POST /config/test : teste sans persister, et expurge tout secret d'un message d'erreur amont", async () => {
    pendingError = new Error(`snmp failure for community ${V2C_COMMUNITY}`);
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/exagrid/config/test",
      cookies: adminCookie(),
      payload: { host: "10.10.0.42", version: "2c", community: V2C_COMMUNITY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.body).not.toContain(V2C_COMMUNITY);
    expect(response.json().message).toContain("***");

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("POST /config/test : succès -> alarme réelle remontée, toujours sans persister", async () => {
    seedOid(OID.alarmState, 3, OBJECT_TYPE.Integer);
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/exagrid/config/test",
      cookies: adminCookie(),
      payload: { host: "10.10.0.42", version: "2c", community: V2C_COMMUNITY },
    });
    expect(response.json()).toMatchObject({ ok: true, alarm: { raw: 3, state: "error" } });
    // Sonde minimale : un seul OID interrogé, jamais un poll complet pour un simple test.
    expect(getCalls).toEqual([[OID.alarmState]]);
    expect(setCallCount).toBe(0);

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
  });

  it("DELETE : retour à jamais configuré", async () => {
    await seedV2cConfig();
    app = buildServer();

    const response = await app.inject({ method: "DELETE", url: "/api/exagrid/config", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);

    const cfg = await app.inject({ method: "GET", url: "/api/exagrid/config", cookies: adminCookie() });
    expect(cfg.json()).toEqual({ configured: false });
    const status = await app.inject({ method: "GET", url: "/api/exagrid/status", cookies: adminCookie() });
    expect(status.json()).toMatchObject({ configured: false });
    expect(status.json().readings).toBeUndefined();
  });
});
