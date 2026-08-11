/**
 * GET (WebSocket) /api/console/:id — terminal interactif réel dans un conteneur EN COURS
 * D'EXÉCUTION (équivalent `docker exec -it <id> sh`), relayé bidirectionnellement entre le
 * flux dockerode (services/docker.ts#openContainerConsole) et le socket du navigateur.
 *
 * Sécurité :
 * - Le hook global `preHandler` (plugins/auth.ts) s'applique à toute requête `/api/*`, y
 *   compris la requête HTTP d'upgrade WebSocket (vérifié réellement, pas supposé — voir le
 *   rapport de test manuel) : il exige déjà une session valide (401 sinon) et peuple
 *   `request.authSession`. Il n'exige en revanche le rôle operator/admin QUE pour les méthodes
 *   mutantes (POST/PUT/PATCH/DELETE) — une requête d'upgrade WS est un GET, donc le hook
 *   global ne suffit PAS ici : on ajoute un hook `preHandler` supplémentaire, local à ce
 *   plugin, qui exige explicitement operator/admin AVANT que l'upgrade WebSocket ne soit
 *   accepté (une réponse 401/403 classique à ce stade empêche l'upgrade, contrairement à un
 *   refus une fois la connexion WS déjà établie).
 * - Un conteneur non `running` est refusé avec un message clair (voir
 *   services/docker.ts#openContainerConsole), jamais un exec ouvert dans le vide.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { openContainerConsole } from "../services/docker.js";

const PRIVILEGED_ROLES: ReadonlyArray<string> = ["operator", "admin"];

/** true (et réponse déjà envoyée) si la requête n'a pas le rôle operator/admin. */
function rejectIfNotPrivileged(request: FastifyRequest, reply: FastifyReply): boolean {
  // Le hook global (plugins/auth.ts) a déjà envoyé un 401 et interrompu la requête si la
  // session est absente/invalide avant que ce hook ne s'exécute — `authSession` est donc
  // garanti défini ici, même principe que routes/secrets.ts#rejectIfNotAdmin.
  const roles = request.authSession?.roles ?? [];
  const hasPrivilegedRole = roles.some((role) => PRIVILEGED_ROLES.includes(role));
  if (!hasPrivilegedRole) {
    reply.code(403).send({ error: "Insufficient role: operator or admin required" });
    return true;
  }
  return false;
}

export default async function consoleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/console/")) return;
    if (rejectIfNotPrivileged(request, reply)) return reply;
  });

  fastify.get<{ Params: { id: string } }>(
    "/api/console/:id",
    { websocket: true },
    async (socket: WebSocket, request) => {
      let session: Awaited<ReturnType<typeof openContainerConsole>>;
      try {
        session = await openContainerConsole(request.params.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.warn({ err, containerId: request.params.id }, "console: failed to open container exec");
        socket.send(`\r\n[quai] ${message}\r\n`);
        socket.close(4404, message.slice(0, 120));
        return;
      }

      const { stream, exec } = session;
      let closed = false;

      function closeAll() {
        if (closed) return;
        closed = true;
        try {
          stream.end();
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

      // exec -> socket (sortie du terminal, y compris stderr : Tty:true fusionne déjà les
      // deux flux côté Docker, pas de démultiplexage nécessaire ici contrairement à
      // listVolumeFiles ci-dessus qui tourne, lui, sans Tty).
      stream.on("data", (chunk: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      });
      stream.on("error", (err: Error) => {
        request.log.warn({ err, containerId: request.params.id }, "console: exec stream error");
        closeAll();
      });
      stream.on("end", closeAll);
      stream.on("close", closeAll);

      // socket -> exec (saisie clavier du terminal).
      socket.on("message", (data: Buffer) => {
        try {
          stream.write(data);
        } catch {
          // exec déjà terminé côté dockerode — rien à écrire.
        }
      });
      socket.on("close", closeAll);
      socket.on("error", () => closeAll());

      request.log.info(
        { containerId: request.params.id, execId: exec.id, actor: request.authSession?.username },
        "console: session opened",
      );
    },
  );
}
