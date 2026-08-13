import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { AutomationActionConfig, AutomationRunLogEntry, AutomationTriggerConfig } from "@/types";

/**
 * Moteur d'automatisation (trigger -> condition -> action, voir apps/api/src/routes/automation.ts) —
 * forme BRUTE du store (apps/api/src/services/automationStore.ts#AutomationNode/AutomationEdge),
 * PAS la forme TopologyNode/TopologyEdge déjà mirorée dans @/types (celle-ci est la projection
 * affichée sur le graphe, voir services/topology.ts#getAutomationNodes) : ids ici jamais préfixés
 * par `${kind}:`, contrairement à ceux du graphe — voir topologyGraphShared.tsx#idWithoutPrefix,
 * utilisé par TopologyGraph.tsx/TopologyNodeDetailPanel.tsx pour convertir un id de nœud du graphe
 * en id brut avant tout appel de ce slice.
 */
export type AutomationNodeKind = "automation-trigger" | "automation-condition" | "automation-action";

export interface AutomationNode {
  id: string;
  kind: AutomationNodeKind;
  label: string;
  createdAt: string; // ISO 8601
  triggerConfig?: AutomationTriggerConfig;
  conditionInvert?: boolean;
  actionConfig?: AutomationActionConfig;
  lastFired?: string | null;
  lastStatus?: "ok" | "failing" | "unknown";
}

export interface AutomationEdge {
  id: string;
  source: string; // id BRUT d'un AutomationNode
  target: string; // id BRUT d'un AutomationNode
}

/** Corps POST /api/automation/nodes — un seul des trois selon `kind` (voir routes/automation.ts). */
export interface CreateAutomationNodeInput {
  kind: AutomationNodeKind;
  label: string;
  triggerConfig?: AutomationTriggerConfig;
  conditionInvert?: boolean;
  actionConfig?: AutomationActionConfig;
}

interface AutomationState {
  items: AutomationNode[];
  status: "idle" | "loading" | "ready" | "error";
  edges: AutomationEdge[];
  edgesStatus: "idle" | "loading" | "ready" | "error";
  runs: AutomationRunLogEntry[];
  runsStatus: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creatingNode: boolean;
  deletingNodeId: string | null;
  creatingEdge: boolean;
  deletingEdgeId: string | null;
}

const initialState: AutomationState = {
  items: [],
  status: "idle",
  edges: [],
  edgesStatus: "idle",
  runs: [],
  runsStatus: "idle",
  error: null,
  creatingNode: false,
  deletingNodeId: null,
  creatingEdge: false,
  deletingEdgeId: null,
};

export const fetchAutomationNodes = createAsyncThunk<AutomationNode[]>("automation/fetchNodes", async () =>
  apiGet<AutomationNode[]>("/automation/nodes"),
);

export const fetchAutomationEdges = createAsyncThunk<AutomationEdge[]>("automation/fetchEdges", async () =>
  apiGet<AutomationEdge[]>("/automation/edges"),
);

export const fetchAutomationRuns = createAsyncThunk<AutomationRunLogEntry[]>("automation/fetchRuns", async () =>
  apiGet<AutomationRunLogEntry[]>("/automation/runs"),
);

export const createAutomationNode = createAsyncThunk<AutomationNode, CreateAutomationNodeInput, { rejectValue: string }>(
  "automation/createNode",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<AutomationNode>("/automation/nodes", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de créer ce nœud d'automatisation.";
      return rejectWithValue(message);
    }
  },
);

export const deleteAutomationNode = createAsyncThunk<string, string, { rejectValue: string }>(
  "automation/deleteNode",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/automation/nodes/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer ce nœud d'automatisation.";
      return rejectWithValue(message);
    }
  },
);

export const createAutomationEdge = createAsyncThunk<
  AutomationEdge,
  { source: string; target: string },
  { rejectValue: string }
>("automation/createEdge", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<AutomationEdge>("/automation/edges", input);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de créer cette connexion.";
    return rejectWithValue(message);
  }
});

export const deleteAutomationEdge = createAsyncThunk<string, string, { rejectValue: string }>(
  "automation/deleteEdge",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/automation/edges/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer cette connexion.";
      return rejectWithValue(message);
    }
  },
);

const automationSlice = createSlice({
  name: "automation",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAutomationNodes.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchAutomationNodes.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchAutomationNodes.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les nœuds d'automatisation.";
      })
      .addCase(fetchAutomationEdges.pending, (state) => {
        state.edgesStatus = "loading";
      })
      .addCase(fetchAutomationEdges.fulfilled, (state, action) => {
        state.edgesStatus = "ready";
        state.edges = action.payload;
      })
      .addCase(fetchAutomationEdges.rejected, (state) => {
        state.edgesStatus = "error";
      })
      .addCase(fetchAutomationRuns.pending, (state) => {
        state.runsStatus = "loading";
      })
      .addCase(fetchAutomationRuns.fulfilled, (state, action) => {
        state.runsStatus = "ready";
        state.runs = action.payload;
      })
      .addCase(fetchAutomationRuns.rejected, (state) => {
        state.runsStatus = "error";
      })
      .addCase(createAutomationNode.pending, (state) => {
        state.creatingNode = true;
        state.error = null;
      })
      .addCase(createAutomationNode.fulfilled, (state, action) => {
        state.creatingNode = false;
        state.items.push(action.payload);
      })
      .addCase(createAutomationNode.rejected, (state, action) => {
        state.creatingNode = false;
        state.error = action.payload ?? "Impossible de créer ce nœud d'automatisation.";
      })
      .addCase(deleteAutomationNode.pending, (state, action) => {
        state.deletingNodeId = action.meta.arg;
      })
      .addCase(deleteAutomationNode.fulfilled, (state, action) => {
        state.deletingNodeId = null;
        state.items = state.items.filter((n) => n.id !== action.payload);
        state.edges = state.edges.filter((e) => e.source !== action.payload && e.target !== action.payload);
      })
      .addCase(deleteAutomationNode.rejected, (state, action) => {
        state.deletingNodeId = null;
        state.error = action.payload ?? "Impossible de supprimer ce nœud d'automatisation.";
      })
      .addCase(createAutomationEdge.pending, (state) => {
        state.creatingEdge = true;
        state.error = null;
      })
      .addCase(createAutomationEdge.fulfilled, (state, action) => {
        state.creatingEdge = false;
        state.edges.push(action.payload);
      })
      .addCase(createAutomationEdge.rejected, (state, action) => {
        state.creatingEdge = false;
        state.error = action.payload ?? "Impossible de créer cette connexion.";
      })
      .addCase(deleteAutomationEdge.pending, (state, action) => {
        state.deletingEdgeId = action.meta.arg;
      })
      .addCase(deleteAutomationEdge.fulfilled, (state, action) => {
        state.deletingEdgeId = null;
        state.edges = state.edges.filter((e) => e.id !== action.payload);
      })
      .addCase(deleteAutomationEdge.rejected, (state, action) => {
        state.deletingEdgeId = null;
        state.error = action.payload ?? "Impossible de supprimer cette connexion.";
      });
  },
});

export default automationSlice.reducer;
