import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiGet, apiPut } from "@/api/client";
import type { Topology } from "@/types";

export type NodePositions = Record<string, { x: number; y: number }>;

interface TopologyState {
  data: Topology | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  // Disposition des nœuds déplacés à la main par L'UTILISATEUR CONNECTÉ (voir
  // GET/PUT /api/topology/positions, apps/api/src/services/topologyPositionsStore.ts) — pas
  // localStorage : la disposition suit le compte, pas l'appareil/le navigateur.
  positions: NodePositions;
  positionsStatus: "idle" | "loading" | "ready" | "error";
}

const initialState: TopologyState = {
  data: null,
  status: "idle",
  error: null,
  positions: {},
  positionsStatus: "idle",
};

export const fetchTopology = createAsyncThunk<Topology>("topology/fetch", async () => apiGet<Topology>("/topology"));

export const fetchTopologyPositions = createAsyncThunk<NodePositions>(
  "topology/fetchPositions",
  async () => apiGet<NodePositions>("/topology/positions"),
);

/** Remplace la disposition complète de l'utilisateur connecté — voir TopologyGraph.tsx#handleNodeDragStop. */
export const saveTopologyPositions = createAsyncThunk<NodePositions, NodePositions>(
  "topology/savePositions",
  async (positions) => {
    await apiPut<{ ok: boolean }>("/topology/positions", { positions });
    return positions;
  },
);

const topologySlice = createSlice({
  name: "topology",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchTopology.pending, (state) => {
        if (!state.data) state.status = "loading";
      })
      .addCase(fetchTopology.fulfilled, (state, action) => {
        state.status = "ready";
        state.data = action.payload;
      })
      .addCase(fetchTopology.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger la topologie.";
      })
      .addCase(fetchTopologyPositions.pending, (state) => {
        state.positionsStatus = "loading";
      })
      .addCase(fetchTopologyPositions.fulfilled, (state, action) => {
        state.positionsStatus = "ready";
        state.positions = action.payload;
      })
      .addCase(fetchTopologyPositions.rejected, (state) => {
        state.positionsStatus = "error";
      })
      .addCase(saveTopologyPositions.fulfilled, (state, action) => {
        state.positions = action.payload;
      });
  },
});

export default topologySlice.reducer;
