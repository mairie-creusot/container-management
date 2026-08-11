/** Dispatch vers le client registry adapté au type d'image (RegistryKind). */

import { demoStore } from "../demoData.js";
import type { ImageRef, RegistryKind } from "../../types.js";
import * as dockerhub from "./dockerhub.js";
import * as ghcr from "./ghcr.js";
import * as gitlab from "./gitlab.js";

export async function listTagsForImage(image: Pick<ImageRef, "name" | "registry">): Promise<string[]> {
  switch (image.registry) {
    case "dockerhub":
      return dockerhub.listTags(image.name);
    case "ghcr":
      return ghcr.listTags(image.name);
    case "gitlab":
      return gitlab.listTags(image.name);
    case "harbor": {
      // Pas de client Harbor implémenté dans ce premier lot (cf. ARCHITECTURE.md,
      // Harbor listé comme RegistryKind mais hors périmètre initial) : repli direct
      // sur les données de démonstration.
      const demoImage = demoStore.images.find((i) => i.name === image.name && i.registry === "harbor");
      return demoImage ? Array.from(new Set([demoImage.currentTag, demoImage.latestTag])) : [];
    }
    default: {
      const exhaustiveCheck: never = image.registry;
      throw new Error(`Unsupported registry kind: ${String(exhaustiveCheck)}`);
    }
  }
}

export function registryKindFromImageName(name: string): RegistryKind {
  if (name.startsWith("ghcr.io/")) return "ghcr";
  if (name.includes("gitlab")) return "gitlab";
  if (name.includes("harbor")) return "harbor";
  return "dockerhub";
}

/**
 * Utilisé par l'assistant de configuration (POST /api/setup/test/registry) : vérifie
 * qu'un registry candidat est joignable, sans dépendre d'une image précise à suivre.
 */
export async function testRegistryConnection(
  kind: RegistryKind,
  url: string,
  token?: string,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let endpoint: string;
    const headers: Record<string, string> = {};
    switch (kind) {
      case "dockerhub":
        endpoint = "https://hub.docker.com/v2/";
        break;
      case "ghcr":
        endpoint = "https://ghcr.io/v2/";
        break;
      case "gitlab":
      case "harbor":
        endpoint = `${url.replace(/\/$/, "")}/api/v4/version`;
        if (token) headers["PRIVATE-TOKEN"] = token;
        break;
    }
    // Une réponse HTTP (même 401/403 pour un endpoint qui exige une auth qu'on n'a pas
    // encore testée) prouve que l'hôte est joignable ; seule une erreur réseau/timeout
    // signale une configuration invalide.
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    return { ok: true, message: `Registry reachable (HTTP ${response.status})` };
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError" ? "Request timed out" : String(err);
    return { ok: false, message: `Registry not reachable: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}
