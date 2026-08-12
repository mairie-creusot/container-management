/**
 * Moteur GitOps.
 *
 * Le dépôt Git (cloné/pull via simple-git si GITOPS_REPO_URL est fourni, sinon lu
 * directement depuis GITOPS_REPO_PATH) est la seule source de vérité pour l'état désiré.
 * La dérive (désiré vs réel) est calculée en déléguant à @quai/wasm-core#diffManifests,
 * conformément à l'interface figée dans ARCHITECTURE.md.
 *
 * @quai/wasm-core est développé en parallèle (crate Rust + wasm-pack) par un autre agent.
 * Tant qu'il n'est pas buildable, l'import dynamique ci-dessous échoue proprement et un
 * diff JS de repli (LCS ligne à ligne) est utilisé à la place, avec la même interface
 * (DiffResult). Dès que le package est buildé, il est utilisé automatiquement — aucun
 * changement de code n'est nécessaire ici.
 *
 * IMPORTANT — la reconstruction de l'état "réel" (actualManifest) à partir du cluster est
 * un best-effort simplifié pour ce premier lot : elle tente de faire correspondre le nom
 * de la ressource désirée à un conteneur/pod en cours d'exécution (via docker.ts /
 * kubernetes.ts) pour en extraire l'image réellement déployée. Si aucune correspondance
 * n'est trouvée, l'état réel est supposé identique à l'état désiré (pas de dérive détectée)
 * plutôt que de fabriquer une donnée arbitraire.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import simpleGit, { CheckRepoActions, type SimpleGit } from "simple-git";
import { config } from "../config.js";
import { withTimeout } from "../utils/async.js";
import { demoStore } from "./demoData.js";
import { getDockerContainers } from "./docker.js";
import { getKubernetesContainers } from "./kubernetes.js";
import type { ContainerRef, DiffLine, DiffResult, GitCommit, GitOpsFile } from "../types.js";

type DiffManifestsFn = (desiredYaml: string, actualYaml: string) => DiffResult;

let diffManifestsFn: DiffManifestsFn | null = null;

/** LCS ligne à ligne — repli utilisé tant que @quai/wasm-core n'est pas buildable. */
function fallbackDiffManifests(desiredYaml: string, actualYaml: string): DiffResult {
  const oldLines = actualYaml.split("\n");
  const newLines = desiredYaml.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let hasDrift = false;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "remove", text: oldLines[i]! });
      hasDrift = true;
      i++;
    } else {
      lines.push({ kind: "add", text: newLines[j]! });
      hasDrift = true;
      j++;
    }
  }
  while (i < m) {
    lines.push({ kind: "remove", text: oldLines[i]! });
    hasDrift = true;
    i++;
  }
  while (j < n) {
    lines.push({ kind: "add", text: newLines[j]! });
    hasDrift = true;
    j++;
  }

  return { lines, hasDrift };
}

async function loadDiffManifests(): Promise<DiffManifestsFn> {
  if (diffManifestsFn) return diffManifestsFn;
  try {
    const mod = await import("@quai/wasm-core");
    diffManifestsFn = mod.diffManifests;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gitops] @quai/wasm-core is not available yet (${err instanceof Error ? err.message : String(err)}), using the JS fallback diff`,
    );
    diffManifestsFn = fallbackDiffManifests;
  }
  return diffManifestsFn;
}

function repoAbsolutePath(): string {
  return path.resolve(config.gitops.repoPath);
}

/**
 * URL du remote SANS jamais y interpoler le jeton (voir prepareGitAskPass ci-dessous et finding
 * E4, docs/reports/security-audit-2026-08-12.md) — seul le nom d'utilisateur y figure quand un
 * jeton est configuré, pour que `git` sache qu'une authentification est nécessaire (il
 * n'invoquera alors GIT_ASKPASS que pour le mot de passe, jamais pour redemander un nom
 * d'utilisateur déjà connu).
 */
function remoteUrlForGit(): string | undefined {
  const { repoUrl, gitUsername, gitToken } = config.gitops;
  if (!repoUrl) return undefined;
  if (!gitToken || !repoUrl.startsWith("https://")) return repoUrl;
  const withoutProtocol = repoUrl.slice("https://".length);
  const user = gitUsername ? encodeURIComponent(gitUsername) : "oauth2";
  return `https://${user}@${withoutProtocol}`;
}

/**
 * Prépare un `GIT_ASKPASS` TEMPORAIRE portant le jeton — jamais interpolé dans l'URL du remote
 * (qui finirait en argument de ligne de commande du process `git` réellement exécuté, visible
 * via `ps aux`/`/proc/<pid>/cmdline` par tout utilisateur/processus disposant de ces droits
 * d'observation locale sur l'hôte/le conteneur API — voir finding E4,
 * docs/reports/security-audit-2026-08-12.md, et services/github.ts#prepareGitAskPass, le même
 * mécanisme appliqué à l'autre intégration Git du projet). Le jeton ne transite QUE par une
 * variable d'environnement du sous-processus `git` (GIT_QUAI_TOKEN, jamais journalisée) : le
 * script d'aide se contente de la relayer sur stdout quand `git` la lui demande, jamais écrite
 * dans le script lui-même ni conservée au-delà de l'opération Git en cours (dossier temporaire
 * supprimé dans le `finally` de l'appelant).
 */
async function prepareGitAskPass(token: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quai-gitops-askpass-"));
  const scriptPath = path.join(dir, "askpass.sh");
  await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '%s' "$GIT_QUAI_TOKEN"\n`, { encoding: "utf-8", mode: 0o700 });
  return {
    env: { ...process.env, GIT_ASKPASS: scriptPath, GIT_TERMINAL_PROMPT: "0", GIT_QUAI_TOKEN: token },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Convertit une image "name:tag" en nom de service docker-compose valide (alphanumérique,
 * tirets/underscores) — ex: "ghcr.io/mairie/api:1.0" -> "ghcr-io-mairie-api".
 */
function serviceNameFromContainerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

/**
 * Amorce un dépôt Git local vide (aucun GITOPS_REPO_URL configuré, dossier vide) : `git init`
 * + un premier manifeste "dev-local/containers.yaml" au format docker-compose, capturant les
 * conteneurs RÉELLEMENT en cours d'exécution sur l'hôte au moment de l'amorçage — pas des
 * exemples inventés. Sans ça, GITOPS_REPO_PATH reste indéfiniment un dossier vide non-Git et
 * l'app retombe sur le jeu de démonstration pour toujours (voir ARCHITECTURE.md).
 *
 * Le fichier généré devient l'état "désiré" de référence : à partir de maintenant, toute
 * dérive détectée reflète un vrai écart entre ce commit et l'état réel du cluster (ex: une
 * image mise à jour via la page Images sans que ce fichier n'ait été committé derrière).
 */
async function bootstrapLocalRepo(repoPath: string): Promise<SimpleGit | null> {
  try {
    const containers = await getAllRunningContainers();
    const dockerContainers = containers.filter((c) => c.environment === "Dev local" || c.environment === "Prod");

    const manifestDir = path.join(repoPath, "dev-local");
    await fs.mkdir(manifestDir, { recursive: true });

    const services: Record<string, { image: string; container_name: string }> = {};
    for (const c of dockerContainers) {
      services[serviceNameFromContainerName(c.name)] = { image: c.image, container_name: c.name };
    }
    const manifestYaml = yaml.dump({ services });
    await fs.writeFile(path.join(manifestDir, "containers.yaml"), manifestYaml, "utf-8");
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "# Dépôt GitOps QUAI\n\n" +
        "Dépôt initialisé automatiquement à partir de l'état réel de l'hôte Docker au premier " +
        "accès à la page GitOps (aucun GITOPS_REPO_URL n'était configuré). Un fichier YAML par " +
        "dossier d'environnement (ex: dev-local/, prod/) — modifiez-les et committez pour faire " +
        "évoluer l'état désiré ; toute différence avec l'état réellement déployé apparaît comme " +
        "une dérive sur la page GitOps.\n",
      "utf-8",
    );

    const git = simpleGit(repoPath);
    await git.init();
    await git.addConfig("user.name", "QUAI").addConfig("user.email", "quai@lecreusot.priv");
    await git.add(["README.md", "dev-local/containers.yaml"]);
    await git.commit(
      dockerContainers.length > 0
        ? `Amorçage GitOps : capture de l'état réel (${dockerContainers.length} conteneur(s))`
        : "Amorçage GitOps : dépôt initialisé (aucun conteneur en cours d'exécution)",
    );
    return git;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gitops] failed to bootstrap local repository: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Prépare le dépôt local (clone/pull si GITOPS_REPO_URL est configuré, sinon utilise tel
 * quel GITOPS_REPO_PATH — amorcé automatiquement s'il est vide, voir bootstrapLocalRepo).
 * Retourne `null` si aucun dépôt Git exploitable n'est disponible (les appelants retombent
 * alors sur les données de démonstration).
 *
 * Opérations réseau (clone/fetch/pull) bornées par `config.gitops.requestTimeoutMs` — `git`
 * n'a aucun timeout par défaut, un dépôt distant qui ne répond jamais (pare-feu qui droppe les
 * paquets, proxy muet) bloquerait sinon indéfiniment (voir finding É4,
 * docs/reports/optimization-audit-2026-08-12.md ; même correctif déjà appliqué à
 * services/github.ts#runDeployment pour son propre clone).
 */
async function doEnsureRepoReady(): Promise<SimpleGit | null> {
  const repoPath = repoAbsolutePath();

  try {
    await fs.mkdir(repoPath, { recursive: true });
  } catch {
    return null;
  }

  const git = simpleGit(repoPath);
  // IS_REPO_ROOT (pas le défaut IS_REPO) : le défaut répond "vrai" dès que repoPath est une
  // simple sous-arborescence d'UN dépôt Git quelconque (ex: data/gitops à l'intérieur du
  // dépôt du projet lui-même) — pas ce qu'on veut savoir ici, qui est "repoPath a-t-il son
  // propre .git ?". Avec le défaut, ce check répondait toujours "oui" en dev, empêchant tout
  // clone/amorçage de se déclencher : readManifestsFromDisk ne trouvait ensuite jamais aucun
  // fichier dans le dossier réellement vide, d'où un repli permanent sur les données de démo.
  const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT).catch(() => false);
  const remoteUrl = remoteUrlForGit();

  if (remoteUrl) {
    // Préparé une seule fois pour les deux branches ci-dessous (clone OU fetch+checkout+pull),
    // nettoyé dans tous les cas via `finally` — voir prepareGitAskPass (finding E4).
    const { gitToken } = config.gitops;
    const askPass = gitToken ? await prepareGitAskPass(gitToken) : null;
    try {
      if (!isRepo) {
        const entries = await fs.readdir(repoPath);
        if (entries.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[gitops] GITOPS_REPO_PATH (${repoPath}) is not empty and not a git repo, skipping clone`);
          return null;
        }
        const cloner = askPass ? simpleGit().env(askPass.env) : simpleGit();
        await withTimeout(
          cloner.clone(remoteUrl, repoPath, ["--branch", config.gitops.branch, "--single-branch"]),
          config.gitops.requestTimeoutMs,
          "gitops git clone",
        );
        return simpleGit(repoPath);
      }
      const authenticatedGit = askPass ? git.env(askPass.env) : git;
      await withTimeout(
        authenticatedGit.fetch("origin", config.gitops.branch),
        config.gitops.requestTimeoutMs,
        "gitops git fetch",
      );
      await authenticatedGit.checkout(config.gitops.branch).catch(() => undefined);
      await withTimeout(
        authenticatedGit.pull("origin", config.gitops.branch),
        config.gitops.requestTimeoutMs,
        "gitops git pull",
      );
      return git;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gitops] failed to sync remote repository (${err instanceof Error ? err.message : String(err)})`);
      return isRepo ? git : null;
    } finally {
      await askPass?.cleanup();
    }
  }

  if (isRepo) return git;

  const entries = await fs.readdir(repoPath).catch(() => []);
  if (entries.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[gitops] GITOPS_REPO_PATH (${repoPath}) is not empty and not a git repo, skipping bootstrap`);
    return null;
  }
  return bootstrapLocalRepo(repoPath);
}

/** Appel en cours de doEnsureRepoReady(), partagé par tout appelant concurrent — voir ensureRepoReady(). */
let inFlightEnsureRepoReady: Promise<SimpleGit | null> | null = null;

/**
 * Garde ANTI-CHEVAUCHEMENT : listGitOpsFiles() (donc ensureRepoReady) est appelée à la fois par
 * le réconciliateur GitOps en tâche de fond (gitopsReconciler.ts, cycle 90s) ET par toute requête
 * HTTP utilisateur sur /api/gitops/* qui atterrit au même moment — sans garde, un `git fetch`/
 * `pull` un peu lent (réseau capricieux) laisserait un second appel concurrent relancer un
 * DEUXIÈME process `git` sur le même dépôt local pendant que le premier tourne encore : écritures
 * concurrentes sur l'index/les refs Git, "lost update" potentiel (voir finding M7,
 * docs/reports/optimization-audit-2026-08-12.md — le réconciliateur GitOps est explicitement visé
 * par ce finding, ici traité au niveau de la fonction qui fait RÉELLEMENT l'I/O réseau plutôt que
 * dans le `setInterval` de gitopsReconciler.ts, pour protéger aussi les appels concurrents
 * déclenchés par l'UI, pas seulement les cycles du scheduler entre eux). Un appel concurrent
 * REJOINT l'opération déjà en cours (jamais démarré une deuxième fois, jamais un "skip" silencieux
 * qui renverrait `null` à tort) plutôt que d'être ignoré.
 */
async function ensureRepoReady(): Promise<SimpleGit | null> {
  if (inFlightEnsureRepoReady) return inFlightEnsureRepoReady;
  inFlightEnsureRepoReady = doEnsureRepoReady().finally(() => {
    inFlightEnsureRepoReady = null;
  });
  return inFlightEnsureRepoReady;
}

interface DiskManifest {
  relativePath: string;
  content: string;
}

async function readManifestsFromDisk(repoPath: string): Promise<DiskManifest[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(repoPath, { recursive: true })) as string[];
  } catch {
    return [];
  }

  const manifests: DiskManifest[] = [];
  for (const entry of entries) {
    const normalized = entry.split(path.sep).join("/");
    if (normalized.startsWith(".git/") || normalized === ".git") continue;
    if (!/\.(ya?ml)$/i.test(normalized)) continue;

    const absolute = path.join(repoPath, entry);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(absolute, "utf-8");
      manifests.push({ relativePath: normalized, content });
    } catch {
      // fichier illisible entre-temps (race avec un pull) : ignoré
    }
  }
  return manifests;
}

interface ParsedManifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: { spec?: { containers?: Array<{ image?: string }> } };
    containers?: Array<{ image?: string }>;
  };
  services?: Record<string, { image?: string }>; // docker-compose
}

/**
 * Best-effort : tente de reconstruire le manifeste "réel" en remplaçant l'image du
 * manifeste désiré par celle réellement déployée (trouvée par correspondance de nom parmi
 * les conteneurs Docker/Kubernetes en cours). Repli sur le manifeste désiré tel quel
 * (aucune dérive) si aucune correspondance fiable n'est trouvée.
 */
function reconstructActualManifest(desiredYaml: string, runningContainers: ContainerRef[]): string {
  let parsed: ParsedManifest;
  try {
    parsed = yaml.load(desiredYaml) as ParsedManifest;
  } catch {
    return desiredYaml;
  }
  if (!parsed || typeof parsed !== "object") return desiredYaml;

  const resourceName = parsed.metadata?.name;
  const desiredContainers =
    parsed.spec?.template?.spec?.containers ?? parsed.spec?.containers ?? undefined;

  if (resourceName && desiredContainers && desiredContainers.length > 0) {
    const match = runningContainers.find((c) => c.name.includes(resourceName) || c.name.startsWith(resourceName));
    if (match) {
      const patched = structuredClone(parsed);
      const containers = patched.spec?.template?.spec?.containers ?? patched.spec?.containers;
      if (containers && containers[0]) {
        containers[0].image = match.image;
        return yaml.dump(patched);
      }
    }
  }

  if (parsed.services) {
    const serviceNames = Object.keys(parsed.services);
    const patched = structuredClone(parsed);
    let changed = false;
    for (const serviceName of serviceNames) {
      const match = runningContainers.find((c) => c.name.includes(serviceName));
      if (match && patched.services?.[serviceName]) {
        patched.services![serviceName]!.image = match.image;
        changed = true;
      }
    }
    if (changed) return yaml.dump(patched);
  }

  return desiredYaml;
}

async function getAllRunningContainers(): Promise<ContainerRef[]> {
  const [dockerContainers, kubeContainers] = await Promise.all([
    getDockerContainers().catch(() => []),
    getKubernetesContainers().catch(() => []),
  ]);
  return [...dockerContainers, ...kubeContainers];
}

/** Liste les fichiers GitOps (désiré + réel reconstruit + statut de dérive). */
export async function listGitOpsFiles(): Promise<GitOpsFile[]> {
  const repoPath = repoAbsolutePath();
  const git = await ensureRepoReady();
  const diskManifests = git ? await readManifestsFromDisk(repoPath) : [];

  if (diskManifests.length === 0) {
    return demoStore.gitopsFiles;
  }

  const diffManifests = await loadDiffManifests();
  const runningContainers = await getAllRunningContainers();

  return diskManifests.map((manifest): GitOpsFile => {
    const actualManifest = reconstructActualManifest(manifest.content, runningContainers);
    const { hasDrift } = diffManifests(manifest.content, actualManifest);
    return {
      path: manifest.relativePath,
      desiredManifest: manifest.content,
      actualManifest,
      drift: hasDrift,
    };
  });
}

export async function getGitOpsFileDiff(filePath: string): Promise<{ file: GitOpsFile; diff: DiffResult } | null> {
  const files = await listGitOpsFiles();
  const file = files.find((f) => f.path === filePath);
  if (!file) return null;
  const diffManifests = await loadDiffManifests();
  const diff = diffManifests(file.desiredManifest, file.actualManifest);
  return { file, diff };
}

export interface SyncResult {
  syncedAt: string;
  source: "git" | "demo";
  filesChecked: number;
  filesWithDrift: number;
}

/** Resynchronisation explicite : pull du dépôt distant (si configuré) puis recalcul de la dérive. */
export async function sync(): Promise<SyncResult> {
  const files = await listGitOpsFiles();
  return {
    syncedAt: new Date().toISOString(),
    source: files === demoStore.gitopsFiles ? "demo" : "git",
    filesChecked: files.length,
    filesWithDrift: files.filter((f) => f.drift).length,
  };
}

/** Historique Git du dossier GitOps, ou données de démonstration si pas de dépôt configuré. */
export async function getCommits(): Promise<GitCommit[]> {
  const git = await ensureRepoReady();
  if (!git) return demoStore.commits;

  try {
    const log = await git.log({ maxCount: 50 });
    if (log.all.length === 0) return demoStore.commits;
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      date: new Date(entry.date).toISOString(),
    }));
  } catch {
    return demoStore.commits;
  }
}
