import { describe, expect, it } from "vitest";
import {
  deriveModuleRows,
  moduleInstallAvailability,
  moduleIsTrusted,
  moduleUninstallable,
  normalizeModuleInventory,
  type ModuleInventory,
  type ModuleInventorySource,
} from "@/features/plugins/pluginInstallModel";
import type { PluginManifest, PluginSummary } from "@/features/plugins/pluginsModel";

function manifest(id: string, name: string, version: string): PluginManifest {
  return {
    id,
    name,
    version,
    coreApi: "^1.0",
    configSchema: { type: "object", properties: {} },
    secretFields: [],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  };
}

function summary(id: string, name: string, enabled: boolean, configured: boolean): PluginSummary {
  return { manifest: manifest(id, name, "1.0.0"), enabled, configured };
}

function inventoryOf(payload: unknown): ModuleInventory {
  const inventory = normalizeModuleInventory(payload);
  if (!inventory) throw new Error("inventaire refusé alors que la charge utile est valide");
  return inventory;
}

function readySource(payload: unknown): ModuleInventorySource {
  return { status: "ready", inventory: inventoryOf(payload) };
}

/** Forme réelle de GET /api/plugins/installed : les modules INSTALLÉS seulement (les modules livrés
 * avec l'application n'y figurent pas), un vérifié et un refusé. */
const INVENTORY_PAYLOAD = {
  modules: [
    {
      id: "zabbix",
      name: "Supervision Zabbix",
      version: "2.1.0",
      trusted: true,
      keyId: "ops-2026",
      installedAt: "2026-08-20T09:30:00.000Z",
      installedBy: "ybanas",
      reason: null,
    },
    {
      id: "louche",
      name: null,
      version: null,
      trusted: false,
      keyId: null,
      installedAt: null,
      installedBy: null,
      reason: "Signature produite par une clé inconnue du serveur.",
    },
  ],
  installAvailable: true,
  trustedKeyIds: ["ops-2026"],
};

describe("normalizeModuleInventory — la charge utile telle qu'elle est, jamais complétée", () => {
  it("signature vérifiée et par quelle clé, motif du refus, traces d'installation", () => {
    const inventory = inventoryOf(INVENTORY_PAYLOAD);
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["zabbix", "louche"]);

    const [verified, rejected] = inventory.entries;
    expect(verified?.origin).toBe("installed");
    expect(verified?.trust).toBe("verified");
    expect(verified?.signedBy).toBe("ops-2026");
    expect(verified?.removable).toBe(true);
    expect(verified?.version).toBe("2.1.0");
    expect(verified?.installedBy).toBe("ybanas");

    expect(rejected?.trust).toBe("untrusted");
    expect(rejected?.reason).toBe("Signature produite par une clé inconnue du serveur.");
    // Rien d'un paquet refusé n'est présenté comme un fait : ni nom, ni version.
    expect(rejected?.name).toBe("louche");
    expect(rejected?.version).toBeNull();
    expect(moduleIsTrusted(rejected!)).toBe(false);
  });

  it("clé de confiance nommée, et son nombre relevé", () => {
    const inventory = inventoryOf(INVENTORY_PAYLOAD);
    expect(inventory.trustKeys).toEqual(["ops-2026"]);
    expect(inventory.trustKeyCount).toBe(1);
    expect(inventory.installSupported).toBe(true);
  });

  it("accepte la forme à plat (booléens) autant que le bloc de confiance imbriqué", () => {
    const inventory = inventoryOf({
      plugins: [
        { id: "a", builtin: true },
        { id: "b", builtin: false, verified: true, signedBy: "ops-2026" },
        { id: "c", builtin: false, verified: false, reason: "Paquet non signé." },
      ],
    });
    expect(inventory.entries.map((entry) => `${entry.origin}/${entry.trust}`)).toEqual([
      "builtin/builtin",
      "installed/verified",
      "installed/untrusted",
    ]);
    expect(inventory.entries[2]?.reason).toBe("Paquet non signé.");
  });

  it("nom et version repris du manifeste imbriqué quand l'entrée ne les porte pas", () => {
    const inventory = inventoryOf({
      modules: [{ manifest: { id: "glpi", name: "Assistance GLPI", version: "3.2.1" }, origin: "builtin" }],
    });
    expect(inventory.entries[0]).toMatchObject({ id: "glpi", name: "Assistance GLPI", version: "3.2.1" });
  });

  it("version et confiance non communiquées : rien n'est inventé, la confiance n'est pas acquise", () => {
    const entry = inventoryOf({ modules: [{ id: "muet" }] }).entries[0];
    expect(entry?.version).toBeNull();
    expect(entry?.trust).toBe("unknown");
    expect(entry?.signedBy).toBeNull();
    expect(moduleIsTrusted(entry!)).toBe(false);
    // Cette route ne décrit que des modules installés : une entrée sans origine en est un.
    expect(entry?.origin).toBe("installed");
  });

  it("entrée sans identifiant ignorée, doublon écarté", () => {
    const inventory = inventoryOf({
      modules: [{ name: "sans id" }, { id: "hycu" }, { id: "hycu", name: "doublon" }],
    });
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["hycu"]);
  });

  it("charge utile inexploitable : null, jamais un inventaire vide inventé", () => {
    expect(normalizeModuleInventory(null)).toBeNull();
    expect(normalizeModuleInventory({ total: 3 })).toBeNull();
    expect(normalizeModuleInventory("modules")).toBeNull();
  });
});

describe("deriveModuleRows — l'inventaire dit l'origine, GET /api/plugins dit l'activation", () => {
  const plugins = {
    status: "ready" as const,
    items: [summary("hycu", "Sauvegarde HYCU", true, true), summary("zabbix", "Supervision Zabbix", false, false)],
  };

  it("chaque module porte son activation réelle", () => {
    const rows = deriveModuleRows(readySource(INVENTORY_PAYLOAD), plugins);
    expect(rows.map((row) => [row.id, row.enabled, row.configured])).toEqual([
      ["hycu", true, true],
      ["zabbix", false, false],
      // Module refusé : jamais chargé, donc absent de la liste des modules — rien n'est supposé.
      ["louche", null, null],
    ]);
  });

  it("un module chargé mais absent de l'inventaire est livré avec l'application", () => {
    const rows = deriveModuleRows(readySource(INVENTORY_PAYLOAD), plugins);
    expect(rows[0]).toMatchObject({
      id: "hycu",
      origin: "builtin",
      trust: "builtin",
      version: "1.0.0",
      removable: false,
    });
    expect(rows[1]?.origin).toBe("installed");
    expect(moduleIsTrusted(rows[0]!)).toBe(true);
  });

  it("liste des modules pas encore obtenue : l'activation reste inconnue, jamais fausse", () => {
    const rows = deriveModuleRows(readySource(INVENTORY_PAYLOAD), { status: "loading", items: [] });
    expect(rows.every((row) => row.enabled === null && row.configured === null)).toBe(true);
  });
});

describe("deriveModuleRows — repli quand la route d'inventaire n'existe pas", () => {
  const plugins = {
    status: "ready" as const,
    items: [summary("hycu", "Sauvegarde HYCU", true, true)],
  };

  it("les modules exposés restent listés, sans origine ni confiance supposée", () => {
    const rows = deriveModuleRows({ status: "unavailable", reason: "route absente" }, plugins);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "hycu",
      name: "Sauvegarde HYCU",
      version: "1.0.0",
      origin: "unknown",
      trust: "unknown",
      removable: false,
      enabled: true,
      configured: true,
    });
  });

  it("aucune source connue : aucune ligne, jamais une liste fabriquée", () => {
    expect(deriveModuleRows({ status: "unavailable", reason: "x" }, { status: "unavailable", items: [] })).toEqual([]);
    expect(deriveModuleRows({ status: "loading" }, { status: "idle", items: [] })).toEqual([]);
  });

  it("inventaire en cours de lecture : rien n'est rendu avant la réponse réelle", () => {
    expect(deriveModuleRows({ status: "loading" }, plugins)).toEqual([]);
  });

  it("sans inventaire, rien n'est désinstallable ni installable depuis cet écran", () => {
    const source: ModuleInventorySource = { status: "unavailable", reason: "route absente" };
    const rows = deriveModuleRows(source, plugins);
    expect(moduleInstallAvailability(source)).toBe("no-inventory");
    expect(moduleUninstallable(rows[0]!, source)).toBe(false);
  });
});

describe("moduleInstallAvailability — jamais un bouton dont l'échec est certain", () => {
  it("aucune clé de confiance configurée : installation indisponible, et c'est la raison donnée", () => {
    expect(moduleInstallAvailability(readySource({ modules: [], trustedKeyIds: [] }))).toBe("no-trust-key");
    expect(moduleInstallAvailability(readySource({ modules: [], trustKeyCount: 0 }))).toBe("no-trust-key");
    // Le serveur annonce aussi l'installation indisponible : le motif « aucune clé » l'emporte.
    expect(
      moduleInstallAvailability(readySource({ modules: [], trustedKeyIds: [], installAvailable: false })),
    ).toBe("no-trust-key");
  });

  it("le serveur refuse explicitement l'installation", () => {
    expect(moduleInstallAvailability(readySource({ modules: [], trustKeys: ["ops"], canInstall: false }))).toBe(
      "unsupported",
    );
  });

  it("au moins une clé et aucun refus : installation proposée", () => {
    expect(moduleInstallAvailability(readySource(INVENTORY_PAYLOAD))).toBe("ready");
  });
});

describe("moduleUninstallable", () => {
  const loaded = { status: "ready" as const, items: [summary("hycu", "Sauvegarde HYCU", true, true)] };
  const source = readySource(INVENTORY_PAYLOAD);
  const rows = deriveModuleRows(source, loaded);

  it("un module livré avec l'application ne se désinstalle pas", () => {
    expect(rows[0]?.id).toBe("hycu");
    expect(moduleUninstallable(rows[0]!, source)).toBe(false);
  });

  it("un module installé se désinstalle, refusé compris — c'est la seule remédiation", () => {
    expect(moduleUninstallable(rows[1]!, source)).toBe(true);
    expect(moduleUninstallable(rows[2]!, source)).toBe(true);
  });

  it("serveur qui n'expose pas la désinstallation : aucun bouton", () => {
    const noUninstall = readySource({ ...INVENTORY_PAYLOAD, canUninstall: false });
    const noUninstallRows = deriveModuleRows(noUninstall, loaded);
    expect(noUninstallRows[1]?.id).toBe("zabbix");
    expect(moduleUninstallable(noUninstallRows[1]!, noUninstall)).toBe(false);
  });
});
