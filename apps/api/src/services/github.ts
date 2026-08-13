/**
 * Intégration GitHub réelle (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") : parcourt les
 * VRAIS repos accessibles avec le jeton configuré (API GitHub REST, api.github.com), détecte
 * réellement les fichiers présents à la racine (Dockerfile, docker-compose, Terraform), puis
 * clone (git clone --depth 1, simple-git — même dépendance que services/gitops.ts) + build/déploie
 * réellement (dockerode, même client que services/docker.ts#getClient — local ou distant selon
 * la cible choisie) ou crée un workspace IaC réel (services/iac/workspaces.ts) pour un repo
 * Terraform, sans jamais lancer `tofu apply` automatiquement.
 *
 * Détection RACINE UNIQUEMENT dans ce premier lot (pas de parcours récursif de sous-dossiers) —
 * documenté dans ARCHITECTURE.md et reflété tel quel dans GithubRepoDetection.
 *
 * Sécurité : aucun build/clone n'est jamais déclenché automatiquement — uniquement par un appel
 * explicite à POST /api/github/repos/:owner/:repo/deploy (action utilisateur, voir routes/github.ts).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { config } from "../config.js";
import { getEffectiveToken } from "./githubStore.js";
import { getClient } from "./docker.js";
import { createWorkspace, deleteFile as deleteWorkspaceFile, writeFile as writeWorkspaceFile } from "./iac/workspaces.js";
import {
  appendDeploymentLog,
  createDeploymentRecord,
  getDeployment,
  listDeployments,
  readDeploymentLog,
  updateDeploymentRecord,
} from "./githubDeployments.js";
import { CaddyPushFailedError, createRoute } from "./reverseProxy.js";
import { RegistryCredentialsMissingError, RegistryHttpError } from "./registries/http.js";
import { withTimeout } from "../utils/async.js";
import type {
  GithubDeployment,
  GithubDeploymentCommit,
  GithubDeploymentDetail,
  GithubDeploymentTrigger,
  GithubRepoDetection,
  GithubRepoRef,
} from "../types.js";

// --- Client HTTP GitHub (garde le style diagnostic de registries/http.ts — RegistryHttpError/
// RegistryCredentialsMissingError — plutôt que de réinventer une nouvelle taxonomie d'erreurs) ---

const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

interface GithubFetchInit {
  method?: string;
  body?: unknown; // sérialisé en JSON si présent
}

async function githubFetch(
  pathOrUrl: string,
  token: string | undefined,
  init?: GithubFetchInit,
): Promise<{ data: unknown; response: Response }> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${config.github.apiBaseUrl}${pathOrUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      throw new RegistryHttpError(`GitHub API request to ${url} failed with status ${response.status}`, response.status);
    }
    // DELETE réussi (204 No Content) n'a pas de corps JSON à parser.
    const data = response.status === 204 ? null : ((await response.json()) as unknown);
    return { data, response };
  } catch (err) {
    if (err instanceof RegistryHttpError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new RegistryHttpError(`GitHub API request to ${url} timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms`);
    }
    throw new RegistryHttpError(`GitHub API request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Isole l'URL "rel=next" du header Link paginé standard de l'API GitHub REST. */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Message concret et actionnable — même esprit que registries/index.ts#diagnosticFromError. */
export function diagnosticFromGithubError(err: unknown): string {
  if (err instanceof RegistryCredentialsMissingError) return err.message;
  if (err instanceof RegistryHttpError) {
    switch (err.status) {
      case 401:
        return "Jeton GitHub invalide ou expiré (401) — reconfigurez-le dans les paramètres GitHub.";
      case 403:
        return "Accès refusé par GitHub (403) — le jeton n'a probablement pas le scope nécessaire (repo), ou la limite de débit anonyme est atteinte.";
      case 404:
        return "Dépôt introuvable (404) — vérifiez le nom exact (owner/repo) et que le jeton y a accès s'il est privé.";
      case 429:
        return "Limite de requêtes GitHub atteinte (429) — réessayez dans quelques minutes.";
      default:
        return err.status ? `Erreur HTTP GitHub ${err.status} (${err.message}).` : `Erreur réseau vers GitHub (${err.message}).`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// --- Listing des repos ------------------------------------------------------------------------

interface GithubApiRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  updated_at: string;
  owner?: { login?: string };
}

// Borne raisonnable pour ce premier lot : jusqu'à 500 repos (5 pages de 100) — au-delà, un
// utilisateur/organisation avec un catalogue aussi vaste devra filtrer côté GitHub (recherche non
// implémentée ici). Documenté dans ARCHITECTURE.md.
const MAX_REPO_PAGES = 5;
const REPOS_PER_PAGE = 100;

/** GET /api/github/repos — vraie liste des repos accessibles avec le jeton effectif configuré. */
export async function listRepos(): Promise<GithubRepoRef[]> {
  const effective = await getEffectiveToken();
  if (!effective) {
    throw new RegistryCredentialsMissingError(
      "aucun jeton GitHub configuré — configurez-en un (PUT /api/github/token) ou un jeton GHCR à scope large",
    );
  }

  const repos: GithubRepoRef[] = [];
  let next: string | null = `/user/repos?per_page=${REPOS_PER_PAGE}&sort=updated&affiliation=owner,collaborator,organization_member`;
  let pages = 0;

  while (next && pages < MAX_REPO_PAGES) {
    const { data, response } = await githubFetch(next, effective.token);
    for (const item of data as GithubApiRepo[]) {
      repos.push({
        id: item.id,
        fullName: item.full_name,
        owner: item.owner?.login ?? item.full_name.split("/")[0] ?? "",
        name: item.name,
        private: item.private,
        defaultBranch: item.default_branch,
        htmlUrl: item.html_url,
        updatedAt: item.updated_at,
      });
    }
    next = parseNextLink(response.headers.get("link"));
    pages += 1;
  }

  return repos;
}

// --- Détection de fichiers (racine uniquement) via l'API Contents ------------------------------

interface GithubApiContentItem {
  name: string;
  type: string; // "file" | "dir" | "symlink" | "submodule"
  path: string;
}

const COMPOSE_FILE_NAMES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]);

function summarizeRootEntries(entries: Array<{ name: string; type: string }>): {
  hasDockerfile: boolean;
  hasCompose: boolean;
  terraformFiles: string[];
} {
  const files = entries.filter((e) => e.type === "file" || e.type === "blob");
  const hasDockerfile = files.some((f) => f.name === "Dockerfile");
  const hasCompose = files.some((f) => COMPOSE_FILE_NAMES.has(f.name.toLowerCase()));
  const terraformFiles = files.filter((f) => f.name.toLowerCase().endsWith(".tf")).map((f) => f.name);
  return { hasDockerfile, hasCompose, terraformFiles };
}

async function fetchDefaultBranch(owner: string, repo: string, token: string | undefined): Promise<string> {
  const { data } = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  const info = data as { default_branch?: string };
  return info.default_branch ?? "main";
}

/** Dernière instruction EXPOSE d'un Dockerfile — même convention que Docker lui-même (la
 * dernière instruction gagne en cas de plusieurs). Accepte "EXPOSE 8080" et "EXPOSE 8080/tcp" ;
 * ignore délibérément une variable non résolue ("EXPOSE $PORT", rare mais existe) plutôt que de
 * fabriquer un port. */
function parseExposedPort(dockerfileContent: string): number | undefined {
  const matches = [...dockerfileContent.matchAll(/^\s*EXPOSE\s+(\d+)(?:\/\w+)?/gim)];
  const last = matches.at(-1);
  if (!last?.[1]) return undefined;
  const port = Number(last[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Contenu brut (décodé) d'un fichier via l'API Contents GitHub — `undefined` si absent/illisible
 * (best-effort, n'importe quelle erreur ici ne doit jamais faire échouer la détection globale). */
async function fetchFileContent(owner: string, repo: string, filePath: string, ref: string, token: string | undefined): Promise<string | undefined> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    const content = data as { content?: string; encoding?: string };
    if (content.content && content.encoding === "base64") {
      return Buffer.from(content.content, "base64").toString("utf-8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET /api/github/repos/:owner/:repo/detect — appelle l'API GitHub Contents pour la racine du
 * repo. Un jeton n'est pas strictement requis pour un repo public (API GitHub anonyme, limite de
 * débit plus stricte) : effective peut être `null`, `resolveToken` reste optionnel.
 */
export async function detectRepo(owner: string, repo: string, ref?: string): Promise<GithubRepoDetection> {
  const effective = await getEffectiveToken();
  const token = effective?.token;
  const resolvedRef = ref ?? (await fetchDefaultBranch(owner, repo, token));

  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(resolvedRef)}`,
      token,
    );
    const entries = Array.isArray(data) ? (data as GithubApiContentItem[]) : [];
    const { hasDockerfile, hasCompose, terraformFiles } = summarizeRootEntries(entries);
    // Lecture RÉELLE du contenu du Dockerfile pour en extraire le port EXPOSE (pré-remplit le
    // champ "port" du formulaire de déploiement) — appel best-effort supplémentaire, jamais
    // bloquant pour la détection elle-même si absent/illisible.
    const exposedPort = hasDockerfile
      ? parseExposedPort((await fetchFileContent(owner, repo, "Dockerfile", resolvedRef, token)) ?? "")
      : undefined;
    return {
      ref: resolvedRef,
      hasDockerfile,
      hasCompose,
      hasTerraform: terraformFiles.length > 0,
      terraformFiles,
      ...(exposedPort ? { exposedPort } : {}),
    };
  } catch (err) {
    // 404 sur /contents : repo vide (aucun commit) — un résumé "rien détecté" est honnête, pas
    // une donnée fabriquée. Toute autre erreur (401/403/429/réseau) est re-levée telle quelle
    // pour que la route puisse répondre avec un diagnostic concret plutôt que masquer le problème.
    if (err instanceof RegistryHttpError && err.status === 404) {
      return { ref: resolvedRef, hasDockerfile: false, hasCompose: false, hasTerraform: false, terraformFiles: [] };
    }
    throw err;
  }
}

interface GithubApiCommit {
  sha: string;
  commit: { message: string; author?: { name?: string } };
  author: { login?: string; avatar_url?: string } | null;
}

/** Métadonnées réelles du commit à la tête de `ref` (GET /repos/:owner/:repo/commits/:ref) —
 * `null` en cas d'échec (repo vide, ref introuvable, limite de débit...) : best-effort, ne doit
 * jamais faire échouer le déploiement lui-même, voir startDeployment(). */
async function fetchCommitInfo(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
): Promise<GithubDeploymentCommit | null> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      token,
    );
    const c = data as GithubApiCommit;
    if (!c.sha) return null;
    return {
      sha: c.sha,
      message: (c.commit?.message ?? "").split("\n")[0] ?? "",
      author: c.author?.login ?? c.commit?.author?.name ?? "inconnu",
      ...(c.author?.avatar_url ? { authorAvatarUrl: c.author.avatar_url } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Enregistre (POST /repos/:owner/:repo/hooks) un webhook GitHub réel, pointant vers
 * `${config.github.webhookBaseUrl}/api/github/webhook`, événement "push" uniquement, sécurisé par
 * `secret` (vérifié côté QUAI en HMAC SHA-256, voir routes/githubWebhook.ts). Retourne l'id du
 * hook créé (nécessaire pour pouvoir le supprimer à la désactivation).
 */
export async function createRepoWebhook(owner: string, repo: string, url: string, secret: string, token: string | undefined): Promise<number> {
  const { data } = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`, token, {
    method: "POST",
    body: {
      name: "web",
      active: true,
      events: ["push"],
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    },
  });
  const hook = data as { id: number };
  return hook.id;
}

/** Supprime (DELETE /repos/:owner/:repo/hooks/:hookId) le webhook créé par createRepoWebhook — appelée à la désactivation du déploiement automatique. */
export async function deleteRepoWebhook(owner: string, repo: string, hookId: number, token: string | undefined): Promise<void> {
  await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`, token, { method: "DELETE" });
}

// --- Déploiement réel (clone -> build+run Docker, ou création de workspace IaC) ----------------

/** Détection identique à summarizeRootEntries, mais sur le vrai clone local — la vérité terrain utilisée pour décider quoi déployer (pas la détection GitHub API, qui n'est qu'un aperçu). */
async function detectLocalRepoRoot(
  dir: string,
): Promise<{ hasDockerfile: boolean; hasCompose: boolean; terraformFiles: string[] }> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, type: "file" }));
  return summarizeRootEntries(files);
}

/** Liste tous les fichiers du clone (chemins relatifs), .git exclu — contexte de build Docker. */
async function listBuildContextFiles(dir: string): Promise<string[]> {
  const entries = (await fs.readdir(dir, { recursive: true })) as string[];
  const files: string[] = [];
  for (const entry of entries) {
    const normalized = entry.split(path.sep).join("/");
    if (normalized === ".git" || normalized.startsWith(".git/")) continue;
    const absolute = path.join(dir, entry);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile()) files.push(normalized);
  }
  return files;
}

function sanitizeDockerName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

async function deployViaDockerBuild(
  deploymentId: string,
  cloneDir: string,
  owner: string,
  repo: string,
  targetEnvironmentId: string | undefined,
  subdomain: string | undefined,
  portOverride: number | undefined,
): Promise<void> {
  const docker = await getClient(targetEnvironmentId);
  const imageTag = `quai-gh/${sanitizeDockerName(owner)}-${sanitizeDockerName(repo)}:${deploymentId.slice(0, 8)}`;

  await appendDeploymentLog(deploymentId, `$ docker build -t ${imageTag} .\n`);
  const files = await listBuildContextFiles(cloneDir);
  // buildImage() elle-même ne fait que POSTer la requête et retourne quasi immédiatement un
  // flux de progression — c'est la CONSOMMATION de ce flux (followProgress ci-dessous) qui dure
  // le temps réel du build : le timeout doit donc englober followProgress, pas ce seul appel.
  const buildStream = await docker.buildImage({ context: cloneDir, src: files }, { t: imageTag });

  // Un échec RÉEL d'une étape du build (ex: `RUN` qui retourne un code non-zéro) n'est JAMAIS
  // remonté comme erreur du flux lui-même côté dockerode/l'API Docker — le flux se termine
  // "normalement" (le callback `err` ci-dessous reste `undefined`), l'échec n'apparaît que DANS un
  // évènement `{error: "..."}` au milieu du flux, exactement comme la ligne de log correspondante.
  // Sans cette capture, le code poursuivait comme si le build avait réussi ("Build terminé" loggé
  // quoi qu'il arrive) puis échouait plus loin sur `docker run` avec un message 404 trompeur ("no
  // such image") qui masque la VRAIE cause — constaté en conditions réelles le 13/08/2026 (déploiement
  // mairie-creusot/SpacetimeDB, échec de compilation Rust réel dans une dépendance).
  let buildError: string | undefined;
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        buildStream,
        (err) => (err ? reject(err) : resolve()),
        (event: { stream?: string; status?: string; error?: string }) => {
          const line = event.error ?? event.stream ?? event.status;
          if (line) void appendDeploymentLog(deploymentId, line.endsWith("\n") ? line : `${line}\n`);
          if (event.error) buildError = event.error;
        },
      );
    }),
    config.github.buildTimeoutMs,
    "docker build",
  );
  if (buildError) {
    throw new Error(`docker build a échoué : ${buildError}`);
  }
  await appendDeploymentLog(deploymentId, `Build terminé : ${imageTag}\n`);

  const containerName = sanitizeDockerName(`quai-gh-${owner}-${repo}-${deploymentId.slice(0, 8)}`);
  await appendDeploymentLog(deploymentId, `$ docker run -d --name ${containerName} -P ${imageTag}\n`);
  // -P (PublishAllPorts) : publie automatiquement tous les ports EXPOSE du Dockerfile sur des
  // ports hôte aléatoires — évite un conflit avec un port fixe choisi à l'aveugle. L'utilisateur
  // peut ensuite router un sous-domaine dessus via le reverse proxy interne (voir ReverseProxyPage).
  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName,
    HostConfig: { PublishAllPorts: true },
  });
  await container.start();
  await appendDeploymentLog(deploymentId, `Conteneur démarré : ${containerName} (${container.id.slice(0, 12)})\n`);

  await updateDeploymentRecord(deploymentId, {
    kind: "docker-build-run",
    imageTag,
    containerId: container.id,
    containerName,
  });

  // Sous-domaine demandé (dérivé du nom du repo ou choisi explicitement, voir
  // GitHubDeployPage.tsx) : crée réellement la route reverse-proxy vers ce conteneur, port
  // interne = celui fourni explicitement, sinon le dernier EXPOSE réellement lu dans LE VRAI
  // Dockerfile cloné (vérité terrain, pas la détection GitHub API qui n'est qu'un aperçu).
  if (subdomain) {
    const dockerfilePort = await fs
      .readFile(path.join(cloneDir, "Dockerfile"), "utf-8")
      .then(parseExposedPort)
      .catch(() => undefined);
    const targetPort = portOverride ?? dockerfilePort;
    if (!targetPort) {
      await appendDeploymentLog(
        deploymentId,
        `Sous-domaine "${subdomain}" demandé mais aucun port EXPOSE détecté dans le Dockerfile ni fourni explicitement — route reverse-proxy NON créée (voir "Options avancées" pour préciser un port).\n`,
      );
      return;
    }
    try {
      const route = await createRoute({ subdomain, targetContainerId: container.id, targetPort });
      await appendDeploymentLog(deploymentId, `Route reverse-proxy créée : https://${subdomain} -> ${containerName}:${targetPort}\n`);
      await updateDeploymentRecord(deploymentId, { reverseProxyRouteId: route.id });
    } catch (err) {
      // CaddyPushFailedError : la route est malgré tout créée/persistée côté QUAI (voir
      // services/reverseProxy.ts#createRoute) — seul le miroir Caddy n'a pas pu être mis à jour
      // tout de suite (rejouable via POST /api/reverse-proxy/push). reverseProxyRouteId doit donc
      // quand même être enregistré, sinon le lien de domaine "réussi" disparaîtrait à tort.
      if (err instanceof CaddyPushFailedError && err.route) {
        await appendDeploymentLog(deploymentId, `Route reverse-proxy créée (https://${subdomain} -> ${containerName}:${targetPort}) mais Caddy injoignable pour l'instant : ${err.message} — un re-push (POST /api/reverse-proxy/push) suffira.\n`);
        await updateDeploymentRecord(deploymentId, { reverseProxyRouteId: err.route.id });
      } else {
        // Best-effort, jamais bloquant : le déploiement Docker a réussi, seule la route échoue.
        await appendDeploymentLog(deploymentId, `Échec de la création de la route reverse-proxy pour "${subdomain}" : ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}

async function deployViaIacWorkspace(
  deploymentId: string,
  cloneDir: string,
  owner: string,
  repo: string,
  terraformFiles: string[],
  startedBy: string,
): Promise<void> {
  const workspace = await createWorkspace({
    name: `github-${owner}-${repo}-${new Date().toISOString().slice(0, 10)}`,
    engine: "tofu",
    createdBy: startedBy,
  });
  // createWorkspace scaffolde un main.tf de démonstration (voir iac/workspaces.ts#SCAFFOLD) —
  // retiré avant de copier les vrais fichiers Terraform du repo pour ne pas mélanger démo et réel.
  await deleteWorkspaceFile(workspace.id, "main.tf");

  for (const fileName of terraformFiles) {
    const content = await fs.readFile(path.join(cloneDir, fileName), "utf-8");
    await writeWorkspaceFile(workspace.id, fileName, content);
  }

  await appendDeploymentLog(
    deploymentId,
    `Workspace IaC créé : ${workspace.id} (${terraformFiles.length} fichier(s) Terraform copiés depuis la racine du dépôt : ${terraformFiles.join(", ")}).\n` +
      `Aucun "tofu apply" (ni même "plan") n'a été lancé automatiquement — ouvrez la page Infra-as-code pour l'exécuter explicitement.\n`,
  );

  await updateDeploymentRecord(deploymentId, { kind: "iac-workspace", iacWorkspaceId: workspace.id });
}

/**
 * Prépare un `GIT_ASKPASS` TEMPORAIRE portant le jeton PAT — jamais interpolé dans l'URL de
 * clone (qui finirait en argument de ligne de commande du process `git` réellement exécuté,
 * visible via `ps aux`/`/proc/<pid>/cmdline` par tout utilisateur/processus disposant de ces
 * droits d'observation locale sur l'hôte/le conteneur API — voir finding E4,
 * docs/reports/security-audit-2026-08-12.md). Le jeton ne transite QUE par une variable
 * d'environnement du sous-processus `git` (GIT_QUAI_TOKEN, jamais journalisée) : le script
 * d'aide se contente de la relayer sur stdout quand `git` la lui demande (protocole GIT_ASKPASS
 * standard — invoqué UNIQUEMENT pour le mot de passe, l'utilisateur "x-access-token" étant déjà
 * dans l'URL, voir cloneUrl ci-dessous), jamais écrite dans le script lui-même ni conservée
 * au-delà du clone (dossier temporaire supprimé dans le `finally` de l'appelant).
 */
async function prepareGitAskPass(token: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quai-github-askpass-"));
  const scriptPath = path.join(dir, "askpass.sh");
  await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '%s' "$GIT_QUAI_TOKEN"\n`, { encoding: "utf-8", mode: 0o700 });
  return {
    env: { ...process.env, GIT_ASKPASS: scriptPath, GIT_TERMINAL_PROMPT: "0", GIT_QUAI_TOKEN: token },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function runDeployment(
  deploymentId: string,
  owner: string,
  repo: string,
  ref: string,
  targetEnvironmentId: string | undefined,
  token: string | undefined,
  startedBy: string,
  subdomain: string | undefined,
  port: number | undefined,
): Promise<void> {
  const cloneDir = path.join(os.tmpdir(), `quai-github-deploy-${deploymentId}`);
  // Préparé AVANT le try (pour être nettoyé dans tous les cas via le `finally` ci-dessous) —
  // `null` si aucun jeton (repo public) : clone anonyme inchangé, sans GIT_ASKPASS.
  const askPass = token ? await prepareGitAskPass(token) : null;
  try {
    // "x-access-token" seul dans l'URL (convention GitHub PAT pour l'auth HTTPS) : JAMAIS le
    // jeton lui-même, fourni séparément via GIT_ASKPASS (askPass ci-dessus) — voir finding E4.
    const cloneUrl = token ? `https://x-access-token@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
    await appendDeploymentLog(deploymentId, `$ git clone --depth 1 --branch ${ref} https://github.com/${owner}/${repo}.git\n`);
    // simple-git >=3.16 bloque par défaut l'usage de GIT_ASKPASS (plugin "unsafe operations" —
    // protection légitime contre une variable d'environnement non maîtrisée injectée dans un
    // process git arbitraire) : sans `unsafe.allowUnsafeAskPass`, TOUT clone authentifié
    // échouait avec "Use of \"GIT_ASKPASS\" is not permitted without enabling
    // allowUnsafeAskPass" — jamais un GIT_ASKPASS "non maîtrisé" ici (script fixe généré par
    // prepareGitAskPass ci-dessus, jamais construit à partir d'une entrée utilisateur), donc
    // sans risque à activer explicitement UNIQUEMENT sur ce client dédié au clone authentifié
    // (jamais globalement). Bug vérifié en conditions réelles (déploiement avec jeton configuré
    // échouant à 100%) avant ce correctif.
    const cloner = askPass ? simpleGit({ unsafe: { allowUnsafeAskPass: true } }).env(askPass.env) : simpleGit();
    await withTimeout(
      cloner.clone(cloneUrl, cloneDir, ["--depth", "1", "--branch", ref, "--single-branch"]),
      config.github.cloneTimeoutMs,
      "git clone",
    );
    await appendDeploymentLog(deploymentId, "Clone terminé.\n");

    const detection = await detectLocalRepoRoot(cloneDir);
    await appendDeploymentLog(
      deploymentId,
      `Détection (racine du clone) : Dockerfile=${detection.hasDockerfile} compose=${detection.hasCompose} ` +
        `terraform=${detection.terraformFiles.length > 0} (${detection.terraformFiles.join(", ") || "aucun"})\n\n`,
    );

    if (detection.hasDockerfile) {
      await deployViaDockerBuild(deploymentId, cloneDir, owner, repo, targetEnvironmentId, subdomain, port);
    } else if (detection.terraformFiles.length > 0) {
      await deployViaIacWorkspace(deploymentId, cloneDir, owner, repo, detection.terraformFiles, startedBy);
    } else {
      throw new Error(
        "Aucun Dockerfile ni fichier Terraform détecté à la racine du dépôt — rien à déployer automatiquement " +
          "dans ce premier lot (docker-compose seul et parcours récursif de sous-dossiers non pris en charge).",
      );
    }

    await updateDeploymentRecord(deploymentId, { status: "success", finishedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendDeploymentLog(deploymentId, `\n[quai] échec : ${message}\n`);
    await updateDeploymentRecord(deploymentId, { status: "failed", finishedAt: new Date().toISOString() });
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
    await askPass?.cleanup();
  }
}

export interface StartDeploymentInput {
  owner: string;
  repo: string;
  ref?: string;
  targetEnvironmentId?: string;
  startedBy: string;
  /** "manual" (défaut) : clic operator/admin. "webhook" : déclenché par POST /api/github/webhook (voir routes/githubWebhook.ts). */
  triggeredBy?: GithubDeploymentTrigger;
  /** Sous-domaine reverse-proxy à router vers le conteneur déployé (kind "docker-build-run" uniquement) — voir deployViaDockerBuild. */
  subdomain?: string;
  /** Port interne du conteneur pour la route reverse-proxy — remplace la détection EXPOSE automatique si fourni. */
  port?: number;
  /** Déclenchement webhook : métadonnées de commit déjà connues (payload `push`), pour éviter un
   * appel GitHub supplémentaire — sinon récupérées ici via l'API (déclenchement manuel). */
  commit?: GithubDeploymentCommit;
}

/**
 * POST /api/github/repos/:owner/:repo/deploy (ou déclenchement webhook, voir routes/githubWebhook.ts)
 * — résout la référence par défaut si omise (appel rapide, avant de retourner) puis démarre le
 * clone/build/run en arrière-plan (comme iac/runner.ts#startRun) : retourne immédiatement
 * l'entrée d'historique à l'état "running".
 */
export async function startDeployment(input: StartDeploymentInput): Promise<GithubDeployment> {
  const effective = await getEffectiveToken();
  const token = effective?.token;
  const resolvedRef = input.ref ?? (await fetchDefaultBranch(input.owner, input.repo, token));

  // Métadonnées de commit RÉELLES — déjà connues pour un déclenchement webhook (payload `push`),
  // sinon récupérées via l'API GitHub (best-effort, voir fetchCommitInfo : `null` n'empêche jamais
  // le déploiement, l'historique affiche juste moins d'informations dans ce cas).
  const commit = input.commit ?? (await fetchCommitInfo(input.owner, input.repo, resolvedRef, token));

  const id = randomUUID();
  const deployment = await createDeploymentRecord({
    id,
    owner: input.owner,
    repo: input.repo,
    ref: resolvedRef,
    targetEnvironmentId: input.targetEnvironmentId ?? null,
    startedBy: input.startedBy,
    triggeredBy: input.triggeredBy ?? "manual",
    ...(commit ? { commit } : {}),
    ...(input.subdomain ? { subdomain: input.subdomain } : {}),
  });

  void runDeployment(id, input.owner, input.repo, resolvedRef, input.targetEnvironmentId, token, input.startedBy, input.subdomain, input.port);

  return deployment;
}

export { listDeployments };

export async function getDeploymentDetail(id: string): Promise<GithubDeploymentDetail | null> {
  const deployment = await getDeployment(id);
  if (!deployment) return null;
  const log = await readDeploymentLog(id);
  return { ...deployment, log };
}
