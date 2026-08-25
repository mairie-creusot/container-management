/**
 * Vue "Registry" (statut + compteur d'images suivies) construite à partir des registries
 * réellement persistés par l'assistant de configuration (setupStore.ts, config.json) — PAS
 * un CRUD en mémoire séparé. `[]` si aucun registry n'est configuré (plus de repli sur des
 * données de démonstration — bug réel corrigé le 14/08/2026 : un repli qui se fait passer pour
 * de vrais registries modifiables trompe plus qu'il n'aide, voir listRegistries ci-dessous).
 *
 * "status: connected" reflète maintenant un jeu de tests plus complet que la simple
 * joignabilité réseau — voir buildRegistryView ci-dessous (bug réel corrigé le 14/08/2026 :
 * "connected" pouvait rester affiché alors que la vraie interrogation du catalogue échouait en
 * 401, le compteur "images suivies" avalant silencieusement cet échec).
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
import { registryKindFromImageName, testRegistryConnection, diagnosticFromError } from "./registries/index.js";
import { listOrgPackages } from "./registries/ghcr.js";
import { listGroupRepositories } from "./registries/gitlab.js";
import type { Registry, RegistryKind } from "../types.js";

/** "ghcr.io/mairie-creusot/foo" -> "mairie-creusot" — repli de dernier recours quand aucune org
 * n'est explicitement configurée (champ `org`) ni déductible d'un `username` non-email : déduite
 * d'une image ghcr.io déjà tirée localement (best-effort, fragile — voir resolveRegistryOrg). */
export function inferGhcrOrg(localImages: LocalDockerImage[]): string | null {
  for (const img of localImages) {
    if (!img.name.startsWith("ghcr.io/")) continue;
    const org = img.name.slice("ghcr.io/".length).split("/")[0];
    if (org) return org;
  }
  return null;
}

/**
 * SOURCE UNIQUE de la résolution "quelle organisation/quel namespace interroger pour ce
 * registry" — utilisée à la fois par buildRegistryView (compteur "images suivies" ci-dessous) et
 * par routes/registries.ts (GET .../repositories, l'explorateur de catalogue). Avant ce
 * correctif, ces deux appelants réimplémentaient chacun leur propre variante de cette logique
 * (registriesStore.ts ET routes/registries.ts ET registries/ghcr.ts#resolveOrg avaient trois
 * copies quasi identiques) — un pur risque de divergence future, même si en pratique elles
 * calculaient déjà la même chose aujourd'hui (root-cause réelle du bug "3 vs 401" : voir
 * buildRegistryView plus bas, pas une différence d'org entre les deux chemins).
 *
 * Priorité :
 *  1. `persisted.org` explicite (nouveau champ, jamais un e-mail ni une déduction) — le seul
 *     moyen fiable pour l'utilisateur de corriger une déduction erronée.
 *  2. `persisted.username` s'il ne ressemble pas à un e-mail (repli historique : GitHub demande
 *     souvent un e-mail comme identifiant `docker login`, jamais un org/user GitHub valide —
 *     Docker Hub, en revanche, utilise bien le nom d'utilisateur comme namespace).
 *  3. GHCR uniquement : déduit d'une image ghcr.io déjà tirée localement (inferGhcrOrg).
 *  4. undefined si rien n'a pu être déterminé.
 */
export function resolveRegistryOrg(persisted: SetupRegistryConfig, localImages: LocalDockerImage[]): string | undefined {
  const explicitOrg = persisted.org?.trim();
  if (explicitOrg) return explicitOrg;
  if (persisted.kind === "dockerhub") {
    return persisted.username || undefined;
  }
  if (persisted.kind === "ghcr") {
    if (persisted.username && !persisted.username.includes("@")) return persisted.username;
    return inferGhcrOrg(localImages) ?? undefined;
  }
  return undefined;
}

async function buildRegistryView(persisted: SetupRegistryConfig, index: number): Promise<Registry> {
  const localImages = await getLocalDockerImages();
  const localCount = localImages.filter((img) => registryKindFromImageName(img.name) === persisted.kind).length;
  const base = {
    id: `reg-${persisted.kind}-${index}`,
    kind: persisted.kind,
    name: persisted.name,
    url: persisted.url,
    ...(persisted.org ? { org: persisted.org } : {}),
  };

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
    const org = resolveRegistryOrg(persisted, localImages);
    if (org) {
      try {
        const packages = await listOrgPackages(org);
        if (packages.length > 0) trackedImages = packages.length;
      } catch (err) {
        // Bug réel corrigé le 14/08/2026 (retour utilisateur : GET /api/registries répondait
        // "connected"/trackedImages=3 pour un registry dont GET .../repositories répondait
        // "GHCR : identifiants invalides ou expirés (401)" pour le MÊME registry — CONTRADICTOIRE).
        // Root-causé en lisant le code : ce `catch` avalait silencieusement l'échec et laissait
        // `trackedImages` sur `localCount` (le nombre d'images ghcr.io déjà tirées EN LOCAL, sans
        // rapport avec le vrai catalogue distant) tout en laissant `status` à "connected" (basé
        // uniquement sur `testRegistryConnection`, qui ne fait que vérifier que ghcr.io répond à
        // une requête HTTP, jamais que les identifiants sont valides — voir testRegistryConnection
        // ci-dessus). Un registry dont les identifiants sont RÉELLEMENT rejetés par l'API GitHub
        // Packages (401/403) ne peut plus se présenter comme "connected" ici : on bascule sur le
        // même statut d'erreur ET le même message concret (diagnosticFromError, déjà utilisé par
        // l'explorateur de catalogue) que ce que GET .../repositories affiche déjà pour ce même
        // registry — les deux vues sont désormais TOUJOURS cohérentes entre elles.
        return {
          ...base,
          status: "error",
          trackedImages: localCount,
          lastSyncAt: null,
          statusDetail: diagnosticFromError("GHCR", err),
        };
      }
    }
  }
  // Même raisonnement pour GitLab depuis que son catalogue est interrogeable (25/08/2026) : sans
  // ça, la carte affichait le nombre d'images du même type déjà tirées EN LOCAL pendant que
  // l'explorateur, lui, montrait le vrai contenu du registre — deux chiffres justes mais
  // contradictoires à l'écran.
  if (persisted.kind === "gitlab") {
    const org = resolveRegistryOrg(persisted, localImages);
    if (org) {
      try {
        trackedImages = (await listGroupRepositories(persisted.url, org)).length;
      } catch (err) {
        return {
          ...base,
          status: "error",
          trackedImages: localCount,
          lastSyncAt: null,
          statusDetail: diagnosticFromError("GitLab", err),
        };
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

/**
 * Bug réel corrigé le 14/08/2026 (retour utilisateur : "tu a mis des placehold que je ne peut pas
 * enlever") — root-causé via le journal d'audit : l'utilisateur a réellement supprimé son seul
 * registry configuré (DELETE /api/registries/reg-ghcr-0, 200, confirmé) ; `persisted.length === 0`
 * déclenchait alors un repli sur `demoStore.registries` — 4 cartes ("Docker Hub"/"GitHub Container
 * Registry"/"GitLab Registry — Mairie"/"Harbor interne") renvoyées avec EXACTEMENT la même forme
 * qu'un vrai `Registry`, donc rendues par le frontend avec les mêmes boutons "Explorer le
 * catalogue"/"Supprimer" pleinement cliquables — qui échouaient en 404 dès qu'on cliquait dessus
 * (aucune entrée réelle correspondante dans le tableau persisté). Un repli de démonstration n'a de
 * sens QU'AVANT tout usage réel (aperçu de fonctionnalité pendant l'assistant de configuration) —
 * une fois `completed: true` (l'assistant a déjà tourné), un tableau vide signifie RÉELLEMENT "plus
 * aucun registry", jamais une invitation à afficher des cartes qui se comportent comme des vraies
 * sans en être. RegistriesPage.tsx a déjà un état vide honnête ("Aucun registry configuré.",
 * jamais atteint tant que ce repli renvoyait 4 entrées) : on le laisse enfin s'afficher.
 */
export async function listRegistries(): Promise<Registry[]> {
  const current = await getCurrent();
  const persisted = current.registries ?? [];
  if (persisted.length === 0) return [];
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
  // Identifiants + org optionnels, saisissables directement dans le formulaire de création —
  // retour utilisateur du 14/08/2026 ("de plus a la creation ya pas pour mettre les identifiant
  // ou un token") : avant ce correctif, seule une édition ultérieure via l'icône engrenage
  // permettait de configurer des identifiants, ce qui laissait tout registry privé fraîchement
  // créé "unconfigured" jusqu'à ce détour. Mêmes conventions que RegistryPatch (setupStore.ts).
  username?: string;
  password?: string;
  token?: string;
  org?: string;
}

/** Ajoute un registry — avec ou sans identifiants (sans, il reste "unconfigured" jusqu'à édition
 * via l'icône engrenage — utile pour un premier repérage d'un dépôt public). */
export async function createRegistry(input: CreateRegistryInput): Promise<Registry> {
  await persistRegistry({
    kind: input.kind,
    name: input.name,
    url: input.url,
    ...(input.username !== undefined ? { username: input.username } : {}),
    ...(input.password !== undefined ? { password: input.password } : {}),
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.org !== undefined ? { org: input.org } : {}),
  });
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
