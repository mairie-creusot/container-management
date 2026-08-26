/**
 * LISTES DE RÉVOCATION (CRL) des certificats de signature de module.
 *
 * Deux décisions structurent ce fichier.
 *
 * 1. AUCUN APPEL RÉSEAU ICI. Une CRL est lue sur le DISQUE, dans un répertoire du volume de données.
 *    Interroger une PKI au moment précis où le socle décide de charger du code n'aurait pas de
 *    réponse honnête en cas d'échec : ni « je charge quand même » (la révocation deviendrait
 *    décorative), ni « je coupe tout » (une PKI enrhumée éteindrait les intégrations). Le
 *    rafraîchissement est donc une tâche séparée (services/crlRefresher.ts), et ce fichier ne voit
 *    que des fichiers déjà là.
 *
 * 2. ANALYSE DER ÉCRITE ICI, sans dépendance. Une bibliothèque ASN.1 aurait fait le travail, mais
 *    elle entrerait dans le processus qui garde la frontière de confiance — c'est précisément ce
 *    qu'on cherche à contrôler. Le lecteur ci-dessous est volontairement étroit et strict : il ne
 *    connaît que la structure d'une CRL, refuse tout ce qu'il ne reconnaît pas, et ne peut jamais
 *    ACCORDER une confiance — au pire il n'en retire pas une qu'il aurait fallu retirer, ce qui
 *    ramène exactement à l'état sans CRL. C'est aussi pourquoi SHA-1 reste accepté pour la signature
 *    d'une CRL : une CRL forgée ne peut que révoquer, jamais habiliter.
 */

import { X509Certificate, createHash, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";

/** Politique appliquée quand aucune CRL exploitable ne couvre un certificat. */
export type CrlPolicy = "off" | "soft" | "strict";

export interface ParsedCrl {
  /** Nom du fichier d'où elle vient — le seul repère utile dans un message d'erreur. */
  source: string;
  /** Octets EXACTS de tbsCertList, ceux que la signature couvre. */
  tbs: Buffer;
  signature: Buffer;
  /** Nom du condensat déduit de l'OID de signature ("sha256"). */
  digest: string;
  thisUpdate: Date;
  /** Absent = CRL sans date de péremption : jamais considérée comme périmée. */
  nextUpdate: Date | undefined;
  /** Numéros de série révoqués, normalisés (minuscules, sans zéros de tête). */
  revoked: ReadonlySet<string>;
}

export type RevocationVerdict =
  | { state: "clear"; source: string }
  | { state: "revoked"; reason: string }
  | { state: "unknown"; reason: string };

// --- Lecteur DER minimal --------------------------------------------------------------------

interface DerNode {
  tag: number;
  /** Contenu seul, sans en-tête. */
  content: Buffer;
  /** En-tête + contenu : ce qu'une signature couvre. */
  raw: Buffer;
}

class DerError extends Error {}

/** Découpe la suite de nœuds DER d'un tampon. Refuse toute forme qu'elle ne sait pas lire. */
function readNodes(buffer: Buffer): DerNode[] {
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const tag = buffer[offset];
    if (tag === undefined) throw new DerError("étiquette DER absente");
    offset += 1;
    // Étiquette longue (0x1f) : aucune structure de CRL n'en utilise, on refuse plutôt que deviner.
    if ((tag & 0x1f) === 0x1f) throw new DerError("étiquette DER longue non supportée");

    const first = buffer[offset];
    if (first === undefined) throw new DerError("longueur DER absente");
    offset += 1;

    let length: number;
    if (first < 0x80) {
      length = first;
    } else if (first === 0x80) {
      throw new DerError("longueur DER indéfinie non supportée");
    } else {
      const count = first & 0x7f;
      if (count > 4) throw new DerError("longueur DER hors de portée");
      length = 0;
      for (let index = 0; index < count; index += 1) {
        const byte = buffer[offset + index];
        if (byte === undefined) throw new DerError("longueur DER tronquée");
        length = length * 256 + byte;
      }
      offset += count;
    }

    const end = offset + length;
    if (end > buffer.length) throw new DerError("contenu DER tronqué");
    nodes.push({ tag, content: buffer.subarray(offset, end), raw: buffer.subarray(start, end) });
    offset = end;
  }
  return nodes;
}

function expect(nodes: DerNode[], index: number, tag: number, what: string): DerNode {
  const node = nodes[index];
  if (!node || node.tag !== tag) throw new DerError(`${what} attendu`);
  return node;
}

/** OID en notation pointée, à partir de son encodage DER. */
function readOid(content: Buffer): string {
  const first = content[0];
  if (first === undefined) throw new DerError("OID vide");
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of content.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/**
 * Condensat correspondant à l'OID de signature. SHA-1 est accepté : une CRL ne peut que RETIRER une
 * confiance (voir l'en-tête), et beaucoup d'autorités internes signent encore ainsi.
 */
const SIGNATURE_DIGESTS: Record<string, string> = {
  "1.2.840.113549.1.1.5": "sha1", // sha1WithRSAEncryption
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.1": "sha224", // ecdsa-with-SHA*
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};

const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

function readTime(node: DerNode): Date {
  const text = node.content.toString("ascii");
  const match =
    node.tag === UTC_TIME
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) throw new DerError(`date DER illisible : ${JSON.stringify(text)}`);

  const [, rawYear, month, day, hour, minute, second] = match as unknown as string[];
  // UTCTime n'a que deux chiffres d'année : la bascule à 50 est celle de la RFC 5280.
  const year = node.tag === UTC_TIME ? (Number(rawYear) < 50 ? 2000 + Number(rawYear) : 1900 + Number(rawYear)) : Number(rawYear);
  return new Date(Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function isTime(node: DerNode | undefined): boolean {
  return node !== undefined && (node.tag === UTC_TIME || node.tag === GENERALIZED_TIME);
}

/** "00A1B2" -> "a1b2" : même forme que X509Certificate#serialNumber une fois normalisé. */
export function normalizeSerial(serial: string): string {
  return serial.replace(/^0+/, "").toLowerCase() || "0";
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;

/**
 * CRL exploitable, ou le motif exact du refus. Rien n'est deviné : une structure inattendue est une
 * CRL inutilisable, pas une CRL vide (qui, elle, dirait « personne n'est révoqué »).
 */
export function parseCrl(der: Buffer, source: string): { ok: true; crl: ParsedCrl } | { ok: false; reason: string } {
  try {
    const [root, ...rest] = readNodes(der);
    if (!root || root.tag !== SEQUENCE || rest.length > 0) throw new DerError("une CRL est une SEQUENCE unique");

    const top = readNodes(root.content);
    const tbsNode = expect(top, 0, SEQUENCE, "tbsCertList");
    const algorithmNode = expect(top, 1, SEQUENCE, "algorithme de signature");
    const signatureNode = expect(top, 2, BIT_STRING, "signature");

    const [algorithmOid] = readNodes(algorithmNode.content);
    if (!algorithmOid) throw new DerError("OID d'algorithme absent");
    const digest = SIGNATURE_DIGESTS[readOid(algorithmOid.content)];
    if (digest === undefined) throw new DerError(`algorithme de signature de CRL non supporté (${readOid(algorithmOid.content)})`);

    const fields = readNodes(tbsNode.content);
    let index = 0;
    if (fields[index]?.tag === INTEGER) index += 1; // version, absente en v1
    expect(fields, index, SEQUENCE, "algorithme du tbsCertList");
    index += 1;
    expect(fields, index, SEQUENCE, "émetteur");
    index += 1;

    const thisUpdateNode = fields[index];
    if (!isTime(thisUpdateNode)) throw new DerError("thisUpdate attendu");
    const thisUpdate = readTime(thisUpdateNode!);
    index += 1;

    let nextUpdate: Date | undefined;
    if (isTime(fields[index])) {
      nextUpdate = readTime(fields[index]!);
      index += 1;
    }

    const revoked = new Set<string>();
    const revokedNode = fields[index];
    if (revokedNode?.tag === SEQUENCE) {
      for (const entry of readNodes(revokedNode.content)) {
        if (entry.tag !== SEQUENCE) throw new DerError("entrée de révocation inattendue");
        const [serialNode] = readNodes(entry.content);
        if (!serialNode || serialNode.tag !== INTEGER) throw new DerError("numéro de série absent");
        revoked.add(normalizeSerial(serialNode.content.toString("hex")));
      }
    }

    // La signature couvre les OCTETS de tbsCertList, en-tête compris : c'est `raw`, jamais `content`.
    // Le premier octet d'un BIT STRING compte les bits inutilisés — il ne fait pas partie de la valeur.
    return {
      ok: true,
      crl: {
        source,
        tbs: Buffer.from(tbsNode.raw),
        signature: Buffer.from(signatureNode.content.subarray(1)),
        digest,
        thisUpdate,
        nextUpdate,
        revoked,
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof DerError ? err.message : `CRL illisible (${source})` };
  }
}

/** La CRL a-t-elle réellement été signée par cette autorité ? C'est le seul lien qui compte : aucun
 * nom n'est comparé, c'est la signature qui dit qui l'a émise. */
export function crlSignedBy(crl: ParsedCrl, issuerKey: KeyObject): boolean {
  try {
    return verifySignature(crl.digest, crl.tbs, issuerKey, crl.signature);
  } catch {
    return false;
  }
}

/**
 * Verdict de révocation pour une chaîne déjà vérifiée. Chaque certificat est confronté aux CRL que
 * SON émetteur a signées ; un certificat qu'aucune CRL ne couvre reste « inconnu », jamais « sain ».
 *
 * `issuers` doit contenir, dans l'ordre, l'émetteur de chaque certificat de `chain` — c'est ce que
 * la vérification de chaîne vient d'établir.
 */
export function checkRevocation(
  chain: readonly X509Certificate[],
  issuers: readonly X509Certificate[],
  crls: readonly ParsedCrl[],
  now: Date,
): RevocationVerdict {
  if (crls.length === 0) return { state: "unknown", reason: "aucune liste de révocation n'est disponible sur ce serveur" };

  let coveringSource: string | undefined;
  let staleSource: string | undefined;

  for (const [position, certificate] of chain.entries()) {
    const issuer = issuers[position];
    if (!issuer) continue;

    const applicable = crls.filter((crl) => crlSignedBy(crl, issuer.publicKey));
    if (applicable.length === 0) continue;

    for (const crl of applicable) {
      if (crl.nextUpdate !== undefined && crl.nextUpdate.getTime() < now.getTime()) {
        staleSource ??= crl.source;
        continue;
      }
      coveringSource ??= crl.source;
      if (crl.revoked.has(normalizeSerial(certificate.serialNumber))) {
        return {
          state: "revoked",
          reason: `révoqué par l'autorité (liste ${crl.source}, publiée le ${crl.thisUpdate.toISOString().slice(0, 10)})`,
        };
      }
    }
  }

  if (coveringSource !== undefined) return { state: "clear", source: coveringSource };
  if (staleSource !== undefined) {
    return { state: "unknown", reason: `la seule liste de révocation disponible (${staleSource}) est périmée` };
  }
  return { state: "unknown", reason: "aucune liste de révocation ne provient de l'autorité qui a délivré ce certificat" };
}

// --- Chargement depuis le disque -------------------------------------------------------------

interface CrlCache {
  /** Signature du répertoire (noms, tailles, dates) : re-lire n'a lieu qu'en cas de changement. */
  fingerprint: string;
  crls: ParsedCrl[];
  rejected: { source: string; reason: string }[];
}

let cache: CrlCache | undefined;

function directoryFingerprint(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fsSync.readdirSync(dir).sort();
  } catch {
    return undefined;
  }
  const hash = createHash("sha256");
  for (const name of entries) {
    try {
      const stat = fsSync.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      hash.update(`${name}:${stat.size}:${stat.mtimeMs}\n`);
    } catch {
      // Fichier disparu entre readdir et stat : il ne compte simplement pas.
    }
  }
  return hash.digest("hex");
}

/**
 * CRL présentes sur le disque, relues seulement quand le répertoire a changé. Lecture SYNCHRONE
 * assumée : ces fichiers sont petits, et la vérification de paquet qui les consulte est synchrone.
 * Un répertoire absent n'est pas une erreur — il n'y a simplement aucune révocation à opposer.
 */
export function loadCrls(dir: string | undefined): { crls: ParsedCrl[]; rejected: { source: string; reason: string }[] } {
  if (dir === undefined) return { crls: [], rejected: [] };

  const fingerprint = directoryFingerprint(dir);
  if (fingerprint === undefined) return { crls: [], rejected: [] };
  if (cache?.fingerprint === fingerprint) return { crls: cache.crls, rejected: cache.rejected };

  const crls: ParsedCrl[] = [];
  const rejected: { source: string; reason: string }[] = [];
  for (const name of fsSync.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    let content: Buffer;
    try {
      content = fsSync.readFileSync(path.join(dir, name));
    } catch (err) {
      rejected.push({ source: name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = parseCrl(pemToDer(content), name);
    if (parsed.ok) crls.push(parsed.crl);
    else rejected.push({ source: name, reason: parsed.reason });
  }

  cache = { fingerprint, crls, rejected };
  return { crls, rejected };
}

/** Une CRL se distribue en DER brut ou en PEM ; les deux formes existent chez AD CS. */
export function pemToDer(content: Buffer): Buffer {
  const text = content.toString("latin1");
  const match = /-----BEGIN X509 CRL-----([\sA-Za-z0-9+/=]+?)-----END X509 CRL-----/.exec(text);
  return match?.[1] === undefined ? content : Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

export function resetCrlCacheForTests(): void {
  cache = undefined;
}
