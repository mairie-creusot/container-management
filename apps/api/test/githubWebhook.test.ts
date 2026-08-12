import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Vérification de signature HMAC du webhook GitHub (POST /api/github/webhook, cf.
 * routes/githubWebhook.ts) — format vérifié auprès de la doc officielle GitHub
 * (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) :
 * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 du corps BRUT>`. Ces tests calculent une VRAIE
 * signature valide (avec le secret réellement configuré pour le dépôt) et une invalide (mauvais
 * secret), et vérifient que la route accepte l'une et rejette l'autre — jamais une simple
 * assertion sur la forme du code, la vérification HMAC tourne réellement.
 *
 * GITHUB_STORE_PATH isolé, même pattern que lxc.test.ts/remoteEnvironments.test.ts.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpGithubPath = path.join(os.tmpdir(), `quai-api-test-github-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.GITHUB_STORE_PATH = tmpGithubPath;
process.env.CONFIG_ENCRYPTION_KEY = "9".repeat(64); // clé fixe pour ce process de test uniquement

const { buildServer } = await import("../src/index.js");
const githubStore = await import("../src/services/githubStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpGithubPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const REAL_SECRET = "s3cret-webhook-token-abcdef";
const WRONG_SECRET = "totally-different-secret";

async function configureAutoDeploy(): Promise<void> {
  await githubStore.saveAutoDeployEntry({
    owner: "acme",
    repo: "demo",
    branch: "main",
    enabled: true,
    secret: REAL_SECRET,
  });
}

/** Corps EXACT envoyé par la requête — la signature HMAC porte sur ces octets précis. */
function pushPayload(ref: string): string {
  return JSON.stringify({
    ref,
    repository: { full_name: "acme/demo" },
    head_commit: { id: "abc123", message: "fix: something\n\nlonger body", author: { name: "Ada Lovelace", username: "ada" } },
    pusher: { name: "ada" },
    sender: { login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  });
}

function signatureFor(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("POST /api/github/webhook — vérification de signature HMAC (X-Hub-Signature-256)", () => {
  it("accepts a request with a VALID signature (ping event -> 200 pong, no deployment triggered)", async () => {
    await configureAutoDeploy();
    app = buildServer();
    const rawBody = pushPayload("refs/heads/main");
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signatureFor(rawBody, REAL_SECRET),
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, message: "pong" });
  });

  it("rejects a request with an INVALID signature (wrong secret) with 401, even for a real repository config", async () => {
    await configureAutoDeploy();
    app = buildServer();
    const rawBody = pushPayload("refs/heads/main");
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signatureFor(rawBody, WRONG_SECRET),
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("signature") });
  });

  it("rejects a request with a malformed/missing X-Hub-Signature-256 header with 401", async () => {
    await configureAutoDeploy();
    app = buildServer();
    const rawBody = pushPayload("refs/heads/main");
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: { "content-type": "application/json", "x-github-event": "push" },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a repository with no auto-deploy configuration at all", async () => {
    app = buildServer();
    const rawBody = pushPayload("refs/heads/main");
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        // Signature calculée avec un secret arbitraire : de toute façon rejetée en amont (404,
        // aucune config pour ce dépôt à vérifier).
        "x-hub-signature-256": signatureFor(rawBody, "irrelevant"),
      },
      payload: JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "unknown-owner/unknown-repo" } }),
    });
    expect(response.statusCode).toBe(404);
  });

  it("with a VALID signature, ignores a push to a branch other than the configured one (200, no deployment triggered)", async () => {
    await configureAutoDeploy();
    app = buildServer();
    const rawBody = pushPayload("refs/heads/feature-branch");
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signatureFor(rawBody, REAL_SECRET),
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; ignored?: boolean; reason?: string };
    expect(body).toMatchObject({ ok: true, ignored: true });
    expect(body.reason).toContain("feature-branch");
  });
});
