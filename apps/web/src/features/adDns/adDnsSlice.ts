import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import type { AdDnsConfig, AdDnsStatus, AdDnsSyncResult, AdDnsTestResult } from "@/types";

/** Formulaire de configuration DNS AD — voir PUT/POST /api/ad-dns/{config,test}. `password` vide
 * = conserver le mot de passe déjà enregistré (même convention que RegistriesPage). */
export interface AdDnsFormInput {
  realm: string;
  kdcHost: string;
  zone: string;
  serviceAccount: string;
  password?: string;
  targetIp: string;
}

interface AdDnsState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  configured: boolean;
  config: AdDnsConfig | null;
  lastSync: AdDnsSyncResult | null;
  saving: boolean;
  clearing: boolean;
  testing: boolean;
  testResult: AdDnsTestResult | null;
}

const initialState: AdDnsState = {
  status: "idle",
  error: null,
  configured: false,
  config: null,
  lastSync: null,
  saving: false,
  clearing: false,
  testing: false,
  testResult: null,
};

export const fetchAdDnsStatus = createAsyncThunk<AdDnsStatus>("adDns/fetchStatus", async () =>
  apiGet<AdDnsStatus>("/ad-dns/config"),
);

export const saveAdDnsConfig = createAsyncThunk<AdDnsStatus, AdDnsFormInput, { rejectValue: string }>(
  "adDns/save",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPut<AdDnsStatus>("/ad-dns/config", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible d'enregistrer la configuration DNS AD.";
      return rejectWithValue(message);
    }
  },
);

export const disableAdDns = createAsyncThunk<void, void, { rejectValue: string }>(
  "adDns/disable",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/ad-dns/config");
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de désactiver la synchronisation DNS AD.";
      return rejectWithValue(message);
    }
  },
);

export const testAdDnsConfig = createAsyncThunk<AdDnsTestResult, AdDnsFormInput, { rejectValue: string }>(
  "adDns/test",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<AdDnsTestResult>("/ad-dns/test", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de tester la configuration DNS AD.";
      return rejectWithValue(message);
    }
  },
);

const adDnsSlice = createSlice({
  name: "adDns",
  initialState,
  reducers: {
    clearAdDnsTestResult(state) {
      state.testResult = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAdDnsStatus.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchAdDnsStatus.fulfilled, (state, action) => {
        state.status = "ready";
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
        state.lastSync = action.payload.lastSync ?? null;
      })
      .addCase(fetchAdDnsStatus.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger la configuration DNS AD.";
      })
      .addCase(saveAdDnsConfig.pending, (state) => {
        state.saving = true;
        state.error = null;
      })
      .addCase(saveAdDnsConfig.fulfilled, (state, action) => {
        state.saving = false;
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
      })
      .addCase(saveAdDnsConfig.rejected, (state, action) => {
        state.saving = false;
        state.error = action.payload ?? "Impossible d'enregistrer la configuration DNS AD.";
      })
      .addCase(disableAdDns.pending, (state) => {
        state.clearing = true;
      })
      .addCase(disableAdDns.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = null;
        state.lastSync = null;
      })
      .addCase(disableAdDns.rejected, (state, action) => {
        state.clearing = false;
        state.error = action.payload ?? "Impossible de désactiver la synchronisation DNS AD.";
      })
      .addCase(testAdDnsConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testAdDnsConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testAdDnsConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = { ok: false, message: action.payload ?? "Impossible de tester la configuration DNS AD." };
      });
  },
});

export const { clearAdDnsTestResult } = adDnsSlice.actions;
export default adDnsSlice.reducer;
