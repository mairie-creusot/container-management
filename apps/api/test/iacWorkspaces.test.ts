import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé (même pattern que containers.test.ts/setup.test.ts) : services/iac/workspaces.ts
// dérive son dossier de données (data/iac/) du même répertoire que CONFIG_PATH — jamais le vrai
// apps/api/data/config.json en dev.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const workspaces = await import("../src/services/iac/workspaces.js");

const iacDataDir = path.join(path.dirname(path.resolve(tmpConfigPath)), "iac");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(iacDataDir, { recursive: true, force: true });
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

describe("isValidWorkspaceId / workspaceFilesPath — format strict (finding E2)", () => {
  it("accepts a well-formed UUID (the only format createWorkspace ever generates)", () => {
    expect(workspaces.isValidWorkspaceId("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(() => workspaces.workspaceFilesPath("11111111-2222-3333-4444-555555555555")).not.toThrow();
  });

  it("rejects path-traversal / absolute-path payloads disguised as a workspace id", () => {
    const malicious = ["../../etc", "..", "..%2f..%2fetc%2fpasswd", "/etc/passwd", "a/../../b", "", "not-a-uuid"];
    for (const id of malicious) {
      expect(workspaces.isValidWorkspaceId(id)).toBe(false);
      expect(() => workspaces.workspaceFilesPath(id)).toThrow();
    }
  });
});

describe("readFile/writeFile (resolveSafeFilePath) — path traversal via relativePath", () => {
  it("rejects a relative path that escapes the workspace's files/ directory", async () => {
    const workspace = await workspaces.createWorkspace({ name: "e2-relpath-test", engine: "tofu", createdBy: "test" });
    try {
      await expect(workspaces.readFile(workspace.id, "../../../etc/passwd")).rejects.toThrow();
      await expect(workspaces.writeFile(workspace.id, "../../escape.txt", "pwned")).rejects.toThrow();
      // Un chemin légitime, lui, doit continuer de fonctionner normalement (pas de faux positif).
      await expect(workspaces.readFile(workspace.id, "main.tf")).resolves.toContain("terraform");
    } finally {
      await workspaces.deleteWorkspace(workspace.id);
    }
  });
});

describe("Routes /api/iac/workspaces/:id/* — vérification d'existence avant tout usage (finding E2)", () => {
  it("404s on every id-scoped route for a well-formed but unknown workspace id", async () => {
    app = buildServer();
    const unknownId = "00000000-0000-4000-8000-000000000000";

    const filesList = await app.inject({
      method: "GET",
      url: `/api/iac/workspaces/${unknownId}/files`,
      cookies: cookieFor(["admin"]),
    });
    expect(filesList.statusCode).toBe(404);

    const fileGet = await app.inject({
      method: "GET",
      url: `/api/iac/workspaces/${unknownId}/files/main.tf`,
      cookies: cookieFor(["admin"]),
    });
    expect(fileGet.statusCode).toBe(404);

    const filePut = await app.inject({
      method: "PUT",
      url: `/api/iac/workspaces/${unknownId}/files/main.tf`,
      cookies: cookieFor(["admin"]),
      payload: { content: "x" },
    });
    expect(filePut.statusCode).toBe(404);

    const run = await app.inject({
      method: "POST",
      url: `/api/iac/workspaces/${unknownId}/run`,
      cookies: cookieFor(["admin"]),
      payload: { action: "init", engine: "tofu" },
    });
    expect(run.statusCode).toBe(404);

    const runs = await app.inject({
      method: "GET",
      url: `/api/iac/workspaces/${unknownId}/runs`,
      cookies: cookieFor(["admin"]),
    });
    expect(runs.statusCode).toBe(404);
  });

  it("never reaches the filesystem/spawn for a workspace id containing a path-traversal payload", async () => {
    app = buildServer();
    const malicious = encodeURIComponent("../../../../etc");

    const filesList = await app.inject({
      method: "GET",
      url: `/api/iac/workspaces/${malicious}/files`,
      cookies: cookieFor(["admin"]),
    });
    expect(filesList.statusCode).toBe(404);

    const run = await app.inject({
      method: "POST",
      url: `/api/iac/workspaces/${malicious}/run`,
      cookies: cookieFor(["admin"]),
      payload: { action: "init", engine: "tofu" },
    });
    expect(run.statusCode).toBe(404);
  });
});
