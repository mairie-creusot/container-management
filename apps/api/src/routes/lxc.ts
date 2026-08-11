/**
 * GET    /api/lxc/containers   — instances LXD réelles (nom, statut, architecture, type). Renvoie
 *                                 [] si LXD n'a jamais été configuré, ou si configuré mais
 *                                 injoignable — voir services/lxc.ts#getLxcContainers (aucune
 *                                 transformation supplémentaire nécessaire ici, la forme est déjà
 *                                 LxcContainer[]). Branchée dès sa création (contrairement à
 *                                 GET /api/nutanix/vms, resté du code mort un temps).
 * GET    /api/lxc/config       — { configured, endpoint?, updatedAt? }, jamais le certificat/la clé.
 * PUT    /api/lxc/config       — { endpoint, clientCert, clientKey }, admin uniquement.
 * DELETE /api/lxc/config       — admin uniquement.
 * GET    /api/lxc/config/test  — test de connectivité réel contre la config persistée
 *                                 (GET /1.0/instances authentifié par certificat client).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getLxcContainers, testLxcConnection } from "../services/lxc.js";
import { clearLxcConfig, getEffectiveLxcConfig, getLxcConfigRef, LxcValidationError, setLxcConfig } from "../services/lxcStore.js";

interface SetLxcConfigBody {
  endpoint?: string;
  clientCert?: string;
  clientKey?: string;
}

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que secrets.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

export default async function lxcRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/lxc/containers", async (_request, reply) => {
    return reply.send(await getLxcContainers());
  });

  fastify.get("/api/lxc/config", async (_request, reply) => {
    return reply.send(await getLxcConfigRef());
  });

  fastify.put<{ Body: SetLxcConfigBody }>("/api/lxc/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const endpoint = request.body?.endpoint?.trim();
    const clientCert = request.body?.clientCert?.trim();
    const clientKey = request.body?.clientKey?.trim();
    if (!endpoint || !clientCert || !clientKey) {
      return reply.code(400).send({ error: "endpoint, clientCert and clientKey are required" });
    }

    try {
      const saved = await setLxcConfig({ endpoint, clientCert, clientKey });
      return reply.code(201).send(saved);
    } catch (err) {
      if (err instanceof LxcValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.delete("/api/lxc/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;
    await clearLxcConfig();
    return reply.send({ ok: true });
  });

  // Test de connectivité RÉEL contre la config persistée — jamais contre une config candidate
  // non enregistrée (contrairement à /api/setup/test/nutanix) : pas d'assistant LXC dans ce
  // premier lot, la config est déjà écrite avant de pouvoir la tester.
  fastify.get("/api/lxc/config/test", async (_request, reply) => {
    const effective = await getEffectiveLxcConfig();
    if (!effective) {
      return reply.send({ ok: false, message: "LXD is not configured" });
    }
    const result = await testLxcConnection(effective.endpoint, effective.clientCert, effective.clientKey);
    return reply.send(result);
  });
}
