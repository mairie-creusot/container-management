import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { DockerNetwork } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

interface CreateNetworkInput {
  name: string;
  driver: string;
}

interface NetworksState {
  items: DockerNetwork[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedId: string | null;
  mutatingId: string | null;
}

const initialState: NetworksState = {
  items: [],
  status: "idle",
  error: null,
  selectedId: null,
  mutatingId: null,
};

export const fetchNetworks = createAsyncThunk<DockerNetwork[]>("networks/fetch", async () =>
  apiGet<DockerNetwork[]>("/networks"),
);

export const createNetwork = createAsyncThunk<DockerNetwork, CreateNetworkInput, { rejectValue: string }>(
  "networks/create",
  async (input, { rejectWithValue, dispatch }) => {
    try {
      const network = await apiPost<DockerNetwork>("/networks", input);
      dispatch(pushNotification({ level: "success", message: `Network "${input.name}" créé.` }));
      return network;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la création du network.";
      return rejectWithValue(message);
    }
  },
);

export const removeNetwork = createAsyncThunk<string, { id: string; name: string }, { rejectValue: string }>(
  "networks/remove",
  async ({ id, name }, { rejectWithValue, dispatch }) => {
    try {
      await apiDelete(`/networks/${id}`);
      dispatch(pushNotification({ level: "success", message: `Network "${name}" supprimé.` }));
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la suppression du network.";
      return rejectWithValue(message);
    }
  },
);

/**
 * Attache/détache un conteneur à un network (équivalent `docker network connect/disconnect`) —
 * voir POST /api/networks/:id/{connect,disconnect}. Utilisé par le glisser-connecter (ou le
 * menu contextuel d'une arête pour la déconnexion) de l'éditeur visuel de topologie ; le graphe
 * lui-même est rafraîchi séparément (topologySlice) après succès, pas ici.
 */
export const connectContainerToNetwork = createAsyncThunk<
  void,
  { networkId: string; containerId: string },
  { rejectValue: string }
>("networks/connectContainer", async ({ networkId, containerId }, { rejectWithValue, dispatch }) => {
  try {
    await apiPost(`/networks/${networkId}/connect`, { containerId });
    dispatch(pushNotification({ level: "success", message: "Conteneur connecté au network." }));
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la connexion au network.";
    dispatch(pushNotification({ level: "error", message }));
    return rejectWithValue(message);
  }
});

export const disconnectContainerFromNetwork = createAsyncThunk<
  void,
  { networkId: string; containerId: string },
  { rejectValue: string }
>("networks/disconnectContainer", async ({ networkId, containerId }, { rejectWithValue, dispatch }) => {
  try {
    await apiPost(`/networks/${networkId}/disconnect`, { containerId });
    dispatch(pushNotification({ level: "success", message: "Conteneur déconnecté du network." }));
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la déconnexion du network.";
    dispatch(pushNotification({ level: "error", message }));
    return rejectWithValue(message);
  }
});

const networksSlice = createSlice({
  name: "networks",
  initialState,
  reducers: {
    selectNetwork(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNetworks.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchNetworks.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchNetworks.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les networks.";
      })
      .addCase(createNetwork.fulfilled, (state, action) => {
        state.items.unshift(action.payload);
      })
      .addCase(removeNetwork.pending, (state, action) => {
        state.mutatingId = action.meta.arg.id;
      })
      .addCase(removeNetwork.fulfilled, (state, action) => {
        state.mutatingId = null;
        state.items = state.items.filter((n) => n.id !== action.payload);
        if (state.selectedId === action.payload) state.selectedId = null;
      })
      .addCase(removeNetwork.rejected, (state) => {
        state.mutatingId = null;
      });
  },
});

export const { selectNetwork } = networksSlice.actions;
export default networksSlice.reducer;
