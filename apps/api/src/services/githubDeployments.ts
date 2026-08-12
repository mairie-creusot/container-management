/**
 * Historique des déploiements GitHub (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") —
 * même pattern de persistance que services/iac/runner.ts : un index.json (métadonnées de tous
 * les déploiements) + un fichier de log par déploiement, écrit en direct pendant que le clone/
 * build/run tourne en arrière-plan, lu en polling par le frontend (voir routes/github.ts).
 *
 * Répertoire : data/github-deployments/ (même racine que config.json/iac/, voir
 * iacRootPath() dans services/iac/workspaces.ts pour le même principe).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { GithubDeployment } from "../types.js";

function rootPath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "github-deployments");
}

function indexPath(): string {
  return path.join(rootPath(), "index.json");
}

function logPath(id: string): string {
  return path.join(rootPath(), `${id}.log`);
}

async function readIndex(): Promise<GithubDeployment[]> {
  try {
    return JSON.parse(await fs.readFile(indexPath(), "utf-8")) as GithubDeployment[];
  } catch {
    return [];
  }
}

async function writeIndex(deployments: GithubDeployment[]): Promise<void> {
  await fs.mkdir(rootPath(), { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(deployments, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function upsert(deployment: GithubDeployment): Promise<void> {
  const all = await readIndex();
  const index = all.findIndex((d) => d.id === deployment.id);
  if (index >= 0) all[index] = deployment;
  else all.unshift(deployment);
  await writeIndex(all);
}

/** GET /api/github/deployments — les plus récents en premier. */
export async function listDeployments(): Promise<GithubDeployment[]> {
  return (await readIndex()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getDeployment(id: string): Promise<GithubDeployment | undefined> {
  return (await readIndex()).find((d) => d.id === id);
}

export async function readDeploymentLog(id: string): Promise<string> {
  try {
    return await fs.readFile(logPath(id), "utf-8");
  } catch {
    return "";
  }
}

export interface CreateDeploymentInput {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  targetEnvironmentId: string | null;
  startedBy: string;
}

/** Crée l'entrée d'historique à l'état "running" et initialise son fichier de log. */
export async function createDeploymentRecord(input: CreateDeploymentInput): Promise<GithubDeployment> {
  const deployment: GithubDeployment = {
    id: input.id,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    targetEnvironmentId: input.targetEnvironmentId,
    kind: null,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    startedBy: input.startedBy,
  };
  await fs.mkdir(rootPath(), { recursive: true });
  await fs.writeFile(
    logPath(deployment.id),
    `Déploiement ${input.owner}/${input.repo}@${input.ref} démarré par ${input.startedBy}\n\n`,
    "utf-8",
  );
  await upsert(deployment);
  return deployment;
}

/** Patch partiel appliqué à l'entrée existante (status/finishedAt/kind/champs spécifiques au type de déploiement). */
export async function updateDeploymentRecord(id: string, patch: Partial<GithubDeployment>): Promise<void> {
  const all = await readIndex();
  const index = all.findIndex((d) => d.id === id);
  if (index === -1) return; // ne devrait pas arriver (createDeploymentRecord toujours appelé avant)
  all[index] = { ...all[index]!, ...patch };
  await writeIndex(all);
}

/** Append au fichier de log — appelée à chaque étape (git clone, docker build, docker run…). */
export async function appendDeploymentLog(id: string, chunk: string): Promise<void> {
  try {
    await fs.appendFile(logPath(id), chunk, "utf-8");
  } catch {
    // fichier de log illisible/supprimé entre-temps : ne fait pas échouer le déploiement pour autant
  }
}
