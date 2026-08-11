import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Même isolement CONFIG_PATH que environments.test.ts (positionné avant le premier import de
 * src/config.js) — évite de polluer le config.json de développement réel.
 *
 * Cet environnement de test n'a jamais configuré Nutanix : GET /api/nutanix/vms doit donc
 * honnêtement renvoyer [] (voir services/nutanix.ts#getNutanixVms — jamais de VM inventée),
 * exactement le comportement attendu en dev tant que l'assistant de configuration Nutanix n'a
 * pas été complété. Le mapping VM Nutanix -> TopologyNode (kind "nutanix-vm") est, lui, couvert
 * par un test ciblé dans topology.test.ts avec services/nutanix.js mocké, puisqu'aucune VM
 * réelle n'existe dans cet environnement de dev pour l'exercer de bout en bout.
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

describe("GET /api/nutanix/vms", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/vms" });
    expect(response.statusCode).toBe(401);
  });

  it("returns [] for an authenticated viewer — Nutanix has never been configured in this environment", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });

    const response = await app.inject({
      method: "GET",
      url: "/api/nutanix/vms",
      cookies: { [config.session.cookieName]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
