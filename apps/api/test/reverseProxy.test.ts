import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * REVERSE_PROXY_PATH isolé (même pattern que lxc.test.ts) — aucun Caddy réel joignable dans cet
 * environnement de test : POST /api/reverse-proxy/routes répond donc 201 avec `caddyPushError`
 * pour une cible autorisée (la mutation locale reste acquise, voir services/reverseProxy.ts),
 * mais doit répondre 400 AVANT tout appel Caddy pour une cible interdite — voir
 * docs/reports/security-audit-2026-08-12.md, finding M1.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpReverseProxyPath = path.join(
  os.tmpdir(),
  `quai-api-test-reverse-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.REVERSE_PROXY_PATH = tmpReverseProxyPath;
process.env.CONFIG_ENCRYPTION_KEY = "5".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpReverseProxyPath, { force: true });
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

describe("POST /api/reverse-proxy/routes — forbidden targetHost (finding M1)", () => {
  it.each([
    ["loopback IPv4", "127.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["link-local IPv4", "169.254.169.254"],
    ["localhost", "localhost"],
    ["the Caddy admin API's own authority", "caddy"], // hostname de CADDY_ADMIN_URL par défaut (http://caddy:2019)
  ])("rejects targetHost=%s (%s) with 400, before any Caddy push", async (_label, targetHost) => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/reverse-proxy/routes",
      cookies: cookieFor(["operator"]),
      payload: { subdomain: "blocked.lecreusot.priv", targetHost, targetPort: 80 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining(targetHost) });
  });

  it("accepts a legitimate internal targetHost (201, even if the Caddy push itself fails in this test environment)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/reverse-proxy/routes",
      cookies: cookieFor(["operator"]),
      payload: { subdomain: "allowed.lecreusot.priv", targetHost: "10.0.0.5", targetPort: 8080 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { subdomain: string };
    expect(body.subdomain).toBe("allowed.lecreusot.priv");
  });
});
