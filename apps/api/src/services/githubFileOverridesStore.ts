/**
 * Surcharge du CONTENU de fichiers détectés (Dockerfile, docker-compose.yml, *.tf, playbook
 * Ansible) au moment du build/déploiement — retour utilisateur réel (14/08/2026) : "fait en sorte
 * qu'ont puisse overide le dockerfile et les autre fichier de conf au moment du build" (corriger un
 * problème ponctuel, ex: un Dockerfile réellement buggé sur formulaire_hotline, SANS avoir besoin
 * de forker le dépôt ni d'y faire un vrai commit).
 *
 * Décision de stockage documentée (mission : "à toi de trancher") : contrairement au jeton GitHub
 * (githubStore.ts) ou aux variables d'environnement résolues (github.ts#saveGithubEnvValues), le
 * contenu d'un Dockerfile/docker-compose/Terraform/Ansible n'a PAS vocation à être un secret — ces
 * fichiers sont normalement committés en clair dans le dépôt d'origine, et l'utilisateur doit
 * pouvoir les CONSULTER en clair depuis QUAI (voir mission "le fichier brut original doit être
 * visible/comparable") : chiffrer ce contenu au repos (AES-256-GCM comme secretsStore.ts)
 * n'apporterait donc aucune protection réelle tout en compliquant inutilement la lecture. Stocké
 * en JSON simple sur disque (GITHUB_FILE_OVERRIDES_PATH), permissions restreintes 0600 (même
 * hygiène que tout autre store de ce projet), cache mémoire process invalidé à chaque écriture —
 * même pattern général que githubDeployments.ts/githubStore.ts, sans le chiffrement.
 *
 * Scope : PAR DÉPÔT ET PAR CHEMIN de fichier exact (voir StoredFileOverride#path, toujours validé
 * via isSafeRelativeConfigPath par l'appelant — routes/github.ts — avant d'atteindre ce module :
 * jamais un chemin arbitraire hors du dépôt cloné). Le fichier réellement utilisé pour build/
 * déployer est TOUJOURS le fichier original du clone SAUF si une surcharge existe pour CE chemin
 * exact pour CE dépôt, auquel cas elle remplace ENTIÈREMENT le fichier (jamais un patch/diff
 * partiel — plus simple et plus prévisible, voir services/github.ts#applyStoredFileOverrides).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { writeFileRestricted } from "../utils/secureFile.js";

export interface StoredFileOverride {
  path: string; // chemin relatif au dépôt (incluant le sous-dossier detectedPath éventuel), ex: "docker/Dockerfile"
  content: string; // contenu INTÉGRAL de remplacement
  updatedAt: string; // ISO 8601
  updatedBy: string; // username
}

// Clé de premier niveau : "owner/repo" (minuscules) -> { chemin de fichier -> surcharge }.
type StoredFileOverridesData = Record<string, Record<string, StoredFileOverride>>;

let cache: StoredFileOverridesData | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.github.fileOverridesPath);
}

function repoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

async function readFromDisk(): Promise<StoredFileOverridesData> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredFileOverridesData) : {};
  } catch {
    return {};
  }
}

async function writeToDisk(next: StoredFileOverridesData): Promise<void> {
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
}

async function getAll(): Promise<StoredFileOverridesData> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET .../file-overrides — toutes les surcharges actives pour ce dépôt (contenu INCLUS, ce store
 * n'est jamais write-only contrairement à secretsStore.ts — voir en-tête de fichier). */
export async function listFileOverrides(owner: string, repo: string): Promise<StoredFileOverride[]> {
  const all = await getAll();
  const forRepo = all[repoKey(owner, repo)] ?? {};
  return Object.values(forRepo);
}

export async function getFileOverride(owner: string, repo: string, filePath: string): Promise<StoredFileOverride | undefined> {
  const all = await getAll();
  return all[repoKey(owner, repo)]?.[filePath];
}

/** PUT .../file-overrides — crée ou remplace ENTIÈREMENT la surcharge pour ce chemin exact. */
export async function saveFileOverride(
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  updatedBy: string,
): Promise<StoredFileOverride> {
  const all = await getAll();
  const key = repoKey(owner, repo);
  const entry: StoredFileOverride = { path: filePath, content, updatedAt: new Date().toISOString(), updatedBy };
  const next: StoredFileOverridesData = { ...all, [key]: { ...(all[key] ?? {}), [filePath]: entry } };
  await writeToDisk(next);
  cache = next;
  return entry;
}

/** DELETE .../file-overrides — supprime la surcharge (retour au fichier original du dépôt).
 * `true` si une surcharge existait réellement et a été supprimée. */
export async function deleteFileOverride(owner: string, repo: string, filePath: string): Promise<boolean> {
  const all = await getAll();
  const key = repoKey(owner, repo);
  const forRepo = all[key];
  if (!forRepo || !(filePath in forRepo)) return false;
  const { [filePath]: _removed, ...rest } = forRepo;
  const next: StoredFileOverridesData = { ...all, [key]: rest };
  await writeToDisk(next);
  cache = next;
  return true;
}
