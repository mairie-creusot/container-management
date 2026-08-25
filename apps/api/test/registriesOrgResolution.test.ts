import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Tests du correctif du 14/08/2026 pour le bug réel confirmé en direct sur le registry GHCR
 * "MAIRIE" (reg-ghcr-0, username "informatique@ville-lecreusot.fr") :
 *
 *   GET /api/registries répondait "connected"/trackedImages=3 pour ce registry, tandis que
 *   GET /api/registries/reg-ghcr-0/repositories répondait "GHCR : identifiants invalides ou
 *   expirés (401)..." pour le MÊME registry — CONTRADICTOIRE.
 *
 * Root-cause réelle (voir registriesStore.ts#buildRegistryView) : le `catch` autour de
 * `listOrgPackages(org)` avalait silencieusement l'échec (401 y compris) et laissait
 * `trackedImages` retomber sur le nombre d'images ghcr.io déjà tirées EN LOCAL, tout en gardant
 * `status: "connected"` (basé uniquement sur la joignabilité réseau de ghcr.io, jamais sur la
 * validité des identifiants). Les DEUX chemins (compteur ET explorateur) utilisaient par ailleurs
 * deux implémentations SÉPARÉES de la déduction d'organisation (registriesStore.ts,
 * routes/registries.ts, registries/ghcr.ts#resolveOrg) — un risque de divergence future même si,
 * en pratique, elles calculaient déjà la même chose. Ce fichier couvre les deux angles :
 * resolveRegistryOrg (résolution unifiée, org explicite prioritaire) ET la cohérence bout-en-bout
 * des deux routes HTTP pour un même registry.
 *
 * CONFIG_PATH isolé (même pattern que environments.test.ts/setupStoreRegistries.test.ts).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

// getLocalDockerImages() mocké à [] pour TOUTE la suite : ce conteneur de dev a un vrai accès au
// démon Docker de l'hôte (contrairement à l'hypothèse "pas de démon Docker joignable" documentée
// dans environments.test.ts, valable en CI mais pas forcément ici) — sans ce mock, la déduction
// d'org depuis les images locales (inferGhcrOrg) dépendrait des images RÉELLEMENT présentes sur
// la machine de dev, rendant les tests non déterministes d'un environnement à l'autre. Aucun test
// de ce fichier ne dépend du comportement réel de getLocalDockerImages (tous utilisent soit un
// `org` explicite, soit vérifient explicitement l'absence de déduction).
vi.mock("../src/services/docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/docker.js")>();
  return { ...actual, getLocalDockerImages: vi.fn(async () => []) };
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { resolveRegistryOrg, getPersistedRegistryConfig } = await import("../src/services/registriesStore.js");
const { completeSetup, decryptRegistryCredentials } = await import("../src/services/setupStore.js");
import type { LocalDockerImage } from "../src/services/docker.js";

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const NO_LOCAL_IMAGES: LocalDockerImage[] = [];

describe("resolveRegistryOrg (registriesStore.ts) — résolution unique, org explicite prioritaire", () => {
  it("org explicite prioritaire sur un username ressemblant à un e-mail (GHCR)", () => {
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "informatique@ville-lecreusot.fr", org: "ville-lecreusot" },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBe("ville-lecreusot");
  });

  it("org explicite prioritaire sur la déduction depuis une image locale (GHCR)", () => {
    const localImages: LocalDockerImage[] = [
      { id: "sha256:1", name: "ghcr.io/autre-org/foo", tag: "latest", digest: "sha256:1", sizeBytes: 0 },
    ];
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", org: "ville-lecreusot" },
      localImages,
    );
    expect(org).toBe("ville-lecreusot");
  });

  it("repli sur username non-email quand aucune org explicite n'est configurée (GHCR)", () => {
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "ville-lecreusot" },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBe("ville-lecreusot");
  });

  it("repli sur la déduction locale quand ni org explicite ni username exploitable (GHCR) — ancien comportement conservé", () => {
    const localImages: LocalDockerImage[] = [
      { id: "sha256:1", name: "ghcr.io/inferred-org/foo", tag: "latest", digest: "sha256:1", sizeBytes: 0 },
    ];
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "informatique@ville-lecreusot.fr" },
      localImages,
    );
    expect(org).toBe("inferred-org");
  });

  it("undefined si rien n'est déterminable — jamais une chaîne vide ou un e-mail (GHCR)", () => {
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "informatique@ville-lecreusot.fr" },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBeUndefined();
  });

  it("Docker Hub : org explicite prioritaire sur username (namespace)", () => {
    const org = resolveRegistryOrg(
      { kind: "dockerhub", name: "DockerHub", url: "https://hub.docker.com", username: "compte-perso", org: "compte-pro" },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBe("compte-pro");
  });

  it("Docker Hub : repli sur username (namespace) quand aucune org explicite", () => {
    const org = resolveRegistryOrg(
      { kind: "dockerhub", name: "DockerHub", url: "https://hub.docker.com", username: "compte-perso" },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBe("compte-perso");
  });

  it("une org explicite composée uniquement d'espaces est traitée comme absente (repli sur username)", () => {
    const org = resolveRegistryOrg(
      { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "ville-lecreusot", org: "   " },
      NO_LOCAL_IMAGES,
    );
    expect(org).toBe("ville-lecreusot");
  });
});

describe("GET /api/registries vs GET /api/registries/:id/repositories — cohérence bout-en-bout (bug réel du 14/08/2026)", () => {
  it("org explicite + jeton valide : les deux routes s'accordent sur le même compte ET le même compteur", async () => {
    app = buildServer();
    await completeSetup({
      registries: [
        {
          kind: "ghcr",
          name: "MAIRIE",
          url: "https://ghcr.io",
          username: "informatique@ville-lecreusot.fr",
          token: "good-token",
          org: "ville-lecreusot",
        },
      ],
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://ghcr.io/v2/") return jsonResponse(200, {});
      if (u.startsWith("https://api.github.com/orgs/ville-lecreusot/packages")) {
        return jsonResponse(200, [{ name: "portail-citoyen" }, { name: "site-vitrine" }, { name: "api-mairie" }]);
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const listRes = await app.inject({
      method: "GET",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
    });
    const [registry] = listRes.json() as Array<{ id: string; status: string; trackedImages: number; org?: string }>;
    expect(registry.status).toBe("connected");
    expect(registry.org).toBe("ville-lecreusot");
    expect(registry.trackedImages).toBe(3);

    const reposRes = await app.inject({
      method: "GET",
      url: `/api/registries/${registry.id}/repositories`,
      cookies: { [config.session.cookieName]: adminToken },
    });
    const repos = reposRes.json() as { repositories: string[]; diagnostic?: string };
    expect(repos.diagnostic).toBeUndefined();
    expect(repos.repositories).toEqual([
      "ghcr.io/ville-lecreusot/portail-citoyen",
      "ghcr.io/ville-lecreusot/site-vitrine",
      "ghcr.io/ville-lecreusot/api-mairie",
    ]);
    // Le cœur de la régression couverte : le compteur résumé et le vrai catalogue s'accordent.
    expect(repos.repositories.length).toBe(registry.trackedImages);
  });

  it("jeton invalide (401 GitHub) : les DEUX routes signalent désormais LA MÊME erreur — plus de 'connected'/3 contradictoire", async () => {
    app = buildServer();
    await completeSetup({
      registries: [
        {
          kind: "ghcr",
          name: "MAIRIE",
          url: "https://ghcr.io",
          username: "informatique@ville-lecreusot.fr",
          token: "bad-token",
          org: "ville-lecreusot",
        },
      ],
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://ghcr.io/v2/") return jsonResponse(200, {}); // hôte ghcr.io joignable
      if (u.startsWith("https://api.github.com/orgs/ville-lecreusot/packages")) {
        return jsonResponse(401, { message: "Bad credentials" }); // jeton rejeté par GitHub
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const listRes = await app.inject({
      method: "GET",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
    });
    const [registry] = listRes.json() as Array<{ id: string; status: string; trackedImages: number; statusDetail?: string }>;
    // AVANT le correctif : status restait "connected" (testRegistryConnection ne vérifie que la
    // joignabilité réseau de ghcr.io, jamais les identifiants) et trackedImages retombait
    // silencieusement sur le nombre d'images locales — reproduisant exactement le bug rapporté.
    expect(registry.status).toBe("error");
    expect(registry.statusDetail).toContain("401");
    expect(registry.statusDetail).toContain("identifiants invalides ou expirés");

    const reposRes = await app.inject({
      method: "GET",
      url: `/api/registries/${registry.id}/repositories`,
      cookies: { [config.session.cookieName]: adminToken },
    });
    const repos = reposRes.json() as { repositories: string[]; diagnostic?: string };
    expect(repos.repositories).toEqual([]);
    expect(repos.diagnostic).toContain("401");

    // Assertion clé de la correction demandée : les deux chemins produisent EXACTEMENT le même
    // message (même fonction diagnosticFromError partagée), jamais deux formulations qui pourraient
    // diverger.
    expect(registry.statusDetail).toBe(repos.diagnostic);
  });

  it("sans org explicite ni username exploitable : les deux vues s'accordent sur le même motif d'échec, jamais sur un « connecté, 0 image » trompeur", async () => {
    app = buildServer();
    await completeSetup({
      registries: [
        { kind: "ghcr", name: "MAIRIE", url: "https://ghcr.io", username: "informatique@ville-lecreusot.fr", token: "some-token" },
      ],
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://ghcr.io/v2/") return jsonResponse(200, {});
      // Aucune organisation résolue : listOrgPackages (donc api.github.com) ne doit JAMAIS être
      // appelé par aucun des deux chemins — tout appel inattendu fait échouer le test.
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const listRes = await app.inject({
      method: "GET",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
    });
    const [registry] = listRes.json() as Array<{ id: string; status: string; trackedImages: number; statusDetail?: string }>;
    // Depuis le 25/08/2026, le compteur affiche le CATALOGUE DISTANT et rien d'autre : quand il ne
    // peut pas être listé, la carte le dit au lieu d'annoncer "connecté, 0 image" — état qui laissait
    // croire à un registry réellement vide. L'esprit du test est conservé : les deux vues doivent
    // s'accorder, et elles s'accordent désormais sur le même motif d'échec.
    expect(registry.status).toBe("error");
    expect(registry.statusDetail).toContain("aucune organisation");
    expect(registry.trackedImages).toBe(0);

    const reposRes = await app.inject({
      method: "GET",
      url: `/api/registries/${registry.id}/repositories`,
      cookies: { [config.session.cookieName]: adminToken },
    });
    const repos = reposRes.json() as { repositories: string[]; diagnostic?: string };
    expect(repos.repositories).toEqual([]);
    expect(repos.diagnostic).toContain("aucune organisation");
  });
});

describe("POST /api/registries — identifiants + org acceptés directement à la création", () => {
  it("persiste kind/name/url/username/password/token/org fournis dans le corps de la requête (plus besoin d'un détour par PATCH)", async () => {
    app = buildServer();
    await completeSetup({ registries: [] });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://ghcr.io/v2/") return jsonResponse(200, {});
      if (u.startsWith("https://api.github.com/orgs/ville-lecreusot/packages")) {
        return jsonResponse(200, [{ name: "site-vitrine" }]);
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
      payload: {
        kind: "ghcr",
        name: "GHCR direct",
        url: "https://ghcr.io",
        username: "informatique@ville-lecreusot.fr",
        token: "pat-xyz",
        org: "ville-lecreusot",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; status: string; trackedImages: number; org?: string };
    // Avant ce correctif, POST /api/registries n'acceptait que kind/name/url : le registry restait
    // "unconfigured" jusqu'à une édition via l'icône engrenage. Ici des identifiants sont fournis
    // dès la création : le registry est directement testé/suivi.
    expect(body.status).toBe("connected");
    expect(body.trackedImages).toBe(1);
    expect(body.org).toBe("ville-lecreusot");

    const persisted = await getPersistedRegistryConfig(body.id);
    expect(persisted).toBeDefined();
    expect(persisted?.org).toBe("ville-lecreusot");
    const creds = decryptRegistryCredentials(persisted!);
    expect(creds.username).toBe("informatique@ville-lecreusot.fr");
    expect(creds.token).toBe("pat-xyz"); // déchiffré : stocké chiffré au repos (voir setupStore.ts)
  });

  it("reste 'unconfigured' quand aucun identifiant n'est fourni (comportement historique préservé)", async () => {
    app = buildServer();
    await completeSetup({ registries: [] });
    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/registries",
      cookies: { [config.session.cookieName]: adminToken },
      payload: { kind: "dockerhub", name: "Docker Hub public", url: "https://hub.docker.com" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { status: string; org?: string };
    expect(body.status).toBe("unconfigured");
    expect(body.org).toBeUndefined();
  });
});
