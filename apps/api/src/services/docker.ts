/**
 * Intégration Docker Engine / Swarm via dockerode.
 *
 * IMPORTANT — repli de développement : si le démon Docker n'est pas joignable (pas de
 * DOCKER_HOST configuré et pas de socket par défaut disponible, timeout, erreur réseau...),
 * ce module retombe proprement sur le jeu de données de démonstration en mémoire
 * (src/services/demoData.ts). Ce n'est PAS un mock permanent : dès qu'un démon Docker
 * répond, les données réelles sont utilisées.
 */

import Docker from "dockerode";
import type { ContainerInfo } from "dockerode";
import type http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { demoStore } from "./demoData.js";
import { getEffectiveDockerConfig } from "./setupStore.js";
import { getEffectiveRemoteDockerConfig, getRemoteDockerEnvironmentRef } from "./remoteDockerStore.js";
import type { EffectiveRemoteDockerConfig } from "./remoteDockerStore.js";
import { getSshDockerAgent } from "./sshTunnel.js";
import { withTimeout } from "../utils/async.js";
import type {
  ClusterNode,
  ContainerDetail,
  ContainerMount,
  ContainerPortMapping,
  ContainerProcessList,
  ContainerRef,
  DockerHostInfo,
  DockerNetwork,
  DockerVolume,
  Environment,
  ImageHistoryLayer,
  VolumeFileEntry,
} from "../types.js";

const PING_TIMEOUT_MS = 2000;
const STATS_TIMEOUT_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;

function buildDockerClient(host: string | undefined): Docker {
  if (host) {
    // dockerode/docker-modem parses host/port/protocol from a DOCKER_HOST-style URL when
    // passed explicitly; simplest robust path is to set it on process.env for the duration
    // of the client construction and let the Docker constructor read it (it does not persist
    // this globally — the previous value, if any, is restored right after).
    const previousHost = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = host;
    try {
      return new Docker();
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
    }
  }
  if (process.platform === "win32") {
    return new Docker({ socketPath: "//./pipe/docker_engine" });
  }
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/**
 * @types/dockerode ne déclare pas `agent` dans `DockerOptions` alors que docker-modem
 * (lib/modem.js — vérifié dans ses sources : `if (this.agent) optionsf.agent = this.agent;`) le
 * lit bel et bien au runtime, quel que soit `protocol`. C'est exactement le mécanisme utilisé
 * ici pour le transport SSH poolé (voir services/sshTunnel.ts) : extension locale du type
 * officiel plutôt qu'un `any` complet, pour garder le reste de l'objet vérifié normalement.
 */
type DockerOptionsWithAgent = Docker.DockerOptions & { agent?: http.Agent };

/**
 * Client vers un démon Docker distant persisté (services/remoteDockerStore.ts) — deux transports :
 *
 * - "tcp-tls" : dockerode/docker-modem acceptent `host`/`port`/`ca`/`cert`/`key` directement dans
 *   leur constructeur, c'est LA méthode standard pour joindre un démon Docker exposé sur le
 *   réseau (https://docs.docker.com/engine/security/protect-access/). Sans `tls`, connexion TCP
 *   en clair (déploiement de test uniquement — voir ARCHITECTURE.md). `protocol: "https"` est
 *   fixé EXPLICITEMENT dès que cert+key sont fournis : docker-modem (lib/modem.js) ne bascule en
 *   https tout seul que si `ca` ET `cert` ET `key` sont TOUS LES TROIS présents (vérifié dans ses
 *   sources) — un déploiement avec seulement cert+key (CA système déjà approuvée, cas courant)
 *   retomberait sinon silencieusement en HTTP en clair.
 * - "ssh" : AUCUNE connexion TCP directe vers un port Docker — le trafic Docker est tunnelé au
 *   travers d'une connexion SSH poolée (services/sshTunnel.ts#getSshDockerAgent, même mécanisme
 *   que `docker context create --docker host=ssh://user@host` : chaque requête HTTP obtient un
 *   canal `exec` "docker system dial-stdio" sur cette connexion). `host`/`port` passés à `Docker`
 *   ici sont ceux du serveur SSH (pas d'un démon Docker TCP) : docker-modem s'en sert uniquement
 *   pour construire l'adresse nominale de ses requêtes HTTP, jamais pour ouvrir de socket lui-même
 *   puisque `agent.createConnection` court-circuite totalement la connexion réseau réelle.
 */
function buildRemoteDockerClient(remote: EffectiveRemoteDockerConfig): Docker {
  if (remote.transport === "ssh") {
    if (!remote.ssh) {
      throw new Error(`Remote Docker environment "${remote.id}" has transport "ssh" but no SSH credentials configured`);
    }
    const agent = getSshDockerAgent(remote.id, {
      host: remote.host,
      port: remote.port,
      username: remote.ssh.username,
      ...(remote.ssh.password ? { password: remote.ssh.password } : {}),
      ...(remote.ssh.privateKey ? { privateKey: remote.ssh.privateKey } : {}),
    });
    const options: DockerOptionsWithAgent = { host: remote.host, port: remote.port, protocol: "http", agent };
    return new Docker(options);
  }

  const hasTls = Boolean(remote.tls?.ca || remote.tls?.cert || remote.tls?.key);
  return new Docker({
    host: remote.host,
    port: remote.port,
    ...(remote.tls?.ca ? { ca: remote.tls.ca } : {}),
    ...(remote.tls?.cert ? { cert: remote.tls.cert } : {}),
    ...(remote.tls?.key ? { key: remote.tls.key } : {}),
    ...(hasTls ? { protocol: "https" as const } : {}),
  });
}

/**
 * Construit un client à partir de la config effective (assistant si persisté, sinon
 * DOCKER_HOST). Pas de cache : dockerode ne maintient pas de connexion persistante tant
 * qu'on n'appelle pas de méthode, donc reconstruire le client à chaque appel est bon marché
 * et évite d'avoir à invalider un cache quand la config change (via l'assistant, un reset...).
 *
 * `remoteEnvironmentId` (optionnel, cf. ARCHITECTURE.md § "Environnements Docker distants") :
 * quand fourni, résout à la place un client vers CET hôte distant persisté (voir
 * remoteDockerStore.ts) — TCP+TLS ou SSH selon son `transport` (voir buildRemoteDockerClient
 * ci-dessus) — le démon local n'est alors jamais contacté. Omis (comportement
 * historique, INCHANGÉ) : résout toujours le démon local/DOCKER_HOST comme avant. Lève si l'id
 * ne correspond à aucun environnement distant persisté (l'appelant — une route — traduit en 404,
 * jamais un 502 "injoignable" trompeur pour un id qui n'existe simplement pas).
 */
export async function getClient(remoteEnvironmentId?: string): Promise<Docker> {
  if (remoteEnvironmentId) {
    const remote = await getEffectiveRemoteDockerConfig(remoteEnvironmentId);
    if (!remote) {
      throw new Error(`Remote Docker environment "${remoteEnvironmentId}" not found`);
    }
    return buildRemoteDockerClient(remote);
  }
  const effective = await getEffectiveDockerConfig();
  return buildDockerClient(effective.host);
}

export async function isDockerReachable(docker: Docker): Promise<boolean> {
  try {
    await withTimeout(docker.ping(), PING_TIMEOUT_MS, "docker ping");
    return true;
  } catch {
    return false;
  }
}

/**
 * Utilisé par l'assistant de configuration (POST /api/setup/test/docker) : teste un hôte
 * Docker candidat (pas encore persisté) sans jamais modifier l'état applicatif ni le
 * client (reconstruit à chaque appel, voir getClient()).
 */
export async function testDockerConnection(host?: string): Promise<{ ok: boolean; message: string }> {
  const previousHost = process.env.DOCKER_HOST;
  try {
    if (host) process.env.DOCKER_HOST = host;
    else delete process.env.DOCKER_HOST;

    const candidateClient =
      host || process.platform !== "win32"
        ? new Docker()
        : new Docker({ socketPath: "//./pipe/docker_engine" });

    const reachable = await isDockerReachable(candidateClient);
    return reachable
      ? { ok: true, message: "Docker daemon is reachable" }
      : { ok: false, message: "Docker daemon did not respond (ping timed out or connection refused)" };
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
}

export interface LocalDockerImage {
  /** Id de couche Docker (sha256:...) — plusieurs tags peuvent partager le même id. */
  id: string;
  /** Nom du repo sans le tag, ex: "nginx", "ghcr.io/ville-lecreusot/portail-citoyen". */
  name: string;
  tag: string;
  digest: string;
  sizeBytes: number;
}

/**
 * Images Docker réellement présentes sur l'hôte (équivalent de `docker images`) — PAS le
 * jeu de démonstration. Utilisé par src/services/images.ts pour bâtir la liste "Images" à
 * partir de ce qui est vraiment sur la machine plutôt que d'un jeu figé.
 */
export async function getLocalDockerImages(): Promise<LocalDockerImage[]> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) return [];

  try {
    const images = await docker.listImages();
    const results: LocalDockerImage[] = [];
    for (const image of images) {
      const repoTags = (image.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
      if (repoTags.length === 0) continue; // couches intermédiaires/sans tag : pas des images "suivables"
      for (const repoTag of repoTags) {
        const separator = repoTag.lastIndexOf(":");
        results.push({
          id: image.Id,
          name: repoTag.slice(0, separator),
          tag: repoTag.slice(separator + 1),
          digest: image.RepoDigests?.[0] ?? image.Id,
          sizeBytes: image.Size,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Tire une image depuis son registry (équivalent `docker pull`), en suivant le flux de
 * progression jusqu'à la fin. Lève une erreur explicite si le démon Docker n'est pas
 * joignable ou si le pull échoue (tag inexistant, dépôt privé sans authentification...).
 */
export async function pullImage(reference: string): Promise<void> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    throw new Error("Docker daemon is not reachable");
  }

  await new Promise<void>((resolve, reject) => {
    docker.pull(reference, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        reject(err ?? new Error("docker.pull returned no stream"));
        return;
      }
      docker.modem.followProgress(stream, (progressErr: Error | null) => {
        if (progressErr) reject(progressErr);
        else resolve();
      });
    });
  });
}

/**
 * Supprime une image locale (équivalent `docker rmi <reference>`). `reference` peut être un
 * "repo:tag" ou un ID d'image. Lève si un conteneur (même arrêté) l'utilise encore, sauf
 * `force: true`.
 */
export async function removeDockerImage(reference: string, force = false): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getImage(reference).remove({ force });
}

export interface CreateContainerOptions {
  image: string;
  /** Optionnel : nom Docker (lettres/chiffres/./-/_) ; laissé à Docker (nom aléatoire) si omis. */
  name?: string;
  /** Mappings de ports façon CLI, ex: ["8080:80", "127.0.0.1:5432:5432/tcp"]. */
  ports?: string[];
  /** Variables d'environnement façon CLI, ex: ["POSTGRES_PASSWORD=secret"]. */
  env?: string[];
  /** Montages façon `docker run -v`, ex: ["pgdata:/var/lib/postgresql/data", "/host/path:/container/path:ro"]. */
  volumes?: string[];
  /** Réseau Docker à attacher (doit déjà exister — voir createNetwork ci-dessous) ; par défaut "bridge". */
  network?: string;
  /** Limite mémoire (`HostConfig.Memory`, en octets) — équivalent `docker run --memory`. Absent =
   * pas de limite (comportement Docker natif inchangé), jamais de valeur par défaut fabriquée ici :
   * la validation (borne min/max raisonnable) est faite côté route (routes/containers.ts), ce
   * module se contente de la transmettre telle quelle à Docker. */
  memoryLimitBytes?: number;
  /** Limite CPU (`HostConfig.NanoCpus`, en milliardièmes de cœur — ex: 500000000 = 0.5 cœur) —
   * équivalent `docker run --cpus`. Mêmes règles que memoryLimitBytes ci-dessus. */
  nanoCpus?: number;
}

/** Parse un mapping de port façon `docker run -p` : [host_ip:]host_port:container_port[/proto]. */
function parsePortMapping(mapping: string): { hostIp?: string; hostPort: string; containerPort: string; proto: string } {
  const [portsPart, proto = "tcp"] = mapping.split("/");
  const segments = portsPart!.split(":");
  if (segments.length === 2) {
    return { hostPort: segments[0]!, containerPort: segments[1]!, proto };
  }
  if (segments.length === 3) {
    return { hostIp: segments[0]!, hostPort: segments[1]!, containerPort: segments[2]!, proto };
  }
  throw new Error(`Invalid port mapping "${mapping}" (expected "host:container" or "ip:host:container")`);
}

/**
 * Parse un montage façon `docker run -v source:target[:ro]`. `source` est soit un nom de
 * volume Docker nommé, soit un chemin hôte absolu (bind mount) — dockerode/l'API Engine ne
 * distinguent pas les deux dans `HostConfig.Binds`, le démon tranche lui-même à la création.
 */
function parseVolumeMapping(mapping: string): { source: string; target: string; readOnly: boolean } {
  const segments = mapping.split(":");
  if (segments.length < 2 || segments.length > 3) {
    throw new Error(`Invalid volume mapping "${mapping}" (expected "source:target" or "source:target:ro")`);
  }
  const [source, target, mode] = segments;
  return { source: source!, target: target!, readOnly: mode === "ro" };
}

/**
 * Crée puis démarre un conteneur (équivalent `docker run -d [--name] [-p ...] <image>`).
 * L'image doit déjà être présente localement (faire un pull d'abord si besoin — voir pullImage
 * ci-dessus) ; dockerode ne la tire pas automatiquement.
 */
export async function createAndStartContainer(options: CreateContainerOptions): Promise<{ id: string }> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    throw new Error("Docker daemon is not reachable");
  }

  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
  for (const mapping of options.ports ?? []) {
    const { hostIp, hostPort, containerPort, proto } = parsePortMapping(mapping);
    const key = `${containerPort}/${proto}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ ...(hostIp ? { HostIp: hostIp } : {}), HostPort: hostPort }];
  }

  const binds = (options.volumes ?? []).map((mapping) => {
    const { source, target, readOnly } = parseVolumeMapping(mapping);
    return `${source}:${target}${readOnly ? ":ro" : ""}`;
  });

  const container = await docker.createContainer({
    Image: options.image,
    ...(options.name ? { name: options.name } : {}),
    ...(options.env && options.env.length > 0 ? { Env: options.env } : {}),
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      NetworkMode: options.network || "bridge",
      ...(options.memoryLimitBytes !== undefined ? { Memory: options.memoryLimitBytes } : {}),
      ...(options.nanoCpus !== undefined ? { NanoCpus: options.nanoCpus } : {}),
    },
  });
  await container.start();
  return { id: container.id };
}

export interface ContainerUsage {
  cpuPercent: number;
  memBytes: number;
  /** Cumul RÉEL (compteur croissant depuis le démarrage du conteneur, jamais un débit calculé —
   * voir metricsCollector.ts qui, lui, dérive un débit entre deux points) toutes interfaces
   * réseau confondues (`stats.networks`, même snapshot que CPU/mémoire ci-dessus, aucun appel
   * Docker supplémentaire). Absent (jamais 0 par convention) si le conteneur utilise
   * `network_mode: host` (Docker ne rapporte alors aucune interface propre dans `networks`).
   */
  netRxBytes?: number;
  netTxBytes?: number;
  /** Cumul RÉEL lecture/écriture bloc (`stats.blkio_stats.io_service_bytes_recursive`, même
   * snapshot) — de l'E/S disque réelle, PAS un espace disque total utilisé (Docker n'expose pas
   * cette dernière notion dans `stats()`, seulement via un calcul de taille de répertoire coûteux
   * hors périmètre ici) : jamais présenté comme "espace disque" côté UI, toujours "E/S disque".
   * Absent si le pilote de stockage ne remonte pas cette catégorie (dépend du storage driver).
   */
  blkReadBytes?: number;
  blkWriteBytes?: number;
}

/**
 * Calcule un instantané d'utilisation à partir d'un snapshot unique de `docker stats` — exporté
 * pour être réutilisé par services/topology.ts (cpuPercent/memBytes affichés sur le nœud du
 * graphe) ET services/metricsCollector.ts (persistance de la série temporelle complète), en plus
 * de son usage interne à ce module.
 */
export async function readContainerUsage(docker: Docker, containerId: string): Promise<ContainerUsage> {
  try {
    const container = docker.getContainer(containerId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats: any = await withTimeout(container.stats({ stream: false }), STATS_TIMEOUT_MS, "docker stats");

    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus: number = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
    const memBytes: number = stats.memory_stats?.usage ?? 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const networks: Record<string, any> | undefined = stats.networks;
    let net: { netRxBytes: number; netTxBytes: number } | undefined;
    if (networks && Object.keys(networks).length > 0) {
      net = { netRxBytes: 0, netTxBytes: 0 };
      for (const iface of Object.values(networks)) {
        net.netRxBytes += iface.rx_bytes ?? 0;
        net.netTxBytes += iface.tx_bytes ?? 0;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blkEntries: any[] | undefined = stats.blkio_stats?.io_service_bytes_recursive;
    let blk: { blkReadBytes: number; blkWriteBytes: number } | undefined;
    if (Array.isArray(blkEntries) && blkEntries.length > 0) {
      blk = { blkReadBytes: 0, blkWriteBytes: 0 };
      for (const entry of blkEntries) {
        if (entry.op === "read" || entry.op === "Read") blk.blkReadBytes += entry.value ?? 0;
        else if (entry.op === "write" || entry.op === "Write") blk.blkWriteBytes += entry.value ?? 0;
      }
    }

    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memBytes,
      ...(net ? net : {}),
      ...(blk ? blk : {}),
    };
  } catch {
    return { cpuPercent: 0, memBytes: 0 };
  }
}

/**
 * État de santé Docker NATIF d'un conteneur — reflète `State.Health.Status` tel que calculé par
 * le démon lui-même à partir de l'instruction `HEALTHCHECK` définie (ou non) dans son image
 * (ex: image basée sur `curl -f http://localhost/health`, `pg_isready`...). "none" signifie
 * honnêtement "cette image ne définit aucun HEALTHCHECK" — CE N'EST PAS un échec, la grande
 * majorité des images de ce host n'en définissent probablement aucune : on ne fabrique jamais
 * "healthy"/"unhealthy" par convention (deviner un port/chemin "/health") faute de signal réel.
 * Nécessite un `inspect()` par conteneur (le résumé `listContainers` n'expose que `Status`, une
 * chaîne texte comme "Up 2 minutes (healthy)" — pas de champ structuré) : appel séparé de
 * `readContainerUsage` ci-dessus (qui interroge `stats()`, pas `inspect()`), donc pas de requête
 * réseau redondante entre les deux, seulement un appel de plus, en parallèle par conteneur comme
 * les stats (voir services/topology.ts).
 */
export type ContainerHealthStatus = "healthy" | "unhealthy" | "starting" | "none";

export interface ContainerHealthAndLimits {
  healthStatus: ContainerHealthStatus;
  /** Limites RÉELLEMENT configurées (`HostConfig.Memory`/`HostConfig.NanoCpus`, mêmes champs que
   * ContainerDetail#memoryLimitBytes/nanoCpus, voir routes/containers.ts) — lues sur CE MÊME
   * inspect() plutôt qu'un appel séparé : services/topology.ts en a besoin sur le TopologyNode
   * pour la carte flottante d'alerte "Mémoire élevée" (façon Railway), qui — comme l'alerte CPU
   * déjà existante — ne se déclenche QUE si une limite RÉELLE existe (jamais un seuil absolu
   * inventé en son absence, voir topologyGraphShared.tsx). 0/absent côté Docker = "pas de
   * limite" : jamais traduit en 0 ici, reste absent.
   */
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

/** Un seul `inspect()` par conteneur, réutilisé pour DEUX besoins (santé + limites réelles) —
 * jamais deux appels réseau séparés pour la même information déjà disponible sur la même réponse.
 * Repli honnête `{healthStatus: "none"}` en cas d'échec (conteneur disparu entre deux appels,
 * timeout...) : jamais des limites inventées à la place d'une lecture qui a échoué. */
export async function readContainerHealth(docker: Docker, containerId: string): Promise<ContainerHealthAndLimits> {
  try {
    const container = docker.getContainer(containerId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await withTimeout(container.inspect(), HEALTH_TIMEOUT_MS, "docker inspect (health)");
    const status = data?.State?.Health?.Status;
    const healthStatus: ContainerHealthStatus =
      status === "healthy" || status === "unhealthy" || status === "starting" ? status : "none";
    const memory: number | undefined = data?.HostConfig?.Memory;
    const nanoCpus: number | undefined = data?.HostConfig?.NanoCpus;
    return {
      healthStatus,
      ...(memory ? { memoryLimitBytes: memory } : {}),
      ...(nanoCpus ? { nanoCpus } : {}),
    };
  } catch {
    return { healthStatus: "none" };
  }
}

function mapDockerState(state: string): ContainerRef["state"] {
  if (state === "running") return "running";
  if (state === "restarting") return "restarting";
  return "stopped";
}

function primaryContainerName(container: ContainerInfo): string {
  const name = container.Names?.[0] ?? container.Id.slice(0, 12);
  return name.startsWith("/") ? name.slice(1) : name;
}

/**
 * Liste les conteneurs Docker/Swarm réels, avec repli sur les données de démonstration
 * si le démon est injoignable. `environmentLabel`/`nodeLabel` par défaut sont utilisés
 * quand aucune information Swarm plus précise n'est disponible (mode standalone/compose).
 *
 * `remoteEnvironmentId` (optionnel) : voir getClient() ci-dessus — quand fourni, interroge CET
 * hôte Docker distant persisté au lieu du démon local. Contrairement au démon local, un hôte
 * distant injoignable/jamais configuré ne retombe JAMAIS sur le jeu de démonstration ([] à la
 * place) : faire croire qu'un environnement distant qu'on vient d'ajouter tourne déjà le jeu de
 * données de démo serait trompeur (même principe que nutanix.ts/lxc.ts).
 */
export async function getDockerContainers(remoteEnvironmentId?: string): Promise<ContainerRef[]> {
  let docker: Docker;
  try {
    docker = await getClient(remoteEnvironmentId);
  } catch {
    return [];
  }
  if (!(await isDockerReachable(docker))) {
    if (remoteEnvironmentId) return [];
    return demoStore.containers.filter((c) => c.environment === "Prod" || c.environment === "Dev local");
  }

  try {
    const info = await docker.info();
    const isSwarmActive = info.Swarm?.LocalNodeState === "active";
    const environmentLabel = remoteEnvironmentId
      ? ((await getRemoteDockerEnvironmentRef(remoteEnvironmentId))?.name ?? remoteEnvironmentId)
      : isSwarmActive
        ? "Prod"
        : "Dev local";
    const nodeLabel = remoteEnvironmentId
      ? `remote-docker:${remoteEnvironmentId}`
      : isSwarmActive
        ? "swarm-node"
        : "dev-local-1";

    const containers = await docker.listContainers({ all: true });
    return await Promise.all(
      containers.map(async (c): Promise<ContainerRef> => {
        const usage = await readContainerUsage(docker, c.Id);
        return {
          id: c.Id,
          name: primaryContainerName(c),
          image: c.Image,
          environment: environmentLabel,
          node: c.Labels?.["com.docker.swarm.node.id"] ?? nodeLabel,
          state: mapDockerState(c.State),
          cpuPercent: usage.cpuPercent,
          memBytes: usage.memBytes,
        };
      }),
    );
  } catch {
    if (remoteEnvironmentId) return [];
    return demoStore.containers.filter((c) => c.environment === "Prod" || c.environment === "Dev local");
  }
}

// ---------------------------------------------------------------------------------------
// Cycle de vie d'un conteneur existant (start/stop/restart/remove) — équivalent `docker
// {start,stop,restart,rm} <id>`. Toutes lèvent si le démon est injoignable ou si l'appel
// dockerode échoue (conteneur déjà dans l'état demandé, en cours d'utilisation...) ; les
// routes appelantes traduisent en 502 avec le message d'erreur.
// ---------------------------------------------------------------------------------------

async function requireReachableClient(): Promise<Docker> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    throw new Error("Docker daemon is not reachable");
  }
  return docker;
}

export async function startContainer(id: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getContainer(id).start();
}

export async function stopContainer(id: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getContainer(id).stop();
}

export async function restartContainer(id: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getContainer(id).restart();
}

export async function removeContainer(id: string, force: boolean): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getContainer(id).remove({ force });
}

/** Renomme un conteneur existant (équivalent `docker rename <id> <name>`). */
export async function renameContainer(id: string, name: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getContainer(id).rename({ name });
}

/**
 * IP réelle d'un conteneur sur le réseau Docker (équivalent
 * `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <id>`) —
 * utilisé par services/reverseProxy.ts pour résoudre l'upstream d'une route ciblant un
 * conteneur QUAI À CHAQUE push vers Caddy (jamais mise en cache), pour ne jamais casser une
 * route au redémarrage du conteneur cible (nouvelle IP à chaque (re)création). `null` si le
 * démon est injoignable, si le conteneur n'existe plus, ou s'il n'est attaché à aucun réseau
 * (arrêté sans réseau bridge par défaut, par exemple).
 */
export async function getContainerNetworkAddress(id: string): Promise<string | null> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) return null;

  try {
    const container = docker.getContainer(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await container.inspect();
    const networks: Record<string, { IPAddress?: string }> = data.NetworkSettings?.Networks ?? {};
    const firstWithAddress = Object.values(networks).find((n) => n.IPAddress);
    return firstWithAddress?.IPAddress ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Console interactive dans un conteneur (équivalent `docker exec -it <id> sh`) — voir
// routes/console.ts (WebSocket) qui relaie bidirectionnellement le flux retourné ici avec le
// socket du navigateur. Un exec réel dockerode, jamais une réimplémentation de terminal.
// ---------------------------------------------------------------------------------------

/** Duplex stream hijacké dockerode + le handle Exec (pour resize/inspect) d'une session console. */
export interface ContainerExecSession {
  stream: NodeJS.ReadWriteStream;
  exec: Docker.Exec;
}

/**
 * Ouvre une session shell interactive dans un conteneur EN COURS D'EXÉCUTION (équivalent
 * `docker exec -it <id> sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"`).
 * Lève explicitement si le conteneur n'est pas `running` — vérifié ici en plus de tout
 * contrôle fait par l'appelant (routes/console.ts), jamais supposé.
 */
export async function openContainerConsole(id: string): Promise<ContainerExecSession> {
  const docker = await requireReachableClient();
  const container = docker.getContainer(id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await container.inspect();
  if (info?.State?.Status !== "running") {
    throw new Error(`Container "${id}" is not running (state: ${info?.State?.Status ?? "unknown"})`);
  }

  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });

  const stream: NodeJS.ReadWriteStream = await exec.start({ hijack: true, stdin: true, Tty: true });
  return { stream, exec };
}

// ---------------------------------------------------------------------------------------
// Logs de conteneur (équivalent `docker logs [-f] <id>`) — voir routes/containerLogs.ts. Un
// VRAI appel dockerode (container.logs()), jamais réimplémenté, sur le même principe que la
// console ci-dessus : cette fonction ouvre le flux, routes/containerLogs.ts le relaie tel quel
// au WebSocket du navigateur.
// ---------------------------------------------------------------------------------------

const DEFAULT_LOG_TAIL = 200;

/**
 * Les logs Docker sont multiplexés stdout/stderr (en-tête de 8 octets par frame, format
 * documenté par l'API Engine) SAUF si le conteneur a été créé avec `Tty: true` (flux texte brut,
 * comme la console interactive ci-dessus) — vérifié via `Config.Tty` de l'inspect, jamais
 * supposé : démultiplexer un flux qui n'est pas réellement mux corromprait la sortie affichée
 * (les en-têtes binaires seraient interprétés comme du texte).
 */
async function containerHasTty(container: Docker.Container): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await container.inspect();
  return Boolean(info?.Config?.Tty);
}

export interface ContainerLogStreamSession {
  /** Texte déjà démultiplexé si nécessaire (voir containerHasTty ci-dessus) — prêt à être
   * relayé chunk par chunk vers le socket du navigateur sans traitement supplémentaire. */
  stream: NodeJS.ReadableStream;
}

/**
 * Ouvre un flux de logs temps réel (équivalent `docker logs -f --timestamps --tail <n> <id>`).
 * Lève si le démon est injoignable ou si le conteneur n'existe pas (jamais un flux vide
 * silencieux) — l'appelant (routes/containerLogs.ts) traduit en message honnête avant de fermer
 * le WebSocket, même principe que openContainerConsole ci-dessus.
 */
export async function streamContainerLogs(id: string, options: { tail?: number } = {}): Promise<ContainerLogStreamSession> {
  const docker = await requireReachableClient();
  const container = docker.getContainer(id);
  const tty = await containerHasTty(container);
  const tail = options.tail !== undefined && options.tail >= 0 ? options.tail : DEFAULT_LOG_TAIL;

  const rawStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail,
  });

  if (tty) return { stream: rawStream };

  // Démultiplexage — même mécanisme que listVolumeFiles ci-dessus (docker.modem.demuxStream),
  // les deux sinks (stdout/stderr) pointent volontairement vers le MÊME PassThrough : l'ordre
  // d'écriture suit l'ordre réel des frames dans le flux source, donc stdout/stderr restent
  // chronologiquement entrelacés comme le ferait `docker logs` en CLI.
  const output = new PassThrough();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (docker.modem as any).demuxStream(rawStream, output, output);
  rawStream.on("end", () => output.end());
  rawStream.on("error", (err: Error) => output.destroy(err));
  return { stream: output };
}

/**
 * Snapshot instantané des derniers logs (équivalent `docker logs --timestamps --tail <n> <id>`,
 * SANS follow) — utilisé pour un premier affichage immédiat avant que le flux WebSocket
 * ci-dessus ne prenne le relais (voir routes/containerLogs.ts#GET /api/containers/:id/logs).
 */
export async function getContainerLogs(id: string, tail = DEFAULT_LOG_TAIL): Promise<string> {
  const docker = await requireReachableClient();
  const container = docker.getContainer(id);
  const tty = await containerHasTty(container);

  const buffer = await container.logs({
    follow: false,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail,
  });

  if (tty) return buffer.toString("utf8");

  return new Promise<string>((resolve, reject) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    output.on("error", reject);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (docker.modem as any).demuxStream(input, output, output);
    input.end(buffer);
  });
}

/** Détail complet d'un conteneur (équivalent `docker inspect`) — chargé à la demande par l'Inspector. */
export async function inspectDockerContainer(id: string): Promise<ContainerDetail | null> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) return null;

  try {
    const container = docker.getContainer(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await container.inspect();
    const usage = await readContainerUsage(docker, id);
    const info = await docker.info();
    const isSwarmActive = info.Swarm?.LocalNodeState === "active";

    const ports: ContainerPortMapping[] = Object.entries(data.NetworkSettings?.Ports ?? {}).flatMap(
      ([key, bindings]): ContainerPortMapping[] => {
        const [containerPort, proto] = key.split("/");
        const list = bindings as Array<{ HostIp: string; HostPort: string }> | null;
        if (!list || list.length === 0) return [{ containerPort: containerPort!, hostPort: null, proto: proto ?? "tcp" }];
        return list.map((b) => ({ containerPort: containerPort!, hostPort: b.HostPort, proto: proto ?? "tcp" }));
      },
    );

    const mounts: ContainerMount[] = (data.Mounts ?? []).map(
      (m: { Source: string; Destination: string; Type: string; RW: boolean }) => ({
        source: m.Source,
        destination: m.Destination,
        type: m.Type,
        readOnly: !m.RW,
      }),
    );

    // Limites réellement configurées (équivalent `docker inspect` HostConfig.Memory/NanoCpus) —
    // 0 est la valeur native Docker pour "pas de limite" (jamais fabriquée : un conteneur créé
    // avant cette fonctionnalité, ou sans limite explicite, renvoie honnêtement `undefined` ici,
    // pas un 0 qui laisserait croire à une vraie limite nulle).
    const memoryLimitBytes =
      typeof data.HostConfig?.Memory === "number" && data.HostConfig.Memory > 0 ? data.HostConfig.Memory : undefined;
    const nanoCpus =
      typeof data.HostConfig?.NanoCpus === "number" && data.HostConfig.NanoCpus > 0 ? data.HostConfig.NanoCpus : undefined;

    return {
      id: data.Id,
      fullId: data.Id,
      name: data.Name?.startsWith("/") ? data.Name.slice(1) : (data.Name ?? id),
      image: data.Config?.Image ?? "",
      environment: isSwarmActive ? "Prod" : "Dev local",
      node: data.Config?.Labels?.["com.docker.swarm.node.id"] ?? (isSwarmActive ? "swarm-node" : "dev-local-1"),
      state: mapDockerState(data.State?.Status ?? "stopped"),
      cpuPercent: usage.cpuPercent,
      memBytes: usage.memBytes,
      createdAt: data.Created ?? "",
      command: Array.isArray(data.Config?.Cmd) ? data.Config.Cmd.join(" ") : "",
      restartPolicy: data.HostConfig?.RestartPolicy?.Name || "no",
      networkMode: data.HostConfig?.NetworkMode ?? "default",
      ports,
      mounts,
      env: data.Config?.Env ?? [],
      labels: data.Config?.Labels ?? {},
      ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
      ...(nanoCpus !== undefined ? { nanoCpus } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Processus RÉELLEMENT en cours d'exécution dans un conteneur (équivalent `docker top <id>`) —
 * voir types.ts#ContainerProcessList pour ce que ça représente (et ne représente PAS : QUAI ne
 * reconstruit aucune architecture applicative interne, uniquement ce que le noyau hôte voit
 * tourner dans le namespace PID du conteneur). Ne masque JAMAIS un échec par une liste vide :
 * lève si le démon est injoignable, si le conteneur n'existe pas, ou si `docker top` échoue
 * (conteneur arrêté — la cause la plus fréquente — ou droits insuffisants) ; l'appelant
 * (routes/containers.ts) traduit en message honnête.
 */
export async function getContainerProcesses(id: string): Promise<ContainerProcessList> {
  const docker = await requireReachableClient();
  const container = docker.getContainer(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await container.top();
  return {
    titles: Array.isArray(result?.Titles) ? result.Titles : [],
    processes: Array.isArray(result?.Processes) ? result.Processes : [],
  };
}

/**
 * Historique des couches de l'image d'un conteneur (équivalent `docker history <image>`) — voir
 * types.ts#ImageHistoryLayer. `reference` est une référence Docker réelle ("name:tag" ou id),
 * pas un ImageRef.id QUAI (résolution faite par l'appelant, voir routes/images.ts). Lève si le
 * démon est injoignable ou si l'image n'existe plus localement — jamais de liste vide silencieuse.
 */
export async function getImageHistory(reference: string): Promise<ImageHistoryLayer[]> {
  const docker = await requireReachableClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history: any[] = await docker.getImage(reference).history();
  return history.map((layer) => ({
    id: typeof layer?.Id === "string" && layer.Id ? layer.Id : "<missing>",
    createdAt: typeof layer?.Created === "number" ? new Date(layer.Created * 1000).toISOString() : "",
    createdBy: typeof layer?.CreatedBy === "string" ? layer.CreatedBy : "",
    sizeBytes: typeof layer?.Size === "number" ? layer.Size : 0,
    comment: typeof layer?.Comment === "string" ? layer.Comment : "",
  }));
}

// ---------------------------------------------------------------------------------------
// Volumes (équivalent `docker volume ls/create/rm`).
// ---------------------------------------------------------------------------------------

export async function listVolumes(remoteEnvironmentId?: string): Promise<DockerVolume[]> {
  let docker: Docker;
  try {
    docker = await getClient(remoteEnvironmentId);
  } catch {
    return [];
  }
  if (!(await isDockerReachable(docker))) return [];

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ Volumes }, containers]: [any, ContainerInfo[]] = await Promise.all([
      docker.listVolumes(),
      docker.listContainers({ all: true }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Volumes ?? []).map((v: any) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      createdAt: v.CreatedAt ?? null,
      labels: v.Labels ?? {},
      scope: v.Scope ?? "local",
      inUseBy: containers.filter((c) => c.Mounts?.some((m) => m.Name === v.Name)).length,
    }));
  } catch {
    return [];
  }
}

export async function createVolume(name: string): Promise<DockerVolume> {
  const docker = await requireReachableClient();
  // dockerode: createVolume() renvoie en réalité un handle avec .inspect() à l'exécution
  // (vérifié manuellement) même si @types/dockerode déclare VolumeCreateResponse sans cette
  // méthode — d'où le `any` plutôt qu'un mauvais typage qui masquerait une vraie régression.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle: any = await docker.createVolume({ Name: name });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await handle.inspect();
  return {
    name: data.Name,
    driver: data.Driver,
    mountpoint: data.Mountpoint,
    createdAt: data.CreatedAt ?? null,
    labels: data.Labels ?? {},
    scope: data.Scope ?? "local",
    inUseBy: 0,
  };
}

export async function removeVolume(name: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getVolume(name).remove();
}

// ---------------------------------------------------------------------------------------
// Explorateur de fichiers d'un volume (lecture seule) — pas d'API Docker native pour "lister
// le contenu d'un volume" : on lance un conteneur alpine éphémère avec le volume monté en
// lecture seule sur /volume, on exécute un listing dedans, on parse la sortie, puis le
// conteneur est détruit (HostConfig.AutoRemove, + un remove({force}) défensif en `finally`
// au cas où il n'aurait jamais démarré). Voir routes/volumes.ts#GET /api/volumes/:name/files.
// ---------------------------------------------------------------------------------------

/** Même image que celle déjà utilisée par les workspaces IaC de démo (services/iac/workspaces.ts). */
const VOLUME_HELPER_IMAGE = "alpine:3.19";
const VOLUME_MOUNT_PATH = "/volume";

/**
 * Valide et normalise le sous-chemin demandé par le client. Défense en profondeur à deux
 * niveaux : (1) liste blanche de caractères — aucun métacaractère shell/glob n'est autorisé
 * (le script exécuté dans le conteneur helper interpole ce chemin dans un glob shell, voir
 * plus bas — la liste blanche garantit qu'il ne peut jamais en sortir) ; (2) résolution
 * POSIX (path.posix.normalize) qui collapse tout ".." puis vérification stricte que le
 * résultat reste sous /volume. Un `path=../../etc` (ou toute variante avec des `..`) est donc
 * rejeté avant même d'atteindre le conteneur helper.
 */
function resolveVolumeSubPath(subPath: string): string {
  const raw = subPath ?? "";
  if (!/^[a-zA-Z0-9 _./-]*$/.test(raw)) {
    throw new Error("Invalid path: contains disallowed characters");
  }
  const resolved = path.posix.normalize(path.posix.join(VOLUME_MOUNT_PATH, raw));
  if (resolved !== VOLUME_MOUNT_PATH && !resolved.startsWith(`${VOLUME_MOUNT_PATH}/`)) {
    throw new Error("Invalid path: escapes the mounted volume");
  }
  return resolved;
}

/** Nom de volume Docker valide (mêmes règles que celles appliquées par le démon à la création). */
function assertValidVolumeName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error("Invalid volume name");
  }
}

async function ensureImagePresent(docker: Docker, reference: string): Promise<void> {
  try {
    await docker.getImage(reference).inspect();
    return;
  } catch {
    // pas présente localement : on la tire à la volée, comme documenté.
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(reference, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        reject(err ?? new Error("docker.pull returned no stream"));
        return;
      }
      docker.modem.followProgress(stream, (progressErr: Error | null) => {
        if (progressErr) reject(progressErr);
        else resolve();
      });
    });
  });
}

/**
 * Script exécuté dans le conteneur helper : `$1` (lié plus bas via l'argv, jamais interpolé
 * dans la chaîne du script) est le chemin absolu à lister. `stat` (busybox, présent dans
 * alpine) plutôt que `ls --time-style=full-iso` : busybox `ls` ne supporte pas cette option
 * GNU coreutils (vérifié manuellement : `ls: unrecognized option: time-style=full-iso`).
 * Sortie : une ligne par entrée, `nom\ttaille\tmtime-epoch\ttype` (tabulation réelle).
 */
const LIST_DIR_SCRIPT = `dir="$1"
if [ ! -e "$dir" ]; then
  echo ENOENT >&2
  exit 2
fi
if [ ! -d "$dir" ]; then
  echo ENOTDIR >&2
  exit 3
fi
stat -c '%n\t%s\t%Y\t%F' "$dir"/* "$dir"/.[!.]* 2>/dev/null
exit 0
`;

function parseFileType(statType: string): boolean {
  return statType.trim() === "directory";
}

/**
 * Liste le contenu d'un sous-chemin d'un volume Docker (lecture seule), via un conteneur
 * alpine éphémère (voir en-tête de section). `subPath` est validé/normalisé par
 * resolveVolumeSubPath avant tout usage.
 */
export async function listVolumeFiles(volumeName: string, subPath: string): Promise<VolumeFileEntry[]> {
  assertValidVolumeName(volumeName);
  const docker = await requireReachableClient();
  const targetPath = resolveVolumeSubPath(subPath);

  // Vérifié explicitement AVANT de monter quoi que ce soit : `HostConfig.Binds` sur un volume
  // nommé qui n'existe pas encore fait que Docker le CRÉE silencieusement à la volée (vérifié
  // manuellement) — sans ce garde-fou, lister un volume inexistant polluerait l'hôte d'un
  // volume vide fantôme au lieu de répondre 404.
  try {
    await docker.getVolume(volumeName).inspect();
  } catch {
    throw new Error(`Volume "${volumeName}" not found`);
  }

  await ensureImagePresent(docker, VOLUME_HELPER_IMAGE);

  const container = await docker.createContainer({
    Image: VOLUME_HELPER_IMAGE,
    Cmd: ["/bin/sh", "-c", LIST_DIR_SCRIPT, "quai-volume-ls", targetPath],
    Tty: false,
    HostConfig: {
      Binds: [`${volumeName}:${VOLUME_MOUNT_PATH}:ro`],
      AutoRemove: true,
      NetworkMode: "none",
    },
  });

  try {
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new PassThrough();
    const stderrSink = new PassThrough();
    stdoutSink.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    docker.modem.demuxStream(attachStream, stdoutSink, stderrSink);
    // Enregistré AVANT container.start() pour éviter toute course avec un flux qui se
    // terminerait avant qu'on ait eu la chance de poser ce listener (le conteneur tourne pour
    // une fraction de seconde — `ls`/`stat` sur un petit dossier).
    const streamEnded = new Promise<void>((resolve) => {
      attachStream.once("end", () => resolve());
    });

    await container.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waitResult: any = await container.wait();
    await streamEnded;

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const statusCode: number = waitResult?.StatusCode ?? 0;

    if (statusCode === 2) {
      throw new Error(`Path not found in volume "${volumeName}"`);
    }
    if (statusCode === 3) {
      throw new Error(`Path is not a directory in volume "${volumeName}"`);
    }
    if (statusCode !== 0) {
      throw new Error(stderr.trim() || `Listing failed with exit code ${statusCode}`);
    }

    const entries: VolumeFileEntry[] = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line): VolumeFileEntry | null => {
        const parts = line.split("\t");
        if (parts.length !== 4) return null;
        const [fullName, sizeStr, mtimeStr, fileType] = parts as [string, string, string, string];
        const relativePath = fullName.slice(VOLUME_MOUNT_PATH.length) || "/";
        const name = relativePath.split("/").filter(Boolean).pop() ?? relativePath;
        const mtimeEpochSeconds = Number(mtimeStr);
        return {
          name,
          path: relativePath,
          isDirectory: parseFileType(fileType),
          sizeBytes: Number(sizeStr) || 0,
          modifiedAt: Number.isFinite(mtimeEpochSeconds) ? new Date(mtimeEpochSeconds * 1000).toISOString() : "",
        };
      })
      .filter((entry): entry is VolumeFileEntry => entry !== null);

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  } finally {
    // AutoRemove:true supprime déjà le conteneur en temps normal ; ce remove défensif ne fait
    // rien de plus si c'est déjà le cas (404 avalé), mais garantit qu'aucun helper ne traîne
    // si create/start a échoué avant que le cycle de vie normal ne s'exécute.
    try {
      await container.remove({ force: true });
    } catch {
      // déjà supprimé (AutoRemove) ou jamais démarré : rien à faire.
    }
  }
}

// ---------------------------------------------------------------------------------------
// Networks (équivalent `docker network ls/create/rm`).
// ---------------------------------------------------------------------------------------

export async function listNetworks(remoteEnvironmentId?: string): Promise<DockerNetwork[]> {
  let docker: Docker;
  try {
    docker = await getClient(remoteEnvironmentId);
  } catch {
    return [];
  }
  if (!(await isDockerReachable(docker))) return [];

  try {
    const networks = await docker.listNetworks();
    return networks.map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      containerCount: n.Containers ? Object.keys(n.Containers).length : 0,
      createdAt: n.Created ?? null,
      internal: n.Internal ?? false,
    }));
  } catch {
    return [];
  }
}

export async function createNetwork(name: string, driver: string): Promise<DockerNetwork> {
  const docker = await requireReachableClient();
  const network = await docker.createNetwork({ Name: name, Driver: driver });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await network.inspect();
  return {
    id: data.Id,
    name: data.Name,
    driver: data.Driver,
    scope: data.Scope,
    containerCount: 0,
    createdAt: data.Created ?? null,
    internal: data.Internal ?? false,
  };
}

export async function removeNetwork(id: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getNetwork(id).remove();
}

/**
 * Attache/détache un conteneur à un network (équivalent `docker network {connect,disconnect}`).
 * Utilisé par l'éditeur visuel de topologie (glisser-connecter un conteneur à un network,
 * ou déconnecter depuis le menu contextuel d'une arête) — voir routes/networks.ts.
 */
export async function connectContainerToNetwork(networkId: string, containerId: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getNetwork(networkId).connect({ Container: containerId });
}

export async function disconnectContainerFromNetwork(networkId: string, containerId: string): Promise<void> {
  const docker = await requireReachableClient();
  await docker.getNetwork(networkId).disconnect({ Container: containerId });
}

// ---------------------------------------------------------------------------------------
// Infos hôte du démon (équivalent `docker info`) — CPU/RAM totaux, version, socket, pour la
// carte "environnement" façon Portainer sur la page Environnements.
// ---------------------------------------------------------------------------------------

export async function getDockerHostInfo(remoteEnvironmentId?: string): Promise<DockerHostInfo | null> {
  let docker: Docker;
  try {
    docker = await getClient(remoteEnvironmentId);
  } catch {
    return null;
  }
  if (!(await isDockerReachable(docker))) return null;

  try {
    const [info, version, volumes] = await Promise.all([docker.info(), docker.version(), docker.listVolumes()]);
    let endpoint: string;
    if (remoteEnvironmentId) {
      const ref = await getRemoteDockerEnvironmentRef(remoteEnvironmentId);
      endpoint =
        ref?.transport === "ssh"
          ? `ssh://${ref.sshUsername ?? "?"}@${ref.host}:${ref.port}`
          : `tcp://${ref?.host ?? remoteEnvironmentId}:${ref?.port ?? ""}`;
    } else {
      endpoint =
        (await getEffectiveDockerConfig()).host ??
        (process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock");
    }
    return {
      serverVersion: version.Version ?? info.ServerVersion ?? "unknown",
      apiVersion: version.ApiVersion ?? "unknown",
      os: info.OperatingSystem ?? "unknown",
      kernelVersion: info.KernelVersion ?? "unknown",
      architecture: info.Architecture ?? "unknown",
      cpus: info.NCPU ?? 0,
      totalMemBytes: info.MemTotal ?? 0,
      containersRunning: info.ContainersRunning ?? 0,
      containersStopped: info.ContainersStopped ?? 0,
      imagesCount: info.Images ?? 0,
      storageDriver: info.Driver ?? "unknown",
      dockerRootDir: info.DockerRootDir ?? "",
      endpoint,
      swarmActive: info.Swarm?.LocalNodeState === "active",
      volumesCount: (volumes.Volumes ?? []).length,
    };
  } catch {
    return null;
  }
}

/**
 * Liste les environnements pilotés par Docker (Swarm en Prod, Compose/standalone en Dev
 * local). L'environnement Kubernetes est géré séparément par src/services/kubernetes.ts.
 */
export async function getDockerEnvironments(): Promise<Environment[]> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    return demoStore.environments.filter((e) => e.orchestrator === "swarm" || e.orchestrator === "compose");
  }

  try {
    const info = await docker.info();
    const isSwarmActive = info.Swarm?.LocalNodeState === "active";
    const containers = await docker.listContainers({ all: true });
    const hostInfo = await getDockerHostInfo();

    if (isSwarmActive) {
      const swarmNodes = await docker.listNodes();
      const nodes: ClusterNode[] = swarmNodes.map((n) => {
        const nodeContainerCount = containers.filter(
          (c) => c.Labels?.["com.docker.swarm.node.id"] === n.ID,
        ).length;
        const state = n.Status?.State === "ready" ? "ok" : "warn";
        return {
          id: n.ID,
          environmentId: "prod-swarm",
          role: n.Spec?.Role ?? "worker",
          cpuPercent: 0, // dockerode ne fournit pas d'agrégat CPU par nœud Swarm sans stats par conteneur
          memPercent: 0,
          status: state,
          containerCount: nodeContainerCount,
        };
      });
      return [
        {
          id: "prod-swarm",
          name: "Prod",
          orchestrator: "swarm",
          status: nodes.every((n) => n.status === "ok") ? "ok" : "warn",
          nodes,
          ...(hostInfo ? { hostInfo } : {}),
        },
      ];
    }

    // Agrégat réel (pas 0 en dur) : somme du CPU/mem de chaque conteneur en cours d'exécution,
    // rapportée à la RAM totale de l'hôte (hostInfo). cpuPercent peut légitimement dépasser
    // 100 (plusieurs conteneurs saturant plusieurs cœurs) — même convention que `docker stats` ;
    // le graphique (AreaChart) clampe déjà l'affichage à son échelle 0-100.
    const runningContainers = await Promise.all(
      containers.filter((c) => c.State === "running").map((c) => readContainerUsage(docker, c.Id)),
    );
    const totalMemBytes = runningContainers.reduce((sum, c) => sum + c.memBytes, 0);
    const totalCpuPercent = runningContainers.reduce((sum, c) => sum + c.cpuPercent, 0);
    const memPercent = hostInfo?.totalMemBytes ? Math.min(100, (totalMemBytes / hostInfo.totalMemBytes) * 100) : 0;

    const node: ClusterNode = {
      id: "dev-local-1",
      environmentId: "dev-compose",
      role: "standalone",
      cpuPercent: Math.round(Math.min(100, totalCpuPercent) * 10) / 10,
      memPercent: Math.round(memPercent * 10) / 10,
      status: "ok",
      containerCount: containers.length,
    };
    return [
      {
        id: "dev-compose",
        name: "Dev local",
        orchestrator: "compose",
        status: "ok",
        nodes: [node],
        ...(hostInfo ? { hostInfo } : {}),
      },
    ];
  } catch {
    return demoStore.environments.filter((e) => e.orchestrator === "swarm" || e.orchestrator === "compose");
  }
}
