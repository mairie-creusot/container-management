import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * CONFIG_PATH isolé (même pattern que topologyGroupsStore.test.ts/notificationChannelsStore.test.ts)
 * — githubDeployments.ts écrit dans un sous-dossier "github-deployments" à côté de CONFIG_PATH,
 * sans cet isolement ces tests pollueraient apps/api/data/github-deployments/ en développement réel.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const store = await import("../src/services/githubDeployments.js");

const deploymentsDir = path.join(path.dirname(tmpConfigPath), "github-deployments");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(deploymentsDir, { recursive: true, force: true });
});

describe("githubDeployments — appendDeploymentLog (bug réel corrigé le 14/08/2026)", () => {
  it("retire les séquences d'échappement ANSI (couleurs cargo/rustc/docker build) avant écriture", async () => {
    const deployment = await store.createDeploymentRecord({
      id: "test-ansi-strip",
      owner: "mairie-creusot",
      repo: "SpacetimeDB",
      ref: "pawchat-trimmed",
      targetEnvironmentId: null,
      startedBy: "test",
      triggeredBy: "manual",
    });

    const ESC = String.fromCharCode(27);
    // Reproduit fidèlement la sortie réelle constatée (retour utilisateur, capture d'écran du
    // 14/08/2026) : rustc colore "error"/le nom du type en rouge (SGR 91) puis réinitialise (SGR 0).
    const coloredLine = `${ESC}[0m${ESC}[91merror${ESC}[0m: could not compile \`ethnum\` (lib) due to 1 previous error\n`;
    await store.appendDeploymentLog(deployment.id, coloredLine);

    const log = await store.readDeploymentLog(deployment.id);
    expect(log).toContain("error: could not compile `ethnum` (lib) due to 1 previous error");
    expect(log).not.toContain(ESC);
  });

  it("laisse une ligne sans séquence ANSI strictement inchangée", async () => {
    const deployment = await store.createDeploymentRecord({
      id: "test-ansi-strip-plain",
      owner: "mairie-creusot",
      repo: "quai",
      ref: "main",
      targetEnvironmentId: null,
      startedBy: "test",
      triggeredBy: "manual",
    });

    await store.appendDeploymentLog(deployment.id, "Build terminé : quai-gh-test:latest\n");

    const log = await store.readDeploymentLog(deployment.id);
    expect(log).toContain("Build terminé : quai-gh-test:latest");
  });
});
