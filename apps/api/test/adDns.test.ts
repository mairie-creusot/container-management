import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONFIG_PATH isolé (même pattern que lxc.test.ts/remoteEnvironments.test.ts) : PUT /api/ad-dns/config
 * persiste réellement dans config.json (setupStore.ts#setAdDnsConfig).
 *
 * Régressions couvertes (docs/reports/security-audit-2026-08-12.md) :
 *  - finding E3 : PUT/DELETE /api/ad-dns/config exige désormais explicitement le rôle admin
 *    (un operator recevait 200/204 auparavant).
 *  - finding M6 : targetIp est validé comme une adresse IPv4 stricte avant persistance (un
 *    payload contenant du texte libre, y compris une tentative d'injection nsupdate via \n,
 *    était auparavant accepté tel quel).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CONFIG_ENCRYPTION_KEY = "4".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
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

const VALID_PAYLOAD = {
  realm: "LECREUSOT.PRIV",
  kdcHost: "kdc.lecreusot.priv",
  zone: "lecreusot.priv",
  serviceAccount: "svc-quai-dns",
  targetIp: "10.0.0.42",
  password: "s3cret",
};

describe("PUT /api/ad-dns/config", () => {
  it("rejects an operator (non-admin) with 403 — finding E3", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["operator"]),
      payload: VALID_PAYLOAD,
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a non-IPv4 targetIp with 400, even for an admin — finding M6", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["admin"]),
      payload: { ...VALID_PAYLOAD, targetIp: "not-an-ip" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("targetIp") });
  });

  it("rejects an nsupdate-injection attempt smuggled through targetIp with 400 — finding M6", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["admin"]),
      payload: { ...VALID_PAYLOAD, targetIp: "10.0.0.1\nupdate add evil.lecreusot.priv. 300 A 6.6.6.6\nsend" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts an admin with a valid IPv4 targetIp", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["admin"]),
      payload: VALID_PAYLOAD,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, config: { targetIp: "10.0.0.42" } });
  });
});

describe("DELETE /api/ad-dns/config", () => {
  it("rejects an operator (non-admin) with 403 — finding E3", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["operator"]),
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts an admin", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["admin"]),
    });
    expect(response.statusCode).toBe(200);
  });
});
