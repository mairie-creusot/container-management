import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import type {
  GithubDeployment,
  GithubDeploymentDetail,
  GithubRepoDetection,
  GithubRepoRef,
  GithubStatus,
} from "@/types";

interface GithubState {
  status: GithubStatus | null;
  statusStatus: "idle" | "loading" | "ready" | "error";
  tokenSaving: boolean;

  repos: GithubRepoRef[];
  reposStatus: "idle" | "loading" | "ready" | "error";
  reposError: string | null;

  selectedRepo: { owner: string; repo: string } | null;
  detection: GithubRepoDetection | null;
  detectionStatus: "idle" | "loading" | "ready" | "error";
  detectionError: string | null;

  deployments: GithubDeployment[];
  deploymentsStatus: "idle" | "loading" | "ready" | "error";
  selectedDeployment: GithubDeploymentDetail | null;
  deploying: boolean;
}

const initialState: GithubState = {
  status: null,
  statusStatus: "idle",
  tokenSaving: false,
  repos: [],
  reposStatus: "idle",
  reposError: null,
  selectedRepo: null,
  detection: null,
  detectionStatus: "idle",
  detectionError: null,
  deployments: [],
  deploymentsStatus: "idle",
  selectedDeployment: null,
  deploying: false,
};

export const fetchGithubStatus = createAsyncThunk<GithubStatus>("github/fetchStatus", async () =>
  apiGet<GithubStatus>("/github/status"),
);

export const saveGithubToken = createAsyncThunk<void, string, { rejectValue: string }>(
  "github/saveToken",
  async (token, { rejectWithValue, dispatch }) => {
    try {
      await apiPut("/github/token", { token });
      dispatch(pushNotification({ level: "success", message: "Jeton GitHub enregistré." }));
      dispatch(fetchGithubStatus());
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de l'enregistrement du jeton.";
      return rejectWithValue(message);
    }
  },
);

export const fetchGithubRepos = createAsyncThunk<GithubRepoRef[], void, { rejectValue: string }>(
  "github/fetchRepos",
  async (_arg, { rejectWithValue }) => {
    try {
      return await apiGet<GithubRepoRef[]>("/github/repos");
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec du chargement des dépôts.";
      return rejectWithValue(message);
    }
  },
);

export const fetchGithubDetection = createAsyncThunk<
  GithubRepoDetection,
  { owner: string; repo: string; ref?: string },
  { rejectValue: string }
>("github/fetchDetection", async ({ owner, repo, ref }, { rejectWithValue }) => {
  try {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return await apiGet<GithubRepoDetection>(`/github/repos/${owner}/${repo}/detect${query}`);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la détection.";
    return rejectWithValue(message);
  }
});

export const deployGithubRepo = createAsyncThunk<
  GithubDeployment,
  { owner: string; repo: string; ref?: string; targetEnvironmentId?: string },
  { rejectValue: string }
>("github/deploy", async ({ owner, repo, ref, targetEnvironmentId }, { rejectWithValue, dispatch }) => {
  try {
    const deployment = await apiPost<GithubDeployment>(`/github/repos/${owner}/${repo}/deploy`, {
      ...(ref ? { ref } : {}),
      ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
    });
    dispatch(pushNotification({ level: "info", message: `Déploiement de ${owner}/${repo} démarré.` }));
    return deployment;
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec du démarrage du déploiement.";
    return rejectWithValue(message);
  }
});

export const fetchGithubDeployments = createAsyncThunk<GithubDeployment[]>("github/fetchDeployments", async () =>
  apiGet<GithubDeployment[]>("/github/deployments"),
);

export const fetchGithubDeploymentDetail = createAsyncThunk<GithubDeploymentDetail, string>(
  "github/fetchDeploymentDetail",
  async (id) => apiGet<GithubDeploymentDetail>(`/github/deployments/${id}`),
);

const githubSlice = createSlice({
  name: "github",
  initialState,
  reducers: {
    selectRepo(state, action: PayloadAction<{ owner: string; repo: string } | null>) {
      state.selectedRepo = action.payload;
      state.detection = null;
      state.detectionStatus = "idle";
      state.detectionError = null;
    },
    selectDeployment(state, action: PayloadAction<GithubDeploymentDetail | null>) {
      state.selectedDeployment = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchGithubStatus.pending, (state) => {
        state.statusStatus = "loading";
      })
      .addCase(fetchGithubStatus.fulfilled, (state, action) => {
        state.statusStatus = "ready";
        state.status = action.payload;
      })
      .addCase(fetchGithubStatus.rejected, (state) => {
        state.statusStatus = "error";
      })
      .addCase(saveGithubToken.pending, (state) => {
        state.tokenSaving = true;
      })
      .addCase(saveGithubToken.fulfilled, (state) => {
        state.tokenSaving = false;
      })
      .addCase(saveGithubToken.rejected, (state) => {
        state.tokenSaving = false;
      })
      .addCase(fetchGithubRepos.pending, (state) => {
        state.reposStatus = "loading";
        state.reposError = null;
      })
      .addCase(fetchGithubRepos.fulfilled, (state, action) => {
        state.reposStatus = "ready";
        state.repos = action.payload;
      })
      .addCase(fetchGithubRepos.rejected, (state, action) => {
        state.reposStatus = "error";
        state.reposError = action.payload ?? "Échec du chargement des dépôts.";
      })
      .addCase(fetchGithubDetection.pending, (state) => {
        state.detectionStatus = "loading";
        state.detectionError = null;
      })
      .addCase(fetchGithubDetection.fulfilled, (state, action) => {
        state.detectionStatus = "ready";
        state.detection = action.payload;
      })
      .addCase(fetchGithubDetection.rejected, (state, action) => {
        state.detectionStatus = "error";
        state.detectionError = action.payload ?? "Échec de la détection.";
      })
      .addCase(deployGithubRepo.pending, (state) => {
        state.deploying = true;
      })
      .addCase(deployGithubRepo.fulfilled, (state, action) => {
        state.deploying = false;
        state.deployments.unshift(action.payload);
      })
      .addCase(deployGithubRepo.rejected, (state) => {
        state.deploying = false;
      })
      .addCase(fetchGithubDeployments.pending, (state) => {
        state.deploymentsStatus = "loading";
      })
      .addCase(fetchGithubDeployments.fulfilled, (state, action) => {
        state.deploymentsStatus = "ready";
        state.deployments = action.payload;
      })
      .addCase(fetchGithubDeployments.rejected, (state) => {
        state.deploymentsStatus = "error";
      })
      .addCase(fetchGithubDeploymentDetail.fulfilled, (state, action) => {
        state.selectedDeployment = action.payload;
        const index = state.deployments.findIndex((d) => d.id === action.payload.id);
        if (index >= 0) state.deployments[index] = action.payload;
      });
  },
});

export const { selectRepo, selectDeployment } = githubSlice.actions;
export default githubSlice.reducer;
