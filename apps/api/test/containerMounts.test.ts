/**
 * POST /api/containers/:id/mounts (montage d'un volume par RECRÉATION réelle du conteneur — voir
 * routes/containers.ts et services/docker.ts#mountVolumeOnContainer) :
 *  - gardes d'accès/validation de la route, qui doivent toutes échouer AVANT le moindre appel
 *    Docker (même principe que containers.test.ts : jamais un 502 "Docker daemon is not reachable"
 *    pour une requête invalide, ce qui prouverait qu'on a tenté l'action malgré tout) ;
 *  - helpers PURS de la recréation (rebuildBindsFromMounts/sanitizeRecreateNetworkingConfig),
 *    verrouillés sans démon Docker — c'est là que vivent les invariants critiques : préservation
 *    des volumes ANONYMES (perte de données réelle sinon), refus d'une destination déjà occupée,
 *    nettoyage de l'alias réseau auto-généré (short id périmé de l'ancien conteneur).
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé — même pattern préventif que containers.test.ts (aucun de ces tests n'écrit
// dans config.json, mais l'isoler évite toute pollution silencieuse du config.json de dev réel).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { rebuildBindsFromMounts, sanitizeRecreateNetworkingConfig } = await import("../src/services/docker.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function operatorToken(): string {
  return signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
}

describe("POST /api/containers/:id/mounts — gardes de route (avant tout appel Docker)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      payload: { volumeName: "data", mountPath: "/data" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a viewer (read-only role) with 403", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      cookies: { [config.session.cookieName]: token },
      payload: { volumeName: "data", mountPath: "/data" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing volumeName with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      cookies: { [config.session.cookieName]: operatorToken() },
      payload: { mountPath: "/data" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("volumeName") });
  });

  it("rejects a relative mountPath with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      cookies: { [config.session.cookieName]: operatorToken() },
      payload: { volumeName: "data", mountPath: "data" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("absolute") });
  });

  it("rejects a mountPath containing \":\" (Binds separator) with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      cookies: { [config.session.cookieName]: operatorToken() },
      payload: { volumeName: "data", mountPath: "/da:ta" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a volumeName containing \":\" with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/mounts",
      cookies: { [config.session.cookieName]: operatorToken() },
      payload: { volumeName: "da:ta", mountPath: "/data" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("rebuildBindsFromMounts — reconstruction des Binds de la recréation", () => {
  it("preserves named volumes, host binds AND anonymous volumes (by their real hash name)", () => {
    const binds = rebuildBindsFromMounts(
      [
        { Type: "volume", Name: "pgdata", Destination: "/var/lib/postgresql/data", RW: true },
        { Type: "bind", Source: "/srv/conf", Destination: "/etc/app", RW: false },
        // Volume ANONYME (déclaré par l'image via VOLUME) : jamais dans HostConfig.Binds, seul son
        // nom hash réel (inspect.Mounts) permet de préserver ses données à travers la recréation.
        { Type: "volume", Name: "9f2c3d4e5a6b7c8d9e0f1a2b3c4d5e6f", Destination: "/anon", RW: true },
      ],
      { volumeName: "extra", mountPath: "/extra", readOnly: false },
    );
    expect(binds).toEqual([
      "pgdata:/var/lib/postgresql/data",
      "/srv/conf:/etc/app:ro",
      "9f2c3d4e5a6b7c8d9e0f1a2b3c4d5e6f:/anon",
      "extra:/extra",
    ]);
  });

  it("appends \":ro\" for a read-only addition", () => {
    const binds = rebuildBindsFromMounts([], { volumeName: "conf", mountPath: "/conf", readOnly: true });
    expect(binds).toEqual(["conf:/conf:ro"]);
  });

  it("skips tmpfs mounts (carried by HostConfig.Tmpfs, never re-bound)", () => {
    const binds = rebuildBindsFromMounts(
      [{ Type: "tmpfs", Destination: "/tmp/cache", RW: true }],
      { volumeName: "data", mountPath: "/data", readOnly: false },
    );
    expect(binds).toEqual(["data:/data"]);
  });

  it("throws when the requested mount path is already used by an existing mount", () => {
    expect(() =>
      rebuildBindsFromMounts(
        [{ Type: "volume", Name: "pgdata", Destination: "/data", RW: true }],
        { volumeName: "other", mountPath: "/data", readOnly: false },
      ),
    ).toThrowError(/already used by an existing mount/);
  });
});

describe("sanitizeRecreateNetworkingConfig — endpoints réseau de la recréation", () => {
  it("drops the auto-generated short-id alias of the OLD container but keeps explicit aliases", () => {
    const oldId = "0123456789abcdef0123456789abcdef";
    const result = sanitizeRecreateNetworkingConfig(
      {
        "app-net": { Aliases: ["api", "0123456789ab"], NetworkID: "n1" },
        bridge: { Aliases: null, NetworkID: "n2" },
      },
      oldId,
    );
    expect(result).toEqual({ "app-net": { Aliases: ["api"] }, bridge: {} });
  });
});
