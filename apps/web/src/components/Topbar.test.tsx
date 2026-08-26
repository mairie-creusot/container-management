/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import Topbar from "@/components/Topbar";
import authReducer, { fetchSession } from "@/features/auth/authSlice";
import clustersReducer from "@/features/clusters/clustersSlice";
import notificationsReducer from "@/features/notifications/notificationsSlice";
import pluginsReducer, { fetchPlugins } from "@/features/plugins/pluginsSlice";
import uiReducer from "@/features/ui/uiSlice";
import type { PluginManifest, PluginSummary, PluginsStatus } from "@/features/plugins/pluginsModel";
import type { Role, Session } from "@/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sessionWith(role: Role): Session {
  return { username: "svc-quai", displayName: "Yann Banas", roles: [role] };
}

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

function summary(id: string, name: string): PluginSummary {
  return { manifest: manifest(id, name), enabled: true, configured: true };
}

function makeStore(options: { role: Role; status: PluginsStatus; items: PluginSummary[] }) {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      ui: uiReducer,
      plugins: pluginsReducer,
      clusters: clustersReducer,
      notifications: notificationsReducer,
    },
  });
  // L'état est posé par les actions réelles : session lue, liste des modules rendue ou en cours.
  store.dispatch(fetchSession.fulfilled(sessionWith(options.role), "test", undefined));
  if (options.status === "ready") {
    store.dispatch(fetchPlugins.fulfilled({ ok: true, plugins: options.items }, "test", undefined));
  } else if (options.status === "loading") {
    store.dispatch(fetchPlugins.pending("test", undefined));
  }
  return store;
}

type Store = ReturnType<typeof makeStore>;

function renderTopbar(options: { role: Role; status: PluginsStatus; items: PluginSummary[] }): Store {
  const store = makeStore(options);
  render(
    <Provider store={store}>
      <ConfirmProvider>
        <Topbar />
      </ConfirmProvider>
    </Provider>,
  );
  return store;
}

function openSettingsMenu(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Réglages" }));
  return screen.getByRole("menu");
}

function menuLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

beforeEach(() => {
  // GET /environments part au montage : répondu à vide, jamais laissé pendre.
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("menu Réglages du Topbar — dérivé des modules réellement chargés", () => {
  it("un module absent de la réponse ne figure pas au menu", () => {
    renderTopbar({ role: "admin", status: "ready", items: [summary("hycu", "Sauvegarde HYCU")] });
    const labels = menuLabels(openSettingsMenu());

    expect(labels).toContain("Sauvegarde HYCU");
    expect(labels).not.toContain("Assistance GLPI");
    expect(labels).not.toContain("Virtualisation Nutanix");
  });

  it("un module installé à chaud entre au menu sans qu'aucune liste soit retouchée", () => {
    renderTopbar({
      role: "admin",
      status: "ready",
      items: [summary("hycu", "Sauvegarde HYCU"), summary("zabbix", "Supervision Zabbix")],
    });

    expect(menuLabels(openSettingsMenu())).toContain("Supervision Zabbix");
  });

  it("le libellé d'un module vient de son manifeste, pas du catalogue statique", () => {
    renderTopbar({ role: "admin", status: "ready", items: [summary("hycu", "Sauvegarde HYCU renommée")] });

    const labels = menuLabels(openSettingsMenu());
    expect(labels).toContain("Sauvegarde HYCU renommée");
    expect(labels).not.toContain("Sauvegarde HYCU");
  });

  it("les sections du cœur restent proposées, Modules compris", () => {
    renderTopbar({ role: "admin", status: "ready", items: [] });
    const labels = menuLabels(openSettingsMenu());

    expect(labels).toEqual([
      "Assistant de configuration",
      "Modules",
      "DNS Active Directory",
      "Autorité de certification AD CS",
      "Canaux de notification",
      "Tous les réglages",
    ]);
  });

  it("liste des modules pas encore obtenue : l'ordre de référence complet, rien ne disparaît", () => {
    renderTopbar({ role: "admin", status: "loading", items: [] });
    const labels = menuLabels(openSettingsMenu());

    expect(labels).toContain("Virtualisation Nutanix");
    expect(labels).toContain("Téléphonie 3CX");
    expect(labels).toContain("Assistance GLPI");
    expect(labels).toContain("Sauvegarde HYCU");
  });
});

describe("menu Réglages du Topbar — non-régression du reste", () => {
  it("choisir une entrée ouvre la vue Réglages sur cette section, et referme le menu", () => {
    const store = renderTopbar({ role: "admin", status: "ready", items: [summary("hycu", "Sauvegarde HYCU")] });
    const menu = openSettingsMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sauvegarde HYCU" }));

    expect(store.getState().ui.currentView).toBe("settings");
    expect(store.getState().ui.settingsSection).toBe("hycu");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("« Tous les réglages » ouvre la page sans présélection", () => {
    const store = renderTopbar({ role: "admin", status: "ready", items: [] });
    const menu = openSettingsMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Tous les réglages" }));

    expect(store.getState().ui.currentView).toBe("settings");
    expect(store.getState().ui.settingsSection).toBeNull();
  });

  it("sans le rôle admin, aucun menu Réglages n'est proposé", () => {
    renderTopbar({ role: "operator", status: "ready", items: [] });

    expect(screen.queryByRole("button", { name: "Réglages" })).toBeNull();
  });
});
