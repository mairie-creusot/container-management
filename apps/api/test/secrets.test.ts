import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH/SECRETS_PATH isolés (même pattern que setup.test.ts/containers.test.ts) : chacun
// pointe vers un fichier temporaire dédié à ce fichier de test, jamais vers le vrai
// apps/api/data/{config,secrets}.json.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpSecretsPath = path.join(os.tmpdir(), `quai-api-test-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.SECRETS_PATH = tmpSecretsPath;
process.env.CONFIG_ENCRYPTION_KEY = "1".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const secretsStore = await import("../src/services/secretsStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpSecretsPath, { force: true });
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

describe("GET /api/secrets", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(response.statusCode).toBe(401);
  });

  it("is readable by any authenticated role (viewer included) and never leaks a value field", async () => {
    app = buildServer();
    const created = await secretsStore.createSecret({ name: "list-test-secret", value: "super-secret-value" });

    const response = await app.inject({ method: "GET", url: "/api/secrets", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as unknown[];
    const found = body.find((s) => (s as { id: string }).id === created.id) as Record<string, unknown>;
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty("value");
    expect(JSON.stringify(body)).not.toContain("super-secret-value");

    await secretsStore.deleteSecret(created.id);
  });
});

describe("POST /api/secrets", () => {
  it("rejects an operator (non-admin) with 403", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/secrets",
      cookies: cookieFor(["operator"]),
      payload: { name: "op-secret", value: "x" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing name/value with 400", async () => {
    app = buildServer();
    const noName = await app.inject({
      method: "POST",
      url: "/api/secrets",
      cookies: cookieFor(["admin"]),
      payload: { value: "x" },
    });
    expect(noName.statusCode).toBe(400);

    const noValue = await app.inject({
      method: "POST",
      url: "/api/secrets",
      cookies: cookieFor(["admin"]),
      payload: { name: "no-value-secret" },
    });
    expect(noValue.statusCode).toBe(400);
  });

  it("creates a secret as admin without ever returning the value, then rejects a duplicate name with 409", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/secrets",
      cookies: cookieFor(["admin"]),
      payload: { name: "db-password", value: "hunter2", description: "Mot de passe PostgreSQL" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ name: "db-password", description: "Mot de passe PostgreSQL" });
    expect(body).not.toHaveProperty("value");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/secrets",
      cookies: cookieFor(["admin"]),
      payload: { name: "db-password", value: "other" },
    });
    expect(duplicate.statusCode).toBe(409);

    await secretsStore.deleteSecret(body.id as string);
  });
});

describe("PATCH /api/secrets/:id", () => {
  it("keeps the existing value when value is omitted, but replaces it when provided", async () => {
    app = buildServer();
    const created = await secretsStore.createSecret({ name: "patch-secret", value: "initial-value" });

    const renameOnly = await app.inject({
      method: "PATCH",
      url: `/api/secrets/${created.id}`,
      cookies: cookieFor(["admin"]),
      payload: { name: "patch-secret-renamed" },
    });
    expect(renameOnly.statusCode).toBe(200);
    expect(await secretsStore.getDecryptedSecretValue("patch-secret-renamed")).toBe("initial-value");

    const withNewValue = await app.inject({
      method: "PATCH",
      url: `/api/secrets/${created.id}`,
      cookies: cookieFor(["admin"]),
      payload: { value: "rotated-value" },
    });
    expect(withNewValue.statusCode).toBe(200);
    expect(await secretsStore.getDecryptedSecretValue("patch-secret-renamed")).toBe("rotated-value");

    await secretsStore.deleteSecret(created.id);
  });

  it("rejects a rename colliding with another secret's name with 409", async () => {
    app = buildServer();
    const a = await secretsStore.createSecret({ name: "collide-a", value: "a" });
    const b = await secretsStore.createSecret({ name: "collide-b", value: "b" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/secrets/${b.id}`,
      cookies: cookieFor(["admin"]),
      payload: { name: "collide-a" },
    });
    expect(response.statusCode).toBe(409);

    await secretsStore.deleteSecret(a.id);
    await secretsStore.deleteSecret(b.id);
  });
});

describe("DELETE /api/secrets/:id", () => {
  it("rejects a non-admin with 403, then deletes as admin and 404s on a second delete", async () => {
    app = buildServer();
    const created = await secretsStore.createSecret({ name: "delete-me", value: "x" });

    const asOperator = await app.inject({
      method: "DELETE",
      url: `/api/secrets/${created.id}`,
      cookies: cookieFor(["operator"]),
    });
    expect(asOperator.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: "DELETE",
      url: `/api/secrets/${created.id}`,
      cookies: cookieFor(["admin"]),
    });
    expect(asAdmin.statusCode).toBe(200);

    const secondDelete = await app.inject({
      method: "DELETE",
      url: `/api/secrets/${created.id}`,
      cookies: cookieFor(["admin"]),
    });
    expect(secondDelete.statusCode).toBe(404);
  });
});

describe("secretsStore.getDecryptedSecretValue", () => {
  it("returns null for an unknown name and the decrypted value for a known one", async () => {
    const created = await secretsStore.createSecret({ name: "internal-lookup", value: "resolved-value" });
    expect(await secretsStore.getDecryptedSecretValue("does-not-exist")).toBeNull();
    expect(await secretsStore.getDecryptedSecretValue("internal-lookup")).toBe("resolved-value");
    await secretsStore.deleteSecret(created.id);
  });
});
