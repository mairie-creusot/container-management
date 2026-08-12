/**
 * Webhook GitHub entrant (déploiement automatique sur push, cf. ARCHITECTURE.md § "Intégration
 * GitHub") — reçoit un VRAI événement `push` envoyé par GitHub (enregistré via POST
 * /api/github/repos/:owner/:repo/auto-deploy, voir routes/github.ts#createRepoWebhook) et
 * déclenche le déploiement déjà existant (services/github.ts#startDeployment) vers la branche
 * configurée, sans repasser par une session QUAI (GitHub n'en a pas) — authentifié uniquement
 * par la signature HMAC `X-Hub-Signature-256`, exactement comme documenté par GitHub :
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *
 * Format vérifié auprès de la doc officielle (pas deviné) : en-tête `X-Hub-Signature-256:
 * sha256=<hex HMAC-SHA256 du corps BRUT avec le secret du webhook>`, comparaison en temps
 * constant (`crypto.timingSafeEqual`) — jamais un simple `===`.
 *
 * POST /api/github/webhook — PAS de session requise (voir plugins/auth.ts#isGithubWebhookRoute,
 * exception minimale et ciblée) : c'est la signature HMAC, vérifiée ci-dessous, qui authentifie
 * la requête. Route volontairement séparée de routes/github.ts (authentification différente).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getAutoDeploySecretEntry } from "../services/githubStore.js";
import { startDeployment } from "../services/github.js";
import type { GithubDeploymentCommit } from "../types.js";

interface GithubPushPayload {
  ref?: string;
  repository?: { full_name?: string };
  head_commit?: { id?: string; message?: string; author?: { name?: string; username?: string } } | null;
  pusher?: { name?: string };
  sender?: { login?: string; avatar_url?: string };
}

/** true si `provided` (valeur brute de l'en-tête, sans le préfixe "sha256=") correspond au HMAC
 * SHA-256 attendu de `rawBody` avec `secret` — comparaison en temps constant. */
function isValidSignature(rawBody: Buffer, secret: string, provided: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(provided, "utf-8");
  // Longueurs différentes : timingSafeEqual lèverait — traité comme "invalide", sans branche
  // supplémentaire dépendante du contenu (la comparaison de longueur seule ne fuite qu'une
  // information déjà publique : la longueur fixe d'un hex-digest SHA-256 est 64).
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export default async function githubWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Capture le corps BRUT (Buffer), pas le JSON parsé par défaut : la vérification HMAC doit
  // porter EXACTEMENT sur les octets envoyés par GitHub, jamais sur une reconstruction
  // JSON.stringify(parsed) qui pourrait différer (ordre de clés, espacement, encodage...) et
  // ferait échouer une signature pourtant valide. Encapsulé par Fastify : ce parseur ne s'applique
  // qu'aux routes déclarées dans CE plugin (voir index.ts#buildServer), jamais globalement.
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  fastify.post("/api/github/webhook", async (request, reply) => {
    const rawBody = request.body as Buffer;
    const signatureHeader = request.headers["x-hub-signature-256"];
    const event = request.headers["x-github-event"];

    if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
      return reply.code(401).send({ error: "Missing or malformed X-Hub-Signature-256 header" });
    }

    let payload: GithubPushPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as GithubPushPayload;
    } catch {
      return reply.code(400).send({ error: "Invalid JSON payload" });
    }

    const fullName = payload.repository?.full_name;
    if (!fullName || !fullName.includes("/")) {
      return reply.code(400).send({ error: "Missing or malformed repository.full_name in payload" });
    }
    const [owner, repo] = fullName.split("/", 2) as [string, string];

    // Le secret est résolu à partir du nom de dépôt annoncé par le payload (pas encore vérifié à
    // ce stade) — sans danger : un payload forgé pour un dépôt existant échouera de toute façon
    // la vérification de signature ci-dessous faute de connaître le VRAI secret de ce dépôt.
    const autoDeploy = await getAutoDeploySecretEntry(owner, repo);
    if (!autoDeploy) {
      // Aucune config de déploiement automatique pour ce dépôt (jamais activée, ou webhook
      // orphelin après suppression côté QUAI) — rien à vérifier, rien à déclencher.
      return reply.code(404).send({ error: `No auto-deploy configuration for "${fullName}"` });
    }

    const provided = signatureHeader.slice("sha256=".length);
    if (!isValidSignature(rawBody, autoDeploy.secret, provided)) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    if (event === "ping") {
      // GitHub envoie un événement "ping" à la création du webhook pour vérifier qu'il est
      // joignable — répondre 200 est ce que GitHub attend pour marquer le hook "actif".
      return reply.send({ ok: true, message: "pong" });
    }
    if (event !== "push") {
      return reply.send({ ok: true, ignored: true, reason: `event "${String(event)}" not handled (push only)` });
    }
    if (!autoDeploy.enabled) {
      return reply.send({ ok: true, ignored: true, reason: "auto-deploy disabled for this repository" });
    }

    const pushedBranch = payload.ref?.startsWith("refs/heads/") ? payload.ref.slice("refs/heads/".length) : undefined;
    if (pushedBranch !== autoDeploy.branch) {
      return reply.send({
        ok: true,
        ignored: true,
        reason: `push to "${pushedBranch ?? payload.ref ?? "?"}" ignored (configured branch: "${autoDeploy.branch}")`,
      });
    }

    const commit: GithubDeploymentCommit | undefined = payload.head_commit?.id
      ? {
          sha: payload.head_commit.id,
          message: (payload.head_commit.message ?? "").split("\n")[0] ?? "",
          author: payload.head_commit.author?.username ?? payload.head_commit.author?.name ?? payload.pusher?.name ?? "inconnu",
          ...(payload.sender?.avatar_url ? { authorAvatarUrl: payload.sender.avatar_url } : {}),
        }
      : undefined;

    const deployment = await startDeployment({
      owner,
      repo,
      ref: autoDeploy.branch,
      startedBy: `github-webhook:${payload.sender?.login ?? "unknown"}`,
      triggeredBy: "webhook",
      ...(autoDeploy.targetEnvironmentId ? { targetEnvironmentId: autoDeploy.targetEnvironmentId } : {}),
      ...(autoDeploy.subdomain ? { subdomain: autoDeploy.subdomain } : {}),
      ...(autoDeploy.port !== undefined ? { port: autoDeploy.port } : {}),
      ...(commit ? { commit } : {}),
    });

    return reply.code(201).send({ ok: true, deploymentId: deployment.id });
  });
}
