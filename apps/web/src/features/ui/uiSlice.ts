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
  | "publication"
  | "notification-channels"
  | "backups"
  | "threecx"
  | "glpi"
  | "settings";

interface UiState {
  currentView: ViewId;
  searchQuery: string;
  selectedEnvironmentId: string | null; // "" = toutes
  /**
   * Section ouverte dans la vue "settings" (id de SETTINGS_SECTIONS, voir
   * features/settings/settingsSections.ts) — porté ici pour que le menu Réglages du Topbar puisse
   * ouvrir directement la bonne intégration. `null` = première section.
   */
  settingsSection: string | null;
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
  settingsSection: null,
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
    /** Ouvre la vue Réglages sur une intégration précise (menu Réglages du Topbar). */
    openSettingsSection(state, action: PayloadAction<string | null>) {
      state.currentView = "settings";
      state.searchQuery = "";
      state.settingsSection = action.payload;
    },
  },
});

export const {
  setCurrentView,
  setSearchQuery,
  setSelectedEnvironmentId,
  setUnsavedFormActive,
  openSettingsSection,
} = uiSlice.actions;
export default uiSlice.reducer;

export const NAV_ITEMS: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "images", label: "Images" },
  { id: "registries", label: "Registries" },
  { id: "containers", label: "Conteneurs" },
  { id: "publication", label: "Publication" },
  { id: "clusters", label: "Environnements" },
  { id: "backups", label: "Sauvegardes" },
  { id: "threecx", label: "Téléphonie" },
  { id: "glpi", label: "Assistance GLPI" },
];

const PAGE_TITLES: Partial<Record<ViewId, string>> = {
  notifications: "Notifications",
  audit: "Traçabilité",
  "registry-explorer": "Explorateur de registry",
  secrets: "Secrets",
  "notification-channels": "Canaux de notification",
  settings: "Réglages",
};

export function pageTitle(view: ViewId): string {
  return NAV_ITEMS.find((item) => item.id === view)?.label ?? PAGE_TITLES[view] ?? "QUAI";
}
