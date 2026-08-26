import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * MODULES D'ORIGINE : les intégrations livrées avec QUAI, empaquetées et signées au build, installées
 * au premier démarrage, puis désactivables et désinstallables comme n'importe quel module.
 *
 * Rien n'est simulé de la chaîne : les paquets d'origine sont produits par le script RÉEL du dépôt
 * (scripts/build-origin-plugins.mjs) à partir d'un « dist » factice, avec une paire de clés générée
 * pour ce build, et vérifiés par le code réel du serveur. Les greffons empaquetés ne contactent rien.
 *
 * Le module d'origine écrit un témoin AU MOMENT DE SON IMPORT : c'est lui qui prouve qu'un module
 * mis en pause n'est pas seulement « masqué » mais jamais chargé.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-origin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDir, { recursive: true });

const hostDir = path.join(tmpDir, "faux-dist");
const originDir = path.join(tmpDir, "origin-plugins");
const witnessPath = path.join(tmpDir, "origine-execute.txt");

/** Greffon minimal, conforme au contrat, qui ne joint rien — le « code de l'application » que le
 * paquet d'origine se contente de réexporter. */
function hostModuleSource(id: string, exportName: string): string {
  return `import { appendFileSync } from "node:fs";

appendFileSync(process.env.QUAI_TEST_ORIGIN_WITNESS, ${JSON.stringify(id)} + "\\n");

export const ${exportName} = {
  manifest: {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(`Intégration ${id}`)},
    version: "2.3.4",
    coreApi: "^1.0",
    configSchema: { type: "object", properties: { url: { type: "string", title: "URL" } } },
    secretFields: [],
    permissions: { network: [], mutates: false, graphNodeKinds: ["faux-appliance"] },
    auditLabels: {},
  },
  async test() {
    return { ok: true, message: "module d'origine de test : ne contacte rien" };
  },
  async snapshot() {
    return {
      moduleId: ${JSON.stringify(id)},
      generatedAt: new Date().toISOString(),
      status: "ready",
      summary: [],
      entities: [],
      relations: [],
    };
  },
  async graph() {
    return {
      nodes: [
        {
          id: ${JSON.stringify(`hycu-appliance:${id}`)},
          kind: "faux-appliance",
          label: ${JSON.stringify(id)},
          subtitle: "",
          status: "running",
          rootAttachment: "integration",
          fields: { kind: "hycu-appliance" },
        },
      ],
      edges: [],
      attachments: [],
    };
  },
};
`;
}

/** « dist » factice : le catalogue interne compilé et le code des deux intégrations. */
const ORIGIN_MODULES = [
  { id: "hycu", exportName: "hycuPlugin" },
  { id: "nutanix", exportName: "nutanixPlugin" },
] as const;

fsSync.mkdirSync(path.join(hostDir, "plugins"), { recursive: true });
fsSync.writeFileSync(path.join(hostDir, "package.json"), '{ "type": "module" }\n', "utf-8");
fsSync.writeFileSync(
  path.join(hostDir, "plugins", "builtins.js"),
  `export const BUILTIN_PLUGINS = [\n${ORIGIN_MODULES.map(
    (entry) => `  { id: ${JSON.stringify(entry.id)}, exportName: ${JSON.stringify(entry.exportName)}, load: () => import(${JSON.stringify(`./${entry.id}/index.js`)}) },`,
  ).join("\n")}\n];\n`,
  "utf-8",
);
for (const entry of ORIGIN_MODULES) {
  fsSync.mkdirSync(path.join(hostDir, "plugins", entry.id), { recursive: true });
  fsSync.writeFileSync(path.join(hostDir, "plugins", entry.id, "index.js"), hostModuleSource(entry.id, entry.exportName), "utf-8");
}

process.env.QUAI_TEST_ORIGIN_WITNESS = witnessPath;

/** L'empaqueteur RÉEL du dépôt : ce test ne rejoue pas sa logique, il l'exécute. */
const builderPath = fileURLToPath(new URL("../../../scripts/build-origin-plugins.mjs", import.meta.url));
const signerPath = fileURLToPath(new URL("../../../scripts/sign-plugin.mjs", import.meta.url));
execFileSync(process.execPath, [builderPath, "--dist", hostDir, "--host-root", hostDir, "--out", originDir], { stdio: "pipe" });
// L'empaqueteur charge les greffons pour lire leur manifeste RÉEL : il a donc écrit dans le témoin.
fsSync.rmSync(witnessPath, { force: true });

/** Contenu intact du paquet d'origine, pour réparer après l'avoir volontairement abîmé. */
const pristineShim = fsSync.readFileSync(path.join(originDir, "nutanix", "index.mjs"));

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "5".repeat(64);
process.env.PLUGINS_PATH = path.join(tmpDir, "plugins");
process.env.PLUGIN_ORIGIN_PATH = originDir;

/** Clé d'ADMIN : celle d'un module tiers, sans aucun rapport avec la clé d'origine. */
const ADMIN_KEY_ID = "mairie-2026";
const adminPair = generateKeyPairSync("ed25519");
const adminKeyPath = path.join(tmpDir, "admin.key");
fsSync.writeFileSync(adminKeyPath, adminPair.privateKey.export({ format: "pem", type: "pkcs8" }));
process.env.PLUGIN_TRUSTED_KEYS = JSON.stringify({
  [ADMIN_KEY_ID]: adminPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
});

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { getPlugin, hasPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { loadActivePlugins } = await import("../src/plugins/loader.js");
const { readPluginCatalog } = await import("../src/plugins/catalog.js");
const { installedPluginsRoot, listInstalledPlugins, trustedKeyIds } = await import("../src/plugins/installed.js");
const { ORIGIN_STATE_NAME, bootstrapOriginPlugins, listOriginModules, resetOriginStateForTests } = await import(
  "../src/plugins/origin.js"
);
const { collectPluginGraphParts } = await import("../src/services/topology.js");
const { clearIntegrationConfig, getSafeIntegrationConfig, setIntegrationConfig, setIntegrationEnabled } = await import(
  "../src/services/setupStore.js"
);

const execFileAsync = promisify(execFile);

interface Envelope {
  files: Record<string, string>;
}

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

/** Redémarrage : la mémoire du processus repart de zéro, le DISQUE est conservé tel quel. */
async function restart(): Promise<void> {
  resetPluginRegistryForTests();
  resetOriginStateForTests();
  await loadActivePlugins();
}

/** Paquet tiers signé par l'outil hors ligne réel, avec la clé (et l'identifiant de clé) demandés. */
async function thirdPartyPackage(options: { id: string; keyId?: string }): Promise<Envelope> {
  const dir = path.join(tmpDir, `tiers-${options.id}-${options.keyId ?? ADMIN_KEY_ID}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.QUAI_TEST_ORIGIN_WITNESS, "intrus-${options.id}\\n");\nexport const monGreffon = { manifest: { id: ${JSON.stringify(options.id)}, name: "Module tiers", version: "1.0.0", coreApi: "^1.0", configSchema: { type: "object", properties: {} }, secretFields: [], permissions: { network: [], mutates: false }, auditLabels: {} }, async test() { return { ok: true, message: "ne contacte rien" }; }, async snapshot() { return { moduleId: ${JSON.stringify(options.id)}, generatedAt: new Date().toISOString(), status: "ready", summary: [], entities: [], relations: [] }; } };\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "quai-plugin.json"),
    JSON.stringify({ id: options.id, name: "Module tiers", version: "1.0.0", entry: "index.mjs", exportName: "monGreffon" }, null, 2),
    "utf-8",
  );
  const envelopePath = path.join(tmpDir, `tiers-${options.id}-${options.keyId ?? ADMIN_KEY_ID}.json`);
  await execFileAsync(process.execPath, [
    signerPath,
    "sign",
    dir,
    "--key",
    adminKeyPath,
    "--key-id",
    options.keyId ?? ADMIN_KEY_ID,
    "--out",
    envelopePath,
  ]);
  return JSON.parse(await fs.readFile(envelopePath, "utf-8")) as Envelope;
}

/** Dépose un paquet À LA MAIN dans le volume de données, comme le ferait quelqu'un qui y a accès. */
async function plantPackage(id: string, envelope: Envelope): Promise<void> {
  const dir = path.join(installedPluginsRoot(), id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(envelope.files)) {
    await fs.writeFile(path.join(dir, name), Buffer.from(content, "base64"));
  }
}

let app: FastifyInstance | undefined;
let warnings: string[] = [];

async function server(): Promise<FastifyInstance> {
  await app?.close();
  app = buildServer();
  await app.ready();
  return app;
}

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  resetPluginRegistryForTests();
  resetOriginStateForTests();
  await fs.rm(installedPluginsRoot(), { recursive: true, force: true });
  await fs.rm(witnessPath, { force: true });
  await fs.writeFile(path.join(originDir, "nutanix", "index.mjs"), pristineShim);
  for (const id of ["hycu", "nutanix", "module-demo"]) await clearIntegrationConfig(id);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Amorçage au premier démarrage", () => {
  /** CE TEST DOIT RESTER LE PREMIER : il prouve qu'un module en pause n'est jamais IMPORTÉ, et le
   * cache de modules de Node ne se vide jamais — une fois un module chargé par un autre test, son
   * témoin ne se réécrirait plus et la preuve n'en serait plus une. */
  it("un module d'origine mis en pause est installé, mais son code n'est JAMAIS importé", async () => {
    await setIntegrationConfig("nutanix", { url: "https://exemple.priv" });
    await setIntegrationEnabled("nutanix", false);

    const outcome = await loadActivePlugins();

    // Installé sur le disque comme l'autre : la pause ne l'empêche pas d'être posé.
    expect((await listInstalledPlugins()).map((entry) => entry.id)).toEqual(["hycu", "nutanix"]);
    expect(outcome.paused).toContain("nutanix");
    expect(hasPlugin("nutanix")).toBe(false);
    expect(hasPlugin("hycu")).toBe(true);
    // LA preuve : le code de "nutanix" n'a pas tourné, celui de "hycu" si.
    expect(await witnessLines()).toEqual(["hycu"]);

    // Et il ne contribue rien au graphe, sans qu'une ligne du socle le nomme.
    const parts = await collectPluginGraphParts();
    expect(parts.nodes.map((node) => node.id)).toEqual(["hycu-appliance:hycu"]);
  });

  it("installe les modules d'origine et les présente comme INSTALLÉS, pas comme intégrés au binaire", async () => {
    await loadActivePlugins();

    const installed = await listInstalledPlugins();
    expect(installed).toEqual([
      expect.objectContaining({ id: "hycu", name: "Intégration hycu", version: "2.3.4", trusted: true, origin: true }),
      expect.objectContaining({ id: "nutanix", name: "Intégration nutanix", version: "2.3.4", trusted: true, origin: true }),
    ]);
    // Posés dans le volume de DONNÉES, paquet complet, avec leur trace d'installation.
    for (const id of ["hycu", "nutanix"]) {
      const dir = path.join(installedPluginsRoot(), id);
      expect(fsSync.existsSync(path.join(dir, "index.mjs"))).toBe(true);
      expect(fsSync.existsSync(path.join(dir, "signature.json"))).toBe(true);
      expect(fsSync.existsSync(path.join(dir, ".quai-install.json"))).toBe(true);
    }
    // Actifs par défaut : aucune configuration n'a été écrite pour cela.
    expect(hasPlugin("hycu")).toBe(true);
    expect(hasPlugin("nutanix")).toBe(true);
    expect(await getSafeIntegrationConfig("hycu")).toBeNull();

    // Le catalogue ne vient plus du code importé statiquement : TOUT y est un module installé.
    const catalog = await readPluginCatalog();
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["hycu", "nutanix"]);
    expect(catalog.entries.every((entry) => entry.origin === true)).toBe(true);
  });

  it("le second démarrage ne réécrit rien : les paquets déjà posés sont conservés tels quels", async () => {
    await loadActivePlugins();
    const first = (await listInstalledPlugins()).map((entry) => entry.installedAt);

    resetOriginStateForTests();
    const outcome = await bootstrapOriginPlugins();

    expect(outcome).toMatchObject({ installed: [], kept: ["hycu", "nutanix"], removed: [], failed: [] });
    expect((await listInstalledPlugins()).map((entry) => entry.installedAt)).toEqual(first);
  });

  it("l'écran d'administration voit les modules d'origine livrés par l'image", async () => {
    const instance = await server();

    const response = await instance.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json().origin).toEqual([
      { id: "hycu", name: "Intégration hycu", version: "2.3.4", installed: true, removed: false, removedAt: null, removedBy: null },
      { id: "nutanix", name: "Intégration nutanix", version: "2.3.4", installed: true, removed: false, removedAt: null, removedBy: null },
    ]);
  });
});

describe("Désinstallation d'un module d'origine", () => {
  it("retire le module ET sa configuration, et le retrait SURVIT au redémarrage", async () => {
    const instance = await server();
    await setIntegrationConfig("hycu", { url: "https://sauvegarde.exemple.priv" });
    expect(await getSafeIntegrationConfig("hycu")).not.toBeNull();

    const response = await instance.inject({ method: "DELETE", url: "/api/plugins/installed/hycu", cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, origin: true, restorable: true });
    expect(hasPlugin("hycu")).toBe(false);
    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "hycu"))).toBe(false);
    // La configuration enregistrée part avec le module — l'écran prévient de cette perte.
    expect(await getSafeIntegrationConfig("hycu")).toBeNull();

    // Le point délicat : le redémarrage ne doit PAS annuler la décision de l'admin.
    await restart();

    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "hycu"))).toBe(false);
    expect(hasPlugin("hycu")).toBe(false);
    expect((await readPluginCatalog()).entries.map((entry) => entry.id)).toEqual(["nutanix"]);
    // Le retrait est mémorisé dans les DONNÉES, avec son auteur — jamais deviné à chaque démarrage.
    const state = JSON.parse(await fs.readFile(path.join(installedPluginsRoot(), ORIGIN_STATE_NAME), "utf-8")) as {
      removed: Record<string, { by: string }>;
    };
    expect(state.removed.hycu?.by).toBe("ybanas");
    expect(state.removed.nutanix).toBeUndefined();
  });

  it("un module retiré reste listé comme restaurable, et se réinstalle depuis l'image", async () => {
    const instance = await server();
    await instance.inject({ method: "DELETE", url: "/api/plugins/installed/hycu", cookies: adminCookie() });

    const listed = await instance.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    expect(listed.json().origin).toContainEqual(
      expect.objectContaining({ id: "hycu", installed: false, removed: true, removedBy: "ybanas" }),
    );

    const restored = await instance.inject({ method: "POST", url: "/api/plugins/installed/hycu/restore", cookies: adminCookie() });

    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      module: { id: "hycu", name: "Intégration hycu", version: "2.3.4", trusted: true, origin: true, installedBy: "ybanas" },
      loaded: true,
    });
    expect(hasPlugin("hycu")).toBe(true);
    expect(getPlugin("hycu")?.manifest.name).toBe("Intégration hycu");

    // Et la mémoire du retrait est effacée : le redémarrage suivant le conserve.
    await restart();
    expect(hasPlugin("hycu")).toBe(true);
    expect((await listOriginModules()).find((entry) => entry.id === "hycu")).toMatchObject({ installed: true, removed: false });
  });

  it("restaurer un identifiant que l'image ne livre pas répond 404", async () => {
    const instance = await server();

    const response = await instance.inject({ method: "POST", url: "/api/plugins/installed/inexistant/restore", cookies: adminCookie() });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("Aucun module d'origine \"inexistant\" n'est livré avec cette image.");
  });
});

describe("Désactivation à chaud d'un module d'origine", () => {
  it("le retire du socle et du graphe, sans toucher à sa configuration", async () => {
    const instance = await server();
    await setIntegrationConfig("nutanix", { url: "https://prism.exemple.priv" });
    expect(hasPlugin("nutanix")).toBe(true);

    const response = await instance.inject({
      method: "PUT",
      url: "/api/plugins/nutanix/enabled",
      cookies: adminCookie(),
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: false, configured: true });

    // La construction du graphe commence par réaligner le socle : le greffon en pause en est retiré,
    // et ne contribue donc plus rien.
    const parts = await collectPluginGraphParts();
    expect(parts.nodes.map((node) => node.id)).toEqual(["hycu-appliance:hycu"]);
    expect(hasPlugin("nutanix")).toBe(false);
    // Mettre en pause n'efface rien : réactiver retrouve la configuration telle quelle.
    expect(await getSafeIntegrationConfig("nutanix")).not.toBeNull();

    const back = await instance.inject({
      method: "PUT",
      url: "/api/plugins/nutanix/enabled",
      cookies: adminCookie(),
      payload: { enabled: true },
    });
    expect(back.statusCode).toBe(200);
    expect(hasPlugin("nutanix")).toBe(true);
  });
});

describe("La signature d'origine est vérifiée comme les autres", () => {
  it("un paquet d'origine modifié dans l'image n'est ni installé ni exécuté", async () => {
    await fs.writeFile(path.join(originDir, "nutanix", "index.mjs"), `${pristineShim.toString("utf-8")}export const injecte = true;\n`);

    const outcome = await bootstrapOriginPlugins();

    expect(outcome.installed).toEqual(["hycu"]);
    expect(outcome.failed.find((entry) => entry.id === "nutanix")?.reason).toContain("modifié après signature");
    expect(warnings.join("\n")).toContain(`paquet d'origine "nutanix" inexploitable`);
    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "nutanix"))).toBe(false);
    await loadActivePlugins();
    expect(hasPlugin("nutanix")).toBe(false);
    // Ce qui compte ici : le paquet altéré n'a JAMAIS été exécuté. On ne peut pas exiger un témoin
    // frais pour "hycu" — sa cible a déjà été importée par un test précédent, et le cache de
    // modules de Node ne se vide jamais (voir le commentaire du premier test de ce fichier).
    expect(await witnessLines()).not.toContain("nutanix");
  });

  it("un module TIERS signé par une clé de confiance ne peut pas usurper un identifiant d'origine", async () => {
    await loadActivePlugins();
    // L'intrus est posé APRÈS l'amorçage, directement dans le volume de données.
    await plantPackage("nutanix", await thirdPartyPackage({ id: "nutanix" }));

    const catalog = await readPluginCatalog();

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["hycu"]);
    expect(catalog.rejected.map((refusal) => refusal.reason).join(" ")).toContain("ne peut pas le remplacer");
    await loadActivePlugins();
    expect(getPlugin("nutanix")?.manifest.name).not.toBe("Module tiers");
    expect(await witnessLines()).not.toContain("intrus-nutanix");

    // Et le démarrage suivant RÉPARE : le paquet d'origine de l'image reprend sa place.
    await restart();
    expect((await listInstalledPlugins()).find((entry) => entry.id === "nutanix")).toMatchObject({
      name: "Intégration nutanix",
      origin: true,
      trusted: true,
    });
  });

  it("un paquet qui se réclame de la clé d'origine sans l'avoir est refusé", async () => {
    const instance = await server();
    const usurpateur = await thirdPartyPackage({ id: "module-demo", keyId: "quai-origin" });

    const response = await instance.inject({
      method: "POST",
      url: "/api/plugins/installed",
      cookies: adminCookie(),
      payload: usurpateur,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Signature invalide");
    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "module-demo"))).toBe(false);
    expect(await witnessLines()).not.toContain("intrus-module-demo");
  });

  it("la clé d'origine n'est pas une clé d'installation : elle ne figure pas parmi les clés de confiance", async () => {
    const instance = await server();

    const response = await instance.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });

    expect(trustedKeyIds()).toEqual([ADMIN_KEY_ID]);
    expect(response.json().trustedKeyIds).toEqual([ADMIN_KEY_ID]);
    // Un module tiers ne peut pas non plus prendre l'identifiant par la porte d'installation.
    const refused = await instance.inject({
      method: "POST",
      url: "/api/plugins/installed",
      cookies: adminCookie(),
      payload: await thirdPartyPackage({ id: "nutanix" }),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("ne peut pas le remplacer");
  });
});
