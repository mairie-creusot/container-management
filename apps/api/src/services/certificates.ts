/**
 * Certificats TLS émis par l'autorité AD CS interne de la mairie, via le site d'inscription web
 * `certsrv` (POST certfnsh.asp puis GET certnew.cer) — AD CS n'expose AUCUN point ACME natif et
 * NDES/SCEP exige un mot de passe de challenge à usage unique obtenu manuellement, donc
 * inautomatisable ; voir le rapport de recherche accompagnant ce lot.
 *
 * La clé privée est générée ICI, ne quitte jamais le process autrement que chiffrée sur disque
 * (AES-256-GCM, crypto.ts) et n'est JAMAIS journalisée ni renvoyée par une route.
 *
 * Compte présenté à l'autorité — ordre de résolution : identifiants dédiés s'ils sont renseignés,
 * sinon le compte de l'annuaire LDAP (voir resolveEnrollmentAccount plus bas).
 */

import { generateKeyPairSync, sign, X509Certificate, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { URL } from "node:url";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { effectiveAccountSource, getEffectiveCertificatesConfig, getEffectiveLdapConfig } from "./setupStore.js";
import type { CertificateAccountSource, SetupCertificatesConfig } from "./setupStore.js";
import { writeFileRestricted } from "../utils/secureFile.js";

/** L'intégration AD CS n'a jamais été configurée : rien à émettre, jamais une erreur "réseau". */
export class CertificatesNotConfiguredError extends Error {}

/** L'autorité a refusé, mis en attente, ou est injoignable — message déjà expurgé de tout secret. */
export class CertificateEnrollmentError extends Error {}

/** Aucun compte présentable à `certsrv` : erreur de CONFIGURATION, aucun appel réseau n'est tenté. */
export class CertificateAccountError extends Error {}

// ---------------------------------------------------------------------------------------
// Encodage DER minimal + génération de CSR PKCS#10 (RFC 2986) en pur Node.
// `node:crypto` sait générer une paire de clés et signer, mais ne sait PAS produire de CSR ;
// aucune dépendance PKI n'existe dans ce projet et on n'en ajoute pas (pas d'OpenSSL en
// sous-processus non plus : la clé privée ne doit jamais toucher un fichier temporaire).
// ---------------------------------------------------------------------------------------

function derLength(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  let rest = size;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derOid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  const out: number[] = [40 * first + second];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let rest = part;
    do {
      chunk.unshift(rest & 0x7f);
      rest >>>= 7;
    } while (rest > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] ?? 0) | 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const derSequence = (...content: Buffer[]): Buffer => tlv(0x30, Buffer.concat(content));
const derSet = (...content: Buffer[]): Buffer => tlv(0x31, Buffer.concat(content));

const OID_COMMON_NAME = "2.5.4.3";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

function toPem(der: Buffer, label: string): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** CSR PKCS#10 signé (sha256WithRSAEncryption) portant CN=<subject> et un SAN dNSName par nom. */
export function buildCertificateSigningRequest(
  commonName: string,
  dnsNames: readonly string[],
  privateKey: KeyObject,
  publicKey: KeyObject,
): string {
  // PrintableString (pas UTF8String) : AD CS rejette des attributs encodés en UTF-8 sur certains
  // modèles — un nom DNS tient de toute façon dans le jeu PrintableString.
  const subject = derSequence(
    derSet(derSequence(derOid(OID_COMMON_NAME), tlv(0x13, Buffer.from(commonName, "ascii")))),
  );
  const subjectPublicKeyInfo = publicKey.export({ type: "spki", format: "der" });
  const generalNames = derSequence(...dnsNames.map((name) => tlv(0x82, Buffer.from(name, "ascii"))));
  const extensions = derSequence(derSequence(derOid(OID_SUBJECT_ALT_NAME), tlv(0x04, generalNames)));
  const attributes = tlv(0xa0, derSequence(derOid(OID_EXTENSION_REQUEST), derSet(extensions)));
  const requestInfo = derSequence(
    tlv(0x02, Buffer.from([0x00])),
    subject,
    subjectPublicKeyInfo,
    attributes,
  );
  const signatureAlgorithm = derSequence(derOid(OID_SHA256_WITH_RSA), tlv(0x05, Buffer.alloc(0)));
  const signature = sign("sha256", requestInfo, privateKey);
  const csr = derSequence(
    requestInfo,
    signatureAlgorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  return toPem(csr, "CERTIFICATE REQUEST");
}

/** Extrait chaque certificat X.509 d'un PKCS#7 DER en parcourant l'arbre ASN.1 : tout SEQUENCE que
 * `node:crypto` accepte de parser EST un certificat (aucun décodage CMS complet à réimplémenter). */
export function extractCertificatesFromPkcs7(der: Buffer): X509Certificate[] {
  const found: X509Certificate[] = [];
  const walk = (buffer: Buffer, depth: number): void => {
    if (depth > 12) return;
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const tag = buffer[offset];
      if (tag === undefined) return;
      let cursor = offset + 1;
      const firstLengthByte = buffer[cursor];
      if (firstLengthByte === undefined) return;
      cursor += 1;
      let length = firstLengthByte;
      if (firstLengthByte & 0x80) {
        const lengthBytes = firstLengthByte & 0x7f;
        if (lengthBytes === 0 || lengthBytes > 4 || cursor + lengthBytes > buffer.length) return;
        length = 0;
        for (let i = 0; i < lengthBytes; i += 1) {
          length = (length << 8) | (buffer[cursor + i] ?? 0);
        }
        cursor += lengthBytes;
      }
      if (length < 0 || cursor + length > buffer.length) return;
      const content = buffer.subarray(cursor, cursor + length);
      if (tag === 0x30) {
        const candidate = buffer.subarray(offset, cursor + length);
        let parsed: X509Certificate | null = null;
        try {
          parsed = new X509Certificate(candidate);
        } catch {
          parsed = null;
        }
        if (parsed) found.push(parsed);
        else walk(content, depth + 1);
      } else if ((tag & 0x20) !== 0) {
        walk(content, depth + 1);
      }
      offset = cursor + length;
    }
  };
  walk(der, 0);
  return found;
}

// ---------------------------------------------------------------------------------------
// Client HTTP du site d'inscription web AD CS (`certsrv`).
// ---------------------------------------------------------------------------------------

interface RawHttpResponse {
  status: number;
  raw: string;
  body: Buffer;
}

/** `node:http`/`node:https` plutôt que `fetch` : pilote la vérification TLS pour CETTE connexion
 * seulement (l'autorité présente un certificat qu'elle a elle-même émis) — comme hycu.ts/threecx.ts. */
async function rawRequest(
  target: URL,
  options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; rejectUnauthorized: boolean },
): Promise<RawHttpResponse> {
  const isHttps = target.protocol === "https:";
  const send = isHttps ? httpsRequest : httpRequest;
  const timeoutMs = config.certificates.requestTimeoutMs;
  return await new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: options.method,
        headers: options.headers,
        ...(isHttps ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, raw: body.toString("utf-8"), body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`AD CS ${options.method} ${target.pathname} timed out after ${timeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function normalizedCaUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

function certsrvUrl(caUrl: string, relative: string): URL {
  return new URL(relative, normalizedCaUrl(caUrl));
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Filet de sécurité : retire le mot de passe d'un message avant qu'il ne parte vers une route,
 * un log ou un store — aucun message construit ici ne l'interpole, mais l'autorité pourrait le
 * répéter dans une page d'erreur. */
export function scrubSecrets(message: string, secrets: readonly string[]): string {
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("***") : acc), message);
}

function tlsRejectUnauthorized(cfg: SetupCertificatesConfig): boolean {
  return cfg.tlsRejectUnauthorized ?? config.certificates.tlsRejectUnauthorized;
}

// ---------------------------------------------------------------------------------------
// Compte présenté à `certsrv`.
// Ordre de résolution : identifiants dédiés s'ils sont renseignés, sinon le compte de l'annuaire
// LDAP (getEffectiveLdapConfig : bindDn + bindPassword).
// ---------------------------------------------------------------------------------------

/** Découpe un DN en composants, en respectant l'échappement `\,` (RFC 4514). */
function splitDnComponents(dn: string): { type: string; value: string }[] {
  const rdns: string[] = [];
  let current = "";
  for (let i = 0; i < dn.length; i += 1) {
    const char = dn[i]!;
    if (char === "\\" && i + 1 < dn.length) {
      current += dn[i + 1];
      i += 1;
    } else if (char === ",") {
      rdns.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  rdns.push(current);
  const components: { type: string; value: string }[] = [];
  for (const rdn of rdns) {
    const equals = rdn.indexOf("=");
    if (equals <= 0) continue;
    components.push({ type: rdn.slice(0, equals).trim().toLowerCase(), value: rdn.slice(equals + 1).trim() });
  }
  return components;
}

/** Un sAMAccountName tient en 20 caractères sans espace : au-delà, le CN est un nom d'affichage. */
const SAM_ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,20}$/;

export type WindowsIdentifier =
  | { ok: true; username: string; how: string }
  | { ok: false; reason: string };

/**
 * Identifiant de connexion Windows à présenter à `certsrv` (IIS n'accepte PAS un DN) à partir du
 * `bindDn` de l'annuaire. On ne DEVINE pas : seuls un UPN/`DOMAINE\utilisateur` déjà saisi tel
 * quel, ou un DN dont le `CN=` a la forme d'un sAMAccountName (l'UPN implicite `cn@dns.domaine`
 * étant alors accepté par AD), donnent un résultat ; sinon on refuse explicitement.
 */
export function windowsIdentifierFromBindDn(bindDn: string): WindowsIdentifier {
  const trimmed = bindDn.trim();
  if (!trimmed) return { ok: false, reason: "aucun compte de connexion n'est enregistré dans l'annuaire LDAP" };

  if (!trimmed.includes("=")) {
    if (trimmed.includes("\\")) {
      return { ok: true, username: trimmed, how: "identifiant DOMAINE\\utilisateur repris tel quel du compte de l'annuaire" };
    }
    if (trimmed.includes("@")) {
      return { ok: true, username: trimmed, how: "UPN repris tel quel du compte de l'annuaire" };
    }
    return {
      ok: false,
      reason: `il est enregistré sous « ${trimmed} », qui n'est ni un DN, ni un UPN, ni une forme DOMAINE\\utilisateur`,
    };
  }

  const components = splitDnComponents(trimmed);
  const commonName = components.find((component) => component.type === "cn")?.value;
  const domain = components
    .filter((component) => component.type === "dc")
    .map((component) => component.value)
    .join(".");
  if (!commonName) {
    return { ok: false, reason: "son DN ne comporte aucun « CN= » dont déduire un identifiant de connexion Windows" };
  }
  if (!domain) {
    return { ok: false, reason: "son DN ne comporte aucun « DC= » dont déduire le domaine Windows" };
  }
  if (!SAM_ACCOUNT_NAME.test(commonName)) {
    return {
      ok: false,
      reason: `il est enregistré sous « CN=${commonName} », qui n'est pas un identifiant de connexion Windows (espaces ou caractères interdits) — QUAI ne le devine pas`,
    };
  }
  const username = `${commonName}@${domain}`;
  return { ok: true, username, how: `UPN implicite « ${username} » dérivé du DN de l'annuaire (CN= + composants DC=)` };
}

export interface ResolvedEnrollmentAccount {
  source: CertificateAccountSource;
  username: string;
  /** Jamais journalisé, jamais renvoyé par une route — passe seulement dans l'en-tête Basic. */
  password: string;
  /** Provenance affichable de l'identifiant, sans aucun secret. */
  how: string;
}

const NO_DIRECTORY_ACCOUNT = "Impossible d'utiliser le compte de l'annuaire pour s'inscrire auprès de l'autorité";

/** Identifiants dédiés s'ils sont renseignés, sinon le compte de l'annuaire LDAP. */
export async function resolveEnrollmentAccount(cfg: SetupCertificatesConfig): Promise<ResolvedEnrollmentAccount> {
  const source = effectiveAccountSource(cfg);

  if (source === "dedicated") {
    const username = cfg.username?.trim() ?? "";
    const password = cfg.password ?? "";
    if (!username || !password) {
      throw new CertificateAccountError(
        "Compte dédié incomplet : identifiant et mot de passe sont tous deux requis, ou choisissez le compte de l'annuaire.",
      );
    }
    return { source, username, password, how: "compte dédié saisi dans la configuration des certificats" };
  }

  const ldap = await getEffectiveLdapConfig();
  const password = ldap.bindPassword ?? "";
  if (!password) {
    throw new CertificateAccountError(
      `${NO_DIRECTORY_ACCOUNT} : aucun mot de passe n'est enregistré pour ce compte. Renseignez un compte dédié dans la configuration des certificats.`,
    );
  }

  const override = cfg.username?.trim();
  if (override) {
    return { source, username: override, password, how: `identifiant Windows « ${override} » saisi pour le compte de l'annuaire` };
  }

  const derived = windowsIdentifierFromBindDn(ldap.bindDn ?? "");
  if (!derived.ok) {
    throw new CertificateAccountError(
      `${NO_DIRECTORY_ACCOUNT} : ${derived.reason}. Renseignez son identifiant Windows (ex : LECREUSOT\\svc-quai), ou un compte dédié, dans la configuration des certificats.`,
    );
  }
  return { source, username: derived.username, password, how: derived.how };
}

/** Vue affichable du compte réellement utilisé — sans mot de passe, par construction. */
export interface EnrollmentAccountView {
  source: CertificateAccountSource;
  /** Absent quand aucun compte n'a pu être déterminé. */
  username?: string;
  how: string;
  /** Pourquoi aucun compte n'est utilisable — présent uniquement dans ce cas. */
  problem?: string;
}

export async function describeEnrollmentAccount(cfg: SetupCertificatesConfig): Promise<EnrollmentAccountView> {
  try {
    const account = await resolveEnrollmentAccount(cfg);
    return { source: account.source, username: account.username, how: account.how };
  } catch (err) {
    return {
      source: effectiveAccountSource(cfg),
      how: "aucun compte utilisable en l'état",
      problem: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------------------
// Diagnostic d'un refus : identifiants refusés / droits insuffisants / autorité injoignable.
// ---------------------------------------------------------------------------------------

function accountLabel(account: ResolvedEnrollmentAccount): string {
  return account.source === "dedicated"
    ? `le compte dédié « ${account.username} »`
    : `le compte de l'annuaire « ${account.username} »`;
}

/** N'a de sens que si c'est le compte de l'annuaire qui a été essayé — c'est le parcours voulu. */
function dedicatedAccountHint(account: ResolvedEnrollmentAccount, template: string): string {
  if (account.source === "dedicated") return "";
  return ` Renseignez un compte dédié disposant du droit « Inscrire » sur le modèle « ${template} » dans la configuration des certificats.`;
}

/** 401 = identifiants refusés ; 403 = authentifié mais interdit d'accès au site d'inscription. */
function authFailureMessage(account: ResolvedEnrollmentAccount, template: string, status: number): string {
  if (status === 403) {
    return `L'autorité AD CS a accepté ${accountLabel(account)} mais lui refuse l'accès au site d'inscription certsrv (HTTP 403) : droits insuffisants sur le site.${dedicatedAccountHint(account, template)}`;
  }
  if (account.source === "dedicated") {
    return `L'autorité AD CS a refusé les identifiants du compte dédié « ${account.username} » (HTTP 401) — vérifiez l'identifiant et le mot de passe, et que l'authentification de base est activée sur le site certsrv (HTTPS obligatoire).`;
  }
  return `L'autorité AD CS a refusé le compte de l'annuaire « ${account.username} » (HTTP 401) : ce compte n'a pas le droit de s'inscrire sur le site certsrv, ou son identifiant Windows n'est pas celui-ci.${dedicatedAccountHint(account, template)}`;
}

/** Marqueurs de CERTSRV_E_TEMPLATE_DENIED — « droits sur le modèle », distinct d'un refus de politique. */
const TEMPLATE_RIGHTS_MARKERS = [
  "permissions on the certificate template",
  "do not allow the current user to enroll",
  "0x80094012",
  "certsrv_e_template_denied",
];

function looksLikeTemplateRightsDenial(detail: string): boolean {
  const lowered = detail.toLowerCase();
  return TEMPLATE_RIGHTS_MARKERS.some((marker) => lowered.includes(marker));
}

const REQUEST_ID_ISSUED = /certnew\.cer\?ReqID=(\d+)&/;
const REQUEST_ID_PENDING = /Your Request Id is (\d+)\./;
const DISPOSITION_MESSAGE = /The disposition message is "([^"]+)/;

/** Soumet un CSR à `certfnsh.asp` puis récupère le certificat émis sur `certnew.cer`. */
async function submitCsrToCertsrv(
  cfg: SetupCertificatesConfig,
  account: ResolvedEnrollmentAccount,
  csrPem: string,
): Promise<string> {
  const secrets = [account.password];
  const auth = basicAuthHeader(account.username, account.password);
  const form = new URLSearchParams({
    Mode: "newreq",
    CertRequest: csrPem,
    CertAttrib: `CertificateTemplate:${cfg.template}\r\n`,
    FriendlyType: "Saved-Request Certificate",
    TargetStoreFlags: "0",
    SaveCert: "yes",
  }).toString();

  let submitted: RawHttpResponse;
  try {
    submitted = await rawRequest(certsrvUrl(cfg.caUrl, "certfnsh.asp"), {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(form)),
      },
      body: form,
      rejectUnauthorized: tlsRejectUnauthorized(cfg),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new CertificateEnrollmentError(`Autorité AD CS injoignable : ${message}`);
  }

  if (submitted.status === 401 || submitted.status === 403) {
    throw new CertificateEnrollmentError(authFailureMessage(account, cfg.template, submitted.status));
  }
  if (submitted.status < 200 || submitted.status >= 300) {
    throw new CertificateEnrollmentError(`L'autorité AD CS a répondu HTTP ${submitted.status} à la soumission de la demande.`);
  }

  const issued = REQUEST_ID_ISSUED.exec(submitted.raw);
  if (!issued) {
    const pending = REQUEST_ID_PENDING.exec(submitted.raw);
    if (submitted.raw.includes("Certificate Pending") || pending) {
      throw new CertificateEnrollmentError(
        `La demande est EN ATTENTE d'approbation manuelle sur l'autorité${pending?.[1] ? ` (demande n°${pending[1]})` : ""} — le modèle "${cfg.template}" doit être configuré pour émettre sans approbation.`,
      );
    }
    const disposition = DISPOSITION_MESSAGE.exec(submitted.raw);
    const detail = disposition?.[1] ?? submitted.raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (looksLikeTemplateRightsDenial(detail)) {
      throw new CertificateEnrollmentError(
        scrubSecrets(
          `Le modèle « ${cfg.template} » n'autorise pas ${accountLabel(account)} à s'inscrire : droit « Inscrire » manquant sur le modèle (réponse de l'autorité : ${detail}).${dedicatedAccountHint(account, cfg.template)}`,
          secrets,
        ),
      );
    }
    throw new CertificateEnrollmentError(
      scrubSecrets(`L'autorité AD CS a refusé la demande${detail ? ` : ${detail}` : "."}`, secrets),
    );
  }

  const requestId = issued[1]!;
  let retrieved: RawHttpResponse;
  try {
    retrieved = await rawRequest(certsrvUrl(cfg.caUrl, `certnew.cer?ReqID=${requestId}&Enc=b64`), {
      method: "GET",
      headers: { Authorization: auth },
      rejectUnauthorized: tlsRejectUnauthorized(cfg),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new CertificateEnrollmentError(`Certificat émis (demande n°${requestId}) mais non récupérable : ${message}`);
  }

  if (retrieved.status < 200 || retrieved.status >= 300 || !retrieved.raw.includes("BEGIN CERTIFICATE")) {
    throw new CertificateEnrollmentError(
      `Certificat émis (demande n°${requestId}) mais la récupération a répondu HTTP ${retrieved.status} sans certificat PEM.`,
    );
  }
  return retrieved.raw.trim();
}

/** Chaîne d'autorité (PKCS#7) — best-effort : sans elle le navigateur peut manquer l'intermédiaire,
 * mais un échec ici ne doit jamais faire échouer une émission par ailleurs réussie. */
async function fetchCaChain(cfg: SetupCertificatesConfig, account: ResolvedEnrollmentAccount): Promise<string | null> {
  try {
    const response = await rawRequest(certsrvUrl(cfg.caUrl, "certnew.p7b?ReqID=CACert&Renewal=0&Enc=bin"), {
      method: "GET",
      headers: { Authorization: basicAuthHeader(account.username, account.password) },
      rejectUnauthorized: tlsRejectUnauthorized(cfg),
    });
    if (response.status < 200 || response.status >= 300) return null;
    const certificates = extractCertificatesFromPkcs7(response.body);
    // Le certificat racine est auto-signé : inutile de le servir, seuls les intermédiaires comptent.
    const intermediates = certificates.filter((certificate) => certificate.issuer !== certificate.subject);
    if (intermediates.length === 0) return null;
    return intermediates.map((certificate) => certificate.toString().trim()).join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Persistance (data/certificates.json) — clé privée chiffrée au repos, fichier 0600.
// ---------------------------------------------------------------------------------------

interface StoredCertificate {
  id: string;
  subject: string;
  certificatePem: string;
  chainPem?: string;
  /** Chiffrée au repos (crypto.ts) — jamais lue en dehors de ce module. */
  privateKeyPem: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  issuedAt: string;
  lastRenewalAttemptAt?: string;
  lastRenewalError?: string;
}

let cache: StoredCertificate[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.certificates.storePath);
}

async function readFromDisk(): Promise<StoredCertificate[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredCertificate[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: StoredCertificate[]): Promise<void> {
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
  cache = next;
}

async function getAll(): Promise<StoredCertificate[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

/** Vide le cache mémoire — réservé aux tests, qui réécrivent le fichier entre deux cas. */
export function resetCertificatesCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------------------
// Vue publique (aucune clé privée, aucun identifiant).
// ---------------------------------------------------------------------------------------

export type CertificateHealth = "valid" | "expiring" | "expired";

export interface CertificateSummary {
  id: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;
  health: CertificateHealth;
  issuedAt: string;
  /** Date à partir de laquelle la boucle tentera un renouvellement. */
  renewAt: string;
  lastRenewalAttemptAt?: string;
  /** Dernier échec de renouvellement — visible, jamais masqué (le certificat courant reste servi). */
  lastRenewalError?: string;
}

export interface CertificatesStatus {
  configured: boolean;
  caUrl?: string;
  template?: string;
  autoEnroll?: boolean;
  /** Compte réellement présenté à l'autorité — jamais son mot de passe. */
  account?: EnrollmentAccountView;
  renewBeforeDays: number;
  certificates: CertificateSummary[];
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function effectiveRenewBeforeDays(cfg: SetupCertificatesConfig | null): number {
  const configured = cfg?.renewBeforeDays;
  return configured !== undefined && configured > 0 ? configured : config.certificates.renewBeforeDays;
}

function toSummary(entry: StoredCertificate, renewBeforeDays: number, now: Date): CertificateSummary {
  const notAfter = new Date(entry.notAfter);
  const daysRemaining = daysBetween(now, notAfter);
  const renewAt = new Date(notAfter.getTime() - renewBeforeDays * 86_400_000);
  const health: CertificateHealth = daysRemaining < 0 ? "expired" : daysRemaining <= renewBeforeDays ? "expiring" : "valid";
  return {
    id: entry.id,
    subject: entry.subject,
    issuer: entry.issuer,
    serialNumber: entry.serialNumber,
    notBefore: entry.notBefore,
    notAfter: entry.notAfter,
    daysRemaining,
    health,
    issuedAt: entry.issuedAt,
    renewAt: renewAt.toISOString(),
    ...(entry.lastRenewalAttemptAt ? { lastRenewalAttemptAt: entry.lastRenewalAttemptAt } : {}),
    ...(entry.lastRenewalError ? { lastRenewalError: entry.lastRenewalError } : {}),
  };
}

/** GET /api/certificates — état réel de chaque certificat détenu, config (sans secret) comprise. */
export async function getCertificatesStatus(now: Date = new Date()): Promise<CertificatesStatus> {
  const cfg = await getEffectiveCertificatesConfig();
  const renewBeforeDays = effectiveRenewBeforeDays(cfg);
  const entries = await getAll();
  const certificates = entries
    .map((entry) => toSummary(entry, renewBeforeDays, now))
    .sort((a, b) => a.subject.localeCompare(b.subject));
  const account = cfg ? await describeEnrollmentAccount(cfg) : null;
  return {
    configured: cfg !== null,
    ...(cfg ? { caUrl: cfg.caUrl, template: cfg.template, autoEnroll: cfg.autoEnroll ?? true } : {}),
    ...(account ? { account } : {}),
    renewBeforeDays,
    certificates,
  };
}

/** Ce que Caddy doit servir : uniquement les certificats NON expirés (voir reverseProxy.ts). */
export interface ServableCertificate {
  subject: string;
  /** Feuille + intermédiaires concaténés — ce que `tls.certificates.load_pem` attend. */
  certificatePem: string;
  privateKeyPem: string;
}

export async function getServableCertificates(now: Date = new Date()): Promise<ServableCertificate[]> {
  const entries = await getAll();
  const servable: ServableCertificate[] = [];
  for (const entry of entries) {
    if (new Date(entry.notAfter).getTime() <= now.getTime()) continue;
    servable.push({
      subject: entry.subject,
      certificatePem: entry.chainPem ? `${entry.certificatePem.trim()}\n${entry.chainPem.trim()}\n` : entry.certificatePem,
      privateKeyPem: decryptSecret(entry.privateKeyPem),
    });
  }
  return servable;
}

// ---------------------------------------------------------------------------------------
// Émission et renouvellement.
// ---------------------------------------------------------------------------------------

function normalizeSubject(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Émet (ou réémet) un certificat pour `subject` : nouvelle paire de clés, CSR, soumission à
 * l'autorité, vérification que le certificat rendu correspond bien à NOTRE clé, puis stockage.
 * Le certificat déjà en place n'est remplacé qu'après un succès complet — un échec laisse
 * l'ancien intact et servi.
 */
export async function issueCertificate(subject: string): Promise<CertificateSummary> {
  const cfg = await getEffectiveCertificatesConfig();
  if (!cfg) throw new CertificatesNotConfiguredError("L'autorité de certification AD CS n'est pas configurée.");

  const normalized = normalizeSubject(subject);
  if (!normalized) throw new CertificateEnrollmentError("Le sujet du certificat est requis.");

  // Résolu AVANT de générer quoi que ce soit : sans compte utilisable, aucun appel réseau n'est tenté.
  const account = await resolveEnrollmentAccount(cfg);

  const modulusLength = cfg.keySize && cfg.keySize >= 2048 ? cfg.keySize : 2048;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  const csrPem = buildCertificateSigningRequest(normalized, [normalized], privateKey, publicKey);

  const certificatePem = await submitCsrToCertsrv(cfg, account, csrPem);

  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificatePem);
  } catch (err) {
    throw new CertificateEnrollmentError(
      `L'autorité a répondu un certificat illisible : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed.checkPrivateKey(privateKey)) {
    throw new CertificateEnrollmentError("Le certificat rendu par l'autorité ne correspond pas à la clé générée — émission abandonnée.");
  }

  const chainPem = await fetchCaChain(cfg, account);
  const now = new Date();
  const entries = await getAll();
  const existing = entries.find((entry) => entry.subject === normalized);
  const stored: StoredCertificate = {
    id: existing?.id ?? normalized,
    subject: normalized,
    certificatePem: parsed.toString().trim(),
    ...(chainPem ? { chainPem } : {}),
    privateKeyPem: encryptSecretIfNeeded(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    issuer: parsed.issuer.replace(/\n/g, ", "),
    serialNumber: parsed.serialNumber,
    notBefore: new Date(parsed.validFrom).toISOString(),
    notAfter: new Date(parsed.validTo).toISOString(),
    issuedAt: now.toISOString(),
  };
  const next = existing
    ? entries.map((entry) => (entry.subject === normalized ? stored : entry))
    : [...entries, stored];
  await writeToDisk(next);
  return toSummary(stored, effectiveRenewBeforeDays(cfg), now);
}

/** Enregistre l'échec de renouvellement SANS toucher au certificat en place — il reste servi. */
export async function recordRenewalFailure(subject: string, message: string): Promise<void> {
  const normalized = normalizeSubject(subject);
  const entries = await getAll();
  const at = new Date().toISOString();
  let touched = false;
  const next = entries.map((entry) => {
    if (entry.subject !== normalized) return entry;
    touched = true;
    return { ...entry, lastRenewalAttemptAt: at, lastRenewalError: message };
  });
  if (touched) await writeToDisk(next);
}

/** DELETE /api/certificates/:subject — oublie un certificat (le sujet repasse à l'autorité interne
 * de Caddy au prochain push, jamais de coupure : la config complète est republiée d'un bloc). */
export async function forgetCertificate(subject: string): Promise<boolean> {
  const normalized = normalizeSubject(subject);
  const entries = await getAll();
  const next = entries.filter((entry) => entry.subject !== normalized);
  if (next.length === entries.length) return false;
  await writeToDisk(next);
  return true;
}

/** Sujets dont le certificat entre dans la fenêtre de renouvellement (ou est déjà expiré). */
export async function subjectsDueForRenewal(now: Date = new Date()): Promise<string[]> {
  const cfg = await getEffectiveCertificatesConfig();
  const renewBeforeDays = effectiveRenewBeforeDays(cfg);
  const entries = await getAll();
  return entries
    .filter((entry) => daysBetween(now, new Date(entry.notAfter)) <= renewBeforeDays)
    .map((entry) => entry.subject);
}

export async function knownSubjects(): Promise<string[]> {
  return (await getAll()).map((entry) => entry.subject);
}

export interface CertificatesTestResult {
  ok: boolean;
  message: string;
  /** Compte réellement essayé — permet à l'interface de rappeler lequel a servi. */
  account?: EnrollmentAccountView;
}

/**
 * Vérifie que l'autorité répond ET accepte le compte résolu, SANS émettre de certificat : la page
 * d'accueil de `certsrv` est protégée par la même authentification que l'inscription.
 */
export async function testCertificatesConnection(cfg: SetupCertificatesConfig): Promise<CertificatesTestResult> {
  if (!cfg.caUrl || !cfg.template) {
    return { ok: false, message: "URL de l'autorité et modèle de certificat sont requis." };
  }

  let account: ResolvedEnrollmentAccount;
  try {
    account = await resolveEnrollmentAccount(cfg);
  } catch (err) {
    const view = await describeEnrollmentAccount(cfg);
    return { ok: false, message: err instanceof Error ? err.message : String(err), account: view };
  }
  const view: EnrollmentAccountView = { source: account.source, username: account.username, how: account.how };

  let response: RawHttpResponse;
  try {
    response = await rawRequest(certsrvUrl(cfg.caUrl, "certrqxt.asp"), {
      method: "GET",
      headers: { Authorization: basicAuthHeader(account.username, account.password) },
      rejectUnauthorized: tlsRejectUnauthorized(cfg),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), [account.password]);
    return { ok: false, message: `Autorité AD CS injoignable : ${message}`, account: view };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: authFailureMessage(account, cfg.template, response.status), account: view };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, message: `L'autorité a répondu HTTP ${response.status} sur certrqxt.asp.`, account: view };
  }
  return {
    ok: true,
    message: `Autorité AD CS joignable, ${accountLabel(account)} accepté (modèle "${cfg.template}").`,
    account: view,
  };
}
