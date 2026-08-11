import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet } from "@/api/client";
import type { ClusterNode, Environment } from "@/types";

interface ClustersState {
  environments: Environment[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  expandedIds: string[];
  nodesStatusByEnv: Record<string, "idle" | "loading" | "ready" | "error">;
  selectedNodeId: string | null;
}

const initialState: ClustersState = {
  environments: [],
  status: "idle",
  error: null,
  expandedIds: [],
  nodesStatusByEnv: {},
  selectedNodeId: null,
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
      });
  },
});

export const { toggleEnvironmentExpanded, selectNode } = clustersSlice.actions;
export default clustersSlice.reducer;
