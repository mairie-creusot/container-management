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
import { getEffectiveRegistryCredentials } from "../setupStore.js";
import { fetchJson, RegistryHttpError } from "./http.js";

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

async function authHeaders(): Promise<Record<string, string>> {
  const persisted = await getEffectiveRegistryCredentials("gitlab");
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
      { headers: await authHeaders() },
    );

    const repository = repositories.find((r) => r.location === image) ?? repositories[0];
    if (!repository) {
      throw new RegistryHttpError(`No container registry repository found for project ${projectPath}`);
    }

    const tags = await fetchJson<GitlabRegistryTag[]>(
      `${apiBase}/projects/${encodedProject}/registry/repositories/${repository.id}/tags`,
      { headers: await authHeaders() },
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
