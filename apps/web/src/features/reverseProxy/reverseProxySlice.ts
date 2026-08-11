import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { ReverseProxyRoute, ReverseProxyStatus } from "@/types";

export interface NewRouteInput {
  subdomain: string;
  targetContainerId?: string;
  targetHost?: string;
  targetPort: number;
}

interface ReverseProxyState {
  items: ReverseProxyRoute[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  caddyStatus: ReverseProxyStatus | null;
  caddyStatusLoading: boolean;
}

const initialState: ReverseProxyState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  caddyStatus: null,
  caddyStatusLoading: false,
};

export const fetchRoutes = createAsyncThunk<ReverseProxyRoute[]>("reverseProxy/fetchRoutes", async () =>
  apiGet<ReverseProxyRoute[]>("/reverse-proxy/routes"),
);

export const fetchCaddyStatus = createAsyncThunk<ReverseProxyStatus>("reverseProxy/fetchStatus", async () =>
  apiGet<ReverseProxyStatus>("/reverse-proxy/status"),
);

/** Réponse 201 même en cas d'échec du push vers Caddy (voir routes/reverseProxy.ts côté API) —
 * `caddyPushError` signale que la route est bien créée côté QUAI mais pas encore reflétée par
 * Caddy (retentable via POST /reverse-proxy/push, pas câblé ici pour rester simple). */
export const createRoute = createAsyncThunk<
  ReverseProxyRoute & { caddyPushError?: string },
  NewRouteInput,
  { rejectValue: string }
>("reverseProxy/createRoute", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<ReverseProxyRoute & { caddyPushError?: string }>("/reverse-proxy/routes", input);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de créer cette route.";
    return rejectWithValue(message);
  }
});

export const deleteRoute = createAsyncThunk<string, string, { rejectValue: string }>(
  "reverseProxy/deleteRoute",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/reverse-proxy/routes/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer cette route.";
      return rejectWithValue(message);
    }
  },
);

const reverseProxySlice = createSlice({
  name: "reverseProxy",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRoutes.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRoutes.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchRoutes.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les routes.";
      })
      .addCase(fetchCaddyStatus.pending, (state) => {
        state.caddyStatusLoading = true;
      })
      .addCase(fetchCaddyStatus.fulfilled, (state, action) => {
        state.caddyStatusLoading = false;
        state.caddyStatus = action.payload;
      })
      .addCase(fetchCaddyStatus.rejected, (state) => {
        state.caddyStatusLoading = false;
      })
      .addCase(createRoute.pending, (state) => {
        state.creating = true;
      })
      .addCase(createRoute.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createRoute.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer cette route.";
      })
      .addCase(deleteRoute.fulfilled, (state, action) => {
        state.items = state.items.filter((route) => route.id !== action.payload);
      })
      .addCase(deleteRoute.rejected, (state, action) => {
        state.error = action.payload ?? "Impossible de supprimer cette route.";
      });
  },
});

export default reverseProxySlice.reducer;
