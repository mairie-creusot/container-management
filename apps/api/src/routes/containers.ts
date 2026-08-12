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
 * POST   /api/containers/:id/start     — démarre un conteneur arrêté.
 * POST   /api/containers/:id/stop      — arrête un conteneur en cours d'exécution.
 * POST   /api/containers/:id/restart   — redémarre un conteneur.
 * POST   /api/containers/:id/rename    — renomme un conteneur (équivalent `docker rename`).
 * DELETE /api/containers/:id           — supprime un conteneur (?force=true pour un conteneur en cours d'exécution).
 *
 * `secretEnv` résolu avec succès sur POST /api/containers enregistre aussi le lien secret<->
 * conteneur (services/secretsStore.ts#recordSecretUsage, exposé via `usedBy` sur SecretRef) —
 * maintenu à jour par renameSecretUsageContainer/removeSecretUsagesForContainer sur rename/delete.
 */

import type { FastifyInstance } from "fastify";
import {
  createAndStartContainer,
  getContainerProcesses,
  getDockerContainers,
  inspectDockerContainer,
  removeContainer,
  renameContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from "../services/docker.js";
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
}
