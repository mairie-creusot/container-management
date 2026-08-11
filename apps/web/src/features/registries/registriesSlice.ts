import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { Registry, RegistryCatalogResult, RegistryKind } from "@/types";

interface NewRegistryInput {
  kind: RegistryKind;
  name: string;
  url: string;
}

export interface UpdateRegistryInput {
  id: string;
  name?: string;
  url?: string;
  username?: string;
  // password/token vides = "conserver le secret existant" côté API (voir setupStore.ts) —
  // ne pas envoyer de chaîne vide écraserait silencieusement l'identifiant déjà enregistré,
  // donc ces champs sont omis du corps de la requête tant qu'ils ne sont pas renseignés
  // (voir handleUpdate dans RegistriesPage.tsx).
  password?: string;
  token?: string;
}

interface RegistriesState {
  items: Registry[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedId: string | null;
  selectedDetail: Registry | null;
  detailStatus: "idle" | "loading" | "ready" | "error";
  creating: boolean;
  /** Id du registry actuellement exploré (page RegistryExplorerPage) — null = aucun. */
  exploringId: string | null;
  repositories: string[];
  reposStatus: "idle" | "loading" | "ready" | "error";
  reposError: string | null;
  // Raison concrète pour laquelle `repositories` est vide (identifiants invalides, org
  // introuvable...) — distinct de reposError (échec réseau/HTTP de la requête elle-même) : le
  // catalogue a bien répondu, mais avec un résultat vide et une explication (voir
  // registries/index.ts#diagnosticFromError côté API).
  reposDiagnostic: string | null;
  tagsByRepo: Record<string, string[]>;
  tagsLoadingRepo: string | null;
}

const initialState: RegistriesState = {
  items: [],
  status: "idle",
  error: null,
  selectedId: null,
  selectedDetail: null,
  detailStatus: "idle",
  creating: false,
  exploringId: null,
  repositories: [],
  reposStatus: "idle",
  reposError: null,
  reposDiagnostic: null,
  tagsByRepo: {},
  tagsLoadingRepo: null,
};

export const fetchRegistries = createAsyncThunk<Registry[]>(
  "registries/fetchRegistries",
  async () => apiGet<Registry[]>("/registries"),
);

export const fetchRegistryDetail = createAsyncThunk<Registry, string>(
  "registries/fetchRegistryDetail",
  async (id) => apiGet<Registry>(`/registries/${id}`),
);

export const createRegistry = createAsyncThunk<
  Registry,
  NewRegistryInput,
  { rejectValue: string }
>("registries/createRegistry", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<Registry>("/registries", input);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Impossible d'ajouter ce registry.";
    return rejectWithValue(message);
  }
});

export const updateRegistry = createAsyncThunk<
  Registry,
  UpdateRegistryInput,
  { rejectValue: string }
>("registries/updateRegistry", async ({ id, ...patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<Registry>(`/registries/${id}`, patch);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Impossible de modifier ce registry.";
    return rejectWithValue(message);
  }
});

/** Vrai catalogue distant d'un registry — voir GET /api/registries/:id/repositories. */
export const fetchRepositories = createAsyncThunk<RegistryCatalogResult, string, { rejectValue: string }>(
  "registries/fetchRepositories",
  async (id, { rejectWithValue }) => {
    try {
      return await apiGet<RegistryCatalogResult>(`/registries/${id}/repositories`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de charger le catalogue.";
      return rejectWithValue(message);
    }
  },
);

/** Tags d'un dépôt du catalogue — voir GET /api/registries/:id/repositories/:repo/tags. */
export const fetchRepoTags = createAsyncThunk<
  { repo: string; tags: string[] },
  { registryId: string; repo: string }
>("registries/fetchRepoTags", async ({ registryId, repo }) => {
  const result = await apiGet<{ repository: string; tags: string[] }>(
    `/registries/${registryId}/repositories/${encodeURIComponent(repo)}/tags`,
  );
  return { repo, tags: result.tags };
});

const registriesSlice = createSlice({
  name: "registries",
  initialState,
  reducers: {
    selectRegistry(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
      if (action.payload === null) {
        state.selectedDetail = null;
      }
    },
    startExploring(state, action: PayloadAction<string>) {
      state.exploringId = action.payload;
      state.repositories = [];
      state.reposStatus = "idle";
      state.reposDiagnostic = null;
      state.tagsByRepo = {};
    },
    stopExploring(state) {
      state.exploringId = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchRegistries.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRegistries.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchRegistries.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les registries.";
      })
      .addCase(fetchRegistryDetail.pending, (state) => {
        state.detailStatus = "loading";
      })
      .addCase(fetchRegistryDetail.fulfilled, (state, action) => {
        state.detailStatus = "ready";
        state.selectedDetail = action.payload;
      })
      .addCase(fetchRegistryDetail.rejected, (state) => {
        state.detailStatus = "error";
      })
      .addCase(createRegistry.pending, (state) => {
        state.creating = true;
      })
      .addCase(createRegistry.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createRegistry.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible d'ajouter ce registry.";
      })
      .addCase(updateRegistry.pending, (state) => {
        state.creating = true;
      })
      .addCase(updateRegistry.fulfilled, (state, action) => {
        state.creating = false;
        const index = state.items.findIndex((r) => r.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
        if (state.selectedDetail?.id === action.payload.id) state.selectedDetail = action.payload;
      })
      .addCase(updateRegistry.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de modifier ce registry.";
      })
      .addCase(fetchRepositories.pending, (state) => {
        state.reposStatus = "loading";
        state.reposError = null;
        state.reposDiagnostic = null;
      })
      .addCase(fetchRepositories.fulfilled, (state, action) => {
        state.reposStatus = "ready";
        state.repositories = action.payload.repositories;
        state.reposDiagnostic = action.payload.diagnostic ?? null;
      })
      .addCase(fetchRepositories.rejected, (state, action) => {
        state.reposStatus = "error";
        state.reposError = action.payload ?? "Impossible de charger le catalogue.";
      })
      .addCase(fetchRepoTags.pending, (state, action) => {
        state.tagsLoadingRepo = action.meta.arg.repo;
      })
      .addCase(fetchRepoTags.fulfilled, (state, action) => {
        state.tagsLoadingRepo = null;
        state.tagsByRepo[action.payload.repo] = action.payload.tags;
      })
      .addCase(fetchRepoTags.rejected, (state) => {
        state.tagsLoadingRepo = null;
      });
  },
});

export const { selectRegistry, startExploring, stopExploring } = registriesSlice.actions;
export default registriesSlice.reducer;
