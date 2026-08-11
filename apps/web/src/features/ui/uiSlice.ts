import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ViewId =
  | "overview"
  | "images"
  | "registries"
  | "containers"
  | "volumes"
  | "networks"
  | "topology"
  | "iac"
  | "gitops"
  | "clusters"
  | "notifications"
  | "audit";

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
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
  { id: "topology", label: "Topologie" },
  { id: "iac", label: "Infra-as-code" },
  { id: "gitops", label: "GitOps" },
  { id: "clusters", label: "Environnements" },
];

const PAGE_TITLES: Partial<Record<ViewId, string>> = {
  notifications: "Notifications",
  audit: "Traçabilité",
};

export function pageTitle(view: ViewId): string {
  return NAV_ITEMS.find((item) => item.id === view)?.label ?? PAGE_TITLES[view] ?? "QUAI";
}
