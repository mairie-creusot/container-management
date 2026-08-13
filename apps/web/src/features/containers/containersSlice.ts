import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { ContainerDetail, ContainerProcessDetailList, ContainerProcessList, ContainerRef } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

/** Référence par nom vers un secret défini dans le gestionnaire de secrets (features/secrets) —
 * résolue côté serveur uniquement (voir POST /api/containers, routes/containers.ts) : la
 * valeur réelle ne transite jamais par ce payload. */
export interface SecretEnvEntry {
  key: string;
  secretName: string;
}

export interface CreateContainerInput {
  image: string;
  name?: string;
  ports?: string[];
  env?: string[];
  secretEnv?: SecretEnvEntry[];
  volumes?: string[];
  network?: string;
  // Limites de ressources optionnelles (HostConfig.Memory/NanoCpus côté API) — absentes = pas de
  // limite, comportement Docker natif inchangé. Voir ContainersPage.tsx pour la conversion
  // Mo/Go -> octets et cœurs -> NanoCpus faite côté formulaire.
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

export type LifecycleAction = "start" | "stop" | "restart" | "remove";

interface ContainersState {
  items: ContainerRef[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedId: string | null;
  createStatus: "idle" | "creating" | "error";
  createError: string | null;
  detail: ContainerDetail | null;
  detailStatus: "idle" | "loading" | "ready" | "error";
  /** Id du conteneur ayant une action de cycle de vie en cours (désactive ses boutons). */
  actionPendingId: string | null;
  actionError: string | null;
  /** Processus réels (`docker top`) du conteneur consulté dans la vue "composition interne" du
   * sous-graphe (voir TopologySubGraphPanel.tsx) — un seul à la fois, `processesContainerId`
   * évite d'afficher la liste d'un AUTRE conteneur pendant le chargement du nouveau (même garde
   * que `detail`/`rawId` dans TopologyNodeDetailPanel.tsx). */
  processes: ContainerProcessList | null;
  processesContainerId: string | null;
  processesStatus: "idle" | "loading" | "ready" | "error";
  processesError: string | null;
  /** Détail enrichi des processus (voir ContainerProcessDetailList) affiché dans le panneau
   * unifié "Composition interne" du sous-graphe (TopologySubGraphPanel.tsx) — remplace le
   * panneau `docker top` ci-dessus DANS CETTE VUE PRÉCISE uniquement (processes/processesStatus
   * ci-dessus restent inchangés, potentiellement utilisés ailleurs). Rafraîchi par polling court
   * (2-3s) tant que ce panneau est affiché, voir TopologySubGraphPanel.tsx. */
  processesDetailed: ContainerProcessDetailList | null;
  processesDetailedContainerId: string | null;
  processesDetailedStatus: "idle" | "loading" | "ready" | "error";
  processesDetailedError: string | null;
  /** Pid ayant une action kill/restart en cours (désactive son bouton) — un seul à la fois, même
   * principe qu'`actionPendingId` ci-dessus pour le cycle de vie du conteneur. */
  processActionPendingPid: number | null;
  processActionError: string | null;
}

const initialState: ContainersState = {
  items: [],
  status: "idle",
  error: null,
  selectedId: null,
  createStatus: "idle",
  createError: null,
  detail: null,
  detailStatus: "idle",
  actionPendingId: null,
  actionError: null,
  processes: null,
  processesContainerId: null,
  processesStatus: "idle",
  processesError: null,
  processesDetailed: null,
  processesDetailedContainerId: null,
  processesDetailedStatus: "idle",
  processesDetailedError: null,
  processActionPendingPid: null,
  processActionError: null,
};

/**
 * `environmentId` (optionnel) : id sélectionné dans le Topbar (state.ui.selectedEnvironmentId,
 * voir Topbar.tsx). Transmis tel quel en querystring — l'API ne réagit qu'aux id préfixés
 * "remote-docker:" (voir apps/api/src/utils/environmentId.ts), tout le reste (environnement
 * local, Kubernetes, Nutanix, LXC, absent) retombe sur le comportement historique.
 */
export const fetchContainers = createAsyncThunk<ContainerRef[], string | null | undefined>(
  "containers/fetchContainers",
  async (environmentId) =>
    apiGet<ContainerRef[]>(
      `/containers${environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ""}`,
    ),
);

export const fetchContainerDetail = createAsyncThunk<ContainerDetail, string>(
  "containers/fetchContainerDetail",
  async (id) => apiGet<ContainerDetail>(`/containers/${id}`),
);

/** Processus réels en cours d'exécution (équivalent `docker top`) — voir
 * GET /api/containers/:id/processes. Échoue explicitement (409 conteneur arrêté, 404 disparu,
 * 502 démon injoignable...) plutôt que de retomber sur une liste vide qui prétendrait "aucun
 * process" : le composant appelant doit distinguer "aucun process" (impossible en pratique, un
 * conteneur a toujours au moins son PID 1) d'un échec réel. */
export const fetchContainerProcesses = createAsyncThunk<
  { id: string; list: ContainerProcessList },
  string,
  { rejectValue: string }
>("containers/fetchProcesses", async (id, { rejectWithValue }) => {
  try {
    const list = await apiGet<ContainerProcessList>(`/containers/${id}/processes`);
    return { id, list };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de récupérer les processus du conteneur.";
    return rejectWithValue(message);
  }
});

/** Détail enrichi des processus réels (voir ContainerProcessDetailList) — voir
 * GET /api/containers/:id/processes/detailed. Même contrat d'échec explicite que
 * fetchContainerProcesses ci-dessus (409 conteneur arrêté, etc.) ; `shellAvailable: false`
 * (succès HTTP, liste vide) est un cas HONNÊTE distinct, géré côté composant (jamais ici comme
 * une erreur). */
export const fetchContainerProcessesDetailed = createAsyncThunk<
  { id: string; list: ContainerProcessDetailList },
  string,
  { rejectValue: string }
>("containers/fetchProcessesDetailed", async (id, { rejectWithValue }) => {
  try {
    const list = await apiGet<ContainerProcessDetailList>(`/containers/${id}/processes/detailed`);
    return { id, list };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Impossible de récupérer le détail des processus du conteneur.";
    return rejectWithValue(message);
  }
});

/** Tue RÉELLEMENT un process (`docker exec kill`, voir POST .../processes/:pid/kill) — `pid` suit
 * la numérotation ContainerProcessDetail (namespace PID du conteneur), jamais celle de
 * ContainerProcessList (docker top, PID hôte). Le serveur répond 409 avec
 * `useContainerStopInstead: true` (AUCUN kill n'a eu lieu) si `pid` vaut 1 : ce cas remonte via
 * `rejectValue.useContainerStopInstead`, à l'appelant de rediriger vers l'action "Arrêter le
 * conteneur" existante — jamais un message d'erreur brut qui laisserait l'utilisateur bloqué. */
export const killContainerProcess = createAsyncThunk<
  { id: string; pid: number },
  { id: string; pid: number; signal?: "TERM" | "KILL" },
  { rejectValue: { message: string; useContainerStopInstead?: boolean } }
>("containers/killProcess", async ({ id, pid, signal }, { rejectWithValue }) => {
  try {
    await apiPost(`/containers/${id}/processes/${pid}/kill`, signal ? { signal } : undefined);
    return { id, pid };
  } catch (error) {
    if (error instanceof ApiError) {
      return rejectWithValue({
        message: error.message,
        useContainerStopInstead: error.details?.useContainerStopInstead === true,
      });
    }
    return rejectWithValue({ message: "Échec de l'arrêt du processus." });
  }
});

/** Tue puis relance EXACTEMENT la même cmdline (voir POST .../processes/:pid/restart) — même
 * garde-fou PID 1 que killContainerProcess ci-dessus, redirige alors vers l'action "Redémarrer
 * le conteneur" via `rejectValue.useContainerRestartInstead`. */
export const restartContainerProcess = createAsyncThunk<
  { id: string; pid: number },
  { id: string; pid: number },
  { rejectValue: { message: string; useContainerRestartInstead?: boolean } }
>("containers/restartProcess", async ({ id, pid }, { rejectWithValue }) => {
  try {
    await apiPost(`/containers/${id}/processes/${pid}/restart`);
    return { id, pid };
  } catch (error) {
    if (error instanceof ApiError) {
      return rejectWithValue({
        message: error.message,
        useContainerRestartInstead: error.details?.useContainerRestartInstead === true,
      });
    }
    return rejectWithValue({ message: "Échec du redémarrage du processus." });
  }
});

/** Crée puis démarre un conteneur (équivalent `docker run -d`) — voir POST /api/containers. */
export const createContainer = createAsyncThunk<ContainerRef[], CreateContainerInput, { rejectValue: string }>(
  "containers/createContainer",
  async (input, { rejectWithValue }) => {
    try {
      const result = await apiPost<{ id: string; containers: ContainerRef[] }>("/containers", input);
      return result.containers;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la création du conteneur.";
      return rejectWithValue(message);
    }
  },
);

/** start/stop/restart/remove — voir POST/DELETE /api/containers/:id/*. */
export const runContainerAction = createAsyncThunk<
  { id: string; action: LifecycleAction; containers: ContainerRef[] },
  { id: string; action: LifecycleAction },
  { rejectValue: string }
>("containers/runAction", async ({ id, action }, { rejectWithValue }) => {
  try {
    if (action === "remove") {
      await apiDelete(`/containers/${id}`);
    } else {
      await apiPost(`/containers/${id}/${action}`);
    }
    const containers = await apiGet<ContainerRef[]>("/containers");
    return { id, action, containers };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : `Échec de l'action "${action}".`;
    return rejectWithValue(message);
  }
});

/** Renomme un conteneur (équivalent `docker rename`) — voir POST /api/containers/:id/rename.
 * Utilisé par le menu contextuel "Renommer" de l'éditeur visuel de topologie. */
export const renameContainer = createAsyncThunk<
  { id: string; containers: ContainerRef[] },
  { id: string; name: string },
  { rejectValue: string }
>("containers/rename", async ({ id, name }, { rejectWithValue, dispatch }) => {
  try {
    const result = await apiPost<{ ok: true; containers: ContainerRef[] }>(`/containers/${id}/rename`, { name });
    dispatch(pushNotification({ level: "success", message: `Conteneur renommé en "${name}".` }));
    return { id, containers: result.containers };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec du renommage.";
    dispatch(pushNotification({ level: "error", message }));
    return rejectWithValue(message);
  }
});

const containersSlice = createSlice({
  name: "containers",
  initialState,
  reducers: {
    selectContainer(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
      state.detail = null;
      state.detailStatus = "idle";
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchContainers.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchContainers.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchContainers.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les conteneurs.";
      })
      .addCase(fetchContainerDetail.pending, (state) => {
        state.detailStatus = "loading";
      })
      .addCase(fetchContainerDetail.fulfilled, (state, action) => {
        state.detailStatus = "ready";
        state.detail = action.payload;
      })
      .addCase(fetchContainerDetail.rejected, (state) => {
        state.detailStatus = "error";
      })
      .addCase(fetchContainerProcesses.pending, (state, action) => {
        state.processesStatus = "loading";
        state.processesError = null;
        state.processesContainerId = action.meta.arg;
      })
      .addCase(fetchContainerProcesses.fulfilled, (state, action) => {
        state.processesStatus = "ready";
        state.processes = action.payload.list;
        state.processesContainerId = action.payload.id;
      })
      .addCase(fetchContainerProcesses.rejected, (state, action) => {
        state.processesStatus = "error";
        state.processesError = action.payload ?? "Impossible de récupérer les processus du conteneur.";
      })
      .addCase(fetchContainerProcessesDetailed.pending, (state, action) => {
        state.processesDetailedStatus = "loading";
        state.processesDetailedError = null;
        state.processesDetailedContainerId = action.meta.arg;
      })
      .addCase(fetchContainerProcessesDetailed.fulfilled, (state, action) => {
        state.processesDetailedStatus = "ready";
        state.processesDetailed = action.payload.list;
        state.processesDetailedContainerId = action.payload.id;
      })
      .addCase(fetchContainerProcessesDetailed.rejected, (state, action) => {
        state.processesDetailedStatus = "error";
        state.processesDetailedError = action.payload ?? "Impossible de récupérer le détail des processus du conteneur.";
      })
      .addCase(killContainerProcess.pending, (state, action) => {
        state.processActionPendingPid = action.meta.arg.pid;
        state.processActionError = null;
      })
      .addCase(killContainerProcess.fulfilled, (state) => {
        state.processActionPendingPid = null;
      })
      .addCase(killContainerProcess.rejected, (state, action) => {
        state.processActionPendingPid = null;
        // Le cas "PID 1" (useContainerStopInstead) est géré par l'appelant (redirection vers
        // l'action conteneur) — pas affiché comme une erreur brute ici s'il est présent.
        if (!action.payload?.useContainerStopInstead) {
          state.processActionError = action.payload?.message ?? "Échec de l'arrêt du processus.";
        }
      })
      .addCase(restartContainerProcess.pending, (state, action) => {
        state.processActionPendingPid = action.meta.arg.pid;
        state.processActionError = null;
      })
      .addCase(restartContainerProcess.fulfilled, (state) => {
        state.processActionPendingPid = null;
      })
      .addCase(restartContainerProcess.rejected, (state, action) => {
        state.processActionPendingPid = null;
        if (!action.payload?.useContainerRestartInstead) {
          state.processActionError = action.payload?.message ?? "Échec du redémarrage du processus.";
        }
      })
      .addCase(createContainer.pending, (state) => {
        state.createStatus = "creating";
        state.createError = null;
      })
      .addCase(createContainer.fulfilled, (state, action) => {
        state.createStatus = "idle";
        state.items = action.payload;
      })
      .addCase(createContainer.rejected, (state, action) => {
        state.createStatus = "error";
        state.createError = action.payload ?? "Échec de la création du conteneur.";
      })
      .addCase(runContainerAction.pending, (state, action) => {
        state.actionPendingId = action.meta.arg.id;
        state.actionError = null;
      })
      .addCase(runContainerAction.fulfilled, (state, action) => {
        state.actionPendingId = null;
        state.items = action.payload.containers;
        if (action.payload.action === "remove" && state.selectedId === action.payload.id) {
          state.selectedId = null;
          state.detail = null;
        }
      })
      .addCase(runContainerAction.rejected, (state, action) => {
        state.actionPendingId = null;
        state.actionError = action.payload ?? "Échec de l'action.";
      })
      .addCase(renameContainer.pending, (state, action) => {
        state.actionPendingId = action.meta.arg.id;
        state.actionError = null;
      })
      .addCase(renameContainer.fulfilled, (state, action) => {
        state.actionPendingId = null;
        state.items = action.payload.containers;
      })
      .addCase(renameContainer.rejected, (state, action) => {
        state.actionPendingId = null;
        state.actionError = action.payload ?? "Échec du renommage.";
      });
  },
});

export const { selectContainer } = containersSlice.actions;
export default containersSlice.reducer;
