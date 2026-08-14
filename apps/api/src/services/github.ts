/**
 * Intégration GitHub réelle (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") — façon
 * Railway.app : parcourt les VRAIS repos accessibles avec le jeton configuré (API GitHub REST,
 * api.github.com), détecte réellement les fichiers présents (Dockerfile, docker-compose,
 * Terraform, Ansible — à la racine, ou dans un sous-dossier via un parcours BORNÉ, voir
 * scanSubfoldersForCandidates), puis clone (git clone --depth 1, simple-git — même dépendance que
 * services/gitops.ts) + build/déploie réellement :
 *  - docker-compose.yml détecté -> `docker compose -p <projet isolé> up -d --build` en
 *    sous-processus réel (voir deployViaDockerCompose) — PRIORITAIRE sur un Dockerfile isolé quand
 *    les deux coexistent (voir GithubDeploymentKind pour le raisonnement) ;
 *  - sinon un Dockerfile isolé -> `docker build` + `docker run` (dockerode, même client que
 *    services/docker.ts#getClient — local ou distant selon la cible choisie) ;
 *  - sinon des fichiers Terraform ou un playbook Ansible -> workspace IaC réel
 *    (services/iac/workspaces.ts), sans jamais lancer `tofu apply`/`ansible-playbook` automatiquement.
 *
 * Sécurité : aucun build/clone n'est jamais déclenché automatiquement — uniquement par un appel
 * explicite à POST /api/github/repos/:owner/:repo/deploy (action utilisateur, voir routes/github.ts).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import yaml from "js-yaml";
import type Docker from "dockerode";
import { config } from "../config.js";
import { getEffectiveToken } from "./githubStore.js";
import { getClient } from "./docker.js";
import { getEffectiveDockerConfig } from "./setupStore.js";
import { getEffectiveRemoteDockerConfig } from "./remoteDockerStore.js";
import { createWorkspace, deleteFile as deleteWorkspaceFile, writeFile as writeWorkspaceFile } from "./iac/workspaces.js";
import {
  appendDeploymentLog,
  createDeploymentRecord,
  getDeployment,
  listDeployments,
  readDeploymentLog,
  updateDeploymentRecord,
} from "./githubDeployments.js";
import { CaddyPushFailedError, createRoute, deleteRoute, listRoutes, SubdomainConflictError } from "./reverseProxy.js";
import { RegistryCredentialsMissingError, RegistryHttpError } from "./registries/http.js";
import {
  createSecret,
  getDecryptedSecretValue,
  getDecryptedSecretValueById,
  getSecretRef,
  listSecrets,
  updateSecret,
} from "./secretsStore.js";
import { withTimeout } from "../utils/async.js";
import type {
  DeployConfigSchema,
  DeployPortRequirement,
  DeployVolumeInfo,
  EnvVarRequirement,
  EnvVarSource,
  GithubComposeServiceCandidate,
  GithubDeployment,
  GithubDeploymentCommit,
  GithubDeploymentDetail,
  GithubDeploymentTrigger,
  GithubDetectionCandidate,
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

// Ordre = priorité d'affichage/résolution quand plusieurs noms coexistent (rare, mais un dépôt
// peut légitimement avoir à la fois compose.yaml et docker-compose.yml) — docker-compose.yml
// reste le nom conventionnel le plus répandu, retenu en premier.
const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"];
// Idem pour Ansible : "playbook.yml" est la convention QUAI elle-même (voir iac/workspaces.ts#SCAFFOLD),
// "site.yml" la convention historique la plus répandue dans l'écosystème Ansible.
const ANSIBLE_PLAYBOOK_NAMES = ["playbook.yml", "site.yml", "playbook.yaml", "site.yaml"];
const ANSIBLE_INVENTORY_NAMES = ["inventory.ini", "inventory.yml", "inventory.yaml", "hosts.ini", "hosts"];

export interface EntriesSummary {
  hasDockerfile: boolean;
  hasCompose: boolean;
  /** Premier nom de fichier compose trouvé (voir COMPOSE_FILE_NAMES) — absent si hasCompose est false. */
  composeFileName?: string;
  terraformFiles: string[];
  hasAnsible: boolean;
  /** Nom du fichier playbook trouvé (voir ANSIBLE_PLAYBOOK_NAMES) — absent si hasAnsible est false. */
  ansiblePlaybook?: string;
}

/** Résume ce qui est déployable dans UN dossier (racine ou sous-dossier) — utilisé aussi bien
 * pour la détection GitHub API (entrées "file"/"dir"/"symlink"/"submodule") que pour la détection
 * locale post-clone (entrées "file" uniquement, voir detectLocalEntriesAt). */
export function summarizeEntries(entries: Array<{ name: string; type: string }>): EntriesSummary {
  const files = entries.filter((e) => e.type === "file" || e.type === "blob");
  const fileNames = new Set(files.map((f) => f.name.toLowerCase()));
  const hasDockerfile = files.some((f) => f.name === "Dockerfile");
  const composeFileName = COMPOSE_FILE_NAMES.find((name) => fileNames.has(name));
  const terraformFiles = files.filter((f) => f.name.toLowerCase().endsWith(".tf")).map((f) => f.name);
  const ansiblePlaybook = ANSIBLE_PLAYBOOK_NAMES.find((name) => fileNames.has(name));
  return {
    hasDockerfile,
    hasCompose: Boolean(composeFileName),
    ...(composeFileName ? { composeFileName } : {}),
    terraformFiles,
    hasAnsible: Boolean(ansiblePlaybook),
    ...(ansiblePlaybook ? { ansiblePlaybook } : {}),
  };
}

/** true si ce résumé décrit un emplacement effectivement déployable (au moins un mécanisme reconnu). */
function summaryIsCandidate(s: EntriesSummary): boolean {
  return s.hasDockerfile || s.hasCompose || s.terraformFiles.length > 0 || s.hasAnsible;
}

export type GithubDeploymentEngineChoice = "compose" | "dockerfile" | "terraform" | "ansible" | "none";

/**
 * Décide QUEL mécanisme utiliser pour déployer un emplacement donné (racine ou sous-dossier) —
 * fonction pure, appelée par runDeployment sur la détection RÉELLE du clone local, testée
 * indépendamment du réseau/clone (voir test/github.test.ts). Priorité : docker-compose > Dockerfile
 * isolé > Terraform > Ansible > rien — voir types.ts#GithubDeploymentKind pour le raisonnement
 * complet (un docker-compose.yml est un sur-ensemble strict d'un Dockerfile isolé, jamais l'inverse).
 */
export function chooseDeploymentEngine(summary: EntriesSummary): GithubDeploymentEngineChoice {
  if (summary.hasCompose) return "compose";
  if (summary.hasDockerfile) return "dockerfile";
  if (summary.terraformFiles.length > 0) return "terraform";
  if (summary.hasAnsible) return "ansible";
  return "none";
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

export interface ComposeServiceDoc {
  ports?: unknown[];
  expose?: unknown[];
  [key: string]: unknown;
}
export interface ComposeDoc {
  services?: Record<string, ComposeServiceDoc>;
  [key: string]: unknown;
}

/** Port CONTENEUR déclaré par une entrée `ports:` — accepte la syntaxe courte ("8080:80",
 * "80", "80/tcp") et la syntaxe longue (`{ target: 80, ... }`). Retourne `undefined` si
 * indéterminable (jamais deviné). */
export function containerPortFromPortsEntry(entry: unknown): number | undefined {
  if (typeof entry === "string") {
    const withoutProto = entry.split("/")[0] ?? "";
    const parts = withoutProto.split(":");
    const containerPart = parts.at(-1);
    const n = Number(containerPart);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  if (entry && typeof entry === "object" && "target" in entry) {
    const n = Number((entry as { target?: unknown }).target);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Services docker-compose candidats pour recevoir la route de sous-domaine — un service est
 * candidat s'il déclare au moins un port (`ports:` ou `expose:`), jamais deviné pour un service
 * qui n'en déclare aucun (base de données interne typique). YAML illisible/invalide -> [] plutôt
 * que de faire échouer la détection globale (best-effort, même esprit que fetchFileContent).
 */
export function parseComposeServiceCandidates(rawYaml: string): GithubComposeServiceCandidate[] {
  try {
    const doc = yaml.load(rawYaml) as ComposeDoc | undefined;
    if (!doc?.services || typeof doc.services !== "object") return [];
    const out: GithubComposeServiceCandidate[] = [];
    for (const [name, service] of Object.entries(doc.services)) {
      const ports = Array.isArray(service?.ports) ? service.ports : [];
      const expose = Array.isArray(service?.expose) ? service.expose : [];
      if (ports.length === 0 && expose.length === 0) continue;
      const port = ports.length > 0 ? containerPortFromPortsEntry(ports[0]) : Number(expose[0]);
      out.push({ name, ...(port && Number.isInteger(port) && port > 0 ? { port } : {}) });
    }
    return out;
  } catch {
    return [];
  }
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

const EMPTY_DETECTION_FLAGS = { hasDockerfile: false, hasCompose: false, hasTerraform: false, terraformFiles: [] as string[], hasAnsible: false };

/** Segmente et encode un chemin relatif ("apps/api") pour l'API Contents GitHub (.../contents/apps/api). */
function contentsApiPath(owner: string, repo: string, dirPath: string): string {
  const segments = dirPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${segments ? `/${segments}` : ""}`;
}

// Parcours borné (voir mission "détection dans les sous-dossiers") : jamais un parcours illimité
// qui multiplierait les appels API GitHub sans limite — MAX_DEPTH couvre les emplacements les plus
// courants en pratique ("docker/", "deploy/", ou "apps/api/" dans un monorepo à 2 niveaux),
// MAX_DIR_FETCHES borne le coût total même sur un dépôt à l'arborescence très large.
const SUBFOLDER_SCAN_MAX_DEPTH = 3;
const SUBFOLDER_SCAN_MAX_DIR_FETCHES = 40;
const SUBFOLDER_SCAN_IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".git",
  "target",
  "venv",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "coverage",
  ".terraform",
]);

function isScannableDir(entry: GithubApiContentItem): boolean {
  return entry.type === "dir" && !entry.name.startsWith(".") && !SUBFOLDER_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase());
}

/**
 * Parcourt en largeur (BFS), depuis les sous-dossiers directs de la racine (`rootEntries`,
 * DÉJÀ récupérés par l'appelant — jamais un second appel pour la racine elle-même), jusqu'à
 * SUBFOLDER_SCAN_MAX_DEPTH niveaux, à la recherche d'emplacements déployables. Un dossier déjà
 * "candidat" n'est jamais descendu plus loin (un Dockerfile/docker-compose dans un sous-dossier
 * d'un sous-dossier déjà candidat serait presque toujours un faux doublon — image de test, exemple
 * imbriqué). Uniquement appelé quand la RACINE elle-même n'a rien trouvé (voir detectRepo).
 */
async function scanSubfoldersForCandidates(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
  rootEntries: GithubApiContentItem[],
): Promise<GithubDetectionCandidate[]> {
  const candidates: GithubDetectionCandidate[] = [];
  let fetches = 0;
  const queue: Array<{ dirPath: string; depth: number }> = rootEntries
    .filter(isScannableDir)
    .map((e) => ({ dirPath: e.name, depth: 1 }));

  while (queue.length > 0 && fetches < SUBFOLDER_SCAN_MAX_DIR_FETCHES) {
    const next = queue.shift()!;
    fetches += 1;
    let entries: GithubApiContentItem[];
    try {
      const { data } = await githubFetch(`${contentsApiPath(owner, repo, next.dirPath)}?ref=${encodeURIComponent(ref)}`, token);
      entries = Array.isArray(data) ? (data as GithubApiContentItem[]) : [];
    } catch {
      continue; // dossier illisible/inaccessible entre-temps : ignoré, jamais bloquant pour le reste du parcours
    }
    const summary = summarizeEntries(entries);
    if (summaryIsCandidate(summary)) {
      candidates.push({
        path: next.dirPath,
        hasDockerfile: summary.hasDockerfile,
        hasCompose: summary.hasCompose,
        hasTerraform: summary.terraformFiles.length > 0,
        terraformFiles: summary.terraformFiles,
        hasAnsible: summary.hasAnsible,
      });
      continue;
    }
    if (next.depth < SUBFOLDER_SCAN_MAX_DEPTH) {
      for (const entry of entries.filter(isScannableDir)) {
        queue.push({ dirPath: `${next.dirPath}/${entry.name}`, depth: next.depth + 1 });
      }
    }
  }
  return candidates;
}

/** Détection approfondie (exposedPort/composeServices) pour UN emplacement déjà résolu (racine ou
 * sous-dossier unique) — factorisé entre le chemin racine et detectAtPath ci-dessous. */
async function buildResolvedDetection(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
  dirPath: string,
  summary: EntriesSummary,
): Promise<GithubRepoDetection> {
  const filePath = (name: string) => (dirPath ? `${dirPath}/${name}` : name);
  // Lecture RÉELLE du contenu du Dockerfile/docker-compose pour en extraire le port EXPOSE /
  // les services candidats (pré-remplit le formulaire de déploiement) — best-effort, jamais
  // bloquant pour la détection elle-même si absent/illisible.
  const exposedPort = summary.hasDockerfile
    ? parseExposedPort((await fetchFileContent(owner, repo, filePath("Dockerfile"), ref, token)) ?? "")
    : undefined;
  const composeServicesRaw = summary.hasCompose
    ? parseComposeServiceCandidates((await fetchFileContent(owner, repo, filePath(summary.composeFileName!), ref, token)) ?? "")
    : [];
  return {
    ref,
    hasDockerfile: summary.hasDockerfile,
    hasCompose: summary.hasCompose,
    hasTerraform: summary.terraformFiles.length > 0,
    terraformFiles: summary.terraformFiles,
    hasAnsible: summary.hasAnsible,
    ...(summary.ansiblePlaybook ? { ansiblePlaybook: summary.ansiblePlaybook } : {}),
    ...(exposedPort ? { exposedPort } : {}),
    ...(composeServicesRaw.length > 0 ? { composeServices: composeServicesRaw } : {}),
    ...(dirPath ? { detectedPath: dirPath } : {}),
  };
}

async function detectAtPath(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
  dirPath: string,
): Promise<GithubRepoDetection> {
  const { data } = await githubFetch(`${contentsApiPath(owner, repo, dirPath)}?ref=${encodeURIComponent(ref)}`, token);
  const entries = Array.isArray(data) ? (data as GithubApiContentItem[]) : [];
  return buildResolvedDetection(owner, repo, ref, token, dirPath, summarizeEntries(entries));
}

/**
 * GET /api/github/repos/:owner/:repo/detect — appelle l'API GitHub Contents. Sans `explicitPath` :
 * détecte d'abord la RACINE ; si elle n'a rien, parcourt un nombre BORNÉ de sous-dossiers
 * (scanSubfoldersForCandidates) — un seul candidat trouvé -> résolu automatiquement (comme la
 * racine) ; plusieurs -> remontés tels quels dans `candidates`, sans en choisir un à l'aveugle
 * (voir GitHubDeployPage.tsx). Avec `explicitPath` (utilisateur ayant choisi un candidat dans la
 * liste) : détecte directement CET emplacement, sans reparcourir quoi que ce soit d'autre. Un
 * jeton n'est pas strictement requis pour un repo public (API GitHub anonyme, limite de débit plus
 * stricte) : effective peut être `null`, `resolveToken` reste optionnel.
 */
export async function detectRepo(owner: string, repo: string, ref?: string, explicitPath?: string): Promise<GithubRepoDetection> {
  const effective = await getEffectiveToken();
  const token = effective?.token;
  const resolvedRef = ref ?? (await fetchDefaultBranch(owner, repo, token));

  if (explicitPath) {
    return detectAtPath(owner, repo, resolvedRef, token, explicitPath);
  }

  try {
    const { data } = await githubFetch(`${contentsApiPath(owner, repo, "")}?ref=${encodeURIComponent(resolvedRef)}`, token);
    const rootEntries = Array.isArray(data) ? (data as GithubApiContentItem[]) : [];
    const rootSummary = summarizeEntries(rootEntries);
    if (summaryIsCandidate(rootSummary)) {
      return buildResolvedDetection(owner, repo, resolvedRef, token, "", rootSummary);
    }

    const candidates = await scanSubfoldersForCandidates(owner, repo, resolvedRef, token, rootEntries);
    if (candidates.length === 0) {
      return { ref: resolvedRef, ...EMPTY_DETECTION_FLAGS };
    }
    if (candidates.length === 1) {
      return detectAtPath(owner, repo, resolvedRef, token, candidates[0]!.path);
    }
    // Plusieurs emplacements candidats à des endroits DIFFÉRENTS : jamais deviner lequel utiliser,
    // voir GithubRepoDetection#candidates.
    return { ref: resolvedRef, ...EMPTY_DETECTION_FLAGS, candidates };
  } catch (err) {
    // 404 sur /contents : repo vide (aucun commit) — un résumé "rien détecté" est honnête, pas
    // une donnée fabriquée. Toute autre erreur (401/403/429/réseau) est re-levée telle quelle
    // pour que la route puisse répondre avec un diagnostic concret plutôt que masquer le problème.
    if (err instanceof RegistryHttpError && err.status === 404) {
      return { ref: resolvedRef, ...EMPTY_DETECTION_FLAGS };
    }
    throw err;
  }
}

// --- Détection et résolution des variables d'environnement manquantes (bug réel corrigé le
// 14/08/2026, retour utilisateur : "oui jai cette erreur ce qu'il faut faire c'est detecter si ya
// un .env ou .env.local ou autre les ajouter au secret et utiliser ces secret pour le deploiement
// automatique") ------------------------------------------------------------------------------
//
// Un docker-compose.yml référençant `env_file: .env` (ou une clé `environment: KEY:` sans valeur,
// ou un `ARG` de Dockerfile sans défaut) échouait platement à `docker compose up`/`docker build`
// ("env file ... not found", code 14) sur un clone frais — `.env` est presque toujours gitignored
// (pratique standard, un fichier de secrets n'est jamais commité). Au lieu de laisser Docker
// échouer bruyamment, la détection ci-dessous recense CE dont un déploiement a réellement besoin
// AVANT d'invoquer quoi que ce soit, résout ce qui peut l'être depuis :
//  1. un secret déjà stocké pour ce dépôt (voir githubEnvSecretName, secretsStore.ts) — un
//     redéploiement ultérieur ne redemande donc plus jamais les mêmes clés ;
//  2. une valeur par défaut LÉGITIME et NON SENSIBLE trouvée dans un .env.example/.env.sample du
//     dépôt (ex: "PORT=3000") — jamais une valeur qui ressemblerait à un vrai secret (voir
//     looksLikePlaceholderEnvValue/looksSensitiveEnvKey) ;
// et, si des clés REQUISES restent sans valeur après ça, arrête le déploiement à une étape claire
// "configuration requise" (status "needs-config", voir runDeployment) plutôt qu'un échec brut.
//
// Deux consommateurs de cette même logique pure (buildEnvRequirements) : buildDeployConfigSchema
// (aperçu via l'API Contents GitHub, avant clone — alimente GET .../config-schema) et
// resolveAndWriteEnvConfig (vérité terrain sur le VRAI clone local — invoqué par runDeployment
// juste avant deployViaDockerCompose/deployViaDockerBuild), chacun ne fournissant qu'un
// `envFileExists` différent (API GitHub vs `fs.access` local).

// Variantes usuelles d'un gabarit d'environnement (voir mission) — la première trouvée à
// l'emplacement inspecté est utilisée comme liste de référence des clés attendues.
const ENV_EXAMPLE_FILE_NAMES = [".env.example", ".env.sample", ".env.local.example", ".env.dist", ".env.template", "env.example"];

// Heuristique sur le NOM de la clé (jamais sur sa valeur, qu'on ne connaît pas forcément) —
// détermine si le frontend doit afficher un champ masqué (voir EnvVarRequirement#looksSensitive,
// même esprit que les champs token/password des registres déjà gérés dans le frontend). "PASS"
// seul (pas seulement "PASSWORD"/"PASSWD") — couvre les abréviations très courantes en pratique
// ("DB_PASS", "ADMIN_DEFAULT_PASS"...), constaté en conditions réelles le 14/08/2026 lors de la
// vérification de cette mission sur mairie-creusot/formulaire_hotline : DB_PASS/ADMIN_DEFAULT_PASS
// n'étaient PAS détectées comme sensibles avec le seul motif "PASSWORD|PASSWD", affichant un champ
// en clair pour un vrai mot de passe.
const SENSITIVE_ENV_KEY_PATTERN =
  /PASS|PWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|DSN|CONNECTION.?STRING|DATABASE_URL|CERT|CLIENT_SECRET|ACCESS_KEY/i;

export function looksSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_PATTERN.test(key);
}

// Valeurs "placeholder" courantes d'un .env.example — jamais utilisées comme défaut légitime (voir
// looksLikePlaceholderEnvValue) : un .env.example contient normalement des valeurs vides/factices,
// mais on vérifie explicitement plutôt que de faire confiance à la convention.
const PLACEHOLDER_ENV_VALUE_PATTERN = /^(changeme|change_me|change-me|xxx+|todo|example|replace(_?me)?|secret|password|placeholder)$/i;

/** true si `value` ressemble à une valeur factice/placeholder plutôt qu'à une VRAIE valeur par
 * défaut utilisable telle quelle (ex: "changeme", "<votre-clé>", chaîne vide) — voir
 * parseEnvExampleDefaults. Jamais un faux-négatif qui laisserait passer un secret déjà rempli par
 * erreur dans un .env.example : en cas de doute (clé au nom sensible), looksSensitiveEnvKey tranche
 * de toute façon en amont. */
export function looksLikePlaceholderEnvValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.startsWith("<") || v.endsWith(">")) return true;
  if (/your[-_].*here/i.test(v)) return true;
  return PLACEHOLDER_ENV_VALUE_PATTERN.test(v);
}

/**
 * Parse un .env.example/.env.sample (une entrée `KEY=value` par ligne, `#` = commentaire) —
 * retourne, pour chaque clé trouvée, une valeur par défaut UNIQUEMENT si elle est à la fois
 * non-sensible (looksSensitiveEnvKey) ET ne ressemble pas à un placeholder
 * (looksLikePlaceholderEnvValue) : `undefined` sinon (clé connue, mais aucune valeur utilisable
 * sans deviner). Jamais une exception si le fichier est mal formé — lignes illisibles simplement
 * ignorées (best-effort, même esprit que parseComposeServiceCandidates).
 */
export function parseEnvExampleDefaults(raw: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const usable = !looksSensitiveEnvKey(key) && !looksLikePlaceholderEnvValue(value);
    out.set(key, usable ? value : undefined);
  }
  return out;
}

/** Chemins `env_file:` référencés par un service compose — accepte la forme courte (chaîne
 * unique ou liste de chaînes) et la forme longue Compose Spec (`{ path, required }`). */
export function composeEnvFilePaths(service: ComposeServiceDoc): string[] {
  const raw = service.env_file;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((entry) => (typeof entry === "string" ? entry : (entry as { path?: unknown } | undefined)?.path))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** Clés `environment:` déclarées SANS valeur ("KEY:" nul en YAML forme map, ou "KEY" seul en forme
 * liste) — convention docker-compose signifiant "vient du shell/.env hôte", jamais une valeur à
 * deviner. Une entrée "KEY=valeur" (liste) ou "KEY: valeur" (map) a déjà sa valeur, jamais
 * remontée ici. */
export function composeEnvironmentMissingKeys(service: ComposeServiceDoc): string[] {
  const raw = service.environment;
  if (!raw) return [];
  const missing: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      if (!entry.includes("=")) missing.push(entry.trim());
    }
  } else if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) missing.push(key);
    }
  }
  return missing;
}

/** ARG Dockerfile SANS valeur par défaut ("ARG FOO", jamais "ARG FOO=valeur") — jamais deviné,
 * même convention que parseExposedPort ci-dessus (dernière-instruction-gagne non pertinent ici :
 * chaque ARG est indépendant). */
export function parseDockerfileArgsWithoutDefault(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*(=.*)?$/gim)) {
    if (!match[2]) out.push(match[1]!);
  }
  return out;
}

export interface BuildEnvRequirementsInput {
  composeDoc?: ComposeDoc;
  dockerfileContent?: string;
  /** Vide si aucun .env.example/variante n'a été trouvé à l'emplacement inspecté. */
  envExampleDefaults: Map<string, string | undefined>;
  /** Valeurs déjà résolues (secret stocké déchiffré) — jamais journalisées, jamais renvoyées telles
   * quelles par un GET (voir DeployConfigSchema#EnvVarRequirement, qui ne porte qu'un booléen). */
  resolvedValues: Record<string, string>;
  /** Existence RÉELLE d'un fichier `env_file:` référencé — API Contents GitHub (aperçu) ou
   * `fs.access` sur le clone local (vérité terrain) selon l'appelant. */
  envFileExists: (relativePath: string) => Promise<boolean>;
}

export interface BuildEnvRequirementsResult {
  envVars: EnvVarRequirement[];
  missingRequiredKeys: string[];
  unresolvableEnvFile?: string;
}

/**
 * Fonction pure (modulo `envFileExists`, injecté) au cœur de la détection — voir le commentaire
 * d'en-tête de section. Ne remonte QUE les clés qui ont réellement besoin d'une valeur externe :
 * une clé `environment:`/compose déjà littérale n'est jamais remontée (rien à demander).
 */
export async function buildEnvRequirements(input: BuildEnvRequirementsInput): Promise<BuildEnvRequirementsResult> {
  const envVars: EnvVarRequirement[] = [];
  const seen = new Set<string>();
  let unresolvableEnvFile: string | undefined;

  const pushKey = (key: string, source: EnvVarSource, service: string | undefined, envFilePath: string | undefined) => {
    const dedupeKey = `${source}:${service ?? ""}:${envFilePath ?? ""}:${key}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const hasStoredValue = Object.prototype.hasOwnProperty.call(input.resolvedValues, key);
    const exampleDefault = input.envExampleDefaults.get(key);
    envVars.push({
      key,
      required: true,
      hasValue: hasStoredValue || exampleDefault !== undefined,
      source,
      ...(service ? { service } : {}),
      ...(envFilePath ? { envFilePath } : {}),
      looksSensitive: looksSensitiveEnvKey(key),
    });
  };

  if (input.composeDoc?.services) {
    for (const [serviceName, service] of Object.entries(input.composeDoc.services)) {
      for (const key of composeEnvironmentMissingKeys(service)) {
        pushKey(key, "environment", serviceName, undefined);
      }
      for (const envFilePath of composeEnvFilePaths(service)) {
        const exists = await input.envFileExists(envFilePath);
        // Fichier déjà présent dans le dépôt (rare mais possible — valeurs non sensibles commitées
        // volontairement) : rien à demander, docker compose le lira tel quel depuis le clone.
        if (exists) continue;
        if (input.envExampleDefaults.size > 0) {
          for (const key of input.envExampleDefaults.keys()) {
            pushKey(key, "env_file", serviceName, envFilePath);
          }
        } else {
          // Fichier référencé absent ET aucun .env.example pour en déduire les clés attendues :
          // limite honnête, voir DeployConfigSchema#unresolvableEnvFile — jamais un formulaire
          // vide qui laisserait croire à tort qu'il n'y a rien à configurer.
          unresolvableEnvFile = envFilePath;
        }
      }
    }
  }

  if (input.dockerfileContent) {
    for (const key of parseDockerfileArgsWithoutDefault(input.dockerfileContent)) {
      pushKey(key, "dockerfile_arg", undefined, undefined);
    }
  }

  const missingRequiredKeys = envVars.filter((v) => v.required && !v.hasValue).map((v) => v.key);
  return { envVars, missingRequiredKeys, ...(unresolvableEnvFile ? { unresolvableEnvFile } : {}) };
}

// --- Auto-provisioning générique de mot de passe base de données (retour utilisateur réel,
// 14/08/2026, DB_PASS sur mairie-creusot/formulaire_hotline : "bah normalement c'est toi qui la
// creer donc tu peut creer un compt admin ou check dans le code de repos si ya info il faut un
// systeme qui check sa autonome") ------------------------------------------------------------
//
// Quand le MÊME docker-compose.yml définit à la fois un service CONSOMMATEUR (qui attend une clé
// requise, ex: "app" avec `DB_PASS` non résolu) ET un service PRODUCTEUR reconnu (image/nom de
// moteur de base de données bien connu) dont l'un des mots de passe standard référence CETTE MÊME
// clé via l'interpolation compose native (`${DB_PASS}`, `${DB_PASS:-defaut}`...), QUAI contrôle
// RÉELLEMENT les deux côtés dans CE déploiement précis (le service producteur est créé PAR ce
// même `docker compose up`, jamais un service externe deviné) : un mot de passe fort est alors
// généré UNE fois (crypto.randomBytes, jamais un mot de passe faible/prévisible), stocké comme
// secret scopé à ce dépôt (voir githubEnvSecretName) et appliqué de façon cohérente aux deux
// variables PAR LE MÉCANISME D'INTERPOLATION COMPOSE LUI-MÊME (même fichier .env, voir
// resolveAndWriteEnvConfig) — jamais une valeur écrite séparément à deux endroits qui pourrait
// diverger. Preuve exigée AVANT tout provisionnement automatique : la référence `${clé}` doit
// apparaître LITTÉRALEMENT dans le compose de CE dépôt, jamais une supposition sur un service
// externe/déjà existant.

/** Services reconnus comme "producteurs" d'une base de données — nom de service standard OU image
 * d'un moteur connu (mysql/mariadb/postgres/mongo). Heuristique volontairement conservatrice :
 * un service qui ne matche NI l'un NI l'autre n'est jamais considéré comme un producteur, même si
 * son nom contient "db" en partie (ex: "pgdb-migrate" ne matche pas le nom exact attendu). */
const DB_PRODUCER_SERVICE_NAME_PATTERN = /^(db|database|mysql|mariadb|postgres|postgresql|mongo|mongodb)$/i;
const DB_PRODUCER_IMAGE_PATTERN = /^(mysql|mariadb|postgres|postgresql|mongo|mongodb)(:|@|$)/i;

/** Variables d'environnement standard portant le mot de passe d'accès pour chaque moteur reconnu —
 * conventions officielles des images Docker Hub respectives, jamais une supposition. */
const DB_PRODUCER_PASSWORD_VAR_NAMES = new Set([
  "MYSQL_ROOT_PASSWORD",
  "MYSQL_PASSWORD",
  "MARIADB_ROOT_PASSWORD",
  "MARIADB_PASSWORD",
  "POSTGRES_PASSWORD",
  "MONGO_INITDB_ROOT_PASSWORD",
]);

function looksLikeDbProducerService(serviceName: string, service: ComposeServiceDoc): boolean {
  const image = typeof service.image === "string" ? service.image : "";
  return DB_PRODUCER_SERVICE_NAME_PATTERN.test(serviceName) || DB_PRODUCER_IMAGE_PATTERN.test(image);
}

/** Extrait la clé référencée par une interpolation compose SIMPLE `${KEY}` / `${KEY:-defaut}` /
 * `${KEY-defaut}` — `undefined` pour toute autre forme (valeur littérale, expression imbriquée...),
 * jamais interprétée à l'aveugle. Même famille de syntaxe que Docker Compose lui-même. */
export function composeInterpolatedVarName(rawValue: unknown): string | undefined {
  if (typeof rawValue !== "string") return undefined;
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-.*)?\}$/.exec(rawValue.trim());
  return match?.[1];
}

/** true si `key` est PROUVÉE, dans CE MÊME compose, alimenter le mot de passe d'un service base de
 * données reconnu — voir le commentaire de section ci-dessus. Fonction pure, testée indépendamment. */
export function isDbCredentialProvisionable(composeDoc: ComposeDoc | undefined, key: string): boolean {
  if (!composeDoc?.services) return false;
  for (const [serviceName, service] of Object.entries(composeDoc.services)) {
    if (!looksLikeDbProducerService(serviceName, service)) continue;
    const raw = service.environment;
    const entries: Array<[string, unknown]> = Array.isArray(raw)
      ? raw
          .filter((e): e is string => typeof e === "string" && e.includes("="))
          .map((e) => {
            const eq = e.indexOf("=");
            return [e.slice(0, eq), e.slice(eq + 1)] as [string, unknown];
          })
      : raw && typeof raw === "object"
        ? Object.entries(raw as Record<string, unknown>)
        : [];
    for (const [envKey, envValue] of entries) {
      if (!DB_PRODUCER_PASSWORD_VAR_NAMES.has(envKey.toUpperCase())) continue;
      if (composeInterpolatedVarName(envValue) === key) return true;
    }
  }
  return false;
}

/** Mot de passe fort généré côté serveur (192 bits d'entropie, alphabet URL-safe — jamais un mot
 * de passe faible/prévisible, voir mission) — utilisé pour l'auto-provisioning DB ET le seeder de
 * compte admin ci-dessous. */
export function generateStrongSecret(): string {
  return randomBytes(24).toString("base64url");
}

// --- Seeder générique de compte admin par défaut (retour utilisateur réel, 14/08/2026 : "genre
// admin@localhost.fr mdp simple bref quand ya des truc dans ce genre ou ont a le controle
// utiliser un systeme de seeder ou utilisateur peut toujour overide si il le shouaite") --------
//
// Une clé qui ressemble à un compte admin PAR DÉFAUT d'une application que QUAI déploie
// lui-même (jamais un compte d'un système EXTERNE) reçoit une valeur SUGGÉRÉE — jamais appliquée
// en silence : le champ reste visible/éditable dans le formulaire (DeployConfigForm.tsx),
// pré-rempli avec cette suggestion que l'utilisateur peut remplacer avant de valider. Le mot de
// passe suggéré est généré fort (generateStrongSecret), jamais "simple" malgré le mot de
// l'utilisateur — c'est un vrai compte admin d'une vraie application.

const ADMIN_SEED_EMAIL_KEY_PATTERN = /^(ADMIN_DEFAULT_EMAIL|ADMIN_EMAIL|DEFAULT_ADMIN_EMAIL|SEED_ADMIN_EMAIL)$/i;
const ADMIN_SEED_PASSWORD_KEY_PATTERN = /^(ADMIN_DEFAULT_PASS(WORD)?|ADMIN_PASSWORD|DEFAULT_ADMIN_PASS(WORD)?|SEED_ADMIN_PASS(WORD)?)$/i;

/** Segment DNS-safe dérivé du nom du dépôt — même esprit que defaultSubdomainFor côté frontend
 * (GitHubDeployPage.tsx), réutilisé ici pour un email de démonstration plausible et unique par dépôt. */
function repoSlug(repo: string): string {
  return (
    repo
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app"
  );
}

/** Suggestion pour une clé "seed admin" reconnue — `undefined` si `key` ne matche aucun des deux
 * motifs (email/mot de passe), jamais un provisionnement pour une clé qui n'y ressemble pas. */
export function adminSeedSuggestion(key: string, repo: string): string | undefined {
  if (ADMIN_SEED_EMAIL_KEY_PATTERN.test(key)) return `admin@${repoSlug(repo)}.local`;
  if (ADMIN_SEED_PASSWORD_KEY_PATTERN.test(key)) return generateStrongSecret();
  return undefined;
}

/**
 * Applique les deux mécanismes génériques ci-dessus sur une liste d'EnvVarRequirement déjà
 * calculée par buildEnvRequirements — factorisé entre buildDeployConfigSchema (aperçu, ne
 * persiste rien) et resolveAndWriteEnvConfig (déploiement réel, persiste la valeur DB générée).
 * Mute `envVars` EN PLACE (tableau déjà possédé par l'appelant, jamais partagé ailleurs) et
 * retourne la liste de clés encore réellement bloquantes après application.
 */
function applyAutoResolutions(envVars: EnvVarRequirement[], composeDoc: ComposeDoc | undefined, repo: string): string[] {
  for (const v of envVars) {
    if (v.hasValue) continue;
    if (isDbCredentialProvisionable(composeDoc, v.key)) {
      v.hasValue = true;
      v.autoResolution = "db-provisioned";
      continue;
    }
    const suggestion = adminSeedSuggestion(v.key, repo);
    if (suggestion !== undefined) {
      v.autoResolution = "admin-seed";
      v.suggestedValue = suggestion;
      // hasValue reste false : le champ DOIT rester visible/éditable, jamais appliqué en silence.
    }
  }
  return envVars.filter((v) => v.required && !v.hasValue).map((v) => v.key);
}

/** Nom du secret multi-clé (JSON) portant les variables d'environnement résolues pour CE dépôt —
 * scope au dépôt entier (pas par sous-dossier : un dépôt a en pratique une configuration
 * d'environnement cohérente d'un seul tenant, simplification assumée et documentée). Convention
 * cohérente avec le modèle de données existant (secretsStore.ts, secrets nommés). */
export function githubEnvSecretName(owner: string, repo: string): string {
  return `github-env:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Entrée stockée pour une clé donnée dans le secret multi-clé d'un dépôt — soit une valeur
 * littérale (chiffrée avec le reste du blob JSON, comme avant), soit une RÉFÉRENCE vers un secret
 * DÉJÀ existant ailleurs dans secretsStore.ts (`{ secretRef: <id> }`) : la copie n'est jamais
 * dupliquée, résolue à la demande (getStoredEnvValues) — si le secret référencé est renommé/tourné
 * plus tard, ce dépôt récupère automatiquement la nouvelle valeur au prochain déploiement, jamais
 * une copie figée au moment de la référence. Mécanisme générique demandé par la mission "SMTP
 * partagé entre plusieurs dépôts" — voir routes/github.ts#PUT .../config-values.
 */
type StoredEnvEntry = string | { secretRef: string };

/** Forme BRUTE (non résolue) du secret multi-clé de ce dépôt — utilisée uniquement par
 * saveGithubEnvValues pour fusionner sans jamais devoir déchiffrer/reformer les entrées déjà
 * présentes. Jamais exposée par une route. */
async function getStoredEnvEntriesRaw(owner: string, repo: string): Promise<Record<string, StoredEnvEntry>> {
  const raw = await getDecryptedSecretValue(githubEnvSecretName(owner, repo));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredEnvEntry>) : {};
  } catch {
    return {};
  }
}

/** Valeurs RÉSOLUES (déchiffrées) pour ce dépôt — une entrée `{secretRef}` est déréférencée vers
 * la valeur COURANTE du secret ciblé (jamais une copie figée) ; si ce secret référencé a disparu
 * depuis (supprimé), la clé est simplement absente du résultat, jamais une exception qui ferait
 * échouer toute la résolution. Jamais exposée telle quelle par une route — voir
 * buildDeployConfigSchema/resolveAndWriteEnvConfig qui n'en dérivent qu'un booléen `hasValue` ou
 * les consomment pour écrire un VRAI fichier .env local, jamais pour les renvoyer au client. */
async function getStoredEnvValues(owner: string, repo: string): Promise<Record<string, string>> {
  const rawEntries = await getStoredEnvEntriesRaw(owner, repo);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rawEntries)) {
    if (typeof entry === "string") {
      out[key] = entry;
      continue;
    }
    if (entry && typeof entry === "object" && typeof entry.secretRef === "string") {
      const value = await getDecryptedSecretValueById(entry.secretRef).catch(() => null);
      if (value !== null) out[key] = value;
    }
  }
  return out;
}

/**
 * PUT /api/github/repos/:owner/:repo/config-values (voir routes/github.ts) — fusionne les valeurs
 * fournies dans le secret JSON multi-clé de ce dépôt (créé au premier appel, mis à jour ensuite).
 * Une valeur vide/absente n'écrase JAMAIS une valeur déjà stockée : un formulaire qui ne modifie
 * que certains champs (les autres restant masqués "déjà configuré") ne doit jamais effacer le reste.
 * `secretRefs` (optionnel) : référence un secret DÉJÀ existant par id au lieu de retaper une
 * valeur — voir StoredEnvEntry ; l'appelant (routes/github.ts) DOIT avoir vérifié que chaque id
 * existe réellement avant d'appeler cette fonction (jamais une référence fantôme silencieuse).
 */
export async function saveGithubEnvValues(
  owner: string,
  repo: string,
  values: Record<string, string>,
  secretRefs?: Record<string, string>,
): Promise<void> {
  const existing = await getStoredEnvEntriesRaw(owner, repo);
  const merged: Record<string, StoredEnvEntry> = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  for (const [key, secretId] of Object.entries(secretRefs ?? {})) {
    if (secretId) merged[key] = { secretRef: secretId };
  }
  const name = githubEnvSecretName(owner, repo);
  const all = await listSecrets();
  const found = all.find((s) => s.name === name);
  const payload = JSON.stringify(merged);
  if (found) {
    await updateSecret(found.id, { value: payload });
  } else {
    await createSecret({
      name,
      value: payload,
      description: `Variables d'environnement résolues pour le déploiement GitHub ${owner}/${repo} (secret multi-clé, JSON — valeurs littérales et/ou références vers d'autres secrets) — réutilisées automatiquement à chaque redéploiement suivant.`,
    });
  }
}

/**
 * GET /api/github/repos/:owner/:repo/config-schema (voir routes/github.ts) — même détection que
 * detectRepo (API Contents GitHub, aperçu avant clone), mais orientée "ce qu'il faut configurer"
 * plutôt que "quel moteur utiliser". Jamais de valeur réelle de secret dans le résultat.
 */
export async function buildDeployConfigSchema(
  owner: string,
  repo: string,
  ref?: string,
  explicitPath?: string,
): Promise<DeployConfigSchema> {
  const effective = await getEffectiveToken();
  const token = effective?.token;
  const resolvedRef = ref ?? (await fetchDefaultBranch(owner, repo, token));
  const dirPath = explicitPath ?? "";
  const filePath = (name: string) => (dirPath ? `${dirPath}/${name}` : name);

  const { data } = await githubFetch(`${contentsApiPath(owner, repo, dirPath)}?ref=${encodeURIComponent(resolvedRef)}`, token);
  const entries = Array.isArray(data) ? (data as GithubApiContentItem[]) : [];
  const summary = summarizeEntries(entries);

  const composeRaw = summary.hasCompose
    ? await fetchFileContent(owner, repo, filePath(summary.composeFileName!), resolvedRef, token)
    : undefined;
  const composeDoc = composeRaw ? ((yaml.load(composeRaw) as ComposeDoc | undefined) ?? undefined) : undefined;
  const dockerfileContent = summary.hasDockerfile
    ? await fetchFileContent(owner, repo, filePath("Dockerfile"), resolvedRef, token)
    : undefined;

  let envExampleDefaults = new Map<string, string | undefined>();
  for (const name of ENV_EXAMPLE_FILE_NAMES) {
    const content = await fetchFileContent(owner, repo, filePath(name), resolvedRef, token);
    if (content !== undefined) {
      envExampleDefaults = parseEnvExampleDefaults(content);
      break;
    }
  }

  const storedValues = await getStoredEnvValues(owner, repo);
  const envFileExists = async (relativePath: string): Promise<boolean> =>
    (await fetchFileContent(owner, repo, filePath(relativePath), resolvedRef, token)) !== undefined;

  const { envVars, unresolvableEnvFile } = await buildEnvRequirements({
    ...(composeDoc ? { composeDoc } : {}),
    ...(dockerfileContent ? { dockerfileContent } : {}),
    envExampleDefaults,
    resolvedValues: storedValues,
    envFileExists,
  });
  // Auto-provisioning DB (preuve dans CE compose) + seeder de compte admin par défaut — voir
  // applyAutoResolutions. Aperçu SEULEMENT ici (aucune écriture/génération persistée) : la
  // génération réelle du mot de passe DB n'a lieu qu'au moment du déploiement effectif, voir
  // resolveAndWriteEnvConfig — GET ne doit jamais avoir d'effet de bord.
  const missingRequiredKeys = applyAutoResolutions(envVars, composeDoc, repo);

  const ports: DeployPortRequirement[] = [];
  if (composeDoc?.services) {
    for (const [serviceName, service] of Object.entries(composeDoc.services)) {
      for (const entry of Array.isArray(service.ports) ? service.ports : []) {
        const containerPort = containerPortFromPortsEntry(entry);
        if (!containerPort) continue;
        const hostPort = parseFixedHostPort(entry);
        ports.push({ service: serviceName, containerPort, ...(hostPort ? { hostPort } : {}), overridable: true });
      }
    }
  } else if (summary.hasDockerfile && dockerfileContent) {
    const exposed = parseExposedPort(dockerfileContent);
    if (exposed) ports.push({ containerPort: exposed, overridable: true });
  }

  const volumes: DeployVolumeInfo[] = [];
  if (composeDoc?.services) {
    for (const [serviceName, service] of Object.entries(composeDoc.services)) {
      const rawVolumes = service.volumes;
      if (!Array.isArray(rawVolumes)) continue;
      for (const entry of rawVolumes) {
        if (typeof entry === "string") {
          const parts = entry.split(":");
          if (parts.length < 2) continue; // volume anonyme ("/data" seul) : rien de significatif à afficher
          const [source, target, mode] = parts;
          volumes.push({ service: serviceName, source: source!, target: target!, readOnly: mode === "ro" });
        } else if (entry && typeof entry === "object") {
          const v = entry as { source?: string; target?: string; read_only?: boolean };
          if (v.source && v.target) volumes.push({ service: serviceName, source: v.source, target: v.target, readOnly: Boolean(v.read_only) });
        }
      }
    }
  }

  return {
    owner,
    repo,
    ref: resolvedRef,
    ...(dirPath ? { configPath: dirPath } : {}),
    envVars,
    missingRequiredKeys,
    ports,
    volumes,
    ...(unresolvableEnvFile ? { unresolvableEnvFile } : {}),
  };
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

/** Détection identique à summarizeEntries, mais sur le vrai clone local — la vérité terrain
 * utilisée pour décider quoi déployer (pas la détection GitHub API, qui n'est qu'un aperçu).
 * `subPath` = sous-dossier à inspecter dans le clone ("" = racine, voir GithubRepoDetection#detectedPath). */
async function detectLocalEntriesAt(cloneDir: string, subPath: string): Promise<EntriesSummary> {
  const target = subPath ? path.join(cloneDir, subPath) : cloneDir;
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, type: "file" }));
  return summarizeEntries(files);
}

/**
 * `configPath` provient du client (candidat choisi dans GithubRepoDetection#candidates) : jamais
 * fait confiance sans validation avant de le combiner à un chemin de fichier local
 * (path.join(cloneDir, configPath) dans runDeployment) — même esprit défense-en-profondeur que
 * isValidWorkspaceId (services/iac/workspaces.ts). Un segment "." ou ".." romprait l'isolation du
 * clone temporaire ; un chemin absolu l'ignorerait complètement.
 */
export function isSafeRelativeConfigPath(value: string): boolean {
  if (!value) return true; // "" = racine, toujours valide
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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

/**
 * Crée réellement la route reverse-proxy vers `containerId` pour `subdomain` et journalise/persiste
 * le résultat — factorisé entre deployViaDockerBuild (conteneur unique) et deployViaDockerCompose
 * (service choisi/déduit), même comportement pour les deux : jamais un second système de suivi
 * parallèle (voir en-tête de fichier).
 */
async function createSubdomainRouteForDeployment(
  deploymentId: string,
  subdomain: string,
  containerId: string,
  containerLabel: string,
  targetPort: number,
  /** true : un SubdomainConflictError (route déjà existante pour ce sous-domaine) déclenche la
   * suppression de l'ancienne route puis UNE nouvelle tentative — jamais plus d'une fois (évite
   * toute boucle), voir l'appel depuis un redéploiement. `false` (défaut, premier déploiement) :
   * un conflit est une vraie anomalie remontée telle quelle, jamais une suppression à l'aveugle
   * d'une route qui pourrait appartenir à tout autre chose. */
  replaceExisting = false,
): Promise<void> {
  try {
    const route = await createRoute({ subdomain, targetContainerId: containerId, targetPort });
    await appendDeploymentLog(deploymentId, `Route reverse-proxy créée : https://${subdomain} -> ${containerLabel}:${targetPort}\n`);
    await updateDeploymentRecord(deploymentId, { reverseProxyRouteId: route.id });
  } catch (err) {
    // Un redéploiement (même sous-domaine que la fois précédente) peut retomber sur une route
    // encore enregistrée sous l'ANCIEN conteneur/projet compose déjà supprimé entre-temps (le
    // chaînage par historique de déploiement, voir tearDownPreviousCompose, ne couvre pas tous
    // les cas — ex: la route du tout premier déploiement d'une chaîne dont aucun maillon
    // intermédiaire n'a lui-même réussi à route) : constaté en conditions réelles le 14/08/2026
    // lors de la vérification de cette mission. Un seul rattrapage (jamais de boucle), et
    // uniquement pour CE sous-domaine précis — jamais une route sans rapport.
    if (replaceExisting && err instanceof SubdomainConflictError) {
      const existing = (await listRoutes()).find((r) => r.subdomain === subdomain);
      if (existing) {
        await appendDeploymentLog(
          deploymentId,
          `Sous-domaine "${subdomain}" déjà routé vers une ressource d'un déploiement précédent — remplacement de la route.\n`,
        );
        await deleteRoute(existing.id).catch(() => undefined);
        return createSubdomainRouteForDeployment(deploymentId, subdomain, containerId, containerLabel, targetPort, false);
      }
    }
    // CaddyPushFailedError : la route est malgré tout créée/persistée côté QUAI (voir
    // services/reverseProxy.ts#createRoute) — seul le miroir Caddy n'a pas pu être mis à jour
    // tout de suite (rejouable via POST /api/reverse-proxy/push). reverseProxyRouteId doit donc
    // quand même être enregistré, sinon le lien de domaine "réussi" disparaîtrait à tort.
    if (err instanceof CaddyPushFailedError && err.route) {
      await appendDeploymentLog(
        deploymentId,
        `Route reverse-proxy créée (https://${subdomain} -> ${containerLabel}:${targetPort}) mais Caddy injoignable pour l'instant : ${err.message} — un re-push (POST /api/reverse-proxy/push) suffira.\n`,
      );
      await updateDeploymentRecord(deploymentId, { reverseProxyRouteId: err.route.id });
    } else {
      // Best-effort, jamais bloquant : le déploiement Docker a réussi, seule la route échoue.
      await appendDeploymentLog(deploymentId, `Échec de la création de la route reverse-proxy pour "${subdomain}" : ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function deployViaDockerBuild(
  deploymentId: string,
  cloneDir: string,
  owner: string,
  repo: string,
  targetEnvironmentId: string | undefined,
  subdomain: string | undefined,
  portOverride: number | undefined,
  /** ARG Dockerfile résolus (secret stocké ou défaut légitime .env.example, voir
   * resolveAndWriteEnvConfig) — passés tels quels à `docker build --build-arg`, jamais devinés. */
  buildArgs: Record<string, string> = {},
): Promise<void> {
  const docker = await getClient(targetEnvironmentId);
  const imageTag = `quai-gh/${sanitizeDockerName(owner)}-${sanitizeDockerName(repo)}:${deploymentId.slice(0, 8)}`;

  const buildArgKeys = Object.keys(buildArgs);
  await appendDeploymentLog(
    deploymentId,
    `$ docker build -t ${imageTag}${buildArgKeys.length > 0 ? ` ${buildArgKeys.map((k) => `--build-arg ${k}=***`).join(" ")}` : ""} .\n`,
  );
  const files = await listBuildContextFiles(cloneDir);
  // buildImage() elle-même ne fait que POSTer la requête et retourne quasi immédiatement un
  // flux de progression — c'est la CONSOMMATION de ce flux (followProgress ci-dessous) qui dure
  // le temps réel du build : le timeout doit donc englober followProgress, pas ce seul appel.
  const buildStream = await docker.buildImage(
    { context: cloneDir, src: files },
    { t: imageTag, ...(buildArgKeys.length > 0 ? { buildargs: buildArgs } : {}) },
  );

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
    // replaceExisting=true : un redéploiement du même repo/sous-domaine (bouton "Redéployer",
    // TopologyNodeDetailPanel.tsx) crée un TOUT NOUVEAU conteneur (comportement historique
    // inchangé, l'ancien reste tel quel) mais doit reprendre la MÊME route — jamais un
    // SubdomainConflictError qui laisserait le nouveau conteneur démarré sans route utilisable.
    await createSubdomainRouteForDeployment(deploymentId, subdomain, container.id, containerName, targetPort, true);
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

/** Même mécanisme que deployViaIacWorkspace (Terraform), pour un playbook Ansible détecté sans
 * Dockerfile ni docker-compose — même kind "iac-workspace" (voir GithubDeploymentKind), moteur
 * "ansible" distingué via IacWorkspace#engine. Aucun `ansible-playbook` lancé automatiquement. */
async function deployViaAnsibleWorkspace(
  deploymentId: string,
  ansibleDir: string,
  owner: string,
  repo: string,
  playbookFileName: string,
  startedBy: string,
): Promise<void> {
  const workspace = await createWorkspace({
    name: `github-${owner}-${repo}-${new Date().toISOString().slice(0, 10)}`,
    engine: "ansible",
    createdBy: startedBy,
  });
  // Scaffold de démo Ansible (playbook.yml + inventory.ini, voir iac/workspaces.ts#SCAFFOLD)
  // retiré avant de copier les vrais fichiers du dépôt — même principe que "main.tf" pour tofu.
  await deleteWorkspaceFile(workspace.id, "playbook.yml");
  await deleteWorkspaceFile(workspace.id, "inventory.ini");

  const playbookContent = await fs.readFile(path.join(ansibleDir, playbookFileName), "utf-8");
  await writeWorkspaceFile(workspace.id, "playbook.yml", playbookContent);

  // Fichier d'inventaire réel du dépôt s'il existe (voir ANSIBLE_INVENTORY_NAMES), copié sous le
  // nom attendu par iac/runner.ts#buildCommand ("inventory.ini") — sinon aucun inventaire n'est
  // recréé (le scaffold "localhost" par défaut a été retiré ci-dessus) : ansible-playbook
  // utilisera son inventaire implicite au moment où l'utilisateur lancera "run" explicitement.
  let inventoryFileName: string | undefined;
  for (const name of ANSIBLE_INVENTORY_NAMES) {
    const content = await fs.readFile(path.join(ansibleDir, name), "utf-8").catch(() => undefined);
    if (content !== undefined) {
      await writeWorkspaceFile(workspace.id, "inventory.ini", content);
      inventoryFileName = name;
      break;
    }
  }

  await appendDeploymentLog(
    deploymentId,
    `Workspace IaC créé : ${workspace.id} (playbook Ansible "${playbookFileName}" copié depuis le dépôt` +
      `${inventoryFileName ? `, avec l'inventaire "${inventoryFileName}"` : ", sans fichier d'inventaire détecté (inventaire implicite localhost)"}).\n` +
      `Aucun "ansible-playbook" n'a été lancé automatiquement — ouvrez la page Infra-as-code pour l'exécuter explicitement.\n`,
  );

  await updateDeploymentRecord(deploymentId, { kind: "iac-workspace", iacWorkspaceId: workspace.id });
}

// --- Déploiement docker-compose réel ------------------------------------------------------------
//
// Contrairement à deployViaDockerBuild (un seul `docker run`), docker-compose peut démarrer
// PLUSIEURS conteneurs à partir d'un fichier tiers dont QUAI ne maîtrise ni les noms de service ni
// les ports — deux risques concrets gérés explicitement ci-dessous :
//  1. Collision de nom de projet avec un AUTRE déploiement compose sur ce même hôte Docker
//     (nommage isolé, dérivé de l'id de déploiement — voir COMPOSE_PROJECT_PREFIX).
//  2. Collision de PORT HÔTE fixe ("ports: [\"3000:3000\"]") avec un conteneur RÉEL déjà en cours
//     d'exécution — stratégie retenue : réécriture du fichier compose lui-même (jamais un
//     `-f override.yml` séparé, voir rewriteComposePortsForConflicts) vers un port hôte libre,
//     détectée et loggée clairement AVANT de lancer `up`, plutôt qu'un échec Docker brut
//     incompréhensible ("port is already allocated").

/** Ports hôte RÉELLEMENT occupés par des conteneurs EN COURS D'EXÉCUTION sur la cible (docker.
 * listContainers(), pas la liste "all" : un conteneur arrêté ne tient aucun port au niveau noyau)
 * — limite assumée : ne voit que ce que CE démon Docker gère lui-même. Un process non-Docker déjà
 * lié à ce port sur l'hôte resterait invisible ici (hors du radar de dockerode depuis ce
 * conteneur) et ferait encore échouer `docker compose up` dans ce cas rare — l'échec Docker réel
 * remonte alors tel quel dans le journal, jamais masqué. */
async function usedHostPorts(docker: Docker): Promise<Set<number>> {
  const containers = await docker.listContainers();
  const ports = new Set<number>();
  for (const c of containers) {
    for (const p of c.Ports ?? []) {
      if (typeof p.PublicPort === "number") ports.add(p.PublicPort);
    }
  }
  return ports;
}

const COMPOSE_REMAP_PORT_MIN = 20000;
const COMPOSE_REMAP_PORT_MAX = 59999;

/** Choisit un port hôte libre (absent de `used`) dans une plage haute peu susceptible d'être déjà
 * répartie — tentatives bornées (jamais de boucle infinie théorique) : un échec ici est remonté
 * honnêtement plutôt que de retourner une valeur hors plage. */
export function pickFreeHostPort(used: Set<number>): number {
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = COMPOSE_REMAP_PORT_MIN + Math.floor(Math.random() * (COMPOSE_REMAP_PORT_MAX - COMPOSE_REMAP_PORT_MIN));
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Impossible de trouver un port hôte libre pour remapper un conflit de port docker-compose");
}

/** Port HÔTE explicitement fixé par une entrée `ports:` — accepte la syntaxe courte
 * ("8080:80", "127.0.0.1:8080:80/tcp") et la syntaxe longue (`{ published: 8080, ... }`).
 * Retourne `null` pour une entrée SANS port hôte explicite ("80" seul, ou long sans `published`) :
 * Docker choisit alors lui-même un port hôte libre, jamais un risque de conflit à corriger. */
export function parseFixedHostPort(entry: unknown): number | null {
  if (typeof entry === "string") {
    const withoutProto = entry.split("/")[0] ?? "";
    const parts = withoutProto.split(":");
    if (parts.length < 2) return null;
    const hostPort = Number(parts.at(-2));
    return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
  }
  if (entry && typeof entry === "object" && "published" in entry) {
    const published = (entry as { published?: unknown }).published;
    if (published === undefined || published === null || published === "") return null;
    const hostPort = Number(published);
    return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
  }
  return null;
}

/** Reconstruit une entrée `ports:` avec un nouveau port hôte, en conservant le reste tel quel
 * (port conteneur, IP de bind, protocole). */
export function rewritePortEntry(entry: unknown, newHostPort: number): unknown {
  if (typeof entry === "string") {
    const [withoutProto, proto] = entry.split("/");
    const parts = withoutProto!.split(":");
    parts[parts.length - 2] = String(newHostPort);
    return proto ? `${parts.join(":")}/${proto}` : parts.join(":");
  }
  return { ...(entry as object), published: newHostPort };
}

/**
 * Applique EN PLACE les ports hôte explicitement choisis par l'utilisateur (voir
 * DeployPortRequirement#overridable, `composePortOverrides` sur POST .../deploy) — un port hôte
 * précis plutôt que le remap automatique. Appliqué AVANT rewriteComposePortsForConflicts, qui reste
 * la protection de dernier ressort : si le port demandé est malgré tout déjà occupé, il est
 * remplacé par un port libre comme n'importe quel autre conflit, jamais un `docker compose up` qui
 * échouerait à l'aveugle sur le choix explicite de l'utilisateur. Ignore silencieusement un service
 * inconnu ou sans port déclaré (l'utilisateur ne peut choisir que parmi `DeployPortRequirement`,
 * mais le fichier a pu changer entre la lecture du schéma et ce déploiement — best-effort, jamais
 * bloquant).
 */
export function applyComposeHostPortOverrides(doc: ComposeDoc, overrides: Record<string, number>): void {
  if (!doc.services) return;
  for (const [serviceName, desiredHostPort] of Object.entries(overrides)) {
    const service = doc.services[serviceName];
    if (!service || !Array.isArray(service.ports) || service.ports.length === 0) continue;
    service.ports[0] = rewritePortEntry(service.ports[0], desiredHostPort);
  }
}

export interface ComposePortRemap {
  service: string;
  oldHostPort: number;
  newHostPort: number;
}

/**
 * Mute `doc` EN PLACE : remplace tout port hôte fixe déjà utilisé (voir usedHostPorts) par un port
 * libre. Réécrit le YAML PARSÉ lui-même plutôt qu'un fichier `-f override.yml` séparé : la
 * fusion multi-fichiers de docker-compose CONCATÈNE (ne remplace pas) les champs de type liste
 * comme `ports` — un override ne contenant que le port corrigé aurait laissé l'entrée conflictuelle
 * d'origine intacte EN PLUS de la corrigée, reproduisant exactement le même conflit. Retourne la
 * liste des remplacements effectués (pour le journal), vide si aucun conflit détecté.
 */
export function rewriteComposePortsForConflicts(doc: ComposeDoc, used: Set<number>): ComposePortRemap[] {
  const remaps: ComposePortRemap[] = [];
  if (!doc.services) return remaps;
  for (const [serviceName, service] of Object.entries(doc.services)) {
    if (!Array.isArray(service.ports)) continue;
    service.ports = service.ports.map((entry) => {
      const hostPort = parseFixedHostPort(entry);
      if (hostPort === null || !used.has(hostPort)) return entry;
      const newHostPort = pickFreeHostPort(used);
      used.add(newHostPort);
      remaps.push({ service: serviceName, oldHostPort: hostPort, newHostPort });
      return rewritePortEntry(entry, newHostPort);
    });
  }
  return remaps;
}

/**
 * Environnement à passer au sous-processus `docker compose` pour qu'il cible EXACTEMENT le même
 * démon que celui résolu par services/docker.ts#getClient pour ce même `targetEnvironmentId` —
 * dockerode et la CLI `docker` ne partagent aucun état, chacun doit être configuré séparément.
 * "ssh" (tunnel poolé applicatif, services/sshTunnel.ts) n'est PAS pris en charge pour ce
 * sous-processus CLI dans ce lot : câbler un agent HTTP applicatif sur un `spawn` n'est pas
 * possible, et le propre client SSH intégré de la CLI Docker (`DOCKER_HOST=ssh://...`) est un
 * mécanisme entièrement différent (paire de clés/known_hosts) — limitation documentée plutôt qu'un
 * comportement à moitié fonctionnel, voir le rapport de mission.
 */
async function resolveComposeCliEnv(targetEnvironmentId: string | undefined): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  if (!targetEnvironmentId) {
    const effective = await getEffectiveDockerConfig();
    return {
      env: effective.host ? { ...process.env, DOCKER_HOST: effective.host } : { ...process.env },
      cleanup: async () => undefined,
    };
  }
  const remote = await getEffectiveRemoteDockerConfig(targetEnvironmentId);
  if (!remote) throw new Error(`Remote Docker environment "${targetEnvironmentId}" not found`);
  if (remote.transport === "ssh") {
    throw new Error(
      `Déploiement docker-compose non pris en charge vers un environnement Docker distant en transport SSH ("${remote.name}") dans ce lot — utilisez "Docker local" ou un environnement distant TCP+TLS.`,
    );
  }
  const dockerHostUrl = `tcp://${remote.host}:${remote.port}`;
  const hasTls = Boolean(remote.tls?.ca || remote.tls?.cert || remote.tls?.key);
  if (!hasTls) {
    return { env: { ...process.env, DOCKER_HOST: dockerHostUrl }, cleanup: async () => undefined };
  }
  // Certificats écrits dans un dossier temporaire dédié — noms imposés par la convention
  // DOCKER_CERT_PATH de la CLI Docker (ca.pem/cert.pem/key.pem), supprimé après l'appel.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quai-compose-tls-"));
  await Promise.all([
    remote.tls?.ca ? fs.writeFile(path.join(dir, "ca.pem"), remote.tls.ca, { mode: 0o600 }) : undefined,
    remote.tls?.cert ? fs.writeFile(path.join(dir, "cert.pem"), remote.tls.cert, { mode: 0o600 }) : undefined,
    remote.tls?.key ? fs.writeFile(path.join(dir, "key.pem"), remote.tls.key, { mode: 0o600 }) : undefined,
  ]);
  return {
    env: { ...process.env, DOCKER_HOST: dockerHostUrl, DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: dir },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Lance réellement `docker <args>` (compose) en sous-processus, journalise sa sortie en direct
 * (stdout+stderr entrelacés, même principe que iac/runner.ts#startRun) et attend sa fin. En cas
 * d'échec, le message d'erreur inclut la FIN de la sortie réelle de Docker (jamais juste un code
 * de sortie brut) — à la fois plus actionnable pour l'utilisateur et exploitable par
 * extractUnavailablePort ci-dessous pour la nouvelle tentative automatique sur port indisponible. */
function runComposeCommand(deploymentId: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, env });
    let combined = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      combined += text;
      void appendDeploymentLog(deploymentId, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => reject(new Error(`Impossible de lancer "docker compose" : ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"docker compose" a échoué (code de sortie ${code}) : ${combined.trim().slice(-800)}`));
    });
  });
}

/**
 * Extrait un port hôte depuis un message d'échec RÉEL de Docker (formes observées en conditions
 * réelles : "Bind for 0.0.0.0:PORT failed: port is already allocated" sur Linux, "ports are not
 * available: exposing port TCP 0.0.0.0:PORT -> ... : listen tcp 0.0.0.0:PORT: bind: ..." sur
 * Docker Desktop/Windows — ce dernier survient MÊME pour un port fraîchement choisi par
 * pickFreeHostPort quand il tombe dans une plage réservée par l'hôte, ex. la plage dynamique
 * Hyper-V exclue via `netsh int ipv4 show excludedportrange`, invisible depuis Docker/dockerode).
 * Retourne `null` si le message ne ressemble pas RÉELLEMENT à un échec de liaison de port — jamais
 * une extraction hasardeuse qui déclencherait une nouvelle tentative hors-sujet.
 */
function extractUnavailablePort(message: string): number | null {
  if (!/port|bind|allocat/i.test(message)) return null;
  const match = /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)\b/.exec(message);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Redéploiement d'un dépôt déjà déployé en compose (voir TopologyNodeDetailPanel.tsx#
 * handleRedeployFromGithub, qui rappelle simplement POST .../deploy avec les mêmes paramètres) :
 * arrête D'ABORD le projet compose précédent de CE MÊME dépôt (down --remove-orphans) plutôt que
 * de laisser d'anciens conteneurs s'accumuler à chaque redéploiement — contrairement au flux
 * Dockerfile-seul (un nouveau conteneur par déploiement, comportement historique inchangé), un
 * "service" compose façon Railway est censé être remplacé par son redéploiement, pas dupliqué.
 * Best-effort : un échec de cet arrêt (projet déjà arrêté manuellement, hôte injoignable...) ne
 * doit jamais empêcher le NOUVEAU déploiement de démarrer, seulement être loggé honnêtement.
 */
async function tearDownPreviousCompose(
  deploymentId: string,
  owner: string,
  repo: string,
  currentDeploymentId: string,
  targetEnvironmentId: string | undefined,
): Promise<void> {
  const all = await listDeployments();
  const previous = all.find(
    (d) => d.owner === owner && d.repo === repo && d.kind === "docker-compose" && d.status === "success" && d.id !== currentDeploymentId && d.composeProjectName,
  );
  if (!previous?.composeProjectName) return;

  await appendDeploymentLog(
    deploymentId,
    `Déploiement compose précédent détecté pour ${owner}/${repo} (projet "${previous.composeProjectName}") — arrêt avant le nouveau déploiement.\n` +
      `$ docker compose -p ${previous.composeProjectName} down --remove-orphans\n`,
  );
  const { env, cleanup } = await resolveComposeCliEnv(targetEnvironmentId);
  try {
    await runComposeCommand(deploymentId, os.tmpdir(), ["compose", "-p", previous.composeProjectName, "down", "--remove-orphans"], env);
    await appendDeploymentLog(deploymentId, `Ancien projet compose "${previous.composeProjectName}" arrêté.\n`);
  } catch (err) {
    await appendDeploymentLog(
      deploymentId,
      `Avertissement : impossible d'arrêter proprement l'ancien projet compose "${previous.composeProjectName}" (${err instanceof Error ? err.message : String(err)}) — poursuite du nouveau déploiement quand même.\n`,
    );
  } finally {
    await cleanup();
  }

  // La route reverse-proxy de l'ANCIEN déploiement (même sous-domaine probable pour un
  // redéploiement, voir TopologyNodeDetailPanel.tsx#handleRedeployFromGithub) doit être libérée
  // AVANT le nouveau déploiement : sans ça, createSubdomainRouteForDeployment échouerait plus loin
  // avec SubdomainConflictError ("A route for ... already exists") dès que le nouveau déploiement
  // tenterait de router le MÊME sous-domaine — constaté en conditions réelles le 14/08/2026 lors de
  // la vérification de cette mission (redéploiement docker/awesome-compose gitea-postgres). Le
  // conteneur ciblé par cette route n'existe de toute façon plus (down ci-dessus) : la route ne
  // servirait plus à rien même en cas d'échec du nouveau déploiement. Best-effort, jamais bloquant.
  if (previous.reverseProxyRouteId) {
    try {
      await deleteRoute(previous.reverseProxyRouteId);
      await appendDeploymentLog(deploymentId, `Ancienne route reverse-proxy (déploiement précédent) supprimée.\n\n`);
    } catch (err) {
      await appendDeploymentLog(
        deploymentId,
        `Avertissement : impossible de supprimer l'ancienne route reverse-proxy (${err instanceof Error ? err.message : String(err)}) — le nouveau déploiement échouera à recréer la route si le sous-domaine est identique.\n\n`,
      );
    }
  } else {
    await appendDeploymentLog(deploymentId, "\n");
  }
}

async function deployViaDockerCompose(
  deploymentId: string,
  composeDir: string,
  composeFileName: string,
  owner: string,
  repo: string,
  targetEnvironmentId: string | undefined,
  subdomain: string | undefined,
  serviceForSubdomain: string | undefined,
  /** Port hôte précis demandé par service (voir DeployPortRequirement#overridable) — {} = aucune
   * surcharge, comportement historique inchangé (remap automatique uniquement sur conflit réel). */
  portOverrides: Record<string, number> = {},
): Promise<void> {
  const docker = await getClient(targetEnvironmentId);
  // Nom de projet isolé dérivé de l'id de déploiement — même esprit que sanitizeDockerName déjà
  // utilisé pour le nom de conteneur du flux Dockerfile-seul : ne collisionne jamais avec un autre
  // déploiement compose (un autre repo, ou un redéploiement concurrent) sur ce même hôte Docker.
  const projectName = sanitizeDockerName(`quai-gh-${owner}-${repo}-${deploymentId.slice(0, 8)}`);

  await tearDownPreviousCompose(deploymentId, owner, repo, deploymentId, targetEnvironmentId);

  const rawYaml = await fs.readFile(path.join(composeDir, composeFileName), "utf-8");
  const doc = (yaml.load(rawYaml) as ComposeDoc | undefined) ?? {};

  if (Object.keys(portOverrides).length > 0) {
    applyComposeHostPortOverrides(doc, portOverrides);
    await appendDeploymentLog(
      deploymentId,
      `Port(s) hôte demandé(s) explicitement : ${Object.entries(portOverrides)
        .map(([service, port]) => `${service} -> ${port}`)
        .join(", ")}.\n`,
    );
  }

  const used = await usedHostPorts(docker);
  let remaps = rewriteComposePortsForConflicts(doc, used);
  for (const remap of remaps) {
    await appendDeploymentLog(
      deploymentId,
      `Conflit de port détecté : le port hôte ${remap.oldHostPort} (service "${remap.service}") est déjà utilisé par un autre conteneur de cet hôte Docker — remplacé automatiquement par ${remap.newHostPort}.\n`,
    );
  }

  // Jusqu'à 3 tentatives : au-delà d'un conflit avec un AUTRE conteneur Docker (déjà corrigé
  // ci-dessus), un port fraîchement choisi par pickFreeHostPort peut malgré tout être refusé par
  // l'hôte lui-même (plage réservée par le système, ex. la plage dynamique Hyper-V exclue sur
  // Docker Desktop/Windows — invisible depuis Docker, constaté en conditions réelles le
  // 14/08/2026 lors de la vérification de cette mission) : `docker compose up` échoue alors avec
  // un message Docker RÉEL explicite ("ports are not available"/"already allocated"). Plutôt que
  // de remonter cet échec brut, le port fautif est extrait (extractUnavailablePort) et un nouveau
  // port est choisi pour lui avant de réessayer — jamais plus de MAX_UP_ATTEMPTS essais.
  const MAX_UP_ATTEMPTS = 3;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_UP_ATTEMPTS; attempt++) {
    const effectiveFileName = remaps.length > 0 ? "docker-compose.quai-effective.yml" : composeFileName;
    if (remaps.length > 0) {
      // Écrit DANS composeDir (jamais un autre dossier) : les chemins `build: .`/`build: ./sous-dossier`
      // du fichier d'origine restent relatifs à ce même dossier, donc valides tels quels.
      await fs.writeFile(path.join(composeDir, effectiveFileName), yaml.dump(doc), "utf-8");
    }

    const args = ["compose", "-f", effectiveFileName, "-p", projectName, "up", "-d", "--build"];
    await appendDeploymentLog(deploymentId, `$ docker ${args.join(" ")}\n`);
    const { env: cliEnv, cleanup: cliCleanup } = await resolveComposeCliEnv(targetEnvironmentId);
    try {
      await withTimeout(runComposeCommand(deploymentId, composeDir, args, cliEnv), config.github.buildTimeoutMs, "docker compose up");
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const badPort = attempt < MAX_UP_ATTEMPTS ? extractUnavailablePort(lastError.message) : null;
      if (badPort === null) break; // pas un échec de port reconnu, ou dernière tentative : abandon
      used.add(badPort);
      const retryRemaps = rewriteComposePortsForConflicts(doc, used);
      if (retryRemaps.length === 0) break; // le port fautif ne correspond à aucun mapping fixe qu'on contrôle : abandon
      for (const remap of retryRemaps) {
        await appendDeploymentLog(
          deploymentId,
          `Port hôte ${remap.oldHostPort} refusé par l'hôte Docker (service "${remap.service}") — nouvel essai (${attempt + 1}/${MAX_UP_ATTEMPTS}) avec le port ${remap.newHostPort}.\n`,
        );
      }
      remaps = [...remaps, ...retryRemaps];
    } finally {
      await cliCleanup();
    }
  }
  if (lastError) {
    // Un `up --build` qui échoue en cours de route peut malgré tout avoir DÉJÀ créé/démarré
    // certains services (constaté en conditions réelles le 14/08/2026 : un service "db" démarré
    // avec succès pendant qu'un autre échouait à publier son port) — sans ce nettoyage, ces
    // conteneurs orphelins restent indéfiniment sur l'hôte, invisibles de tout historique QUAI
    // (le déploiement est marqué "failed", jamais "success", donc jamais repris par
    // tearDownPreviousCompose). Best-effort, jamais bloquant : l'erreur d'origine reste celle
    // remontée à l'utilisateur dans tous les cas.
    const { env: cleanupEnv, cleanup: cleanupEnvCleanup } = await resolveComposeCliEnv(targetEnvironmentId);
    try {
      await appendDeploymentLog(deploymentId, `\n$ docker compose -p ${projectName} down --remove-orphans (nettoyage après échec)\n`);
      await runComposeCommand(deploymentId, composeDir, ["compose", "-p", projectName, "down", "--remove-orphans"], cleanupEnv);
    } catch {
      // Si même ce nettoyage échoue, l'erreur d'origine (lastError, plus pertinente) est
      // remontée quand même ci-dessous — un opérateur peut toujours nettoyer manuellement
      // via `docker compose -p <projet> down`, dont le nom exact est journalisé ci-dessus.
    } finally {
      await cleanupEnvCleanup();
    }
    throw lastError;
  }
  await appendDeploymentLog(deploymentId, `Déploiement compose terminé (projet "${projectName}").\n`);

  // Conteneurs RÉELLEMENT créés par ce `up` — retrouvés via le label standard que docker-compose
  // pose lui-même sur chaque conteneur qu'il crée, jamais une liste déduite du seul YAML (qui peut
  // différer du résultat réel en cas d'échec partiel d'un service).
  const composeContainers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.project=${projectName}`] }),
  });
  const composeServiceContainerNames = composeContainers.map(
    (c) => c.Labels?.["com.docker.compose.service"] ?? c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
  );
  await appendDeploymentLog(deploymentId, `Conteneurs créés : ${composeServiceContainerNames.join(", ") || "aucun"}\n`);

  await updateDeploymentRecord(deploymentId, {
    kind: "docker-compose",
    composeProjectName: projectName,
    composeServices: composeServiceContainerNames,
  });

  if (!subdomain) return;

  // Règle de routage (voir mission "Sous-domaine / reverse-proxy") : un service explicitement
  // choisi (`serviceForSubdomain`, voir GitHubDeployPage.tsx) est toujours prioritaire ; sinon,
  // s'il n'y a qu'UN SEUL service qui expose un port -> sélection automatique (aucune saisie à
  // l'aveugle nécessaire) ; s'il y en a PLUSIEURS sans choix explicite -> jamais deviner, route non
  // créée avec un message actionnable (même honnêteté que le cas "aucun port EXPOSE" du flux
  // Dockerfile-seul).
  const withPorts = composeContainers.filter((c) => (c.Ports ?? []).some((p) => typeof p.PrivatePort === "number"));
  let chosen: (typeof composeContainers)[number] | undefined;

  if (serviceForSubdomain) {
    chosen = composeContainers.find((c) => c.Labels?.["com.docker.compose.service"] === serviceForSubdomain);
    if (!chosen) {
      await appendDeploymentLog(
        deploymentId,
        `Service "${serviceForSubdomain}" demandé pour le sous-domaine "${subdomain}" mais introuvable parmi les conteneurs créés (${composeServiceContainerNames.join(", ")}) — route reverse-proxy NON créée.\n`,
      );
    } else if (!(chosen.Ports ?? []).some((p) => typeof p.PrivatePort === "number")) {
      await appendDeploymentLog(
        deploymentId,
        `Service "${serviceForSubdomain}" ne déclare aucun port — route reverse-proxy NON créée pour "${subdomain}".\n`,
      );
      chosen = undefined;
    }
  } else if (withPorts.length === 1) {
    chosen = withPorts[0];
  } else if (withPorts.length === 0) {
    await appendDeploymentLog(deploymentId, `Sous-domaine "${subdomain}" demandé mais aucun service ne déclare de port exposé — route reverse-proxy NON créée.\n`);
  } else {
    const candidateNames = withPorts.map((c) => c.Labels?.["com.docker.compose.service"] ?? c.Id.slice(0, 12));
    await appendDeploymentLog(
      deploymentId,
      `Sous-domaine "${subdomain}" demandé mais ${withPorts.length} services exposent un port (${candidateNames.join(", ")}) — précisez lequel via "Service à exposer" dans la configuration ; route reverse-proxy NON créée.\n`,
    );
  }

  if (chosen) {
    const targetPort = chosen.Ports!.find((p) => typeof p.PrivatePort === "number")!.PrivatePort;
    const label = chosen.Labels?.["com.docker.compose.service"] ?? chosen.Names?.[0]?.replace(/^\//, "") ?? chosen.Id.slice(0, 12);
    await updateDeploymentRecord(deploymentId, { containerId: chosen.Id, containerName: label });
    // replaceExisting=true : voir le commentaire équivalent dans deployViaDockerBuild — un
    // redéploiement compose du même sous-domaine doit reprendre la route existante plutôt que
    // d'échouer sur SubdomainConflictError (l'ancien conteneur ciblé par cette route a de toute
    // façon déjà été arrêté par tearDownPreviousCompose au tout début de cette fonction).
    await createSubdomainRouteForDeployment(deploymentId, subdomain, chosen.Id, label, targetPort, true);
  }
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

export type ResolveEnvConfigResult =
  | { ok: true; buildArgs: Record<string, string> }
  | { ok: false; missingKeys: string[] };

/**
 * Analyse le VRAI clone local (`targetDir`) juste avant `docker build`/`docker compose up` — voir
 * la section "Détection et résolution des variables d'environnement manquantes" plus haut dans ce
 * fichier pour la logique partagée (buildEnvRequirements). Si des clés requises restent sans
 * valeur : n'invoque NI `docker build` NI `docker compose`, retourne `{ok: false}` (le déploiement
 * s'arrête à l'étape "configuration requise", status "needs-config", voir runDeployment). Sinon,
 * écrit RÉELLEMENT le(s) fichier(s) `.env` nécessaires (jamais vide, jamais une valeur inventée) et
 * retourne les ARG Dockerfile résolus (pour `docker build --build-arg`, voir deployViaDockerBuild).
 */
async function resolveAndWriteEnvConfig(
  deploymentId: string,
  owner: string,
  repo: string,
  targetDir: string,
  detection: EntriesSummary,
): Promise<ResolveEnvConfigResult> {
  const filePath = (name: string) => path.join(targetDir, name);

  const composeRaw = detection.hasCompose
    ? await fs.readFile(filePath(detection.composeFileName!), "utf-8").catch(() => undefined)
    : undefined;
  const composeDoc = composeRaw ? ((yaml.load(composeRaw) as ComposeDoc | undefined) ?? undefined) : undefined;
  const dockerfileContent = detection.hasDockerfile ? await fs.readFile(filePath("Dockerfile"), "utf-8").catch(() => undefined) : undefined;

  let envExampleDefaults = new Map<string, string | undefined>();
  for (const name of ENV_EXAMPLE_FILE_NAMES) {
    const content = await fs.readFile(filePath(name), "utf-8").catch(() => undefined);
    if (content !== undefined) {
      envExampleDefaults = parseEnvExampleDefaults(content);
      break;
    }
  }

  const storedValues = await getStoredEnvValues(owner, repo);
  const envFileExists = async (relativePath: string): Promise<boolean> =>
    fs
      .access(filePath(relativePath))
      .then(() => true)
      .catch(() => false);

  const { envVars } = await buildEnvRequirements({
    ...(composeDoc ? { composeDoc } : {}),
    ...(dockerfileContent ? { dockerfileContent } : {}),
    envExampleDefaults,
    resolvedValues: storedValues,
    envFileExists,
  });

  // Auto-provisioning DB (preuve dans CE MÊME compose, voir isDbCredentialProvisionable) + seeder
  // de compte admin par défaut (voir adminSeedSuggestion) — réduisent RÉELLEMENT ce qui bloque le
  // déploiement, jamais un cas spécifique à un dépôt précis (voir applyAutoResolutions).
  const missingRequiredKeys = applyAutoResolutions(envVars, composeDoc, repo);

  // Génère RÉELLEMENT, une seule fois, le mot de passe des clés auto-provisionnées encore sans
  // valeur stockée — un redéploiement ultérieur retrouve `storedValues[key]` déjà rempli et ne
  // régénère JAMAIS (le service base de données déjà créé, dont le volume persiste les données,
  // refuserait un nouveau mot de passe à chaque redéploiement). Persisté immédiatement (secret
  // scopé à ce dépôt) pour que le prochain déploiement retrouve la MÊME valeur.
  const newlyProvisioned: Record<string, string> = {};
  for (const v of envVars) {
    if (v.autoResolution !== "db-provisioned" || storedValues[v.key] !== undefined) continue;
    newlyProvisioned[v.key] = generateStrongSecret();
  }
  if (Object.keys(newlyProvisioned).length > 0) {
    await saveGithubEnvValues(owner, repo, newlyProvisioned);
    Object.assign(storedValues, newlyProvisioned);
    await appendDeploymentLog(
      deploymentId,
      `${Object.keys(newlyProvisioned).length} mot(s) de passe de base de données généré(s) automatiquement (référence directe prouvée dans ce même docker-compose.yml : ${Object.keys(newlyProvisioned).join(", ")}) — stocké(s) de manière chiffrée, jamais journalisé(s) en clair, réutilisé(s) automatiquement à chaque redéploiement suivant.\n`,
    );
  }

  if (missingRequiredKeys.length > 0) {
    await appendDeploymentLog(
      deploymentId,
      `Configuration requise avant de déployer : ${missingRequiredKeys.length} variable(s) d'environnement manquante(s) — ${missingRequiredKeys.join(", ")}.\n` +
        `Aucun "docker build"/"docker compose" n'a été lancé. Renseignez ces valeurs (formulaire de configuration de ce dépôt) puis relancez ce déploiement — elles seront alors réutilisées automatiquement.\n`,
    );
    return { ok: false, missingKeys: missingRequiredKeys };
  }

  // Valeur finale par clé : secret déjà stocké prioritaire, sinon défaut légitime du .env.example.
  const resolvedAll: Record<string, string> = {};
  for (const v of envVars) {
    const value = storedValues[v.key] ?? envExampleDefaults.get(v.key);
    if (value !== undefined) resolvedAll[v.key] = value;
  }

  if (Object.keys(resolvedAll).length > 0) {
    // Écrit un VRAI fichier .env à la racine du contexte : docker compose le charge automatiquement
    // pour l'interpolation ${VAR} ET pour tout service qui s'appuie sur le shell/.env hôte, sans
    // qu'un `env_file:` explicite le référence forcément — jamais un fichier vide ni une valeur
    // inventée (voir resolvedAll ci-dessus, uniquement secret stocké ou défaut .env.example légitime).
    const envFileContent = Object.entries(resolvedAll)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    await fs.writeFile(path.join(targetDir, ".env"), envFileContent, { encoding: "utf-8", mode: 0o600 });
    let writtenFiles = 1;
    if (composeDoc?.services) {
      for (const service of Object.values(composeDoc.services)) {
        for (const envFilePath of composeEnvFilePaths(service)) {
          if (envFilePath === ".env") continue; // déjà écrit ci-dessus
          if (await envFileExists(envFilePath)) continue; // déjà présent dans le dépôt, jamais écrasé
          const target = filePath(envFilePath);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, envFileContent, { encoding: "utf-8", mode: 0o600 });
          writtenFiles += 1;
        }
      }
    }
    await appendDeploymentLog(
      deploymentId,
      `Fichier(s) d'environnement générés à partir de la configuration résolue (${Object.keys(resolvedAll).length} clé(s), ${writtenFiles} fichier(s)) — valeurs stockées chiffrées, jamais journalisées en clair.\n`,
    );
  }

  const buildArgs: Record<string, string> = {};
  for (const v of envVars) {
    if (v.source === "dockerfile_arg" && resolvedAll[v.key] !== undefined) buildArgs[v.key] = resolvedAll[v.key]!;
  }

  return { ok: true, buildArgs };
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
  configPath: string,
  serviceForSubdomain: string | undefined,
  composePortOverrides: Record<string, number> = {},
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

    // "Vérité terrain" : détection sur le VRAI clone (jamais réutilisé la détection GitHub API,
    // qui n'est qu'un aperçu — voir en-tête de fichier), à l'emplacement choisi par l'utilisateur
    // (configPath = GithubRepoDetection#detectedPath, "" pour la racine).
    const targetDir = configPath ? path.join(cloneDir, configPath) : cloneDir;
    const detection = await detectLocalEntriesAt(cloneDir, configPath);
    await appendDeploymentLog(
      deploymentId,
      `Détection (${configPath ? `sous-dossier "${configPath}"` : "racine du clone"}) : Dockerfile=${detection.hasDockerfile} ` +
        `compose=${detection.hasCompose} terraform=${detection.terraformFiles.length > 0} ` +
        `(${detection.terraformFiles.join(", ") || "aucun"}) ansible=${detection.hasAnsible}\n\n`,
    );

    // Priorité (voir chooseDeploymentEngine) : docker-compose > Dockerfile isolé > Terraform >
    // Ansible > rien. Un docker-compose.yml référence le plus souvent CE MÊME Dockerfile
    // (`build: .`) tout en décrivant en plus la topologie complète voulue par le mainteneur
    // (services dépendants, volumes, réseau, variables d'env) — sur-ensemble strict d'un
    // déploiement Dockerfile seul, jamais l'inverse (voir GithubDeploymentKind pour le détail).
    const engine = chooseDeploymentEngine(detection);

    // AVANT tout `docker build`/`docker compose up` (voir mission "fichier .env manquant") :
    // détecte/résout les variables d'environnement requises. Un échec ici arrête le déploiement à
    // une étape claire "configuration requise" (status "needs-config"), jamais un échec docker brut.
    if (engine === "compose" || engine === "dockerfile") {
      const envResolution = await resolveAndWriteEnvConfig(deploymentId, owner, repo, targetDir, detection);
      if (!envResolution.ok) {
        await updateDeploymentRecord(deploymentId, {
          status: "needs-config",
          finishedAt: new Date().toISOString(),
          missingConfigKeys: envResolution.missingKeys,
        });
        return;
      }
      switch (engine) {
        case "compose":
          await deployViaDockerCompose(
            deploymentId,
            targetDir,
            detection.composeFileName!,
            owner,
            repo,
            targetEnvironmentId,
            subdomain,
            serviceForSubdomain,
            composePortOverrides,
          );
          break;
        case "dockerfile":
          await deployViaDockerBuild(deploymentId, targetDir, owner, repo, targetEnvironmentId, subdomain, port, envResolution.buildArgs);
          break;
      }
      await updateDeploymentRecord(deploymentId, { status: "success", finishedAt: new Date().toISOString() });
      return;
    }

    switch (engine) {
      case "terraform":
        await deployViaIacWorkspace(deploymentId, targetDir, owner, repo, detection.terraformFiles, startedBy);
        break;
      case "ansible":
        await deployViaAnsibleWorkspace(deploymentId, targetDir, owner, repo, detection.ansiblePlaybook!, startedBy);
        break;
      case "none":
        throw new Error(
          `Aucun Dockerfile, docker-compose, fichier Terraform ni playbook Ansible détecté ${configPath ? `dans "${configPath}"` : "à la racine du dépôt"} — rien à déployer automatiquement.`,
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
  /** Sous-domaine reverse-proxy à router vers le conteneur déployé (kind "docker-build-run"/"docker-compose") — voir deployViaDockerBuild/deployViaDockerCompose. */
  subdomain?: string;
  /** Port interne du conteneur pour la route reverse-proxy (kind "docker-build-run" uniquement) — remplace la détection EXPOSE automatique si fourni. */
  port?: number;
  /** Sous-dossier du dépôt à utiliser pour la détection ET le déploiement (voir
   * GithubRepoDetection#detectedPath) — "" ou absent = racine (comportement historique inchangé).
   * DOIT avoir été validé par l'appelant (voir isSafeRelativeConfigPath, routes/github.ts). */
  configPath?: string;
  /** kind "docker-compose" avec plusieurs services exposant un port : lequel router vers
   * `subdomain` — voir deployViaDockerCompose. Ignoré pour les autres kinds. */
  serviceForSubdomain?: string;
  /** Déclenchement webhook : métadonnées de commit déjà connues (payload `push`), pour éviter un
   * appel GitHub supplémentaire — sinon récupérées ici via l'API (déclenchement manuel). */
  commit?: GithubDeploymentCommit;
  /** kind "docker-compose" uniquement : port hôte précis demandé par service (voir
   * DeployPortRequirement#overridable) — remplace le remap automatique pour CE service, voir
   * applyComposeHostPortOverrides. Absent/{} = comportement historique inchangé. */
  composePortOverrides?: Record<string, number>;
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
  const configPath = input.configPath ?? "";

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
    ...(configPath ? { configPath } : {}),
  });

  void runDeployment(
    id,
    input.owner,
    input.repo,
    resolvedRef,
    input.targetEnvironmentId,
    token,
    input.startedBy,
    input.subdomain,
    input.port,
    configPath,
    input.serviceForSubdomain,
    input.composePortOverrides ?? {},
  );

  return deployment;
}

export { listDeployments };

export async function getDeploymentDetail(id: string): Promise<GithubDeploymentDetail | null> {
  const deployment = await getDeployment(id);
  if (!deployment) return null;
  const log = await readDeploymentLog(id);
  return { ...deployment, log };
}
