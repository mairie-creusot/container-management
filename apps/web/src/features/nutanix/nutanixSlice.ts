import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, apiUrl, ApiError } from "@/api/client";
import type { NutanixImageSummary, NutanixSubnetSummary } from "@/types";

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

/**
 * Statistiques temps réel + alertes (GET /api/nutanix/cluster-stats, /api/nutanix/alerts).
 * Types déclarés ICI plutôt que dans @/types : ce sont des formes propres à l'intégration Nutanix,
 * miroir exact de celles exportées par apps/api/src/services/nutanix.ts (un module apps/api n'est
 * pas importable depuis apps/web — même duplication assumée que partout ailleurs dans le dépôt).
 *
 * UNITÉS explicites dans les noms de champs, jamais un nombre nu : les latences Nutanix sont en
 * MICROsecondes (`...Usec`) et les débits en kilo-octets/s (`...KbytesPerSec`, unité SOURCE de
 * l'API — jamais convertie en octets/s sur une hypothèse). Un champ ABSENT = métrique réellement
 * non communiquée par Prism (sentinelle "-1" côté API), jamais un 0 de remplissage.
 */
export interface NutanixIoStats {
  readIops?: number;
  writeIops?: number;
  totalIops?: number;
  avgLatencyUsec?: number;
  avgReadLatencyUsec?: number;
  avgWriteLatencyUsec?: number;
  readThroughputKbytesPerSec?: number;
  writeThroughputKbytesPerSec?: number;
  totalThroughputKbytesPerSec?: number;
}

export interface NutanixStorageUsage {
  capacityBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  logicalUsedBytes?: number;
}

export interface NutanixStorageContainerStats {
  uuid: string;
  name: string;
  storage: NutanixStorageUsage;
}

export interface NutanixHostStats {
  uuid: string;
  name: string;
  state?: string;
  numVms?: number;
  inMaintenanceMode?: boolean;
  degraded?: boolean;
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  cpuCapacityHz?: number;
  numCpuCores?: number;
  memoryCapacityBytes?: number;
  controllerIo: NutanixIoStats;
  storage: NutanixStorageUsage;
}

export interface NutanixClusterHealth {
  currentFaultTolerance?: number;
  desiredFaultTolerance?: number;
  currentRedundancyFactor?: number;
  desiredRedundancyFactor?: number;
  hostsTotal: number;
  hostsNormal: number;
}

export interface NutanixClusterStats {
  uuid: string;
  name: string;
  version?: string;
  numNodes?: number;
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  cpuCapacityHz?: number;
  memoryCapacityBytes?: number;
  controllerIo: NutanixIoStats;
  clusterIo: NutanixIoStats;
  storage: NutanixStorageUsage;
  storageContainers: NutanixStorageContainerStats[];
  health: NutanixClusterHealth;
  hosts: NutanixHostStats[];
}

export interface NutanixPollOutcome {
  reachable: boolean;
  at: string;
}

export interface NutanixClusterStatsResponse {
  configured: boolean;
  reachable: boolean;
  clusters: NutanixClusterStats[];
  lastPoll: NutanixPollOutcome | null;
}

export type NutanixAlertSeverity = "critical" | "warning" | "info" | "audit" | "unknown";

export interface NutanixAlert {
  id: string;
  severity: NutanixAlertSeverity;
  severityRaw: string;
  title: string;
  message: string;
  acknowledged: boolean;
  createdAt?: string;
  lastOccurredAt?: string;
  entityType?: string;
  entityName?: string;
  entityUuid?: string;
  clusterUuid?: string;
}

export interface NutanixAlertsResponse {
  configured: boolean;
  reachable: boolean;
  alerts: NutanixAlert[];
  totalUnresolved?: number;
  lastPoll: NutanixPollOutcome | null;
}

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
  /** uuid de la VM en cours de SUPPRESSION (contour rouge pulsé sur sa carte, quelle que soit
   * l'origine de l'action : graphe ou panneau de détail). */
  deletePendingUuid: string | null;
  /** Convergence attendue par uuid après un start/stop réussi (stop ACPI = l'OS invité met du
   * temps à s'éteindre) : la carte du graphe reste en "pending" tant que le poll de topologie ne
   * constate pas cet état réel — purgé par TopologyGraph une fois convergé ou expiré. */
  convergence: Record<string, { expected: "running" | "stopped"; since: number }>;
  /** Subnets réels (GET /api/nutanix/subnets) — pour le sélecteur "Ajouter une carte réseau". */
  subnets: NutanixSubnetSummary[];
  /** Images réelles du catalogue Prism (GET /api/nutanix/images) — pour "Déployer en VM" depuis un
   * template. "unavailable" = 404 (backend pas encore là), distinct d'un catalogue vide légitime. */
  images: NutanixImageSummary[];
  imagesStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  /** Dernière réponse RÉELLE de /nutanix/cluster-stats — conservée entre deux polls pour que le
   * panneau ne clignote pas ; `null` tant que rien n'a jamais été chargé (état "pas encore
   * chargé", distinct de "non configuré"/"injoignable" que porte la réponse elle-même). */
  clusterStats: NutanixClusterStatsResponse | null;
  clusterStatsStatus: "idle" | "loading" | "ready" | "error";
  alerts: NutanixAlertsResponse | null;
  alertsStatus: "idle" | "loading" | "ready" | "error";
}

const initialState: NutanixState = {
  actionPendingUuid: null,
  deletePendingUuid: null,
  convergence: {},
  subnets: [],
  images: [],
  imagesStatus: "idle",
  clusterStats: null,
  clusterStatsStatus: "idle",
  alerts: null,
  alertsStatus: "idle",
};

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

type FetchNutanixImagesResult =
  | { outcome: "ok"; items: NutanixImageSummary[] }
  | { outcome: "unavailable" }
  | { outcome: "error" };

/** Images du catalogue Prism pour "Déployer en VM" — jamais rejeté (un 404 signifie que la route
 * backend n'existe pas encore : état vide explicite côté modale, pas un toast d'erreur). */
export const fetchNutanixImages = createAsyncThunk<FetchNutanixImagesResult, void>("nutanix/fetchImages", async () => {
  try {
    const items = await apiGet<NutanixImageSummary[]>("/nutanix/images");
    return { outcome: "ok", items };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { outcome: "unavailable" };
    return { outcome: "error" };
  }
});

/** Upload d'un ISO local vers le catalogue Prism — POST /api/nutanix/images/upload (multipart,
 * champs `file` + `name`). XMLHttpRequest plutôt que le client fetch JSON : seule API donnant la
 * progression d'ENVOI réelle (xhr.upload.onprogress), cookie de session via withCredentials.
 * Résout `{ uuid }` si le serveur le renvoie (uuid/imageUuid), `{}` sinon — l'appelant re-fetch le
 * catalogue et retrouve l'image par nom. Rejette une ApiError (404 = backend pas encore là). */
export function uploadNutanixImage(file: File, name: string, onProgress: (percent: number) => void): Promise<{ uuid?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/nutanix/images/upload"));
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Échec réseau pendant l'envoi de l'ISO."));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as Record<string, unknown>;
      if (xhr.status >= 200 && xhr.status < 300) {
        const uuid = typeof body["uuid"] === "string" ? body["uuid"] : typeof body["imageUuid"] === "string" ? body["imageUuid"] : undefined;
        resolve(uuid === undefined ? {} : { uuid });
        return;
      }
      const message = typeof body["error"] === "string" ? body["error"] : `Erreur ${xhr.status} sur /nutanix/images/upload`;
      reject(new ApiError(xhr.status, message));
    };
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    xhr.send(form);
  });
}

/** Statistiques temps réel du/des clusters — pollé UNIQUEMENT tant que le panneau de détail d'un
 * nœud Nutanix est ouvert (voir TopologyNodeDetailPanel.tsx), jamais en tâche de fond permanente.
 * JAMAIS rejeté : un accroc réseau à chaque tour de poll ne doit pas déclencher un toast d'erreur
 * via errorNotificationMiddleware (même choix que fetchNutanixImages) — l'échec se lit dans
 * `clusterStatsStatus`/`reachable`, affiché explicitement dans le panneau. */
export const fetchNutanixClusterStats = createAsyncThunk<NutanixClusterStatsResponse | null, void>(
  "nutanix/fetchClusterStats",
  async () => {
    try {
      return await apiGet<NutanixClusterStatsResponse>("/nutanix/cluster-stats");
    } catch {
      return null;
    }
  },
);

/** Alertes non résolues les plus récentes — même politique de poll et de non-rejet que ci-dessus. */
export const fetchNutanixAlerts = createAsyncThunk<NutanixAlertsResponse | null, { limit?: number } | void>(
  "nutanix/fetchAlerts",
  async (arg) => {
    const limit = arg && typeof arg === "object" ? arg.limit : undefined;
    try {
      return await apiGet<NutanixAlertsResponse>(`/nutanix/alerts${limit !== undefined ? `?limit=${limit}` : ""}`);
    } catch {
      return null;
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
  reducers: {
    clearNutanixVmConvergence(state, action: PayloadAction<string>) {
      delete state.convergence[action.payload];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(runNutanixVmAction.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
      })
      .addCase(runNutanixVmAction.fulfilled, (state, action) => {
        state.actionPendingUuid = null;
        // restart : power_state reste ON pendant l'ACPI reboot, aucune convergence observable.
        if (action.payload.action === "start") state.convergence[action.payload.uuid] = { expected: "running", since: Date.now() };
        if (action.payload.action === "stop") state.convergence[action.payload.uuid] = { expected: "stopped", since: Date.now() };
      })
      .addCase(runNutanixVmAction.rejected, (state) => {
        state.actionPendingUuid = null;
      })
      .addCase(deleteNutanixVm.pending, (state, action) => {
        state.actionPendingUuid = action.meta.arg.uuid;
        state.deletePendingUuid = action.meta.arg.uuid;
      })
      .addCase(deleteNutanixVm.fulfilled, (state) => {
        state.actionPendingUuid = null;
        state.deletePendingUuid = null;
      })
      .addCase(deleteNutanixVm.rejected, (state) => {
        state.actionPendingUuid = null;
        state.deletePendingUuid = null;
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
      .addCase(fetchNutanixImages.pending, (state) => {
        if (state.imagesStatus === "idle") state.imagesStatus = "loading";
      })
      .addCase(fetchNutanixImages.fulfilled, (state, action) => {
        if (action.payload.outcome === "ok") {
          state.imagesStatus = "ready";
          state.images = action.payload.items;
        } else if (action.payload.outcome === "unavailable") {
          state.imagesStatus = "unavailable";
          state.images = [];
        } else {
          state.imagesStatus = "error";
        }
      })
      // "loading" seulement au TOUT PREMIER chargement : les polls suivants gardent la dernière
      // valeur réelle affichée plutôt que de vider le panneau à chaque tour.
      .addCase(fetchNutanixClusterStats.pending, (state) => {
        if (state.clusterStatsStatus === "idle") state.clusterStatsStatus = "loading";
      })
      .addCase(fetchNutanixClusterStats.fulfilled, (state, action) => {
        if (action.payload === null) {
          state.clusterStatsStatus = "error";
          return;
        }
        state.clusterStatsStatus = "ready";
        state.clusterStats = action.payload;
      })
      .addCase(fetchNutanixAlerts.pending, (state) => {
        if (state.alertsStatus === "idle") state.alertsStatus = "loading";
      })
      .addCase(fetchNutanixAlerts.fulfilled, (state, action) => {
        if (action.payload === null) {
          state.alertsStatus = "error";
          return;
        }
        state.alertsStatus = "ready";
        state.alerts = action.payload;
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

export const { clearNutanixVmConvergence } = nutanixSlice.actions;
export default nutanixSlice.reducer;
