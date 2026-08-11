import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { ContainerDetail, ContainerRef } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

export interface CreateContainerInput {
  image: string;
  name?: string;
  ports?: string[];
  env?: string[];
  volumes?: string[];
  network?: string;
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
};

export const fetchContainers = createAsyncThunk<ContainerRef[]>(
  "containers/fetchContainers",
  async () => apiGet<ContainerRef[]>("/containers"),
);

export const fetchContainerDetail = createAsyncThunk<ContainerDetail, string>(
  "containers/fetchContainerDetail",
  async (id) => apiGet<ContainerDetail>(`/containers/${id}`),
);

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
