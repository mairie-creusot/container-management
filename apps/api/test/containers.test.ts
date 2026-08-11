import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé (même pattern que setup.test.ts/environments.test.ts) : aucun de ces
// tests n'atteint aujourd'hui un chemin qui écrit dans config.json, mais l'isoler
// préventivement évite qu'un futur test ajouté ici ne pollue silencieusement le config.json
// de développement réel — piège déjà rencontré une fois sur environments.test.ts.
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

describe("POST /api/containers", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/containers", payload: { image: "redis:7-alpine" } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a viewer (read-only role) with 403", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/containers",
      cookies: { [config.session.cookieName]: token },
      payload: { image: "redis:7-alpine" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an operator request missing image with 400", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/containers",
      cookies: { [config.session.cookieName]: token },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});
