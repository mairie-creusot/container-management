/**
 * MODULES INSTALLÉS — ceux qui n'ont pas été livrés avec l'image, posés dans un répertoire de
 * DONNÉES (PLUGINS_PATH, sinon `plugins/` à côté de CONFIG_PATH) : un module installé survit à une
 * reconstruction d'image, un module désinstallé disparaît réellement du disque.
 *
 * Disposition : `<racine>/<identifiant>/` = le paquet tel quel (quai-plugin.json, signature.json,
 * code), plus `.quai-install.json` — la trace d'installation, hors paquet donc hors signature.
 *
 * Les intégrations livrées avec QUAI passent par le MÊME chemin : elles sont empaquetées et signées
 * au build puis installées ici au premier démarrage (plugins/origin.ts). Rien ne les distingue à la
 * lecture, sinon la clé qui a signé leur paquet.
 *
 * Chaque passe du chargeur REVÉRIFIE la signature de chaque module présent : un fichier modifié sur
 * le disque après l'installation ne produit pas seulement un refus au prochain démarrage, il retire
 * le module du socle au cycle suivant (voir plugins/loader.ts). Aucune entrée n'est produite pour un
 * paquet refusé : le code d'un module non vérifié n'est jamais importable.
 */

import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { isBuiltinPluginId } from "./builtins.js";
import { loadCrls } from "./crl.js";
import type { PluginModuleEntry } from "./builtins.js";
import {
  CERTIFICATE_KEY_PREFIX,
  INSTALL_MARK_NAME,
  decodePackageEnvelope,
  isValidPluginId,
  readPackageFiles,
  verifyPluginPackage,
} from "./package.js";
import type { CertificateTrust, PackageFiles, VerifiedPluginPackage } from "./package.js";

/** Identifiants que le socle se réserve : ils servent de segment de route (/api/plugins/installed). */
const RESERVED_PLUGIN_IDS = new Set(["installed"]);

/** `import()` NATIF : un module installé vit sur le disque de DONNÉES, pas dans le graphe de
 * modules de l'application. Le commentaire `@vite-ignore` interdit à Vite/vitest d'analyser ce
 * chemin — sans lui, l'appel finit dans un contexte sans dynamic import et échoue avec
 * « A dynamic import callback was not specified » (constaté le 26/08/2026). */
async function nativeImport(specifier: string): Promise<unknown> {
  return await import(/* @vite-ignore */ specifier);
}

export interface InstalledPluginRecord {
  id: string;
  /** Renseignés UNIQUEMENT si la signature est vérifiée : rien d'un paquet refusé n'est présenté comme un fait. */
  name: string | null;
  version: string | null;
  trusted: boolean;
  keyId: string | null;
  /** Ce que les listes de révocation disent de ce certificat : "clear", "unknown" ou (jamais listé
   * ici, puisqu'il serait refusé) "revoked". `null` pour une signature par clé nue. */
  revocation: string | null;
  /** Motif quand la révocation n'a pas pu être établie — jamais masqué derrière un état vert. */
  revocationReason: string | null;
  /** QUI a signé, quand une AUTORITÉ le dit (nom usuel du certificat) — `null` pour une signature
   * par clé nue, qui ne porte aucune identité. */
  signer: string | null;
  /** Empreinte SHA-256 du certificat de signature : celle à poser dans PLUGIN_REVOKED_CERTS pour
   * retirer ce signataire sans reconstruire quoi que ce soit. */
  certificateFingerprint: string | null;
  /** Paquet d'ORIGINE de cette image : prouvé par la clé qui l'a signé, jamais par sa trace d'installation. */
  origin: boolean;
  installedAt: string | null;
  installedBy: string | null;
  /** Motif RÉEL du refus quand `trusted` est faux. */
  reason: string | null;
}

export interface InstalledCatalog {
  entries: PluginModuleEntry[];
  rejected: { id: string; reason: string }[];
}

export type InstallResult =
  | { ok: true; record: InstalledPluginRecord; replaced: boolean }
  | { ok: false; status: number; error: string };

export type UninstallResult = { ok: true } | { ok: false; status: number; error: string };

export function installedPluginsRoot(): string {
  const configured = config.plugins.installPath;
  if (configured !== undefined) return path.resolve(configured);
  // Même convention que services/auditLog.ts : les données vivent dans le dossier de CONFIG_PATH.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "plugins");
}

/** Répertoire des listes de révocation, dans les DONNÉES : elles sont rafraîchies en cours de vie du
 * serveur (services/crlRefresher.ts) et ne peuvent donc pas vivre dans l'image. */
export function crlDirectory(): string {
  const configured = config.plugins.crlPath;
  if (configured !== undefined) return path.resolve(configured);
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "crl");
}

/** Confiance apportée par une AUTORITÉ (AD CS interne), telle que la configuration la décrit. Les
 * listes de révocation sont lues sur le disque à ce moment-là — aucun appel réseau n'est fait. */
export function certificateTrust(): CertificateTrust {
  const policy = config.plugins.crlPolicy;
  const { crls } = loadCrls(policy === "off" ? undefined : crlDirectory());
  return {
    anchors: config.plugins.trustedCertificates,
    revoked: config.plugins.revokedCertificates,
    crls,
    crlPolicy: policy,
  };
}

/** Nom usuel d'une autorité configurée, pour l'afficher sans jamais sortir son certificat. */
function anchorLabels(): string[] {
  const labels: string[] = [];
  for (const material of config.plugins.trustedCertificates) {
    let subject: string;
    try {
      subject = new X509Certificate(material).subject;
    } catch {
      continue;
    }
    const cn = subject
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("CN="));
    labels.push(`${CERTIFICATE_KEY_PREFIX}${cn === undefined ? "autorité" : cn.slice(3).trim()}`);
  }
  return labels;
}

/** Identifiants de confiance configurés — jamais leur valeur. La clé d'ORIGINE en est exclue : sa
 * clé privée n'existe plus après le build, personne ne peut signer avec elle. Les autorités de
 * certification y figurent : elles habilitent des signataires que le serveur n'a pas à connaître. */
export function trustedKeyIds(): string[] {
  return [
    ...Object.keys(config.plugins.trustedKeys).filter((keyId) => keyId !== config.plugins.originKeyId),
    ...anchorLabels(),
  ].sort();
}

/** Le paquet a-t-il été signé par la clé d'origine de CETTE image ? */
export function isOriginKeyId(keyId: string): boolean {
  return config.plugins.originKeyId !== undefined && keyId === config.plugins.originKeyId;
}

export function isPluginInstallAvailable(): boolean {
  return trustedKeyIds().length > 0;
}

export interface InstallMark {
  installedAt: string | null;
  installedBy: string | null;
}

async function readInstallMark(dir: string): Promise<InstallMark> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, INSTALL_MARK_NAME), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { installedAt: null, installedBy: null };
    const record = parsed as Record<string, unknown>;
    return {
      installedAt: typeof record.installedAt === "string" ? record.installedAt : null,
      installedBy: typeof record.installedBy === "string" ? record.installedBy : null,
    };
  } catch {
    return { installedAt: null, installedBy: null };
  }
}

interface ScannedPackage {
  /** Nom du répertoire : la seule identité vérifiable avant la signature, et celle qu'on désinstalle. */
  id: string;
  dir: string;
  mark: InstallMark;
  verified: VerifiedPluginPackage | null;
  reason: string | null;
}

async function scanInstalled(): Promise<ScannedPackage[]> {
  const root = installedPluginsRoot();
  // Répertoire absent = aucun module installé, jamais une erreur.
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const scanned: ScannedPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const mark = await readInstallMark(dir);

    if (!isValidPluginId(entry.name)) {
      scanned.push({ id: entry.name, dir, mark, verified: null, reason: `"${entry.name}" n'est pas un identifiant de module valide.` });
      continue;
    }

    let files: PackageFiles;
    try {
      files = await readPackageFiles(dir, config.plugins.maxPackageBytes);
    } catch (err) {
      scanned.push({ id: entry.name, dir, mark, verified: null, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const verification = verifyPluginPackage(files, config.plugins.trustedKeys, certificateTrust());
    if (!verification.ok) {
      scanned.push({ id: entry.name, dir, mark, verified: null, reason: verification.reason });
      continue;
    }
    if (verification.verified.manifest.id !== entry.name) {
      scanned.push({
        id: entry.name,
        dir,
        mark,
        verified: null,
        reason: `Le répertoire "${entry.name}" contient un module signé sous l'identifiant "${verification.verified.manifest.id}".`,
      });
      continue;
    }
    scanned.push({ id: entry.name, dir, mark, verified: verification.verified, reason: null });
  }
  return scanned.sort((a, b) => a.id.localeCompare(b.id));
}

/** Ce que l'écran d'administration liste : état de confiance, version, provenance. */
export async function listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  return (await scanInstalled()).map((entry) => ({
    id: entry.id,
    name: entry.verified?.manifest.name ?? null,
    version: entry.verified?.manifest.version ?? null,
    trusted: entry.verified !== null,
    keyId: entry.verified?.keyId ?? null,
    signer: entry.verified?.signer ?? null,
    certificateFingerprint: entry.verified?.certificateFingerprint ?? null,
    revocation: entry.verified?.revocation?.state ?? null,
    revocationReason: entry.verified?.revocation?.state === "unknown" ? entry.verified.revocation.reason : null,
    origin: entry.verified !== null && isOriginKeyId(entry.verified.keyId),
    installedAt: entry.mark.installedAt,
    installedBy: entry.mark.installedBy,
    reason: entry.reason,
  }));
}

/**
 * Entrées de catalogue des modules installés — UNIQUEMENT ceux dont la signature est vérifiée. Le
 * `load()` d'une entrée n'existe que pour un paquet vérifié : il n'y a aucun chemin de code par
 * lequel un module refusé pourrait être importé.
 *
 * L'empreinte du paquet est passée en paramètre d'URL : un module réinstallé avec un contenu
 * différent est réellement rechargé, alors que le cache de modules de Node ne se vide jamais.
 */
export async function installedCatalog(): Promise<InstalledCatalog> {
  const entries: PluginModuleEntry[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const scanned of await scanInstalled()) {
    if (!scanned.verified) {
      rejected.push({ id: scanned.id, reason: scanned.reason ?? "paquet refusé" });
      continue;
    }
    const { manifest, digest } = scanned.verified;
    const href = pathToFileURL(path.join(scanned.dir, manifest.entry)).href;
    // Clé de cache = empreinte du contenu ET date d'installation : réinstaller le MÊME contenu doit
    // réellement recharger le code, or Node réutilise un module déjà importé sous la même URL.
    const cacheKey = `${digest}-${scanned.mark.installedAt ?? "0"}`;
    entries.push({
      id: manifest.id,
      exportName: manifest.exportName,
      origin: isOriginKeyId(scanned.verified.keyId),
      load: async () => await nativeImport(`${href}?quai=${encodeURIComponent(cacheKey)}`),
    });
  }
  return { entries, rejected };
}

/** Marqueur ESM à la RACINE du répertoire d'installation : un module vit hors du dépôt, où rien ne
 * dirait à Node que ses fichiers `.js` sont des modules. Hors de tout paquet, donc hors signature. */
async function ensureInstallRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{ "type": "module" }\n', { encoding: "utf-8", mode: 0o600 });
}

async function writePackageTo(dir: string, files: PackageFiles, mark: InstallMark): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of files) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
  await fs.writeFile(path.join(dir, INSTALL_MARK_NAME), `${JSON.stringify(mark, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Pose sur le disque un paquet DÉJÀ VÉRIFIÉ, de façon atomique (répertoire temporaire puis
 * renommage). Rend `true` si un module portait déjà cet identifiant. Lève en cas d'échec d'écriture
 * — l'appelant décide du message. C'est le SEUL chemin d'écriture d'un module installé, celui de la
 * route d'installation comme celui de l'amorçage des paquets d'origine (plugins/origin.ts).
 */
export async function writeInstalledPackage(id: string, files: PackageFiles, mark: InstallMark): Promise<boolean> {
  const root = installedPluginsRoot();
  const target = path.join(root, id);
  const replaced = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

  const staging = path.join(root, `.staging-${id}-${Date.now()}`);
  try {
    await ensureInstallRoot(root);
    await fs.rm(staging, { recursive: true, force: true });
    await writePackageTo(staging, files, mark);
    // rm PUIS rename : sur Windows, renommer par-dessus un répertoire existant échoue.
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return replaced;
}

/**
 * Installe un paquet — la vérification de signature a lieu AVANT toute écriture, et bien avant tout
 * import. Un identifiant déjà porté par un greffon livré est refusé : un module installé ne peut pas
 * usurper une intégration du socle.
 */
export async function installPluginPackage(body: unknown, installedBy: string): Promise<InstallResult> {
  if (!isPluginInstallAvailable()) {
    return {
      ok: false,
      status: 503,
      error:
        "Aucune confiance n'est configurée (PLUGIN_TRUSTED_KEYS pour une clé, PLUGIN_TRUSTED_CA pour une autorité) : l'installation de modules externes est indisponible sur ce serveur.",
    };
  }

  const envelope = decodePackageEnvelope(body, config.plugins.maxPackageBytes);
  if (!envelope.ok) return { ok: false, status: 400, error: envelope.reason };

  const verification = verifyPluginPackage(envelope.files, config.plugins.trustedKeys, certificateTrust());
  if (!verification.ok) return { ok: false, status: 400, error: verification.reason };

  const { manifest, keyId, signer, certificateFingerprint, revocation } = verification.verified;
  if (isBuiltinPluginId(manifest.id)) {
    return {
      ok: false,
      status: 409,
      error: `L'identifiant "${manifest.id}" est celui d'un greffon livré avec QUAI : un module installé ne peut pas le remplacer.`,
    };
  }
  if (RESERVED_PLUGIN_IDS.has(manifest.id)) {
    return { ok: false, status: 409, error: `L'identifiant "${manifest.id}" est réservé par le socle : choisissez-en un autre.` };
  }

  const mark: InstallMark = { installedAt: new Date().toISOString(), installedBy };
  let replaced: boolean;
  try {
    replaced = await writeInstalledPackage(manifest.id, envelope.files, mark);
  } catch (err) {
    return { ok: false, status: 500, error: `Écriture du module impossible : ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    ok: true,
    replaced,
    record: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      trusted: true,
      keyId,
      signer: signer ?? null,
      certificateFingerprint: certificateFingerprint ?? null,
      revocation: revocation?.state ?? null,
      revocationReason: revocation?.state === "unknown" ? revocation.reason : null,
      origin: isOriginKeyId(keyId),
      installedAt: mark.installedAt,
      installedBy: mark.installedBy,
      reason: null,
    },
  };
}

/** Retire RÉELLEMENT le module du disque. L'identifiant est validé avant de servir de chemin. */
export async function uninstallPlugin(id: string): Promise<UninstallResult> {
  if (!isValidPluginId(id)) return { ok: false, status: 400, error: `Identifiant de module invalide : ${JSON.stringify(id)}.` };

  const target = path.join(installedPluginsRoot(), id);
  const exists = await fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!exists) return { ok: false, status: 404, error: `Aucun module installé sous l'identifiant "${id}".` };

  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, status: 500, error: `Suppression impossible : ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}
