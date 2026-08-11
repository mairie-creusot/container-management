/**
 * GET    /api/reverse-proxy/routes      — liste des routes actives, ouvert à toute session
 *                                          authentifiée (cf. plugins/auth.ts).
 * POST   /api/reverse-proxy/routes      — { subdomain, targetContainerId? | targetHost?, targetPort }
 *                                          — operator/admin (hook global, aucune restriction
 *                                          supplémentaire ici contrairement à /api/secrets/*).
 * DELETE /api/reverse-proxy/routes/:id  — operator/admin.
 * POST   /api/reverse-proxy/push        — repousse la config complète vers Caddy sans rien
 *                                          changer côté QUAI (utile après un redémarrage de
 *                                          Caddy) — operator/admin.
 * GET    /api/reverse-proxy/status      — Caddy joignable ou non, même pattern que
 *                                          GET /api/scanners/status (routes/scan.ts).
 *
 * Un échec de push vers Caddy (voir services/reverseProxy.ts#CaddyPushFailedError) ne fait
 * jamais disparaître silencieusement une mutation qui a pourtant eu lieu côté QUAI : POST
 * répond quand même 201 avec la route créée (+ `caddyPushError`), DELETE répond quand même
 * `{ ok: true, caddyPushError }` — la route est bel et bien créée/supprimée localement, seul
 * le miroir Caddy n'a pas pu être mis à jour tout de suite (un re-push via POST .../push le
 * corrigera).
 */

import type { FastifyInstance } from "fastify";
import {
  CaddyPushFailedError,
  createRoute,
  deleteRoute,
  getReverseProxyStatus,
  listRoutes,
  pushConfigToCaddy,
  SubdomainConflictError,
} from "../services/reverseProxy.js";

interface CreateRouteBody {
  subdomain?: string;
  targetContainerId?: string;
  targetHost?: string;
  targetPort?: number;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

export default async function reverseProxyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/reverse-proxy/routes", async (_request, reply) => {
    return reply.send(await listRoutes());
  });

  fastify.post<{ Body: CreateRouteBody }>("/api/reverse-proxy/routes", async (request, reply) => {
    const subdomain = request.body?.subdomain?.trim();
    const targetContainerId = request.body?.targetContainerId?.trim();
    const targetHost = request.body?.targetHost?.trim();
    const targetPort = request.body?.targetPort;

    if (!subdomain) {
      return reply.code(400).send({ error: "subdomain is required" });
    }
    if (!targetContainerId && !targetHost) {
      return reply.code(400).send({ error: "targetContainerId or targetHost is required" });
    }
    if (!isValidPort(targetPort)) {
      return reply.code(400).send({ error: "targetPort must be a valid port number (1-65535)" });
    }

    try {
      const created = await createRoute({
        subdomain,
        ...(targetContainerId ? { targetContainerId } : {}),
        ...(targetHost ? { targetHost } : {}),
        targetPort,
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof SubdomainConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      if (err instanceof CaddyPushFailedError) {
        return reply.code(201).send({ ...err.route, caddyPushError: err.message });
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>("/api/reverse-proxy/routes/:id", async (request, reply) => {
    try {
      const deleted = await deleteRoute(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: `Route "${request.params.id}" not found` });
      }
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof CaddyPushFailedError) {
        return reply.send({ ok: true, caddyPushError: err.message });
      }
      throw err;
    }
  });

  fastify.post("/api/reverse-proxy/push", async (_request, reply) => {
    try {
      await pushConfigToCaddy();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/reverse-proxy/status", async (_request, reply) => {
    return reply.send(await getReverseProxyStatus());
  });
}
