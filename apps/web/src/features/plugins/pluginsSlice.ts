import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { ApiError, apiGet } from "@/api/client";
import { normalizePluginsPayload, type PluginSummary, type PluginsStatus } from "@/features/plugins/pluginsModel";

export interface PluginsState {
  items: PluginSummary[];
  status: PluginsStatus;
  /** Motif réel du dernier échec, conservé pour diagnostic — jamais affiché comme une erreur bloquante. */
  error: string | null;
}

export const initialPluginsState: PluginsState = { items: [], status: "idle", error: null };

type FetchPluginsResult = { ok: true; plugins: PluginSummary[] } | { ok: false; reason: string };

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
    return { ok: false, reason: errorMessage(error, "Liste des greffons injoignable.") };
  }
});

const pluginsSlice = createSlice({
  name: "plugins",
  initialState: initialPluginsState,
  reducers: {},
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
        state.error = action.error.message ?? "Liste des greffons injoignable.";
      });
  },
});

export default pluginsSlice.reducer;
