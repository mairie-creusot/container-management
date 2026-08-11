import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé (même pattern que containers.test.ts/environments.test.ts).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(path.join(path.dirname(tmpConfigPath), "notifications-log.jsonl"), { force: true });
  await fs.rm(path.join(path.dirname(tmpConfigPath), "notifications-read-state.json"), { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/notifications", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(response.statusCode).toBe(401);
  });

  it("returns an empty array for any authenticated role (viewer included)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("POST /api/notifications/read-all", () => {
  it("rejects a viewer with 403 — mutating routes require operator or admin", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read-all",
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts an operator", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read-all",
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
