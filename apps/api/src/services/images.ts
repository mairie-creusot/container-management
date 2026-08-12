/**
 * Suivi des images (registries multi-sources) : liste des images suivies (jeu de
 * démonstration comme socle, cf. src/services/demoData.ts) enrichie du dernier tag
 * disponible en interrogeant le registry concerné (src/services/registries/*).
 *
 * L'appel registry est best-effort par image et ne bloque jamais la réponse : en cas
 * d'échec (réseau, auth, timeout), le latestTag/status déjà connu (démo) est conservé.
 */

import { demoStore } from "./demoData.js";
import { getLocalDockerImages, pullImage, removeDockerImage } from "./docker.js";
import { listTagsForImage, registryKindFromImageName } from "./registries/index.js";
import type { ImageRef } from "../types.js";

const LOCAL_ID_PREFIX = "local:";

/**
 * Cache mémoire process (TTL court) du résultat déjà enrichi de getImages() — voir
 * docs/reports/optimization-audit-2026-08-12.md §É1 : sans lui, chacun des 8 sites d'appel
 * (dont le watchdog toutes les 75s et GET /api/topology pollée toutes les 9s) refait un
 * aller-retour registry complet par image locale suivie, mesuré à 3831ms sur /api/topology
 * en conditions réelles. 30s absorbe largement l'écart mesuré (deux salves à 4s d'intervalle)
 * sans jamais servir une donnée "dernier tag disponible" perceptiblement périmée (mono-process,
 * voir docker-compose.dev.yml — pas de risque de divergence inter-instance).
 */
const IMAGES_CACHE_TTL_MS = 30_000;
let imagesCache: { at: number; data: ImageRef[] } | null = null;

/** Invalide le cache — appelé après toute mutation locale (pull/rm) pour ne jamais renvoyer un
 * état obsolète juste après que l'appelant vient de le changer lui-même. */
function invalidateImagesCache(): void {
  imagesCache = null;
}

/** true si l'id désigne une image réelle de l'hôte (voir imageRefsFromLocalDocker ci-dessous), pas une entrée de démo. */
function isLocalImageId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** "local:nginx:1.27" -> "nginx:1.27" (référence exploitable par dockerode). */
function repoTagFromLocalId(id: string): string {
  return id.slice(LOCAL_ID_PREFIX.length);
}

function compareNumericVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const na = partsA[i] ?? 0;
    const nb = partsB[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Meilleur tag "sémantique" parmi une liste de tags (ex: ["1.2.0","1.3.0","latest"] -> "1.3.0"). */
function pickLatestTag(tags: string[]): string | undefined {
  const numericTags = tags.filter((t) => /^\d+(\.\d+)*$/.test(t));
  if (numericTags.length === 0) return undefined;
  return [...numericTags].sort(compareNumericVersions).at(-1);
}

async function withRefreshedLatestTag(image: ImageRef): Promise<ImageRef> {
  try {
    const tags = await listTagsForImage(image);
    const latestTag = pickLatestTag(tags) ?? image.latestTag;
    return { ...image, latestTag, status: latestTag === image.currentTag ? "uptodate" : "update" };
  } catch {
    return image;
  }
}

/**
 * Convertit les images Docker réellement présentes sur l'hôte (docker.ts#getLocalDockerImages)
 * en ImageRef. `latestTag`/`status` sont provisoirement égaux à `currentTag` — corrigés juste
 * après par withRefreshedLatestTag, qui interroge le vrai registry d'origine.
 */
function imageRefsFromLocalDocker(local: Awaited<ReturnType<typeof getLocalDockerImages>>): ImageRef[] {
  return local.map((img) => ({
    id: `local:${img.name}:${img.tag}`,
    name: img.name,
    registry: registryKindFromImageName(img.name),
    currentTag: img.tag,
    latestTag: img.tag,
    environment: "Dev local",
    status: "uptodate",
    digest: img.digest,
    sizeBytes: img.sizeBytes,
    layers: 0, // `docker images` seul ne donne pas le nombre de couches sans un appel history() par image
  }));
}

/**
 * Liste les images à afficher : celles réellement présentes sur le Docker de l'hôte quand il
 * est joignable (PAS le jeu de démonstration — voir docker.ts#getLocalDockerImages), avec
 * repli sur le jeu de démonstration seulement si Docker est injoignable ou ne renvoie aucune
 * image locale. Chaque image est enrichie du dernier tag disponible sur son registry d'origine.
 */
export async function getImages(status?: ImageRef["status"]): Promise<ImageRef[]> {
  const now = Date.now();
  let refreshed: ImageRef[];
  if (imagesCache && now - imagesCache.at < IMAGES_CACHE_TTL_MS) {
    refreshed = imagesCache.data;
  } else {
    const local = await getLocalDockerImages();
    const base = local.length > 0 ? imageRefsFromLocalDocker(local) : demoStore.images;
    refreshed = await Promise.all(base.map(withRefreshedLatestTag));
    imagesCache = { at: now, data: refreshed };
  }
  return status ? refreshed.filter((i) => i.status === status) : refreshed;
}

export class ImagePullError extends Error {}

/** Tire une nouvelle image (équivalent `docker pull <reference>`) — voir docker.ts#pullImage. */
export async function pullNewImage(reference: string): Promise<void> {
  try {
    await pullImage(reference);
    invalidateImagesCache(); // nouvelle image locale : le prochain getImages() doit la voir tout de suite
  } catch (err) {
    throw new ImagePullError(err instanceof Error ? err.message : String(err));
  }
}

export class ImageNotFoundError extends Error {}

/**
 * Déclenche la mise à jour explicite d'une image vers son dernier tag connu.
 *
 * Pour une image réelle de l'hôte (id "local:...") : un vrai `docker pull nom:dernierTag` —
 * télécharge la nouvelle version localement (les conteneurs existants continuent de tourner
 * sur l'ancienne image jusqu'à être recréés, comme avec `docker pull` en CLI). Pour le jeu de
 * démonstration (Docker injoignable) : simple mise à jour du jeu de données en mémoire.
 */
export async function updateImage(id: string): Promise<ImageRef> {
  if (isLocalImageId(id)) {
    const current = (await getImages()).find((i) => i.id === id);
    if (!current) throw new ImageNotFoundError(`Image "${id}" not found`);
    try {
      await pullImage(`${current.name}:${current.latestTag}`);
      invalidateImagesCache(); // le pull vient de changer l'état local : ne pas relire le cache d'avant
    } catch (err) {
      throw new ImagePullError(err instanceof Error ? err.message : String(err));
    }
    const refreshed = (await getImages()).find(
      (i) => i.name === current.name && i.currentTag === current.latestTag,
    );
    return refreshed ?? { ...current, currentTag: current.latestTag, status: "uptodate" };
  }

  const index = demoStore.images.findIndex((i) => i.id === id);
  if (index === -1) {
    throw new ImageNotFoundError(`Image "${id}" not found`);
  }
  const current = demoStore.images[index]!;
  const updated: ImageRef = { ...current, currentTag: current.latestTag, status: "uptodate" };
  demoStore.images[index] = updated;
  return updated;
}

/** Supprime une image (équivalent `docker rmi`) — uniquement pour une image réelle de l'hôte. */
export async function deleteImage(id: string, force: boolean): Promise<void> {
  if (!isLocalImageId(id)) {
    throw new ImageNotFoundError(`Image "${id}" not found (demo entries cannot be deleted)`);
  }
  await removeDockerImage(repoTagFromLocalId(id), force);
  invalidateImagesCache(); // image supprimée : ne pas continuer à la servir depuis le cache jusqu'au TTL
}
