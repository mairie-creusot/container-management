/**
 * Slice Redux GitOps — auparavant consommée par la page dédiée `features/gitops/GitOpsPage.tsx`
 * (retirée : GitOps est maintenant piloté depuis le nœud "gitops-source" du graphe de topologie,
 * voir TopologyNodeDetailPanel.tsx). Conservée telle quelle (aucune route/logique dupliquée) : le
 * panneau de détail dispatch exactement les mêmes thunks/actions qu'avant, seul l'EMPLACEMENT de
 * l'UI a changé.
 */
import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPost } from "@/api/client";
import type { DiffResult, GitCommit, GitOpsFile } from "@/types";

export type GitOpsTab = "diff" | "manifest";

interface GitopsState {
  files: GitOpsFile[];
  filesStatus: "idle" | "loading" | "ready" | "error";
  commits: GitCommit[];
  commitsStatus: "idle" | "loading" | "ready" | "error";
  selectedPath: string | null;
  activeTab: GitOpsTab;
  diff: DiffResult | null;
  diffStatus: "idle" | "loading" | "ready" | "error";
  syncing: boolean;
  error: string | null;
  /** Horodatage du dernier GET /api/gitops/files réussi — sert d'indicateur "dernière
   *  vérification automatique" sur la page (voir GitOpsPage.tsx). */
  lastCheckedAt: string | null;
}

const initialState: GitopsState = {
  files: [],
  filesStatus: "idle",
  commits: [],
  commitsStatus: "idle",
  selectedPath: null,
  activeTab: "diff",
  diff: null,
  diffStatus: "idle",
  syncing: false,
  error: null,
  lastCheckedAt: null,
};

export const fetchGitopsFiles = createAsyncThunk<GitOpsFile[]>(
  "gitops/fetchFiles",
  async () => apiGet<GitOpsFile[]>("/gitops/files"),
);

export const fetchGitopsCommits = createAsyncThunk<GitCommit[]>(
  "gitops/fetchCommits",
  async () => apiGet<GitCommit[]>("/gitops/commits"),
);

export const fetchGitopsDiff = createAsyncThunk<
  { path: string; diff: DiffResult },
  string
>("gitops/fetchDiff", async (path) => {
  const diff = await apiGet<DiffResult>(`/gitops/files/${encodeURIComponent(path)}/diff`);
  return { path, diff };
});

export const syncGitops = createAsyncThunk("gitops/sync", async () => {
  await apiPost<void>("/gitops/sync");
});

const gitopsSlice = createSlice({
  name: "gitops",
  initialState,
  reducers: {
    selectFile(state, action: PayloadAction<string | null>) {
      state.selectedPath = action.payload;
      state.diff = null;
    },
    setActiveTab(state, action: PayloadAction<GitOpsTab>) {
      state.activeTab = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchGitopsFiles.pending, (state) => {
        state.filesStatus = "loading";
        state.error = null;
      })
      .addCase(fetchGitopsFiles.fulfilled, (state, action) => {
        state.filesStatus = "ready";
        state.files = action.payload;
        state.lastCheckedAt = new Date().toISOString();
      })
      .addCase(fetchGitopsFiles.rejected, (state, action) => {
        state.filesStatus = "error";
        state.error = action.error.message ?? "Impossible de charger les manifestes.";
      })
      .addCase(fetchGitopsCommits.pending, (state) => {
        state.commitsStatus = "loading";
      })
      .addCase(fetchGitopsCommits.fulfilled, (state, action) => {
        state.commitsStatus = "ready";
        state.commits = action.payload;
      })
      .addCase(fetchGitopsCommits.rejected, (state) => {
        state.commitsStatus = "error";
      })
      .addCase(fetchGitopsDiff.pending, (state) => {
        state.diffStatus = "loading";
      })
      .addCase(fetchGitopsDiff.fulfilled, (state, action) => {
        state.diffStatus = "ready";
        if (state.selectedPath === action.payload.path) {
          state.diff = action.payload.diff;
        }
      })
      .addCase(fetchGitopsDiff.rejected, (state) => {
        state.diffStatus = "error";
      })
      .addCase(syncGitops.pending, (state) => {
        state.syncing = true;
      })
      .addCase(syncGitops.fulfilled, (state) => {
        state.syncing = false;
      })
      .addCase(syncGitops.rejected, (state, action) => {
        state.syncing = false;
        state.error = action.error.message ?? "Échec de la resynchronisation.";
      });
  },
});

export const { selectFile, setActiveTab } = gitopsSlice.actions;
export default gitopsSlice.reducer;
