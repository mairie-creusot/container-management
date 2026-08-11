/**
 * GET    /api/containers               — conteneurs Docker/Swarm + pods Kubernetes, vue unifiée.
 * POST   /api/containers               — crée puis démarre un conteneur Docker (équivalent `docker run -d`).
 *                                         L'image doit déjà être locale (POST /api/images/pull d'abord si besoin).
 * GET    /api/containers/:id           — détail complet (équivalent `docker inspect`), Docker uniquement.
 * POST   /api/containers/:id/start     — démarre un conteneur arrêté.
 * POST   /api/containers/:id/stop      — arrête un conteneur en cours d'exécution.
 * POST   /api/containers/:id/restart   — redémarre un conteneur.
 * POST   /api/containers/:id/rename    — renomme un conteneur (équivalent `docker rename`).
 * DELETE /api/containers/:id           — supprime un conteneur (?force=true pour un conteneur en cours d'exécution).
 */

import type { FastifyInstance } from "fastify";
import {
  createAndStartContainer,
  getDockerContainers,
  inspectDockerContainer,
  removeContainer,
  renameContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from "../services/docker.js";
import { getKubernetesContainers } from "../services/kubernetes.js";
import { getDecryptedSecretValue } from "../services/secretsStore.js";

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
  reply.code(notFound ? 404 : 502).send({ error: message });
}

export default async function containersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/containers", async (_request, reply) => {
    const [dockerContainers, kubernetesContainers] = await Promise.all([
      getDockerContainers(),
      getKubernetesContainers(),
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

    // Résolution des secrets référencés par nom (jamais côté client) — TOUJOURS avant l'appel
    // à createAndStartContainer : un secretName introuvable doit faire échouer la requête
    // entière en 400, jamais créer le conteneur avec un env partiellement résolu.
    const secretEnv: string[] = [];
    for (const ref of request.body?.secretEnv ?? []) {
      const key = ref.key?.trim();
      const secretName = ref.secretName?.trim();
      if (!key || !secretName) {
        return reply.code(400).send({ error: "secretEnv entries require both key and secretName" });
      }
      const value = await getDecryptedSecretValue(secretName);
      if (value === null) {
        return reply.code(400).send({ error: `Secret "${secretName}" not found` });
      }
      secretEnv.push(`${key}=${value}`);
    }

    try {
      const created = await createAndStartContainer({
        image,
        ...(name ? { name } : {}),
        ports,
        env: [...env, ...secretEnv],
        volumes,
        ...(network ? { network } : {}),
      });
      const containers = await getDockerContainers();
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
    return reply.send(detail);
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
        return reply.send({ ok: true });
      } catch (err) {
        sendDockerActionError(reply, err);
      }
    },
  );
}
