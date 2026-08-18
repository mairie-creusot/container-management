import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError } from "@/api/client";
import type { Topology, TopologyGroup } from "@/types";

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

/** `scope: "local"` = premier rendu rapide sans les sources externes lentes (Nutanix, Docker
 * distants, LXD, AD) — l'appelant enchaîne aussitôt le fetch complet, voir TopologyGraph.tsx. */
export const fetchTopology = createAsyncThunk<Topology, { scope: "local" } | undefined>(
  "topology/fetch",
  async (arg) => apiGet<Topology>(arg?.scope === "local" ? "/topology?scope=local" : "/topology"),
);

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

/**
 * Regroupement de nœuds ("Regrouper" sur sélection multiple, voir TopologyGraph.tsx) —
 * POST /api/topology/groups. Ne met pas à jour `state.data` directement : l'appelant redéclenche
 * `fetchTopology()` juste après (même pattern que le reste de ce fichier/TopologyGraph.tsx), pour
 * ne jamais désynchroniser le nouveau groupe de l'état RÉEL du graphe recalculé côté serveur.
 */
export const createTopologyGroup = createAsyncThunk<TopologyGroup, { label: string; nodeIds: string[] }, { rejectValue: string }>(
  "topology/createGroup",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<TopologyGroup>("/topology/groups", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la création du groupe.";
      return rejectWithValue(message);
    }
  },
);

/** Renommer et/ou replier/déplier un groupe — PATCH /api/topology/groups/:id. */
export const updateTopologyGroup = createAsyncThunk<
  TopologyGroup,
  { id: string; label?: string; collapsed?: boolean },
  { rejectValue: string }
>("topology/updateGroup", async ({ id, ...patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<TopologyGroup>(`/topology/groups/${id}`, patch);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la mise à jour du groupe.";
    return rejectWithValue(message);
  }
});

/** Dissocie un groupe (les membres redeviennent des nœuds autonomes) — DELETE /api/topology/groups/:id. */
export const deleteTopologyGroup = createAsyncThunk<{ id: string }, string, { rejectValue: string }>(
  "topology/deleteGroup",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>(`/topology/groups/${id}`);
      return { id };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la dissociation du groupe.";
      return rejectWithValue(message);
    }
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
        // Un graphe partiel "local" ne remplace jamais un graphe déjà affiché (complet ou non) :
        // il ne sert qu'au premier paint, le fetch complet enchaîné apporte le reste.
        if (action.meta.arg?.scope === "local" && state.data) return;
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
