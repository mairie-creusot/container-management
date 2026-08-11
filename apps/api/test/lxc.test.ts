import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONFIG_PATH/LXC_PATH isolés (même pattern que remoteEnvironments.test.ts/secrets.test.ts).
 *
 * Aucun démon LXD réel n'est disponible dans cet environnement de test : ces tests couvrent ce
 * qui EST vérifiable sans LXD réel — LXD n'a jamais été configuré dans cet environnement, donc
 * GET /api/lxc/containers doit honnêtement renvoyer [] (voir services/lxc.ts#getLxcContainers —
 * jamais d'instance LXC inventée), exactement comme nutanix.test.ts pour Nutanix. Le CRUD de
 * config (chiffrement au repos, validation) est, lui, testé directement.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpLxcPath = path.join(os.tmpdir(), `quai-api-test-lxc-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.LXC_PATH = tmpLxcPath;
process.env.CONFIG_ENCRYPTION_KEY = "3".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const lxcStore = await import("../src/services/lxcStore.js");
const lxc = await import("../src/services/lxc.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpLxcPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

describe("GET /api/lxc/containers", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/lxc/containers" });
    expect(response.statusCode).toBe(401);
  });

  it("returns [] for an authenticated viewer — LXD has never been configured in this environment", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/lxc/containers",
      cookies: cookieFor(["viewer"]),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("services/lxc.ts — never configured", () => {
  it("isLxcConfigured() is false and isLxcReachable() is false without throwing", async () => {
    expect(await lxc.isLxcConfigured()).toBe(false);
    expect(await lxc.isLxcReachable()).toBe(false);
  });

  it("getLxcEnvironment() returns null (no fake LXC environment mixed with real ones)", async () => {
    expect(await lxc.getLxcEnvironment()).toBeNull();
  });
});

describe("services/lxcStore.ts — validation and encryption at rest", () => {
  it("rejects a non-https endpoint", async () => {
    await expect(
      lxcStore.setLxcConfig({ endpoint: "http://lxd.example:8443", clientCert: "CERT", clientKey: "KEY" }),
    ).rejects.toThrow(lxcStore.LxcValidationError);
  });

  it("rejects a missing clientCert/clientKey", async () => {
    await expect(
      lxcStore.setLxcConfig({ endpoint: "https://lxd.example:8443", clientCert: "", clientKey: "" }),
    ).rejects.toThrow(lxcStore.LxcValidationError);
  });

  it("persists endpoint in clear but clientCert/clientKey encrypted at rest, decryptable via getEffectiveLxcConfig", async () => {
    const saved = await lxcStore.setLxcConfig({
      endpoint: "https://lxd.example.internal:8443",
      clientCert: "PLAINTEXT-CLIENT-CERT",
      clientKey: "PLAINTEXT-CLIENT-KEY",
    });
    expect(saved).toMatchObject({ configured: true, endpoint: "https://lxd.example.internal:8443" });

    const raw = await fs.readFile(tmpLxcPath, "utf-8");
    expect(raw).toContain("https://lxd.example.internal:8443"); // endpoint : pas un secret
    expect(raw).not.toContain("PLAINTEXT-CLIENT-CERT");
    expect(raw).not.toContain("PLAINTEXT-CLIENT-KEY");
    expect(raw).toContain("enc:v1:");

    const effective = await lxcStore.getEffectiveLxcConfig();
    expect(effective).toEqual({
      endpoint: "https://lxd.example.internal:8443",
      clientCert: "PLAINTEXT-CLIENT-CERT",
      clientKey: "PLAINTEXT-CLIENT-KEY",
    });

    // GET /api/lxc/config ne renvoie jamais le certificat/la clé.
    const ref = await lxcStore.getLxcConfigRef();
    expect(ref).not.toHaveProperty("clientCert");
    expect(ref).not.toHaveProperty("clientKey");

    await lxcStore.clearLxcConfig();
    expect(await lxcStore.getEffectiveLxcConfig()).toBeNull();
  });
});

describe("PUT /api/lxc/config", () => {
  it("rejects an operator (non-admin) with 403", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/lxc/config",
      cookies: cookieFor(["operator"]),
      payload: { endpoint: "https://lxd.example:8443", clientCert: "CERT", clientKey: "KEY" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts an admin, then GET /api/lxc/config/test honestly reports ok:false against an unreachable host", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "PUT",
      url: "/api/lxc/config",
      cookies: cookieFor(["admin"]),
      payload: {
        endpoint: "https://lxd.invalid.does-not-exist.example:8443",
        clientCert: "CERT",
        clientKey: "KEY",
      },
    });
    expect(created.statusCode).toBe(201);

    const tested = await app.inject({ method: "GET", url: "/api/lxc/config/test", cookies: cookieFor(["viewer"]) });
    expect(tested.statusCode).toBe(200);
    const body = tested.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toBeTruthy();

    const cleared = await app.inject({ method: "DELETE", url: "/api/lxc/config", cookies: cookieFor(["admin"]) });
    expect(cleared.statusCode).toBe(200);
  });
});
