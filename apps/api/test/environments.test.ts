import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Ces tests s'exécutent en environnement de dev/CI sans démon Docker ni cluster
 * Kubernetes joignables : le serveur retombe donc sur le jeu de données de démonstration
 * (src/services/demoData.ts), exactement comme documenté dans docker.ts/kubernetes.ts.
 *
 * CONFIG_PATH doit être positionné avant le premier import de src/config.js (même pattern
 * que setup.test.ts) : "POST /api/registries" persiste désormais réellement dans config.json
 * (registriesStore.ts) — sans cet isolement, chaque exécution de la suite de tests ajoutait
 * un registry "Docker Hub (test)" de plus au config.json de développement réel.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

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

describe("GET /api/environments", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/environments" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the demo environments for an authenticated viewer", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });

    const response = await app.inject({
      method: "GET",
      url: "/api/environments",
      cookies: { [config.session.cookieName]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ name: string; orchestrator: string; nodes: unknown[] }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const env of body) {
      expect(["swarm", "kubernetes", "compose"]).toContain(env.orchestrator);
      expect(Array.isArray(env.nodes)).toBe(true);
    }
  });
});

describe("POST /api/registries", () => {
  it("rejects a viewer (403) — mutating routes require operator or admin", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: token },
      payload: { kind: "dockerhub", name: "Docker Hub", url: "https://hub.docker.com" },
    });

    expect(response.statusCode).toBe(403);
  });

  // La gestion des registries (identifiants inclus, via PATCH) est documentée « admin uniquement »
  // dans ARCHITECTURE.md — un simple operator ne doit plus pouvoir créer/modifier un registry
  // (voir docs/reports/security-audit-2026-08-12.md, finding M4).
  it("rejects an operator (403) — registry management is admin-only", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: token },
      payload: { kind: "dockerhub", name: "Docker Hub (test)", url: "https://hub.docker.com" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("accepts an admin", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo Admin", roles: ["admin"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: token },
      payload: { kind: "dockerhub", name: "Docker Hub (test)", url: "https://hub.docker.com" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("unconfigured");
  });
});

describe("PATCH /api/registries/:id", () => {
  it("rejects an operator (403) — registry management is admin-only (finding M4)", async () => {
    app = buildServer();
    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });
    const created = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
      payload: { kind: "dockerhub", name: "Docker Hub (patch test)", url: "https://hub.docker.com" },
    });
    const { id } = created.json() as { id: string };

    const operatorToken = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/registries/${id}`,
      cookies: { [config.session.cookieName]: operatorToken },
      payload: { name: "Renamed by operator" },
    });

    expect(response.statusCode).toBe(403);
  });
});
