import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * SANS clé de confiance configurée : l'installation de modules externes est simplement
 * INDISPONIBLE, et les greffons livrés avec l'image continuent de fonctionner — jamais une
 * installation « en mode dégradé », jamais un module chargé sans signature vérifiable.
 *
 * Fichier séparé de pluginPackage.test.ts parce que la configuration se lit au chargement du module
 * config.ts : c'est l'ABSENCE de PLUGIN_TRUSTED_KEYS qui est exercée ici.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-nokeys-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDir, { recursive: true });

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "4".repeat(64);
process.env.PLUGINS_PATH = path.join(tmpDir, "plugins");
delete process.env.PLUGIN_TRUSTED_KEYS;

const witnessPath = path.join(tmpDir, "module-execute.txt");
process.env.QUAI_TEST_PLUGIN_WITNESS = witnessPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { hasPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { readPluginCatalog } = await import("../src/plugins/catalog.js");
const { installedPluginsRoot } = await import("../src/plugins/installed.js");

let app: FastifyInstance | undefined;

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}

async function witnessLines(): Promise<string[]> {
  try {
    return (await fs.readFile(witnessPath, "utf-8")).split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
  await fs.rm(installedPluginsRoot(), { recursive: true, force: true });
  await fs.rm(witnessPath, { force: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Aucune clé de confiance configurée", () => {
  it("les greffons LIVRÉS avec l'image continuent de se charger normalement", async () => {
    app = buildServer();
    await app.ready();

    for (const id of ["3cx", "demo", "glpi", "hycu", "nutanix"]) expect(hasPlugin(id)).toBe(true);
    expect((await readPluginCatalog()).entries.map((entry) => entry.id)).toEqual(["3cx", "demo", "glpi", "hycu", "nutanix"]);
  });

  it("l'installation d'un module externe est indisponible, avec un message explicite", async () => {
    app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/plugins/installed",
      cookies: adminCookie(),
      payload: { files: { "quai-plugin.json": Buffer.from("{}", "utf-8").toString("base64") } },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("PLUGIN_TRUSTED_KEYS");
    expect(response.json().error).toContain("indisponible");

    const modules = await app.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    // `origin` vide : hors image, aucun paquet d'origine n'est livré (voir plugins/origin.ts).
    expect(modules.json()).toEqual({ modules: [], origin: [], installAvailable: false, trustedKeyIds: [] });
  });

  it("un module déposé à la main sur le disque n'est ni chargé ni exécuté", async () => {
    const dir = path.join(installedPluginsRoot(), "module-clandestin");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.QUAI_TEST_PLUGIN_WITNESS, "clandestin\\n");\nexport const monGreffon = {};\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "quai-plugin.json"),
      JSON.stringify({
        format: "quai-plugin/1",
        id: "module-clandestin",
        name: "Clandestin",
        version: "1.0.0",
        entry: "index.mjs",
        exportName: "monGreffon",
        files: {},
      }),
      "utf-8",
    );

    const catalog = await readPluginCatalog();

    expect(catalog.entries.some((entry) => entry.id === "module-clandestin")).toBe(false);
    expect(catalog.rejected).toEqual([
      {
        id: "module-clandestin",
        reason:
          "Aucune clé de confiance n'est configurée (PLUGIN_TRUSTED_KEYS) : l'installation et le chargement de modules externes sont indisponibles.",
      },
    ]);
    expect(await witnessLines()).toEqual([]);

    // Et l'écran d'administration le montre, avec son motif — jamais un module ignoré en silence.
    app = buildServer();
    await app.ready();
    const modules = await app.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    expect(modules.json().modules).toEqual([
      expect.objectContaining({ id: "module-clandestin", trusted: false, name: null, version: null }),
    ]);
    expect(hasPlugin("module-clandestin")).toBe(false);
    expect(await witnessLines()).toEqual([]);
  });
});
