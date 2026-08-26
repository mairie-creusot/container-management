import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REPLI DE DÉVELOPPEMENT : hors image, aucun paquet d'origine n'existe (PLUGIN_ORIGIN_PATH n'est pas
 * positionné) et le socle doit continuer de fonctionner exactement comme avant — sinon `pnpm dev` et
 * les tests n'auraient plus aucune intégration.
 *
 * Aucun test ne contacte quoi que ce soit : les quatre intégrations ne sont jamais configurées dans
 * ce CONFIG_PATH isolé, elles ne contribuent rien et n'émettent aucune requête.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-origin-repli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "4".repeat(64);
process.env.PLUGINS_PATH = path.join(tmpDir, "plugins");
delete process.env.PLUGIN_ORIGIN_PATH;
delete process.env.PLUGIN_ORIGIN_KEY;

const { config } = await import("../src/config.js");
const { BUILTIN_PLUGINS } = await import("../src/plugins/builtins.js");
const { readPluginCatalog } = await import("../src/plugins/catalog.js");
const { listInstalledPlugins } = await import("../src/plugins/installed.js");
const { bootstrapOriginPlugins, hasOriginPackages, listOriginModules } = await import("../src/plugins/origin.js");
const { loadActivePlugins } = await import("../src/plugins/loader.js");
const { listPlugins, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRegistryForTests();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Hors image, le catalogue interne reprend son rôle", () => {
  it("aucune clé d'origine, aucun paquet d'origine, aucun module inventé", async () => {
    expect(config.plugins.originPath).toBeUndefined();
    expect(config.plugins.originKeyId).toBeUndefined();
    expect(await hasOriginPackages()).toBe(false);
    expect(await bootstrapOriginPlugins()).toEqual({ installed: [], kept: [], removed: [], failed: [] });
    expect(await listOriginModules()).toEqual([]);
    expect(await listInstalledPlugins()).toEqual([]);
  });

  it("le catalogue est celui du code livré, et les quatre intégrations se chargent comme avant", async () => {
    const catalog = await readPluginCatalog();

    expect(catalog.entries.map((entry) => entry.id)).toEqual(BUILTIN_PLUGINS.map((entry) => entry.id));
    expect(catalog.entries.some((entry) => entry.origin === true)).toBe(false);
    expect(catalog.rejected).toEqual([]);

    await loadActivePlugins();

    expect(listPlugins().map((plugin) => plugin.manifest.id)).toEqual(["3cx", "glpi", "hycu", "nutanix"]);
  });
});
