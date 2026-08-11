import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONFIG_PATH/REMOTE_DOCKER_PATH isolés (même pattern que secrets.test.ts) : fichiers
 * temporaires dédiés à ce fichier de test, jamais les vrais apps/api/data/{config,remote-docker}.json.
 *
 * Aucun second démon Docker réel n'est disponible dans cet environnement de test (voir le
 * rapport final) : les tests ci-dessous couvrent ce qui EST vérifiable sans hôte distant réel —
 * CRUD, validation, chiffrement au repos des identifiants TLS, et le comportement honnête de
 * GET .../test contre un host qui n'existe pas (résolution DNS/connexion refusée, jamais un
 * faux "ok:true").
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpRemoteDockerPath = path.join(
  os.tmpdir(),
  `quai-api-test-remote-docker-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.REMOTE_DOCKER_PATH = tmpRemoteDockerPath;
process.env.CONFIG_ENCRYPTION_KEY = "2".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const remoteDockerStore = await import("../src/services/remoteDockerStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpRemoteDockerPath, { force: true });
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

describe("GET /api/remote-environments", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/remote-environments" });
    expect(response.statusCode).toBe(401);
  });

  it("never leaks ca/cert/key, only hasTls", async () => {
    app = buildServer();
    const created = await remoteDockerStore.createRemoteDockerEnvironment({
      name: "list-test",
      host: "docker-remote.example.internal",
      port: 2376,
      tls: { ca: "CA-PEM-CONTENT", cert: "CERT-PEM-CONTENT", key: "KEY-PEM-CONTENT" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/remote-environments",
      cookies: cookieFor(["viewer"]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as unknown[];
    const found = body.find((e) => (e as { id: string }).id === created.id) as Record<string, unknown>;
    expect(found).toMatchObject({ name: "list-test", host: "docker-remote.example.internal", port: 2376, hasTls: true });
    expect(found).not.toHaveProperty("tls");
    expect(JSON.stringify(body)).not.toContain("CA-PEM-CONTENT");
    expect(JSON.stringify(body)).not.toContain("CERT-PEM-CONTENT");
    expect(JSON.stringify(body)).not.toContain("KEY-PEM-CONTENT");

    await remoteDockerStore.deleteRemoteDockerEnvironment(created.id);
  });
});

describe("TLS credentials are encrypted at rest", () => {
  it("never writes ca/cert/key in plaintext to the store file on disk", async () => {
    const created = await remoteDockerStore.createRemoteDockerEnvironment({
      name: "encryption-test",
      host: "docker-remote.example.internal",
      port: 2376,
      tls: { ca: "PLAINTEXT-CA", cert: "PLAINTEXT-CERT", key: "PLAINTEXT-KEY" },
    });

    const raw = await fs.readFile(tmpRemoteDockerPath, "utf-8");
    expect(raw).not.toContain("PLAINTEXT-CA");
    expect(raw).not.toContain("PLAINTEXT-CERT");
    expect(raw).not.toContain("PLAINTEXT-KEY");
    expect(raw).toContain("enc:v1:"); // préfixe de crypto.ts#encryptSecret

    // Mais la config effective (déchiffrée, réservée à docker.ts#getClient) retrouve bien le clair.
    const effective = await remoteDockerStore.getEffectiveRemoteDockerConfig(created.id);
    expect(effective?.tls).toEqual({ ca: "PLAINTEXT-CA", cert: "PLAINTEXT-CERT", key: "PLAINTEXT-KEY" });

    await remoteDockerStore.deleteRemoteDockerEnvironment(created.id);
  });
});

describe("POST /api/remote-environments", () => {
  it("rejects an operator (non-admin) with 403 — stricter than registries, same as secrets", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-environments",
      cookies: cookieFor(["operator"]),
      payload: { name: "op-attempt", host: "host.example", port: 2376 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing field with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-environments",
      cookies: cookieFor(["admin"]),
      payload: { name: "incomplete" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an out-of-range port with 400 (clean validation, never silently persisted)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-environments",
      cookies: cookieFor(["admin"]),
      payload: { name: "bad-port", host: "host.example", port: 99999 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects cert without key (and vice versa) with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-environments",
      cookies: cookieFor(["admin"]),
      payload: { name: "cert-only", host: "host.example", port: 2376, tls: { cert: "CERT-ONLY" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("creates as admin, then updates and deletes it", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/remote-environments",
      cookies: cookieFor(["admin"]),
      payload: { name: "crud-test", host: "host.example", port: 2376 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string };
    expect(body.id).toBeTruthy();

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/remote-environments/${body.id}`,
      cookies: cookieFor(["admin"]),
      payload: { name: "crud-test-renamed" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "crud-test-renamed" });

    const deletedAsOperator = await app.inject({
      method: "DELETE",
      url: `/api/remote-environments/${body.id}`,
      cookies: cookieFor(["operator"]),
    });
    expect(deletedAsOperator.statusCode).toBe(403);

    const deletedAsAdmin = await app.inject({
      method: "DELETE",
      url: `/api/remote-environments/${body.id}`,
      cookies: cookieFor(["admin"]),
    });
    expect(deletedAsAdmin.statusCode).toBe(200);

    const secondDelete = await app.inject({
      method: "DELETE",
      url: `/api/remote-environments/${body.id}`,
      cookies: cookieFor(["admin"]),
    });
    expect(secondDelete.statusCode).toBe(404);
  });
});

describe("GET /api/remote-environments/:id/test", () => {
  it("404s for an unknown id", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/remote-environments/does-not-exist/test",
      cookies: cookieFor(["viewer"]),
    });
    expect(response.statusCode).toBe(404);
  });

  it("honestly reports ok:false against a host that does not resolve — never a fabricated success", async () => {
    app = buildServer();
    const created = await remoteDockerStore.createRemoteDockerEnvironment({
      name: "unreachable-test",
      host: "docker-remote.invalid.does-not-exist.example",
      port: 2376,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/remote-environments/${created.id}/test`,
      cookies: cookieFor(["viewer"]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toBeTruthy();

    await remoteDockerStore.deleteRemoteDockerEnvironment(created.id);
  });
});
