import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import type { IacEngine, IacEngineStatus, IacFileEntry, IacRun, IacRunDetail, IacWorkspace } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

interface IacState {
  engines: IacEngineStatus[];
  /**
   * Un seul workspace "actif" à la fois (celui affiché par TopologyNodeDetailPanel.tsx#
   * IacWorkspacePanel — l'ancienne page dédiée IacPage.tsx, retirée, listait tous les workspaces
   * ici même ; désormais GET /api/topology fait déjà cette liste sous forme de nœuds
   * "iac-workspace", plus besoin de la dupliquer dans ce slice) : files/openFile.../runs/selectedRun
   * ci-dessous décrivent tous CE workspace précis, réinitialisés par `selectWorkspace` à chaque
   * changement de nœud affiché.
   */
  selectedWorkspaceId: string | null;
  files: IacFileEntry[];
  openFilePath: string | null;
  openFileContent: string;
  runs: IacRun[];
  selectedRun: IacRunDetail | null;
}

const initialState: IacState = {
  engines: [],
  selectedWorkspaceId: null,
  files: [],
  openFilePath: null,
  openFileContent: "",
  runs: [],
  selectedRun: null,
};

export const fetchEngines = createAsyncThunk<IacEngineStatus[]>("iac/fetchEngines", async () =>
  apiGet<IacEngineStatus[]>("/iac/engines"),
);

export const createWorkspace = createAsyncThunk<IacWorkspace, { name: string; engine: IacEngine }, { rejectValue: string }>(
  "iac/createWorkspace",
  async (input, { rejectWithValue, dispatch }) => {
    try {
      const workspace = await apiPost<IacWorkspace>("/iac/workspaces", input);
      dispatch(pushNotification({ level: "success", message: `Workspace "${input.name}" créé.` }));
      return workspace;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la création du workspace.";
      return rejectWithValue(message);
    }
  },
);

export const deleteWorkspace = createAsyncThunk<string, string, { rejectValue: string }>(
  "iac/deleteWorkspace",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/iac/workspaces/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la suppression.";
      return rejectWithValue(message);
    }
  },
);

export const fetchFiles = createAsyncThunk<IacFileEntry[], string>("iac/fetchFiles", async (workspaceId) =>
  apiGet<IacFileEntry[]>(`/iac/workspaces/${workspaceId}/files`),
);

export const openFile = createAsyncThunk<{ path: string; content: string }, { workspaceId: string; path: string }>(
  "iac/openFile",
  async ({ workspaceId, path }) =>
    apiGet<{ path: string; content: string }>(`/iac/workspaces/${workspaceId}/files/${encodeURIComponent(path)}`),
);

export const saveFile = createAsyncThunk<
  void,
  { workspaceId: string; path: string; content: string },
  { rejectValue: string }
>("iac/saveFile", async ({ workspaceId, path, content }, { rejectWithValue, dispatch }) => {
  try {
    await apiPut(`/iac/workspaces/${workspaceId}/files/${encodeURIComponent(path)}`, { content });
    dispatch(pushNotification({ level: "success", message: `"${path}" enregistré.` }));
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de l'enregistrement.";
    return rejectWithValue(message);
  }
});

export const runAction = createAsyncThunk<
  IacRun,
  { workspaceId: string; engine: IacEngine; action: string },
  { rejectValue: string }
>("iac/runAction", async ({ workspaceId, engine, action }, { rejectWithValue }) => {
  try {
    return await apiPost<IacRun>(`/iac/workspaces/${workspaceId}/run`, { engine, action });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec du lancement.";
    return rejectWithValue(message);
  }
});

export const fetchRuns = createAsyncThunk<IacRun[], string>("iac/fetchRuns", async (workspaceId) =>
  apiGet<IacRun[]>(`/iac/workspaces/${workspaceId}/runs`),
);

export const fetchRunDetail = createAsyncThunk<IacRunDetail, { workspaceId: string; runId: string }>(
  "iac/fetchRunDetail",
  async ({ workspaceId, runId }) => apiGet<IacRunDetail>(`/iac/workspaces/${workspaceId}/runs/${runId}`),
);

const iacSlice = createSlice({
  name: "iac",
  initialState,
  reducers: {
    selectWorkspace(state, action: PayloadAction<string | null>) {
      state.selectedWorkspaceId = action.payload;
      state.files = [];
      state.openFilePath = null;
      state.openFileContent = "";
      state.runs = [];
      state.selectedRun = null;
    },
    setOpenFileContent(state, action: PayloadAction<string>) {
      state.openFileContent = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchEngines.fulfilled, (state, action) => {
        state.engines = action.payload;
      })
      .addCase(deleteWorkspace.fulfilled, (state, action) => {
        if (state.selectedWorkspaceId === action.payload) state.selectedWorkspaceId = null;
      })
      .addCase(fetchFiles.fulfilled, (state, action) => {
        state.files = action.payload;
      })
      .addCase(openFile.fulfilled, (state, action) => {
        state.openFilePath = action.payload.path;
        state.openFileContent = action.payload.content;
      })
      .addCase(runAction.fulfilled, (state, action) => {
        state.runs.unshift(action.payload);
      })
      .addCase(fetchRuns.fulfilled, (state, action) => {
        state.runs = action.payload;
      })
      .addCase(fetchRunDetail.fulfilled, (state, action) => {
        state.selectedRun = action.payload;
        const index = state.runs.findIndex((r) => r.id === action.payload.id);
        if (index >= 0) state.runs[index] = action.payload;
      });
  },
});

export const { selectWorkspace, setOpenFileContent } = iacSlice.actions;
export default iacSlice.reducer;
