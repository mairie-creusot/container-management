/**
 * Pool de connexions SSH pour les environnements Docker distants en transport "ssh" (voir
 * remoteDockerStore.ts, docker.ts#getClient) — équivalent programmatique de
 * `docker context create --docker host=ssh://user@host` : chaque requête HTTP émise par
 * docker-modem est tunnelée vers `docker system dial-stdio` exécuté côté hôte distant via SSH,
 * plutôt que de parler TCP+TLS en clair sur le réseau. Rien n'est exposé publiquement côté hôte
 * distant au-delà du port SSH déjà ouvert pour son administration — c'est précisément ce que
 * demande ce chantier (pas de démon Docker TCP exposé à l'extérieur).
 *
 * **Pourquoi ce module et pas simplement `protocol: "ssh"` de dockerode/docker-modem ?**
 * docker-modem sait nativement parler SSH (`docker-modem/lib/ssh.js`, vérifié dans ses sources)
 * mais y ouvre une CONNEXION SSH COMPLÈTE (handshake TCP + négociation + authentification) À
 * CHAQUE appel HTTP — `new Client().connect(opt)` à chaque `buildRequest`. Inutilisable en
 * pratique dès qu'une page charge plusieurs conteneurs : une connexion pour `listContainers()`,
 * une par `stats()` par conteneur, une par `inspect()` (santé)... Ce module maintient à la place
 * UNE connexion `ssh2.Client` persistante par environnement — le protocole SSH multiplexe
 * nativement plusieurs canaux sur une même connexion TCP, donc chaque requête HTTP docker-modem
 * ouvre juste un nouveau canal `exec` sur la connexion déjà établie et prête, jamais une nouvelle
 * négociation SSH complète.
 *
 * **Cycle de vie / pool** : une connexion par `environmentId`, conservée tant qu'elle est
 * utilisée. Une passe périodique (SWEEP_INTERVAL_MS) ferme toute connexion inactive depuis plus
 * de SSH_IDLE_TTL_MS — pour ne jamais laisser une session SSH ouverte indéfiniment sur un
 * environnement qu'on a cessé de consulter. `invalidateSshConnection` permet en plus à
 * remoteDockerStore.ts de fermer immédiatement une connexion dont les identifiants viennent de
 * changer ou d'être supprimés (voir update/delete), plutôt que d'attendre l'expiration.
 *
 * **Vérification de l'empreinte de l'hôte** : ssh2, comme docker-modem/lib/ssh.js, accepte par
 * défaut la clé de n'importe quel hôte (pas de `hostVerifier` fourni ici) — même niveau de
 * confiance que le support SSH natif de docker-modem, pas moins. Un `hostVerifier` pourrait être
 * ajouté plus tard si QUAI persiste un fingerprint attendu par environnement.
 */

import { Client as SshClient, type ClientChannel } from "ssh2";
import http from "node:http";
import type { Duplex } from "node:stream";

const SSH_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes d'inactivité avant fermeture de la connexion SSH.
const SSH_READY_TIMEOUT_MS = 10_000; // délai de négociation/authentification avant abandon.
const SWEEP_INTERVAL_MS = 60_000;

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

interface PooledConnection {
  client: SshClient;
  /** Résolue une fois le handshake+auth SSH terminés ("ready"), rejetée si la connexion échoue. */
  ready: Promise<void>;
  lastUsedAt: number;
  closed: boolean;
}

const pool = new Map<string, PooledConnection>();
let sweepTimer: NodeJS.Timeout | undefined;

function ensureSweepRunning(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [environmentId, entry] of pool) {
      if (now - entry.lastUsedAt > SSH_IDLE_TTL_MS) {
        pool.delete(environmentId);
        entry.closed = true;
        entry.client.end();
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Ne doit jamais empêcher le process de sortir (tests, arrêt normal du serveur).
  sweepTimer.unref();
}

function openConnection(config: SshConnectionConfig): PooledConnection {
  const client = new SshClient();
  const entry: PooledConnection = {
    client,
    lastUsedAt: Date.now(),
    closed: false,
    ready: new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
    }),
  };
  // Filet de sécurité : si aucun appelant n'est encore en attente de `entry.ready` au moment où
  // la connexion échoue (course rare), évite un unhandledRejection process-wide — chaque
  // appelant de getSshDockerAgent observe l'échec via son propre .catch sur cette même promesse.
  entry.ready.catch(() => {});
  client.on("close", () => {
    entry.closed = true;
  });
  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    ...(config.password !== undefined ? { password: config.password } : {}),
    ...(config.privateKey !== undefined ? { privateKey: config.privateKey } : {}),
    readyTimeout: SSH_READY_TIMEOUT_MS,
  });
  return entry;
}

function getOrCreateConnection(environmentId: string, config: SshConnectionConfig): PooledConnection {
  const existing = pool.get(environmentId);
  if (existing && !existing.closed) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const entry = openConnection(config);
  pool.set(environmentId, entry);
  ensureSweepRunning();
  return entry;
}

/**
 * Ferme (si ouverte) et retire du pool la connexion SSH d'un environnement — à appeler quand sa
 * config est modifiée ou supprimée (remoteDockerStore.ts) pour ne jamais laisser une requête
 * suivante réutiliser une session ouverte avec des identifiants qui viennent de changer ou de
 * disparaître. Sans effet si aucune connexion n'est actuellement poolée pour cet id.
 */
export function invalidateSshConnection(environmentId: string): void {
  const entry = pool.get(environmentId);
  if (!entry) return;
  pool.delete(environmentId);
  entry.closed = true;
  try {
    entry.client.end();
  } catch {
    // déjà fermée : rien à faire.
  }
}

/**
 * `http.Agent` branché sur la connexion SSH poolée de cet environnement — chaque requête HTTP
 * émise par docker-modem obtient un nouveau canal `exec` (`docker system dial-stdio`, la même
 * commande que le CLI Docker utilise pour un contexte `ssh://`) sur la connexion SSH partagée,
 * jamais une nouvelle connexion TCP+SSH. Voir docker.ts#buildRemoteDockerClient (seul appelant).
 */
export function getSshDockerAgent(environmentId: string, config: SshConnectionConfig): http.Agent {
  const agent = new http.Agent();
  agent.createConnection = (_options, callback) => {
    // `stream.Duplex` est non-optionnel dans la signature du callback même pour le cas erreur
    // (type Node — voir @types/node/http.d.ts) : aucun flux n'existe alors réellement, ce cast
    // est le seul moyen de satisfaire ce type sans fabriquer un faux Duplex inerte. Même
    // approche que les casts `any` déjà présents ailleurs dans docker.ts quand un type tiers ne
    // reflète pas fidèlement le runtime.
    const noStream = undefined as unknown as Duplex;
    const entry = getOrCreateConnection(environmentId, config);
    entry.ready
      .then(() => {
        entry.lastUsedAt = Date.now();
        entry.client.exec("docker system dial-stdio", (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            callback?.(err, noStream);
            return;
          }
          entry.lastUsedAt = Date.now();
          callback?.(null, stream);
        });
      })
      .catch((err: Error) => {
        // La connexion SSH elle-même a échoué (auth refusée, hôte injoignable, timeout...) : on
        // la retire du pool pour qu'un prochain appel en retente une neuve plutôt que de rester
        // bloqué indéfiniment sur une connexion morte.
        pool.delete(environmentId);
        callback?.(err, noStream);
      });
    return undefined;
  };
  return agent;
}
