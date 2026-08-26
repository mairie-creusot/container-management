import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/api/client";
import { normalizePluginsPayload, type PluginSummary, type PluginsStatus } from "@/features/plugins/pluginsModel";
import {
  normalizePluginConfigPayload,
  normalizePluginTestPayload,
  type PluginConfigView,
  type PluginTestOutcome,
} from "@/features/plugins/pluginConfigModel";

/** État de la configuration d'UN greffon, tel que les routes génériques la décrivent. */
export interface PluginConfigEntry {
  status: PluginsStatus;
  configured: boolean;
  enabled: boolean;
  /** Vue sûre : les secrets y sont des booléens `hasX`, jamais des valeurs. */
  config: Record<string, unknown>;
  /** Change à chaque configuration relue — sert de `resetKey` au formulaire généré. */
  revision: number;
  saving: boolean;
  testing: boolean;
  clearing: boolean;
  toggling: boolean;
  error: string | null;
  /** Échec de la SEULE bascule d'activation — affiché près de l'interrupteur, pas dans le formulaire. */
  enabledError: string | null;
  testResult: PluginTestOutcome | null;
}

export interface PluginsState {
  items: PluginSummary[];
  status: PluginsStatus;
  /** Motif réel du dernier échec, conservé pour diagnostic — jamais affiché comme une erreur bloquante. */
  error: string | null;
  configs: Record<string, PluginConfigEntry>;
}

export const initialPluginConfigEntry: PluginConfigEntry = {
  status: "idle",
  configured: false,
  enabled: false,
  config: {},
  revision: 0,
  saving: false,
  testing: false,
  clearing: false,
  toggling: false,
  error: null,
  enabledError: null,
  testResult: null,
};

export const initialPluginsState: PluginsState = { items: [], status: "idle", error: null, configs: {} };

type FetchPluginsResult = { ok: true; plugins: PluginSummary[] } | { ok: false; reason: string };

/** Résultat d'une route de configuration : elle a abouti (vue fraîche) ou pas (motif lisible). */
export type PluginConfigResult =
  | { ok: true; pluginId: string; view: PluginConfigView }
  | { ok: false; pluginId: string; reason: string };

export type PluginTestResult =
  | { ok: true; pluginId: string; test: PluginTestOutcome }
  | { ok: false; pluginId: string; reason: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** GET /api/plugins. Ne rejette jamais : une route absente ou un corps inattendu donne
 * `unavailable`, l'état de repli qui laisse les pages de greffons visibles et n'alerte personne. */
export const fetchPlugins = createAsyncThunk<FetchPluginsResult>("plugins/fetchAll", async () => {
  try {
    const plugins = normalizePluginsPayload(await apiGet<unknown>("/plugins"));
    if (!plugins) return { ok: false, reason: "GET /api/plugins n'a pas renvoyé de liste exploitable." };
    return { ok: true, plugins };
  } catch (error) {
    return { ok: false, reason: errorMessage(error, "Liste des modules injoignable.") };
  }
});

// Les thunks ci-dessous ne rejettent jamais non plus : l'échec est rendu DANS la section (bannière
// du formulaire), pas en notification globale — un mot de passe refusé n'est pas une panne.

export const fetchPluginConfig = createAsyncThunk<PluginConfigResult, string>(
  "plugins/fetchConfig",
  async (pluginId) => {
    try {
      const view = normalizePluginConfigPayload(await apiGet<unknown>(`/plugins/${encodeURIComponent(pluginId)}/config`));
      if (!view) return { ok: false, pluginId, reason: "La configuration renvoyée n'est pas exploitable." };
      return { ok: true, pluginId, view };
    } catch (error) {
      return { ok: false, pluginId, reason: errorMessage(error, "Configuration du module injoignable.") };
    }
  },
);

/** PUT : le serveur TESTE la connexion avant d'enregistrer — un échec ne persiste rien. Un champ
 * secret absent du corps conserve celui déjà enregistré. */
export const savePluginConfig = createAsyncThunk<
  PluginConfigResult,
  { pluginId: string; config: Record<string, unknown> }
>("plugins/saveConfig", async ({ pluginId, config }) => {
  try {
    const view = normalizePluginConfigPayload(
      await apiPut<unknown>(`/plugins/${encodeURIComponent(pluginId)}/config`, { config }),
    );
    if (!view) return { ok: false, pluginId, reason: "Le serveur n'a pas confirmé l'enregistrement." };
    return { ok: true, pluginId, view };
  } catch (error) {
    return { ok: false, pluginId, reason: errorMessage(error, "Enregistrement impossible.") };
  }
});

/** POST : ne persiste rien. Un corps vide teste la configuration DÉJÀ enregistrée. */
export const testPluginConfig = createAsyncThunk<
  PluginTestResult,
  { pluginId: string; config: Record<string, unknown> }
>("plugins/testConfig", async ({ pluginId, config }) => {
  try {
    const test = normalizePluginTestPayload(
      await apiPost<unknown>(`/plugins/${encodeURIComponent(pluginId)}/config/test`, { config }),
    );
    if (!test) return { ok: false, pluginId, reason: "Le serveur n'a pas renvoyé de résultat de test." };
    return { ok: true, pluginId, test };
  } catch (error) {
    return { ok: false, pluginId, reason: errorMessage(error, "Test de connexion impossible.") };
  }
});

/** DELETE puis relecture : l'écran montre l'état réel du greffon retiré, jamais un état supposé. */
export const removePluginConfig = createAsyncThunk<PluginConfigResult, string>(
  "plugins/removeConfig",
  async (pluginId) => {
    try {
      await apiDelete<unknown>(`/plugins/${encodeURIComponent(pluginId)}/config`);
      const view = normalizePluginConfigPayload(await apiGet<unknown>(`/plugins/${encodeURIComponent(pluginId)}/config`));
      if (!view) return { ok: false, pluginId, reason: "La configuration renvoyée n'est pas exploitable." };
      return { ok: true, pluginId, view };
    } catch (error) {
      return { ok: false, pluginId, reason: errorMessage(error, "Retrait impossible.") };
    }
  },
);

/** Bascule seule : la configuration n'est ni relue ni réécrite, et un module jamais configuré se met
 * en pause comme les autres — c'est cet état qui empêche son code d'être chargé. */
export const setPluginEnabled = createAsyncThunk<PluginConfigResult, { pluginId: string; enabled: boolean }>(
  "plugins/setEnabled",
  async ({ pluginId, enabled }) => {
    try {
      const view = normalizePluginConfigPayload(
        await apiPut<unknown>(`/plugins/${encodeURIComponent(pluginId)}/enabled`, { enabled }),
      );
      if (!view) return { ok: false, pluginId, reason: "Le serveur n'a pas confirmé la bascule." };
      return { ok: true, pluginId, view };
    } catch (error) {
      // Le motif du serveur est rendu tel quel : lui substituer une phrase générique masquerait la
      // cause réelle d'un refus (droits, module retiré entre-temps…).
      return { ok: false, pluginId, reason: errorMessage(error, "Activation impossible.") };
    }
  },
);

/** Entrée d'un greffon jamais consulté : l'état initial partagé, jamais un objet neuf (référence
 * stable pour `useAppSelector`). */
export function pluginConfigOf(state: PluginsState, pluginId: string): PluginConfigEntry {
  return state.configs[pluginId] ?? initialPluginConfigEntry;
}

function entryOf(state: PluginsState, pluginId: string): PluginConfigEntry {
  if (!state.configs[pluginId]) state.configs[pluginId] = { ...initialPluginConfigEntry };
  return state.configs[pluginId]!;
}

/**
 * Applique la vue renvoyée par une route de configuration : c'est elle qui fait foi ensuite. La
 * LISTE est alignée au passage — c'est elle qui alimente le tiroir « Extensions », la page Modules
 * et les sections de Réglages. Sans cet alignement, une bascule restait invisible partout ailleurs
 * que dans la section qui l'avait déclenchée, jusqu'à un rechargement de la liste.
 */
function applyView(state: PluginsState, pluginId: string, view: PluginConfigView): void {
  const entry = entryOf(state, pluginId);
  entry.status = "ready";
  entry.configured = view.configured;
  entry.enabled = view.enabled;
  entry.config = view.config;
  entry.revision += 1;
  entry.error = null;
  entry.enabledError = null;

  const summary = state.items.find((item) => item.manifest.id === pluginId);
  if (summary) {
    summary.enabled = view.enabled;
    summary.configured = view.configured;
  }
}

const pluginsSlice = createSlice({
  name: "plugins",
  initialState: initialPluginsState,
  reducers: {
    clearPluginTestResult(state, action: PayloadAction<string>) {
      entryOf(state, action.payload).testResult = null;
    },
    clearPluginConfigError(state, action: PayloadAction<string>) {
      entryOf(state, action.payload).error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPlugins.pending, (state) => {
        state.status = state.status === "ready" ? "ready" : "loading";
      })
      .addCase(fetchPlugins.fulfilled, (state, action) => {
        if (!action.payload.ok) {
          state.status = "unavailable";
          state.items = [];
          state.error = action.payload.reason;
          return;
        }
        state.status = "ready";
        state.items = action.payload.plugins;
        state.error = null;
      })
      .addCase(fetchPlugins.rejected, (state, action) => {
        state.status = "unavailable";
        state.items = [];
        state.error = action.error.message ?? "Liste des modules injoignable.";
      })

      .addCase(fetchPluginConfig.pending, (state, action) => {
        const entry = entryOf(state, action.meta.arg);
        entry.status = entry.status === "ready" ? "ready" : "loading";
      })
      .addCase(fetchPluginConfig.fulfilled, (state, action) => {
        const entry = entryOf(state, action.payload.pluginId);
        if (!action.payload.ok) {
          entry.status = "unavailable";
          entry.error = action.payload.reason;
          return;
        }
        applyView(state, action.payload.pluginId, action.payload.view);
      })

      .addCase(savePluginConfig.pending, (state, action) => {
        const entry = entryOf(state, action.meta.arg.pluginId);
        entry.saving = true;
        entry.error = null;
        entry.testResult = null;
      })
      .addCase(savePluginConfig.fulfilled, (state, action) => {
        const entry = entryOf(state, action.payload.pluginId);
        entry.saving = false;
        if (!action.payload.ok) {
          entry.error = action.payload.reason;
          return;
        }
        applyView(state, action.payload.pluginId, action.payload.view);
      })

      .addCase(testPluginConfig.pending, (state, action) => {
        const entry = entryOf(state, action.meta.arg.pluginId);
        entry.testing = true;
        entry.testResult = null;
      })
      .addCase(testPluginConfig.fulfilled, (state, action) => {
        const entry = entryOf(state, action.payload.pluginId);
        entry.testing = false;
        if (!action.payload.ok) {
          entry.error = action.payload.reason;
          return;
        }
        entry.testResult = action.payload.test;
      })

      .addCase(removePluginConfig.pending, (state, action) => {
        const entry = entryOf(state, action.meta.arg);
        entry.clearing = true;
        entry.error = null;
        entry.testResult = null;
      })
      .addCase(removePluginConfig.fulfilled, (state, action) => {
        const entry = entryOf(state, action.payload.pluginId);
        entry.clearing = false;
        if (!action.payload.ok) {
          entry.error = action.payload.reason;
          return;
        }
        applyView(state, action.payload.pluginId, action.payload.view);
      })

      .addCase(setPluginEnabled.pending, (state, action) => {
        const entry = entryOf(state, action.meta.arg.pluginId);
        entry.toggling = true;
        entry.enabledError = null;
      })
      .addCase(setPluginEnabled.fulfilled, (state, action) => {
        const entry = entryOf(state, action.payload.pluginId);
        entry.toggling = false;
        if (!action.payload.ok) {
          entry.enabledError = action.payload.reason;
          return;
        }
        applyView(state, action.payload.pluginId, action.payload.view);
      });
  },
});

export const { clearPluginTestResult, clearPluginConfigError } = pluginsSlice.actions;
export default pluginsSlice.reducer;
