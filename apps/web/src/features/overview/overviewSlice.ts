import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiGet } from "@/api/client";
import type { ContainerRef, Environment, GitCommit, GitOpsFile, ImageRef, Registry } from "@/types";

export interface OverviewStats {
  activeContainers: number;
  imagesToUpdate: number;
  healthyNodes: number;
  totalNodes: number;
  driftCount: number;
}

export interface UtilisationPoint {
  label: string; // nom du nœud
  cpuPercent: number;
  memPercent: number;
}

export interface RegistrySegment {
  kind: Registry["kind"];
  name: string;
  value: number;
}

interface OverviewState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  stats: OverviewStats | null;
  /** Historique temporel (pas "un point par nœud" — voir loadOverview) : un point ajouté à
   * chaque rafraîchissement, agrégat CPU/mem sur l'ensemble des nœuds. Plafonné à HISTORY_LIMIT. */
  utilisation: UtilisationPoint[];
  registrySegments: RegistrySegment[];
  recentCommits: GitCommit[];
  lastRefreshedAt: string | null;
}

const HISTORY_LIMIT = 30;

const initialState: OverviewState = {
  status: "idle",
  error: null,
  stats: null,
  utilisation: [],
  registrySegments: [],
  recentCommits: [],
  lastRefreshedAt: null,
};

interface OverviewPayload {
  stats: OverviewStats;
  /** Agrégat de l'instant présent (moyenne sur tous les nœuds) — le point temporel est ajouté par le reducer. */
  currentUtilisation: { cpuPercent: number; memPercent: number };
  registrySegments: RegistrySegment[];
  recentCommits: GitCommit[];
}

// La vue d'ensemble agrège plusieurs endpoints du contrat (aucune route
// /api/overview dédiée n'est définie dans ARCHITECTURE.md) : conteneurs,
// images, environnements + nœuds, registries et commits GitOps.
export const loadOverview = createAsyncThunk<OverviewPayload>(
  "overview/load",
  async () => {
    const [containers, images, environments, registries, files, commits] = await Promise.all([
      apiGet<ContainerRef[]>("/containers"),
      apiGet<ImageRef[]>("/images"),
      apiGet<Environment[]>("/environments"),
      apiGet<Registry[]>("/registries"),
      apiGet<GitOpsFile[]>("/gitops/files"),
      apiGet<GitCommit[]>("/gitops/commits"),
    ]);

    // Hydrate les nœuds par environnement pour un décompte fiable des nœuds sains.
    const environmentsWithNodes = await Promise.all(
      environments.map(async (env) => {
        if (env.nodes.length > 0) return env;
        try {
          const nodes = await apiGet<Environment["nodes"]>(`/environments/${env.id}/nodes`);
          return { ...env, nodes };
        } catch {
          return env;
        }
      }),
    );

    const allNodes = environmentsWithNodes.flatMap((env) => env.nodes);

    const stats: OverviewStats = {
      activeContainers: containers.filter((c) => c.state === "running").length,
      imagesToUpdate: images.filter((i) => i.status === "update").length,
      healthyNodes: allNodes.filter((n) => n.status === "ok").length,
      totalNodes: allNodes.length,
      driftCount: files.filter((f) => f.drift).length,
    };

    // Moyenne sur tous les nœuds plutôt qu'"un point par nœud" : avec 1-3 nœuds (cas courant
    // ici), un point par nœud sur l'axe X ne forme pas une courbe lisible — voir le
    // commentaire sur OverviewState#utilisation. Le point temporel réel est ajouté par le
    // reducer à chaque fetch (voir loadOverview.fulfilled), constituant un historique au fil
    // des rafraîchissements successifs plutôt qu'un instantané remplacé à chaque fois.
    const currentUtilisation = {
      cpuPercent: allNodes.length > 0 ? allNodes.reduce((s, n) => s + n.cpuPercent, 0) / allNodes.length : 0,
      memPercent: allNodes.length > 0 ? allNodes.reduce((s, n) => s + n.memPercent, 0) / allNodes.length : 0,
    };

    const registrySegments: RegistrySegment[] = registries.map((r) => ({
      kind: r.kind,
      name: r.name,
      value: r.trackedImages,
    }));

    return {
      stats,
      currentUtilisation,
      registrySegments,
      recentCommits: commits.slice(0, 6),
    };
  },
);

const overviewSlice = createSlice({
  name: "overview",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadOverview.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(loadOverview.fulfilled, (state, action) => {
        state.status = "ready";
        state.stats = action.payload.stats;
        state.registrySegments = action.payload.registrySegments;
        state.recentCommits = action.payload.recentCommits;
        state.lastRefreshedAt = new Date().toISOString();

        const label = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        state.utilisation.push({ label, ...action.payload.currentUtilisation });
        if (state.utilisation.length > HISTORY_LIMIT) {
          state.utilisation = state.utilisation.slice(-HISTORY_LIMIT);
        }
      })
      .addCase(loadOverview.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger la vue d'ensemble.";
      });
  },
});

export default overviewSlice.reducer;
