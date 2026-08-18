import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/** Lint shell réel (sh -n dans le conteneur), validation de recette et recherche de paquets
 * (Repology stubé via fetch — jamais de dépendance réseau dans la suite). Le store templates/iac
 * dérive son dossier de données de dirname(CONFIG_PATH) : sous-dossier DÉDIÉ pour ne jamais
 * partager templates.json avec templates.test.ts (fichiers exécutés en parallèle). */
const tmpDataDir = path.join(os.tmpdir(), `quai-api-test-lint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDataDir, { recursive: true });
const tmpConfigPath = path.join(tmpDataDir, "config.json");
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { extractPackages } = await import("../src/services/packageSearch.js");

afterAll(async () => {
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
});

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}

describe("POST /api/iac/lint", () => {
  it("401 sans session", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/iac/lint", payload: { kind: "shell", content: "echo ok" } });
    expect(response.statusCode).toBe(401);
  });

  it("script valide -> ok true, aucune erreur (sh -n réel)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/iac/lint",
      cookies: adminCookie(),
      payload: { kind: "shell", content: "#!/bin/sh\nset -eu\necho 'ok'\nfor f in a b; do echo \"$f\"; done\n" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, errors: [] });
  });

  it("erreur de syntaxe réelle -> ok false + ligne + message brut de sh", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/iac/lint",
      cookies: adminCookie(),
      payload: { kind: "shell", content: "echo debut\nif [ -f x ]; then\necho jamais-ferme\n" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].message).toBeTruthy();
  });

  it("400 si kind inconnu ou content absent", async () => {
    app = buildServer();
    expect((await app.inject({ method: "POST", url: "/api/iac/lint", cookies: adminCookie(), payload: { kind: "python", content: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/iac/lint", cookies: adminCookie(), payload: { kind: "shell" } })).statusCode).toBe(400);
  });
});

describe("POST /api/templates/:id/validate", () => {
  it("404 pour un template inconnu", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/templates/00000000-0000-0000-0000-000000000000/validate", cookies: adminCookie() });
    expect(response.statusCode).toBe(404);
  });

  it("recette container avec script cassé -> ok false, la sortie cite le fichier fautif", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: adminCookie(),
      payload: {
        name: "lint-check",
        base: { type: "container", image: "debian:12" },
        steps: [{ type: "script", content: "if [ -f x ]; then\necho jamais-ferme\n" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const response = await app.inject({ method: "POST", url: `/api/templates/${id}/validate`, cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.json().output).toMatch(/scripts\//);
    await app.inject({ method: "DELETE", url: `/api/templates/${id}`, cookies: adminCookie() });
  });

  it("recette container saine -> ok true", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: adminCookie(),
      payload: {
        name: "lint-ok",
        base: { type: "container", image: "debian:12" },
        steps: [{ type: "script", content: "#!/bin/sh\necho ok\n" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const response = await app.inject({ method: "POST", url: `/api/templates/${id}/validate`, cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/templates/${id}`, cookies: adminCookie() });
  });
});

describe("GET /api/packages/search", () => {
  const REPOLOGY_PAYLOAD = {
    htop: [
      { repo: "debian_12", binname: "htop", version: "3.2.2", summary: "interactive processes viewer" },
      { repo: "debian_13", binname: "htop", version: "3.4.1", summary: "interactive processes viewer" },
      { repo: "alpine_3_20", binname: "htop", version: "3.3.0" },
    ],
    "htop-vim": [{ repo: "arch", name: "htop-vim", version: "3.4.0", summary: "htop with vim keybindings" }],
  };

  it("filtre par distro et garde le dépôt le plus récent (mapping pur extractPackages)", () => {
    const debian = extractPackages(REPOLOGY_PAYLOAD, "debian_");
    expect(debian).toEqual([{ name: "htop", version: "3.4.1", summary: "interactive processes viewer" }]);
    const arch = extractPackages(REPOLOGY_PAYLOAD, "arch");
    expect(arch).toEqual([{ name: "htop-vim", version: "3.4.0", summary: "htop with vim keybindings" }]);
  });

  it("route : résultats réels du proxy (fetch stubé), source repology", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(REPOLOGY_PAYLOAD), { status: 200 })));
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/packages/search?distro=debian&q=htop", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [{ name: "htop", version: "3.4.1", summary: "interactive processes viewer" }],
      source: "repology",
    });
  });

  it("400 pour distro inconnue ou requête trop courte ; 502 honnête si l'amont échoue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/api/packages/search?distro=gentoo&q=htop", cookies: adminCookie() })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/packages/search?distro=debian&q=h", cookies: adminCookie() })).statusCode).toBe(400);
    const upstream = await app.inject({ method: "GET", url: "/api/packages/search?distro=debian&q=zzznocache", cookies: adminCookie() });
    expect(upstream.statusCode).toBe(502);
  });
});

describe("GET /api/dockerhub/search + /tags", () => {
  const HUB_SEARCH_PAYLOAD = {
    results: [
      { repo_name: "debian", short_description: "Debian is a Linux distribution", star_count: 5321, is_official: true },
      { repo_name: "bitnami/debian-base", short_description: "Base image", star_count: 12, is_official: false },
    ],
  };
  const HUB_TAGS_PAYLOAD = { results: [{ name: "bookworm" }, { name: "12" }, { name: "latest" }] };

  it("search : résultats mappés (officiel, étoiles, description)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(HUB_SEARCH_PAYLOAD), { status: 200 })));
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/dockerhub/search?q=debian", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { name: "debian", description: "Debian is a Linux distribution", stars: 5321, official: true },
      { name: "bitnami/debian-base", description: "Base image", stars: 12, official: false },
    ]);
  });

  it("tags : dépôt officiel préfixé library/, liste des noms", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(HUB_TAGS_PAYLOAD), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/dockerhub/tags?repo=debian", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tags: ["bookworm", "12", "latest"] });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/repositories/library/debian/tags/");
  });

  it("400 requête trop courte / repo invalide ; 502 honnête si le Hub échoue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/api/dockerhub/search?q=d", cookies: adminCookie() })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dockerhub/tags?repo=..//bad", cookies: adminCookie() })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dockerhub/search?q=zzznocachehub", cookies: adminCookie() })).statusCode).toBe(502);
  });
});
