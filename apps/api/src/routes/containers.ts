/**
 * GET    /api/containers               — conteneurs Docker/Swarm + pods Kubernetes, vue unifiée.
 *                                         `?environmentId=remote-docker:<id>` cible un environnement
 *                                         Docker distant persisté (voir remoteDockerStore.ts) au lieu
 *                                         du démon local — CÂBLÉ BOUT-EN-BOUT, voir ARCHITECTURE.md
 *                                         § "Environnements Docker distants". Tout autre id (environnement
 *                                         local, Kubernetes, Nutanix, LXC, absent) retombe sur le
 *                                         comportement historique (démon local + pods Kubernetes).
 * POST   /api/containers               — crée puis démarre un conteneur Docker (équivalent `docker run -d`).
 *                                         L'image doit déjà être locale (POST /api/images/pull d'abord si besoin).
 * GET    /api/containers/:id           — détail complet (équivalent `docker inspect`), Docker uniquement.
 * GET    /api/containers/:id/processes — processus RÉELS en cours d'exécution (équivalent `docker top`),
 *                                         voir services/docker.ts#getContainerProcesses — 409 si le
 *                                         conteneur n'est pas démarré (docker top l'exige), jamais une
 *                                         liste vide silencieuse.
 * GET    /api/containers/:id/processes/detailed — mêmes processus mais vus DEPUIS L'INTÉRIEUR du
 *                                         conteneur cible (PID dans SA PROPRE numérotation, CPU/âge/
 *                                         ports en LISTEN réels) — voir services/containerInternals.ts#
 *                                         getContainerProcessDetails. Même niveau d'accès que
 *                                         GET /processes ci-dessus (authentifié, tous rôles). 409 si le
 *                                         conteneur n'est pas démarré ; `shellAvailable: false` (200,
 *                                         liste vide) si aucun shell POSIX n'est disponible dans l'image
 *                                         cible — jamais une liste vide silencieuse sans distinction.
 * POST   /api/containers/:id/start     — démarre un conteneur arrêté.
 * POST   /api/containers/:id/stop      — arrête un conteneur en cours d'exécution.
 * POST   /api/containers/:id/restart   — redémarre un conteneur.
 * POST   /api/containers/:id/rename    — renomme un conteneur (équivalent `docker rename`).
 * DELETE /api/containers/:id           — supprime un conteneur (?force=true pour un conteneur en cours d'exécution).
 * GET    /api/containers/:id/files/hexdump — hexdump en lecture seule d'une fenêtre d'octets d'un
 *                                         fichier ARBITRAIRE dans le conteneur (équivalent `docker
 *                                         exec <id> sh -c "dd ... | xxd -p"`), voir
 *                                         services/docker.ts#readContainerFileHexdump pour la
 *                                         validation stricte du chemin (absolu, aucun "..") et le
 *                                         plafonnement de `length`. ADMIN UNIQUEMENT (pas operator,
 *                                         voir rejectIfNotAdmin ci-dessous) : surface plus sensible
 *                                         que /processes(/detailed) ci-dessus — lecture de contenu
 *                                         binaire brut potentiellement un secret sur disque, même
 *                                         sensibilité que POST /api/secrets/:id/reveal.
 * GET    /api/containers/:id/processes/:pid/inspect — cmdline/environ/fd RÉELS d'UN process précis,
 *                                         lus DEPUIS L'INTÉRIEUR du conteneur (voir
 *                                         services/docker.ts#inspectContainerProcess). `pid` suit la
 *                                         numérotation vue PAR LE CONTENEUR LUI-MÊME (celle de
 *                                         GET /processes/detailed), PAS celle de GET /processes
 *                                         (docker top, PID hôte) — les deux ne sont JAMAIS
 *                                         interchangeables. Même niveau d'accès que /processes
 *                                         (tous rôles authentifiés, lecture seule).
 * POST   /api/containers/:id/processes/:pid/kill — envoie un signal RÉEL (`{ signal?: "TERM"|"KILL"
 *                                         }`, "TERM" par défaut) — operator/admin (garde globale
 *                                         plugins/auth.ts sur toute méthode mutante, même pattern
 *                                         que /start,/stop,/restart ci-dessus). 409 dédié avec
 *                                         `useContainerStopInstead: true` si `pid` vaut 1 (voir
 *                                         services/docker.ts#killContainerProcess pour le garde-fou).
 * POST   /api/containers/:id/processes/:pid/restart — tue puis relance EXACTEMENT la même cmdline
 *                                         (voir services/docker.ts#restartContainerProcess) —
 *                                         mêmes rôles que kill ci-dessus. 409 dédié avec
 *                                         `useContainerRestartInstead: true` si `pid` vaut 1.
 *
 * `secretEnv` résolu avec succès sur POST /api/containers enregistre aussi le lien secret<->
 * conteneur (services/secretsStore.ts#recordSecretUsage, exposé via `usedBy` sur SecretRef) —
 * maintenu à jour par renameSecretUsageContainer/removeSecretUsagesForContainer sur rename/delete.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAndStartContainer,
  getContainerProcesses,
  getDockerContainers,
  inspectContainerProcess,
  inspectDockerContainer,
  killContainerProcess,
  readContainerFileHexdump,
  removeContainer,
  renameContainer,
  restartContainer,
  restartContainerProcess,
  startContainer,
  stopContainer,
} from "../services/docker.js";
import { getContainerProcessDetails } from "../services/containerInternals.js";
import { getKubernetesContainers } from "../services/kubernetes.js";
import {
  getDecryptedSecretValue,
  listSecrets,
  recordSecretUsage,
  removeSecretUsagesForContainer,
  renameSecretUsageContainer,
  SecretExpiredError,
} from "../services/secretsStore.js";
import { remoteDockerIdFromEnvironmentId } from "../utils/environmentId.js";

interface SecretEnvRef {
  key?: string;
  secretName?: string;
}

interface CreateContainerBody {
  image?: string;
  name?: string;
  ports?: string[];
  env?: string[];
  // Références par nom vers des secrets définis dans le gestionnaire de secrets (voir
  // services/secretsStore.ts) — résolues côté serveur ci-dessous, jamais côté client :
  // la valeur réelle ne transite jamais vers/depuis le navigateur après sa saisie initiale.
  secretEnv?: SecretEnvRef[];
  volumes?: string[];
  network?: string;
  // Limites de ressources optionnelles (HostConfig.Memory/NanoCpus côté dockerode) — voir
  // parseResourceLimits ci-dessous. Absentes = pas de limite, comportement Docker natif
  // inchangé, jamais de valeur par défaut fabriquée ici.
  memoryLimitBytes?: number;
  nanoCpus?: number;
}

// Docker refuse de créer un conteneur avec une limite mémoire trop basse pour qu'un processus
// puisse seulement démarrer (contrainte du démon lui-même, pas une règle QUAI inventée — vérifié
// dans la doc Docker Engine : `--memory` doit être >= 6 Mo). Rejeter ici en 400 avec un message
// clair plutôt que de laisser Docker renvoyer une erreur générique en 502 après coup.
const MIN_MEMORY_LIMIT_BYTES = 6 * 1024 * 1024;
// Pas une vraie limite Docker (NanoCpus n'a pas de plafond documenté au-delà du nombre de cœurs
// réellement disponibles sur l'hôte, que Docker valide lui-même) — simple garde-fou de bon sens
// contre une saisie absurde (ex: un zéro oublié) avant même d'atteindre Docker. 256 cœurs dépasse
// largement tout hôte réaliste pour ce projet.
const MAX_NANO_CPUS = 256 * 1_000_000_000;

/**
 * Valide les limites de ressources optionnelles du body de POST /api/containers. Lève un message
 * prêt à renvoyer en 400 si une valeur est fournie mais invalide/déraisonnable — ne fabrique
 * jamais de valeur par défaut quand un champ est absent (voir CreateContainerBody ci-dessus).
 */
function parseResourceLimits(body: CreateContainerBody): { memoryLimitBytes?: number; nanoCpus?: number } | { error: string } {
  const result: { memoryLimitBytes?: number; nanoCpus?: number } = {};
  if (body.memoryLimitBytes !== undefined) {
    const value = body.memoryLimitBytes;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_MEMORY_LIMIT_BYTES) {
      return { error: `memoryLimitBytes must be an integer >= ${MIN_MEMORY_LIMIT_BYTES} bytes (Docker's own minimum, ~6 Mo)` };
    }
    result.memoryLimitBytes = value;
  }
  if (body.nanoCpus !== undefined) {
    const value = body.nanoCpus;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_NANO_CPUS) {
      return { error: `nanoCpus must be a positive integer, max ${MAX_NANO_CPUS} (${MAX_NANO_CPUS / 1_000_000_000} cœurs)` };
    }
    result.nanoCpus = value;
  }
  return result;
}

interface RenameContainerBody {
  name?: string;
}

interface FileHexdumpQuery {
  path?: string;
  offset?: string;
  length?: string;
}

/**
 * true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même pattern que
 * routes/secrets.ts#rejectIfNotAdmin. Le hook global (plugins/auth.ts) n'exige operator/admin
 * QUE pour les méthodes mutantes (POST/PUT/PATCH/DELETE) ; cette route est un GET, donc sans ce
 * garde local elle serait accessible à TOUT rôle authentifié (comme /processes(/detailed)
 * ci-dessus, volontairement ouverts eux). Lire le contenu binaire arbitraire d'un fichier dans
 * un conteneur est plus sensible qu'un redémarrage/exec shell (operator suffit pour
 * /api/console) : accès direct potentiel à un secret sur disque (clé privée, .env, etc.) —
 * admin uniquement, même sensibilité que POST /api/secrets/:id/reveal (routes/secrets.ts).
 */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/**
 * Traduit une erreur de readContainerFileHexdump (services/docker.ts) en réponse HTTP. Distincte
 * de sendDockerActionError ci-dessus (messages et codes propres à cette route) plutôt que de la
 * modifier : sendDockerActionError est partagée par toutes les autres routes de ce fichier, la
 * faire évoluer pour un seul endpoint risquerait de changer leur comportement par effet de bord.
 */
function sendFileHexdumpError(reply: FastifyReply, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // Validation chemin/offset/length (services/docker.ts#assertValidAbsoluteFilePath et
  // readContainerFileHexdump) ou tentative de hexdump d'un dossier -> 400, requête mal formée.
  const isBadRequest = /^Invalid (path|offset|length)|is a directory, not a file/i.test(message);
  // Fichier présent mais illisible côté conteneur (permissions Unix internes) -> 403, distinct
  // du 403 "rôle insuffisant" ci-dessus mais même code HTTP (accès refusé), message différent.
  const isForbidden = /is not readable/i.test(message);
  const isNotFound = /^File not found|no such container|404/i.test(message);
  // "is not running" : même convention que sendDockerActionError ci-dessus (409, conflit d'état).
  const isConflict = /is not running/i.test(message);
  const status = isBadRequest ? 400 : isForbidden ? 403 : isNotFound ? 404 : isConflict ? 409 : 502;
  reply.code(status).send({ error: message });
}

/** Traduit une erreur dockerode/moteur Docker en réponse HTTP — 404 si le conteneur n'existe
 * plus (course possible entre la liste affichée et l'action), 502 pour le reste (démon
 * injoignable, conteneur déjà dans l'état demandé, volume/réseau en cours d'utilisation...). */
function sendDockerActionError(reply: import("fastify").FastifyReply, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const notFound = /no such container|404/i.test(message);
  // "is not running" : réponse du démon pour `docker top` sur un conteneur arrêté — 409
  // (conflit d'état), un message plus honnête qu'un 502 générique pour ce cas très courant.
  const notRunning = /is not running/i.test(message);
  reply.code(notFound ? 404 : notRunning ? 409 : 502).send({ error: message });
}

/**
 * Traduit une erreur de inspectContainerProcess/killContainerProcess/restartContainerProcess
 * (services/docker.ts) en réponse HTTP. Distincte de sendDockerActionError ci-dessus : un process
 * "introuvable" (déjà mort, course normale entre l'affichage de la liste et l'action) doit rendre
 * un 404 propre au PROCESS, jamais confondu avec "conteneur introuvable" (404 aussi, mais un
 * message différent) ni avaler comme un succès.
 */
function sendProcessActionError(reply: FastifyReply, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const containerNotFound = /no such container|404/i.test(message);
  const containerNotRunning = /is not running/i.test(message);
  // "Process <pid> not found... already exited" (voir readCmdline, services/docker.ts) : le pid a
  // disparu entre temps — situation normale, traduite honnêtement en 404, jamais un 502 générique.
  const processGone = /process \d+ not found|no such process/i.test(message);
  const status = containerNotFound ? 404 : containerNotRunning ? 409 : processGone ? 404 : 502;
  reply.code(status).send({ error: message });
}

/**
 * GET /api/containers/:id ne doit JAMAIS renvoyer en clair la valeur d'une variable d'env
 * injectée via `secretEnv` (voir POST /api/containers ci-dessus) — `docker inspect` (donc
 * `services/docker.ts#inspectDockerContainer`, source de `detail.env`) ne fait bien sûr aucune
 * distinction entre une variable "normale" et un secret résolu côté serveur : c'est cette route
 * qui doit la faire elle-même. Masquage SYSTÉMATIQUE (aucun rôle, y compris admin, n'y échappe) —
 * même principe que GET /api/secrets qui ne renvoie jamais `value` (routes/secrets.ts) : la seule
 * façon d'obtenir une valeur de secret en clair reste POST /api/secrets/:id/reveal (admin
 * uniquement, une fois par appel, déjà journalisé dans l'audit log). Avant ce correctif, un
 * simple `viewer` pouvait lire n'importe quel secret injecté dans un conteneur via cette route,
 * en contradiction directe avec le contrat "write-only" documenté du gestionnaire de secrets
 * (voir finding E1, docs/reports/security-audit-2026-08-12.md).
 *
 * `secretKeys` vient de `usedBy` (secretsStore.ts#recordSecretUsage, déjà exposé publiquement
 * par GET /api/secrets) : la clé d'env est une METADONNÉE non sensible, seule la valeur l'est.
 * Repose sur une correspondance de CLÉ (pas de valeur) : robuste même si la valeur du secret a
 * changé depuis (rotation) sans que le conteneur n'ait été recréé.
 */
export function maskSecretEnvValues(env: readonly string[], secretKeys: ReadonlySet<string>): string[] {
  if (secretKeys.size === 0) return [...env];
  return env.map((entry) => {
    const eq = entry.indexOf("=");
    const key = eq >= 0 ? entry.slice(0, eq) : entry;
    return secretKeys.has(key) ? `${key}=***` : entry;
  });
}

export default async function containersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { environmentId?: string } }>("/api/containers", async (request, reply) => {
    const remoteEnvironmentId = remoteDockerIdFromEnvironmentId(request.query?.environmentId);
    // Un environnement Docker distant n'a pas de pods Kubernetes : on n'interroge Kubernetes que
    // pour la vue par défaut (local), jamais pour un hôte distant précis.
    const [dockerContainers, kubernetesContainers] = await Promise.all([
      getDockerContainers(remoteEnvironmentId),
      remoteEnvironmentId ? Promise.resolve([]) : getKubernetesContainers(),
    ]);
    return reply.send([...dockerContainers, ...kubernetesContainers]);
  });

  fastify.post<{ Body: CreateContainerBody }>("/api/containers", async (request, reply) => {
    const image = request.body?.image?.trim();
    if (!image) {
      return reply.code(400).send({ error: "image is required (ex: \"redis:7-alpine\")" });
    }
    const name = request.body?.name?.trim() || undefined;
    const ports = (request.body?.ports ?? []).map((p) => p.trim()).filter(Boolean);
    const env = (request.body?.env ?? []).map((e) => e.trim()).filter(Boolean);
    const volumes = (request.body?.volumes ?? []).map((v) => v.trim()).filter(Boolean);
    const network = request.body?.network?.trim() || undefined;

    const resourceLimits = parseResourceLimits(request.body ?? {});
    if ("error" in resourceLimits) {
      return reply.code(400).send({ error: resourceLimits.error });
    }

    // Résolution des secrets référencés par nom (jamais côté client) — TOUJOURS avant l'appel
    // à createAndStartContainer : un secretName introuvable doit faire échouer la requête
    // entière en 400, jamais créer le conteneur avec un env partiellement résolu. `resolvedSecretRefs`
    // garde key/secretName (sans la valeur) pour enregistrer la liaison secret<->conteneur une
    // fois le conteneur RÉELLEMENT créé ci-dessous (voir secretsStore.ts#recordSecretUsage) —
    // c'est la SEULE façon dont un lien "usedBy" est établi, jamais deviné après coup.
    const secretEnv: string[] = [];
    const resolvedSecretRefs: { key: string; secretName: string }[] = [];
    for (const ref of request.body?.secretEnv ?? []) {
      const key = ref.key?.trim();
      const secretName = ref.secretName?.trim();
      if (!key || !secretName) {
        return reply.code(400).send({ error: "secretEnv entries require both key and secretName" });
      }
      let value: string | null;
      try {
        value = await getDecryptedSecretValue(secretName);
      } catch (err) {
        if (err instanceof SecretExpiredError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      if (value === null) {
        return reply.code(400).send({ error: `Secret "${secretName}" not found` });
      }
      secretEnv.push(`${key}=${value}`);
      resolvedSecretRefs.push({ key, secretName });
    }

    try {
      const created = await createAndStartContainer({
        image,
        ...(name ? { name } : {}),
        ports,
        env: [...env, ...secretEnv],
        volumes,
        ...(network ? { network } : {}),
        ...resourceLimits,
      });
      const containers = await getDockerContainers();
      if (resolvedSecretRefs.length > 0) {
        // Nom réel du conteneur créé (Docker peut en générer un aléatoire si `name` était omis) —
        // relu depuis la liste fraîchement rechargée plutôt que de supposer `name`.
        const createdName = containers.find((c) => c.id === created.id)?.name ?? name ?? created.id;
        for (const ref of resolvedSecretRefs) {
          await recordSecretUsage(ref.secretName, {
            containerId: created.id,
            containerName: createdName,
            key: ref.key,
          });
        }
      }
      return reply.code(201).send({ id: created.id, containers });
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/containers/:id", async (request, reply) => {
    const detail = await inspectDockerContainer(request.params.id);
    if (!detail) {
      return reply.code(404).send({ error: `Container "${request.params.id}" not found` });
    }
    // Voir maskSecretEnvValues ci-dessus (finding E1) — `usedBy` (déjà public via GET /api/secrets)
    // donne les clés d'env réellement issues de secretEnv pour CE conteneur, tous secrets confondus.
    const allSecrets = await listSecrets();
    const secretKeys = new Set(
      allSecrets.flatMap((secret) => secret.usedBy.filter((u) => u.containerId === detail.id).map((u) => u.key)),
    );
    return reply.send({ ...detail, env: maskSecretEnvValues(detail.env, secretKeys) });
  });

  fastify.get<{ Params: { id: string } }>("/api/containers/:id/processes", async (request, reply) => {
    try {
      const list = await getContainerProcesses(request.params.id);
      return reply.send(list);
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  // Même niveau d'accès que GET /processes ci-dessus (voir plugins/auth.ts : les GET ne sont
  // gardés que par l'authentification, pas par un rôle operator/admin — aucune route existante
  // similaire n'ajoute de garde supplémentaire pour de la lecture seule, contrairement à
  // routes/console.ts qui, lui, ouvre un accès INTERACTIF).
  fastify.get<{ Params: { id: string } }>("/api/containers/:id/processes/detailed", async (request, reply) => {
    try {
      const list = await getContainerProcessDetails(request.params.id);
      return reply.send(list);
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  // Voir en-tête de fichier — mêmes rôles/lecture que /processes(/detailed) : `pid` doit être
  // celui vu PAR LE CONTENEUR LUI-MÊME (namespace PID interne), PAS le pid hôte de /processes.
  fastify.get<{ Params: { id: string; pid: string } }>(
    "/api/containers/:id/processes/:pid/inspect",
    async (request, reply) => {
      const pid = Number(request.params.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return reply.code(400).send({ error: "pid must be a positive integer" });
      }
      try {
        const detail = await inspectContainerProcess(request.params.id, pid);
        return reply.send(detail);
      } catch (err) {
        sendProcessActionError(reply, err);
      }
    },
  );

  // operator/admin (garde globale plugins/auth.ts sur POST, même pattern que /start,/stop,/restart
  // ci-dessus — aucun garde local supplémentaire nécessaire ici). Voir
  // services/docker.ts#killContainerProcess pour le garde-fou pid===1 : dans ce cas AUCUN kill n'a
  // été exécuté, on répond 409 avec `useContainerStopInstead: true` plutôt qu'un succès ambigu qui
  // laisserait croire que le process a été tué.
  fastify.post<{ Params: { id: string; pid: string }; Body: { signal?: "TERM" | "KILL" } }>(
    "/api/containers/:id/processes/:pid/kill",
    async (request, reply) => {
      const pid = Number(request.params.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return reply.code(400).send({ error: "pid must be a positive integer" });
      }
      const rawSignal = request.body?.signal;
      if (rawSignal !== undefined && rawSignal !== "TERM" && rawSignal !== "KILL") {
        return reply.code(400).send({ error: 'signal must be "TERM" or "KILL" (default "TERM")' });
      }
      const signal: "TERM" | "KILL" = rawSignal === "KILL" ? "KILL" : "TERM";

      try {
        const result = await killContainerProcess(request.params.id, pid, signal);
        if (result.wasPidOne) {
          return reply.code(409).send({
            error: "Refusing to kill PID 1 directly: this would stop the entire container. Use the container stop action instead.",
            useContainerStopInstead: true,
          });
        }
        return reply.send({ ok: true });
      } catch (err) {
        sendProcessActionError(reply, err);
      }
    },
  );

  // Même garde/rôles que kill ci-dessus. Voir services/docker.ts#restartContainerProcess pour le
  // garde-fou pid===1 (même principe : { wasPidOne: true } sans AUCUNE action, 409 avec
  // `useContainerRestartInstead: true`) et pour l'échec explicite si la cmdline du process est
  // vide/introuvable (jamais une commande de remplacement devinée).
  fastify.post<{ Params: { id: string; pid: string } }>(
    "/api/containers/:id/processes/:pid/restart",
    async (request, reply) => {
      const pid = Number(request.params.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return reply.code(400).send({ error: "pid must be a positive integer" });
      }

      try {
        const result = await restartContainerProcess(request.params.id, pid);
        if (result.wasPidOne) {
          return reply.code(409).send({
            error: "Refusing to restart PID 1 directly: this would restart the entire container. Use the container restart action instead.",
            useContainerRestartInstead: true,
          });
        }
        return reply.send({ ok: true });
      } catch (err) {
        sendProcessActionError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>("/api/containers/:id/start", async (request, reply) => {
    try {
      await startContainer(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string } }>("/api/containers/:id/stop", async (request, reply) => {
    try {
      await stopContainer(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string } }>("/api/containers/:id/restart", async (request, reply) => {
    try {
      await restartContainer(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      sendDockerActionError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string }; Body: RenameContainerBody }>(
    "/api/containers/:id/rename",
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        return reply.code(400).send({ error: "name is required" });
      }
      try {
        await renameContainer(request.params.id, name);
        // Garde `usedBy` (SecretsPage.tsx) à jour avec le nom réel — sans ça, un secret lié à ce
        // conteneur continuerait d'afficher son ancien nom après renommage.
        await renameSecretUsageContainer(request.params.id, name);
        const containers = await getDockerContainers();
        return reply.send({ ok: true, containers });
      } catch (err) {
        sendDockerActionError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/containers/:id",
    async (request, reply) => {
      try {
        await removeContainer(request.params.id, request.query.force === "true");
        // Nettoyage immédiat et précis (suppression CONFIRMÉE) plutôt que d'attendre le filet de
        // sécurité lazy de GET /api/secrets (purgeStaleSecretUsages) — voir secretsStore.ts.
        await removeSecretUsagesForContainer(request.params.id);
        return reply.send({ ok: true });
      } catch (err) {
        sendDockerActionError(reply, err);
      }
    },
  );

  // Hexdump en lecture seule d'un fichier ARBITRAIRE dans un conteneur — voir en-tête de fichier
  // et services/docker.ts#readContainerFileHexdump. ADMIN UNIQUEMENT (rejectIfNotAdmin ci-dessus) ;
  // `path` (obligatoire) validé/normalisé côté service (jamais ici) — toute tentative de ".."
  // ou de chemin relatif est rejetée en 400 AVANT tout appel Docker. `offset`/`length` en
  // querystring (chaînes) -> Number() ci-dessous ; NaN/valeurs invalides sont rejetées par
  // readContainerFileHexdump lui-même (Number.isInteger), jamais tolérées silencieusement.
  fastify.get<{ Params: { id: string }; Querystring: FileHexdumpQuery }>(
    "/api/containers/:id/files/hexdump",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const rawPath = request.query?.path;
      if (!rawPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const offsetRaw = request.query?.offset;
      const lengthRaw = request.query?.length;
      const offset = offsetRaw !== undefined ? Number(offsetRaw) : 0;
      const length = lengthRaw !== undefined ? Number(lengthRaw) : 512;

      try {
        const dump = await readContainerFileHexdump(request.params.id, rawPath, offset, length);
        return reply.send(dump);
      } catch (err) {
        sendFileHexdumpError(reply, err);
      }
    },
  );
}
