// Recherche d'images publiques Docker Hub (GET /api/dockerhub/*, proxy côté serveur) — module
// autonome comme packagesApi.ts : types locaux, rien dans templatesSlice/types.ts.
import { apiGet } from "@/api/client";

export interface DockerHubImage {
  name: string;
  description?: string;
  stars: number;
  official: boolean;
}

export type DockerHubSearchOutcome = { state: "ok"; results: DockerHubImage[] } | { state: "unavailable" };

/** Toute erreur (502 amont, backend absent…) -> "unavailable" : la saisie libre reste le repli,
 * jamais de fausse liste. */
export async function searchDockerHubImages(q: string): Promise<DockerHubSearchOutcome> {
  try {
    const res = await apiGet<{ results: DockerHubImage[] }>(`/dockerhub/search?q=${encodeURIComponent(q)}`);
    return { state: "ok", results: res.results ?? [] };
  } catch {
    return { state: "unavailable" };
  }
}

export type DockerHubTagsOutcome = { state: "ok"; tags: string[] } | { state: "unavailable" };

/** Tags d'un repo (30 max, plus récents d'abord côté serveur) — "latest" remonté en tête ici. */
export async function fetchDockerHubTags(repo: string): Promise<DockerHubTagsOutcome> {
  try {
    const res = await apiGet<{ tags: string[] }>(`/dockerhub/tags?repo=${encodeURIComponent(repo)}`);
    const tags = res.tags ?? [];
    return { state: "ok", tags: tags.includes("latest") ? ["latest", ...tags.filter((t) => t !== "latest")] : tags };
  } catch {
    return { state: "unavailable" };
  }
}
