/**
 * Gestionnaire de secrets nommés façon Vault/GitHub Actions secrets (cf. ARCHITECTURE.md,
 * chapitre "Gestionnaire de secrets"). Un admin définit une valeur une seule fois sous un nom
 * unique ; cette valeur est ensuite référencée PAR NOM (jamais retapée) lors de la création
 * d'un conteneur — voir routes/containers.ts, qui résout `secretEnv` via
 * `getDecryptedSecretValue` avant l'appel à `docker.ts#createAndStartContainer`.
 *
 * Persistance JSON sur disque (SECRETS_PATH, défaut ./data/secrets.json en dev), même
 * répertoire et même pattern que config.json (setupStore.ts) : cache mémoire process invalidé
 * à chaque écriture, fichier écrit avec des permissions restrictives (0600).
 *
 * La valeur de chaque secret est chiffrée au repos (AES-256-GCM, voir crypto.ts — même
 * mécanisme que le mot de passe LDAP/kubeconfig/identifiants de registry dans setupStore.ts)
 * et n'est JAMAIS renvoyée par listSecrets()/getSecretRef() : ces deux fonctions ne retournent
 * que la forme publique (SecretRef, sans `value`). getDecryptedSecretValue()/
 * getDecryptedSecretValueById() déchiffrent : la première reste réservée à un usage serveur
 * interne (résolution `secretEnv` à la création de conteneur) ; la seconde n'est appelée que
 * par POST /api/secrets/:id/reveal (routes/secrets.ts), la SEULE route qui expose jamais une
 * valeur en clair — admin uniquement, une fois par appel.
 *
 * `name` sert de clé de référence (utilisée par secretEnv côté création de conteneur) : doit
 * rester unique, vérifié à la création et au renommage (SecretNameConflictError, traduit en
 * 409 par routes/secrets.ts).
 *
 * Chaque secret porte aussi `usedBy` : la liste des conteneurs qui le référencent RÉELLEMENT
 * via `secretEnv` à leur création (jamais une coïncidence de variable d'environnement) —
 * enregistrée par recordSecretUsage(), nettoyée précisément à la suppression/au renommage d'un
 * conteneur (removeSecretUsagesForContainer/renameSecretUsageContainer) et, en filet de
 * sécurité, purgée par purgeStaleSecretUsages() pour les conteneurs disparus autrement que via
 * QUAI. Voir ARCHITECTURE.md, chapitre "Gestionnaire de secrets".
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { writeFileRestricted } from "../utils/secureFile.js";
import type { SecretRef, SecretUsage, SecretVersionMeta } from "../types.js";

/**
 * Nombre de versions PRÉCÉDENTES conservées par secret (façon Vault KV v2 `max_versions`, mais
 * fixe plutôt que configurable — un réglage par secret aurait ajouté une UI/un contrat dédiés
 * pour un bénéfice marginal à cette échelle). Volontairement modeste : ce fichier reste un JSON
 * relu/réécrit en entier à chaque écriture (voir writeToDisk), pas une base — un historique non
 * borné grossirait indéfiniment pour un secret souvent tourné.
 */
const MAX_HISTORY_VERSIONS = 5;

interface StoredSecretVersion {
  version: number;
  value: string; // chiffré au repos, comme la valeur courante
  updatedAt: string; // date à laquelle CETTE version a cessé d'être la version courante
}

interface StoredSecret {
  id: string;
  name: string;
  description?: string;
  value: string; // chiffré au repos (voir crypto.ts) — TOUJOURS la version courante
  createdAt: string;
  updatedAt: string;
  // Conteneurs qui référencent RÉELLEMENT ce secret via `secretEnv` à leur création — jamais
  // une coïncidence de variable d'environnement (voir recordSecretUsage ci-dessous, appelée
  // uniquement par routes/containers.ts après une résolution réussie). Absent sur les secrets
  // écrits avant l'introduction de ce champ : toujours lu via `secret.usedBy ?? []` plutôt que
  // supposé présent.
  usedBy?: SecretUsage[];
  // Historique + expiration façon Vault KV v2 (cf. ARCHITECTURE.md, chapitre "Gestionnaire de
  // secrets") — absents sur les secrets écrits avant l'introduction de ces champs, toujours lus
  // avec un repli (`secret.version ?? 1`, `secret.history ?? []`).
  version?: number; // incrémenté à chaque changement RÉEL de valeur (PATCH avec `value` non vide)
  history?: StoredSecretVersion[]; // versions précédentes seulement, bornées à MAX_HISTORY_VERSIONS
  expiresAt?: string; // ISO 8601 optionnelle — voir getDecryptedSecretValue (bloque secretEnv passé cette date)
}

export class SecretNameConflictError extends Error {}

/** Levée par getDecryptedSecretValue() quand le secret demandé a une `expiresAt` dépassée —
 * routes/containers.ts la traduit en 400 explicite plutôt que de résoudre silencieusement une
 * valeur potentiellement périmée dans l'environnement d'un nouveau conteneur. Ne bloque QUE la
 * résolution à la création de conteneur : POST /api/secrets/:id/reveal reste volontairement
 * permissif sur un secret expiré (un admin doit pouvoir consulter une valeur expirée pour la
 * faire tourner), voir routes/secrets.ts. */
export class SecretExpiredError extends Error {}

let cache: StoredSecret[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.secrets.storePath);
}

async function readFromDisk(): Promise<StoredSecret[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSecret[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: StoredSecret[]): Promise<void> {
  // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
}

async function getAll(): Promise<StoredSecret[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

function toRef(secret: StoredSecret): SecretRef {
  return {
    id: secret.id,
    name: secret.name,
    ...(secret.description !== undefined ? { description: secret.description } : {}),
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    usedBy: secret.usedBy ?? [],
    version: secret.version ?? 1,
    versionCount: 1 + (secret.history?.length ?? 0),
    ...(secret.expiresAt !== undefined ? { expiresAt: secret.expiresAt } : {}),
  };
}

/** GET /api/secrets — jamais la valeur, voir toRef(). */
export async function listSecrets(): Promise<SecretRef[]> {
  const all = await getAll();
  return all.map(toRef);
}

export async function getSecretRef(id: string): Promise<SecretRef | undefined> {
  const found = (await getAll()).find((secret) => secret.id === id);
  return found ? toRef(found) : undefined;
}

export interface CreateSecretInput {
  name: string;
  value: string;
  description?: string;
  expiresAt?: string; // ISO 8601 optionnelle — voir SecretExpiredError
}

/** POST /api/secrets — `name` doit être unique (409 via SecretNameConflictError sinon). */
export async function createSecret(input: CreateSecretInput): Promise<SecretRef> {
  const all = await getAll();
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  if (all.some((secret) => secret.name === name)) {
    throw new SecretNameConflictError(`A secret named "${name}" already exists`);
  }
  const now = new Date().toISOString();
  const trimmedDescription = input.description?.trim();
  const created: StoredSecret = {
    id: randomUUID(),
    name,
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
    value: encryptSecretIfNeeded(input.value),
    createdAt: now,
    updatedAt: now,
    usedBy: [],
    version: 1,
    history: [],
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  const next = [...all, created];
  await writeToDisk(next);
  cache = next;
  return toRef(created);
}

export interface UpdateSecretInput {
  name?: string;
  // value omise/vide = valeur conservée (comme password/token dans setupStore.ts#updateRegistryAt)
  // — un PATCH qui ne fait que renommer un secret ne doit jamais effacer silencieusement sa valeur.
  // Une valeur RÉELLEMENT fournie déclenche une rotation : l'ancienne valeur bascule dans
  // l'historique (voir MAX_HISTORY_VERSIONS) plutôt que d'être perdue.
  value?: string;
  description?: string;
  // undefined = expiration inchangée ; null = efface explicitement l'expiration ; chaîne = nouvelle date.
  expiresAt?: string | null;
}

/** PATCH /api/secrets/:id — value omise/vide = valeur conservée ; name renommé doit rester unique. */
export async function updateSecret(id: string, patch: UpdateSecretInput): Promise<SecretRef | undefined> {
  const all = await getAll();
  const index = all.findIndex((secret) => secret.id === id);
  if (index === -1) return undefined;
  const existing = all[index]!;

  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new Error("name cannot be empty");
  if (nextName !== existing.name && all.some((secret, i) => i !== index && secret.name === nextName)) {
    throw new SecretNameConflictError(`A secret named "${nextName}" already exists`);
  }

  const nextDescription = patch.description !== undefined ? patch.description.trim() : existing.description;

  // Rotation façon Vault KV v2 : une VRAIE nouvelle valeur bascule l'ancienne dans l'historique
  // (bornée à MAX_HISTORY_VERSIONS, la plus ancienne tombe au-delà) plutôt que d'être perdue,
  // et incrémente `version`. Un PATCH qui ne fait que renommer/changer la description ne bouge
  // ni l'un ni l'autre.
  const valueChanged = Boolean(patch.value);
  const existingVersion = existing.version ?? 1;
  const nextVersion = valueChanged ? existingVersion + 1 : existingVersion;
  const nextHistory = valueChanged
    ? [
        ...(existing.history ?? []),
        { version: existingVersion, value: existing.value, updatedAt: existing.updatedAt },
      ].slice(-MAX_HISTORY_VERSIONS)
    : (existing.history ?? []);

  // undefined = expiration inchangée ; null = effacée explicitement ; chaîne = nouvelle date.
  const nextExpiresAt =
    patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt === null ? undefined : patch.expiresAt;

  const updated: StoredSecret = {
    id: existing.id,
    name: nextName,
    value: patch.value ? encryptSecretIfNeeded(patch.value) : existing.value,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    ...(nextDescription ? { description: nextDescription } : {}),
    // Un renommage/changement de valeur/description ne touche jamais aux conteneurs qui
    // référencent déjà ce secret (usedBy n'est jamais recalculé ici) — le lien reste valide
    // par id de secret, pas par name.
    usedBy: existing.usedBy ?? [],
    version: nextVersion,
    history: nextHistory,
    ...(nextExpiresAt !== undefined ? { expiresAt: nextExpiresAt } : {}),
  };
  const next = all.map((secret, i) => (i === index ? updated : secret));
  await writeToDisk(next);
  cache = next;
  return toRef(updated);
}

/** DELETE /api/secrets/:id — true si un secret a bien été supprimé. */
export async function deleteSecret(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((secret) => secret.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}

/**
 * Résolution interne (déchiffrée) par nom — réservée à un usage serveur (routes/containers.ts,
 * résolution de `secretEnv` avant création d'un conteneur). JAMAIS exposée par une route :
 * aucune route ne doit jamais renvoyer le résultat de cette fonction tel quel au client.
 * Retourne `null` si aucun secret ne porte ce nom (permet à l'appelant de répondre 400 avant
 * toute création partielle plutôt que de propager une exception générique). Lève
 * SecretExpiredError si `expiresAt` est dépassée — routes/containers.ts la traduit en 400 lui
 * aussi, plutôt que d'injecter silencieusement une valeur périmée dans un nouveau conteneur.
 */
export async function getDecryptedSecretValue(name: string): Promise<string | null> {
  const found = (await getAll()).find((secret) => secret.name === name);
  if (!found) return null;
  if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) {
    throw new SecretExpiredError(`Secret "${name}" has expired (expiresAt: ${found.expiresAt})`);
  }
  return decryptSecret(found.value);
}

/**
 * Résolution interne (déchiffrée) par id — réservée à POST /api/secrets/:id/reveal
 * (routes/secrets.ts), la SEULE route qui expose jamais une valeur en clair, admin uniquement,
 * une fois par appel (jamais préchargée pour toute la liste). `version` optionnelle (façon
 * Vault KV v2 : révéler une version passée pour vérifier ce qui tournait avant une rotation) —
 * omise ou égale à la version courante = valeur courante ; sinon cherchée dans `history`.
 * `null` si l'id n'existe pas OU si la version demandée n'existe pas/plus (hors des
 * MAX_HISTORY_VERSIONS conservées) — l'appelant répond 404 dans les deux cas, sans distinction
 * utile côté client.
 */
export async function getDecryptedSecretValueById(id: string, version?: number): Promise<string | null> {
  const found = (await getAll()).find((secret) => secret.id === id);
  if (!found) return null;
  if (version === undefined || version === (found.version ?? 1)) {
    return decryptSecret(found.value);
  }
  const historical = (found.history ?? []).find((entry) => entry.version === version);
  if (!historical) return null;
  return decryptSecret(historical.value);
}

/**
 * GET /api/secrets/:id/versions — métadonnées SEULES (jamais de valeur), version courante en
 * tête puis les précédentes du plus récent au plus ancien (façon Vault KV v2 : consulter
 * l'historique avant de décider de révéler/restaurer une version précise). `undefined` si l'id
 * n'existe pas (404 côté route).
 */
export async function listSecretVersions(id: string): Promise<SecretVersionMeta[] | undefined> {
  const found = (await getAll()).find((secret) => secret.id === id);
  if (!found) return undefined;
  const current: SecretVersionMeta = { version: found.version ?? 1, updatedAt: found.updatedAt };
  const past: SecretVersionMeta[] = (found.history ?? [])
    .map((entry) => ({ version: entry.version, updatedAt: entry.updatedAt }))
    .reverse();
  return [current, ...past];
}

/**
 * Enregistre qu'un conteneur RÉELLEMENT créé référence ce secret sous cette clé d'env —
 * appelée UNIQUEMENT par routes/containers.ts, après que `secretEnv` a été résolu avec succès
 * et que le conteneur a effectivement été créé (jamais avant, jamais sur un échec de création).
 * Idempotent sur (containerId, key) : un appel répété pour le même conteneur/clé remplace
 * l'entrée plutôt que de la dupliquer. No-op silencieux si `secretName` n'existe plus (course
 * théorique entre la résolution du secretEnv et cet enregistrement — ne doit normalement jamais
 * arriver, la résolution ayant déjà validé l'existence du secret juste avant).
 */
export async function recordSecretUsage(secretName: string, usage: SecretUsage): Promise<void> {
  const all = await getAll();
  const index = all.findIndex((secret) => secret.name === secretName);
  if (index === -1) return;
  const existing = all[index]!;
  const withoutSameEntry = (existing.usedBy ?? []).filter(
    (u) => !(u.containerId === usage.containerId && u.key === usage.key),
  );
  const updated: StoredSecret = { ...existing, usedBy: [...withoutSameEntry, usage] };
  const next = all.map((secret, i) => (i === index ? updated : secret));
  await writeToDisk(next);
  cache = next;
}

/**
 * Retire toute trace d'usage de CE conteneur, sur tous les secrets — appelée par
 * routes/containers.ts juste après un `DELETE /api/containers/:id` réussi (suppression
 * CONFIRMÉE, pas une supposition) : c'est le chemin de nettoyage précis et immédiat. Voir
 * purgeStaleSecretUsages ci-dessous pour le filet de sécurité (conteneur disparu autrement
 * qu'via QUAI, ex: `docker rm` fait directement sur l'hôte).
 */
export async function removeSecretUsagesForContainer(containerId: string): Promise<void> {
  const all = await getAll();
  let changed = false;
  const next = all.map((secret) => {
    const current = secret.usedBy ?? [];
    const kept = current.filter((u) => u.containerId !== containerId);
    if (kept.length === current.length) return secret;
    changed = true;
    return { ...secret, usedBy: kept };
  });
  if (!changed) return;
  await writeToDisk(next);
  cache = next;
}

/**
 * Met à jour `containerName` sur toute entrée d'usage référençant ce conteneur — appelée par
 * routes/containers.ts juste après un `POST /api/containers/:id/rename` réussi, pour que le nom
 * affiché dans SecretsPage.tsx reste exact plutôt que de figer le nom au moment de la création.
 */
export async function renameSecretUsageContainer(containerId: string, newName: string): Promise<void> {
  const all = await getAll();
  let changed = false;
  const next = all.map((secret) => {
    const current = secret.usedBy ?? [];
    let localChanged = false;
    const updated = current.map((u) => {
      if (u.containerId !== containerId || u.containerName === newName) return u;
      localChanged = true;
      return { ...u, containerName: newName };
    });
    if (!localChanged) return secret;
    changed = true;
    return { ...secret, usedBy: updated };
  });
  if (!changed) return;
  await writeToDisk(next);
  cache = next;
}

/**
 * GET /api/secrets — filet de sécurité : retire silencieusement, avant de renvoyer la liste,
 * toute entrée `usedBy` dont le conteneur n'existe plus parmi `liveContainerIds` (calculé par
 * l'appelant via getDockerContainers(), même esprit que purgeStalePositions dans
 * topologyPositionsStore.ts). Couvre le cas où un conteneur a disparu autrement que via
 * `DELETE /api/containers/:id` (ex: `docker rm` fait directement sur l'hôte, hors QUAI) — le
 * chemin normal (suppression/renommage DEPUIS QUAI) est déjà géré précisément et immédiatement
 * par removeSecretUsagesForContainer/renameSecretUsageContainer ci-dessus, sans attendre ce
 * filet de sécurité.
 *
 * Limite assumée (même que purgeStalePositions) : si le démon Docker local est brièvement
 * injoignable, getDockerContainers() peut retourner un jeu de démonstration ou une liste vide —
 * `liveContainerIds` ne refléterait alors plus les conteneurs réels, et cet appel purgerait à
 * tort des usages pourtant valides. Risque accepté et documenté plutôt que silencieux (voir
 * ARCHITECTURE.md) : ce n'est qu'une préférence d'affichage dérivée, jamais une suppression de
 * ressource Docker, et elle se reconstitue à la prochaine création de conteneur référençant ce
 * secret. N'écrit sur disque que si au moins une entrée a effectivement été retirée.
 */
export async function purgeStaleSecretUsages(liveContainerIds: ReadonlySet<string>): Promise<SecretRef[]> {
  const all = await getAll();
  let changed = false;
  const next = all.map((secret) => {
    const current = secret.usedBy ?? [];
    const kept = current.filter((u) => liveContainerIds.has(u.containerId));
    if (kept.length === current.length) return secret;
    changed = true;
    return { ...secret, usedBy: kept };
  });
  if (changed) {
    await writeToDisk(next);
    cache = next;
  }
  return next.map(toRef);
}
