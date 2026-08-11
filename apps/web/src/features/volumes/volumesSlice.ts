import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import type { DockerVolume } from "@/types";
import { pushNotification } from "@/features/notifications/notificationsSlice";

interface VolumesState {
  items: DockerVolume[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedName: string | null;
  mutatingName: string | null;
}

const initialState: VolumesState = {
  items: [],
  status: "idle",
  error: null,
  selectedName: null,
  mutatingName: null,
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

const volumesSlice = createSlice({
  name: "volumes",
  initialState,
  reducers: {
    selectVolume(state, action: PayloadAction<string | null>) {
      state.selectedName = action.payload;
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
        if (state.selectedName === action.payload) state.selectedName = null;
      })
      .addCase(removeVolume.rejected, (state) => {
        state.mutatingName = null;
      });
  },
});

export const { selectVolume } = volumesSlice.actions;
export default volumesSlice.reducer;
