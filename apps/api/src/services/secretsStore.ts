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
 * que la forme publique (SecretRef, sans `value`). Seule getDecryptedSecretValue() déchiffre,
 * et elle n'est appelée que côté serveur (résolution interne), jamais exposée par une route.
 *
 * `name` sert de clé de référence (utilisée par secretEnv côté création de conteneur) : doit
 * rester unique, vérifié à la création et au renommage (SecretNameConflictError, traduit en
 * 409 par routes/secrets.ts).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import type { SecretRef } from "../types.js";

interface StoredSecret {
  id: string;
  name: string;
  description?: string;
  value: string; // chiffré au repos (voir crypto.ts)
  createdAt: string;
  updatedAt: string;
}

export class SecretNameConflictError extends Error {}

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
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // mode 0o600 : même précaution que config.json (setupStore.ts) — le fichier contient des
  // valeurs chiffrées, mais autant restreindre aussi l'accès au fichier lui-même.
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
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
  value?: string;
  description?: string;
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

  const updated: StoredSecret = {
    id: existing.id,
    name: nextName,
    value: patch.value ? encryptSecretIfNeeded(patch.value) : existing.value,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    ...(nextDescription ? { description: nextDescription } : {}),
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
 * toute création partielle plutôt que de propager une exception générique).
 */
export async function getDecryptedSecretValue(name: string): Promise<string | null> {
  const found = (await getAll()).find((secret) => secret.name === name);
  if (!found) return null;
  return decryptSecret(found.value);
}
