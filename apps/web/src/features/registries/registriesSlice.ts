import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPost, ApiError } from "@/api/client";
import type { Registry, RegistryKind } from "@/types";

interface NewRegistryInput {
  kind: RegistryKind;
  name: string;
  url: string;
}

interface RegistriesState {
  items: Registry[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedId: string | null;
  selectedDetail: Registry | null;
  detailStatus: "idle" | "loading" | "ready" | "error";
  creating: boolean;
}

const initialState: RegistriesState = {
  items: [],
  status: "idle",
  error: null,
  selectedId: null,
  selectedDetail: null,
  detailStatus: "idle",
  creating: false,
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
      });
  },
});

export const { selectRegistry } = registriesSlice.actions;
export default registriesSlice.reducer;
