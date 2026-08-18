import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ViewId =
  | "overview"
  | "images"
  | "registries"
  | "containers"
  | "registry-explorer"
  | "clusters"
  | "notifications"
  | "audit"
  | "secrets"
  | "reverse-proxy"
  | "ad-dns"
  | "notification-channels"
  | "hycu";

interface UiState {
  currentView: ViewId;
  searchQuery: string;
  selectedEnvironmentId: string | null; // "" = toutes
  /**
   * Un formulaire de la vue courante contient des modifications non
   * enregistrées (ex. le formulaire d'ajout de registry ouvert). Consulté
   * par la Sidebar pour demander confirmation avant de changer de vue
   * plutôt que d'abandonner silencieusement la saisie.
   */
  unsavedFormActive: boolean;
}

const initialState: UiState = {
  currentView: "overview",
  searchQuery: "",
  selectedEnvironmentId: null,
  unsavedFormActive: false,
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    setCurrentView(state, action: PayloadAction<ViewId>) {
      state.currentView = action.payload;
      state.searchQuery = "";
    },
    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
    },
    setSelectedEnvironmentId(state, action: PayloadAction<string | null>) {
      state.selectedEnvironmentId = action.payload;
    },
    setUnsavedFormActive(state, action: PayloadAction<boolean>) {
      state.unsavedFormActive = action.payload;
    },
  },
});

export const { setCurrentView, setSearchQuery, setSelectedEnvironmentId, setUnsavedFormActive } =
  uiSlice.actions;
export default uiSlice.reducer;

export const NAV_ITEMS: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "images", label: "Images" },
  { id: "registries", label: "Registries" },
  { id: "containers", label: "Conteneurs" },
  { id: "reverse-proxy", label: "Reverse proxy" },
  { id: "clusters", label: "Environnements" },
  { id: "hycu", label: "Sauvegardes" },
];

const PAGE_TITLES: Partial<Record<ViewId, string>> = {
  notifications: "Notifications",
  audit: "Traçabilité",
  "registry-explorer": "Explorateur de registry",
  secrets: "Secrets",
  "ad-dns": "DNS Active Directory",
  "notification-channels": "Canaux de notification",
};

export function pageTitle(view: ViewId): string {
  return NAV_ITEMS.find((item) => item.id === view)?.label ?? PAGE_TITLES[view] ?? "QUAI";
}
