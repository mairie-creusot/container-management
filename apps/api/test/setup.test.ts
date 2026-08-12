import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// CONFIG_PATH doit être positionné avant le premier import de src/config.js : on utilise un
// fichier temporaire dédié à ce fichier de test pour ne pas interférer avec un éventuel
// data/config.json de développement, ni avec les autres fichiers de test (vitest isole le
// registre de modules par fichier de test).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { signSessionToken } = await import("../src/services/session.js");
const { config } = await import("../src/config.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

describe("setup wizard (/api/setup/*)", () => {
  it("is open and reports completed:false before any config is persisted", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ completed: false });
    await app.close();
  });

  it("rejects completion without an ldap block", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/setup/complete", payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("persists completion, then requires an admin session for /api/setup/*", async () => {
    const app = buildServer();

    const completeResponse = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      payload: {
        ldap: {
          url: "ldap://localhost:389",
          bindDn: "cn=admin,dc=example,dc=org",
          bindPassword: "admin",
          searchBase: "ou=people,dc=example,dc=org",
          searchFilter: "(uid={{username}})",
          groupRoleMap: {},
          defaultRole: "viewer",
        },
        registries: [
          { kind: "dockerhub", name: "Docker Hub", url: "https://hub.docker.com", username: "alice", password: "s3cret" },
        ],
      },
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json()).toMatchObject({ completed: true });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(unauthenticated.statusCode).toBe(401);

    // GET /api/setup/status ne renvoie que des booléens (aucun secret) : tout utilisateur
    // authentifié peut le lire, quel que soit son rôle — l'app en a besoin à chaque
    // chargement pour savoir si l'assistant doit s'afficher (voir plugins/auth.ts).
    const viewerToken = signSessionToken({ username: "demo", displayName: "Demo", roles: ["viewer"] });
    const asViewer = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      cookies: { [config.session.cookieName]: viewerToken },
    });
    expect(asViewer.statusCode).toBe(200);
    const statusBody = asViewer.json();
    expect(statusBody).toMatchObject({ completed: true, registriesConfigured: true });
    // finding M5 : le tableau `registries` complet (username en clair, password/token chiffrés
    // mais présents) ne doit plus jamais apparaître dans cette réponse — seul un booléen résume
    // l'état, cohérent avec les autres champs `xConfigured` de cette même route.
    expect(statusBody).not.toHaveProperty("registries");
    const rawBody = JSON.stringify(statusBody);
    expect(rawBody).not.toContain("alice");
    expect(rawBody).not.toContain("s3cret");

    // En revanche, reconfigurer (POST /api/setup/complete, /reset) reste réservé aux admins.
    const resetAsViewer = await app.inject({
      method: "POST",
      url: "/api/setup/reset",
      cookies: { [config.session.cookieName]: viewerToken },
    });
    expect(resetAsViewer.statusCode).toBe(403);

    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });
    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      cookies: { [config.session.cookieName]: adminToken },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json()).toMatchObject({ completed: true });

    await app.close();
  });
});
