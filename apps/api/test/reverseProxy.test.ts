import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * REVERSE_PROXY_PATH isolé (même pattern que lxc.test.ts) — le store QUAI ne touche jamais le
 * vrai reverse-proxy.json de dev. CADDY_ADMIN_URL isolé EXPLICITEMENT en plus ("caddy:1" — MÊME
 * hostname que le défaut "caddy:2019" pour ne pas changer l'autorité testée par le cas "the
 * Caddy admin API's own authority" ci-dessous, mais un port sur lequel rien n'écoute :
 * ECONNREFUSED quasi immédiat, jamais le vrai `:2019`) : dans CE dépôt, l'API de test tourne
 * dans le même réseau docker-compose que le VRAI Caddy de dev, qui répondrait donc réellement à
 * un `POST /load` non isolé — écrasant silencieusement sa config de routage réelle avec les
 * routes fictives de ce fichier ("allowed.lecreusot.priv" -> 10.0.0.5:8080) sans jamais la
 * restaurer ensuite (bug constaté en conditions réelles le 13/08/2026 : les routes de dev
 * cassées après un run de tests, cause racine ici). POST /api/reverse-proxy/routes répond donc
 * 201 avec `caddyPushError` pour une cible autorisée (la mutation locale reste acquise, voir
 * services/reverseProxy.ts), mais doit répondre 400 AVANT tout appel Caddy pour une cible
 * interdite — voir docs/reports/security-audit-2026-08-12.md, finding M1.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpReverseProxyPath = path.join(
  os.tmpdir(),
  `quai-api-test-reverse-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.REVERSE_PROXY_PATH = tmpReverseProxyPath;
process.env.CADDY_ADMIN_URL = "http://caddy:1";
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
    // Dérivé de CADDY_ADMIN_URL EN DIRECT (isolé plus haut à "127.0.0.1:1", jamais le
    // "caddy:2019" par défaut, voir le commentaire de tête de fichier) plutôt qu'un "caddy"
    // en dur : isForbiddenProxyTarget() interdit l'AUTORITÉ RÉELLE de caddyAdminUrl, quelle
    // qu'elle soit — un littéral figé aurait cessé de tester quoi que ce soit dès que
    // CADDY_ADMIN_URL n'est plus la valeur par défaut.
    ["the Caddy admin API's own authority", new URL(config.reverseProxy.caddyAdminUrl).hostname],
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
