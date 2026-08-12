import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ContainerDetail, SecretRef } from "../src/types.js";

// CONFIG_PATH/SECRETS_PATH isolés (même pattern que containers.test.ts/secrets.test.ts) : ces
// tests ne touchent en réalité aucun des deux fichiers (docker.js et secretsStore.js sont
// entièrement mockés ci-dessous), mais on s'isole préventivement quand même.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpSecretsPath = path.join(os.tmpdir(), `quai-api-test-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.SECRETS_PATH = tmpSecretsPath;

const FAKE_CONTAINER_ID = "fake0000000000000000000000000000000000000000000000000000000000";

/**
 * inspectDockerContainer() mocké (pas de vrai démon Docker requis pour ce test, même esprit que
 * topology.test.ts qui mocke déjà tout services/docker.js) — renvoie un détail de conteneur dont
 * `env` porte une entrée injectée via secretEnv (DB_PASSWORD) et une entrée normale (PORT),
 * exactement la forme que docker.ts#inspectDockerContainer produit à partir de `Config.Env` d'un
 * `docker inspect` réel.
 */
vi.mock("../src/services/docker.js", () => ({
  inspectDockerContainer: vi.fn(
    async (id: string): Promise<ContainerDetail | null> => {
      if (id !== FAKE_CONTAINER_ID) return null;
      return {
        id: FAKE_CONTAINER_ID,
        fullId: FAKE_CONTAINER_ID,
        name: "test-container",
        image: "redis:7-alpine",
        environment: "Dev local",
        node: "dev-local-1",
        state: "running",
        cpuPercent: 0,
        memBytes: 0,
        createdAt: new Date().toISOString(),
        command: "",
        restartPolicy: "no",
        networkMode: "default",
        ports: [],
        mounts: [],
        env: ["DB_PASSWORD=hunter2-in-clear", "PORT=6379"],
        labels: {},
      };
    },
  ),
  getDockerContainers: vi.fn(async () => []),
}));

/**
 * listSecrets() mocké — renvoie un secret dont `usedBy` référence FAKE_CONTAINER_ID sous la clé
 * "DB_PASSWORD" (exactement la forme que secretsStore.ts#recordSecretUsage produit réellement à
 * la création d'un conteneur via POST /api/containers#secretEnv).
 */
vi.mock("../src/services/secretsStore.js", () => ({
  listSecrets: vi.fn(
    async (): Promise<SecretRef[]> => [
      {
        id: "secret-1",
        name: "db-password",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usedBy: [{ containerId: FAKE_CONTAINER_ID, containerName: "test-container", key: "DB_PASSWORD" }],
        version: 1,
        versionCount: 1,
      },
    ],
  ),
  getDecryptedSecretValue: vi.fn(async () => null),
  recordSecretUsage: vi.fn(async () => undefined),
  removeSecretUsagesForContainer: vi.fn(async () => undefined),
  renameSecretUsageContainer: vi.fn(async () => undefined),
  SecretExpiredError: class SecretExpiredError extends Error {},
}));

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

describe("GET /api/containers/:id — masquage des valeurs secretEnv (finding E1)", () => {
  it("masks the value of an env entry injected via secretEnv, even for a viewer, while keeping normal entries in clear", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}`,
      cookies: { [config.session.cookieName]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { env: string[] };
    expect(body.env).toContain("PORT=6379");
    expect(body.env).toContain("DB_PASSWORD=***");
    expect(body.env.find((e) => e.startsWith("DB_PASSWORD="))).not.toBe("DB_PASSWORD=hunter2-in-clear");
    expect(JSON.stringify(body)).not.toContain("hunter2-in-clear");
  });

  it("also masks the value for an admin session — masking is systematic, not role-gated", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}`,
      cookies: { [config.session.cookieName]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { env: string[] };
    expect(JSON.stringify(body)).not.toContain("hunter2-in-clear");
  });

  it("returns 404 for an unknown container id", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: "/api/containers/does-not-exist",
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("maskSecretEnvValues (unit)", () => {
  it("only rewrites the value of entries whose key is a known secret key, leaving others untouched", async () => {
    const { maskSecretEnvValues } = await import("../src/routes/containers.js");
    const result = maskSecretEnvValues(
      ["DB_PASSWORD=hunter2", "PORT=6379", "API_KEY=abc123"],
      new Set(["DB_PASSWORD", "API_KEY"]),
    );
    expect(result).toEqual(["DB_PASSWORD=***", "PORT=6379", "API_KEY=***"]);
  });

  it("returns a copy of env unchanged when no key matches (empty secret key set)", async () => {
    const { maskSecretEnvValues } = await import("../src/routes/containers.js");
    const env = ["PORT=6379"];
    const result = maskSecretEnvValues(env, new Set());
    expect(result).toEqual(env);
    expect(result).not.toBe(env); // copie, jamais la même référence
  });
});
