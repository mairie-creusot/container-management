/**
 * MODULES D'ORIGINE — les intégrations livrées avec QUAI, traitées exactement comme des modules
 * externes : empaquetées et signées pendant la construction de l'image (scripts/build-origin-plugins.mjs),
 * posées en lecture seule dans l'image, installées au premier démarrage dans le volume de données,
 * puis désactivables et désinstallables comme n'importe quel autre module.
 *
 * Confiance : la paire de clés est générée POUR CE BUILD, la clé privée n'est jamais écrite et
 * disparaît avec le processus de build ; seule la clé publique part dans l'image (config.plugins.originKeyId).
 * Un paquet d'origine est donc vérifié comme tous les autres, et personne ne peut en fabriquer un
 * que cette image accepterait.
 *
 * Un retrait VOLONTAIRE est mémorisé dans le volume de données (`.quai-origin.json`, à la racine du
 * répertoire d'installation) : l'amorçage ne réinstalle jamais un module que l'admin a désinstallé.
 * `restoreOriginPlugin()` est la porte de retour — le paquet, lui, reste dans l'image.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { certificateTrust, installedPluginsRoot, isOriginKeyId, writeInstalledPackage } from "./installed.js";
import type { InstalledPluginRecord } from "./installed.js";
import { isValidPluginId, readPackageFiles, verifyPluginPackage } from "./package.js";
import type { PackageFiles, VerifiedPluginPackage } from "./package.js";

/** Mémoire des retraits volontaires — hors de tout paquet, donc hors signature, et dans les DONNÉES. */
export const ORIGIN_STATE_NAME = ".quai-origin.json";

export interface OriginRefusal {
  id: string;
  reason: string;
}

interface OriginPackage {
  id: string;
  verified: VerifiedPluginPackage;
  files: PackageFiles;
}

interface OriginImage {
  /** L'image livre-t-elle des paquets d'origine ? Vrai dès qu'un répertoire candidat existe, même si
   * son paquet est refusé — sinon un paquet abîmé ferait ressusciter le catalogue interne, et avec
   * lui une intégration que l'admin avait désinstallée. */
  shipped: boolean;
  packages: OriginPackage[];
  rejected: OriginRefusal[];
}

export interface OriginModuleRecord {
  id: string;
  name: string;
  version: string;
  installed: boolean;
  /** Retiré VOLONTAIREMENT : ni réamorcé au démarrage, ni perdu — restaurable depuis l'image. */
  removed: boolean;
  removedAt: string | null;
  removedBy: string | null;
}

export interface OriginBootstrapOutcome {
  installed: string[];
  /** Déjà installés à l'identique : rien n'a été réécrit. */
  kept: string[];
  /** Désinstallés volontairement : délibérément PAS réinstallés. */
  removed: string[];
  failed: OriginRefusal[];
}

export type OriginRestoreResult =
  | { ok: true; record: InstalledPluginRecord }
  | { ok: false; status: number; error: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function originRoot(): string | undefined {
  const configured = config.plugins.originPath;
  return configured === undefined ? undefined : path.resolve(configured);
}

/** Lecture RÉELLE des paquets d'origine de l'image, signature comprise. Ne lève jamais. */
async function readOriginImage(): Promise<OriginImage> {
  const root = originRoot();
  if (root === undefined) return { shipped: false, packages: [], rejected: [] };

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return { shipped: false, packages: [], rejected: [] };

  const packages: OriginPackage[] = [];
  const rejected: OriginRefusal[] = [];
  let shipped = false;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    shipped = true;

    if (!isValidPluginId(entry.name)) {
      rejected.push({ id: entry.name, reason: `"${entry.name}" n'est pas un identifiant de module valide.` });
      continue;
    }

    let files: PackageFiles;
    try {
      files = await readPackageFiles(path.join(root, entry.name), config.plugins.maxPackageBytes);
    } catch (err) {
      rejected.push({ id: entry.name, reason: messageOf(err) });
      continue;
    }

    const verification = verifyPluginPackage(files, config.plugins.trustedKeys, certificateTrust());
    if (!verification.ok) {
      rejected.push({ id: entry.name, reason: verification.reason });
      continue;
    }
    // Signé, mais par QUI ? Un paquet posé dans ce répertoire et signé par une clé d'admin ne devient
    // pas pour autant une intégration de QUAI : seule la clé d'origine de CETTE image le rend.
    if (!isOriginKeyId(verification.verified.keyId)) {
      rejected.push({
        id: entry.name,
        reason: `Le paquet "${entry.name}" n'est pas signé par la clé d'origine de cette image : il n'est pas livré avec QUAI.`,
      });
      continue;
    }
    if (verification.verified.manifest.id !== entry.name) {
      rejected.push({
        id: entry.name,
        reason: `Le répertoire "${entry.name}" contient un paquet signé sous l'identifiant "${verification.verified.manifest.id}".`,
      });
      continue;
    }
    packages.push({ id: entry.name, verified: verification.verified, files });
  }

  // Ordre stable : `readdir` ne garantit rien, et l'ordre d'amorçage se retrouve dans les journaux.
  return {
    shipped,
    packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    rejected: rejected.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Le contenu de l'image ne change pas en cours d'exécution : lu une fois, gardé. */
let imageCache: Promise<OriginImage> | undefined;

function loadOriginImage(): Promise<OriginImage> {
  imageCache ??= readOriginImage();
  return imageCache;
}

/** Cette image livre-t-elle ses intégrations sous forme de paquets ? Faux hors image : le socle
 * retombe alors sur son catalogue interne (plugins/builtins.ts). */
export async function hasOriginPackages(): Promise<boolean> {
  return (await loadOriginImage()).shipped;
}

export async function isOriginPluginId(id: string): Promise<boolean> {
  return (await loadOriginImage()).packages.some((entry) => entry.id === id);
}

interface OriginRemoval {
  at: string | null;
  by: string | null;
}

interface OriginState {
  removed: Record<string, OriginRemoval>;
}

function originStatePath(): string {
  return path.join(installedPluginsRoot(), ORIGIN_STATE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOriginState(): Promise<OriginState> {
  const empty: OriginState = { removed: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(originStatePath(), "utf-8"));
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !isRecord(parsed.removed)) return empty;

  const removed: Record<string, OriginRemoval> = {};
  for (const [id, value] of Object.entries(parsed.removed)) {
    if (!isValidPluginId(id)) continue;
    const entry = isRecord(value) ? value : {};
    removed[id] = {
      at: typeof entry.at === "string" ? entry.at : null,
      by: typeof entry.by === "string" ? entry.by : null,
    };
  }
  return { removed };
}

async function writeOriginState(state: OriginState): Promise<void> {
  const target = originStatePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Mémorise qu'un module d'ORIGINE vient d'être désinstallé volontairement : sans cette trace,
 * l'amorçage du démarrage suivant le réinstallerait et annulerait la décision de l'admin. Sans effet
 * — et sans fichier écrit — pour un module qui n'est pas d'origine.
 */
export async function rememberOriginRemoval(id: string, by: string): Promise<boolean> {
  if (!(await isOriginPluginId(id))) return false;
  const state = await readOriginState();
  state.removed[id] = { at: new Date().toISOString(), by };
  await writeOriginState(state);
  return true;
}

async function forgetOriginRemoval(id: string): Promise<void> {
  const state = await readOriginState();
  if (state.removed[id] === undefined) return;
  const removed: Record<string, OriginRemoval> = {};
  for (const [key, value] of Object.entries(state.removed)) {
    if (key !== id) removed[key] = value;
  }
  await writeOriginState({ removed });
}

/**
 * Le module d'origine posé dans le volume de données est-il EXACTEMENT celui de l'image ? Faux si
 * absent, si sa signature ne se vérifie plus (fichier modifié sur le disque), ou si l'image en
 * apporte une autre version — chacun de ces cas doit être réparé par une réinstallation.
 */
async function isInstallCurrent(entry: OriginPackage): Promise<boolean> {
  const dir = path.join(installedPluginsRoot(), entry.id);
  let files: PackageFiles;
  try {
    files = await readPackageFiles(dir, config.plugins.maxPackageBytes);
  } catch {
    return false;
  }
  const verification = verifyPluginPackage(files, config.plugins.trustedKeys, certificateTrust());
  return verification.ok && verification.verified.digest === entry.verified.digest;
}

/**
 * AMORÇAGE : chaque paquet d'origine absent du répertoire d'installation y est posé, actif par
 * défaut (l'activation est implicite tant qu'aucune mise en pause explicite n'est enregistrée, voir
 * plugins/activation.ts). Un module retiré volontairement n'est jamais réamorcé ; un module déjà
 * installé à l'identique n'est pas réécrit. Ne lève jamais.
 */
export async function bootstrapOriginPlugins(installedBy?: string): Promise<OriginBootstrapOutcome> {
  const outcome: OriginBootstrapOutcome = { installed: [], kept: [], removed: [], failed: [] };
  const image = await loadOriginImage();
  outcome.failed.push(...image.rejected);
  for (const refusal of image.rejected) {
    console.warn(`[greffons] paquet d'origine "${refusal.id}" inexploitable : ${refusal.reason}`);
  }
  if (image.packages.length === 0) return outcome;

  const state = await readOriginState();
  for (const entry of image.packages) {
    if (state.removed[entry.id] !== undefined) {
      outcome.removed.push(entry.id);
      continue;
    }
    if (await isInstallCurrent(entry)) {
      outcome.kept.push(entry.id);
      continue;
    }
    try {
      await writeInstalledPackage(entry.id, entry.files, { installedAt: new Date().toISOString(), installedBy: installedBy ?? null });
      outcome.installed.push(entry.id);
      console.warn(`[greffons] module d'origine "${entry.id}" installé depuis l'image`);
    } catch (err) {
      const reason = messageOf(err);
      outcome.failed.push({ id: entry.id, reason });
      console.warn(`[greffons] module d'origine "${entry.id}" non installé : ${reason}`);
    }
  }
  return outcome;
}

/** Une seule passe d'amorçage par exécution : « au PREMIER démarrage », pas à chaque lecture du catalogue. */
let bootstrap: Promise<OriginBootstrapOutcome> | undefined;

export async function ensureOriginBootstrapped(): Promise<OriginBootstrapOutcome> {
  bootstrap ??= bootstrapOriginPlugins().catch((err: unknown) => {
    console.warn(`[greffons] amorçage des modules d'origine impossible : ${messageOf(err)}`);
    return { installed: [], kept: [], removed: [], failed: [] };
  });
  return await bootstrap;
}

/**
 * RÉINSTALLE un module d'origine désinstallé : le paquet n'a jamais quitté l'image, il est vérifié
 * puis reposé dans le volume de données, et la mémoire du retrait est effacée. Sa configuration,
 * elle, avait été retirée à la désinstallation : elle est à ressaisir.
 */
export async function restoreOriginPlugin(id: string, by: string): Promise<OriginRestoreResult> {
  if (!isValidPluginId(id)) return { ok: false, status: 400, error: `Identifiant de module invalide : ${JSON.stringify(id)}.` };

  const image = await loadOriginImage();
  const entry = image.packages.find((candidate) => candidate.id === id);
  if (!entry) {
    const refusal = image.rejected.find((candidate) => candidate.id === id);
    if (refusal) {
      return { ok: false, status: 500, error: `Le paquet d'origine "${id}" présent dans l'image est inexploitable : ${refusal.reason}` };
    }
    return { ok: false, status: 404, error: `Aucun module d'origine "${id}" n'est livré avec cette image.` };
  }

  const mark = { installedAt: new Date().toISOString(), installedBy: by };
  try {
    await writeInstalledPackage(id, entry.files, mark);
  } catch (err) {
    return { ok: false, status: 500, error: `Écriture du module impossible : ${messageOf(err)}` };
  }
  await forgetOriginRemoval(id);

  return {
    ok: true,
    record: {
      id,
      name: entry.verified.manifest.name,
      version: entry.verified.manifest.version,
      trusted: true,
      keyId: entry.verified.keyId,
      // Un paquet d'origine est signé par la clé de l'image, pas par un certificat : aucun signataire.
      signer: null,
      certificateFingerprint: null,
      origin: true,
      installedAt: mark.installedAt,
      installedBy: mark.installedBy,
      reason: null,
    },
  };
}

/** Ce que l'écran d'administration affiche des modules d'origine : présents dans l'image, installés
 * ou retirés volontairement — un module retiré reste listé, sinon il serait introuvable. */
export async function listOriginModules(): Promise<OriginModuleRecord[]> {
  const image = await loadOriginImage();
  if (image.packages.length === 0) return [];
  const state = await readOriginState();

  const records: OriginModuleRecord[] = [];
  for (const entry of image.packages) {
    const removal = state.removed[entry.id];
    const installed = await fs
      .stat(path.join(installedPluginsRoot(), entry.id))
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    records.push({
      id: entry.id,
      name: entry.verified.manifest.name,
      version: entry.verified.manifest.version,
      installed,
      removed: removal !== undefined,
      removedAt: removal?.at ?? null,
      removedBy: removal?.by ?? null,
    });
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export function resetOriginStateForTests(): void {
  imageCache = undefined;
  bootstrap = undefined;
}
