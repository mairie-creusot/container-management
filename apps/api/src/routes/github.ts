/**
 * Intégration GitHub (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") — QUAI parcourt les
 * VRAIS repos accessibles avec un jeton GitHub configuré, détecte réellement les fichiers
 * présents à la racine, clone/build/déploie réellement (ou crée un workspace IaC pour Terraform).
 *
 * GET  /api/github/status                          — jeton dédié configuré ou non (jamais le jeton).
 * PUT  /api/github/token                            — { token } admin uniquement, chiffré au repos.
 * GET  /api/github/repos                            — vraie liste des repos accessibles.
 * GET  /api/github/repos/:owner/:repo/detect        — ?ref= optionnel ; détection racine (Dockerfile/compose/terraform, port EXPOSE).
 * POST /api/github/repos/:owner/:repo/deploy        — { ref?, targetEnvironmentId?, subdomain?, port? } — operator/admin (hook global).
 * GET  /api/github/deployments                      — historique.
 * GET  /api/github/deployments/:id                  — détail + log complet (à poller pendant qu'il tourne).
 * GET  /api/github/repos/:owner/:repo/auto-deploy    — statut du déploiement automatique sur push (jamais le secret webhook).
 * PUT  /api/github/repos/:owner/:repo/auto-deploy    — { enabled, branch?, targetEnvironmentId?, subdomain?, port? } — operator/admin
 *                                                       (hook global) ; enregistre/supprime réellement le webhook GitHub.
 *
 * Le webhook entrant lui-même (POST /api/github/webhook, appelé par GitHub — pas de session) vit
 * dans routes/githubWebhook.ts, volontairement séparé (authentification différente : signature
 * HMAC plutôt que cookie de session, voir plugins/auth.ts).
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  getAutoDeployHookId,
  getAutoDeployStatus,
  getEffectiveToken,
  getExistingAutoDeploySecret,
  getStatus,
  saveAutoDeployEntry,
  setToken,
} from "../services/githubStore.js";
import {
  createRepoWebhook,
  deleteRepoWebhook,
  detectRepo,
  diagnosticFromGithubError,
  getDeploymentDetail,
  listDeployments,
  listRepos,
  startDeployment,
} from "../services/github.js";
import { isValidSubdomain } from "../services/reverseProxy.js";
import { RegistryCredentialsMissingError, RegistryHttpError } from "../services/registries/http.js";
import type { GithubAutoDeployStatus } from "../types.js";

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même pattern que routes/secrets.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/** Même validation que routes/reverseProxy.ts#isValidPort — port TCP valide (1-65535). */
function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
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
    Body: { ref?: string; targetEnvironmentId?: string; subdomain?: string; port?: number };
  }>("/api/github/repos/:owner/:repo/deploy", async (request, reply) => {
    const subdomain = request.body?.subdomain?.trim().toLowerCase();
    if (subdomain && !isValidSubdomain(subdomain)) {
      return reply.code(400).send({
        error: `"${subdomain}" is not a valid DNS subdomain (letters, digits, hyphens and dots only, e.g. "monapp.lecreusot.priv")`,
      });
    }
    const port = request.body?.port;
    if (port !== undefined && !isValidPort(port)) {
      return reply.code(400).send({ error: "port must be a valid port number (1-65535)" });
    }
    try {
      const deployment = await startDeployment({
        owner: request.params.owner,
        repo: request.params.repo,
        ...(request.body?.ref ? { ref: request.body.ref } : {}),
        ...(request.body?.targetEnvironmentId ? { targetEnvironmentId: request.body.targetEnvironmentId } : {}),
        ...(subdomain ? { subdomain } : {}),
        ...(port !== undefined ? { port } : {}),
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

  // --- Déploiement automatique sur push (webhook GitHub réel — cf. routes/githubWebhook.ts) ----

  fastify.get<{ Params: { owner: string; repo: string } }>(
    "/api/github/repos/:owner/:repo/auto-deploy",
    async (request, reply) => {
      const { owner, repo } = request.params;
      const existing = await getAutoDeployStatus(owner, repo);
      if (existing) return reply.send(existing);
      // Jamais configuré pour ce dépôt : statut honnête "désactivé", branche par défaut
      // pré-remplie (résolue en direct) pour que le formulaire du front n'ait rien à taper.
      try {
        const detection = await detectRepo(owner, repo);
        const status: GithubAutoDeployStatus = { owner, repo, enabled: false, branch: detection.ref, updatedAt: null };
        return reply.send(status);
      } catch (err) {
        return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
      }
    },
  );

  fastify.put<{
    Params: { owner: string; repo: string };
    Body: { enabled?: boolean; branch?: string; targetEnvironmentId?: string; subdomain?: string; port?: number };
  }>("/api/github/repos/:owner/:repo/auto-deploy", async (request, reply) => {
    const { owner, repo } = request.params;
    const enabled = Boolean(request.body?.enabled);
    const subdomain = request.body?.subdomain?.trim().toLowerCase();
    if (subdomain && !isValidSubdomain(subdomain)) {
      return reply.code(400).send({
        error: `"${subdomain}" is not a valid DNS subdomain (letters, digits, hyphens and dots only, e.g. "monapp.lecreusot.priv")`,
      });
    }
    const port = request.body?.port;
    if (port !== undefined && !isValidPort(port)) {
      return reply.code(400).send({ error: "port must be a valid port number (1-65535)" });
    }

    try {
      const effective = await getEffectiveToken();
      const token = effective?.token;
      const branch = request.body?.branch?.trim() || (await detectRepo(owner, repo)).ref;
      const existingHookId = await getAutoDeployHookId(owner, repo);

      if (enabled) {
        if (!config.github.webhookBaseUrl) {
          return reply.code(400).send({
            error:
              "Aucune URL publique de webhook configurée (GITHUB_WEBHOOK_BASE_URL) — GitHub doit pouvoir joindre cette API pour déclencher un déploiement automatique.",
          });
        }
        const webhookUrl = `${config.github.webhookBaseUrl.replace(/\/+$/, "")}/api/github/webhook`;
        // Réutilise le secret existant s'il y en a déjà un pour ce dépôt (ré-activation après une
        // désactivation) plutôt que d'en régénérer un et de devoir recréer le hook GitHub à
        // chaque fois — un secret HMAC n'a pas besoin de tourner à chaque toggle.
        const secret = (await getExistingAutoDeploySecret(owner, repo)) ?? randomBytes(32).toString("hex");
        // Un hook déjà enregistré pour une config précédente (désactivée puis réactivée) est
        // réutilisé tel quel plutôt que d'en créer un doublon côté GitHub.
        const hookId = existingHookId ?? (await createRepoWebhook(owner, repo, webhookUrl, secret, token));
        const status = await saveAutoDeployEntry({
          owner,
          repo,
          branch,
          enabled: true,
          hookId,
          secret,
          ...(request.body?.targetEnvironmentId ? { targetEnvironmentId: request.body.targetEnvironmentId } : {}),
          ...(subdomain ? { subdomain } : {}),
          ...(port !== undefined ? { port } : {}),
        });
        return reply.send(status);
      }

      // Désactivation : supprime réellement le webhook côté GitHub (best-effort — un hook déjà
      // supprimé manuellement, ou un jeton qui n'a plus les droits, ne doit pas empêcher de
      // marquer la config désactivée localement, seule protection qui compte vraiment côté QUAI
      // puisque routes/githubWebhook.ts vérifie `enabled` avant tout déclenchement).
      if (existingHookId) {
        await deleteRepoWebhook(owner, repo, existingHookId, token).catch(() => undefined);
      }
      const secret = (await getExistingAutoDeploySecret(owner, repo)) ?? randomBytes(32).toString("hex");
      const status = await saveAutoDeployEntry({
        owner,
        repo,
        branch,
        enabled: false,
        secret,
        ...(request.body?.targetEnvironmentId ? { targetEnvironmentId: request.body.targetEnvironmentId } : {}),
        ...(subdomain ? { subdomain } : {}),
        ...(port !== undefined ? { port } : {}),
      });
      return reply.send(status);
    } catch (err) {
      return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
    }
  });
}
