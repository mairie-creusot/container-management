/**
 * GET  /api/gitops/files            — manifestes GitOps (désiré/réel/dérive).
 * GET  /api/gitops/files/:path/diff — diff détaillé d'un manifeste (via @quai/wasm-core).
 * GET  /api/gitops/commits          — historique Git du dossier GitOps.
 * POST /api/gitops/sync             — resynchronisation explicite (rôle operator/admin requis).
 */

import type { FastifyInstance } from "fastify";
import { getCommits, getGitOpsFileDiff, listGitOpsFiles, sync } from "../services/gitops.js";

export default async function gitopsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/gitops/files", async (_request, reply) => {
    const files = await listGitOpsFiles();
    return reply.send(files);
  });

  // Le chemin d'un fichier GitOps peut contenir des "/" (ex: "prod/nginx.yaml") : le
  // routeur Fastify (find-my-way) ne supporte pas de wildcard au milieu d'un chemin, donc
  // le client doit URL-encoder les "/" du :path (ex: "prod%2Fnginx.yaml"). Fastify décode
  // automatiquement les paramètres de route.
  fastify.get<{ Params: { path: string } }>("/api/gitops/files/:path/diff", async (request, reply) => {
    const filePath = request.params.path;
    const result = await getGitOpsFileDiff(filePath);
    if (!result) {
      return reply.code(404).send({ error: `GitOps file "${filePath}" not found` });
    }
    // Le contrat documenté (ARCHITECTURE.md, types.ts#DiffResult) est { lines, hasDrift } —
    // getGitOpsFileDiff() renvoie aussi le fichier source en interne, à ne pas exposer ici
    // (le frontend l'a déjà via GET /api/gitops/files, et faisait `diff.lines.map(...)` sur
    // ce corps de réponse en s'attendant à un DiffResult direct, d'où le crash).
    return reply.send(result.diff);
  });

  fastify.get("/api/gitops/commits", async (_request, reply) => {
    const commits = await getCommits();
    return reply.send(commits);
  });

  fastify.post("/api/gitops/sync", async (_request, reply) => {
    const result = await sync();
    return reply.send(result);
  });
}
