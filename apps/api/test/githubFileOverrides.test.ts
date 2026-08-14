import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests du store de surcharge de fichiers (mission "fait en sorte qu'ont puisse overide le
 * dockerfile et les autre fichier de conf au moment du build", 14/08/2026) —
 * apps/api/src/services/githubFileOverridesStore.ts. Isolation GITHUB_FILE_OVERRIDES_PATH dédiée,
 * même pattern que test/githubTokenUnification.test.ts.
 */
const tmpPath = path.join(os.tmpdir(), `quai-api-test-file-overrides-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.GITHUB_FILE_OVERRIDES_PATH = tmpPath;
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const store = await import("../src/services/githubFileOverridesStore.js");

afterAll(async () => {
  await fs.rm(tmpPath, { force: true });
});

describe("githubFileOverridesStore — CRUD scopé par dépôt et par chemin exact", () => {
  it("aucune surcharge initialement", async () => {
    expect(await store.listFileOverrides("owner1", "repo1")).toEqual([]);
    expect(await store.getFileOverride("owner1", "repo1", "Dockerfile")).toBeUndefined();
  });

  it("saveFileOverride crée puis listFileOverrides/getFileOverride la retrouvent (contenu INCLUS, jamais write-only)", async () => {
    const saved = await store.saveFileOverride("owner1", "repo1", "Dockerfile", "FROM alpine\n", "ybanas");
    expect(saved.path).toBe("Dockerfile");
    expect(saved.content).toBe("FROM alpine\n");

    const found = await store.getFileOverride("owner1", "repo1", "Dockerfile");
    expect(found?.content).toBe("FROM alpine\n");

    const list = await store.listFileOverrides("owner1", "repo1");
    expect(list).toHaveLength(1);
  });

  it("un second saveFileOverride sur le MÊME chemin remplace ENTIÈREMENT (jamais un patch/diff)", async () => {
    await store.saveFileOverride("owner1", "repo1", "Dockerfile", "FROM node:22\n", "ybanas");
    const found = await store.getFileOverride("owner1", "repo1", "Dockerfile");
    expect(found?.content).toBe("FROM node:22\n");
    expect(await store.listFileOverrides("owner1", "repo1")).toHaveLength(1); // toujours un seul, pas un doublon
  });

  it("scope strictement PAR DÉPÔT — un autre repo ne voit jamais les surcharges d'un autre", async () => {
    await store.saveFileOverride("owner1", "repo2", "docker-compose.yml", "services: {}\n", "ybanas");
    expect(await store.listFileOverrides("owner1", "repo1")).toHaveLength(1);
    expect(await store.listFileOverrides("owner1", "repo2")).toHaveLength(1);
    expect(await store.getFileOverride("owner1", "repo2", "Dockerfile")).toBeUndefined();
  });

  it("plusieurs chemins différents pour le MÊME dépôt coexistent", async () => {
    await store.saveFileOverride("owner1", "repo1", "docker-compose.yml", "services: {}\n", "ybanas");
    expect(await store.listFileOverrides("owner1", "repo1")).toHaveLength(2);
  });

  it("deleteFileOverride retire la surcharge (retour à l'original) et retourne true/false honnêtement", async () => {
    expect(await store.deleteFileOverride("owner1", "repo1", "docker-compose.yml")).toBe(true);
    expect(await store.getFileOverride("owner1", "repo1", "docker-compose.yml")).toBeUndefined();
    expect(await store.deleteFileOverride("owner1", "repo1", "docker-compose.yml")).toBe(false); // déjà supprimée
  });

  it("owner/repo insensibles à la casse (même convention que githubEnvSecretName)", async () => {
    const found = await store.getFileOverride("Owner1", "Repo1", "Dockerfile");
    expect(found?.content).toBe("FROM node:22\n");
  });
});
