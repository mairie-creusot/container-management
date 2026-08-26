/**
 * FORMAT DE PAQUET d'un module distribuable, et VÉRIFICATION DE SA SIGNATURE.
 *
 * Un paquet est un RÉPERTOIRE contenant :
 *   quai-plugin.json — manifeste de paquet : identifiant, version, point d'entrée, nom d'export, et
 *                      l'empreinte SHA-256 de CHAQUE fichier de code du paquet ;
 *   signature.json   — signature des OCTETS EXACTS de quai-plugin.json (aucune re-sérialisation,
 *                      donc aucune ambiguïté de canonicalisation), sous l'une des deux formes :
 *                        { algorithm: "ed25519", keyId, signature }
 *                          — clé nue, dont la publique est configurée sur le serveur
 *                            (PLUGIN_TRUSTED_KEYS). Simple, mais anonyme : la clé ne dit pas qui
 *                            signe, et la retirer suppose de savoir laquelle retirer.
 *                        { algorithm: "x509-sha256", signature, certificates: [...] }
 *                          — certificat de signature de code délivré par une AUTORITÉ configurée
 *                            (PLUGIN_TRUSTED_CA, l'AD CS de la collectivité). Le serveur n'a alors
 *                            aucune clé de signataire à connaître : il vérifie que le certificat
 *                            remonte à l'autorité, porte l'usage « signature de code » et n'a pas
 *                            expiré. En prime, le paquet dit QUI l'a signé.
 *   le code lui-même — JavaScript ESM autonome (aucun import autre que les modules `node:`).
 *
 * Chaîne de confiance : la signature couvre le manifeste, le manifeste couvre les empreintes des
 * fichiers. Changer un octet de code casse une empreinte ; changer une empreinte casse la signature.
 *
 * Ce module ne fait QUE lire et vérifier : il n'importe jamais de code. C'est la règle
 * non contournable — un paquet non signé, mal signé, signé par une clé inconnue ou modifié après
 * signature est refusé AVANT tout `import()`, jamais chargé « avec un avertissement ».
 *
 * Pour le transport HTTP, le même paquet voyage dans une enveloppe JSON `{ files: { "<chemin>":
 * "<base64>" } }` produite par l'outil de signature HORS LIGNE (scripts/sign-plugin.mjs) : c'est le
 * répertoire sérialisé, octet pour octet, signature comprise.
 */

import { X509Certificate, createHash, createPublicKey, verify as verifyEd25519, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSemver } from "@quai/plugin-contract";
import { checkRevocation } from "./crl.js";
import type { CrlPolicy, ParsedCrl, RevocationVerdict } from "./crl.js";

export const PACKAGE_FORMAT = "quai-plugin/1";
export const PACKAGE_MANIFEST_NAME = "quai-plugin.json";
export const PACKAGE_SIGNATURE_NAME = "signature.json";
/** Trace d'installation posée par le socle — hors paquet, donc hors périmètre de la signature. */
export const INSTALL_MARK_NAME = ".quai-install.json";

const RESERVED_NAMES = new Set([PACKAGE_SIGNATURE_NAME, INSTALL_MARK_NAME]);
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/\s]*={0,2}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_FILES = 64;
/** id-kp-codeSigning : l'usage qu'un certificat doit porter pour habiliter du code. */
const CODE_SIGNING_EKU = "1.3.6.1.5.5.7.3.3";
/** Une chaîne plus longue ne décrit plus une hiérarchie interne, elle décrit une boucle. */
const MAX_CHAIN_LENGTH = 8;
/** Préfixe des identifiants de confiance issus d'une autorité — jamais confondu avec une clé
 * configurée, et surtout jamais avec "quai-origin" (voir isOriginKeyId). */
export const CERTIFICATE_KEY_PREFIX = "x509:";

export type PackageFiles = ReadonlyMap<string, Buffer>;

export interface PluginPackageManifest {
  format: string;
  id: string;
  name: string;
  version: string;
  /** Fichier importé par le socle, relatif à la racine du paquet ("index.js"). */
  entry: string;
  /** Nom sous lequel ce fichier exporte le greffon. */
  exportName: string;
  /** Chemin relatif -> empreinte SHA-256 hexadécimale. */
  files: Record<string, string>;
}

export interface VerifiedPluginPackage {
  manifest: PluginPackageManifest;
  /** Clé de confiance qui a réellement signé — celle configurée, jamais celle annoncée. */
  keyId: string;
  /** SHA-256 des octets du manifeste signé : identifie le contenu exact du paquet. */
  digest: string;
  /** QUI a signé, quand une autorité le dit : nom usuel du certificat de signature. Absent pour une
   * signature par clé nue, qui ne porte aucune identité. */
  signer?: string;
  /** Empreinte SHA-256 du certificat de signature — celle à poser dans PLUGIN_REVOKED_CERTS pour
   * retirer ce signataire. */
  certificateFingerprint?: string;
  /** Ce que les listes de révocation disponibles disent de ce certificat. « unknown » est un état à
   * part entière : aucune liste ne le couvre, et ce n'est PAS « sain ». */
  revocation?: RevocationVerdict;
}

/**
 * Confiance apportée par une AUTORITÉ, à côté des clés publiques configurées une à une. Un module
 * signé par un certificat que cette autorité a émis, portant l'usage « signature de code », est
 * accepté sans que sa clé soit connue du serveur.
 */
export interface CertificateTrust {
  /** Certificats racines, en PEM, autorisés à habiliter un signataire de module. */
  anchors: readonly string[];
  /** Empreintes SHA-256 (hex minuscule, sans séparateur) de certificats retirés à la main. */
  revoked: readonly string[];
  /** Listes de révocation déjà lues sur le disque — jamais récupérées par le réseau ici. */
  crls?: readonly ParsedCrl[];
  /** Ce qu'on fait d'un certificat qu'aucune CRL ne couvre. Défaut : "soft". */
  crlPolicy?: CrlPolicy;
}

const NO_CERTIFICATE_TRUST: CertificateTrust = { anchors: [], revoked: [] };

export type PackageVerification = { ok: true; verified: VerifiedPluginPackage } | { ok: false; reason: string };

function refuse(reason: string): PackageVerification {
  return { ok: false, reason };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Chemin relatif sans échappatoire : ni absolu, ni `..`, ni antislash, ni segment vide. */
export function isSafePackagePath(name: string): boolean {
  if (name.length === 0 || name.length > 200 || !SAFE_PATH_PATTERN.test(name)) return false;
  return !name.split("/").some((segment) => segment === "." || segment === "..");
}

export function isValidPluginId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 2 && id.length <= 32 && PLUGIN_ID_PATTERN.test(id) && !id.includes("--");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clé publique Ed25519, en PEM, en DER SPKI base64, ou en 32 octets bruts base64. */
function trustedPublicKey(material: string): KeyObject | undefined {
  const trimmed = material.trim();
  try {
    const key = trimmed.startsWith("-----BEGIN")
      ? createPublicKey(trimmed)
      : (() => {
          const raw = Buffer.from(trimmed, "base64");
          const der = raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
          return createPublicKey({ key: der, format: "der", type: "spki" });
        })();
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Nom usuel d'un sujet X.509 ("CN=BANAS Yann") — le seul morceau lisible par un humain. */
function commonName(subject: string): string | undefined {
  for (const line of subject.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("CN=")) return trimmed.slice(3).trim();
  }
  return undefined;
}

/** Empreinte SHA-256 normalisée : minuscules, sans les deux-points de l'affichage Windows. */
function fingerprintOf(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, "").toLowerCase();
}

function parseCertificate(material: string | Buffer): X509Certificate | undefined {
  try {
    return new X509Certificate(material);
  } catch {
    return undefined;
  }
}

/** `validFrom`/`validTo` sont les seules formes présentes dans toutes les versions supportées de
 * Node : une date illisible rend le certificat invalide, jamais valide par défaut. */
function isCurrentlyValid(certificate: X509Certificate, now: Date): boolean {
  const from = new Date(certificate.validFrom).getTime();
  const to = new Date(certificate.validTo).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= now.getTime() && now.getTime() <= to;
}

interface CertificateVerdict {
  keyId: string;
  signer: string;
  fingerprint: string;
  revocation: RevocationVerdict;
}

/**
 * Signature par CERTIFICAT. Ce qui est exigé, dans cet ordre, et sans exception :
 *  - le certificat de signature n'est pas listé comme retiré, ni aucun de ses émetteurs ;
 *  - il est valide À CET INSTANT, comme tous les certificats de la chaîne ;
 *  - il porte explicitement l'usage « signature de code » — un certificat sans cet usage habilite
 *    tout, donc rien : il est refusé plutôt qu'interprété largement ;
 *  - il a réellement signé les octets du manifeste ;
 *  - il remonte, de proche en proche, à une autorité configurée sur CE serveur.
 *
 * L'identifiant de confiance rendu est dérivé de l'AUTORITÉ, jamais de ce que le paquet annonce :
 * sinon un signataire tiers pourrait se déclarer "quai-origin" et usurper une intégration livrée.
 */
function verifyCertificateSignature(
  manifestBytes: Buffer,
  rawCertificates: unknown,
  signature: Buffer,
  trust: CertificateTrust,
  now: Date,
): { ok: true; verdict: CertificateVerdict } | { ok: false; reason: string } {
  if (trust.anchors.length === 0) {
    return {
      ok: false,
      reason:
        "Ce paquet est signé par certificat, mais aucune autorité de signature n'est configurée sur ce serveur (PLUGIN_TRUSTED_CA) : rien ne permet d'en juger.",
    };
  }
  if (!Array.isArray(rawCertificates) || rawCertificates.length === 0) {
    return { ok: false, reason: `${PACKAGE_SIGNATURE_NAME} ne porte aucun certificat : une signature par certificat doit fournir sa chaîne.` };
  }
  if (rawCertificates.length > MAX_CHAIN_LENGTH) {
    return { ok: false, reason: `Chaîne de certificats trop longue (${rawCertificates.length}) : ${MAX_CHAIN_LENGTH} au maximum.` };
  }

  const chain: X509Certificate[] = [];
  for (const [index, entry] of (rawCertificates as unknown[]).entries()) {
    if (typeof entry !== "string" || !BASE64_PATTERN.test(entry.replace(/-----[A-Z ]+-----/g, ""))) {
      return { ok: false, reason: `Certificat n°${index + 1} illisible : du DER en base64 (ou du PEM) est attendu.` };
    }
    const certificate = parseCertificate(entry.includes("BEGIN CERTIFICATE") ? entry : Buffer.from(entry, "base64"));
    if (!certificate) return { ok: false, reason: `Certificat n°${index + 1} illisible : ce n'est pas un certificat X.509 exploitable.` };
    chain.push(certificate);
  }

  const anchors: X509Certificate[] = [];
  for (const material of trust.anchors) {
    const anchor = parseCertificate(material);
    if (anchor) anchors.push(anchor);
  }
  if (anchors.length === 0) {
    return { ok: false, reason: "Aucune autorité de signature exploitable n'est configurée : corrigez PLUGIN_TRUSTED_CA." };
  }

  const revoked = new Set(trust.revoked);
  for (const certificate of chain) {
    const fingerprint = fingerprintOf(certificate);
    if (revoked.has(fingerprint)) {
      return {
        ok: false,
        reason: `Le certificat « ${commonName(certificate.subject) ?? fingerprint} » a été retiré (PLUGIN_REVOKED_CERTS) : ce module n'est plus accepté.`,
      };
    }
  }

  const leaf = chain[0]!;
  const leafName = commonName(leaf.subject) ?? leaf.subject.split("\n")[0] ?? "certificat sans nom";
  for (const certificate of chain) {
    if (!isCurrentlyValid(certificate, now)) {
      return {
        ok: false,
        reason: `Le certificat « ${commonName(certificate.subject) ?? "sans nom"} » n'est pas valide aujourd'hui (${certificate.validFrom} → ${certificate.validTo}).`,
      };
    }
  }

  if (!leaf.keyUsage?.includes(CODE_SIGNING_EKU)) {
    return {
      ok: false,
      reason: `Le certificat « ${leafName} » ne porte pas l'usage « signature de code » : il ne peut pas habiliter un module.`,
    };
  }

  let signatureValid = false;
  try {
    signatureValid = verifySignature("sha256", manifestBytes, leaf.publicKey, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: `Signature invalide : le manifeste du paquet ne correspond pas à ce que « ${leafName} » a signé.` };
  }

  // Remontée de proche en proche : chaque certificat doit avoir été RÉELLEMENT émis par le suivant.
  // `issuers` garde qui a émis quoi : c'est ce que la révocation confrontera aux CRL disponibles.
  const issuers: X509Certificate[] = [];
  let current = leaf;
  for (const issuer of chain.slice(1)) {
    if (!issuer.ca) {
      return { ok: false, reason: `« ${commonName(issuer.subject) ?? "un certificat de la chaîne"} » n'est pas une autorité : il ne peut pas avoir émis un certificat.` };
    }
    if (!current.checkIssued(issuer) || !current.verify(issuer.publicKey)) {
      return { ok: false, reason: `Chaîne de certificats rompue : « ${commonName(current.subject) ?? "un certificat"} » n'a pas été émis par « ${commonName(issuer.subject) ?? "le certificat suivant"} ».` };
    }
    issuers.push(issuer);
    current = issuer;
  }

  const topFingerprint = fingerprintOf(current);
  for (const anchor of anchors) {
    // La racine peut être fournie dans la chaîne (elle est alors la même que l'ancre) ou rester
    // implicite (le dernier certificat fourni a été émis par l'ancre) : les deux formes existent.
    const isAnchorItself = fingerprintOf(anchor) === topFingerprint;
    const issuedByAnchor = !isAnchorItself && current.checkIssued(anchor) && current.verify(anchor.publicKey);
    if (!isAnchorItself && !issuedByAnchor) continue;
    if (!isCurrentlyValid(anchor, now)) {
      return { ok: false, reason: `L'autorité « ${commonName(anchor.subject) ?? "configurée"} » n'est plus valide (${anchor.validFrom} → ${anchor.validTo}).` };
    }

    // La chaîne tient. Reste ce que l'autorité en dit AUJOURD'HUI : le dernier émetteur est l'ancre
    // elle-même quand elle n'était pas fournie dans le paquet.
    const policy: CrlPolicy = trust.crlPolicy ?? "soft";
    const revocation =
      policy === "off"
        ? ({ state: "unknown", reason: "vérification de révocation désactivée sur ce serveur" } as const)
        : checkRevocation(chain, [...issuers, anchor], trust.crls ?? [], now);

    if (revocation.state === "revoked") {
      return { ok: false, reason: `Le certificat « ${leafName} » a été ${revocation.reason} : ce module n'est plus accepté.` };
    }
    // « strict » : un certificat qu'aucune liste à jour ne couvre n'est pas réputé valide. C'est le
    // réglage à choisir quand la PKI publie réellement ses listes ; il fait tomber les modules dès
    // que la publication s'arrête, ce qui est le but, et ce qui doit rester un choix explicite.
    if (policy === "strict" && revocation.state === "unknown") {
      return { ok: false, reason: `Révocation invérifiable pour « ${leafName} » : ${revocation.reason}. Le serveur est en mode strict.` };
    }

    return {
      ok: true,
      verdict: {
        keyId: `${CERTIFICATE_KEY_PREFIX}${commonName(anchor.subject) ?? "autorité"}`,
        signer: leafName,
        fingerprint: fingerprintOf(leaf),
        revocation,
      },
    };
  }

  return {
    ok: false,
    reason: `Le certificat « ${leafName} » ne remonte à aucune autorité configurée sur ce serveur : il n'a pas été délivré par une autorité que QUAI reconnaît.`,
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
}

/** Manifeste de paquet exploitable, ou le motif exact du refus. */
function readPackageManifest(bytes: Buffer): { ok: true; manifest: PluginPackageManifest } | { ok: false; reason: string } {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed)) return { ok: false, reason: `${PACKAGE_MANIFEST_NAME} n'est pas un objet JSON exploitable.` };
  if (parsed.format !== PACKAGE_FORMAT) {
    return { ok: false, reason: `Format de paquet inconnu : attendu "${PACKAGE_FORMAT}", trouvé ${JSON.stringify(parsed.format)}.` };
  }
  const id: unknown = parsed.id;
  if (!isValidPluginId(id)) {
    return {
      ok: false,
      reason: `Identifiant de module invalide : ${JSON.stringify(id)} — 2 à 32 caractères en minuscules (lettres, chiffres, tirets).`,
    };
  }
  const name: unknown = parsed.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, reason: "Le manifeste de paquet doit porter un nom lisible (name)." };
  }
  const version: unknown = parsed.version;
  if (typeof version !== "string" || !isSemver(version)) {
    return { ok: false, reason: `Version de module invalide : ${JSON.stringify(version)} — semver attendu (ex. "1.0.0").` };
  }
  const entry: unknown = parsed.entry;
  // .mjs imposé : un module vit dans le répertoire de DONNÉES, où aucun package.json du dépôt ne
  // dit à Node qu'il s'agit d'ESM (voir plugins/installed.ts, qui pose tout de même un marqueur).
  if (typeof entry !== "string" || !isSafePackagePath(entry) || !entry.endsWith(".mjs")) {
    return { ok: false, reason: `Point d'entrée invalide : ${JSON.stringify(entry)} — un fichier .mjs du paquet est attendu.` };
  }
  const exportName: unknown = parsed.exportName;
  if (typeof exportName !== "string" || exportName.trim().length === 0) {
    return { ok: false, reason: "Le manifeste de paquet doit indiquer exportName : le nom sous lequel le module exporte son greffon." };
  }
  const declared: unknown = parsed.files;
  if (!isRecord(declared) || Object.keys(declared).length === 0) {
    return { ok: false, reason: "Le manifeste de paquet ne liste aucun fichier : rien ne serait couvert par la signature." };
  }
  const files: Record<string, string> = {};
  for (const [file, digest] of Object.entries(declared)) {
    if (!isSafePackagePath(file)) return { ok: false, reason: `Chemin de fichier refusé dans le manifeste : ${JSON.stringify(file)}.` };
    if (file === PACKAGE_MANIFEST_NAME || RESERVED_NAMES.has(file)) {
      return { ok: false, reason: `"${file}" est réservé au socle : il ne peut pas figurer parmi les fichiers signés.` };
    }
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: `Empreinte invalide pour "${file}" : SHA-256 hexadécimal attendu.` };
    }
    files[file] = digest;
  }
  if (files[entry] === undefined) {
    return { ok: false, reason: `Le point d'entrée "${entry}" ne figure pas parmi les fichiers signés.` };
  }
  return { ok: true, manifest: { format: PACKAGE_FORMAT, id, name: name.trim(), version, entry, exportName, files } };
}

/**
 * SEULE porte d'entrée de la confiance. Rien d'autre dans le socle ne décide qu'un module est
 * fiable, et rien n'est importé tant que cette fonction n'a pas répondu `ok`.
 */
export function verifyPluginPackage(
  files: PackageFiles,
  trustedKeys: Readonly<Record<string, string>>,
  certificateTrust: CertificateTrust = NO_CERTIFICATE_TRUST,
): PackageVerification {
  const trustedIds = Object.keys(trustedKeys);
  if (trustedIds.length === 0 && certificateTrust.anchors.length === 0) {
    return refuse(
      "Aucune confiance n'est configurée (PLUGIN_TRUSTED_KEYS, PLUGIN_TRUSTED_CA) : l'installation et le chargement de modules externes sont indisponibles.",
    );
  }

  const manifestBytes = files.get(PACKAGE_MANIFEST_NAME);
  if (!manifestBytes) return refuse(`Le paquet ne contient pas son manifeste (${PACKAGE_MANIFEST_NAME}).`);

  const signatureBytes = files.get(PACKAGE_SIGNATURE_NAME);
  if (!signatureBytes) {
    return refuse(`Le paquet n'est pas signé (${PACKAGE_SIGNATURE_NAME} absent) : un module non signé n'est jamais chargé.`);
  }

  const signatureDoc = parseJson(signatureBytes);
  if (!isRecord(signatureDoc)) return refuse(`${PACKAGE_SIGNATURE_NAME} n'est pas un objet JSON exploitable.`);
  const algorithm = signatureDoc.algorithm;
  if (algorithm !== "ed25519" && algorithm !== "x509-sha256") {
    return refuse(
      `Algorithme de signature non supporté : ${JSON.stringify(algorithm)} — "ed25519" (clé nue) et "x509-sha256" (certificat) sont acceptés.`,
    );
  }
  const rawSignature = signatureDoc.signature;
  if (typeof rawSignature !== "string" || !BASE64_PATTERN.test(rawSignature)) {
    return refuse(`${PACKAGE_SIGNATURE_NAME} ne porte pas de signature base64 exploitable.`);
  }

  let keyId: string;
  let signer: string | undefined;
  let certificateFingerprint: string | undefined;
  let revocation: RevocationVerdict | undefined;

  if (algorithm === "x509-sha256") {
    const outcome = verifyCertificateSignature(
      manifestBytes,
      signatureDoc.certificates,
      Buffer.from(rawSignature, "base64"),
      certificateTrust,
      new Date(),
    );
    if (!outcome.ok) return refuse(outcome.reason);
    // Dérivé de l'AUTORITÉ : ce que le paquet annonce dans keyId n'entre jamais en compte, sans quoi
    // un signataire tiers se déclarerait "quai-origin" et usurperait une intégration livrée.
    keyId = outcome.verdict.keyId;
    signer = outcome.verdict.signer;
    certificateFingerprint = outcome.verdict.fingerprint;
    revocation = outcome.verdict.revocation;
  } else {
    const declared = signatureDoc.keyId;
    if (typeof declared !== "string" || declared.trim().length === 0) {
      return refuse(`${PACKAGE_SIGNATURE_NAME} n'indique pas quelle clé a signé (keyId).`);
    }
    keyId = declared;

    const material = trustedKeys[keyId];
    if (material === undefined) {
      return refuse(
        `Signature émise par la clé "${keyId}", inconnue du serveur : seules les clés de confiance configurées (${trustedIds.join(", ") || "aucune"}) sont acceptées.`,
      );
    }
    const publicKey = trustedPublicKey(material);
    if (!publicKey) {
      return refuse(`La clé de confiance "${keyId}" n'est pas une clé publique Ed25519 exploitable : corrigez PLUGIN_TRUSTED_KEYS.`);
    }

    let valid = false;
    try {
      valid = verifyEd25519(null, manifestBytes, publicKey, Buffer.from(rawSignature, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) {
      return refuse(`Signature invalide : le manifeste du paquet ne correspond pas à ce que la clé "${keyId}" a signé.`);
    }
  }

  const manifest = readPackageManifest(manifestBytes);
  if (!manifest.ok) return refuse(manifest.reason);

  for (const [name, expected] of Object.entries(manifest.manifest.files)) {
    const content = files.get(name);
    if (!content) return refuse(`Le fichier signé "${name}" manque dans le paquet.`);
    if (sha256(content) !== expected) {
      return refuse(`Le fichier "${name}" ne correspond pas à son empreinte signée : le paquet a été modifié après signature.`);
    }
  }
  for (const name of files.keys()) {
    if (name === PACKAGE_MANIFEST_NAME || RESERVED_NAMES.has(name)) continue;
    if (manifest.manifest.files[name] === undefined) {
      return refuse(`Le paquet contient un fichier non signé : "${name}" — un ajout après signature est refusé.`);
    }
  }

  return {
    ok: true,
    verified: {
      manifest: manifest.manifest,
      keyId,
      digest: sha256(manifestBytes),
      ...(signer !== undefined ? { signer } : {}),
      ...(certificateFingerprint !== undefined ? { certificateFingerprint } : {}),
      ...(revocation !== undefined ? { revocation } : {}),
    },
  };
}

/** Fichiers d'un paquet posé sur disque, chemins relatifs à `dir`. Lève si le paquet déborde. */
export async function readPackageFiles(dir: string, maxBytes: number): Promise<PackageFiles> {
  const files = new Map<string, Buffer>();
  let total = 0;

  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_FILES) throw new Error(`Le paquet dépasse ${MAX_FILES} fichiers.`);
      const content = await fs.readFile(path.join(current, entry.name));
      total += content.byteLength;
      if (total > maxBytes) throw new Error(`Le paquet dépasse la taille maximale de ${maxBytes} octets.`);
      files.set(relative, content);
    }
  };

  await walk(dir, "");
  return files;
}

export type EnvelopeResult = { ok: true; files: PackageFiles } | { ok: false; reason: string };

/**
 * Enveloppe de transport `{ files: { "<chemin>": "<base64>" } }` — le répertoire du paquet
 * sérialisé tel quel. Aucun chemin n'est deviné ni normalisé : un chemin refusé est refusé.
 */
export function decodePackageEnvelope(body: unknown, maxBytes: number): EnvelopeResult {
  const outer = isRecord(body) ? body : undefined;
  const nested: unknown = outer?.package;
  const root: unknown = isRecord(nested) ? nested : body;
  const declared: unknown = isRecord(root) ? root.files : undefined;
  if (!isRecord(declared)) {
    return { ok: false, reason: 'Paquet illisible : un objet { "files": { "<chemin>": "<contenu base64>" } } est attendu.' };
  }

  const entries = Object.entries(declared);
  if (entries.length === 0) return { ok: false, reason: "Le paquet ne contient aucun fichier." };
  if (entries.length > MAX_FILES) return { ok: false, reason: `Le paquet dépasse ${MAX_FILES} fichiers.` };

  const files = new Map<string, Buffer>();
  let total = 0;
  for (const [name, encoded] of entries) {
    if (!isSafePackagePath(name)) return { ok: false, reason: `Chemin de fichier refusé : ${JSON.stringify(name)}.` };
    if (name === INSTALL_MARK_NAME) return { ok: false, reason: `"${INSTALL_MARK_NAME}" est réservé au socle : il ne peut pas être fourni.` };
    if (typeof encoded !== "string" || !BASE64_PATTERN.test(encoded)) {
      return { ok: false, reason: `Le contenu de "${name}" n'est pas du base64 exploitable.` };
    }
    const content = Buffer.from(encoded, "base64");
    total += content.byteLength;
    if (total > maxBytes) return { ok: false, reason: `Le paquet dépasse la taille maximale de ${maxBytes} octets.` };
    files.set(name, content);
  }
  return { ok: true, files };
}
