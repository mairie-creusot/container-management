import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé, même pattern que containers.test.ts/containersSecretMasking.test.ts.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const FAKE_CONTAINER_ID = "fakecontainerlogs0000000000000000000000000000000000000000000";

/**
 * services/docker.js mocké (pas de vrai démon Docker requis, même esprit que
 * containersSecretMasking.test.ts) — getContainerLogs simule un `docker logs --tail <n>` réel :
 * succès pour FAKE_CONTAINER_ID (le texte renvoyé encode le `tail` reçu, pour vérifier que la
 * querystring est bien transmise), échec "no such container" pour tout autre id — même erreur
 * que dockerode renvoie réellement pour un id inconnu.
 */
vi.mock("../src/services/docker.js", () => ({
  getContainerLogs: vi.fn(async (id: string, tail?: number) => {
    if (id !== FAKE_CONTAINER_ID) throw new Error(`No such container: ${id}`);
    return `2026-08-12T10:00:00.000000000Z hello (tail=${tail})\n`;
  }),
  streamContainerLogs: vi.fn(async () => {
    throw new Error("not exercised by this test file — voir la vérification manuelle en conditions réelles (WebSocket)");
  }),
}));

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

describe("GET /api/containers/:id/logs", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: `/api/containers/${FAKE_CONTAINER_ID}/logs` });
    expect(response.statusCode).toBe(401);
  });

  it("allows a viewer (read-only role) — logs are read-only, DELIBERATELY no extra role check unlike routes/console.ts", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/logs`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ logs: expect.stringContaining("hello") });
  });

  it("defaults tail to 200 when the querystring omits it", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/logs`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.json()).toMatchObject({ logs: expect.stringContaining("tail=200") });
  });

  it("passes an explicit tail value through unchanged", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/logs?tail=50`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.json()).toMatchObject({ logs: expect.stringContaining("tail=50") });
  });

  it("accepts an explicit tail=0 (used by the frontend after an initial snapshot, to avoid duplicating lines on the live stream)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/logs?tail=0`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.json()).toMatchObject({ logs: expect.stringContaining("tail=0") });
  });

  it("falls back to the default tail for an invalid (non-numeric) tail querystring", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/logs?tail=abc`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.json()).toMatchObject({ logs: expect.stringContaining("tail=200") });
  });

  it("returns 404 for an unknown container id (translated from dockerode's 'no such container')", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: "/api/containers/does-not-exist/logs",
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
  });
});
