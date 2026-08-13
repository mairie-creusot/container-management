import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ContainerProcessInspection } from "../src/types.js";
import type { ContainerProcessActionResult } from "../src/services/docker.js";

// CONFIG_PATH isolé, même pattern que containerProcessDetails.test.ts/containers.test.ts.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const RUNNING_CONTAINER_ID = "fakerunningcontainer000000000000000000000000000000000000000000";
const STOPPED_CONTAINER_ID = "fakestoppedcontainer00000000000000000000000000000000000000000000";

const ALIVE_PID = 42;
const DEAD_PID = 999;

/**
 * services/docker.js mocké pour CES routes précises (kill/restart/inspect de process) — pas de vrai
 * démon Docker requis, même esprit que containersSecretMasking.test.ts/containerProcessDetails.
 * test.ts. Les trois fonctions simulent les cas honnêtes attendus : succès, PID déjà mort (erreur,
 * jamais un succès silencieux), et conteneur arrêté (409, même convention que sendDockerActionError).
 * Le garde-fou pid===1 en lui-même est déjà couvert SANS mock dans containerProcessActions.test.ts
 * (test du VRAI code) — ici on vérifie seulement que la ROUTE traduit correctement `wasPidOne: true`
 * en 409 avec le bon flag de redirection, peu importe qui le calcule.
 */
vi.mock("../src/services/docker.js", () => ({
  inspectContainerProcess: vi.fn(
    async (id: string, pid: number): Promise<ContainerProcessInspection> => {
      if (id === STOPPED_CONTAINER_ID) {
        throw new Error(`Container "${id}" is not running (state: exited)`);
      }
      if (pid === DEAD_PID) {
        throw new Error(`Process ${pid} not found in container "${id}" (already exited)`);
      }
      return { pid, cmdline: ["node", "server.js"], environ: { PATH: "/usr/bin" }, openFiles: ["socket:[123]"] };
    },
  ),
  killContainerProcess: vi.fn(
    async (id: string, pid: number, signal: "TERM" | "KILL"): Promise<ContainerProcessActionResult> => {
      if (pid === 1) return { wasPidOne: true };
      if (id === STOPPED_CONTAINER_ID) {
        throw new Error(`Container "${id}" is not running (state: exited)`);
      }
      if (pid === DEAD_PID) {
        // Message réel que produirait `kill` sur un process déjà terminé (ESRCH).
        throw new Error("No such process");
      }
      return { wasPidOne: false };
    },
  ),
  restartContainerProcess: vi.fn(
    async (id: string, pid: number): Promise<ContainerProcessActionResult> => {
      if (pid === 1) return { wasPidOne: true };
      if (pid === DEAD_PID) {
        throw new Error(`Process ${pid} not found in container "${id}" (already exited)`);
      }
      return { wasPidOne: false };
    },
  ),
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const dockerMock = await import("../src/services/docker.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

describe("GET /api/containers/:id/processes/:pid/inspect", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/inspect` });
    expect(response.statusCode).toBe(401);
  });

  // Lecture seule, même niveau d'accès que GET /processes(/detailed) — un viewer doit pouvoir lire.
  it("allows a viewer to read cmdline/environ/openFiles for a live process", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/inspect`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pid: ALIVE_PID, cmdline: ["node", "server.js"] });
  });

  it("rejects a non-integer pid with 400 before calling the service", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/not-a-number/inspect`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 (honest, not an empty/fabricated result) for a pid that already exited", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${DEAD_PID}/inspect`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 409 for a container that exists but is not running", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${STOPPED_CONTAINER_ID}/processes/${ALIVE_PID}/inspect`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("POST /api/containers/:id/processes/:pid/kill", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/kill`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a viewer (read-only role) with 403 — killing a process is a mutating action", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/kill`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  // Kill normal réussi.
  it("returns 200 { ok: true } for a successful kill by an operator, defaulting to signal TERM", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/kill`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(dockerMock.killContainerProcess).toHaveBeenCalledWith(RUNNING_CONTAINER_ID, ALIVE_PID, "TERM");
  });

  it("passes an explicit signal KILL through to the service", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/kill`,
      cookies: { [config.session.cookieName]: token },
      payload: { signal: "KILL" },
    });
    expect(response.statusCode).toBe(200);
    expect(dockerMock.killContainerProcess).toHaveBeenCalledWith(RUNNING_CONTAINER_ID, ALIVE_PID, "KILL");
  });

  it("rejects an invalid signal value with 400", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/kill`,
      cookies: { [config.session.cookieName]: token },
      payload: { signal: "HUP" },
    });
    expect(response.statusCode).toBe(400);
  });

  // Garde-fou PID 1, vu depuis la route : ni succès ni ambiguïté, une redirection 409 explicite.
  it("returns 409 with useContainerStopInstead: true for pid 1, never a silent success", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/1/kill`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ useContainerStopInstead: true });
  });

  // Kill sur un PID déjà mort : erreur honnête, jamais un succès.
  it("returns 404 (never 200) when the target process is already dead", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${DEAD_PID}/kill`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/no such process/i);
  });

  it("rejects a non-integer pid with 400 before calling the service", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/0/kill`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/containers/:id/processes/:pid/restart", () => {
  it("rejects a viewer (read-only role) with 403", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/restart`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 200 { ok: true } for a successful restart by an operator", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${ALIVE_PID}/restart`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("returns 409 with useContainerRestartInstead: true for pid 1, never a silent success", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/1/restart`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ useContainerRestartInstead: true });
  });

  it("returns 404 when the target process is already dead", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/${DEAD_PID}/restart`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
  });
});
