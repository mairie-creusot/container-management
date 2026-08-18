import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import type {
  HycuConfig,
  HycuConfigStatus,
  HycuEvent,
  HycuJob,
  HycuPolicy,
  HycuStatusSummary,
  HycuTarget,
  HycuTestResult,
  HycuVm,
} from "@/types";

/** Formulaire de configuration HYCU (routes/hycu.ts) — `password` vide = conserver l'existant,
 * même convention que NutanixConfigFormInput/AdDnsFormInput. */
export interface HycuConfigFormInput {
  url: string;
  username: string;
  password?: string;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface HycuState {
  summary: HycuStatusSummary | null;
  summaryStatus: LoadStatus;
  vms: HycuVm[];
  vmsStatus: LoadStatus;
  policies: HycuPolicy[];
  policiesStatus: LoadStatus;
  targets: HycuTarget[];
  targetsStatus: LoadStatus;
  jobs: HycuJob[];
  jobsStatus: LoadStatus;
  events: HycuEvent[];
  eventsStatus: LoadStatus;
  configured: boolean;
  config: HycuConfig | null;
  configStatus: LoadStatus;
  configSaving: boolean;
  configError: string | null;
  clearing: boolean;
  testing: boolean;
  testResult: HycuTestResult | null;
}

const initialState: HycuState = {
  summary: null,
  summaryStatus: "idle",
  vms: [],
  vmsStatus: "idle",
  policies: [],
  policiesStatus: "idle",
  targets: [],
  targetsStatus: "idle",
  jobs: [],
  jobsStatus: "idle",
  events: [],
  eventsStatus: "idle",
  configured: false,
  config: null,
  configStatus: "idle",
  configSaving: false,
  configError: null,
  clearing: false,
  testing: false,
  testResult: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export const fetchHycuStatus = createAsyncThunk<HycuStatusSummary>("hycu/fetchStatus", async () =>
  apiGet<HycuStatusSummary>("/hycu/status"),
);

export const fetchHycuVms = createAsyncThunk<HycuVm[]>("hycu/fetchVms", async () => apiGet<HycuVm[]>("/hycu/vms"));

export const fetchHycuPolicies = createAsyncThunk<HycuPolicy[]>("hycu/fetchPolicies", async () =>
  apiGet<HycuPolicy[]>("/hycu/policies"),
);

export const fetchHycuTargets = createAsyncThunk<HycuTarget[]>("hycu/fetchTargets", async () =>
  apiGet<HycuTarget[]>("/hycu/targets"),
);

export const fetchHycuJobs = createAsyncThunk<HycuJob[]>("hycu/fetchJobs", async () => apiGet<HycuJob[]>("/hycu/jobs"));

export const fetchHycuEvents = createAsyncThunk<HycuEvent[]>("hycu/fetchEvents", async () =>
  apiGet<HycuEvent[]>("/hycu/events"),
);

export const fetchHycuConfig = createAsyncThunk<HycuConfigStatus>("hycu/fetchConfig", async () =>
  apiGet<HycuConfigStatus>("/hycu/config"),
);

/** PUT /api/hycu/config — le serveur teste réellement la connexion avant de persister. */
export const saveHycuConfig = createAsyncThunk<HycuConfigStatus, HycuConfigFormInput, { rejectValue: string }>(
  "hycu/saveConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPut<HycuConfigStatus>("/hycu/config", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'enregistrer la configuration HYCU."));
    }
  },
);

/** POST /api/hycu/config/test — teste une config candidate SANS persister. */
export const testHycuConfig = createAsyncThunk<HycuTestResult, HycuConfigFormInput, { rejectValue: string }>(
  "hycu/testConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<HycuTestResult>("/hycu/config/test", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de tester la configuration HYCU."));
    }
  },
);

export const disableHycu = createAsyncThunk<void, void, { rejectValue: string }>(
  "hycu/disable",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/hycu/config");
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de retirer la configuration HYCU."));
    }
  },
);

const hycuSlice = createSlice({
  name: "hycu",
  initialState,
  reducers: {
    clearHycuTestResult(state) {
      state.testResult = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchHycuStatus.pending, (state) => {
        state.summaryStatus = "loading";
      })
      .addCase(fetchHycuStatus.fulfilled, (state, action) => {
        state.summaryStatus = "ready";
        state.summary = action.payload;
        state.configured = action.payload.configured;
      })
      .addCase(fetchHycuStatus.rejected, (state) => {
        state.summaryStatus = "error";
      })
      .addCase(fetchHycuVms.pending, (state) => {
        state.vmsStatus = "loading";
      })
      .addCase(fetchHycuVms.fulfilled, (state, action) => {
        state.vmsStatus = "ready";
        state.vms = action.payload;
      })
      .addCase(fetchHycuVms.rejected, (state) => {
        state.vmsStatus = "error";
      })
      .addCase(fetchHycuPolicies.pending, (state) => {
        state.policiesStatus = "loading";
      })
      .addCase(fetchHycuPolicies.fulfilled, (state, action) => {
        state.policiesStatus = "ready";
        state.policies = action.payload;
      })
      .addCase(fetchHycuPolicies.rejected, (state) => {
        state.policiesStatus = "error";
      })
      .addCase(fetchHycuTargets.pending, (state) => {
        state.targetsStatus = "loading";
      })
      .addCase(fetchHycuTargets.fulfilled, (state, action) => {
        state.targetsStatus = "ready";
        state.targets = action.payload;
      })
      .addCase(fetchHycuTargets.rejected, (state) => {
        state.targetsStatus = "error";
      })
      .addCase(fetchHycuJobs.pending, (state) => {
        state.jobsStatus = "loading";
      })
      .addCase(fetchHycuJobs.fulfilled, (state, action) => {
        state.jobsStatus = "ready";
        state.jobs = action.payload;
      })
      .addCase(fetchHycuJobs.rejected, (state) => {
        state.jobsStatus = "error";
      })
      .addCase(fetchHycuEvents.pending, (state) => {
        state.eventsStatus = "loading";
      })
      .addCase(fetchHycuEvents.fulfilled, (state, action) => {
        state.eventsStatus = "ready";
        state.events = action.payload;
      })
      .addCase(fetchHycuEvents.rejected, (state) => {
        state.eventsStatus = "error";
      })
      .addCase(fetchHycuConfig.pending, (state) => {
        state.configStatus = "loading";
      })
      .addCase(fetchHycuConfig.fulfilled, (state, action) => {
        state.configStatus = "ready";
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
      })
      .addCase(fetchHycuConfig.rejected, (state) => {
        state.configStatus = "error";
      })
      .addCase(saveHycuConfig.pending, (state) => {
        state.configSaving = true;
        state.configError = null;
      })
      .addCase(saveHycuConfig.fulfilled, (state, action) => {
        state.configSaving = false;
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
        // Les données affichées peuvent venir d'une ancienne config — forcer leur rechargement.
        state.summaryStatus = "idle";
        state.vmsStatus = "idle";
        state.policiesStatus = "idle";
        state.targetsStatus = "idle";
        state.jobsStatus = "idle";
        state.eventsStatus = "idle";
      })
      .addCase(saveHycuConfig.rejected, (state, action) => {
        state.configSaving = false;
        state.configError = action.payload ?? "Impossible d'enregistrer la configuration HYCU.";
      })
      .addCase(testHycuConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testHycuConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testHycuConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = { ok: false, message: action.payload ?? "Impossible de tester la configuration HYCU." };
      })
      .addCase(disableHycu.pending, (state) => {
        state.clearing = true;
      })
      .addCase(disableHycu.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = null;
        state.summary = { configured: false };
        state.vms = [];
        state.policies = [];
        state.targets = [];
        state.jobs = [];
        state.events = [];
        state.vmsStatus = "idle";
        state.policiesStatus = "idle";
        state.targetsStatus = "idle";
        state.jobsStatus = "idle";
        state.eventsStatus = "idle";
      })
      .addCase(disableHycu.rejected, (state, action) => {
        state.clearing = false;
        state.configError = action.payload ?? "Impossible de retirer la configuration HYCU.";
      });
  },
});

export const { clearHycuTestResult } = hycuSlice.actions;
export default hycuSlice.reducer;
