import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { BackupDefinition, BackupRestoreResult, BackupRun, BackupTarget } from "@/types";

/** Corps commun POST/PATCH — voir apps/api/src/routes/backups.ts. `destination` reprend le même
 * principe write-only que NotificationChannelFormInput : accessKey/secretKey omis dans un PATCH =
 * identifiants conservés, `clearCredentials` explicite pour les effacer (repasse en accès
 * anonyme) — jamais renvoyés une fois enregistrés, voir BackupDestinationRef côté @/types. */
export interface BackupDefinitionFormInput {
  name: string;
  target: BackupTarget;
  destination: {
    endpoint: string;
    region?: string;
    bucket: string;
    forcePathStyle?: boolean;
    accessKey?: string;
    secretKey?: string;
  };
  clearCredentials?: boolean;
  schedule: string;
  retentionCount: number;
  enabled?: boolean;
}

interface BackupsState {
  items: BackupDefinition[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  updatingId: string | null;
  deletingId: string | null;
  /** Définition dont une sauvegarde manuelle vient d'être déclenchée (POST /:id/run, 202) — le run
   * "running" retourné est déjà injecté dans runsByDefinitionId, ce drapeau ne pilote que l'état
   * disabled du bouton "Sauvegarder maintenant" le temps de l'aller-retour HTTP. */
  runningId: string | null;
  /** Run dont la restauration est en cours (POST /:id/restore/:runId, bloquant côté API — voir
   * backupScheduler.ts#restoreBackup) — pilote l'état disabled du bouton "Restaurer" concerné. */
  restoringRunId: string | null;
  runsByDefinitionId: Record<string, BackupRun[]>;
  runsStatusByDefinitionId: Record<string, "idle" | "loading" | "ready" | "error">;
  restoreResultByDefinitionId: Record<string, BackupRestoreResult | undefined>;
}

const initialState: BackupsState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  updatingId: null,
  deletingId: null,
  runningId: null,
  restoringRunId: null,
  runsByDefinitionId: {},
  runsStatusByDefinitionId: {},
  restoreResultByDefinitionId: {},
};

export const fetchBackupDefinitions = createAsyncThunk<BackupDefinition[]>("backups/fetch", async () =>
  apiGet<BackupDefinition[]>("/backups"),
);

export const createBackupDefinition = createAsyncThunk<
  BackupDefinition,
  BackupDefinitionFormInput,
  { rejectValue: string }
>("backups/create", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<BackupDefinition>("/backups", input);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de créer cette définition de sauvegarde.";
    return rejectWithValue(message);
  }
});

export const updateBackupDefinition = createAsyncThunk<
  BackupDefinition,
  { id: string; patch: Partial<BackupDefinitionFormInput> },
  { rejectValue: string }
>("backups/update", async ({ id, patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<BackupDefinition>(`/backups/${id}`, patch);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de modifier cette définition de sauvegarde.";
    return rejectWithValue(message);
  }
});

export const deleteBackupDefinition = createAsyncThunk<string, string, { rejectValue: string }>(
  "backups/delete",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/backups/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer cette définition de sauvegarde.";
      return rejectWithValue(message);
    }
  },
);

export const fetchBackupRuns = createAsyncThunk<{ definitionId: string; runs: BackupRun[] }, string>(
  "backups/fetchRuns",
  async (definitionId) => ({ definitionId, runs: await apiGet<BackupRun[]>(`/backups/${definitionId}/runs`) }),
);

/** Déclenchement manuel — POST /api/backups/:id/run répond 202 avec le run à l'état "running"
 * immédiatement, la sauvegarde continue en arrière-plan côté API (voir backupScheduler.ts). */
export const runBackupNow = createAsyncThunk<
  { definitionId: string; run: BackupRun },
  string,
  { rejectValue: string }
>("backups/runNow", async (definitionId, { rejectWithValue }) => {
  try {
    const run = await apiPost<BackupRun>(`/backups/${definitionId}/run`);
    return { definitionId, run };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de déclencher cette sauvegarde.";
    return rejectWithValue(message);
  }
});

/** Restauration RÉELLE et destructive — POST /api/backups/:id/restore/:runId, bloquant jusqu'au
 * résultat définitif (voir backupScheduler.ts#restoreBackup). La confirmation forte vit côté
 * BackupsPage.tsx (useConfirm, variant "danger"), jamais ici. */
export const restoreBackup = createAsyncThunk<
  { definitionId: string; result: BackupRestoreResult },
  { definitionId: string; runId: string },
  { rejectValue: string }
>("backups/restore", async ({ definitionId, runId }, { rejectWithValue }) => {
  try {
    const result = await apiPost<BackupRestoreResult>(`/backups/${definitionId}/restore/${runId}`);
    return { definitionId, result };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la restauration.";
    return rejectWithValue(message);
  }
});

const backupsSlice = createSlice({
  name: "backups",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchBackupDefinitions.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchBackupDefinitions.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchBackupDefinitions.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les définitions de sauvegarde.";
      })
      .addCase(createBackupDefinition.pending, (state) => {
        state.creating = true;
        state.error = null;
      })
      .addCase(createBackupDefinition.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createBackupDefinition.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer cette définition de sauvegarde.";
      })
      .addCase(updateBackupDefinition.pending, (state, action) => {
        state.updatingId = action.meta.arg.id;
        state.error = null;
      })
      .addCase(updateBackupDefinition.fulfilled, (state, action) => {
        state.updatingId = null;
        const index = state.items.findIndex((d) => d.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(updateBackupDefinition.rejected, (state, action) => {
        state.updatingId = null;
        state.error = action.payload ?? "Impossible de modifier cette définition de sauvegarde.";
      })
      .addCase(deleteBackupDefinition.pending, (state, action) => {
        state.deletingId = action.meta.arg;
      })
      .addCase(deleteBackupDefinition.fulfilled, (state, action) => {
        state.deletingId = null;
        state.items = state.items.filter((d) => d.id !== action.payload);
        delete state.runsByDefinitionId[action.payload];
        delete state.runsStatusByDefinitionId[action.payload];
        delete state.restoreResultByDefinitionId[action.payload];
      })
      .addCase(deleteBackupDefinition.rejected, (state, action) => {
        state.deletingId = null;
        state.error = action.payload ?? "Impossible de supprimer cette définition de sauvegarde.";
      })
      .addCase(fetchBackupRuns.pending, (state, action) => {
        state.runsStatusByDefinitionId[action.meta.arg] = "loading";
      })
      .addCase(fetchBackupRuns.fulfilled, (state, action) => {
        state.runsStatusByDefinitionId[action.payload.definitionId] = "ready";
        state.runsByDefinitionId[action.payload.definitionId] = action.payload.runs;
      })
      .addCase(fetchBackupRuns.rejected, (state, action) => {
        state.runsStatusByDefinitionId[action.meta.arg] = "error";
      })
      .addCase(runBackupNow.pending, (state, action) => {
        state.runningId = action.meta.arg;
        state.error = null;
      })
      .addCase(runBackupNow.fulfilled, (state, action) => {
        state.runningId = null;
        const existing = state.runsByDefinitionId[action.payload.definitionId] ?? [];
        state.runsByDefinitionId[action.payload.definitionId] = [action.payload.run, ...existing];
      })
      .addCase(runBackupNow.rejected, (state, action) => {
        state.runningId = null;
        state.error = action.payload ?? "Impossible de déclencher cette sauvegarde.";
      })
      .addCase(restoreBackup.pending, (state, action) => {
        state.restoringRunId = action.meta.arg.runId;
        state.error = null;
      })
      .addCase(restoreBackup.fulfilled, (state, action) => {
        state.restoringRunId = null;
        state.restoreResultByDefinitionId[action.payload.definitionId] = action.payload.result;
      })
      .addCase(restoreBackup.rejected, (state, action) => {
        state.restoringRunId = null;
        state.error = action.payload ?? "Échec de la restauration.";
      });
  },
});

export default backupsSlice.reducer;
