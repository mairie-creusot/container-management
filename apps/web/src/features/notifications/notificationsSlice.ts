import { createAsyncThunk, createSlice, nanoid, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPost } from "@/api/client";
import type { SystemNotificationEvent } from "@/types";

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

/**
 * Notifications système détectées côté serveur par le watchdog (nouvelle version d'image,
 * intégration devenue injoignable/de nouveau joignable — voir apps/api/src/services/watchdog.ts)
 * : persistées, partagées entre tous les admins. Repollées comme le reste de l'app (voir
 * REFRESH_INTERVAL_MS dans overview/TopologyGraph), câblé depuis App.tsx pour rester actif
 * quelle que soit la vue affichée.
 */
export const fetchSystemNotifications = createAsyncThunk<SystemNotificationEvent[]>(
  "notifications/fetchSystem",
  () => apiGet<SystemNotificationEvent[]>("/notifications"),
);

/**
 * Contrepartie serveur de `markAllRead` (voir Topbar.tsx, dispatché en même temps au clic sur
 * la cloche) : persiste le curseur "tout lu" côté API pour que les notifications système
 * n'apparaissent plus non lues au prochain chargement, y compris pour un autre admin. Route
 * réservée à operator/admin (comme toute route mutante, cf. plugins/auth.ts) — un viewer voit
 * son marquage rester local uniquement, sans erreur visible (voir errorNotificationMiddleware.ts,
 * ce thunk est dans SILENT_PREFIXES).
 */
export const markServerNotificationsRead = createAsyncThunk<void>("notifications/markServerRead", async () => {
  await apiPost<{ ok: boolean }>("/notifications/read-all");
});

/** "system:<kind>" comme `source`, pour les distinguer d'une erreur d'action utilisateur au survol/debug. */
function fromSystemEvent(event: SystemNotificationEvent): AppNotification {
  return {
    id: event.id,
    level: event.level,
    message: event.message,
    source: `system:${event.kind}`,
    createdAt: event.timestamp,
    read: event.read,
  };
}

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
  extraReducers: (builder) => {
    builder.addCase(fetchSystemNotifications.fulfilled, (state, action) => {
      // Fusion par id : un événement système déjà connu (poll précédent) n'est jamais dupliqué
      // ni re-poussé comme "nouveau" (ToastStack ne re-toaste que les ids jamais vus), seul son
      // `read` est rafraîchi ; un événement inédit est inséré puis retrié par date de création
      // pour rester intercalé au bon endroit parmi les notifications client existantes.
      const byId = new Map(state.items.map((item) => [item.id, item]));
      for (const event of action.payload) {
        const existing = byId.get(event.id);
        if (existing) {
          existing.read = existing.read || event.read;
        } else {
          byId.set(event.id, fromSystemEvent(event));
        }
      }
      state.items = Array.from(byId.values())
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, MAX_ITEMS);
    });
  },
});

export const { pushNotification, markAllRead, dismissNotification, clearAllNotifications } =
  notificationsSlice.actions;
export default notificationsSlice.reducer;
