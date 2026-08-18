// Recherche RÉELLE de paquets par nom via l'API publique Repology (cross-distro, JSON documenté :
// https://repology.org/api) — studio de templates, étape "packages". Aucune donnée inventée : en
// cas d'échec amont, l'erreur remonte (le frontend garde la saisie libre en repli).

export interface PackageSearchResult {
  name: string;
  version?: string;
  summary?: string;
}

interface RepologyPackage {
  repo?: string;
  name?: string;
  binname?: string;
  srcname?: string;
  visiblename?: string;
  version?: string;
  summary?: string;
}

const REPOLOGY_BASE = "https://repology.org/api/v1/projects/";
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const MAX_RESULTS = 30;

// Repology demande un User-Agent identifiant (politique d'usage de leur API).
const USER_AGENT = "QUAI-container-management (mairie-creusot; package search)";

const DISTRO_REPO_PREFIX: Record<string, string> = {
  debian: "debian_",
  ubuntu: "ubuntu_",
  alpine: "alpine_",
  fedora: "fedora_",
  arch: "arch",
};

const cache = new Map<string, { at: number; results: PackageSearchResult[] }>();

export function repoPrefixForDistro(distro: string): string | undefined {
  return DISTRO_REPO_PREFIX[distro.toLowerCase()];
}

/** Extrait, pour chaque projet Repology, l'entrée du dépôt le plus récent de la distro demandée. */
export function extractPackages(payload: Record<string, RepologyPackage[]>, repoPrefix: string): PackageSearchResult[] {
  const results: PackageSearchResult[] = [];
  for (const [project, entries] of Object.entries(payload)) {
    if (!Array.isArray(entries)) continue;
    const matching = entries.filter((e) => typeof e.repo === "string" && e.repo.startsWith(repoPrefix));
    if (matching.length === 0) continue;
    // Tri par nom de dépôt : "debian_13" > "debian_12" — l'entrée la plus récente gagne.
    matching.sort((a, b) => (b.repo ?? "").localeCompare(a.repo ?? ""));
    const best = matching[0]!;
    const name = best.binname ?? best.name ?? best.visiblename ?? best.srcname ?? project;
    results.push({
      name,
      ...(best.version ? { version: best.version } : {}),
      ...(best.summary ? { summary: best.summary } : {}),
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results.slice(0, MAX_RESULTS);
}

export async function searchPackages(distro: string, query: string): Promise<PackageSearchResult[]> {
  const repoPrefix = repoPrefixForDistro(distro);
  if (!repoPrefix) throw new Error(`Unsupported distro "${distro}" — supported: ${Object.keys(DISTRO_REPO_PREFIX).join(", ")}`);

  const cacheKey = `${repoPrefix}:${query.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

  // Pas de filtre `inrepo` : il exige un id de dépôt exact (ex "debian_12") qu'on ne veut pas
  // figer — le filtrage par préfixe se fait localement dans extractPackages.
  const url = `${REPOLOGY_BASE}?search=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Repology answered ${response.status}`);
  const payload = (await response.json()) as Record<string, RepologyPackage[]>;
  const results = extractPackages(payload, repoPrefix);

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { at: Date.now(), results });
  return results;
}
