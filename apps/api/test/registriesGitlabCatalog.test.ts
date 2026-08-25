import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getEffectiveRegistryCredentialsForImage = vi.fn();
vi.mock("../src/services/setupStore.js", () => ({ getEffectiveRegistryCredentialsForImage }));

const { listGroupRepositories } = await import("../src/services/registries/gitlab.js");
const { listRegistryRepositories } = await import("../src/services/registries/index.js");

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("catalogue GitLab Registry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getEffectiveRegistryCredentialsForImage.mockResolvedValue({ token: "glpat-xxx" });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("liste les dépôts d'un groupe et renvoie la référence complète servie par GitLab", async () => {
    // `location` porte le nom d'hôte RÉEL du registre, qui peut différer de celui de l'instance
    // quand GitLab est publié derrière un reverse proxy — c'est lui que docker pull attend.
    fetchMock.mockResolvedValue(
      jsonResponse([
        { id: 1, path: "informatique/quai", location: "registry.lecreusot.priv/informatique/quai" },
        { id: 2, path: "informatique/portail", location: "registry.lecreusot.priv/informatique/portail" },
      ]),
    );

    const repositories = await listGroupRepositories("https://gitlab.lecreusot.priv", "Informatique");

    expect(repositories).toEqual([
      "registry.lecreusot.priv/informatique/quai",
      "registry.lecreusot.priv/informatique/portail",
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://gitlab.lecreusot.priv/api/v4/groups/Informatique/registry/repositories?per_page=100");
    expect((init as { headers: Record<string, string> }).headers["PRIVATE-TOKEN"]).toBe("glpat-xxx");
  });

  it("se rabat sur l'API de projet quand le namespace n'est pas un groupe", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "404 Group Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse([{ id: 3, path: "ybanas/outil", location: "registry.lecreusot.priv/ybanas/outil" }]));

    const repositories = await listGroupRepositories("https://gitlab.lecreusot.priv/", "ybanas%2Foutil");

    expect(repositories).toEqual(["registry.lecreusot.priv/ybanas/outil"]);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/api/v4/projects/");
  });

  it("sans jeton : diagnostic explicite, jamais une liste vide silencieuse", async () => {
    getEffectiveRegistryCredentialsForImage.mockResolvedValue(null);

    const result = await listRegistryRepositories("gitlab", "Informatique", "https://gitlab.lecreusot.priv");

    expect(result.repositories).toEqual([]);
    expect(result.diagnostic).toMatch(/jeton GitLab/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sans namespace ou sans URL : dit lequel manque plutôt que d'échouer sur le réseau", async () => {
    expect((await listRegistryRepositories("gitlab", undefined, "https://gitlab.lecreusot.priv")).diagnostic).toMatch(
      /namespace/i,
    );
    expect((await listRegistryRepositories("gitlab", "Informatique", undefined)).diagnostic).toMatch(/URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
