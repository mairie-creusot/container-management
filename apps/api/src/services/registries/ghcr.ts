/**
 * Client GHCR (GitHub Container Registry) — API de packages GitHub / API OCI distribution.
 *
 * Utilise le flux d'authentification anonyme standard de ghcr.io (token endpoint public,
 * suffisant pour les packages publics) : GET /token puis GET /v2/{repo}/tags/list.
 * Si GHCR_TOKEN est fourni, il est utilisé pour les packages privés.
 *
 * IMPORTANT — repli de développement : si l'appel réseau échoue (pas d'accès Internet,
 * timeout, 404, package privé sans token...), listTags retombe sur une liste de
 * démonstration basée sur src/services/demoData.ts. Ce n'est PAS un mock permanent.
 */

import { config } from "../../config.js";
import { demoStore } from "../demoData.js";
import { getEffectiveRegistryCredentialsForImage } from "../setupStore.js";
import { fetchJson, RegistryCredentialsMissingError, RegistryHttpError } from "./http.js";

interface GhcrTokenResponse {
  token: string;
}

interface GhcrTagsResponse {
  name: string;
  tags: string[];
}

/** Retire le préfixe "ghcr.io/" pour ne garder que "owner/package". */
function stripHost(image: string): string {
  return image.startsWith("ghcr.io/") ? image.slice("ghcr.io/".length) : image;
}

function demoFallbackTags(image: string): string[] {
  const demoImage = demoStore.images.find((i) => i.name === image && i.registry === "ghcr");
  if (!demoImage) return [];
  return Array.from(new Set([demoImage.currentTag, demoImage.latestTag]));
}

/**
 * Jeton effectif : celui du registry GHCR configuré via l'assistant, sinon GHCR_TOKEN (env).
 * `.password` est aussi accepté (pas seulement `.token`) : GitHub demande un PAT comme mot de
 * passe pour `docker login ghcr.io`, c'est ce que l'assistant collecte pour ce type de
 * registry — ignorer `.password` aurait laissé tous les appels GHCR anonymes malgré des
 * identifiants réellement saisis.
 *
 * `target` (nom d'image complet "ghcr.io/org/pkg", ou org/user déjà isolé) désambiguïse entre
 * PLUSIEURS registries GHCR configurés (ex: compte pro + compte perso) — voir
 * setupStore.ts#getEffectiveRegistryCredentialsForImage. Omis (ex: repli générique de
 * githubStore.ts) : retombe sur la première entrée GHCR configurée, comme avant.
 */
async function resolveToken(target?: string): Promise<string | undefined> {
  const persisted = await getEffectiveRegistryCredentialsForImage("ghcr", target ?? "");
  return persisted?.token ?? persisted?.password ?? config.registries.ghcr.token;
}

async function getAnonymousToken(repository: string): Promise<string> {
  const url = `https://ghcr.io/token?service=ghcr.io&scope=repository:${encodeURIComponent(repository)}:pull`;
  const headers: Record<string, string> = {};
  const token = await resolveToken(repository);
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await fetchJson<GhcrTokenResponse>(url, { headers });
  return data.token;
}

interface GhcrOrgPackage {
  name: string;
}

async function fetchPackages(ownerKind: "orgs" | "users", owner: string, token: string): Promise<string[]> {
  const packages = await fetchJson<GhcrOrgPackage[]>(
    `https://api.github.com/${ownerKind}/${encodeURIComponent(owner)}/packages?package_type=container&per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  return packages.map((p) => p.name);
}

/**
 * Liste les packages (images) réellement présents dans un org/user GHCR — API REST GitHub
 * (api.github.com), PAS l'API OCI distribution (ghcr.io/v2/...) utilisée par listTags : ce
 * sont deux API GitHub distinctes. Nécessite un jeton avec la permission `read:packages`.
 * Utilisé pour que "images suivies" sur la page Registries reflète le vrai catalogue distant,
 * pas seulement les images de ce registry déjà tirées localement (voir registriesStore.ts).
 *
 * Ne masque plus les échecs derrière un `[]` silencieux : lève RegistryCredentialsMissingError
 * (aucun jeton) ou RegistryHttpError (401/403/404/réseau) pour que l'appelant (registries/index.ts)
 * puisse construire un diagnostic précis plutôt que de laisser l'explorateur afficher un vague
 * "aucun dépôt trouvé" sans dire pourquoi.
 */
export async function listOrgPackages(owner: string): Promise<string[]> {
  const token = await resolveToken(owner);
  if (!token) {
    throw new RegistryCredentialsMissingError(
      "aucun identifiant GHCR configuré — ajoutez un jeton d'accès via l'icône engrenage du registry",
    );
  }
  try {
    return await fetchPackages("orgs", owner, token);
  } catch (err) {
    // Les packages GHCR peuvent appartenir à un compte GitHub personnel plutôt qu'à une
    // organisation — l'API GitHub distingue /orgs/ et /users/, impossible de savoir lequel sans
    // essayer. Un 404 sur /orgs/ (contrairement à 401/403, qui signalent un vrai problème
    // d'identifiants) déclenche donc un repli sur /users/ avant d'abandonner.
    if (err instanceof RegistryHttpError && err.status === 404) {
      return await fetchPackages("users", owner, token);
    }
    throw err;
  }
}

/** Liste les tags disponibles pour une image GHCR (ex: "ghcr.io/ville-lecreusot/portail-citoyen"). */
export async function listTags(image: string): Promise<string[]> {
  const repository = stripHost(image);

  try {
    const token = await getAnonymousToken(repository);
    const data = await fetchJson<GhcrTagsResponse>(`https://ghcr.io/v2/${repository}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data.tags;
  } catch (err) {
    if (err instanceof RegistryHttpError) {
      // eslint-disable-next-line no-console
      console.warn(`[ghcr] listTags("${image}") failed (${err.message}), falling back to demo data`);
    }
    return demoFallbackTags(image);
  }
}
