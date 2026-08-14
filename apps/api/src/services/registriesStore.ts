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

import {
  addRegistry as persistRegistry,
  decryptRegistryCredentials,
  getCurrent,
  removeRegistryAt,
  updateRegistryAt,
} from "./setupStore.js";
import type { RegistryPatch, SetupRegistryConfig } from "./setupStore.js";
import { getLocalDockerImages } from "./docker.js";
import type { LocalDockerImage } from "./docker.js";
import { registryKindFromImageName, testRegistryConnection } from "./registries/index.js";
import { listOrgPackages } from "./registries/ghcr.js";
import { demoStore } from "./demoData.js";
import type { Registry, RegistryKind } from "../types.js";

/** "ghcr.io/mairie-creusot/foo" -> "mairie-creusot" — pas d'org configurable dans l'assistant
 * aujourd'hui, donc déduite d'une image ghcr.io déjà tirée localement (best-effort). */
export function inferGhcrOrg(localImages: LocalDockerImage[]): string | null {
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
  //
  // Déchiffrement DIRECT de `persisted` (l'entrée précise, pas une recherche par kind) : avec
  // plusieurs registries du même kind (ex: deux comptes GHCR), une résolution par kind seul
  // aurait donné les identifiants de la PREMIÈRE entrée à toutes les vues, faisant apparaître
  // le second registry comme "connecté"/"error" avec le statut du premier au lieu du sien.
  const credentials = decryptRegistryCredentials(persisted);
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
    // Priorité au nom d'utilisateur/organisation explicitement configuré (icône engrenage) —
    // même règle que registries.ts#namespace pour GET .../repositories, voir ce fichier pour
    // le pourquoi (un e-mail n'est pas un org/user GitHub valide).
    const org = persisted.username && !persisted.username.includes("@") ? persisted.username : inferGhcrOrg(localImages);
    if (org) {
      try {
        const packages = await listOrgPackages(org);
        if (packages.length > 0) trackedImages = packages.length;
      } catch {
        // Le compteur "images suivies" reste sur le total local en cas d'échec — le diagnostic
        // précis (identifiants invalides, org introuvable...) est réservé à l'explorateur de
        // registry (GET .../repositories, voir routes/registries.ts), pas à cette vue résumée.
      }
    }
  }

  return {
    ...base,
    status: test.ok ? "connected" : "error",
    trackedImages,
    lastSyncAt: test.ok ? new Date().toISOString() : null,
    ...(test.ok ? {} : { statusDetail: test.message }),
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

/**
 * Retrouve la config persistée (avec identifiants) correspondant à un id de vue (`reg-ghcr-0`)
 * — nécessaire pour parcourir le catalogue distant d'un registry précis (voir routes/registries.ts,
 * l'explorateur de registry), contrairement à `getRegistry()` qui ne renvoie que la vue publique
 * sans secret.
 */
export async function getPersistedRegistryConfig(id: string): Promise<SetupRegistryConfig | undefined> {
  const current = await getCurrent();
  const persisted = current.registries ?? [];
  return persisted.find((r, index) => `reg-${r.kind}-${index}` === id);
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

/**
 * Met à jour un registry existant (nom/URL/identifiants) — permet notamment d'ajouter des
 * identifiants après coup à un registry créé sans (POST /api/registries n'en demande pas),
 * seul cas où il restait bloqué en statut "unconfigured" sans passer par tout l'assistant.
 */
export async function updateRegistry(id: string, patch: RegistryPatch): Promise<Registry | undefined> {
  const current = await getCurrent();
  const persisted = current.registries ?? [];
  const index = persisted.findIndex((r, i) => `reg-${r.kind}-${i}` === id);
  if (index === -1) return undefined;
  await updateRegistryAt(index, patch);
  return getRegistry(id);
}

/**
 * Supprime un registry — retour utilisateur du 14/08/2026 : "manque option pour suprimer", aucune
 * route DELETE n'existait jusqu'ici (limite honnête déjà notée lors du chantier multi-comptes).
 * `false` si l'id n'existe pas/plus. Voir removeRegistryAt (setupStore.ts) pour la mise en garde
 * sur l'instabilité des ids "reg-<kind>-<index>" après une suppression — le frontend doit relire
 * GET /api/registries après coup plutôt que réutiliser un id mémorisé avant la suppression.
 */
export async function deleteRegistry(id: string): Promise<boolean> {
  const current = await getCurrent();
  const persisted = current.registries ?? [];
  const index = persisted.findIndex((r, i) => `reg-${r.kind}-${i}` === id);
  if (index === -1) return false;
  return removeRegistryAt(index);
}
