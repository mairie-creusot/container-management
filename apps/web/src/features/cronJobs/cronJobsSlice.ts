import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { CronJobDefinition, CronJobRun } from "@/types";

/** Corps commun POST/PATCH — voir apps/api/src/routes/cronJobs.ts. `enabled` optionnel côté PATCH
 * (peut ne toucher qu'à un autre champ sans changer l'activation), toujours présent côté création
 * (CronJobsPage.tsx envoie explicitement la case à cocher du formulaire). */
export interface CronJobFormInput {
  name: string;
  containerId: string;
  containerName: string;
  command: string;
  schedule: string;
  enabled?: boolean;
}

interface CronJobsState {
  items: CronJobDefinition[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  updatingId: string | null;
  deletingId: string | null;
  triggeringId: string | null;
  triggerError: string | null;
  /** Historique d'exécution du job actuellement consulté — un seul à la fois (voir
   * CronJobsPage.tsx#selectedJobId), même principe que ContainersState#processes. */
  runs: CronJobRun[];
  runsJobId: string | null;
  runsStatus: "idle" | "loading" | "ready" | "error";
}

const initialState: CronJobsState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  updatingId: null,
  deletingId: null,
  triggeringId: null,
  triggerError: null,
  runs: [],
  runsJobId: null,
  runsStatus: "idle",
};

export const fetchCronJobs = createAsyncThunk<CronJobDefinition[]>("cronJobs/fetch", async () =>
  apiGet<CronJobDefinition[]>("/cron-jobs"),
);

export const createCronJob = createAsyncThunk<CronJobDefinition, CronJobFormInput, { rejectValue: string }>(
  "cronJobs/create",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<CronJobDefinition>("/cron-jobs", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de créer ce cron job.";
      return rejectWithValue(message);
    }
  },
);

export const updateCronJob = createAsyncThunk<
  CronJobDefinition,
  { id: string; patch: Partial<CronJobFormInput> },
  { rejectValue: string }
>("cronJobs/update", async ({ id, patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<CronJobDefinition>(`/cron-jobs/${id}`, patch);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de modifier ce cron job.";
    return rejectWithValue(message);
  }
});

export const deleteCronJob = createAsyncThunk<string, string, { rejectValue: string }>(
  "cronJobs/delete",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/cron-jobs/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer ce cron job.";
      return rejectWithValue(message);
    }
  },
);

export const fetchCronJobRuns = createAsyncThunk<{ jobId: string; runs: CronJobRun[] }, string>(
  "cronJobs/fetchRuns",
  async (jobId) => ({ jobId, runs: await apiGet<CronJobRun[]>(`/cron-jobs/${jobId}/runs`) }),
);

/** Déclenchement manuel — voir POST /api/cron-jobs/:id/trigger (operator/admin côté API). Refusé
 * avec un 409 si un run de ce job est déjà en cours (garde anti-chevauchement, même pour un
 * déclenchement manuel — voir cronJobsScheduler.ts#triggerCronJobRun). */
export const triggerCronJob = createAsyncThunk<{ jobId: string; run: CronJobRun }, string, { rejectValue: string }>(
  "cronJobs/trigger",
  async (jobId, { rejectWithValue }) => {
    try {
      const run = await apiPost<CronJobRun>(`/cron-jobs/${jobId}/trigger`);
      return { jobId, run };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de déclencher ce cron job.";
      return rejectWithValue(message);
    }
  },
);

const cronJobsSlice = createSlice({
  name: "cronJobs",
  initialState,
  reducers: {
    clearCronJobTriggerError(state) {
      state.triggerError = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCronJobs.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchCronJobs.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchCronJobs.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les cron jobs.";
      })
      .addCase(createCronJob.pending, (state) => {
        state.creating = true;
        state.error = null;
      })
      .addCase(createCronJob.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createCronJob.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer ce cron job.";
      })
      .addCase(updateCronJob.pending, (state, action) => {
        state.updatingId = action.meta.arg.id;
        state.error = null;
      })
      .addCase(updateCronJob.fulfilled, (state, action) => {
        state.updatingId = null;
        const index = state.items.findIndex((j) => j.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(updateCronJob.rejected, (state, action) => {
        state.updatingId = null;
        state.error = action.payload ?? "Impossible de modifier ce cron job.";
      })
      .addCase(deleteCronJob.pending, (state, action) => {
        state.deletingId = action.meta.arg;
      })
      .addCase(deleteCronJob.fulfilled, (state, action) => {
        state.deletingId = null;
        state.items = state.items.filter((j) => j.id !== action.payload);
        if (state.runsJobId === action.payload) {
          state.runs = [];
          state.runsJobId = null;
        }
      })
      .addCase(deleteCronJob.rejected, (state, action) => {
        state.deletingId = null;
        state.error = action.payload ?? "Impossible de supprimer ce cron job.";
      })
      .addCase(fetchCronJobRuns.pending, (state, action) => {
        state.runsStatus = "loading";
        state.runsJobId = action.meta.arg;
      })
      .addCase(fetchCronJobRuns.fulfilled, (state, action) => {
        // Une réponse en retard pour un job qu'on ne consulte déjà plus ne doit pas écraser
        // l'historique du job actuellement affiché (même garde que ContainersSlice#processes).
        if (state.runsJobId !== action.payload.jobId) return;
        state.runsStatus = "ready";
        state.runs = action.payload.runs;
      })
      .addCase(fetchCronJobRuns.rejected, (state) => {
        state.runsStatus = "error";
      })
      .addCase(triggerCronJob.pending, (state, action) => {
        state.triggeringId = action.meta.arg;
        state.triggerError = null;
      })
      .addCase(triggerCronJob.fulfilled, (state, action) => {
        state.triggeringId = null;
        // Le nouveau run apparaît immédiatement dans l'historique si c'est celui déjà consulté,
        // sans attendre le prochain poll (voir CronJobsPage.tsx).
        if (state.runsJobId === action.payload.jobId) {
          state.runs = [action.payload.run, ...state.runs];
        }
      })
      .addCase(triggerCronJob.rejected, (state, action) => {
        state.triggeringId = null;
        state.triggerError = action.payload ?? "Impossible de déclencher ce cron job.";
      });
  },
});

export const { clearCronJobTriggerError } = cronJobsSlice.actions;
export default cronJobsSlice.reducer;
