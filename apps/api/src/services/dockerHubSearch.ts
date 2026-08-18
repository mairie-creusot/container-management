// Recherche RÉELLE d'images publiques Docker Hub (API v2 publique, sans authentification) —
// studio de templates, base "container". Même patron que packageSearch.ts : cache TTL, timeout,
// erreur amont remontée honnêtement (le frontend garde la saisie libre en repli).

export interface DockerHubImageResult {
  name: string;
  description?: string;
  stars: number;
  official: boolean;
}

interface HubSearchEntry {
  repo_name?: string;
  short_description?: string;
  star_count?: number;
  is_official?: boolean;
}

const HUB_BASE = "https://hub.docker.com/v2";
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const MAX_RESULTS = 25;
const USER_AGENT = "QUAI-container-management (mairie-creusot; image search)";

const searchCache = new Map<string, { at: number; results: DockerHubImageResult[] }>();
const tagsCache = new Map<string, { at: number; tags: string[] }>();

function remember<T>(cache: Map<string, { at: number } & T>, key: string, value: T): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ...value });
}

async function hubFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${HUB_BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Docker Hub answered ${response.status}`);
  return (await response.json()) as T;
}

export async function searchDockerHubImages(query: string): Promise<DockerHubImageResult[]> {
  const key = query.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

  const payload = await hubFetch<{ results?: HubSearchEntry[] }>(
    `/search/repositories/?query=${encodeURIComponent(query)}&page_size=${MAX_RESULTS}`,
  );
  const results = (payload.results ?? [])
    .filter((e) => typeof e.repo_name === "string" && e.repo_name)
    .map((e) => ({
      name: e.repo_name!,
      ...(e.short_description ? { description: e.short_description } : {}),
      stars: e.star_count ?? 0,
      official: e.is_official === true,
    }));
  remember(searchCache, key, { results });
  return results;
}

/** Tags d'un dépôt public — "debian" (officiel) devient "library/debian" côté API Hub. */
export async function listDockerHubTags(repo: string): Promise<string[]> {
  const fullRepo = repo.includes("/") ? repo : `library/${repo}`;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(fullRepo)) {
    throw new Error(`Invalid repository name "${repo}"`);
  }
  const cached = tagsCache.get(fullRepo);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tags;

  const payload = await hubFetch<{ results?: { name?: string }[] }>(
    `/repositories/${fullRepo}/tags/?page_size=30&ordering=last_updated`,
  );
  const tags = (payload.results ?? []).map((t) => t.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  remember(tagsCache, fullRepo, { tags });
  return tags;
}
