import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Panne réelle reproduite ici : Caddy redémarre, sa config (qui ne vit QU'en mémoire) est perdue,
 * il repart de son Caddyfile de bootstrap (:80, aucune route) et QUAI devient injoignable en HTTPS
 * sans que rien ne republie. `fetch` est TOUJOURS mocké dans ce fichier — aucun appel sortant réel,
 * en particulier jamais un POST /load vers le vrai Caddy de dev (bug constaté le 13/08/2026, voir
 * l'en-tête de reverseProxy.test.ts).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpReverseProxyPath = path.join(
  os.tmpdir(),
  `quai-api-test-reverse-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.REVERSE_PROXY_PATH = tmpReverseProxyPath;
process.env.CADDY_ADMIN_URL = "http://caddy:1";
process.env.CONFIG_ENCRYPTION_KEY = "5".repeat(64);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { createRoute } = await import("../src/services/reverseProxy.js");
const {
  detectReverseProxyDrift,
  getReverseProxyReconciliationStatus,
  runReverseProxyReconcileCycle,
  startReverseProxyReconciler,
} = await import("../src/services/reverseProxyReconciler.js");

const SUBDOMAIN = "reconcile.lecreusot.priv";

/** Caddy tout juste redémarré : Caddyfile de bootstrap, :80 seulement, aucune route applicative. */
const BOOTSTRAP_SERVED = {
  apps: { http: { servers: { srv0: { listen: [":80"], routes: [{ handle: [{ handler: "static_response" }] }] } } } },
};

/** Caddy servant exactement ce que QUAI attend (:80 + :443, la route du magasin). */
const IN_SYNC_SERVED = {
  apps: {
    http: {
      servers: {
        quai: {
          listen: [":80", ":443"],
          routes: [
            { match: [{ host: [SUBDOMAIN] }], handle: [{ handler: "reverse_proxy" }] },
            { handle: [{ handler: "static_response" }] },
          ],
        },
      },
    },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
let served: unknown = BOOTSTRAP_SERVED;
let caddyDown = false;

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
}

function loadCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/load"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let app: FastifyInstance | undefined;

beforeEach(() => {
  caddyDown = false;
  fetchMock = vi.fn(async (input: unknown) => {
    if (caddyDown) throw new Error("connect ECONNREFUSED 172.18.0.9:2019");
    const url = String(input);
    if (url.endsWith("/config/")) return jsonResponse(served);
    if (url.endsWith("/load")) return jsonResponse({});
    throw new Error(`unexpected Caddy admin call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpReverseProxyPath, { force: true });
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  return { [config.session.cookieName]: signSessionToken({ username: "demo", displayName: "Demo User", roles }) };
}

describe("detectReverseProxyDrift", () => {
  it("reports no drift when Caddy serves exactly the expected subdomains and listeners", () => {
    const drift = detectReverseProxyDrift(
      { subdomains: [SUBDOMAIN], listen: [":80", ":443"] },
      { subdomains: [SUBDOMAIN], listen: [":80", ":443"] },
    );
    expect(drift.drifted).toBe(false);
  });

  it("reports drift when Caddy lost every route and the HTTPS listener (restarted on its bootstrap Caddyfile)", () => {
    const drift = detectReverseProxyDrift({ subdomains: [SUBDOMAIN], listen: [":80", ":443"] }, { subdomains: [], listen: [":80"] });
    expect(drift).toMatchObject({ drifted: true, missingSubdomains: [SUBDOMAIN], missingListeners: [":443"] });
  });

  it("reports drift when Caddy still serves a subdomain QUAI no longer knows about", () => {
    const drift = detectReverseProxyDrift(
      { subdomains: [], listen: [":80", ":443"] },
      { subdomains: ["stale.lecreusot.priv"], listen: [":80", ":443"] },
    );
    expect(drift).toMatchObject({ drifted: true, unexpectedSubdomains: ["stale.lecreusot.priv"] });
  });

  it("ignores host casing (Caddy normalises differently than the store)", () => {
    const drift = detectReverseProxyDrift(
      { subdomains: ["App.Lecreusot.Priv"], listen: [":80"] },
      { subdomains: ["app.lecreusot.priv"], listen: [":80"] },
    );
    expect(drift.drifted).toBe(false);
  });
});

describe("runReverseProxyReconcileCycle", () => {
  it("does not call Caddy at all when the route store is empty", async () => {
    const outcome = await runReverseProxyReconcileCycle();
    expect(outcome).toBe("empty-store");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getReverseProxyReconciliationStatus().caddyReachable).toBeNull(); // Caddy jamais interrogé
  });

  it("republishes when Caddy drifted back to its bootstrap configuration", async () => {
    await createRoute({ subdomain: SUBDOMAIN, targetHost: "10.0.0.7", targetPort: 8080 });
    fetchMock.mockClear();
    served = BOOTSTRAP_SERVED;

    const outcome = await runReverseProxyReconcileCycle();

    expect(outcome).toBe("republished");
    expect(loadCalls()).toHaveLength(1);
    const pushed = JSON.parse(String((loadCalls()[0][1] as RequestInit).body)) as {
      apps: { http: { servers: { quai: { listen: string[]; routes: { match?: { host: string[] }[] }[] } } } };
    };
    expect(pushed.apps.http.servers.quai.listen).toEqual([":80", ":443"]);
    expect(pushed.apps.http.servers.quai.routes[0].match?.[0].host).toEqual([SUBDOMAIN]);

    const status = getReverseProxyReconciliationStatus();
    expect(status).toMatchObject({ lastOutcome: "republished", caddyReachable: true, driftDetected: false });
    expect(status.lastRepublishAt).not.toBeNull();
  });

  it("never reloads Caddy when its live configuration already matches the store", async () => {
    served = IN_SYNC_SERVED;

    const outcome = await runReverseProxyReconcileCycle();

    expect(outcome).toBe("in-sync");
    expect(loadCalls()).toHaveLength(0); // AUCUNE republication à l'aveugle
    expect(fetchMock).toHaveBeenCalledTimes(1); // une seule lecture GET /config/
    expect(getReverseProxyReconciliationStatus()).toMatchObject({
      caddyReachable: true,
      driftDetected: false,
      expectedSubdomains: [SUBDOMAIN],
      servedSubdomains: [SUBDOMAIN],
    });
  });

  it("reports Caddy as unreachable without republishing when its admin API does not answer", async () => {
    caddyDown = true;

    const outcome = await runReverseProxyReconcileCycle();

    expect(outcome).toBe("caddy-unreachable");
    expect(loadCalls()).toHaveLength(0);
    const status = getReverseProxyReconciliationStatus();
    expect(status.caddyReachable).toBe(false);
    expect(status.lastError).toContain("Caddy admin API unreachable");
  });
});

describe("startReverseProxyReconciler", () => {
  it("retries the startup republication until Caddy answers, then pushes successfully", async () => {
    caddyDown = true;
    served = BOOTSTRAP_SERVED;

    const stop = startReverseProxyReconciler(60_000, 5, 200);
    try {
      await waitFor(() => fetchMock.mock.calls.length >= 2); // au moins un réessai après l'échec initial
      expect(loadCalls()).toHaveLength(0);

      caddyDown = false;
      await waitFor(() => loadCalls().length >= 1);
      expect(getReverseProxyReconciliationStatus()).toMatchObject({ lastOutcome: "republished", caddyReachable: true });
    } finally {
      stop();
    }
  });

  it("stops every timer it started (no leaking retry nor interval)", async () => {
    caddyDown = true;
    const stop = startReverseProxyReconciler(10, 5, 200);
    await waitFor(() => fetchMock.mock.calls.length >= 2);
    stop();

    await new Promise((resolve) => setTimeout(resolve, 30)); // laisse un cycle déjà démarré se terminer
    const callsAtStop = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120)); // largement plus que l'intervalle et le réessai
    expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  });
});

describe("GET /api/reverse-proxy/status", () => {
  it("exposes the reconciliation state alongside Caddy reachability", async () => {
    served = IN_SYNC_SERVED;
    await runReverseProxyReconcileCycle();
    app = buildServer();

    const response = await app.inject({ method: "GET", url: "/api/reverse-proxy/status", cookies: cookieFor(["viewer"]) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reachable: true,
      httpsEnabled: true, // :443 réellement servi, plus une simple déduction de joignabilité
      reconciliation: { lastOutcome: "in-sync", caddyReachable: true, driftDetected: false, servedSubdomains: [SUBDOMAIN] },
    });
  });
});
