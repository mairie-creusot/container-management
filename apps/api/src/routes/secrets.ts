/**
 * GET    /api/secrets       — liste des secrets (id/name/description/dates, JAMAIS la valeur),
 *                              ouvert à toute session authentifiée (cf. plugins/auth.ts).
 * POST   /api/secrets       — { name, value, description? }, admin uniquement.
 * PATCH  /api/secrets/:id   — { name?, value?, description? }, value omise/vide = valeur
 *                              conservée, admin uniquement.
 * DELETE /api/secrets/:id   — admin uniquement.
 *
 * Un secret est plus sensible qu'un registry (routes/registries.ts, operator/admin suffit) :
 * le hook global (plugins/auth.ts) exige déjà operator/admin pour toute méthode mutante, mais
 * on restreint explicitement les 3 handlers mutants ci-dessous à "admin" — même principe que
 * requireAdmin pour /api/setup/* une fois l'assistant terminé.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSecret,
  deleteSecret,
  listSecrets,
  SecretNameConflictError,
  updateSecret,
} from "../services/secretsStore.js";

interface CreateSecretBody {
  name?: string;
  value?: string;
  description?: string;
}

interface UpdateSecretBody {
  name?: string;
  value?: string;
  description?: string;
}

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

export default async function secretsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/secrets", async (_request, reply) => {
    return reply.send(await listSecrets());
  });

  fastify.post<{ Body: CreateSecretBody }>("/api/secrets", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const name = request.body?.name?.trim();
    const value = request.body?.value;
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (!value) {
      return reply.code(400).send({ error: "value is required" });
    }
    const description = request.body?.description?.trim();

    try {
      const created = await createSecret({ name, value, ...(description ? { description } : {}) });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof SecretNameConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateSecretBody }>(
    "/api/secrets/:id",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const { name, value, description } = request.body ?? {};
      if (name !== undefined && !name.trim()) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }

      try {
        const updated = await updateSecret(request.params.id, {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(value ? { value } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        if (!updated) {
          return reply.code(404).send({ error: `Secret "${request.params.id}" not found` });
        }
        return reply.send(updated);
      } catch (err) {
        if (err instanceof SecretNameConflictError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/secrets/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const deleted = await deleteSecret(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: `Secret "${request.params.id}" not found` });
    }
    return reply.send({ ok: true });
  });
}
