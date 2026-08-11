/**
 * Infra-as-code (OpenTofu / Ansible / Packer) — QUAI pilote les vrais binaires (voir
 * services/iac/*), aucune réimplémentation.
 *
 * GET    /api/iac/engines                          — disponibilité + version des 3 outils.
 * GET    /api/iac/workspaces                        — liste.
 * POST   /api/iac/workspaces                        — { name, engine } (operator/admin).
 * DELETE /api/iac/workspaces/:id                    — (operator/admin).
 * GET    /api/iac/workspaces/:id/files               — liste des fichiers.
 * GET    /api/iac/workspaces/:id/files/:path         — contenu d'un fichier (:path encodé, cf. gitops.ts).
 * PUT    /api/iac/workspaces/:id/files/:path         — écrit un fichier (operator/admin).
 * POST   /api/iac/workspaces/:id/run                 — { action } lance une vraie commande (operator/admin).
 * GET    /api/iac/workspaces/:id/runs                — historique des runs.
 * GET    /api/iac/workspaces/:id/runs/:runId         — statut + log complet d'un run (à poller pendant qu'il tourne).
 */

import type { FastifyInstance } from "fastify";
import { listEngineStatuses } from "../services/iac/engines.js";
import {
  createWorkspace,
  deleteFile,
  deleteWorkspace,
  listFiles,
  listWorkspaces,
  readFile,
  writeFile,
  WorkspaceNotFoundError,
} from "../services/iac/workspaces.js";
import { getRun, listRuns, readRunLog, startRun } from "../services/iac/runner.js";
import type { IacEngine } from "../types.js";

const VALID_ENGINES: readonly IacEngine[] = ["tofu", "ansible", "packer"];

export default async function iacRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/iac/engines", async (_request, reply) => {
    return reply.send(await listEngineStatuses());
  });

  fastify.get("/api/iac/workspaces", async (_request, reply) => {
    return reply.send(await listWorkspaces());
  });

  fastify.post<{ Body: { name?: string; engine?: string } }>("/api/iac/workspaces", async (request, reply) => {
    const { name, engine } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: "name is required" });
    if (!engine || !VALID_ENGINES.includes(engine as IacEngine)) {
      return reply.code(400).send({ error: `engine must be one of: ${VALID_ENGINES.join(", ")}` });
    }
    const workspace = await createWorkspace({
      name: name.trim(),
      engine: engine as IacEngine,
      createdBy: request.authSession!.username,
    });
    return reply.code(201).send(workspace);
  });

  fastify.delete<{ Params: { id: string } }>("/api/iac/workspaces/:id", async (request, reply) => {
    try {
      await deleteWorkspace(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/iac/workspaces/:id/files", async (request, reply) => {
    return reply.send(await listFiles(request.params.id));
  });

  fastify.get<{ Params: { id: string; path: string } }>(
    "/api/iac/workspaces/:id/files/:path",
    async (request, reply) => {
      try {
        const content = await readFile(request.params.id, request.params.path);
        return reply.send({ path: request.params.path, content });
      } catch {
        return reply.code(404).send({ error: `File "${request.params.path}" not found` });
      }
    },
  );

  fastify.put<{ Params: { id: string; path: string }; Body: { content?: string } }>(
    "/api/iac/workspaces/:id/files/:path",
    async (request, reply) => {
      const content = request.body?.content;
      if (content === undefined) return reply.code(400).send({ error: "content is required" });
      await writeFile(request.params.id, request.params.path, content);
      return reply.send({ ok: true });
    },
  );

  fastify.delete<{ Params: { id: string; path: string } }>(
    "/api/iac/workspaces/:id/files/:path",
    async (request, reply) => {
      await deleteFile(request.params.id, request.params.path);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { id: string }; Body: { action?: string; engine?: string } }>(
    "/api/iac/workspaces/:id/run",
    async (request, reply) => {
      const { action, engine } = request.body ?? {};
      if (!action || !engine) return reply.code(400).send({ error: "action and engine are required" });
      try {
        const run = await startRun(request.params.id, engine as IacEngine, action, request.authSession!.username);
        return reply.code(201).send(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/iac/workspaces/:id/runs", async (request, reply) => {
    return reply.send(await listRuns(request.params.id));
  });

  fastify.get<{ Params: { id: string; runId: string } }>(
    "/api/iac/workspaces/:id/runs/:runId",
    async (request, reply) => {
      const run = await getRun(request.params.id, request.params.runId);
      if (!run) return reply.code(404).send({ error: `Run "${request.params.runId}" not found` });
      const log = await readRunLog(request.params.id, request.params.runId);
      return reply.send({ ...run, log });
    },
  );
}
