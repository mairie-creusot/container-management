/**
 * Vue "Registry" (statut + compteur d'images suivies) construite à partir des registries
 * réellement persistés par l'assistant de configuration (setupStore.ts, config.json) — PAS
 * un CRUD en mémoire séparé. Repli sur le jeu de données de démonstration uniquement si
 * aucun registry n'est configuré du tout (même principe que docker.ts/images.ts).
 *
 * "status: connected" reflète l'accessibilité réseau du registry (testRegistryConnection),
 * pas une validation complète des identifiants pour chaque dépôt privé — voir la note dans
 * registries/index.ts#testRegistryConnection. C'est la même limitation que le test affiché
 * pendant l'assistant de configuration.
 */

import { addRegistry as persistRegistry, getCurrent, getEffectiveRegistryCredentials } from "./setupStore.js";
import type { SetupRegistryConfig } from "./setupStore.js";
import { getLocalDockerImages } from "./docker.js";
import type { LocalDockerImage } from "./docker.js";
import { registryKindFromImageName, testRegistryConnection } from "./registries/index.js";
import { listOrgPackages } from "./registries/ghcr.js";
import { demoStore } from "./demoData.js";
import type { Registry, RegistryKind } from "../types.js";

/** "ghcr.io/mairie-creusot/foo" -> "mairie-creusot" — pas d'org configurable dans l'assistant
 * aujourd'hui, donc déduite d'une image ghcr.io déjà tirée localement (best-effort). */
function inferGhcrOrg(localImages: LocalDockerImage[]): string | null {
  for (const img of localImages) {
    if (!img.name.startsWith("ghcr.io/")) continue;
    const org = img.name.slice("ghcr.io/".length).split("/")[0];
    if (org) return org;
  }
  return null;
}

async function buildRegistryView(persisted: SetupRegistryConfig, index: number): Promise<Registry> {
  const localImages = await getLocalDockerImages();
  const localCount = localImages.filter((img) => registryKindFromImageName(img.name) === persisted.kind).length;
  const base = { id: `reg-${persisted.kind}-${index}`, kind: persisted.kind, name: persisted.name, url: persisted.url };

  // Sans identifiants (ajouté via POST /api/registries sans passer par l'assistant) : pas de
  // test réseau, "unconfigured" — un registry public répondrait quand même 200, ce qui
  // donnerait un "connecté" trompeur pour un registry qu'on n'a en fait jamais authentifié.
  const credentials = await getEffectiveRegistryCredentials(persisted.kind);
  if (!credentials?.username && !credentials?.password && !credentials?.token) {
    return { ...base, status: "unconfigured", trackedImages: localCount, lastSyncAt: null };
  }

  const test = await testRegistryConnection(persisted.kind, persisted.url, credentials.token ?? credentials.password);

  // "Images suivies" = le vrai catalogue distant quand on peut l'interroger (ex: GHCR via
  // l'API GitHub Packages), pas seulement ce qui a déjà été tiré localement — sinon un
  // registry avec 11 packages distants mais 2 images pull_ées localement affichait "2",
  // trompeur pour un registry qu'on vient de configurer.
  let trackedImages = localCount;
  if (persisted.kind === "ghcr") {
    const org = inferGhcrOrg(localImages);
    if (org) {
      const packages = await listOrgPackages(org);
      if (packages.length > 0) trackedImages = packages.length;
    }
  }

  return {
    ...base,
    status: test.ok ? "connected" : "error",
    trackedImages,
    lastSyncAt: test.ok ? new Date().toISOString() : null,
  };
}

export async function listRegistries(): Promise<Registry[]> {
  const current = await getCurrent();
  const persisted = current.registries ?? [];
  if (persisted.length === 0) return demoStore.registries; // rien configuré : repli démo
  return Promise.all(persisted.map((r, index) => buildRegistryView(r, index)));
}

export async function getRegistry(id: string): Promise<Registry | undefined> {
  const all = await listRegistries();
  return all.find((r) => r.id === id);
}

export interface CreateRegistryInput {
  kind: RegistryKind;
  name: string;
  url: string;
}

/** Ajoute un registry (sans identifiants — utiliser l'assistant pour un dépôt privé). */
export async function createRegistry(input: CreateRegistryInput): Promise<Registry> {
  await persistRegistry({ kind: input.kind, name: input.name, url: input.url });
  const all = await listRegistries();
  const created = [...all].reverse().find((r) => r.kind === input.kind && r.name === input.name);
  if (!created) throw new Error("Failed to create registry");
  return created;
}
