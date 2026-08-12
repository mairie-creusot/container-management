/**
 * Jeton GitHub (Personal Access Token) configurable pour l'intégration GitOps GitHub (cf.
 * ARCHITECTURE.md, chapitre "Intégration GitHub"). Un seul jeton pour toute la plateforme dans
 * ce premier lot (pas multi-comptes) — même pattern de persistance chiffrée que
 * secretsStore.ts/setupStore.ts : fichier JSON sur disque (GITHUB_STORE_PATH), jeton chiffré
 * au repos (AES-256-GCM, voir crypto.ts), cache mémoire process invalidé à chaque écriture,
 * fichier écrit avec des permissions restrictives (0600). Jamais renvoyé par une route GET
 * (voir routes/github.ts#GET /api/github/status, qui ne renvoie que { configured, usingGhcrFallback }).
 *
 * Repli automatique en lecture seule : si aucun jeton GitHub dédié n'est configuré, mais qu'un
 * jeton GHCR existe déjà dans la config de l'assistant (setupStore.ts — souvent un PAT GitHub à
 * scope large, utilisé pour `docker login ghcr.io`), il est essayé en repli pour lister les
 * repos. Ce module ne modifie/n'écrase JAMAIS ce jeton GHCR — getEffectiveRegistryCredentials()
 * n'est appelée qu'en lecture.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { getEffectiveRegistryCredentials } from "./setupStore.js";
import type { GithubStatus } from "../types.js";

interface StoredGithubConfig {
  token?: string; // chiffré au repos
}

let cache: StoredGithubConfig | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.github.storePath);
}

async function readFromDisk(): Promise<StoredGithubConfig> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredGithubConfig) : {};
  } catch {
    return {};
  }
}

async function writeToDisk(next: StoredGithubConfig): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // mode 0o600 : même précaution que config.json/secrets.json — le fichier contient un jeton
  // chiffré, mais autant restreindre aussi l'accès au fichier lui-même.
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getCurrent(): Promise<StoredGithubConfig> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** true si un jeton GHCR persisté (setupStore.ts) existe, utilisable en repli — lecture seule. */
async function ghcrFallbackToken(): Promise<string | undefined> {
  const ghcr = await getEffectiveRegistryCredentials("ghcr");
  return ghcr?.token ?? ghcr?.password;
}

/** GET /api/github/status. */
export async function getStatus(): Promise<GithubStatus> {
  const current = await getCurrent();
  if (current.token) return { configured: true, usingGhcrFallback: false };
  const fallback = await ghcrFallbackToken();
  return { configured: false, usingGhcrFallback: Boolean(fallback) };
}

/** PUT /api/github/token (admin uniquement, voir routes/github.ts) — écrase/configure le jeton dédié. */
export async function setToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("token is required");
  const next: StoredGithubConfig = { token: encryptSecretIfNeeded(trimmed) };
  await writeToDisk(next);
  cache = next;
}

export interface EffectiveGithubToken {
  token: string;
  source: "github" | "ghcr-fallback";
}

/**
 * Jeton effectif (déchiffré) utilisé pour tous les appels réels à l'API GitHub : celui dédié
 * s'il est configuré, sinon le jeton GHCR persisté en repli (jamais modifié — voir en-tête de
 * module) ; `null` si aucun des deux n'existe (les repos publics restent listables/détectables
 * sans jeton via l'API GitHub anonyme, avec une limite de débit plus stricte).
 */
export async function getEffectiveToken(): Promise<EffectiveGithubToken | null> {
  const current = await getCurrent();
  if (current.token) return { token: decryptSecret(current.token), source: "github" };
  const fallback = await ghcrFallbackToken();
  if (fallback) return { token: fallback, source: "ghcr-fallback" };
  return null;
}
