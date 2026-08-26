import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Section générique `integrations` de config.json (setupStore.ts) : stockage d'une configuration
 * dont le socle ignore la forme, seuls les CHEMINS déclarés (`secretFields`) étant chiffrés.
 *
 * CONFIG_PATH isolé (même pattern que setupStoreRegistries.test.ts) + clé de chiffrement fixe :
 * sans elle, crypto.ts génère une clé éphémère par process (suffisant ici, mais on veut une
 * vérification déterministe du texte réellement écrit sur disque).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CONFIG_ENCRYPTION_KEY = "9".repeat(64);

const SECRET_HERITAGE = "jeton-herite-en-clair-A1";
const SECRET_ZABBIX = "jeton-zabbix-tres-secret-B2";
const SECRET_VEEAM = "mot-de-passe-veeam-imbrique-C3";
const SECRET_HYCU = "mot-de-passe-hycu-D4";
const SECRET_NUTANIX = "mot-de-passe-nutanix-E5";
const SECRET_JETABLE = "jeton-jetable-F6";
const SECRET_FILET = "jeton-filet-G7";
const SECRET_SURVIVANT = "jeton-survivant-H8";

// Écrit AVANT le premier import du store : le premier getCurrent() doit migrer ce secret en clair
// (même garantie que pour les champs typés — voir hasLegacyPlaintextSecret).
await fs.writeFile(
  tmpConfigPath,
  JSON.stringify(
    {
      completed: true,
      everCompleted: true,
      integrations: {
        heritage: {
          enabled: true,
          config: { url: "https://heritage.example.org", token: SECRET_HERITAGE },
          secretFields: ["token"],
        },
      },
    },
    null,
    2,
  ),
  "utf-8",
);

const store = await import("../src/services/setupStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

interface StoredEntry {
  enabled: boolean;
  config: Record<string, unknown>;
  secretFields?: string[];
}

async function readDisk(): Promise<string> {
  return fs.readFile(tmpConfigPath, "utf-8");
}

async function storedEntry(id: string): Promise<StoredEntry | undefined> {
  const parsed = JSON.parse(await readDisk()) as { integrations?: Record<string, StoredEntry> };
  return parsed.integrations?.[id];
}

function isCiphertext(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("enc:v1:");
}

describe("setupStore — intégrations génériques (greffons)", () => {
  it("migre au premier accès un secret déclaré écrit en clair sur disque", async () => {
    const effective = await store.getEffectiveIntegrationConfig("heritage");
    expect(effective?.enabled).toBe(true);
    expect(effective?.config.token).toBe(SECRET_HERITAGE);

    const raw = await readDisk();
    expect(raw).not.toContain(SECRET_HERITAGE);
    expect(isCiphertext((await storedEntry("heritage"))?.config.token)).toBe(true);
  });

  it("chiffre au repos les SEULS champs déclarés ; le fichier ne contient jamais le secret en clair", async () => {
    await store.setIntegrationConfig(
      "zabbix",
      { url: "https://zabbix.example.org", username: "svc-quai", apiToken: SECRET_ZABBIX },
      ["apiToken"],
    );

    const raw = await readDisk();
    expect(raw).not.toContain(SECRET_ZABBIX);

    const entry = await storedEntry("zabbix");
    expect(isCiphertext(entry?.config.apiToken)).toBe(true);
    expect(entry?.config.url).toBe("https://zabbix.example.org"); // non déclaré secret : reste en clair
    expect(entry?.config.username).toBe("svc-quai");
    expect(entry?.secretFields).toEqual(["apiToken"]);
    expect(entry?.enabled).toBe(true); // écrire une config active l'intégration, comme les champs typés
  });

  it("relit la configuration déchiffrée à l'identique", async () => {
    const effective = await store.getEffectiveIntegrationConfig("zabbix");
    expect(effective).toEqual({
      enabled: true,
      config: { url: "https://zabbix.example.org", username: "svc-quai", apiToken: SECRET_ZABBIX },
    });
  });

  it("vue sûre : aucun secret, un booléen hasX à sa place, champs non secrets conservés", async () => {
    const safe = await store.getSafeIntegrationConfig("zabbix");
    expect(safe).toEqual({
      enabled: true,
      config: { url: "https://zabbix.example.org", username: "svc-quai", hasApiToken: true },
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(SECRET_ZABBIX);
    expect(serialized).not.toContain("enc:v1:");
  });

  it("listSafeIntegrationConfigs ne laisse sortir aucun secret", async () => {
    const all = await store.listSafeIntegrationConfigs();
    expect(Object.keys(all)).toContain("zabbix");
    const serialized = JSON.stringify(all);
    for (const secret of [SECRET_HERITAGE, SECRET_ZABBIX]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("enc:v1:");
  });

  it("champ secret IMBRIQUÉ (auth.password) : chiffré au repos, déchiffré fidèlement, masqué à sa place", async () => {
    await store.setIntegrationConfig(
      "veeam",
      { baseUrl: "https://veeam.example.org", auth: { user: "svc-veeam", password: SECRET_VEEAM } },
      ["auth.password"],
    );

    expect(await readDisk()).not.toContain(SECRET_VEEAM);
    const storedAuth = (await storedEntry("veeam"))?.config.auth as Record<string, unknown> | undefined;
    expect(isCiphertext(storedAuth?.password)).toBe(true);
    expect(storedAuth?.user).toBe("svc-veeam"); // le frère non secret n'est pas touché

    const effective = await store.getEffectiveIntegrationConfig("veeam");
    expect(effective?.config).toEqual({
      baseUrl: "https://veeam.example.org",
      auth: { user: "svc-veeam", password: SECRET_VEEAM },
    });

    const safe = await store.getSafeIntegrationConfig("veeam");
    expect(safe?.config).toEqual({
      baseUrl: "https://veeam.example.org",
      auth: { user: "svc-veeam", hasPassword: true },
    });
  });

  it("refuse explicitement un chemin de champ secret inutilisable, sans rien persister", async () => {
    for (const bad of ["", "auth..password", ".token", "token.", "__proto__.polluted"]) {
      await expect(store.setIntegrationConfig("refuse", { token: "x" }, [bad])).rejects.toThrow();
    }
    expect(await store.getSafeIntegrationConfig("refuse")).toBeNull();
  });

  it("refuse un champ secret déclaré dont la valeur n'est pas une chaîne (jamais persisté en clair)", async () => {
    await expect(store.setIntegrationConfig("refuse", { token: 42 }, ["token"])).rejects.toThrow();
    expect(await store.getSafeIntegrationConfig("refuse")).toBeNull();
  });

  it("refuse un chemin qui traverse un tableau plutôt que d'écrire le secret en clair sans le dire", async () => {
    await expect(
      store.setIntegrationConfig("refuse", { endpoints: [{ apiKey: "jeton-dans-un-tableau" }] }, ["endpoints.0.apiKey"]),
    ).rejects.toThrow();
    expect(await store.getSafeIntegrationConfig("refuse")).toBeNull();
  });

  it("désactive puis réactive sans perdre la configuration ni les secrets", async () => {
    const disabled = await store.setIntegrationEnabled("zabbix", false);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.config).toEqual({ url: "https://zabbix.example.org", username: "svc-quai", hasApiToken: true });

    const whileDisabled = await store.getEffectiveIntegrationConfig("zabbix");
    expect(whileDisabled?.enabled).toBe(false);
    expect(whileDisabled?.config.apiToken).toBe(SECRET_ZABBIX);
    expect(await readDisk()).not.toContain(SECRET_ZABBIX);

    const reEnabled = await store.setIntegrationEnabled("zabbix", true);
    expect(reEnabled?.enabled).toBe(true);
    expect((await store.getEffectiveIntegrationConfig("zabbix"))?.config.apiToken).toBe(SECRET_ZABBIX);
  });

  it("met en pause un greffon jamais configuré sans lui inventer de configuration", async () => {
    // L'activation d'un greffon jamais configuré est IMPLICITE : sans entrée écrite, aucune pause ne
    // pourrait être exprimée et l'interrupteur resterait sans effet sur un module fraîchement installé.
    const paused = await store.setIntegrationEnabled("jamais-configure", false);
    expect(paused).toEqual({ enabled: false, config: {} });
    expect(await store.getEffectiveIntegrationConfig("jamais-configure")).toEqual({ enabled: false, config: {} });
    expect(await readDisk()).toContain("jamais-configure");
  });

  it("un champ secret déclaré mais ABSENT ne fait pas échouer l'écriture", async () => {
    const safe = await store.setIntegrationConfig("partiel", { url: "https://partiel.example.org" }, [
      "token",
      "auth.password",
    ]);
    // `token` : racine toujours présente -> booléen à false. `auth.password` : aucune branche `auth`
    // inventée dans la vue sûre (décision documentée dans stripSecretAtPath).
    expect(safe.config).toEqual({ url: "https://partiel.example.org", hasToken: false });
    expect((await store.getEffectiveIntegrationConfig("partiel"))?.config).toEqual({
      url: "https://partiel.example.org",
    });
  });

  it("supprime la configuration d'un greffon, secret compris, et reste idempotent", async () => {
    await store.setIntegrationConfig("jetable", { token: SECRET_JETABLE }, ["token"]);
    expect(await store.getEffectiveIntegrationConfig("jetable")).not.toBeNull();

    expect(await store.clearIntegrationConfig("jetable")).toBe(true);
    expect(await store.getEffectiveIntegrationConfig("jetable")).toBeNull();
    expect(await store.getSafeIntegrationConfig("jetable")).toBeNull();
    expect(await readDisk()).not.toContain("jetable");
    expect(await store.clearIntegrationConfig("jetable")).toBe(false);
  });

  it("filet de sécurité : une valeur chiffrée résiduelle ne sort pas de la vue sûre, même sans déclaration", async () => {
    await store.setIntegrationConfig("filet", { token: SECRET_FILET }, ["token"]);
    const ciphertext = (await storedEntry("filet"))?.config.token as string;

    // Réécriture SANS déclaration : le socle ne sait plus que c'est un secret, le filet le masque.
    await store.setIntegrationConfig("filet", { token: ciphertext }, []);
    const safe = await store.getSafeIntegrationConfig("filet");
    expect(safe?.config).toEqual({ hasToken: true });
    expect(JSON.stringify(safe)).not.toContain("enc:v1:");
  });

  it("laisse INTACTS les champs typés existants après des écritures génériques", async () => {
    await store.setHycuConfig({ url: "https://hycu.example.org:8443", username: "admin-hycu", password: SECRET_HYCU });
    await store.setNutanixConfig({
      prismCentralUrl: "https://prism.example.org:9440",
      username: "admin-ntx",
      password: SECRET_NUTANIX,
    });

    await store.setIntegrationConfig("greffon-temporaire", { token: "jeton-temporaire-I9" }, ["token"]);
    await store.setIntegrationEnabled("greffon-temporaire", false);
    await store.clearIntegrationConfig("greffon-temporaire");

    expect(await store.getEffectiveHycuConfig()).toEqual({
      url: "https://hycu.example.org:8443",
      username: "admin-hycu",
      password: SECRET_HYCU,
    });
    expect(await store.getEffectiveNutanixConfig()).toEqual({
      prismCentralUrl: "https://prism.example.org:9440",
      username: "admin-ntx",
      password: SECRET_NUTANIX,
    });

    const parsed = JSON.parse(await readDisk()) as { hycu?: { password: string }; nutanix?: { password: string } };
    expect(isCiphertext(parsed.hycu?.password)).toBe(true);
    expect(isCiphertext(parsed.nutanix?.password)).toBe(true);
    const raw = await readDisk();
    expect(raw).not.toContain(SECRET_HYCU);
    expect(raw).not.toContain(SECRET_NUTANIX);

    // Et symétriquement : une écriture typée ne perd pas les intégrations génériques.
    expect((await store.getEffectiveIntegrationConfig("zabbix"))?.config.apiToken).toBe(SECRET_ZABBIX);
  });

  it("rejouer l'assistant (completeSetup) ne perd pas les intégrations greffons", async () => {
    await store.setIntegrationConfig("survivant", { token: SECRET_SURVIVANT }, ["token"]);
    await store.completeSetup({
      ldap: {
        url: "ldap://localhost:389",
        bindDn: "cn=admin,dc=example,dc=org",
        bindPassword: "mot-de-passe-ldap-J10",
        searchBase: "dc=example,dc=org",
        searchFilter: "(uid={{username}})",
        groupRoleMap: {},
        defaultRole: "viewer",
      },
    });

    expect((await store.getEffectiveIntegrationConfig("survivant"))?.config.token).toBe(SECRET_SURVIVANT);
    expect(await readDisk()).not.toContain(SECRET_SURVIVANT);
  });
});
