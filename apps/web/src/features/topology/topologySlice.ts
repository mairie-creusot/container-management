import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiGet } from "@/api/client";
import type { Topology } from "@/types";

interface TopologyState {
  data: Topology | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

const initialState: TopologyState = { data: null, status: "idle", error: null };

export const fetchTopology = createAsyncThunk<Topology>("topology/fetch", async () => apiGet<Topology>("/topology"));

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
      });
  },
});

export default topologySlice.reducer;
