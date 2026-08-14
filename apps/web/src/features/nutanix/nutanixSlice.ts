import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiPost, ApiError } from "@/api/client";

/**
 * Actions de cycle de vie + migration hôte-à-hôte d'une VM Nutanix (voir apps/api/src/routes/
 * nutanix.ts et services/nutanix.ts) — mission "il manque suprimer redemarer creer toute
 * interface et la logique". Même style que containersSlice.ts#runContainerAction/LifecycleAction :
 * un thunk générique pour start/stop/restart (même forme de réponse `{ ok, vmName }`), un thunk
 * dédié pour la suppression (DELETE, forme de réponse identique) et un pour la migration (POST
 * avec `targetHostUuid`, réponse enrichie de `targetHostName`).
 *
 * Erreurs : jamais de `pushNotification` manuel ici — tout thunk "nutanix/*" rejeté est
 * automatiquement transformé en toast d'erreur par errorNotificationMiddleware.ts (filet de
 * sécurité générique déjà en place pour toute l'app, voir ce fichier), à condition de
 * `rejectWithValue(message)` avec un message exploitable, comme tous les thunks existants du
 * dépôt (containersSlice.ts#runContainerAction, backupsSlice.ts...).
 */
export type NutanixVmLifecycleAction = "start" | "stop" | "restart";

interface NutanixVmActionResponse {
  ok: true;
  vmName: string;
}

interface NutanixVmMigrateResponse extends NutanixVmActionResponse {
  targetHostName: string;
}

interface NutanixState {
  /** uuid de la VM ayant une action de cycle de vie/suppression/migration en cours (désactive ses
   * boutons/le glisser-déposer) — un seul à la fois, même principe que ContainersState#actionPendingId. */
  actionPendingUuid: string | null;
}

const initialState: NutanixState = { actionPendingUuid: null };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** start/stop/restart — voir POST /api/nutanix/vms/:uuid/{start,stop,restart}. */
export const runNutanixVmAction = createAsyncThunk<
  { uuid: string; action: NutanixVmLifecycleAction; vmName: string },
  { uuid: string; action: NutanixVmLifecycleAction },
  { rejectValue: string }
>("nutanix/runVmAction", async ({ uuid, action }, { rejectWithValue }) => {
  try {
    const result = await apiPost<NutanixVmActionResponse>(`/nutanix/vms/${uuid}/${action}`);
    return { uuid, action, vmName: result.vmName };
  } catch (error) {
    return rejectWithValue(errorMessage(error, `Échec de l'action "${action}" sur la VM.`));
  }
});

/** Suppression définitive — voir DELETE /api/nutanix/vms/:uuid (409 si la VM est allumée, garde-fou
 * serveur — voir services/nutanix.ts#deleteNutanixVm). Appelé UNIQUEMENT après la confirmation
 * lourde "taper le nom de la VM" côté TopologyNodeDetailPanel.tsx, jamais directement au clic. */
export const deleteNutanixVm = createAsyncThunk<{ uuid: string; vmName: string }, { uuid: string }, { rejectValue: string }>(
  "nutanix/deleteVm",
  async ({ uuid }, { rejectWithValue }) => {
    try {
      const result = await apiDelete<NutanixVmActionResponse>(`/nutanix/vms/${uuid}`);
      return { uuid, vmName: result.vmName };
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Échec de la suppression de la VM."));
    }
  },
);

/** Migration live vers un autre hôte du même cluster — voir POST /api/nutanix/vms/:uuid/migrate
 * (409 si hôte cible = hôte actuel ou cluster différent, voir services/nutanix.ts#
 * migrateNutanixVm). Appelé par le glisser-déposer d'une VM sur un nœud hôte (TopologyGraph.tsx),
 * APRÈS confirmation explicite — jamais déclenché par un drag accidentel sans confirmation. */
export const migrateNutanixVm = createAsyncThunk<
  { uuid: string; vmName: string; targetHostName: string },
  { uuid: string; targetHostUuid: string },
  { rejectValue: string }
>("nutanix/migrateVm", async ({ uuid, targetHostUuid }, { rejectWithValue }) => {
  try {
    const result = await apiPost<NutanixVmMigrateResponse>(`/nutanix/vms/${uuid}/migrate`, { targetHostUuid });
    return { uuid, vmName: result.vmName, targetHostName: result.targetHostName };
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Échec de la migration de la VM."));
  }
});

const nutanixSlice = createSlice({
  name: "nutanix",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(runNutanixVmAction.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(runNutanixVmAction.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(runNutanixVmAction.rejected, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(deleteNutanixVm.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(deleteNutanixVm.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(deleteNutanixVm.rejected, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(migrateNutanixVm.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(migrateNutanixVm.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(migrateNutanixVm.rejected, (state) => {
        state.actionPendingUuid = null;
      });
  },
});

export default nutanixSlice.reducer;
