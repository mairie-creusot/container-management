/**
 * Environnements Docker distants persistés (cf. ARCHITECTURE.md, chapitre "Environnements
 * Docker distants") — liste nommée d'hôtes Docker joignables en TCP+TLS, en plus du démon
 * local piloté par défaut (services/docker.ts#getClient sans argument).
 *
 * Même pattern que secretsStore.ts : persistance JSON sur disque (REMOTE_DOCKER_PATH, défaut
 * ./data/remote-docker.json), cache mémoire process invalidé à chaque écriture, fichier écrit
 * avec des permissions restrictives (0600).
 *
 * dockerode/docker-modem acceptent `host`/`port`/`ca`/`cert`/`key` directement dans leur
 * constructeur pour une connexion TCP+TLS à un démon distant (voir docker.ts#getClient) — c'est
 * la méthode standard documentée par Docker Engine pour exposer un démon sur le réseau
 * (https://docs.docker.com/engine/security/protect-access/). `ca`/`cert`/`key` (PEM) sont
 * chiffrés au repos (AES-256-GCM, crypto.ts) champ par champ, comme le mot de passe LDAP/le
 * kubeconfig/les identifiants de registry dans setupStore.ts — le fichier ne contient jamais de
 * secret en clair. `host`/`port`/`name` ne sont pas des secrets, non chiffrés.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";

export interface RemoteDockerTls {
  ca?: string;
  cert?: string;
  key?: string;
}

interface StoredRemoteDockerEnvironment {
  id: string;
  name: string;
  host: string;
  port: number;
  // ca/cert/key : chiffrés au repos (voir crypto.ts) quand présents.
  tls?: RemoteDockerTls;
  createdAt: string;
  updatedAt: string;
}

/** Vue publique — ne contient JAMAIS le contenu ca/cert/key (voir toRef ci-dessous). */
export interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  hasTls: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Config effective (déchiffrée) — réservée à un usage serveur (docker.ts#getClient), jamais exposée par une route. */
export interface EffectiveRemoteDockerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  tls?: RemoteDockerTls;
}

export class RemoteDockerValidationError extends Error {}

let cache: StoredRemoteDockerEnvironment[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.remoteDocker.storePath);
}

async function readFromDisk(): Promise<StoredRemoteDockerEnvironment[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredRemoteDockerEnvironment[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: StoredRemoteDockerEnvironment[]): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<StoredRemoteDockerEnvironment[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

function toRef(env: StoredRemoteDockerEnvironment): RemoteDockerEnvironmentRef {
  return {
    id: env.id,
    name: env.name,
    host: env.host,
    port: env.port,
    hasTls: Boolean(env.tls?.ca || env.tls?.cert || env.tls?.key),
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}

function encryptTls(tls: RemoteDockerTls | undefined): RemoteDockerTls | undefined {
  if (!tls) return undefined;
  const encrypted: RemoteDockerTls = {
    ...(tls.ca ? { ca: encryptSecretIfNeeded(tls.ca) } : {}),
    ...(tls.cert ? { cert: encryptSecretIfNeeded(tls.cert) } : {}),
    ...(tls.key ? { key: encryptSecretIfNeeded(tls.key) } : {}),
  };
  return Object.keys(encrypted).length > 0 ? encrypted : undefined;
}

function decryptTls(tls: RemoteDockerTls | undefined): RemoteDockerTls | undefined {
  if (!tls) return undefined;
  return {
    ...(tls.ca ? { ca: decryptSecret(tls.ca) } : {}),
    ...(tls.cert ? { cert: decryptSecret(tls.cert) } : {}),
    ...(tls.key ? { key: decryptSecret(tls.key) } : {}),
  };
}

/** GET /api/remote-environments — jamais ca/cert/key, voir toRef(). */
export async function listRemoteDockerEnvironments(): Promise<RemoteDockerEnvironmentRef[]> {
  return (await getAll()).map(toRef);
}

export async function getRemoteDockerEnvironmentRef(id: string): Promise<RemoteDockerEnvironmentRef | undefined> {
  const found = (await getAll()).find((env) => env.id === id);
  return found ? toRef(found) : undefined;
}

export interface RemoteDockerEnvironmentInput {
  name: string;
  host: string;
  port: number;
  tls?: RemoteDockerTls;
}

/** Valide host/port avant toute écriture — rejet propre plutôt qu'une config invalide silencieusement persistée. */
function assertValidInput(input: RemoteDockerEnvironmentInput): void {
  if (!input.name.trim()) throw new RemoteDockerValidationError("name is required");
  if (!input.host.trim()) throw new RemoteDockerValidationError("host is required");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new RemoteDockerValidationError("port must be an integer between 1 and 65535");
  }
  const tls = input.tls;
  if (tls && (tls.cert || tls.key) && !(tls.cert && tls.key)) {
    throw new RemoteDockerValidationError("tls.cert and tls.key must be provided together");
  }
}

/** POST /api/remote-environments — admin uniquement (voir routes/remoteEnvironments.ts). */
export async function createRemoteDockerEnvironment(
  input: RemoteDockerEnvironmentInput,
): Promise<RemoteDockerEnvironmentRef> {
  assertValidInput(input);
  const all = await getAll();
  const now = new Date().toISOString();
  const encryptedTls = encryptTls(input.tls);
  const created: StoredRemoteDockerEnvironment = {
    id: randomUUID(),
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port,
    ...(encryptedTls ? { tls: encryptedTls } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const next = [...all, created];
  await writeToDisk(next);
  cache = next;
  return toRef(created);
}

export interface RemoteDockerEnvironmentPatch {
  name?: string;
  host?: string;
  port?: number;
  // tls omis = TLS conservé tel quel ; tls: {} explicite = supprime le TLS (repasse en TCP
  // non chiffré) ; tls avec ca/cert/key = remplace les champs fournis (mêmes conventions que
  // password/token dans setupStore.ts#updateRegistryAt — mais ici un objet vide est un choix
  // valide, contrairement à une chaîne vide qui n'exprime rien de propre pour un PEM).
  tls?: RemoteDockerTls;
  clearTls?: boolean;
}

/** PATCH /api/remote-environments/:id — admin uniquement. */
export async function updateRemoteDockerEnvironment(
  id: string,
  patch: RemoteDockerEnvironmentPatch,
): Promise<RemoteDockerEnvironmentRef | undefined> {
  const all = await getAll();
  const index = all.findIndex((env) => env.id === id);
  if (index === -1) return undefined;
  const existing = all[index]!;

  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  const nextHost = patch.host !== undefined ? patch.host.trim() : existing.host;
  const nextPort = patch.port !== undefined ? patch.port : existing.port;
  assertValidInput({ name: nextName, host: nextHost, port: nextPort, ...(patch.tls ? { tls: patch.tls } : {}) });

  const nextTls = patch.clearTls ? undefined : patch.tls ? encryptTls(patch.tls) : existing.tls;

  const updated: StoredRemoteDockerEnvironment = {
    id: existing.id,
    name: nextName,
    host: nextHost,
    port: nextPort,
    ...(nextTls ? { tls: nextTls } : {}),
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const next = all.map((env, i) => (i === index ? updated : env));
  await writeToDisk(next);
  cache = next;
  return toRef(updated);
}

/** DELETE /api/remote-environments/:id — admin uniquement. */
export async function deleteRemoteDockerEnvironment(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((env) => env.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}

/**
 * Config effective déchiffrée d'un environnement Docker distant — réservée à
 * services/docker.ts#getClient(remoteEnvironmentId). `undefined` si aucun environnement ne
 * porte cet id (jamais d'erreur ici : c'est à l'appelant de décider comment réagir).
 */
export async function getEffectiveRemoteDockerConfig(id: string): Promise<EffectiveRemoteDockerConfig | undefined> {
  const found = (await getAll()).find((env) => env.id === id);
  if (!found) return undefined;
  const tls = decryptTls(found.tls);
  return {
    id: found.id,
    name: found.name,
    host: found.host,
    port: found.port,
    ...(tls ? { tls } : {}),
  };
}
