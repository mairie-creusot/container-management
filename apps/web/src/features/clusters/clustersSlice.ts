import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPut, ApiError } from "@/api/client";
import type { ClusterNode, Environment, NutanixConfig, NutanixStatus, NutanixVm } from "@/types";

/** Formulaire de configuration Nutanix (routes/nutanix.ts côté API) — `password` vide = conserver
 * le mot de passe déjà enregistré (même convention que le reste du projet, voir AdDnsFormInput). */
export interface NutanixConfigFormInput {
  prismCentralUrl: string;
  username: string;
  password?: string;
}

interface ClustersState {
  environments: Environment[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  expandedIds: string[];
  nodesStatusByEnv: Record<string, "idle" | "loading" | "ready" | "error">;
  selectedNodeId: string | null;
  // Détail par VM de l'environnement Nutanix (GET /api/nutanix/vms) — distinct de
  // environments[].nodes qui n'expose qu'un nœud PAR CLUSTER PHYSIQUE (compteur agrégé, voir
  // apps/api/src/services/nutanix.ts#getNutanixEnvironment). Chargé à la demande, seulement
  // quand l'environnement Nutanix est déplié (EnvironmentsPage.tsx#handleToggle).
  nutanixVms: NutanixVm[];
  nutanixVmsStatus: "idle" | "loading" | "ready" | "error";
  selectedVmId: string | null;
  // Configuration Nutanix elle-même (routes/nutanix.ts) — permet de l'ajouter/la modifier EN
  // DEHORS de l'assistant de premier lancement (avant cette section, seule cette étape-là pouvait
  // la définir, invisible une fois l'assistant terminé sans tout rouvrir).
  nutanixConfigured: boolean;
  nutanixConfig: NutanixConfig | null;
  nutanixConfigStatus: "idle" | "loading" | "ready" | "error";
  nutanixConfigSaving: boolean;
  nutanixConfigError: string | null;
}

const initialState: ClustersState = {
  environments: [],
  status: "idle",
  error: null,
  expandedIds: [],
  nodesStatusByEnv: {},
  selectedNodeId: null,
  nutanixVms: [],
  nutanixVmsStatus: "idle",
  selectedVmId: null,
  nutanixConfigured: false,
  nutanixConfig: null,
  nutanixConfigStatus: "idle",
  nutanixConfigSaving: false,
  nutanixConfigError: null,
};

export const fetchEnvironments = createAsyncThunk<Environment[]>(
  "clusters/fetchEnvironments",
  async () => apiGet<Environment[]>("/environments"),
);

export const fetchEnvironmentNodes = createAsyncThunk<
  { environmentId: string; nodes: ClusterNode[] },
  string
>("clusters/fetchEnvironmentNodes", async (environmentId) => {
  const nodes = await apiGet<ClusterNode[]>(`/environments/${environmentId}/nodes`);
  return { environmentId, nodes };
});

export const fetchNutanixVms = createAsyncThunk<NutanixVm[]>(
  "clusters/fetchNutanixVms",
  async () => apiGet<NutanixVm[]>("/nutanix/vms"),
);

export const fetchNutanixConfig = createAsyncThunk<NutanixStatus>(
  "clusters/fetchNutanixConfig",
  async () => apiGet<NutanixStatus>("/nutanix/config"),
);

export const saveNutanixConfig = createAsyncThunk<NutanixStatus, NutanixConfigFormInput, { rejectValue: string }>(
  "clusters/saveNutanixConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPut<NutanixStatus>("/nutanix/config", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible d'enregistrer la configuration Nutanix.";
      return rejectWithValue(message);
    }
  },
);

export const disableNutanix = createAsyncThunk<void, void, { rejectValue: string }>(
  "clusters/disableNutanix",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/nutanix/config");
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de désactiver Nutanix.";
      return rejectWithValue(message);
    }
  },
);

const clustersSlice = createSlice({
  name: "clusters",
  initialState,
  reducers: {
    toggleEnvironmentExpanded(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.expandedIds = state.expandedIds.includes(id)
        ? state.expandedIds.filter((existing) => existing !== id)
        : [...state.expandedIds, id];
    },
    selectNode(state, action: PayloadAction<string | null>) {
      state.selectedNodeId = action.payload;
      if (action.payload) state.selectedVmId = null;
    },
    selectVm(state, action: PayloadAction<string | null>) {
      state.selectedVmId = action.payload;
      if (action.payload) state.selectedNodeId = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchEnvironments.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchEnvironments.fulfilled, (state, action) => {
        state.status = "ready";
        state.environments = action.payload;
      })
      .addCase(fetchEnvironments.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les environnements.";
      })
      .addCase(fetchEnvironmentNodes.pending, (state, action) => {
        state.nodesStatusByEnv[action.meta.arg] = "loading";
      })
      .addCase(fetchEnvironmentNodes.fulfilled, (state, action) => {
        state.nodesStatusByEnv[action.payload.environmentId] = "ready";
        const env = state.environments.find((e) => e.id === action.payload.environmentId);
        if (env) env.nodes = action.payload.nodes;
      })
      .addCase(fetchEnvironmentNodes.rejected, (state, action) => {
        state.nodesStatusByEnv[action.meta.arg] = "error";
      })
      .addCase(fetchNutanixVms.pending, (state) => {
        state.nutanixVmsStatus = "loading";
      })
      .addCase(fetchNutanixVms.fulfilled, (state, action) => {
        state.nutanixVmsStatus = "ready";
        state.nutanixVms = action.payload;
      })
      .addCase(fetchNutanixVms.rejected, (state) => {
        state.nutanixVmsStatus = "error";
      })
      .addCase(fetchNutanixConfig.pending, (state) => {
        state.nutanixConfigStatus = "loading";
      })
      .addCase(fetchNutanixConfig.fulfilled, (state, action) => {
        state.nutanixConfigStatus = "ready";
        state.nutanixConfigured = action.payload.configured;
        state.nutanixConfig = action.payload.config ?? null;
      })
      .addCase(fetchNutanixConfig.rejected, (state) => {
        state.nutanixConfigStatus = "error";
      })
      .addCase(saveNutanixConfig.pending, (state) => {
        state.nutanixConfigSaving = true;
        state.nutanixConfigError = null;
      })
      .addCase(saveNutanixConfig.fulfilled, (state, action) => {
        state.nutanixConfigSaving = false;
        state.nutanixConfigured = action.payload.configured;
        state.nutanixConfig = action.payload.config ?? null;
        // Le formulaire vit désormais dans les Réglages, pas sur la page Environnements : la liste
        // affichée vient peut-être de l'ancien Prism Central — repassée en "idle" pour être relue
        // au prochain affichage de la page plutôt que d'y rester périmée.
        state.status = "idle";
        state.nutanixVmsStatus = "idle";
      })
      .addCase(saveNutanixConfig.rejected, (state, action) => {
        state.nutanixConfigSaving = false;
        state.nutanixConfigError = action.payload ?? "Impossible d'enregistrer la configuration Nutanix.";
      })
      .addCase(disableNutanix.fulfilled, (state) => {
        state.nutanixConfigured = false;
        state.nutanixConfig = null;
        state.nutanixVms = [];
        state.nutanixVmsStatus = "idle";
        state.status = "idle";
      })
      .addCase(disableNutanix.rejected, (state, action) => {
        state.nutanixConfigError = action.payload ?? "Impossible de désactiver Nutanix.";
      });
  },
});

export const { toggleEnvironmentExpanded, selectNode, selectVm } = clustersSlice.actions;
export default clustersSlice.reducer;
