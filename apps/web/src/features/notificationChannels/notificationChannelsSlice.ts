import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/api/client";
import type {
  NotificationChannelFilter,
  NotificationChannelKind,
  NotificationChannelRef,
  NotificationChannelTestResult,
} from "@/types";

/** Corps commun POST/PATCH — voir apps/api/src/routes/notificationChannels.ts. Les champs de config
 * spécifiques au type (webhook/slack/discord/email) sont volontairement optionnels : un PATCH peut
 * ne toucher qu'au nom/statut/filtre sans reposter la config du canal. */
export interface NotificationChannelFormInput {
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  filter?: NotificationChannelFilter;
  clearFilter?: boolean;
  webhook?: { url?: string };
  slack?: { webhookUrl?: string };
  discord?: { webhookUrl?: string };
  email?: {
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpPassword?: string;
    smtpSecure?: boolean;
    fromAddress?: string;
    toAddress?: string;
  };
}

interface NotificationChannelsState {
  items: NotificationChannelRef[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  creating: boolean;
  updatingId: string | null;
  deletingId: string | null;
  testingId: string | null;
  testResultById: Record<string, NotificationChannelTestResult | undefined>;
}

const initialState: NotificationChannelsState = {
  items: [],
  status: "idle",
  error: null,
  creating: false,
  updatingId: null,
  deletingId: null,
  testingId: null,
  testResultById: {},
};

export const fetchNotificationChannels = createAsyncThunk<NotificationChannelRef[]>(
  "notificationChannels/fetch",
  async () => apiGet<NotificationChannelRef[]>("/notification-channels"),
);

export const createNotificationChannel = createAsyncThunk<
  NotificationChannelRef,
  NotificationChannelFormInput,
  { rejectValue: string }
>("notificationChannels/create", async (input, { rejectWithValue }) => {
  try {
    return await apiPost<NotificationChannelRef>("/notification-channels", input);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de créer ce canal.";
    return rejectWithValue(message);
  }
});

export const updateNotificationChannel = createAsyncThunk<
  NotificationChannelRef,
  { id: string; patch: Partial<NotificationChannelFormInput> },
  { rejectValue: string }
>("notificationChannels/update", async ({ id, patch }, { rejectWithValue }) => {
  try {
    return await apiPatch<NotificationChannelRef>(`/notification-channels/${id}`, patch);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Impossible de modifier ce canal.";
    return rejectWithValue(message);
  }
});

export const deleteNotificationChannel = createAsyncThunk<string, string, { rejectValue: string }>(
  "notificationChannels/delete",
  async (id, { rejectWithValue }) => {
    try {
      await apiDelete(`/notification-channels/${id}`);
      return id;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de supprimer ce canal.";
      return rejectWithValue(message);
    }
  },
);

/** Envoi RÉEL d'un événement de test — voir POST /api/notification-channels/:id/test, jamais persisté au journal. */
export const testNotificationChannel = createAsyncThunk<
  { id: string; result: NotificationChannelTestResult },
  string,
  { rejectValue: string }
>("notificationChannels/test", async (id, { rejectWithValue }) => {
  try {
    const result = await apiPost<NotificationChannelTestResult>(`/notification-channels/${id}/test`);
    return { id, result };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Test d'envoi impossible.";
    return rejectWithValue(message);
  }
});

const notificationChannelsSlice = createSlice({
  name: "notificationChannels",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotificationChannels.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchNotificationChannels.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchNotificationChannels.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les canaux de notification.";
      })
      .addCase(createNotificationChannel.pending, (state) => {
        state.creating = true;
        state.error = null;
      })
      .addCase(createNotificationChannel.fulfilled, (state, action) => {
        state.creating = false;
        state.items.push(action.payload);
      })
      .addCase(createNotificationChannel.rejected, (state, action) => {
        state.creating = false;
        state.error = action.payload ?? "Impossible de créer ce canal.";
      })
      .addCase(updateNotificationChannel.pending, (state, action) => {
        state.updatingId = action.meta.arg.id;
        state.error = null;
      })
      .addCase(updateNotificationChannel.fulfilled, (state, action) => {
        state.updatingId = null;
        const index = state.items.findIndex((c) => c.id === action.payload.id);
        if (index !== -1) state.items[index] = action.payload;
      })
      .addCase(updateNotificationChannel.rejected, (state, action) => {
        state.updatingId = null;
        state.error = action.payload ?? "Impossible de modifier ce canal.";
      })
      .addCase(deleteNotificationChannel.pending, (state, action) => {
        state.deletingId = action.meta.arg;
      })
      .addCase(deleteNotificationChannel.fulfilled, (state, action) => {
        state.deletingId = null;
        state.items = state.items.filter((c) => c.id !== action.payload);
        delete state.testResultById[action.payload];
      })
      .addCase(deleteNotificationChannel.rejected, (state, action) => {
        state.deletingId = null;
        state.error = action.payload ?? "Impossible de supprimer ce canal.";
      })
      .addCase(testNotificationChannel.pending, (state, action) => {
        state.testingId = action.meta.arg;
      })
      .addCase(testNotificationChannel.fulfilled, (state, action) => {
        state.testingId = null;
        state.testResultById[action.payload.id] = action.payload.result;
      })
      .addCase(testNotificationChannel.rejected, (state, action) => {
        state.testingId = null;
        state.testResultById[action.meta.arg] = { ok: false, message: action.payload ?? "Test d'envoi impossible." };
      });
  },
});

export default notificationChannelsSlice.reducer;
