import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * DISTRIBUTION des modules : format de paquet, signature NON CONTOURNABLE, installation et
 * désinstallation à chaud.
 *
 * Rien n'est simulé de la chaîne de confiance : les paquets exercés ici sont signés par l'OUTIL
 * HORS LIGNE réel (scripts/sign-plugin.mjs) avec des clés Ed25519 générées pour ce test, et
 * vérifiés par le code réel du serveur. Aucun accès réseau, aucune infrastructure contactée : le
 * module installé est un greffon de démonstration qui ne joint rien.
 *
 * Le module écrit un fichier témoin AU MOMENT DE SON IMPORT : c'est ce témoin qui prouve qu'un
 * paquet refusé n'a jamais fait exécuter une seule ligne de son code.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-package-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDir, { recursive: true });

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);
process.env.PLUGINS_PATH = path.join(tmpDir, "plugins");

const TRUSTED_KEY_ID = "mairie-2026";
const trustedPair = generateKeyPairSync("ed25519");
const strangerPair = generateKeyPairSync("ed25519");
const trustedKeyPath = path.join(tmpDir, "trusted.key");
const strangerKeyPath = path.join(tmpDir, "stranger.key");
fsSync.writeFileSync(trustedKeyPath, trustedPair.privateKey.export({ format: "pem", type: "pkcs8" }));
fsSync.writeFileSync(strangerKeyPath, strangerPair.privateKey.export({ format: "pem", type: "pkcs8" }));
process.env.PLUGIN_TRUSTED_KEYS = JSON.stringify({
  [TRUSTED_KEY_ID]: trustedPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
});

/** Témoin d'EXÉCUTION : le module l'écrit à l'import, personne d'autre ne l'écrit. */
const witnessPath = path.join(tmpDir, "module-execute.txt");
process.env.QUAI_TEST_PLUGIN_WITNESS = witnessPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { getPlugin, hasPlugin, resetPluginRegistryForTests } = await import("../src/plugins/registry.js");
const { loadActivePlugins } = await import("../src/plugins/loader.js");
const { readPluginCatalog } = await import("../src/plugins/catalog.js");
const { installedPluginsRoot } = await import("../src/plugins/installed.js");

const execFileAsync = promisify(execFile);
/** L'outil de signature RÉEL du dépôt : ces tests ne rejouent pas sa logique, ils l'exécutent. */
const signerPath = fileURLToPath(new URL("../../../scripts/sign-plugin.mjs", import.meta.url));

interface Envelope {
  files: Record<string, string>;
}

/** Code du module : greffon minimal, conforme au contrat, qui ne contacte rien. */
function moduleSource(id: string): string {
  return `import { appendFileSync } from "node:fs";

appendFileSync(process.env.QUAI_TEST_PLUGIN_WITNESS, ${JSON.stringify(id)} + "\\n");

export const monGreffon = {
  manifest: {
    id: ${JSON.stringify(id)},
    name: "Module de démonstration",
    version: "1.0.0",
    coreApi: "^1.0",
    configSchema: { type: "object", properties: { etiquette: { type: "string", title: "Étiquette" } } },
    secretFields: [],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  },
  async test() {
    return { ok: true, message: "module de démonstration : ne contacte rien" };
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
};
`;
}

let sourceCounter = 0;

/** Construit ET SIGNE un paquet avec l'outil hors ligne réel, puis rend son enveloppe de transport. */
async function signedPackage(options: { id: string; keyPath?: string; keyId?: string; version?: string }): Promise<Envelope> {
  sourceCounter += 1;
  const dir = path.join(tmpDir, `source-${sourceCounter}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.mjs"), moduleSource(options.id), "utf-8");
  await fs.writeFile(
    path.join(dir, "quai-plugin.json"),
    JSON.stringify(
      {
        id: options.id,
        name: "Module de démonstration",
        version: options.version ?? "1.0.0",
        entry: "index.mjs",
        exportName: "monGreffon",
      },
      null,
      2,
    ),
    "utf-8",
  );

  const envelopePath = path.join(tmpDir, `paquet-${sourceCounter}.json`);
  await execFileAsync(process.execPath, [
    signerPath,
    "sign",
    dir,
    "--key",
    options.keyPath ?? trustedKeyPath,
    "--key-id",
    options.keyId ?? TRUSTED_KEY_ID,
    "--out",
    envelopePath,
  ]);
  return JSON.parse(await fs.readFile(envelopePath, "utf-8")) as Envelope;
}

function encode(content: string): string {
  return Buffer.from(content, "utf-8").toString("base64");
}

function adminCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] }) };
}

function viewerCookie() {
  return { [config.session.cookieName]: signSessionToken({ username: "lambda", displayName: "Utilisateur", roles: ["viewer"] }) };
}

async function witnessLines(): Promise<string[]> {
  try {
    return (await fs.readFile(witnessPath, "utf-8")).split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

let app: FastifyInstance | undefined;

async function server(): Promise<FastifyInstance> {
  await app?.close();
  app = buildServer();
  await app.ready();
  return app;
}

async function install(envelope: Envelope) {
  return await (await server()).inject({ method: "POST", url: "/api/plugins/installed", cookies: adminCookie(), payload: envelope });
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

describe("Signature d'un module — seule frontière de sécurité", () => {
  it("accepte un paquet signé par une clé de confiance, l'installe et le charge à chaud", async () => {
    const response = await install(await signedPackage({ id: "module-demo" }));

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      module: { id: "module-demo", name: "Module de démonstration", version: "1.0.0", trusted: true, keyId: TRUSTED_KEY_ID, installedBy: "ybanas" },
      replaced: false,
      loaded: true,
    });

    // Chargé RÉELLEMENT : le module est dans le registre et son code s'est exécuté une fois.
    expect(hasPlugin("module-demo")).toBe(true);
    expect(getPlugin("module-demo")?.manifest.name).toBe("Module de démonstration");
    expect(await witnessLines()).toEqual(["module-demo"]);

    // Et il est posé dans le répertoire de DONNÉES, hors du code livré.
    const installed = path.join(installedPluginsRoot(), "module-demo");
    expect(fsSync.existsSync(path.join(installed, "index.mjs"))).toBe(true);
    expect(fsSync.existsSync(path.join(installed, "signature.json"))).toBe(true);
  });

  it("REFUSE un paquet non signé, sans jamais exécuter une ligne de son code", async () => {
    const envelope = await signedPackage({ id: "module-demo" });
    delete envelope.files["signature.json"];

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("n'est pas signé");
    expect(response.json().error).toContain("jamais chargé");
    // LA preuve : rien n'a été importé, donc rien n'a été exécuté.
    expect(await witnessLines()).toEqual([]);
    expect(hasPlugin("module-demo")).toBe(false);
    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "module-demo"))).toBe(false);
  });

  it("REFUSE un paquet dont le code a été modifié après signature, sans l'exécuter", async () => {
    const envelope = await signedPackage({ id: "module-demo" });
    envelope.files["index.mjs"] = encode(`${moduleSource("module-demo")}\nexport const injecte = true;\n`);

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Le fichier "index.mjs" ne correspond pas à son empreinte signée');
    expect(response.json().error).toContain("modifié après signature");
    expect(await witnessLines()).toEqual([]);
  });

  it("REFUSE un paquet dont la signature elle-même a été altérée", async () => {
    const envelope = await signedPackage({ id: "module-demo" });
    const signature = JSON.parse(Buffer.from(envelope.files["signature.json"]!, "base64").toString("utf-8")) as {
      signature: string;
    };
    const bytes = Buffer.from(signature.signature, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    envelope.files["signature.json"] = encode(
      JSON.stringify({ algorithm: "ed25519", keyId: TRUSTED_KEY_ID, signature: bytes.toString("base64") }),
    );

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Signature invalide");
    expect(await witnessLines()).toEqual([]);
  });

  it("REFUSE un paquet signé par une clé INCONNUE du serveur", async () => {
    const envelope = await signedPackage({ id: "module-demo", keyPath: strangerKeyPath, keyId: "cle-inconnue" });

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('la clé "cle-inconnue", inconnue du serveur');
    expect(response.json().error).toContain(TRUSTED_KEY_ID);
    expect(await witnessLines()).toEqual([]);
  });

  it("REFUSE un paquet signé par une AUTRE clé sous l'identifiant d'une clé de confiance", async () => {
    // Usurpation de l'identifiant de clé : c'est la clé publique configurée qui tranche, pas ce que
    // le paquet annonce.
    const envelope = await signedPackage({ id: "module-demo", keyPath: strangerKeyPath, keyId: TRUSTED_KEY_ID });

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Signature invalide");
    expect(await witnessLines()).toEqual([]);
  });

  it("REFUSE un fichier ajouté au paquet après signature", async () => {
    const envelope = await signedPackage({ id: "module-demo" });
    envelope.files["clandestin.mjs"] = encode("export const x = 1;\n");

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('fichier non signé : "clandestin.mjs"');
    expect(await witnessLines()).toEqual([]);
  });

  it("REFUSE un chemin de fichier qui sort du paquet", async () => {
    const envelope = await signedPackage({ id: "module-demo" });
    envelope.files["../evasion.mjs"] = encode("export const x = 1;\n");

    const response = await install(envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Chemin de fichier refusé");
    expect(fsSync.existsSync(path.join(tmpDir, "evasion.mjs"))).toBe(false);
  });
});

describe("Un module installé ne peut pas usurper un greffon livré", () => {
  it("REFUSE l'identifiant d'un greffon du catalogue interne, avec un message explicite", async () => {
    const response = await install(await signedPackage({ id: "nutanix" }));

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(
      `L'identifiant "nutanix" est celui d'un greffon livré avec QUAI : un module installé ne peut pas le remplacer.`,
    );
    expect(await witnessLines()).toEqual([]);
  });

  it("un paquet valide déposé DIRECTEMENT sous le nom d'un greffon livré n'entre pas au catalogue", async () => {
    // Contournement de la route : le répertoire est posé à la main dans le volume de données.
    const envelope = await signedPackage({ id: "nutanix" });
    const dir = path.join(installedPluginsRoot(), "nutanix");
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(envelope.files)) {
      await fs.writeFile(path.join(dir, name), Buffer.from(content, "base64"));
    }

    const catalog = await readPluginCatalog();

    expect(catalog.entries.filter((entry) => entry.id === "nutanix")).toHaveLength(1);
    expect(catalog.entries.find((entry) => entry.id === "nutanix")?.exportName).toBe("nutanixPlugin");
    expect(catalog.rejected.map((refusal) => refusal.reason).join(" ")).toContain("ne peut pas le remplacer");
    expect(await witnessLines()).toEqual([]);

    // Et l'intrus ne fait pas non plus tomber l'intégration légitime : c'est LUI qu'on écarte.
    await loadActivePlugins();
    expect(hasPlugin("nutanix")).toBe(true);
    expect(getPlugin("nutanix")?.manifest.name).not.toBe("Module de démonstration");
    expect(await witnessLines()).toEqual([]);
  });
});

describe("Installation et désinstallation à chaud", () => {
  it("le module installé apparaît dans le catalogue, dans la liste des greffons et dans la liste des modules", async () => {
    await install(await signedPackage({ id: "module-demo" }));
    const instance = app!;

    const plugins = await instance.inject({ method: "GET", url: "/api/plugins", cookies: adminCookie() });
    expect(plugins.statusCode).toBe(200);
    expect(plugins.json().plugins.map((entry: { manifest: { id: string } }) => entry.manifest.id)).toContain("module-demo");

    const modules = await instance.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    expect(modules.statusCode).toBe(200);
    expect(modules.json()).toMatchObject({ installAvailable: true, trustedKeyIds: [TRUSTED_KEY_ID] });
    expect(modules.json().modules).toEqual([
      expect.objectContaining({ id: "module-demo", version: "1.0.0", trusted: true, keyId: TRUSTED_KEY_ID, reason: null }),
    ]);
    // Aucune valeur de clé ne sort de l'API.
    expect(JSON.stringify(modules.json())).not.toContain(process.env.PLUGIN_TRUSTED_KEYS!.slice(20, 40));
  });

  it("la désinstallation retire RÉELLEMENT le module : du disque, du registre et du catalogue", async () => {
    await install(await signedPackage({ id: "module-demo" }));
    expect(hasPlugin("module-demo")).toBe(true);

    const response = await app!.inject({ method: "DELETE", url: "/api/plugins/installed/module-demo", cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(hasPlugin("module-demo")).toBe(false);
    expect(fsSync.existsSync(path.join(installedPluginsRoot(), "module-demo"))).toBe(false);
    expect((await readPluginCatalog()).entries.some((entry) => entry.id === "module-demo")).toBe(false);
    // Et il ne revient pas au démarrage suivant.
    await loadActivePlugins();
    expect(hasPlugin("module-demo")).toBe(false);
  });

  it("désinstaller un identifiant inconnu répond 404 sans toucher aux greffons livrés", async () => {
    await (await server()).ready();
    expect(hasPlugin("nutanix")).toBe(true);

    const response = await app!.inject({ method: "DELETE", url: "/api/plugins/installed/nutanix", cookies: adminCookie() });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain('Aucun module installé sous l\'identifiant "nutanix"');
    expect(hasPlugin("nutanix")).toBe(true);
  });

  it("une réinstallation remplace le module et recharge RÉELLEMENT le nouveau code", async () => {
    await install(await signedPackage({ id: "module-demo", version: "1.0.0" }));
    expect(await witnessLines()).toEqual(["module-demo"]);

    const again = await install(await signedPackage({ id: "module-demo", version: "1.1.0" }));

    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ replaced: true, loaded: true });
    const modules = await app!.inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    expect(modules.json().modules[0]).toMatchObject({ version: "1.1.0" });
  });

  it("un fichier modifié sur le disque APRÈS installation retire le module du socle à la passe suivante", async () => {
    await install(await signedPackage({ id: "module-demo" }));
    expect(hasPlugin("module-demo")).toBe(true);

    await fs.writeFile(
      path.join(installedPluginsRoot(), "module-demo", "index.mjs"),
      `${moduleSource("module-demo")}\nexport const injecte = true;\n`,
      "utf-8",
    );

    const outcome = await loadActivePlugins();

    expect(hasPlugin("module-demo")).toBe(false);
    expect(outcome.failed.find((failure) => failure.id === "module-demo")?.reason).toContain("modifié après signature");

    // L'écran d'administration le montre, avec son motif — jamais disparu en silence.
    const modules = await (await server()).inject({ method: "GET", url: "/api/plugins/installed", cookies: adminCookie() });
    expect(modules.json().modules[0]).toMatchObject({ id: "module-demo", trusted: false, name: null, version: null });
    expect(modules.json().modules[0].reason).toContain("modifié après signature");
  });

  it("réservé aux admins : lecture, installation et désinstallation", async () => {
    const instance = await server();
    for (const [method, url] of [
      ["GET", "/api/plugins/installed"],
      ["POST", "/api/plugins/installed"],
      ["DELETE", "/api/plugins/installed/module-demo"],
    ] as const) {
      const body = method === "GET" ? {} : { payload: {} };
      const forbidden = await instance.inject({ method, url, cookies: viewerCookie(), ...body });
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
      const anonymous = await instance.inject({ method, url, ...body });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("un corps qui n'est pas un paquet est refusé sans rien écrire", async () => {
    const instance = await server();
    for (const payload of [{}, { files: {} }, { files: { "index.mjs": "pas du base64 ***" } }]) {
      const response = await instance.inject({ method: "POST", url: "/api/plugins/installed", cookies: adminCookie(), payload });
      expect(response.statusCode).toBe(400);
      expect(typeof response.json().error).toBe("string");
    }
    expect(await witnessLines()).toEqual([]);
  });
});

describe("Outil de signature hors ligne", () => {
  it("vérifie localement un paquet réel, et refuse celui qu'une autre clé a signé", async () => {
    const dir = path.join(tmpDir, "verif-source");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.mjs"), moduleSource("module-verif"), "utf-8");
    await fs.writeFile(
      path.join(dir, "quai-plugin.json"),
      JSON.stringify({ id: "module-verif", name: "Module", version: "1.0.0", entry: "index.mjs", exportName: "monGreffon" }),
      "utf-8",
    );
    await execFileAsync(process.execPath, [signerPath, "sign", dir, "--key", trustedKeyPath, "--key-id", TRUSTED_KEY_ID]);

    const keys = process.env.PLUGIN_TRUSTED_KEYS!;
    const ok = await execFileAsync(process.execPath, [signerPath, "verify", dir, "--keys", keys]);
    expect(ok.stdout).toContain('module-verif 1.0.0, signé par "mairie-2026"');

    const autresCles = JSON.stringify({
      [TRUSTED_KEY_ID]: strangerPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    });
    await expect(execFileAsync(process.execPath, [signerPath, "verify", dir, "--keys", autresCles])).rejects.toThrow(
      /Signature invalide/,
    );
  });
});
