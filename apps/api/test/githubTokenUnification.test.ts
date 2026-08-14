import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Unification du jeton GitHub (retour utilisateur réel, 14/08/2026 : "c'est penible ca il faut
 * faire en sorte de soit utilise depuis un secret parmanant soit le renseigner dans les setting
 * pour utiliser partout") — PUT /api/github/token stocke désormais le jeton comme secret nommé
 * réservé ("github-token") dans secretsStore.ts au lieu d'un champ dédié isolé, résolu
 * automatiquement partout où QUAI a besoin d'un jeton GitHub. Voir services/githubStore.ts.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpSecretsPath = path.join(os.tmpdir(), `quai-api-test-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpGithubPath = path.join(os.tmpdir(), `quai-api-test-github-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.SECRETS_PATH = tmpSecretsPath;
process.env.GITHUB_STORE_PATH = tmpGithubPath;
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const githubStore = await import("../src/services/githubStore.js");
const secretsStore = await import("../src/services/secretsStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpSecretsPath, { force: true });
  await fs.rm(tmpGithubPath, { force: true });
});

describe("Jeton GitHub stocké comme secret nommé réutilisable (github-token)", () => {
  it("aucun jeton configuré -> getStatus() configured:false", async () => {
    const status = await githubStore.getStatus();
    expect(status.configured).toBe(false);
  });

  it("setToken() crée un secret nommé 'github-token' dans secretsStore, jamais un champ isolé", async () => {
    await githubStore.setToken("ghp_test_token_abc123");

    const status = await githubStore.getStatus();
    expect(status.configured).toBe(true);

    const secrets = await secretsStore.listSecrets();
    const tokenSecret = secrets.find((s) => s.name === "github-token");
    expect(tokenSecret).toBeDefined();
  });

  it("getEffectiveToken() résout la valeur depuis le secret nommé", async () => {
    const effective = await githubStore.getEffectiveToken();
    expect(effective?.token).toBe("ghp_test_token_abc123");
    expect(effective?.source).toBe("github");
  });

  it("un second setToken() met à jour LE MÊME secret (rotation), jamais un doublon", async () => {
    await githubStore.setToken("ghp_rotated_token_xyz789");

    const secrets = await secretsStore.listSecrets();
    const tokenSecrets = secrets.filter((s) => s.name === "github-token");
    expect(tokenSecrets).toHaveLength(1);

    const effective = await githubStore.getEffectiveToken();
    expect(effective?.token).toBe("ghp_rotated_token_xyz789");
  });

  it("GET /api/github/status ne renvoie jamais le jeton lui-même", async () => {
    const status = await githubStore.getStatus();
    expect(JSON.stringify(status)).not.toContain("ghp_rotated_token_xyz789");
  });
});
