import { describe, expect, it } from "vitest";
import {
  derivePluginNavItems,
  isPluginView,
  normalizePluginsPayload,
  PLUGIN_NAV_CATALOG,
  type PluginManifest,
  type PluginSummary,
} from "@/features/plugins/pluginsModel";

function manifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    coreApi: "^1.0",
    configSchema: { type: "object", properties: {} },
    secretFields: [],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  };
}

function summary(id: string, enabled: boolean, configured: boolean): PluginSummary {
  return { manifest: manifest(id), enabled, configured };
}

function labels(items: { label: string }[]): string[] {
  return items.map((item) => item.label);
}

describe("derivePluginNavItems — une entrée n'existe que si son greffon est activé", () => {
  it("greffon activé : son entrée est là ; désactivé : elle disparaît", () => {
    const items = derivePluginNavItems({
      status: "ready",
      items: [summary("hycu", true, true), summary("3cx", false, true), summary("glpi", true, true)],
    });
    expect(labels(items)).toEqual(["Sauvegardes", "Assistance GLPI"]);
  });

  it("greffon absent de la réponse : aucune entrée inventée", () => {
    const items = derivePluginNavItems({ status: "ready", items: [summary("hycu", true, true)] });
    expect(labels(items)).toEqual(["Sauvegardes"]);
  });

  it("activé mais pas configuré : l'entrée reste, signalée à configurer", () => {
    const items = derivePluginNavItems({ status: "ready", items: [summary("3cx", true, false)] });
    expect(items).toEqual([
      { pluginId: "3cx", view: "threecx", label: "Téléphonie", needsConfiguration: true },
    ]);
  });

  it("aucun greffon activé : liste vide, pas de repli déguisé", () => {
    const items = derivePluginNavItems({
      status: "ready",
      items: [summary("hycu", false, true), summary("3cx", false, false), summary("glpi", false, true)],
    });
    expect(items).toEqual([]);
  });

  it("l'ordre suit le catalogue, pas l'ordre de la réponse", () => {
    const items = derivePluginNavItems({
      status: "ready",
      items: [summary("glpi", true, true), summary("3cx", true, true), summary("hycu", true, true)],
    });
    expect(labels(items)).toEqual(["Sauvegardes", "Téléphonie", "Assistance GLPI"]);
  });
});

describe("derivePluginNavItems — repli tant que la route n'a pas répondu", () => {
  it("état initial : tout le catalogue, rien ne disparaît par avance", () => {
    expect(labels(derivePluginNavItems({ status: "idle", items: [] }))).toEqual(labels([...PLUGIN_NAV_CATALOG]));
  });

  it("chargement en cours : même repli", () => {
    expect(derivePluginNavItems({ status: "loading", items: [] })).toHaveLength(PLUGIN_NAV_CATALOG.length);
  });

  it("route indisponible : le catalogue complet, sans avertissement de configuration", () => {
    const items = derivePluginNavItems({ status: "unavailable", items: [] });
    expect(labels(items)).toEqual(["Sauvegardes", "Téléphonie", "Assistance GLPI"]);
    expect(items.every((item) => !item.needsConfiguration)).toBe(true);
  });
});

describe("normalizePluginsPayload — les deux formes réellement rencontrées", () => {
  it("enveloppe complète : enabled et configured sont lus tels quels", () => {
    const plugins = normalizePluginsPayload({
      plugins: [
        { manifest: manifest("hycu"), enabled: true, configured: false },
        { manifest: manifest("3cx"), enabled: false, configured: true },
      ],
    });
    expect(plugins).toEqual([
      { manifest: manifest("hycu"), enabled: true, configured: false },
      { manifest: manifest("3cx"), enabled: false, configured: true },
    ]);
  });

  it("`enabled` absent : traité comme activé", () => {
    const plugins = normalizePluginsPayload({ plugins: [{ manifest: manifest("glpi"), configured: true }] });
    expect(plugins?.[0]?.enabled).toBe(true);
  });

  it("manifeste nu (forme actuelle de la route) : activé et sans avertissement", () => {
    const plugins = normalizePluginsPayload({ plugins: [manifest("hycu"), manifest("3cx")] });
    expect(plugins?.map((entry) => entry.manifest.id)).toEqual(["hycu", "3cx"]);
    expect(plugins?.every((entry) => entry.enabled && entry.configured)).toBe(true);
  });

  it("un manifeste nu encore activé reste visible dans le menu", () => {
    const plugins = normalizePluginsPayload({ plugins: [manifest("hycu"), manifest("3cx"), manifest("glpi")] });
    expect(labels(derivePluginNavItems({ status: "ready", items: plugins ?? [] }))).toEqual([
      "Sauvegardes",
      "Téléphonie",
      "Assistance GLPI",
    ]);
  });

  it("liste vide : liste vide, jamais null", () => {
    expect(normalizePluginsPayload({ plugins: [] })).toEqual([]);
  });

  it("entrée sans identifiant : ignorée, pas devinée", () => {
    expect(normalizePluginsPayload({ plugins: [{ manifest: { name: "sans id" } }, manifest("hycu")] })).toEqual([
      { manifest: manifest("hycu"), enabled: true, configured: true },
    ]);
  });

  it("corps inexploitable : null, pour laisser l'appelant replier", () => {
    expect(normalizePluginsPayload(null)).toBeNull();
    expect(normalizePluginsPayload({ error: "Not Found" })).toBeNull();
    expect(normalizePluginsPayload({ plugins: "hycu" })).toBeNull();
  });
});

describe("isPluginView — le cœur n'est jamais rangé sous Extensions", () => {
  it("les trois pages de greffons", () => {
    expect(isPluginView("backups")).toBe(true);
    expect(isPluginView("threecx")).toBe(true);
    expect(isPluginView("glpi")).toBe(true);
  });

  it("« Environnements » reste du cœur malgré le greffon nutanix", () => {
    expect(isPluginView("clusters")).toBe(false);
    expect(isPluginView("overview")).toBe(false);
    expect(isPluginView("publication")).toBe(false);
  });
});
