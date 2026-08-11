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
// SECRETS_PATH isolé de même (voir secrets.test.ts) : le test secretEnv ci-dessous ne fait que
// LIRE via getDecryptedSecretValue (jamais écrire), mais autant ne jamais pointer vers le vrai
// apps/api/data/secrets.json, même en lecture seule.
const tmpSecretsPath = path.join(os.tmpdir(), `quai-api-test-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.SECRETS_PATH = tmpSecretsPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpSecretsPath, { force: true });
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

  // La résolution de secretEnv (services/secretsStore.ts) doit échouer AVANT tout appel
  // Docker si un nom de secret référencé n'existe pas — vérifié ici en observant que la
  // requête échoue proprement en 400 (jamais un 502 "Docker daemon is not reachable" qui
  // indiquerait qu'on a tenté de créer le conteneur malgré la résolution incomplète).
  it("rejects secretEnv referencing an unknown secret name with 400, before touching Docker", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/containers",
      cookies: { [config.session.cookieName]: token },
      payload: {
        image: "redis:7-alpine",
        secretEnv: [{ key: "DB_PASSWORD", secretName: "does-not-exist-in-this-test" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Secret "does-not-exist-in-this-test" not found' });
  });
});
