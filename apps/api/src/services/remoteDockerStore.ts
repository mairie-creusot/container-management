/**
 * Environnements Docker distants persistés (cf. ARCHITECTURE.md, chapitre "Environnements
 * Docker distants") — liste nommée d'hôtes Docker distants, en plus du démon local piloté par
 * défaut (services/docker.ts#getClient sans argument). Deux modes de transport vers ce démon
 * distant, choisis par environnement :
 *
 * - `"tcp-tls"` (historique) : le démon Docker distant expose son API sur le réseau via TCP+TLS
 *   (host/port du démon, ca/cert/key client).
 * - `"ssh"` : AUCUN port Docker n'est exposé sur le réseau — QUAI se connecte au port SSH déjà
 *   ouvert pour l'administration de la machine (host/port SSH, identifiants), puis tunnelise le
 *   protocole Docker au travers (voir docker.ts#buildRemoteDockerClient, services/sshTunnel.ts).
 *   C'est le mode recommandé pour un hôte qui n'a pas vocation à exposer Docker publiquement
 *   (ex : un VPS joignable uniquement en SSH).
 *
 * Même pattern que secretsStore.ts : persistance JSON sur disque (REMOTE_DOCKER_PATH, défaut
 * ./data/remote-docker.json), cache mémoire process invalidé à chaque écriture, fichier écrit
 * avec des permissions restrictives (0600).
 *
 * Transport "tcp-tls" : dockerode/docker-modem acceptent `host`/`port`/`ca`/`cert`/`key`
 * directement dans leur constructeur pour une connexion TCP+TLS à un démon distant (voir
 * docker.ts#getClient) — c'est la méthode standard documentée par Docker Engine pour exposer un
 * démon sur le réseau (https://docs.docker.com/engine/security/protect-access/). `ca`/`cert`/
 * `key` (PEM) sont chiffrés au repos (AES-256-GCM, crypto.ts) champ par champ, comme le mot de
 * passe LDAP/le kubeconfig/les identifiants de registry dans setupStore.ts.
 *
 * Transport "ssh" : `password`/`privateKey` (l'un des deux au moins) chiffrés au repos exactement
 * de la même façon — `username` n'est pas un secret, non chiffré (comme `host`/`port`/`name`).
 *
 * Dans tous les cas le fichier ne contient jamais de secret en clair, et aucune route GET ne
 * renvoie jamais ca/cert/key/password/privateKey (write-only, voir toRef ci-dessous).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { invalidateSshConnection } from "./sshTunnel.js";

export type RemoteDockerTransport = "tcp-tls" | "ssh";

export interface RemoteDockerTls {
  ca?: string;
  cert?: string;
  key?: string;
}

/** Identifiants SSH — `password` OU `privateKey` (l'un des deux au moins), chiffrés au repos comme ca/cert/key. */
export interface RemoteDockerSsh {
  username: string;
  password?: string;
  privateKey?: string;
}

interface StoredRemoteDockerEnvironment {
  id: string;
  name: string;
  host: string;
  port: number;
  // Absent sur les environnements créés avant l'introduction du transport SSH : traité comme
  // "tcp-tls" partout où ce champ est lu (toRef, getEffectiveRemoteDockerConfig...) — migration
  // transparente, aucun script de backfill nécessaire.
  transport?: RemoteDockerTransport;
  // ca/cert/key : chiffrés au repos (voir crypto.ts) quand présents. Pertinent uniquement pour transport "tcp-tls".
  tls?: RemoteDockerTls;
  // password/privateKey : chiffrés au repos. Pertinent uniquement pour transport "ssh".
  ssh?: RemoteDockerSsh;
  createdAt: string;
  updatedAt: string;
}

/** Vue publique — ne contient JAMAIS le contenu ca/cert/key/password/privateKey (voir toRef ci-dessous). */
export interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  transport: RemoteDockerTransport;
  hasTls: boolean;
  /** Présent uniquement pour transport "ssh" — le login n'est pas un secret. */
  sshUsername?: string;
  hasSshCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Config effective (déchiffrée) — réservée à un usage serveur (docker.ts#getClient), jamais exposée par une route. */
export interface EffectiveRemoteDockerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  transport: RemoteDockerTransport;
  tls?: RemoteDockerTls;
  ssh?: RemoteDockerSsh;
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
    transport: env.transport ?? "tcp-tls",
    hasTls: Boolean(env.tls?.ca || env.tls?.cert || env.tls?.key),
    ...(env.ssh?.username ? { sshUsername: env.ssh.username } : {}),
    hasSshCredentials: Boolean(env.ssh?.password || env.ssh?.privateKey),
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

function encryptSsh(ssh: RemoteDockerSsh | undefined): RemoteDockerSsh | undefined {
  if (!ssh || !ssh.username?.trim()) return undefined;
  return {
    username: ssh.username.trim(),
    ...(ssh.password ? { password: encryptSecretIfNeeded(ssh.password) } : {}),
    ...(ssh.privateKey ? { privateKey: encryptSecretIfNeeded(ssh.privateKey) } : {}),
  };
}

function decryptSsh(ssh: RemoteDockerSsh | undefined): RemoteDockerSsh | undefined {
  if (!ssh) return undefined;
  return {
    username: ssh.username,
    ...(ssh.password ? { password: decryptSecret(ssh.password) } : {}),
    ...(ssh.privateKey ? { privateKey: decryptSecret(ssh.privateKey) } : {}),
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
  // Optionnel : défaut 22 pour transport "ssh" (résolu dans createRemoteDockerEnvironment).
  // Requis pour transport "tcp-tls" (pas de port Docker par défaut sensé).
  port?: number;
  // Défaut "tcp-tls" si omis — comportement historique inchangé pour tout appelant qui ne
  // précise pas ce champ.
  transport?: RemoteDockerTransport;
  tls?: RemoteDockerTls;
  ssh?: RemoteDockerSsh;
}

/** Valide name/host/port/transport et les identifiants du transport choisi avant toute écriture. */
function assertValidInput(input: RemoteDockerEnvironmentInput): void {
  if (!input.name.trim()) throw new RemoteDockerValidationError("name is required");
  if (!input.host.trim()) throw new RemoteDockerValidationError("host is required");

  const transport = input.transport ?? "tcp-tls";
  if (transport !== "tcp-tls" && transport !== "ssh") {
    throw new RemoteDockerValidationError('transport must be "tcp-tls" or "ssh"');
  }

  const port = input.port ?? (transport === "ssh" ? 22 : undefined);
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RemoteDockerValidationError("port must be an integer between 1 and 65535");
  }

  if (transport === "tcp-tls") {
    const tls = input.tls;
    if (tls && (tls.cert || tls.key) && !(tls.cert && tls.key)) {
      throw new RemoteDockerValidationError("tls.cert and tls.key must be provided together");
    }
  } else {
    const ssh = input.ssh;
    if (!ssh || !ssh.username?.trim()) {
      throw new RemoteDockerValidationError('ssh.username is required for transport "ssh"');
    }
    if (!ssh.password && !ssh.privateKey) {
      throw new RemoteDockerValidationError('ssh.password or ssh.privateKey is required for transport "ssh"');
    }
  }
}

/** POST /api/remote-environments — admin uniquement (voir routes/remoteEnvironments.ts). */
export async function createRemoteDockerEnvironment(
  input: RemoteDockerEnvironmentInput,
): Promise<RemoteDockerEnvironmentRef> {
  assertValidInput(input);
  const all = await getAll();
  const now = new Date().toISOString();
  const transport = input.transport ?? "tcp-tls";
  const port = input.port ?? 22; // n'est atteint pour "tcp-tls" que si input.port était défini (validé ci-dessus).
  const encryptedTls = transport === "tcp-tls" ? encryptTls(input.tls) : undefined;
  const encryptedSsh = transport === "ssh" ? encryptSsh(input.ssh) : undefined;
  const created: StoredRemoteDockerEnvironment = {
    id: randomUUID(),
    name: input.name.trim(),
    host: input.host.trim(),
    port,
    transport,
    ...(encryptedTls ? { tls: encryptedTls } : {}),
    ...(encryptedSsh ? { ssh: encryptedSsh } : {}),
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
  // transport omis = transport conservé tel quel. Changer de transport droppe TOUJOURS les
  // identifiants de l'ancien transport (ils n'ont plus de sens une fois le mode changé) — de
  // nouveaux identifiants tls/ssh adaptés au nouveau transport sont alors requis dans le même patch.
  transport?: RemoteDockerTransport;
  // tls omis = TLS conservé tel quel ; tls: {} explicite = supprime le TLS (repasse en TCP
  // non chiffré) ; tls avec ca/cert/key = remplace les champs fournis (mêmes conventions que
  // password/token dans setupStore.ts#updateRegistryAt — mais ici un objet vide est un choix
  // valide, contrairement à une chaîne vide qui n'exprime rien de propre pour un PEM).
  tls?: RemoteDockerTls;
  clearTls?: boolean;
  // ssh omis = identifiants SSH conservés tels quels ; ssh fourni = remplace username/password/
  // privateKey ; clearSsh = supprime les identifiants SSH persistés (repasse "sans identifiants",
  // invalide tant que transport reste "ssh" — voir assertValidInput).
  ssh?: RemoteDockerSsh;
  clearSsh?: boolean;
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
  const nextTransport: RemoteDockerTransport = patch.transport ?? existing.transport ?? "tcp-tls";

  // Ne réutilise les identifiants existants pour la validation que si le transport ne change
  // pas — changer de transport sans fournir de nouveaux identifiants doit échouer proprement
  // (assertValidInput) plutôt que de faire semblant que d'anciens identifiants TLS valident un
  // nouveau transport SSH (ou l'inverse).
  const tlsForValidation =
    nextTransport !== "tcp-tls" ? undefined : patch.clearTls ? undefined : (patch.tls ?? existing.tls);
  const sshForValidation =
    nextTransport !== "ssh" ? undefined : patch.clearSsh ? undefined : (patch.ssh ?? existing.ssh);

  assertValidInput({
    name: nextName,
    host: nextHost,
    port: nextPort,
    transport: nextTransport,
    ...(tlsForValidation ? { tls: tlsForValidation } : {}),
    ...(sshForValidation ? { ssh: sshForValidation } : {}),
  });

  const nextTls =
    nextTransport !== "tcp-tls" ? undefined : patch.clearTls ? undefined : patch.tls ? encryptTls(patch.tls) : existing.tls;
  const nextSsh =
    nextTransport !== "ssh" ? undefined : patch.clearSsh ? undefined : patch.ssh ? encryptSsh(patch.ssh) : existing.ssh;

  const updated: StoredRemoteDockerEnvironment = {
    id: existing.id,
    name: nextName,
    host: nextHost,
    port: nextPort,
    transport: nextTransport,
    ...(nextTls ? { tls: nextTls } : {}),
    ...(nextSsh ? { ssh: nextSsh } : {}),
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const next = all.map((env, i) => (i === index ? updated : env));
  await writeToDisk(next);
  cache = next;
  // Les identifiants viennent potentiellement de changer (ou le transport a changé) : ne jamais
  // laisser une éventuelle connexion SSH poolée (services/sshTunnel.ts) survivre avec d'anciens
  // identifiants jusqu'à son expiration naturelle.
  invalidateSshConnection(id);
  return toRef(updated);
}

/** DELETE /api/remote-environments/:id — admin uniquement. */
export async function deleteRemoteDockerEnvironment(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((env) => env.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  // Plus aucune config ne justifie de garder une connexion SSH poolée ouverte pour cet id.
  invalidateSshConnection(id);
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
  const transport: RemoteDockerTransport = found.transport ?? "tcp-tls";
  const tls = transport === "tcp-tls" ? decryptTls(found.tls) : undefined;
  const ssh = transport === "ssh" ? decryptSsh(found.ssh) : undefined;
  return {
    id: found.id,
    name: found.name,
    host: found.host,
    port: found.port,
    transport,
    ...(tls ? { tls } : {}),
    ...(ssh ? { ssh } : {}),
  };
}
