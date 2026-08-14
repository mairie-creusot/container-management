/**
 * Config LXD persistée (cf. ARCHITECTURE.md, chapitre "Support LXC (via LXD)") — UN seul
 * endpoint LXD distant (pas une liste nommée comme remoteDockerStore.ts : LXD n'a, dans ce
 * premier lot, pas de notion de "plusieurs intégrations LXC" côté QUAI, exactement comme
 * Nutanix n'a qu'une seule config Prism Central).
 *
 * Même pattern que secretsStore.ts/remoteDockerStore.ts : persistance JSON sur disque
 * (LXC_PATH, défaut ./data/lxc.json), cache mémoire process invalidé à chaque écriture,
 * fichier écrit avec des permissions restrictives (0600). Le certificat client (clientCert)
 * et sa clé privée (clientKey) — l'authentification mutuelle TLS attendue par LXD pour un accès
 * distant, voir services/lxc.ts — sont chiffrés au repos (AES-256-GCM, crypto.ts) champ par
 * champ, comme ca/cert/key dans remoteDockerStore.ts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { writeFileRestricted } from "../utils/secureFile.js";

interface StoredLxcConfig {
  endpoint: string; // ex: "https://lxd.lecreusot.priv:8443"
  clientCert: string; // PEM, chiffré au repos
  clientKey: string; // PEM, chiffré au repos
  updatedAt: string;
}

/** Vue publique — ne contient JAMAIS le contenu du certificat/de la clé. */
export interface LxcConfigRef {
  configured: boolean;
  endpoint?: string;
  updatedAt?: string;
}

/** Config effective (déchiffrée) — réservée à un usage serveur (services/lxc.ts), jamais exposée par une route. */
export interface EffectiveLxcConfig {
  endpoint: string;
  clientCert: string;
  clientKey: string;
}

export class LxcValidationError extends Error {}

let cache: StoredLxcConfig | null | undefined; // undefined = pas encore chargé, null = chargé et absent

function resolvedStorePath(): string {
  return path.resolve(config.lxc.storePath);
}

async function readFromDisk(): Promise<StoredLxcConfig | null> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as StoredLxcConfig;
  } catch {
    return null;
  }
}

async function writeToDisk(next: StoredLxcConfig | null): Promise<void> {
  // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
}

async function getCurrent(): Promise<StoredLxcConfig | null> {
  if (cache !== undefined) return cache;
  cache = await readFromDisk();
  return cache;
}

/** GET /api/lxc/config — jamais le certificat/la clé. */
export async function getLxcConfigRef(): Promise<LxcConfigRef> {
  const current = await getCurrent();
  if (!current) return { configured: false };
  return { configured: true, endpoint: current.endpoint, updatedAt: current.updatedAt };
}

export interface LxcConfigInput {
  endpoint: string;
  clientCert: string;
  clientKey: string;
}

function assertValidInput(input: LxcConfigInput): void {
  const endpoint = input.endpoint.trim();
  if (!endpoint) throw new LxcValidationError("endpoint is required");
  if (!/^https:\/\//i.test(endpoint)) {
    throw new LxcValidationError('endpoint must start with "https://" (LXD REST API over TLS)');
  }
  if (!input.clientCert.trim() || !input.clientKey.trim()) {
    throw new LxcValidationError("clientCert and clientKey are both required (LXD authenticates remote clients by mutual TLS)");
  }
}

/** PUT /api/lxc/config — admin uniquement (voir routes/lxc.ts). Remplace toute config existante. */
export async function setLxcConfig(input: LxcConfigInput): Promise<LxcConfigRef> {
  assertValidInput(input);
  const next: StoredLxcConfig = {
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    clientCert: encryptSecretIfNeeded(input.clientCert),
    clientKey: encryptSecretIfNeeded(input.clientKey),
    updatedAt: new Date().toISOString(),
  };
  await writeToDisk(next);
  cache = next;
  return { configured: true, endpoint: next.endpoint, updatedAt: next.updatedAt };
}

/** DELETE /api/lxc/config — admin uniquement. */
export async function clearLxcConfig(): Promise<void> {
  await writeToDisk(null);
  cache = null;
}

/**
 * Config effective déchiffrée — réservée à services/lxc.ts. `null` si LXD n'a jamais été
 * configuré (voir lxc.ts#isLxcConfigured, même principe que getEffectiveNutanixConfig).
 */
export async function getEffectiveLxcConfig(): Promise<EffectiveLxcConfig | null> {
  const current = await getCurrent();
  if (!current) return null;
  return {
    endpoint: current.endpoint,
    clientCert: decryptSecret(current.clientCert),
    clientKey: decryptSecret(current.clientKey),
  };
}
