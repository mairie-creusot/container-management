/**
 * Client GitLab Container Registry — API REST GitLab v4
 * (GET /projects/:id/registry/repositories puis /:repository_id/tags).
 *
 * Le host de registry (ex: "registry.gitlab.com") est utilisé pour dériver l'API GitLab
 * correspondante (https://{host}/api/v4), ce qui fonctionne aussi bien pour gitlab.com que
 * pour une instance GitLab auto-hébergée dont le registry a le même host que l'instance.
 *
 * IMPORTANT — repli de développement : si l'appel réseau échoue (pas d'accès Internet,
 * timeout, 404, projet privé sans token...), listTags retombe sur une liste de
 * démonstration basée sur src/services/demoData.ts. Ce n'est PAS un mock permanent.
 */

import { config } from "../../config.js";
import { demoStore } from "../demoData.js";
import { getEffectiveRegistryCredentialsForImage } from "../setupStore.js";
import { fetchJson, RegistryCredentialsMissingError, RegistryHttpError } from "./http.js";

interface GitlabRegistryRepository {
  id: number;
  path: string;
  location: string;
}

interface GitlabRegistryTag {
  name: string;
}

function parseImage(image: string): { apiBase: string; projectPath: string } {
  const [host, ...rest] = image.split("/");
  const projectPath = rest.join("/");
  return { apiBase: `https://${host}/api/v4`, projectPath };
}

function demoFallbackTags(image: string): string[] {
  const demoImage = demoStore.images.find((i) => i.name === image && i.registry === "gitlab");
  if (!demoImage) return [];
  return Array.from(new Set([demoImage.currentTag, demoImage.latestTag]));
}

/** `image` (nom d'image complet "host/groupe/projet") désambiguïse entre PLUSIEURS instances
 * GitLab auto-hébergées configurées — rapprochement par HÔTE (voir
 * setupStore.ts#findBestRegistryMatch), aucune ambiguïté réelle entre elles puisque chacune a
 * nécessairement un hôte distinct. */
async function authHeaders(image?: string): Promise<Record<string, string>> {
  const persisted = await getEffectiveRegistryCredentialsForImage("gitlab", image ?? "");
  const token = persisted?.token ?? config.registries.gitlab.token;
  return token ? { "PRIVATE-TOKEN": token } : {};
}

/**
 * Liste les tags disponibles pour une image GitLab Registry
 * (ex: "registry.gitlab.com/mairie/api-etat-civil").
 */
export async function listTags(image: string): Promise<string[]> {
  const { apiBase, projectPath } = parseImage(image);
  const encodedProject = encodeURIComponent(projectPath);

  try {
    const repositories = await fetchJson<GitlabRegistryRepository[]>(
      `${apiBase}/projects/${encodedProject}/registry/repositories?tags_count=false`,
      { headers: await authHeaders(image) },
    );

    const repository = repositories.find((r) => r.location === image) ?? repositories[0];
    if (!repository) {
      throw new RegistryHttpError(`No container registry repository found for project ${projectPath}`);
    }

    const tags = await fetchJson<GitlabRegistryTag[]>(
      `${apiBase}/projects/${encodedProject}/registry/repositories/${repository.id}/tags`,
      { headers: await authHeaders(image) },
    );
    return tags.map((t) => t.name);
  } catch (err) {
    if (err instanceof RegistryHttpError) {
      // eslint-disable-next-line no-console
      console.warn(`[gitlab] listTags("${image}") failed (${err.message}), falling back to demo data`);
    }
    return demoFallbackTags(image);
  }
}

/**
 * Dépôts du registre RÉELLEMENT présents dans un groupe GitLab
 * (GET /groups/:id/registry/repositories) — `location` porte déjà la référence complète de
 * l'image, telle qu'un `docker pull` l'attend, y compris quand le registre est servi sous un
 * autre nom d'hôte que l'instance (cas d'un GitLab publié derrière un reverse proxy).
 *
 * `baseUrl` est l'URL de l'INSTANCE GitLab, pas celle du registre : c'est l'API GitLab qui
 * répond ici. Un namespace qui n'est pas un groupe (projet isolé, espace personnel) déclenche un
 * repli sur l'API de projet plutôt qu'un échec sec.
 */
export async function listGroupRepositories(baseUrl: string, namespace: string): Promise<string[]> {
  // authHeaders rapproche par HÔTE (plusieurs instances GitLab possibles) : on lui passe donc
  // l'hôte, pas l'URL complète.
  const headers = await authHeaders(baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!headers["PRIVATE-TOKEN"]) {
    throw new RegistryCredentialsMissingError(
      "aucun jeton GitLab configuré — ajoutez-en un via l'icône engrenage du registry (jeton d'accès avec la portée read_api)",
    );
  }
  const apiBase = `${baseUrl.replace(/\/+$/, "")}/api/v4`;
  const encoded = encodeURIComponent(namespace);
  const query = "per_page=100";
  try {
    const repositories = await fetchJson<GitlabRegistryRepository[]>(
      `${apiBase}/groups/${encoded}/registry/repositories?${query}`,
      { headers },
    );
    return repositories.map((r) => r.location);
  } catch (err) {
    if (err instanceof RegistryHttpError && err.status === 404) {
      const repositories = await fetchJson<GitlabRegistryRepository[]>(
        `${apiBase}/projects/${encoded}/registry/repositories?${query}`,
        { headers },
      );
      return repositories.map((r) => r.location);
    }
    throw err;
  }
}
