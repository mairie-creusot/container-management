import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { ImageRef, ScanResult } from "@/types";

export type ImageStatusFilter = "all" | "update" | "uptodate";

interface ImagesState {
  items: ImageRef[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  filter: ImageStatusFilter;
  selectedId: string | null;
  updatingId: string | null;
  deletingId: string | null;
  pullStatus: "idle" | "pulling" | "error";
  pullError: string | null;
  /** Historique des scans Grype, clé = ImageRef.id, les plus récents en premier (index 0). */
  scansByImageId: Record<string, ScanResult[]>;
  scanStatus: "idle" | "starting" | "error";
  scanError: string | null;
}

const initialState: ImagesState = {
  items: [],
  status: "idle",
  error: null,
  filter: "all",
  selectedId: null,
  updatingId: null,
  deletingId: null,
  pullStatus: "idle",
  pullError: null,
  scansByImageId: {},
  scanStatus: "idle",
  scanError: null,
};

export const fetchImages = createAsyncThunk<ImageRef[], ImageStatusFilter | undefined>(
  "images/fetchImages",
  async (filter) => {
    const query = filter && filter !== "all" ? `?status=${filter}` : "";
    return apiGet<ImageRef[]>(`/images${query}`);
  },
);

export const updateImage = createAsyncThunk<
  ImageRef,
  string,
  { rejectValue: string }
>("images/updateImage", async (id, { rejectWithValue }) => {
  try {
    // id peut contenir des "/" (ex: "local:ghcr.io/mairie/app:1.0") : à encoder, sinon
    // Fastify le traite comme plusieurs segments de route et 404 (bug réel, corrigé ici —
    // touchait toute image dont le nom n'est pas sur Docker Hub).
    return await apiPost<ImageRef>(`/images/${encodeURIComponent(id)}/update`);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Échec de la mise à jour.";
    return rejectWithValue(message);
  }
});

export const deleteImage = createAsyncThunk<string, { id: string; force?: boolean }, { rejectValue: string }>(
  "images/deleteImage",
  async ({ id, force }, { rejectWithValue }) => {
    try {
      const query = force ? "?force=true" : "";
      await apiDelete(`/images/${encodeURIComponent(id)}${query}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la suppression de l'image.";
      return rejectWithValue(message);
    }
  },
);

/** Tire une nouvelle image (ex: "redis:7-alpine") — équivalent `docker pull`, voir POST /api/images/pull. */
export const pullImage = createAsyncThunk<ImageRef[], string, { rejectValue: string }>(
  "images/pullImage",
  async (reference, { rejectWithValue }) => {
    try {
      const result = await apiPost<{ ok: true; images: ImageRef[] }>("/images/pull", { reference });
      return result.images;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : `Échec du pull de "${reference}".`;
      return rejectWithValue(message);
    }
  },
);

/** Lance un scan Grype réel pour l'image `id` — voir POST /api/images/:id/scan. */
export const scanImage = createAsyncThunk<ScanResult, string, { rejectValue: string }>(
  "images/scanImage",
  async (id, { rejectWithValue }) => {
    try {
      // id peut contenir des "/" (voir updateImage ci-dessus pour le bug déjà corrigé) : encodé ici.
      return await apiPost<ScanResult>(`/images/${encodeURIComponent(id)}/scan`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec du lancement du scan.";
      return rejectWithValue(message);
    }
  },
);

/** Historique des scans d'une image — voir GET /api/images/:id/scans. */
export const fetchScans = createAsyncThunk<ScanResult[], string>("images/fetchScans", async (id) => {
  return apiGet<ScanResult[]>(`/images/${encodeURIComponent(id)}/scans`);
});

/** Rafraîchit le statut d'un scan en cours — voir GET /api/scans/:scanId (à poller). */
export const fetchScanDetail = createAsyncThunk<ScanResult, { imageId: string; scanId: string }>(
  "images/fetchScanDetail",
  async ({ scanId }) => apiGet<ScanResult>(`/scans/${scanId}`),
);

const imagesSlice = createSlice({
  name: "images",
  initialState,
  reducers: {
    setImageFilter(state, action: PayloadAction<ImageStatusFilter>) {
      state.filter = action.payload;
    },
    selectImage(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchImages.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchImages.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchImages.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les images.";
      })
      .addCase(updateImage.pending, (state, action) => {
        state.updatingId = action.meta.arg;
      })
      .addCase(updateImage.fulfilled, (state, action) => {
        state.updatingId = null;
        const index = state.items.findIndex((item) => item.id === action.payload.id);
        if (index >= 0) state.items[index] = action.payload;
      })
      .addCase(updateImage.rejected, (state, action) => {
        state.updatingId = null;
        state.error = action.payload ?? "Échec de la mise à jour.";
      })
      .addCase(deleteImage.pending, (state, action) => {
        state.deletingId = action.meta.arg.id;
      })
      .addCase(deleteImage.fulfilled, (state, action) => {
        state.deletingId = null;
        state.items = state.items.filter((item) => item.id !== action.payload);
        if (state.selectedId === action.payload) state.selectedId = null;
      })
      .addCase(deleteImage.rejected, (state) => {
        state.deletingId = null;
      })
      .addCase(pullImage.pending, (state) => {
        state.pullStatus = "pulling";
        state.pullError = null;
      })
      .addCase(pullImage.fulfilled, (state, action) => {
        state.pullStatus = "idle";
        state.items = action.payload;
      })
      .addCase(pullImage.rejected, (state, action) => {
        state.pullStatus = "error";
        state.pullError = action.payload ?? "Échec du pull.";
      })
      .addCase(scanImage.pending, (state) => {
        state.scanStatus = "starting";
        state.scanError = null;
      })
      .addCase(scanImage.fulfilled, (state, action) => {
        state.scanStatus = "idle";
        const imageId = action.meta.arg;
        const existing = state.scansByImageId[imageId] ?? [];
        state.scansByImageId[imageId] = [action.payload, ...existing];
      })
      .addCase(scanImage.rejected, (state, action) => {
        state.scanStatus = "error";
        state.scanError = action.payload ?? "Échec du lancement du scan.";
      })
      .addCase(fetchScans.fulfilled, (state, action) => {
        state.scansByImageId[action.meta.arg] = action.payload;
      })
      .addCase(fetchScanDetail.fulfilled, (state, action) => {
        const list = state.scansByImageId[action.meta.arg.imageId];
        if (!list) return;
        const index = list.findIndex((s) => s.id === action.payload.id);
        if (index >= 0) list[index] = action.payload;
      });
  },
});

export const { setImageFilter, selectImage } = imagesSlice.actions;
export default imagesSlice.reducer;
