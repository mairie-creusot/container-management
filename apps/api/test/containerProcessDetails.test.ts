import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";

// CONFIG_PATH isolé, même pattern que containerLogs.test.ts/containers.test.ts.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const RUNNING_CONTAINER_ID = "fakerunningcontainer000000000000000000000000000000000000000000";
const NO_SHELL_CONTAINER_ID = "fakenoshellcontainer0000000000000000000000000000000000000000000";
const STOPPED_CONTAINER_ID = "fakestoppedcontainer00000000000000000000000000000000000000000000";
const UNKNOWN_CONTAINER_ID = "does-not-exist";

/**
 * services/containerInternals.js mocké (pas de vrai démon Docker requis, même esprit que
 * containerLogs.test.ts) — getContainerProcessDetails simule les trois cas honnêtes distincts :
 * un conteneur avec shell (résultat réel), un conteneur sans shell (shellAvailable:false, PAS une
 * erreur), et un conteneur inconnu/arrêté (erreur traduite en 404/409 par sendDockerActionError,
 * même mécanisme que le reste de routes/containers.ts).
 */
vi.mock("../src/services/containerInternals.js", () => ({
  getContainerProcessDetails: vi.fn(async (id: string) => {
    if (id === RUNNING_CONTAINER_ID) {
      return {
        shellAvailable: true,
        processes: [
          { pid: 1, ppid: 0, user: "root", command: "node server.js", state: "S", cpuTimeMs: 4200, ageSeconds: 3600, listenPorts: [8080] },
          { pid: 12, ppid: 1, user: "1000", command: "node --inspect (worker)", state: "S", cpuTimeMs: 100, ageSeconds: 10 },
        ],
      };
    }
    if (id === NO_SHELL_CONTAINER_ID) {
      return { shellAvailable: false, processes: [] };
    }
    if (id === STOPPED_CONTAINER_ID) {
      throw new Error(`Container "${id}" is not running (state: exited)`);
    }
    throw new Error(`No such container: ${id}`);
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

describe("GET /api/containers/:id/processes/detailed", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/detailed` });
    expect(response.statusCode).toBe(401);
  });

  // Même niveau d'accès que GET /processes (lecture seule, pas de garde de rôle supplémentaire) —
  // un viewer doit pouvoir consulter, contrairement à POST /api/containers/:id/start par exemple.
  it("allows a viewer (read-only role), same level as GET /processes", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${RUNNING_CONTAINER_ID}/processes/detailed`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shellAvailable).toBe(true);
    expect(body.processes).toHaveLength(2);
    expect(body.processes[0]).toMatchObject({ pid: 1, command: "node server.js", listenPorts: [8080] });
    // comm avec parenthèses/espaces doit survivre intact jusqu'à la réponse JSON.
    expect(body.processes[1].command).toBe("node --inspect (worker)");
  });

  it("returns shellAvailable: false with an empty (honest) process list when the target image has no POSIX shell", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${NO_SHELL_CONTAINER_ID}/processes/detailed`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ shellAvailable: false, processes: [] });
  });

  it("returns 409 for a container that exists but is not running (same convention as GET /processes)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${STOPPED_CONTAINER_ID}/processes/detailed`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 404 for an unknown container id (never a silent empty list)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${UNKNOWN_CONTAINER_ID}/processes/detailed`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
  });
});
