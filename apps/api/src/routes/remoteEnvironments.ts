/**
 * GET    /api/remote-environments           — liste des environnements Docker distants persistés
 *                                              (jamais ca/cert/key, voir remoteDockerStore.ts#toRef).
 * POST   /api/remote-environments           — { name, host, port, tls? }, admin uniquement.
 * PATCH  /api/remote-environments/:id       — modifie nom/host/port/tls, admin uniquement.
 * DELETE /api/remote-environments/:id       — admin uniquement.
 * GET    /api/remote-environments/:id/test  — test de connectivité réel (docker.ping() sur le
 *                                              client distant résolu, voir docker.ts#getClient).
 *
 * Un environnement Docker distant est un point d'accès administratif à un démon Docker entier
 * (au même titre que le démon local) : mêmes règles d'accès que secrets.ts, plus strictes que
 * registries.ts — les mutations sont réservées au rôle admin, pas seulement operator/admin
 * (le hook global n'exige qu'operator/admin pour toute méthode mutante, voir plugins/auth.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createRemoteDockerEnvironment,
  deleteRemoteDockerEnvironment,
  getRemoteDockerEnvironmentRef,
  listRemoteDockerEnvironments,
  RemoteDockerValidationError,
  updateRemoteDockerEnvironment,
} from "../services/remoteDockerStore.js";
import type { RemoteDockerTls } from "../services/remoteDockerStore.js";
import { getClient, isDockerReachable } from "../services/docker.js";

interface TlsBody {
  ca?: string;
  cert?: string;
  key?: string;
}

interface CreateRemoteEnvironmentBody {
  name?: string;
  host?: string;
  port?: number;
  tls?: TlsBody;
}

interface UpdateRemoteEnvironmentBody {
  name?: string;
  host?: string;
  port?: number;
  tls?: TlsBody;
  clearTls?: boolean;
}

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que secrets.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

function tlsInputFromBody(tls: TlsBody | undefined): RemoteDockerTls | undefined {
  if (!tls) return undefined;
  return {
    ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
    ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
    ...(tls.key !== undefined ? { key: tls.key } : {}),
  };
}

export default async function remoteEnvironmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/remote-environments", async (_request, reply) => {
    return reply.send(await listRemoteDockerEnvironments());
  });

  fastify.post<{ Body: CreateRemoteEnvironmentBody }>("/api/remote-environments", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const name = request.body?.name?.trim();
    const host = request.body?.host?.trim();
    const port = request.body?.port;
    if (!name || !host || port === undefined) {
      return reply.code(400).send({ error: "name, host and port are required" });
    }

    try {
      const created = await createRemoteDockerEnvironment({
        name,
        host,
        port,
        ...(tlsInputFromBody(request.body?.tls) ? { tls: tlsInputFromBody(request.body?.tls)! } : {}),
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof RemoteDockerValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/remote-environments/:id", async (request, reply) => {
    const found = await getRemoteDockerEnvironmentRef(request.params.id);
    if (!found) {
      return reply.code(404).send({ error: `Remote Docker environment "${request.params.id}" not found` });
    }
    return reply.send(found);
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateRemoteEnvironmentBody }>(
    "/api/remote-environments/:id",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const { name, host, port, tls, clearTls } = request.body ?? {};
      try {
        const updated = await updateRemoteDockerEnvironment(request.params.id, {
          ...(name !== undefined ? { name } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(tlsInputFromBody(tls) ? { tls: tlsInputFromBody(tls)! } : {}),
          ...(clearTls !== undefined ? { clearTls } : {}),
        });
        if (!updated) {
          return reply.code(404).send({ error: `Remote Docker environment "${request.params.id}" not found` });
        }
        return reply.send(updated);
      } catch (err) {
        if (err instanceof RemoteDockerValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/remote-environments/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const deleted = await deleteRemoteDockerEnvironment(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: `Remote Docker environment "${request.params.id}" not found` });
    }
    return reply.send({ ok: true });
  });

  // Test de connectivité RÉEL : résout un client dockerode pour cet hôte distant précis (voir
  // docker.ts#getClient) et appelle docker.ping() dessus — jamais un simple "host looks valid".
  fastify.get<{ Params: { id: string } }>("/api/remote-environments/:id/test", async (request, reply) => {
    const found = await getRemoteDockerEnvironmentRef(request.params.id);
    if (!found) {
      return reply.code(404).send({ error: `Remote Docker environment "${request.params.id}" not found` });
    }
    try {
      const docker = await getClient(request.params.id);
      const reachable = await isDockerReachable(docker);
      return reply.send(
        reachable
          ? { ok: true, message: `"${found.name}" est joignable` }
          : { ok: false, message: `"${found.name}" n'a pas répondu (timeout ou connexion refusée)` },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, message });
    }
  });
}
