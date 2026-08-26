/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import pluginsReducer, { fetchPlugins } from "@/features/plugins/pluginsSlice";
import uiReducer from "@/features/ui/uiSlice";
import type { PluginManifest, PluginSummary } from "@/features/plugins/pluginsModel";
import ModulesSection from "@/features/settings/ModulesSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const HYCU = summary("hycu", "Sauvegarde HYCU", true, true);
const ZABBIX = summary("zabbix", "Supervision Zabbix", true, true);

/** Forme réelle de GET /api/plugins/installed : les modules installés SEULEMENT — « hycu », livré
 * avec l'application, n'y figure pas et vient de GET /api/plugins. */
const INVENTORY = {
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

interface Answer {
  status: number;
  payload: unknown;
}
interface Call {
  method: string;
  url: string;
}

let calls: Call[] = [];
let routes: Record<string, Answer> = {};

function stubFetch(): void {
  calls = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const answer = routes[`${method} ${url}`] ?? { status: 404, payload: { error: "Route inconnue" } };
    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: () => Promise.resolve(answer.payload),
    } as unknown as Response);
  });
}

function callsTo(method: string, url: string): Call[] {
  return calls.filter((call) => call.method === method && call.url === url);
}

function renderSection(items: PluginSummary[]): void {
  const store = configureStore({ reducer: { plugins: pluginsReducer, ui: uiReducer } });
  // La liste des modules telle que GET /api/plugins l'aurait déjà rendue.
  store.dispatch(fetchPlugins.fulfilled({ ok: true, plugins: items }, "test", undefined));
  render(
    <Provider store={store}>
      <ConfirmProvider>
        <ModulesSection />
      </ConfirmProvider>
    </Provider>,
  );
}

beforeEach(() => {
  routes = {
    "GET /api/plugins/installed": { status: 200, payload: INVENTORY },
    "GET /api/plugins": { status: 200, payload: { plugins: [HYCU] } },
  };
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("inventaire — livré / installé, confiance, activation", () => {
  it("chaque module montre son origine, sa version, sa signature et son activation", async () => {
    renderSection([HYCU, ZABBIX]);

    expect(await screen.findByText("Sauvegarde HYCU")).toBeTruthy();
    expect(screen.getAllByText("Livré avec l'application")).toHaveLength(1);
    expect(screen.getAllByText("Installé")).toHaveLength(2);
    expect(screen.getByText("2.1.0")).toBeTruthy();
    // La clé nommée par le serveur : dans la liste des clés de confiance ET sur le module signé.
    expect(screen.getAllByText("ops-2026")).toHaveLength(2);
    expect(screen.getAllByText("Signature vérifiée")).toHaveLength(1);
    expect(screen.getAllByText("Activé")).toHaveLength(2);
    expect(screen.getByText("ybanas")).toBeTruthy();
  });

  it("un module refusé est distingué, avec le motif en clair et sans action d'activation", async () => {
    renderSection([HYCU, ZABBIX]);

    const reason = await screen.findByText("Signature produite par une clé inconnue du serveur.");
    const card = reason.closest(".module-card");
    expect(card?.className).toContain("module-card--untrusted");
    expect(screen.getByText("Signature refusée")).toBeTruthy();
    // Jamais présenté comme prêt à l'emploi : pas de renvoi vers sa configuration.
    expect(card?.querySelector("button")?.textContent).toBe("Désinstaller");
  });

  it("un module livré avec l'application ne propose pas de désinstallation", async () => {
    renderSection([HYCU, ZABBIX]);

    const name = await screen.findByText("Sauvegarde HYCU");
    const card = name.closest(".module-card");
    const labels = Array.from(card?.querySelectorAll("button") ?? []).map((button) => button.textContent);
    expect(labels).not.toContain("Désinstaller");
  });
});

describe("repli quand les routes d'administration n'existent pas encore", () => {
  it("l'écran le dit et retombe sur les seuls modules exposés, sans origine ni confiance", async () => {
    routes = { "GET /api/plugins": { status: 200, payload: { plugins: [] } } };
    renderSection([HYCU]);

    expect(await screen.findByText("Inventaire des modules indisponible")).toBeTruthy();
    expect(screen.getByText("Sauvegarde HYCU")).toBeTruthy();
    expect(screen.getByText("Origine non communiquée")).toBeTruthy();
    expect(screen.getByText("Confiance non communiquée")).toBeTruthy();
    expect(callsTo("GET", "/api/plugins/installed")).toHaveLength(1);
  });

  it("aucune installation n'est proposée sans inventaire", async () => {
    routes = { "GET /api/plugins": { status: 200, payload: { plugins: [] } } };
    renderSection([HYCU]);

    await screen.findByText("Inventaire des modules indisponible");
    expect(screen.queryByLabelText("Paquet signé du module")).toBeNull();
    expect(screen.queryByRole("button", { name: "Installer" })).toBeNull();
  });
});

describe("clés de confiance", () => {
  it("aucune clé configurée : l'écran l'annonce au lieu d'un bouton qui échouerait", async () => {
    routes["GET /api/plugins/installed"] = {
      status: 200,
      payload: { modules: [], installAvailable: false, trustedKeyIds: [] },
    };
    renderSection([]);

    expect(await screen.findByText("Installation de modules externes indisponible")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Installer" })).toBeNull();
  });

  it("une clé configurée : le paquet signé peut être déposé", async () => {
    renderSection([HYCU, ZABBIX]);

    expect(await screen.findByLabelText("Paquet signé du module")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Installer" })).toBeTruthy();
  });
});

describe("désinstallation — confirmée, et prévenue quand le module est configuré", () => {
  it("un module configuré prévient que sa configuration sera perdue", async () => {
    renderSection([HYCU, ZABBIX]);

    const name = await screen.findByText("Supervision Zabbix");
    const card = name.closest(".module-card");
    const button = Array.from(card?.querySelectorAll("button") ?? []).find(
      (entry) => entry.textContent === "Désinstaller",
    );
    fireEvent.click(button!);

    expect(await screen.findByText("Désinstaller Supervision Zabbix ?")).toBeTruthy();
    expect(
      screen.getByText(
        "Ce module est configuré : sa configuration enregistrée, identifiants compris, sera perdue. Ses pages et les données qu'il apporte quittent QUAI. Rien n'est modifié du côté de l'intégration.",
      ),
    ).toBeTruthy();
    // Rien n'est envoyé tant que la confirmation n'est pas donnée.
    expect(callsTo("DELETE", "/api/plugins/installed/zabbix")).toHaveLength(0);
  });

  it("annuler ne désinstalle rien", async () => {
    renderSection([HYCU, ZABBIX]);

    const name = await screen.findByText("Supervision Zabbix");
    const button = Array.from(name.closest(".module-card")?.querySelectorAll("button") ?? []).find(
      (entry) => entry.textContent === "Désinstaller",
    );
    fireEvent.click(button!);
    fireEvent.click(await screen.findByRole("button", { name: "Annuler" }));

    await waitFor(() => expect(screen.queryByText("Désinstaller Supervision Zabbix ?")).toBeNull());
    expect(callsTo("DELETE", "/api/plugins/installed/zabbix")).toHaveLength(0);
  });

  it("confirmée, la désinstallation appelle la route puis relit l'inventaire", async () => {
    routes["DELETE /api/plugins/installed/zabbix"] = { status: 200, payload: {} };
    renderSection([HYCU, ZABBIX]);

    const name = await screen.findByText("Supervision Zabbix");
    const button = Array.from(name.closest(".module-card")?.querySelectorAll("button") ?? []).find(
      (entry) => entry.textContent === "Désinstaller",
    );
    fireEvent.click(button!);

    routes["GET /api/plugins/installed"] = {
      status: 200,
      payload: { modules: [], installAvailable: true, trustedKeyIds: ["ops-2026"] },
    };
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Désinstaller" }));

    await waitFor(() => expect(callsTo("DELETE", "/api/plugins/installed/zabbix")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Supervision Zabbix")).toBeNull());
    expect(screen.getByText("Module « Supervision Zabbix » désinstallé.")).toBeTruthy();
  });

  it("refus du serveur : son motif est affiché, jamais un succès supposé", async () => {
    routes["DELETE /api/plugins/installed/zabbix"] = {
      status: 409,
      payload: { error: "Ce module est encore activé : désactivez-le avant de le désinstaller." },
    };
    renderSection([HYCU, ZABBIX]);

    const name = await screen.findByText("Supervision Zabbix");
    const button = Array.from(name.closest(".module-card")?.querySelectorAll("button") ?? []).find(
      (entry) => entry.textContent === "Désinstaller",
    );
    fireEvent.click(button!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Désinstaller" }));

    expect(
      await screen.findByText("Ce module est encore activé : désactivez-le avant de le désinstaller."),
    ).toBeTruthy();
    expect(screen.getByText("Supervision Zabbix")).toBeTruthy();
  });
});
