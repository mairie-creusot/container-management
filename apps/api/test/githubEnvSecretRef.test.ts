import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Référence à un secret DÉJÀ existant (mécanisme générique "SMTP partagé entre plusieurs dépôts",
 * mission 14/08/2026) — PUT .../config-values accepte `secretRefs` en plus de `values` ; la
 * valeur n'est JAMAIS dupliquée dans le secret multi-clé du dépôt, seule une référence par id y
 * est stockée (résolue à la demande, voir services/github.ts#getStoredEnvValues). Isolation
 * SECRETS_PATH/CONFIG_PATH dédiée, même pattern que test/githubTokenUnification.test.ts.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpSecretsPath = path.join(os.tmpdir(), `quai-api-test-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.SECRETS_PATH = tmpSecretsPath;
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const github = await import("../src/services/github.js");
const secretsStore = await import("../src/services/secretsStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpSecretsPath, { force: true });
});

describe("saveGithubEnvValues avec secretRefs — jamais une copie de la valeur référencée", () => {
  it("stocke une RÉFÉRENCE ({secretRef: id}), jamais la valeur en clair dupliquée", async () => {
    const shared = await secretsStore.createSecret({ name: "smtp-shared-test", value: "un-vrai-mot-de-passe-smtp" });

    await github.saveGithubEnvValues("owner-test", "repo-test", {}, { SMTP_PASSWORD: shared.id });

    const blobName = github.githubEnvSecretName("owner-test", "repo-test");
    const rawBlob = await secretsStore.getDecryptedSecretValue(blobName);
    expect(rawBlob).toBeTruthy();
    const parsed = JSON.parse(rawBlob!);
    expect(parsed.SMTP_PASSWORD).toEqual({ secretRef: shared.id });
    // Jamais la valeur en clair copiée dans le blob du dépôt.
    expect(rawBlob).not.toContain("un-vrai-mot-de-passe-smtp");
  });

  it("une valeur littérale et une référence peuvent coexister pour des clés différentes", async () => {
    const shared = await secretsStore.createSecret({ name: "smtp-shared-test-2", value: "autre-mot-de-passe" });
    await github.saveGithubEnvValues("owner-test2", "repo-test2", { DB_HOST: "localhost" }, { SMTP_PASSWORD: shared.id });

    const blobName = github.githubEnvSecretName("owner-test2", "repo-test2");
    const rawBlob = await secretsStore.getDecryptedSecretValue(blobName);
    const parsed = JSON.parse(rawBlob!);
    expect(parsed.DB_HOST).toBe("localhost");
    expect(parsed.SMTP_PASSWORD).toEqual({ secretRef: shared.id });
  });
});
