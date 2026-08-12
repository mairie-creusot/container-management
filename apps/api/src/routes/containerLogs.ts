/**
 * GET /api/containers/:id/logs?tail=<n>             — snapshot instantané des derniers logs
 *   (équivalent `docker logs --timestamps --tail <n> <id>`), utilisé pour un premier affichage
 *   immédiat avant que le flux WebSocket ci-dessous ne prenne le relais.
 * GET (WebSocket) /api/containers/:id/logs/stream?tail=<n> — flux temps réel équivalent
 *   `docker logs -f --timestamps --tail <n> <id>`, relayé tel quel (texte déjà démultiplexé côté
 *   services/docker.ts#streamContainerLogs) vers le socket du navigateur.
 *
 * Rôle — DÉLIBÉRÉMENT différent de routes/console.ts. La console ouvre un VRAI shell interactif
 * (docker exec) dans le conteneur : exécuter des commandes exige operator/admin. Consulter des
 * logs est une opération strictement en LECTURE SEULE (rien n'est jamais relayé du navigateur
 * vers dockerode ici, contrairement à la console) — même niveau d'accès que GET /api/volumes/:
 * name/files ou GET /api/containers/:id : aucune restriction de rôle au-delà d'une session valide,
 * déjà appliquée par le hook global (plugins/auth.ts) à toute requête `/api/*`, y compris la
 * requête HTTP d'upgrade WebSocket (même garde vérifiée réellement que routes/console.ts).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type WebSocket from "ws";
import { getContainerLogs, streamContainerLogs } from "../services/docker.js";

const DEFAULT_TAIL = 200;
const MAX_TAIL = 5000;

/**
 * `tail` accepte explicitement "0" (voir services/docker.ts#streamContainerLogs — le frontend
 * l'utilise après avoir déjà chargé un snapshot via GET .../logs, pour ne pas dupliquer les
 * lignes déjà affichées) : seul un paramètre absent ou invalide retombe sur DEFAULT_TAIL.
 */
function parseTail(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TAIL;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TAIL;
  return Math.min(parsed, MAX_TAIL);
}

/** Même traduction d'erreur dockerode -> HTTP que routes/containers.ts#sendDockerActionError
 * (404 conteneur introuvable, 502 pour le reste — démon injoignable...) : pas de dépendance
 * croisée entre les deux fichiers de routes pour une fonction aussi courte. */
function sendDockerActionError(reply: FastifyReply, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const notFound = /no such container|404/i.test(message);
  reply.code(notFound ? 404 : 502).send({ error: message });
}

export default async function containerLogsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/containers/:id/logs",
    async (request, reply) => {
      try {
        const logs = await getContainerLogs(request.params.id, parseTail(request.query?.tail));
        return reply.send({ logs });
      } catch (err) {
        sendDockerActionError(reply, err);
      }
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/containers/:id/logs/stream",
    { websocket: true },
    async (socket: WebSocket, request) => {
      let session: Awaited<ReturnType<typeof streamContainerLogs>>;
      try {
        session = await streamContainerLogs(request.params.id, { tail: parseTail(request.query?.tail) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.warn({ err, containerId: request.params.id }, "containerLogs: failed to open log stream");
        socket.send(`[quai] ${message}\n`);
        socket.close(4404, message.slice(0, 120));
        return;
      }

      const { stream } = session;
      let closed = false;

      function closeAll() {
        if (closed) return;
        closed = true;
        try {
          if (typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === "function") {
            (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
          }
        } catch {
          // flux déjà terminé côté dockerode.
        }
        try {
          if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
            socket.close();
          }
        } catch {
          // socket déjà fermé côté client.
        }
      }

      // dockerode -> socket UNIQUEMENT : contrairement à routes/console.ts, ce flux est en
      // lecture seule — aucun `socket.on("message", ...)` n'écrit jamais vers dockerode ici.
      stream.on("data", (chunk: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      });
      stream.on("error", (err: Error) => {
        request.log.warn({ err, containerId: request.params.id }, "containerLogs: log stream error");
        closeAll();
      });
      stream.on("end", closeAll);
      stream.on("close", closeAll);

      socket.on("close", closeAll);
      socket.on("error", () => closeAll());

      request.log.info(
        { containerId: request.params.id, actor: request.authSession?.username },
        "containerLogs: stream opened",
      );
    },
  );
}
