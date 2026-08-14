import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { RemoteDockerEnvironmentRef, RemoteDockerTestResult, RemoteDockerTransport } from "@/types";

export interface NewRemoteEnvironmentInput {
  name: string;
  host: string;
  // Requis pour transport "tcp-tls" (pas de port Docker par défaut sensé) ; optionnel pour "ssh"
  // (défaut 22 résolu côté store) — le formulaire fournit toujours une valeur explicite dans les
  // deux cas (voir EnvironmentsPage.tsx), donc `number` reste le type ici.
  port: number;
  // Défaut "tcp-tls" côté store si omis. "ssh" : QUAI se connecte au port SSH déjà ouvert pour
  // l'administration de la machine puis tunnelise Docker au travers (aucun port Docker exposé sur
  // le réseau) — voir remoteDockerStore.ts en-tête pour le détail complet des deux transports.
  transport?: RemoteDockerTransport;
  tls?: { ca?: string; cert?: string; key?: string };
  ssh?: { username: string; password?: string; privateKey?: string };
}

interface RemoteEnvironmentsState {
  items: RemoteDockerEnvironmentRef[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  // Résultat du dernier test de connectivité par id d'environnement — voir GET
  // /api/remote-environments/:id/test, câblé bout-en-bout contre le client dockerode résolu.
  testResultById: Record<string, RemoteDockerTestResult | undefined>;
  testingId: string | null;
}

const initialState: RemoteEnvironmentsState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  testResultById: {},
  testingId: null,
};

export const fetchRemoteEnvironments = createAsyncThunk<RemoteDockerEnvironmentRef[]>(
  "remoteEnvironments/fetch",
  async () => apiGet<RemoteDockerEnvironmentRef[]>("/remote-environments"),
);

export const createRemoteEnvironment = createAsyncThunk<
  RemoteDockerEnvironmentRef,
  NewRemoteEnvironmentInput,
  { rejectValue: string }
>("remoteEnvironments/create", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<RemoteDockerEnvironmentRef>("/remote-environments", input);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de créer cet environnement.";
    return rejectWithValue(message);
  }
});

export interface UpdateRemoteEnvironmentInput {
  id: string;
  name?: string;
  host?: string;
  port?: number;
  // transport omis = transport conservé tel quel. Changer de transport DROPPE toujours les
  // identifiants de l'ancien transport côté store — un nouveau tls/ssh adapté au nouveau
  // transport est alors requis dans le même patch (voir remoteDockerStore.ts#updateRemoteDockerEnvironment).
  transport?: RemoteDockerTransport;
  // tls fourni = remplace ca/cert/key fournis (les autres champs TLS déjà persistés sont
  // conservés) ; clearTls = repasse en TCP non chiffré (voir remoteDockerStore.ts#PATCH pour la
  // sémantique exacte côté store) — jamais les deux à la fois côté formulaire (UpdateRemoteModal).
  tls?: { ca?: string; cert?: string; key?: string };
  clearTls?: boolean;
  // ssh fourni = remplace username/password/privateKey ; clearSsh = supprime les identifiants SSH
  // persistés — mêmes conventions que tls/clearTls ci-dessus, côté transport "ssh".
  ssh?: { username: string; password?: string; privateKey?: string };
  clearSsh?: boolean;
}

export const updateRemoteEnvironment = createAsyncThunk<
  RemoteDockerEnvironmentRef,
  UpdateRemoteEnvironmentInput,
  { rejectValue: string }
>("remoteEnvironments/update", async ({ id, ...patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<RemoteDockerEnvironmentRef>(`/remote-environments/${id}`, patch);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de modifier cet environnement.";
    return rejectWithValue(message);
  }
});

export const deleteRemoteEnvironment = createAsyncThunk<string, string, { rejectValue: string }>(
  "remoteEnvironments/delete",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/remote-environments/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer cet environnement.";
      return rejectWithValue(message);
    }
  },
);

/** Test de connectivité réel — voir GET /api/remote-environments/:id/test (docker.ping() sur le client distant résolu). */
export const testRemoteEnvironment = createAsyncThunk<
  { id: string; result: RemoteDockerTestResult },
  string,
  { rejectValue: string }
>("remoteEnvironments/test", async (id, { rejectWithValue }) => {
  try {
    const result = await apiGet<RemoteDockerTestResult>(`/remote-environments/${id}/test`);
    return { id, result };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Test de connectivité impossible.";
    return rejectWithValue(message);
  }
});

const remoteEnvironmentsSlice = createSlice({
  name: "remoteEnvironments",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRemoteEnvironments.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRemoteEnvironments.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchRemoteEnvironments.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les environnements Docker distants.";
      })
      .addCase(createRemoteEnvironment.pending, (state) => {
        state.creating = true;
      })
      .addCase(createRemoteEnvironment.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createRemoteEnvironment.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer cet environnement.";
      })
      .addCase(updateRemoteEnvironment.fulfilled, (state, action) => {
        const index = state.items.findIndex((e) => e.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(updateRemoteEnvironment.rejected, (state, action) => {
        state.error = action.payload ?? "Impossible de modifier cet environnement.";
      })
      .addCase(deleteRemoteEnvironment.fulfilled, (state, action) => {
        state.items = state.items.filter((e) => e.id !== action.payload);
        delete state.testResultById[action.payload];
      })
      .addCase(deleteRemoteEnvironment.rejected, (state, action) => {
        state.error = action.payload ?? "Impossible de supprimer cet environnement.";
      })
      .addCase(testRemoteEnvironment.pending, (state, action) => {
        state.testingId = action.meta.arg;
      })
      .addCase(testRemoteEnvironment.fulfilled, (state, action) => {
        state.testingId = null;
        state.testResultById[action.payload.id] = action.payload.result;
      })
      .addCase(testRemoteEnvironment.rejected, (state, action) => {
        state.testingId = null;
        state.testResultById[action.meta.arg] = {
          ok: false,
          message: action.payload ?? "Test de connectivité impossible.",
        };
      });
  },
});

export default remoteEnvironmentsSlice.reducer;
