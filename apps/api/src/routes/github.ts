/**
 * Intégration GitHub (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") — QUAI parcourt les
 * VRAIS repos accessibles avec un jeton GitHub configuré, détecte réellement les fichiers
 * présents à la racine, clone/build/déploie réellement (ou crée un workspace IaC pour Terraform).
 *
 * GET  /api/github/status                          — jeton dédié configuré ou non (jamais le jeton).
 * PUT  /api/github/token                            — { token } admin uniquement, chiffré au repos.
 * GET  /api/github/repos                            — vraie liste des repos accessibles.
 * GET  /api/github/repos/:owner/:repo/detect        — ?ref= optionnel ; détection racine (Dockerfile/compose/terraform).
 * POST /api/github/repos/:owner/:repo/deploy        — { ref?, targetEnvironmentId? } — operator/admin (hook global).
 * GET  /api/github/deployments                      — historique.
 * GET  /api/github/deployments/:id                  — détail + log complet (à poller pendant qu'il tourne).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getStatus, setToken } from "../services/githubStore.js";
import {
  detectRepo,
  diagnosticFromGithubError,
  getDeploymentDetail,
  listDeployments,
  listRepos,
  startDeployment,
} from "../services/github.js";
import { RegistryCredentialsMissingError, RegistryHttpError } from "../services/registries/http.js";

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même pattern que routes/secrets.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/** Statut HTTP à renvoyer côté QUAI pour une erreur d'appel GitHub — même esprit que registries/index.ts. */
function statusFromGithubError(err: unknown): number {
  if (err instanceof RegistryCredentialsMissingError) return 400;
  if (err instanceof RegistryHttpError) {
    if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 429) return err.status;
    return 502;
  }
  return 500;
}

export default async function githubRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/github/status", async (_request, reply) => {
    return reply.send(await getStatus());
  });

  fastify.put<{ Body: { token?: string } }>("/api/github/token", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;
    const token = request.body?.token?.trim();
    if (!token) return reply.code(400).send({ error: "token is required" });
    await setToken(token);
    return reply.send({ ok: true });
  });

  fastify.get("/api/github/repos", async (_request, reply) => {
    try {
      return reply.send(await listRepos());
    } catch (err) {
      return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
    }
  });

  fastify.get<{ Params: { owner: string; repo: string }; Querystring: { ref?: string } }>(
    "/api/github/repos/:owner/:repo/detect",
    async (request, reply) => {
      try {
        const detection = await detectRepo(request.params.owner, request.params.repo, request.query.ref);
        return reply.send(detection);
      } catch (err) {
        return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
      }
    },
  );

  fastify.post<{
    Params: { owner: string; repo: string };
    Body: { ref?: string; targetEnvironmentId?: string };
  }>("/api/github/repos/:owner/:repo/deploy", async (request, reply) => {
    try {
      const deployment = await startDeployment({
        owner: request.params.owner,
        repo: request.params.repo,
        ...(request.body?.ref ? { ref: request.body.ref } : {}),
        ...(request.body?.targetEnvironmentId ? { targetEnvironmentId: request.body.targetEnvironmentId } : {}),
        startedBy: request.authSession!.username,
      });
      return reply.code(201).send(deployment);
    } catch (err) {
      return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
    }
  });

  fastify.get("/api/github/deployments", async (_request, reply) => {
    return reply.send(await listDeployments());
  });

  fastify.get<{ Params: { id: string } }>("/api/github/deployments/:id", async (request, reply) => {
    const detail = await getDeploymentDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: `Deployment "${request.params.id}" not found` });
    return reply.send(detail);
  });
}
