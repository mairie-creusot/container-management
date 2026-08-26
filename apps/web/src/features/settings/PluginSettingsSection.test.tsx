/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import pluginsReducer, { initialPluginsState, type PluginsState } from "@/features/plugins/pluginsSlice";
import type { PluginManifest, PluginSummary } from "@/features/plugins/pluginsModel";
import PluginSettingsSection from "@/features/settings/PluginSettingsSection";

// Même branchement que SchemaForm.test.tsx : ni `globals` ni jsdom par défaut dans ce paquet.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Manifeste RÉEL du greffon HYCU (apps/api/src/plugins/hycu/index.ts). */
const HYCU_MANIFEST: PluginManifest = {
  id: "hycu",
  name: "Sauvegarde HYCU",
  version: "1.0.0",
  coreApi: "^1.0",
  configSchema: {
    type: "object",
    title: "Contrôleur de sauvegarde (HYCU)",
    properties: {
      url: {
        type: "string",
        title: "URL du contrôleur HYCU",
        description: "Adresse de l'API REST du contrôleur — QUAI ajoute lui-même le préfixe /rest/v1.0.",
        examples: ["https://172.20.0.100:8443"],
      },
      username: {
        type: "string",
        title: "Utilisateur",
        description: "Compte HYCU en lecture : QUAI n'émet que des GET, aucune sauvegarde ni restauration.",
      },
      password: { type: "string", title: "Mot de passe" },
    },
    required: ["url", "username", "password"],
    additionalProperties: false,
  },
  secretFields: ["password"],
  permissions: { network: [], mutates: false },
  auditLabels: {},
};

const CONFIGURED_VIEW = {
  configured: true,
  enabled: true,
  config: { url: "https://172.20.0.100:8443", username: "svc-quai", hasPassword: true },
};

interface Answer {
  status: number;
  payload: unknown;
}
interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let routes: Record<string, Answer> = {};

function stubFetch(): void {
  calls = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const answer = routes[`${method} ${url}`] ?? { status: 200, payload: {} };
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

function renderSection(summary: PluginSummary): void {
  const preloaded: { plugins: PluginsState } = {
    plugins: { ...initialPluginsState, status: "ready", items: [summary] },
  };
  const store = configureStore({ reducer: { plugins: pluginsReducer }, preloadedState: preloaded });
  render(
    <Provider store={store}>
      <ConfirmProvider>
        <PluginSettingsSection pluginId="hycu" />
      </ConfirmProvider>
    </Provider>,
  );
}

function summaryOf(enabled: boolean, configured: boolean): PluginSummary {
  return { manifest: HYCU_MANIFEST, enabled, configured };
}

beforeEach(() => {
  routes = {
    "GET /api/plugins/hycu/config": { status: 200, payload: CONFIGURED_VIEW },
    "GET /api/plugins": { status: 200, payload: { plugins: [{ manifest: HYCU_MANIFEST, enabled: true, configured: true }] } },
  };
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("section générée — le formulaire vient du manifeste", () => {
  it("greffon configuré : récapitulatif d'abord, formulaire seulement sur demande", async () => {
    renderSection(summaryOf(true, true));

    expect(await screen.findByText("Enregistré et chiffré — jamais réaffiché")).toBeTruthy();
    expect(screen.getByText("https://172.20.0.100:8443")).toBeTruthy();
    expect(screen.queryByLabelText(/Mot de passe/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    expect(screen.getByLabelText(/URL du contrôleur HYCU/)).toBeTruthy();
  });

  it("greffon jamais configuré : le formulaire est ouvert d'emblée, sans récapitulatif", async () => {
    routes["GET /api/plugins/hycu/config"] = { status: 200, payload: { configured: false, enabled: false, config: {} } };
    renderSection(summaryOf(false, false));

    expect(await screen.findByLabelText(/URL du contrôleur HYCU/)).toBeTruthy();
    expect(screen.queryByText("Enregistré et chiffré — jamais réaffiché")).toBeNull();
    expect(screen.queryByRole("button", { name: "Modifier" })).toBeNull();
  });
});

describe("secrets — jamais réaffichés, omis quand ils sont laissés vides", () => {
  it("le mot de passe enregistré n'est pas pré-rempli et le champ annonce qu'il sera conservé", async () => {
    renderSection(summaryOf(true, true));
    fireEvent.click(await screen.findByRole("button", { name: "Modifier" }));

    const password = screen.getByLabelText(/Mot de passe/) as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.type).toBe("password");
    expect(screen.getByText(/Mot de passe \(laisser vide pour conserver l'existant\)/)).toBeTruthy();
  });

  it("laissé vide, le mot de passe est absent du corps envoyé : le serveur conserve l'existant", async () => {
    routes["PUT /api/plugins/hycu/config"] = { status: 200, payload: CONFIGURED_VIEW };
    renderSection(summaryOf(true, true));
    fireEvent.click(await screen.findByRole("button", { name: "Modifier" }));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(callsTo("PUT", "/api/plugins/hycu/config")).toHaveLength(1));
    const sent = callsTo("PUT", "/api/plugins/hycu/config")[0]?.body as { config: Record<string, unknown> };
    expect(sent.config).toEqual({ url: "https://172.20.0.100:8443", username: "svc-quai" });
    expect(Object.hasOwn(sent.config, "password")).toBe(false);
  });

  it("un mot de passe saisi part dans le corps, puis l'écran revient au récapitulatif", async () => {
    routes["PUT /api/plugins/hycu/config"] = { status: 200, payload: CONFIGURED_VIEW };
    renderSection(summaryOf(true, true));
    fireEvent.click(await screen.findByRole("button", { name: "Modifier" }));

    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "nouveau-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(callsTo("PUT", "/api/plugins/hycu/config")).toHaveLength(1));
    const sent = callsTo("PUT", "/api/plugins/hycu/config")[0]?.body as { config: Record<string, unknown> };
    expect(sent.config["password"]).toBe("nouveau-secret");
    await waitFor(() => expect(screen.queryByLabelText(/Mot de passe/)).toBeNull());
    expect(screen.getByText("Enregistré et chiffré — jamais réaffiché")).toBeTruthy();
  });

  it("enregistrement refusé : la saisie est conservée et le motif du serveur est affiché", async () => {
    routes["PUT /api/plugins/hycu/config"] = { status: 400, payload: { error: "Authentification refusée par le contrôleur." } };
    renderSection(summaryOf(true, true));
    fireEvent.click(await screen.findByRole("button", { name: "Modifier" }));

    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "mauvais-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("Authentification refusée par le contrôleur.")).toBeTruthy();
    expect((screen.getByLabelText(/Mot de passe/) as HTMLInputElement).value).toBe("mauvais-secret");
  });
});

describe("interrupteur Activer/Désactiver", () => {
  it("la bascule appelle la route dédiée, sans toucher à la configuration", async () => {
    routes["PUT /api/plugins/hycu/enabled"] = {
      status: 200,
      payload: { ...CONFIGURED_VIEW, enabled: false },
    };
    renderSection(summaryOf(true, true));

    const toggle = await screen.findByRole("switch");
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(callsTo("PUT", "/api/plugins/hycu/enabled")).toHaveLength(1));
    expect(callsTo("PUT", "/api/plugins/hycu/enabled")[0]?.body).toEqual({ enabled: false });
    expect(callsTo("PUT", "/api/plugins/hycu/config")).toHaveLength(0);
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false));
  });

  it("greffon jamais configuré : la mise en pause passe quand même, c'est elle qui décharge le module", async () => {
    routes["GET /api/plugins/hycu/config"] = { status: 200, payload: { configured: false, enabled: true, config: {} } };
    routes["PUT /api/plugins/hycu/enabled"] = { status: 200, payload: { configured: false, enabled: false, config: {} } };
    renderSection(summaryOf(false, true));

    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true));
    fireEvent.click(toggle);

    await waitFor(() => expect(callsTo("PUT", "/api/plugins/hycu/enabled")).toHaveLength(1));
    expect(callsTo("PUT", "/api/plugins/hycu/enabled")[0]?.body).toEqual({ enabled: false });
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false));
  });

  it("un refus du serveur est rendu tel quel près de l'interrupteur", async () => {
    routes["PUT /api/plugins/hycu/enabled"] = { status: 403, payload: { error: "Insufficient role: admin required" } };
    renderSection(summaryOf(true, true));

    fireEvent.click(await screen.findByRole("switch"));

    expect(await screen.findByText(/Insufficient role/)).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });
});
