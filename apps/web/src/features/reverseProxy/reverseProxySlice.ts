import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { ReverseProxyRoute, ReverseProxyStatus } from "@/types";

export interface NewRouteInput {
  subdomain: string;
  targetContainerId?: string;
  targetHost?: string;
  /** Omis pour une cible conteneur : l'API déduit le port du conteneur réel (voir
   * services/reverseProxy.ts#detectContainerTargetPort) — obligatoire pour une cible host:port. */
  targetPort?: number;
}

/** Résultat de l'émission AD CS déclenchée par la création de la route (voir
 * services/certificatesReconciler.ts#issueCertificateForSubdomain côté API). */
export interface RouteCertificateOutcome {
  subject: string;
  status: "not-configured" | "auto-enroll-disabled" | "already-valid" | "issued" | "failed";
  at: string;
  message?: string;
}

export type CreatedRoute = ReverseProxyRoute & {
  caddyPushError?: string;
  certificate?: RouteCertificateOutcome;
};

interface ReverseProxyState {
  items: ReverseProxyRoute[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  caddyStatus: ReverseProxyStatus | null;
  caddyStatusLoading: boolean;
  /** Id de la route dont le resync DNS est en cours (une seule à la fois), pour désactiver
   * seulement le bouton "Retester" de cette ligne — jamais toute la table. */
  resyncingId: string | null;
}

const initialState: ReverseProxyState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  caddyStatus: null,
  caddyStatusLoading: false,
  resyncingId: null,
};

export const fetchRoutes = createAsyncThunk<ReverseProxyRoute[]>("reverseProxy/fetchRoutes", async () =>
  apiGet<ReverseProxyRoute[]>("/reverse-proxy/routes"),
);

export const fetchCaddyStatus = createAsyncThunk<ReverseProxyStatus>("reverseProxy/fetchStatus", async () =>
  apiGet<ReverseProxyStatus>("/reverse-proxy/status"),
);

/** Réponse 201 même en cas d'échec du push vers Caddy (voir routes/reverseProxy.ts côté API) —
 * `caddyPushError` signale que la route est bien créée côté QUAI mais pas encore reflétée par
 * Caddy (retentable via POST /reverse-proxy/push, pas câblé ici pour rester simple). `certificate`
 * porte le résultat de l'émission AD CS déclenchée dans la foulée. */
export const createRoute = createAsyncThunk<CreatedRoute, NewRouteInput, { rejectValue: string }>(
  "reverseProxy/createRoute",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<CreatedRoute>("/reverse-proxy/routes", input);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de créer cette route.";
      return rejectWithValue(message);
    }
  },
);

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

/** Retente UNIQUEMENT le push DNS AD (nsupdate) d'une route déjà créée — sans la recréer, sans
 * toucher à Caddy (voir POST /reverse-proxy/routes/:id/resync-dns côté API). Utile après
 * correction d'un problème serveur (ACL/réglage de zone) constaté via `dnsSync.status === "failed"`. */
export const resyncRouteDns = createAsyncThunk<ReverseProxyRoute, string, { rejectValue: string }>(
  "reverseProxy/resyncDns",
  async (id, { rejectWithValue }) => {
    try {
      return await apiPost<ReverseProxyRoute>(`/reverse-proxy/routes/${id}/resync-dns`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de retester la synchronisation DNS.";
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
      })
      .addCase(resyncRouteDns.pending, (state, action) => {
        state.resyncingId = action.meta.arg;
      })
      .addCase(resyncRouteDns.fulfilled, (state, action) => {
        state.resyncingId = null;
        const index = state.items.findIndex((route) => route.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(resyncRouteDns.rejected, (state, action) => {
        state.resyncingId = null;
        state.error = action.payload ?? "Impossible de retester la synchronisation DNS.";
      });
  },
});

export default reverseProxySlice.reducer;
