import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { DockerVolume, VolumeFileEntry } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

interface VolumesState {
  items: DockerVolume[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  mutatingName: string | null;
  /** Explorateur de fichiers (lecture seule) — voir VolumeFilesModal.tsx. */
  browser: {
    volumeName: string | null;
    path: string;
    entries: VolumeFileEntry[];
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
  };
}

const initialState: VolumesState = {
  items: [],
  status: "idle",
  error: null,
  mutatingName: null,
  browser: {
    volumeName: null,
    path: "",
    entries: [],
    status: "idle",
    error: null,
  },
};

export const fetchVolumes = createAsyncThunk<DockerVolume[]>("volumes/fetch", async () =>
  apiGet<DockerVolume[]>("/volumes"),
);

export const createVolume = createAsyncThunk<DockerVolume, string, { rejectValue: string }>(
  "volumes/create",
  async (name, { rejectWithValue, dispatch }) => {
    try {
      const volume = await apiPost<DockerVolume>("/volumes", { name });
      dispatch(pushNotification({ level: "success", message: `Volume "${name}" créé.` }));
      return volume;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la création du volume.";
      return rejectWithValue(message);
    }
  },
);

export const removeVolume = createAsyncThunk<string, string, { rejectValue: string }>(
  "volumes/remove",
  async (name, { rejectWithValue, dispatch }) => {
    try {
      await apiDelete(`/volumes/${encodeURIComponent(name)}`);
      dispatch(pushNotification({ level: "success", message: `Volume "${name}" supprimé.` }));
      return name;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Échec de la suppression du volume.";
      return rejectWithValue(message);
    }
  },
);

/** Explorateur de fichiers en lecture seule — voir GET /api/volumes/:name/files. */
export const fetchVolumeFiles = createAsyncThunk<
  { volumeName: string; path: string; entries: VolumeFileEntry[] },
  { volumeName: string; path: string },
  { rejectValue: string }
>("volumes/fetchFiles", async ({ volumeName, path }, { rejectWithValue }) => {
  try {
    const entries = await apiGet<VolumeFileEntry[]>(
      `/volumes/${encodeURIComponent(volumeName)}/files?path=${encodeURIComponent(path)}`,
    );
    return { volumeName, path, entries };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de lister le contenu du volume.";
    return rejectWithValue(message);
  }
});

const volumesSlice = createSlice({
  name: "volumes",
  initialState,
  reducers: {
    /** Ouvre l'explorateur sur la racine d'un volume — voir TopologyNodeDetailPanel.tsx (bouton
     * "Parcourir" de la section volume). */
    openVolumeBrowser(state, action: PayloadAction<string>) {
      state.browser = { volumeName: action.payload, path: "", entries: [], status: "idle", error: null };
    },
    closeVolumeBrowser(state) {
      state.browser = { volumeName: null, path: "", entries: [], status: "idle", error: null };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchVolumes.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchVolumes.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchVolumes.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les volumes.";
      })
      .addCase(createVolume.fulfilled, (state, action) => {
        state.items.unshift(action.payload);
      })
      .addCase(removeVolume.pending, (state, action) => {
        state.mutatingName = action.meta.arg;
      })
      .addCase(removeVolume.fulfilled, (state, action) => {
        state.mutatingName = null;
        state.items = state.items.filter((v) => v.name !== action.payload);
      })
      .addCase(removeVolume.rejected, (state) => {
        state.mutatingName = null;
      })
      .addCase(fetchVolumeFiles.pending, (state) => {
        state.browser.status = "loading";
        state.browser.error = null;
      })
      .addCase(fetchVolumeFiles.fulfilled, (state, action) => {
        // Ignore une réponse pour un volume/chemin qu'on a déjà quitté (navigation rapide).
        if (state.browser.volumeName !== action.payload.volumeName) return;
        state.browser.status = "ready";
        state.browser.path = action.payload.path;
        state.browser.entries = action.payload.entries;
      })
      .addCase(fetchVolumeFiles.rejected, (state, action) => {
        state.browser.status = "error";
        state.browser.error = action.payload ?? "Impossible de lister le contenu du volume.";
      });
  },
});

export const { openVolumeBrowser, closeVolumeBrowser } = volumesSlice.actions;
export default volumesSlice.reducer;
