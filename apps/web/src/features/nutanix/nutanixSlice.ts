import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { NutanixSubnetSummary } from "@/types";

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
  /** Subnets réels (GET /api/nutanix/subnets) — pour le sélecteur "Ajouter une carte réseau". */
  subnets: NutanixSubnetSummary[];
}

const initialState: NutanixState = { actionPendingUuid: null, subnets: [] };

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

/** Subnets réels pour le sélecteur "Ajouter une carte réseau" — voir GET /api/nutanix/subnets. */
export const fetchNutanixSubnets = createAsyncThunk<NutanixSubnetSummary[], void, { rejectValue: string }>(
  "nutanix/fetchSubnets",
  async (_arg, { rejectWithValue }) => {
    try {
      return await apiGet<NutanixSubnetSummary[]>("/nutanix/subnets");
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Échec du chargement des subnets Nutanix."));
    }
  },
);

/** Ajout d'un disque SCSI — voir POST /api/nutanix/vms/:uuid/disks (services/nutanix.ts#
 * addNutanixVmDisk : storage container recopié d'un disque existant de la VM). Appelé UNIQUEMENT
 * après confirmation explicite côté popover (TopologyGraph.tsx). */
export const addNutanixVmDisk = createAsyncThunk<
  { uuid: string; vmName: string; sizeMib: number },
  { uuid: string; sizeMib: number },
  { rejectValue: string }
>("nutanix/addVmDisk", async ({ uuid, sizeMib }, { rejectWithValue }) => {
  try {
    const result = await apiPost<NutanixVmActionResponse & { sizeMib: number }>(`/nutanix/vms/${uuid}/disks`, { sizeMib });
    return { uuid, vmName: result.vmName, sizeMib: result.sizeMib };
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Échec de l'ajout du disque."));
  }
});

/** Ajout d'une carte réseau — voir POST /api/nutanix/vms/:uuid/nics (subnet vérifié serveur). */
export const addNutanixVmNic = createAsyncThunk<
  { uuid: string; vmName: string; subnetName: string },
  { uuid: string; subnetUuid: string },
  { rejectValue: string }
>("nutanix/addVmNic", async ({ uuid, subnetUuid }, { rejectWithValue }) => {
  try {
    const result = await apiPost<NutanixVmActionResponse & { subnetName: string }>(`/nutanix/vms/${uuid}/nics`, { subnetUuid });
    return { uuid, vmName: result.vmName, subnetName: result.subnetName };
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Échec de l'ajout de la carte réseau."));
  }
});

/** vCPU/cœurs par vCPU/mémoire — voir PATCH /api/nutanix/vms/:uuid/compute. Un refus à-chaud de
 * Prism Central (VM allumée) remonte tel quel en toast via errorNotificationMiddleware. */
export const updateNutanixVmCompute = createAsyncThunk<
  { uuid: string; vmName: string },
  { uuid: string; numVcpus?: number; numCoresPerVcpu?: number; memoryMib?: number },
  { rejectValue: string }
>("nutanix/updateVmCompute", async ({ uuid, ...fields }, { rejectWithValue }) => {
  try {
    const result = await apiPatch<NutanixVmActionResponse>(`/nutanix/vms/${uuid}/compute`, fields);
    return { uuid, vmName: result.vmName };
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Échec de la mise à jour vCPU/mémoire."));
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
      })
      .addCase(fetchNutanixSubnets.fulfilled, (state, action) => {
        state.subnets = action.payload;
      })
      // Même verrou actionPendingUuid pour les 3 mutations matérielles que pour le cycle de vie.
      .addCase(addNutanixVmDisk.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(addNutanixVmDisk.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(addNutanixVmDisk.rejected, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(addNutanixVmNic.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(addNutanixVmNic.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(addNutanixVmNic.rejected, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(updateNutanixVmCompute.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(updateNutanixVmCompute.fulfilled, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(updateNutanixVmCompute.rejected, (state) => {
        state.actionPendingUuid = null;
      });
  },
});

export default nutanixSlice.reducer;
