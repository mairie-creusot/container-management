import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { SecretRef, SecretVersionMeta } from "@/types";

interface NewSecretInput {
  name: string;
  value: string;
  description?: string;
  expiresAt?: string;
}

export interface UpdateSecretInput {
  id: string;
  name?: string;
  // value vide = "conserver le secret existant" côté API (voir secretsStore.ts) — omis du
  // corps de la requête tant qu'il n'est pas renseigné (voir handleUpdate dans SecretsPage.tsx),
  // même principe que registriesSlice.ts#UpdateRegistryInput pour password/token.
  value?: string;
  description?: string;
  // undefined = inchangée ; null = efface l'expiration ; chaîne = nouvelle date (voir secretsStore.ts).
  expiresAt?: string | null;
}

interface SecretsState {
  items: SecretRef[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
}

const initialState: SecretsState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
};

export const fetchSecrets = createAsyncThunk<SecretRef[]>("secrets/fetchSecrets", async () =>
  apiGet<SecretRef[]>("/secrets"),
);

export const createSecret = createAsyncThunk<SecretRef, NewSecretInput, { rejectValue: string }>(
  "secrets/createSecret",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<SecretRef>("/secrets", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de créer ce secret.";
      return rejectWithValue(message);
    }
  },
);

export const updateSecret = createAsyncThunk<SecretRef, UpdateSecretInput, { rejectValue: string }>(
  "secrets/updateSecret",
  async ({ id, ...patch }, { rejectWithValue }) => {
    try {
      return await apiPatch<SecretRef>(`/secrets/${id}`, patch);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de modifier ce secret.";
      return rejectWithValue(message);
    }
  },
);

export const deleteSecret = createAsyncThunk<string, string, { rejectValue: string }>(
  "secrets/deleteSecret",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/secrets/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer ce secret.";
      return rejectWithValue(message);
    }
  },
);

/**
 * POST /api/secrets/:id/reveal — déchiffre et renvoie la valeur UNE FOIS. Volontairement SANS
 * `.addCase` dans extraReducers ci-dessous : la valeur en clair ne doit JAMAIS atterrir dans le
 * state Redux global (persistant, visible des devtools) — SecretsPage.tsx la garde uniquement
 * dans un state React local, via `dispatch(revealSecret(...)).unwrap()`, effacé au
 * démontage/à la fermeture. `version` optionnelle révèle une version passée (voir
 * fetchSecretVersions) plutôt que la version courante.
 */
export const revealSecret = createAsyncThunk<
  string,
  { id: string; version?: number },
  { rejectValue: string }
>("secrets/revealSecret", async ({ id, version }, { rejectWithValue }) => {
  try {
    const { value } = await apiPost<{ value: string }>(
      `/secrets/${id}/reveal`,
      version !== undefined ? { version } : undefined,
    );
    return value;
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de révéler ce secret.";
    return rejectWithValue(message);
  }
});

/** GET /api/secrets/:id/versions — métadonnées seules (jamais de valeur), même principe de non-
 * persistance que revealSecret : consommé directement par SecretsPage.tsx via `.unwrap()`. */
export const fetchSecretVersions = createAsyncThunk<
  SecretVersionMeta[],
  string,
  { rejectValue: string }
>("secrets/fetchSecretVersions", async (id, { rejectWithValue }) => {
  try {
    return await apiGet<SecretVersionMeta[]>(`/secrets/${id}/versions`);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de charger l'historique de ce secret.";
    return rejectWithValue(message);
  }
});

const secretsSlice = createSlice({
  name: "secrets",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchSecrets.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchSecrets.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchSecrets.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les secrets.";
      })
      .addCase(createSecret.pending, (state) => {
        state.creating = true;
      })
      .addCase(createSecret.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createSecret.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer ce secret.";
      })
      .addCase(updateSecret.pending, (state) => {
        state.creating = true;
      })
      .addCase(updateSecret.fulfilled, (state, action) => {
        state.creating = false;
        const index = state.items.findIndex((s) => s.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(updateSecret.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de modifier ce secret.";
      })
      .addCase(deleteSecret.fulfilled, (state, action) => {
        state.items = state.items.filter((s) => s.id !== action.payload);
      })
      .addCase(deleteSecret.rejected, (state, action) => {
        state.error = action.payload ?? "Impossible de supprimer ce secret.";
      });
  },
});

export default secretsSlice.reducer;
