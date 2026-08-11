import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type { RemoteDockerEnvironmentRef, RemoteDockerTestResult } from "@/types";

export interface NewRemoteEnvironmentInput {
  name: string;
  host: string;
  port: number;
  tls?: { ca?: string; cert?: string; key?: string };
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
