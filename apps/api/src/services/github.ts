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
import { RegistryCredentialsMissingError, RegistryHttpError } from "./registries/http.js";
import { withTimeout } from "../utils/async.js";
import type { GithubDeployment, GithubDeploymentDetail, GithubRepoDetection, GithubRepoRef } from "../types.js";

// --- Client HTTP GitHub (garde le style diagnostic de registries/http.ts — RegistryHttpError/
// RegistryCredentialsMissingError — plutôt que de réinventer une nouvelle taxonomie d'erreurs) ---

const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

async function githubFetch(pathOrUrl: string, token: string | undefined): Promise<{ data: unknown; response: Response }> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${config.github.apiBaseUrl}${pathOrUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new RegistryHttpError(`GitHub API request to ${url} failed with status ${response.status}`, response.status);
    }
    const data = (await response.json()) as unknown;
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
    return { ref: resolvedRef, hasDockerfile, hasCompose, hasTerraform: terraformFiles.length > 0, terraformFiles };
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
): Promise<void> {
  const docker = await getClient(targetEnvironmentId);
  const imageTag = `quai-gh/${sanitizeDockerName(owner)}-${sanitizeDockerName(repo)}:${deploymentId.slice(0, 8)}`;

  await appendDeploymentLog(deploymentId, `$ docker build -t ${imageTag} .\n`);
  const files = await listBuildContextFiles(cloneDir);
  // buildImage() elle-même ne fait que POSTer la requête et retourne quasi immédiatement un
  // flux de progression — c'est la CONSOMMATION de ce flux (followProgress ci-dessous) qui dure
  // le temps réel du build : le timeout doit donc englober followProgress, pas ce seul appel.
  const buildStream = await docker.buildImage({ context: cloneDir, src: files }, { t: imageTag });

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        buildStream,
        (err) => (err ? reject(err) : resolve()),
        (event: { stream?: string; status?: string; error?: string }) => {
          const line = event.error ?? event.stream ?? event.status;
          if (line) void appendDeploymentLog(deploymentId, line.endsWith("\n") ? line : `${line}\n`);
        },
      );
    }),
    config.github.buildTimeoutMs,
    "docker build",
  );
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

async function runDeployment(
  deploymentId: string,
  owner: string,
  repo: string,
  ref: string,
  targetEnvironmentId: string | undefined,
  token: string | undefined,
  startedBy: string,
): Promise<void> {
  const cloneDir = path.join(os.tmpdir(), `quai-github-deploy-${deploymentId}`);
  try {
    const cloneUrl = token
      ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;
    await appendDeploymentLog(deploymentId, `$ git clone --depth 1 --branch ${ref} https://github.com/${owner}/${repo}.git\n`);
    await withTimeout(
      simpleGit().clone(cloneUrl, cloneDir, ["--depth", "1", "--branch", ref, "--single-branch"]),
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
      await deployViaDockerBuild(deploymentId, cloneDir, owner, repo, targetEnvironmentId);
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
  }
}

export interface StartDeploymentInput {
  owner: string;
  repo: string;
  ref?: string;
  targetEnvironmentId?: string;
  startedBy: string;
}

/**
 * POST /api/github/repos/:owner/:repo/deploy — résout la référence par défaut si omise (appel
 * rapide, avant de retourner) puis démarre le clone/build/run en arrière-plan (comme
 * iac/runner.ts#startRun) : retourne immédiatement l'entrée d'historique à l'état "running".
 */
export async function startDeployment(input: StartDeploymentInput): Promise<GithubDeployment> {
  const effective = await getEffectiveToken();
  const token = effective?.token;
  const resolvedRef = input.ref ?? (await fetchDefaultBranch(input.owner, input.repo, token));

  const id = randomUUID();
  const deployment = await createDeploymentRecord({
    id,
    owner: input.owner,
    repo: input.repo,
    ref: resolvedRef,
    targetEnvironmentId: input.targetEnvironmentId ?? null,
    startedBy: input.startedBy,
  });

  void runDeployment(id, input.owner, input.repo, resolvedRef, input.targetEnvironmentId, token, input.startedBy);

  return deployment;
}

export { listDeployments };

export async function getDeploymentDetail(id: string): Promise<GithubDeploymentDetail | null> {
  const deployment = await getDeployment(id);
  if (!deployment) return null;
  const log = await readDeploymentLog(id);
  return { ...deployment, log };
}
