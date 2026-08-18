import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, ApiError } from "@/api/client";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import type { ImageTemplate, ImageTemplateCreateInput, TemplateArtifactSource, TemplatePreset } from "@/types";

// Fabrique de templates (GET/POST /api/templates...) — backend développé EN PARALLÈLE contre le
// contrat de types.ts : un 404 est traité PARTOUT comme "backend pas encore disponible" (état vide
// explicite côté UI, jamais de fausses données, jamais un toast d'erreur en boucle de poll).

/** "unavailable" = 404 réel constaté (backend absent) — distinct d'une liste vide légitime. */
export type TemplatesAvailability = "unknown" | "available" | "unavailable";

/** États d'une liste annexe du studio (presets, sources d'artefacts) — "unavailable" = 404 réel. */
export type StudioListStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface TemplatesState {
  items: ImageTemplate[];
  status: "idle" | "loading" | "ready" | "error";
  availability: TemplatesAvailability;
  presets: TemplatePreset[];
  presetsStatus: StudioListStatus;
  artifactSources: TemplateArtifactSource[];
  artifactSourcesStatus: StudioListStatus;
}

const initialState: TemplatesState = {
  items: [],
  status: "idle",
  availability: "unknown",
  presets: [],
  presetsStatus: "idle",
  artifactSources: [],
  artifactSourcesStatus: "idle",
};

const BACKEND_MISSING_MESSAGE = "Le backend de la fabrique de templates n'est pas encore disponible.";

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) return BACKEND_MISSING_MESSAGE;
  return error instanceof ApiError ? error.message : fallback;
}

type FetchTemplatesResult =
  | { outcome: "ok"; items: ImageTemplate[] }
  | { outcome: "unavailable" }
  | { outcome: "error" };

/** Jamais rejeté (le poll pendant un build ne doit produire AUCUN toast via
 * errorNotificationMiddleware) — les transitions building -> ready/error détectées ici déclenchent
 * le toast final + un rafraîchissement du graphe, même pattern de suivi que les runs IaC. */
export const fetchTemplates = createAsyncThunk<FetchTemplatesResult, void>(
  "templates/fetch",
  async (_arg, { getState, dispatch }) => {
    try {
      const items = await apiGet<ImageTemplate[]>("/templates");
      const previous = (getState() as { templates: TemplatesState }).templates.items;
      let finished = false;
      for (const t of items) {
        const before = previous.find((p) => p.id === t.id);
        if (before?.status !== "building" || t.status === "building") continue;
        finished = true;
        if (t.status === "ready") {
          dispatch(pushNotification({ level: "success", message: `Build du template « ${t.name} » terminé — prêt à déployer.` }));
        } else if (t.status === "error") {
          dispatch(pushNotification({ level: "error", message: `Build du template « ${t.name} » en échec — voir les builds du nœud.` }));
        }
      }
      if (finished) dispatch(fetchTopology());
      return { outcome: "ok", items };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { outcome: "unavailable" };
      return { outcome: "error" };
    }
  },
);

type StudioListResult<T> = { outcome: "ok"; items: T[] } | { outcome: "unavailable" } | { outcome: "error" };

async function studioList<T>(path: string): Promise<StudioListResult<T>> {
  try {
    return { outcome: "ok", items: await apiGet<T[]>(path) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { outcome: "unavailable" };
    return { outcome: "error" };
  }
}

/** Jamais rejeté (aucun toast) — un 404 devient un état "indisponible" explicite dans le studio. */
export const fetchTemplatePresets = createAsyncThunk<StudioListResult<TemplatePreset>, void>(
  "templates/fetchPresets",
  () => studioList<TemplatePreset>("/templates/presets"),
);

/** Jamais rejeté (aucun toast) — même contrat que fetchTemplatePresets. */
export const fetchArtifactSources = createAsyncThunk<StudioListResult<TemplateArtifactSource>, void>(
  "templates/fetchArtifactSources",
  () => studioList<TemplateArtifactSource>("/templates/artifact-sources"),
);

export const createTemplate = createAsyncThunk<ImageTemplate, ImageTemplateCreateInput, { rejectValue: string }>(
  "templates/create",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<ImageTemplate>("/templates", input);
    } catch (error) {
      return rejectWithValue(mutationErrorMessage(error, "Échec de la création du template."));
    }
  },
);

/** POST /api/templates/:id/build — la forme exacte de la réponse n'est pas figée par le contrat :
 * seule la relance de fetchTemplates (statut "building" + poll) fait foi côté client. */
export const buildTemplate = createAsyncThunk<{ id: string }, { id: string }, { rejectValue: string }>(
  "templates/build",
  async ({ id }, { rejectWithValue }) => {
    try {
      await apiPost<unknown>(`/templates/${id}/build`);
      return { id };
    } catch (error) {
      return rejectWithValue(mutationErrorMessage(error, "Échec du lancement du build."));
    }
  },
);

export const deleteTemplate = createAsyncThunk<{ id: string }, { id: string }, { rejectValue: string }>(
  "templates/delete",
  async ({ id }, { rejectWithValue }) => {
    try {
      await apiDelete<unknown>(`/templates/${id}`);
      return { id };
    } catch (error) {
      return rejectWithValue(mutationErrorMessage(error, "Échec de la suppression du template."));
    }
  },
);

const templatesSlice = createSlice({
  name: "templates",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchTemplates.pending, (state) => {
        if (state.status === "idle") state.status = "loading";
      })
      .addCase(fetchTemplates.fulfilled, (state, action) => {
        if (action.payload.outcome === "ok") {
          state.status = "ready";
          state.availability = "available";
          state.items = action.payload.items;
          return;
        }
        if (action.payload.outcome === "unavailable") {
          state.status = "ready";
          state.availability = "unavailable";
          state.items = [];
          return;
        }
        // Erreur réseau/serveur : on garde la dernière liste connue, sans conclure sur la dispo.
        state.status = "error";
      })
      .addCase(fetchTemplatePresets.pending, (state) => {
        if (state.presetsStatus === "idle") state.presetsStatus = "loading";
      })
      .addCase(fetchTemplatePresets.fulfilled, (state, action) => {
        if (action.payload.outcome === "ok") {
          state.presetsStatus = "ready";
          state.presets = action.payload.items;
        } else {
          state.presetsStatus = action.payload.outcome;
        }
      })
      .addCase(fetchArtifactSources.pending, (state) => {
        if (state.artifactSourcesStatus === "idle") state.artifactSourcesStatus = "loading";
      })
      .addCase(fetchArtifactSources.fulfilled, (state, action) => {
        if (action.payload.outcome === "ok") {
          state.artifactSourcesStatus = "ready";
          state.artifactSources = action.payload.items;
        } else {
          state.artifactSourcesStatus = action.payload.outcome;
        }
      })
      .addCase(createTemplate.fulfilled, (state, action) => {
        state.availability = "available";
        state.items.unshift(action.payload);
      })
      .addCase(deleteTemplate.fulfilled, (state, action) => {
        state.items = state.items.filter((t) => t.id !== action.payload.id);
      });
  },
});

export default templatesSlice.reducer;
