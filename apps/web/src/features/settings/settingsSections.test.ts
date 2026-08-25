import { describe, expect, it } from "vitest";
import {
  buildSettingsSections,
  settingsSectionMeta,
  SETTINGS_SECTIONS,
} from "@/features/settings/settingsSections";
import type { PluginManifest, PluginSummary } from "@/features/plugins/pluginsModel";

function manifest(id: string, name: string): PluginManifest {
  return {
    id,
    name,
    version: "1.0.0",
    coreApi: "^1.0",
    configSchema: { type: "object", properties: {} },
    secretFields: [],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  };
}

function summary(id: string, name: string, enabled: boolean, configured: boolean): PluginSummary {
  return { manifest: manifest(id, name), enabled, configured };
}

/** Les quatre greffons réellement enregistrés par le serveur, avec le nom exact de leur manifeste. */
const FOUR = [
  summary("nutanix", "Virtualisation Nutanix", true, true),
  summary("3cx", "Téléphonie 3CX", true, true),
  summary("glpi", "Assistance GLPI", true, true),
  summary("hycu", "Sauvegarde HYCU", true, true),
];

function ids(sections: { id: string }[]): string[] {
  return sections.map((section) => section.id);
}

describe("buildSettingsSections — une section par greffon réellement enregistré", () => {
  it("les quatre greffons donnent leurs quatre sections, dans l'ordre de référence", () => {
    expect(ids(buildSettingsSections({ status: "ready", items: FOUR }))).toEqual([
      "setup",
      "nutanix",
      "ad-dns",
      "threecx",
      "glpi",
      "hycu",
      "certificates",
      "notification-channels",
    ]);
  });

  it("le libellé vient du manifeste, pas d'une liste recopiée dans l'interface", () => {
    const sections = buildSettingsSections({
      status: "ready",
      items: [summary("hycu", "Sauvegarde HYCU renommée", true, true)],
    });
    expect(sections.find((section) => section.id === "hycu")?.label).toBe("Sauvegarde HYCU renommée");
  });

  it("greffon désactivé : sa section reste — c'est là qu'on le réactive", () => {
    const sections = buildSettingsSections({ status: "ready", items: [summary("hycu", "Sauvegarde HYCU", false, true)] });
    expect(ids(sections)).toContain("hycu");
  });

  it("greffon jamais configuré : sa section reste — c'est là qu'on le configure", () => {
    const sections = buildSettingsSections({ status: "ready", items: [summary("glpi", "Assistance GLPI", true, false)] });
    expect(ids(sections)).toContain("glpi");
  });

  it("greffon absent de la réponse : sa section disparaît, aucun formulaire n'est deviné", () => {
    const sections = buildSettingsSections({ status: "ready", items: [summary("hycu", "Sauvegarde HYCU", true, true)] });
    expect(ids(sections)).toEqual(["setup", "ad-dns", "hycu", "certificates", "notification-channels"]);
  });

  it("aucun greffon : seules les sections du cœur subsistent", () => {
    expect(ids(buildSettingsSections({ status: "ready", items: [] }))).toEqual([
      "setup",
      "ad-dns",
      "certificates",
      "notification-channels",
    ]);
  });

  it("greffon inconnu du catalogue : ajouté à la fin, nommé par son manifeste", () => {
    const sections = buildSettingsSections({
      status: "ready",
      items: [...FOUR, summary("zabbix", "Supervision Zabbix", true, false)],
    });
    const last = sections[sections.length - 1];
    expect(last?.id).toBe("zabbix");
    expect(last?.label).toBe("Supervision Zabbix");
    expect(last?.pluginId).toBe("zabbix");
  });

  it("manifeste sans nom exploitable : l'identifiant du greffon sert de libellé, rien n'est inventé", () => {
    const nameless = summary("zabbix", "   ", true, true);
    const sections = buildSettingsSections({ status: "ready", items: [nameless] });
    expect(sections[sections.length - 1]?.label).toBe("zabbix");
  });

  it("un greffon apparu deux fois n'ouvre pas deux sections", () => {
    const sections = buildSettingsSections({
      status: "ready",
      items: [summary("hycu", "Sauvegarde HYCU", true, true), summary("hycu", "Doublon", true, true)],
    });
    expect(ids(sections).filter((id) => id === "hycu")).toHaveLength(1);
  });
});

describe("buildSettingsSections — repli tant que la liste n'a pas répondu", () => {
  it("état initial, chargement et route indisponible : l'ordre de référence complet", () => {
    for (const status of ["idle", "loading", "unavailable"] as const) {
      expect(ids(buildSettingsSections({ status, items: [] }))).toEqual(ids(SETTINGS_SECTIONS));
    }
  });
});

describe("settingsSectionMeta", () => {
  it("l'identifiant demandé quand il existe encore", () => {
    const sections = buildSettingsSections({ status: "ready", items: FOUR });
    expect(settingsSectionMeta("hycu", sections).pluginId).toBe("hycu");
    expect(settingsSectionMeta("threecx", sections).pluginId).toBe("3cx");
  });

  it("section disparue ou absente : la première de la liste, jamais une section vide", () => {
    const sections = buildSettingsSections({ status: "ready", items: [] });
    expect(settingsSectionMeta("hycu", sections).id).toBe("setup");
    expect(settingsSectionMeta(null, sections).id).toBe("setup");
  });
});
