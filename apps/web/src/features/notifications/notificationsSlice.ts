import { createSlice, nanoid, type PayloadAction } from "@reduxjs/toolkit";

export type NotificationLevel = "error" | "success" | "info";

export interface AppNotification {
  id: string;
  level: NotificationLevel;
  message: string;
  /** Type d'action Redux à l'origine (ex: "containers/runAction/rejected") — aide au diagnostic. */
  source?: string;
  createdAt: string; // ISO 8601
  read: boolean;
}

interface NotificationsState {
  items: AppNotification[];
}

const MAX_ITEMS = 200;

const initialState: NotificationsState = { items: [] };

const notificationsSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    pushNotification: {
      reducer(state, action: PayloadAction<AppNotification>) {
        state.items.unshift(action.payload);
        if (state.items.length > MAX_ITEMS) state.items.length = MAX_ITEMS;
      },
      prepare(input: { level: NotificationLevel; message: string; source?: string }) {
        return {
          payload: {
            id: nanoid(),
            level: input.level,
            message: input.message,
            ...(input.source ? { source: input.source } : {}),
            createdAt: new Date().toISOString(),
            read: false,
          } satisfies AppNotification,
        };
      },
    },
    markAllRead(state) {
      for (const item of state.items) item.read = true;
    },
    dismissNotification(state, action: PayloadAction<string>) {
      state.items = state.items.filter((n) => n.id !== action.payload);
    },
    clearAllNotifications(state) {
      state.items = [];
    },
  },
});

export const { pushNotification, markAllRead, dismissNotification, clearAllNotifications } =
  notificationsSlice.actions;
export default notificationsSlice.reducer;
