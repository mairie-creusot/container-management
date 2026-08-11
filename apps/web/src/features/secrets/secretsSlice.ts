import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { SecretRef } from "@/types";

interface NewSecretInput {
  name: string;
  value: string;
  description?: string;
}

export interface UpdateSecretInput {
  id: string;
  name?: string;
  // value vide = "conserver le secret existant" côté API (voir secretsStore.ts) — omis du
  // corps de la requête tant qu'il n'est pas renseigné (voir handleUpdate dans SecretsPage.tsx),
  // même principe que registriesSlice.ts#UpdateRegistryInput pour password/token.
  value?: string;
  description?: string;
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
