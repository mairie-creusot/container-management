/**
 * Client Docker Hub — Hub API publique (hub.docker.com/v2).
 *
 * Pour un dépôt privé, l'API Docker Hub exige un jeton JWT obtenu via
 * POST /v2/users/login/ (identifiant + mot de passe, ou un Personal Access Token utilisé
 * comme mot de passe) — pas un simple en-tête PRIVATE-TOKEN comme GitLab. Les identifiants
 * viennent du registry Docker Hub configuré via l'assistant (identifiant + jeton/mot de
 * passe), sinon de DOCKERHUB_USERNAME/DOCKERHUB_TOKEN (env). Sans identifiants, seul l'accès
 * anonyme (dépôts publics) est utilisé.
 *
 * IMPORTANT — repli de développement : si l'appel réseau échoue (pas d'accès Internet en
 * environnement de dev, timeout, 404...), listTags retombe sur une liste de démonstration
 * basée sur le jeu de données de src/services/demoData.ts. Ce n'est PAS un mock permanent.
 */

import { config } from "../../config.js";
import { demoStore } from "../demoData.js";
import { getEffectiveRegistryCredentialsForImage } from "../setupStore.js";
import { fetchJson, RegistryHttpError } from "./http.js";

interface DockerHubLoginResponse {
  token: string;
}

interface DockerHubTagsResponse {
  results: Array<{ name: string }>;
  next: string | null;
}

interface DockerHubRepoResponse {
  results: Array<{ name: string; namespace: string; is_private: boolean; description: string | null }>;
  next: string | null;
}

function splitImageName(image: string): { namespace: string; repository: string } {
  const parts = image.split("/");
  if (parts.length === 1) {
    return { namespace: "library", repository: parts[0]! };
  }
  const [namespace, repository] = parts;
  return { namespace: namespace!, repository: repository! };
}

function demoFallbackTags(image: string): string[] {
  const demoImage = demoStore.images.find((i) => i.name === image && i.registry === "dockerhub");
  if (!demoImage) return [];
  return Array.from(new Set([demoImage.currentTag, demoImage.latestTag]));
}

/**
 * Identifiants effectifs : ceux du registry Docker Hub configuré via l'assistant, sinon les
 * variables d'environnement. `target` (nom d'image complet, ou namespace déjà isolé) désambiguïse
 * entre PLUSIEURS comptes Docker Hub configurés (ex: compte pro + compte perso) — voir
 * setupStore.ts#getEffectiveRegistryCredentialsForImage. Une image officielle sans namespace
 * (ex: "nginx") ne peut être rapprochée d'aucun compte précis : repli sur le premier configuré,
 * sans conséquence puisqu'aucune authentification n'est requise pour un dépôt public.
 */
async function resolveCredentials(target?: string): Promise<{ username: string; password: string } | null> {
  const persisted = await getEffectiveRegistryCredentialsForImage("dockerhub", target ?? "");
  const persistedPassword = persisted?.password ?? persisted?.token;
  if (persisted?.username && persistedPassword) {
    return { username: persisted.username, password: persistedPassword };
  }
  if (config.registries.dockerhub.username && config.registries.dockerhub.token) {
    return { username: config.registries.dockerhub.username, password: config.registries.dockerhub.token };
  }
  return null;
}

/** En-tête Authorization Bearer via le flux de login JWT, ou {} pour un accès anonyme. */
async function resolveAuthHeaders(target?: string): Promise<Record<string, string>> {
  const credentials = await resolveCredentials(target);
  if (!credentials) return {};

  try {
    const login = await fetchJson<DockerHubLoginResponse>("https://hub.docker.com/v2/users/login/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    return { Authorization: `Bearer ${login.token}` };
  } catch {
    // Identifiants invalides ou service de login injoignable : on retombe sur un accès
    // anonyme plutôt que de faire échouer tout l'appel — au pire un dépôt privé restera
    // sur les données de démonstration, ce qui est déjà le comportement de repli standard.
    return {};
  }
}

/**
 * Liste les dépôts (images) réellement présents dans un namespace Docker Hub — le vrai
 * catalogue distant, pas seulement les images déjà tirées localement. `namespace` par défaut :
 * l'identifiant configuré pour ce registry (compte personnel/org Docker Hub), sinon "library"
 * (images officielles).
 */
export async function listNamespaceRepositories(namespace?: string): Promise<string[]> {
  const credentials = await resolveCredentials(namespace);
  const ns = namespace ?? credentials?.username ?? "library";
  const headers = await resolveAuthHeaders(namespace);
  const repos: string[] = [];
  let url: string | null = `https://hub.docker.com/v2/repositories/${encodeURIComponent(ns)}/?page_size=100`;

  try {
    while (url) {
      const data: DockerHubRepoResponse = await fetchJson<DockerHubRepoResponse>(url, { headers });
      repos.push(...data.results.map((r) => `${r.namespace}/${r.name}`));
      url = data.next;
    }
    return repos;
  } catch (err) {
    // Échec en cours de pagination avec déjà des résultats en main : on les rend tels quels
    // (comportement historique), l'utilisateur a un catalogue partiel mais utilisable. Échec
    // dès la première page (rien récupéré du tout) : on laisse remonter pour que l'appelant
    // (registries/index.ts) construise un diagnostic précis au lieu d'un [] silencieux.
    if (repos.length > 0) {
      if (err instanceof RegistryHttpError) {
        // eslint-disable-next-line no-console
        console.warn(`[dockerhub] listNamespaceRepositories("${ns}") failed mid-pagination (${err.message}), returning ${repos.length} repo(s) already fetched`);
      }
      return repos;
    }
    throw err;
  }
}

/** Liste les tags disponibles pour une image Docker Hub (ex: "nginx", "postgres"). */
export async function listTags(image: string): Promise<string[]> {
  const { namespace, repository } = splitImageName(image);
  const url = `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}/tags?page_size=100&ordering=last_updated`;

  try {
    const headers = await resolveAuthHeaders(image);
    const data = await fetchJson<DockerHubTagsResponse>(url, { headers });
    return data.results.map((r) => r.name);
  } catch (err) {
    if (err instanceof RegistryHttpError) {
      // eslint-disable-next-line no-console
      console.warn(`[dockerhub] listTags("${image}") failed (${err.message}), falling back to demo data`);
    }
    return demoFallbackTags(image);
  }
}
