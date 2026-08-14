/**
 * Jeton GitHub (Personal Access Token) configurable pour l'intégration GitOps GitHub (cf.
 * ARCHITECTURE.md, chapitre "Intégration GitHub"). Un seul jeton pour toute la plateforme dans
 * ce premier lot (pas multi-comptes).
 *
 * Retour utilisateur réel (14/08/2026) : "c'est penible ca il faut faire en sorte de soit utilise
 * depuis un secret parmanant soit le renseigner dans les setting pour utiliser partout" — le jeton
 * était auparavant stocké dans un champ dédié de ce module (fichier JSON séparé, GITHUB_STORE_PATH),
 * complètement isolé du gestionnaire de secrets général. Depuis ce jour, PUT /api/github/token
 * enregistre le jeton comme un SECRET NOMMÉ RÉSERVÉ dans secretsStore.ts (GITHUB_TOKEN_SECRET_NAME
 * = "github-token", même mécanisme de chiffrement AES-256-GCM/0600 que tout autre secret) : configuré
 * UNE SEULE FOIS, résolu automatiquement PARTOUT où QUAI a besoin d'un jeton GitHub (listing/détection
 * de repos, clone/build/déploiement, création du webhook) via getEffectiveToken() ci-dessous — même
 * esprit que la résolution de credentials de registre déjà en place (getEffectiveRegistryCredentials).
 * L'ancien champ `token` du fichier JSON dédié de ce module reste lu en repli (compatibilité
 * ascendante avec une instance déjà configurée avant ce changement) mais n'est plus JAMAIS écrit —
 * une nouvelle configuration passe systématiquement par le secret nommé, migration douce et sans
 * action requise de l'administrateur (aucune donnée perdue, aucune double saisie).
 *
 * Même pattern de persistance chiffrée que secretsStore.ts/setupStore.ts pour tout ce qui reste
 * dans ce fichier (déploiement automatique sur push) : fichier JSON sur disque (GITHUB_STORE_PATH),
 * valeurs chiffrées au repos (AES-256-GCM, voir crypto.ts), cache mémoire process invalidé à chaque
 * écriture, fichier écrit avec des permissions restrictives (0600). Jamais renvoyé par une route GET
 * (voir routes/github.ts#GET /api/github/status, qui ne renvoie que { configured, usingGhcrFallback }).
 *
 * Repli automatique en lecture seule : si aucun jeton GitHub dédié n'est configuré (ni secret nommé,
 * ni ancien champ), mais qu'un jeton GHCR existe déjà dans la config de l'assistant (setupStore.ts —
 * souvent un PAT GitHub à scope large, utilisé pour `docker login ghcr.io`), il est essayé en repli
 * pour lister les repos. Ce module ne modifie/n'écrase JAMAIS ce jeton GHCR — getEffectiveRegistryCredentials()
 * n'est appelée qu'en lecture.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { writeFileRestricted } from "../utils/secureFile.js";
import { getEffectiveRegistryCredentials } from "./setupStore.js";
import { createSecret, getDecryptedSecretValue, listSecrets, updateSecret } from "./secretsStore.js";
import type { GithubAutoDeployStatus, GithubStatus } from "../types.js";

/** Nom réservé sous lequel le jeton GitHub dédié est stocké dans le gestionnaire de secrets
 * général (secretsStore.ts) — voir en-tête de fichier. Un utilisateur pourrait en théorie créer un
 * secret portant ce même nom directement depuis SecretsPage.tsx : c'est un comportement voulu, pas
 * un conflit à empêcher (les deux chemins convergent vers le même secret, cohérent avec "un seul
 * jeton pour toute la plateforme"). */
const GITHUB_TOKEN_SECRET_NAME = "github-token";

interface StoredGithubConfig {
  token?: string; // chiffré au repos
  autoDeploy?: Record<string, StoredAutoDeployEntry>; // clé "owner/repo" (minuscules)
}

/**
 * Déploiement automatique sur push (webhook GitHub réel — cf. routes/githubWebhook.ts). `secret`
 * (secret HMAC du webhook, un par dépôt, généré aléatoirement à l'activation) est chiffré au
 * repos, même mécanisme que `token` ci-dessus — jamais renvoyé par une route GET (voir
 * GithubAutoDeployStatus, la forme exposée côté API, qui ne le porte jamais).
 */
export interface StoredAutoDeployEntry {
  owner: string;
  repo: string;
  branch: string;
  enabled: boolean;
  /** id du webhook côté GitHub (POST /repos/:owner/:repo/hooks) — nécessaire pour le désactiver
   * proprement (DELETE .../hooks/:hookId). Absent si la création a échoué côté GitHub alors que
   * la config est malgré tout restée "enabled: true" localement (ne devrait pas arriver, voir
   * routes/github.ts qui ne persiste qu'après succès de la création). */
  hookId?: number;
  secret: string; // chiffré au repos
  targetEnvironmentId?: string;
  subdomain?: string;
  port?: number;
  updatedAt: string; // ISO 8601
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
  // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
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

/** true si le secret nommé réservé (voir GITHUB_TOKEN_SECRET_NAME) existe — chemin PRIORITAIRE
 * depuis le 14/08/2026, voir en-tête de fichier. */
async function tokenSecretValue(): Promise<string | null> {
  return getDecryptedSecretValue(GITHUB_TOKEN_SECRET_NAME);
}

/** GET /api/github/status. */
export async function getStatus(): Promise<GithubStatus> {
  if (await tokenSecretValue()) return { configured: true, usingGhcrFallback: false };
  const current = await getCurrent();
  if (current.token) return { configured: true, usingGhcrFallback: false }; // ancien champ, compatibilité ascendante
  const fallback = await ghcrFallbackToken();
  return { configured: false, usingGhcrFallback: Boolean(fallback) };
}

/**
 * PUT /api/github/token (admin uniquement, voir routes/github.ts) — configure/remplace le jeton
 * GitHub dédié, stocké désormais comme secret nommé RÉUTILISABLE PARTOUT (voir en-tête de fichier) :
 * n'écrit plus jamais dans l'ancien champ dédié de ce module (celui-ci reste lu en repli pour une
 * instance déjà configurée avant ce changement, jamais réécrit).
 */
export async function setToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("token is required");
  const existing = (await listSecrets()).find((s) => s.name === GITHUB_TOKEN_SECRET_NAME);
  if (existing) {
    await updateSecret(existing.id, { value: trimmed });
  } else {
    await createSecret({
      name: GITHUB_TOKEN_SECRET_NAME,
      value: trimmed,
      description:
        "Jeton GitHub (Personal Access Token) partagé par toute l'intégration GitHub de QUAI (listing/détection de dépôts, clone/build/déploiement, webhook) — configuré une seule fois, réutilisé automatiquement partout.",
    });
  }
}

export interface EffectiveGithubToken {
  token: string;
  source: "github" | "ghcr-fallback";
}

/**
 * Jeton effectif (déchiffré) utilisé pour tous les appels réels à l'API GitHub : le secret nommé
 * réservé (GITHUB_TOKEN_SECRET_NAME) s'il existe, sinon l'ancien champ dédié de ce module
 * (compatibilité ascendante, jamais réécrit — voir setToken), sinon le jeton GHCR persisté en
 * repli (jamais modifié) ; `null` si aucun des trois n'existe (les repos publics restent
 * listables/détectables sans jeton via l'API GitHub anonyme, avec une limite de débit plus stricte).
 */
export async function getEffectiveToken(): Promise<EffectiveGithubToken | null> {
  const secretToken = await tokenSecretValue();
  if (secretToken) return { token: secretToken, source: "github" };
  const current = await getCurrent();
  if (current.token) return { token: decryptSecret(current.token), source: "github" };
  const fallback = await ghcrFallbackToken();
  if (fallback) return { token: fallback, source: "ghcr-fallback" };
  return null;
}

// --- Déploiement automatique sur push (webhook GitHub réel, cf. routes/githubWebhook.ts) -------

function autoDeployKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

async function getAutoDeployEntry(owner: string, repo: string): Promise<StoredAutoDeployEntry | null> {
  const current = await getCurrent();
  return current.autoDeploy?.[autoDeployKey(owner, repo)] ?? null;
}

/** GET /api/github/repos/:owner/:repo/auto-deploy — jamais le secret. */
export async function getAutoDeployStatus(owner: string, repo: string): Promise<GithubAutoDeployStatus | null> {
  const entry = await getAutoDeployEntry(owner, repo);
  if (!entry) return null;
  return {
    owner: entry.owner,
    repo: entry.repo,
    enabled: entry.enabled,
    branch: entry.branch,
    updatedAt: entry.updatedAt,
    ...(entry.targetEnvironmentId ? { targetEnvironmentId: entry.targetEnvironmentId } : {}),
    ...(entry.subdomain ? { subdomain: entry.subdomain } : {}),
    ...(entry.port ? { port: entry.port } : {}),
  };
}

/**
 * Résolution interne pour la vérification de signature du webhook (routes/githubWebhook.ts) —
 * secret DÉCHIFFRÉ, jamais exposé par une route GET. `null` si ce dépôt n'a jamais eu de
 * déploiement automatique configuré (webhook orphelin, ou payload forgé visant un dépôt inconnu).
 */
export async function getAutoDeploySecretEntry(
  owner: string,
  repo: string,
): Promise<{ secret: string; enabled: boolean; branch: string; targetEnvironmentId?: string; subdomain?: string; port?: number } | null> {
  const entry = await getAutoDeployEntry(owner, repo);
  if (!entry) return null;
  return {
    secret: decryptSecret(entry.secret),
    enabled: entry.enabled,
    branch: entry.branch,
    ...(entry.targetEnvironmentId ? { targetEnvironmentId: entry.targetEnvironmentId } : {}),
    ...(entry.subdomain ? { subdomain: entry.subdomain } : {}),
    ...(entry.port ? { port: entry.port } : {}),
  };
}

/** Secret HMAC existant pour ce dépôt (déchiffré) s'il y en a déjà un — pour réutiliser le même
 * secret entre deux réactivations plutôt que d'en régénérer un nouveau à chaque fois. */
export async function getExistingAutoDeploySecret(owner: string, repo: string): Promise<string | null> {
  const entry = await getAutoDeployEntry(owner, repo);
  return entry ? decryptSecret(entry.secret) : null;
}

export async function getAutoDeployHookId(owner: string, repo: string): Promise<number | undefined> {
  const entry = await getAutoDeployEntry(owner, repo);
  return entry?.hookId;
}

export interface SaveAutoDeployInput {
  owner: string;
  repo: string;
  branch: string;
  enabled: boolean;
  hookId?: number;
  secret: string; // en clair, chiffré ici avant écriture
  targetEnvironmentId?: string;
  subdomain?: string;
  port?: number;
}

/** PUT /api/github/repos/:owner/:repo/auto-deploy — remplace l'entrée existante pour ce dépôt. */
export async function saveAutoDeployEntry(input: SaveAutoDeployInput): Promise<GithubAutoDeployStatus> {
  const current = await getCurrent();
  const entry: StoredAutoDeployEntry = {
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    enabled: input.enabled,
    secret: encryptSecretIfNeeded(input.secret),
    updatedAt: new Date().toISOString(),
    ...(input.hookId !== undefined ? { hookId: input.hookId } : {}),
    ...(input.targetEnvironmentId ? { targetEnvironmentId: input.targetEnvironmentId } : {}),
    ...(input.subdomain ? { subdomain: input.subdomain } : {}),
    ...(input.port ? { port: input.port } : {}),
  };
  const next: StoredGithubConfig = {
    ...current,
    autoDeploy: { ...(current.autoDeploy ?? {}), [autoDeployKey(input.owner, input.repo)]: entry },
  };
  await writeToDisk(next);
  cache = next;
  return (await getAutoDeployStatus(input.owner, input.repo))!;
}
