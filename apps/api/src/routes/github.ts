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
 * GET  /api/github/repos/:owner/:repo/config-schema  — ?ref=&path= optionnels ; ce qui peut/doit être configuré avant déploiement
 *                                                       (variables d'environnement manquantes, ports, volumes, ARG Dockerfile) —
 *                                                       jamais une vraie valeur de secret, voir DeployConfigSchema (types.ts).
 * PUT  /api/github/repos/:owner/:repo/config-values  — { values?: Record<string,string>, secretRefs?: Record<string,string> } —
 *                                                       operator/admin (hook global) ; stocke les valeurs (littérales et/ou
 *                                                       références vers un secret DÉJÀ existant, vérifié avant enregistrement)
 *                                                       comme secret nommé "github-env:<owner>/<repo>" (secretsStore.ts),
 *                                                       réutilisé automatiquement à chaque redéploiement suivant.
 *
 * GET    /api/github/repos/:owner/:repo/overridable-files — ?ref=&path= optionnels ; fichiers détectés potentiellement
 *                                                             surchargeables (Dockerfile/compose/*.tf/playbook Ansible).
 * GET    /api/github/repos/:owner/:repo/file-content        — ?path=&ref=&source=original|override ; contenu d'UN fichier.
 * PUT    /api/github/repos/:owner/:repo/file-overrides       — { path, content } — operator/admin (hook global) ; remplace
 *                                                               ENTIÈREMENT ce fichier au prochain déploiement de ce dépôt.
 * DELETE /api/github/repos/:owner/:repo/file-overrides       — ?path= — retour au fichier original du dépôt.
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
  buildDeployConfigSchema,
  createRepoWebhook,
  deleteFileOverride,
  deleteRepoWebhook,
  detectRepo,
  diagnosticFromGithubError,
  getDeploymentDetail,
  getGithubFileContent,
  isSafeRelativeConfigPath,
  listDeployments,
  listOverridableFiles,
  listRepos,
  saveFileOverride,
  saveGithubEnvValues,
  startDeployment,
} from "../services/github.js";
import { isValidSubdomain } from "../services/reverseProxy.js";
import { getSecretRef } from "../services/secretsStore.js";
import { RegistryCredentialsMissingError, RegistryHttpError } from "../services/registries/http.js";
import { remoteDockerIdFromEnvironmentId } from "../utils/environmentId.js";
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

  fastify.get<{ Params: { owner: string; repo: string }; Querystring: { ref?: string; path?: string } }>(
    "/api/github/repos/:owner/:repo/detect",
    async (request, reply) => {
      const explicitPath = request.query.path?.trim();
      if (explicitPath && !isSafeRelativeConfigPath(explicitPath)) {
        return reply.code(400).send({ error: `"${explicitPath}" is not a valid repository-relative path` });
      }
      try {
        const detection = await detectRepo(request.params.owner, request.params.repo, request.query.ref, explicitPath);
        return reply.send(detection);
      } catch (err) {
        return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
      }
    },
  );

  fastify.post<{
    Params: { owner: string; repo: string };
    Body: {
      ref?: string;
      targetEnvironmentId?: string;
      subdomain?: string;
      port?: number;
      configPath?: string;
      serviceForSubdomain?: string;
      composePortOverrides?: Record<string, number>;
    };
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
    // Port hôte précis demandé par service compose (voir DeployPortRequirement#overridable) —
    // chaque valeur validée individuellement, même règle que `port` ci-dessus (1-65535).
    const composePortOverrides = request.body?.composePortOverrides;
    if (composePortOverrides && Object.values(composePortOverrides).some((p) => !isValidPort(p))) {
      return reply.code(400).send({ error: "composePortOverrides values must be valid port numbers (1-65535)" });
    }
    // configPath = emplacement (racine si absent) choisi par l'utilisateur parmi
    // GithubRepoDetection#candidates (voir GitHubDeployPage.tsx) — jamais fait confiance sans
    // validation avant d'atteindre services/github.ts#runDeployment, qui le combine à un chemin de
    // fichier local (path.join(cloneDir, configPath)) : voir isSafeRelativeConfigPath.
    const configPath = request.body?.configPath?.trim();
    if (configPath && !isSafeRelativeConfigPath(configPath)) {
      return reply.code(400).send({ error: `"${configPath}" is not a valid repository-relative path` });
    }
    // services/github.ts#deployViaDockerBuild passe targetEnvironmentId TEL QUEL à
    // services/docker.ts#getClient(remoteEnvironmentId), qui attend l'id BRUT d'un environnement
    // Docker distant persisté (remoteDockerStore.ts) — jamais la forme préfixée
    // "remote-docker:<id>" exposée par GET /api/environments (voir
    // apps/web/src/features/github/GitHubDeployPage.tsx, sélecteur de cible). Sans cette
    // résolution, TOUTE cible autre que "Docker local" (id vide) levait "Remote Docker environment
    // "remote-docker:<id>" not found" — même utilitaire déjà utilisé par routes/containers.ts,
    // volumes.ts, networks.ts pour exactement ce même besoin. `undefined` pour un id local
    // ("prod-swarm"/"dev-compose") : retombe sur le démon local, comportement inchangé.
    const resolvedTargetEnvironmentId = remoteDockerIdFromEnvironmentId(request.body?.targetEnvironmentId);
    try {
      const deployment = await startDeployment({
        owner: request.params.owner,
        repo: request.params.repo,
        ...(request.body?.ref ? { ref: request.body.ref } : {}),
        ...(resolvedTargetEnvironmentId ? { targetEnvironmentId: resolvedTargetEnvironmentId } : {}),
        ...(subdomain ? { subdomain } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(configPath ? { configPath } : {}),
        ...(request.body?.serviceForSubdomain?.trim() ? { serviceForSubdomain: request.body.serviceForSubdomain.trim() } : {}),
        ...(composePortOverrides ? { composePortOverrides } : {}),
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

  // --- Configuration dynamique de déploiement (voir DeployConfigSchema, types.ts) ---------------

  fastify.get<{ Params: { owner: string; repo: string }; Querystring: { ref?: string; path?: string } }>(
    "/api/github/repos/:owner/:repo/config-schema",
    async (request, reply) => {
      const explicitPath = request.query.path?.trim();
      if (explicitPath && !isSafeRelativeConfigPath(explicitPath)) {
        return reply.code(400).send({ error: `"${explicitPath}" is not a valid repository-relative path` });
      }
      try {
        const schema = await buildDeployConfigSchema(request.params.owner, request.params.repo, request.query.ref, explicitPath);
        return reply.send(schema);
      } catch (err) {
        return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
      }
    },
  );

  // Enregistre les valeurs de configuration (variables d'environnement) fournies par
  // l'utilisateur — voir services/github.ts#saveGithubEnvValues. Une valeur vide n'écrase jamais
  // une valeur déjà stockée (formulaire partiel). `secretRefs` (mécanisme générique, ex: SMTP
  // partagé entre plusieurs dépôts) référence un secret DÉJÀ existant par id au lieu de retaper
  // une valeur — vérifié ICI, avant tout enregistrement : un id qui ne correspond à AUCUN secret
  // réel est refusé explicitement (400), jamais une référence fantôme silencieuse. Le hook global
  // (plugins/auth.ts) exige déjà operator/admin pour toute méthode mutante, cohérent avec POST
  // .../deploy ci-dessus.
  fastify.put<{
    Params: { owner: string; repo: string };
    Body: { values?: Record<string, string>; secretRefs?: Record<string, string> };
  }>("/api/github/repos/:owner/:repo/config-values", async (request, reply) => {
    const values = request.body?.values;
    const secretRefs = request.body?.secretRefs;
    if (values !== undefined && (typeof values !== "object" || Array.isArray(values))) {
      return reply.code(400).send({ error: "values must be an object" });
    }
    if (secretRefs !== undefined && (typeof secretRefs !== "object" || Array.isArray(secretRefs))) {
      return reply.code(400).send({ error: "secretRefs must be an object" });
    }
    if (!values && !secretRefs) {
      return reply.code(400).send({ error: "values or secretRefs is required" });
    }
    if (secretRefs) {
      for (const [key, secretId] of Object.entries(secretRefs)) {
        if (!secretId) continue;
        const found = await getSecretRef(secretId);
        if (!found) {
          return reply.code(400).send({ error: `secretRefs.${key} : aucun secret "${secretId}" trouvé — vérifiez son id.` });
        }
      }
    }
    await saveGithubEnvValues(request.params.owner, request.params.repo, values ?? {}, secretRefs);
    return reply.send({ ok: true });
  });

  // --- Surcharge du CONTENU de fichiers détectés (Dockerfile/compose/*.tf/playbook Ansible) au
  // moment du build/déploiement — voir services/githubFileOverridesStore.ts. Corrige un problème
  // ponctuel SANS forker/committer sur le vrai dépôt.

  fastify.get<{ Params: { owner: string; repo: string }; Querystring: { ref?: string; path?: string } }>(
    "/api/github/repos/:owner/:repo/overridable-files",
    async (request, reply) => {
      const explicitPath = request.query.path?.trim();
      if (explicitPath && !isSafeRelativeConfigPath(explicitPath)) {
        return reply.code(400).send({ error: `"${explicitPath}" is not a valid repository-relative path` });
      }
      try {
        const files = await listOverridableFiles(request.params.owner, request.params.repo, request.query.ref, explicitPath);
        return reply.send(files);
      } catch (err) {
        return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
      }
    },
  );

  // Contenu d'UN fichier — soit l'original du dépôt (source=original, API Contents GitHub), soit
  // la surcharge active (source=override) — jamais les deux mélangés. `path` valide obligatoirement
  // via isSafeRelativeConfigPath (même garde anti-traversée que le reste, voir mission).
  fastify.get<{
    Params: { owner: string; repo: string };
    Querystring: { path?: string; ref?: string; source?: string };
  }>("/api/github/repos/:owner/:repo/file-content", async (request, reply) => {
    const filePath = request.query.path?.trim();
    if (!filePath || !isSafeRelativeConfigPath(filePath)) {
      return reply.code(400).send({ error: `"${filePath ?? ""}" is not a valid repository-relative file path` });
    }
    const source = request.query.source === "override" ? "override" : "original";
    try {
      const result = await getGithubFileContent(request.params.owner, request.params.repo, filePath, request.query.ref, source);
      if (!result) {
        return reply.code(404).send({
          error:
            source === "override"
              ? `Aucune surcharge active pour "${filePath}" sur ce dépôt.`
              : `Fichier "${filePath}" introuvable dans le dépôt à cette référence.`,
        });
      }
      return reply.send({ path: filePath, ...result });
    } catch (err) {
      return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
    }
  });

  // Enregistre une surcharge — remplace ENTIÈREMENT le fichier à ce chemin exact au prochain
  // déploiement de ce dépôt (jamais un patch/diff partiel, voir mission). Le hook global
  // (plugins/auth.ts) exige déjà operator/admin pour toute méthode mutante.
  fastify.put<{ Params: { owner: string; repo: string }; Body: { path?: string; content?: string } }>(
    "/api/github/repos/:owner/:repo/file-overrides",
    async (request, reply) => {
      const filePath = request.body?.path?.trim();
      const content = request.body?.content;
      if (!filePath || !isSafeRelativeConfigPath(filePath)) {
        return reply.code(400).send({ error: `"${filePath ?? ""}" is not a valid repository-relative file path` });
      }
      if (typeof content !== "string" || content.length === 0) {
        return reply.code(400).send({ error: "content is required" });
      }
      const saved = await saveFileOverride(request.params.owner, request.params.repo, filePath, content, request.authSession!.username);
      return reply.send(saved);
    },
  );

  // Supprime la surcharge — retour au fichier ORIGINAL du dépôt au prochain déploiement.
  fastify.delete<{ Params: { owner: string; repo: string }; Querystring: { path?: string } }>(
    "/api/github/repos/:owner/:repo/file-overrides",
    async (request, reply) => {
      const filePath = request.query.path?.trim();
      if (!filePath || !isSafeRelativeConfigPath(filePath)) {
        return reply.code(400).send({ error: `"${filePath ?? ""}" is not a valid repository-relative file path` });
      }
      const deleted = await deleteFileOverride(request.params.owner, request.params.repo, filePath);
      if (!deleted) {
        return reply.code(404).send({ error: `Aucune surcharge active pour "${filePath}" sur ce dépôt.` });
      }
      return reply.send({ ok: true });
    },
  );

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

    // Même résolution que POST .../deploy ci-dessus (voir son commentaire) : autoDeploy.targetEnvironmentId
    // est repris TEL QUEL par routes/githubWebhook.ts au prochain push, donc c'est ICI, à
    // l'enregistrement, qu'il faut le convertir en id brut attendu par getClient() — jamais au
    // moment du webhook (pas de session HTTP là-bas pour refaire cette traduction).
    const resolvedTargetEnvironmentId = remoteDockerIdFromEnvironmentId(request.body?.targetEnvironmentId);

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
          ...(resolvedTargetEnvironmentId ? { targetEnvironmentId: resolvedTargetEnvironmentId } : {}),
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
        ...(resolvedTargetEnvironmentId ? { targetEnvironmentId: resolvedTargetEnvironmentId } : {}),
        ...(subdomain ? { subdomain } : {}),
        ...(port !== undefined ? { port } : {}),
      });
      return reply.send(status);
    } catch (err) {
      return reply.code(statusFromGithubError(err)).send({ error: diagnosticFromGithubError(err) });
    }
  });
}
