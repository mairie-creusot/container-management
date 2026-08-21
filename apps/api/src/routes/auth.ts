/**
 * Authentification LDAP + session JWT.
 *
 * POST /api/auth/login         — bind LDAP, mapping groupes -> rôles, émission du cookie de session.
 * POST /api/auth/logout        — efface le cookie de session.
 * POST /api/auth/ldap-diagnose — diagnostic d'un compte annuaire, ADMINS UNIQUEMENT, lecture seule.
 * GET  /api/session            — retourne la session courante (protégé par le hook global, cf.
 *                                src/plugins/auth.ts : 401 si pas de cookie valide).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { authenticate, diagnoseLdapAccount, LdapAuthError } from "../services/ldap.js";
import { signSessionToken, verifySessionToken } from "../services/session.js";
import { recordAuditEvent } from "../services/auditLog.js";

interface LoginBody {
  username?: string;
  password?: string;
}

interface DiagnoseBody {
  username?: string;
}

/**
 * /api/auth/* est explicitement exclu du hook d'authentification global (plugins/auth.ts :
 * isPublicAuthRoute) — `request.authSession` n'y est JAMAIS renseigné, même pour un admin
 * connecté. Toute route de ce fichier qui n'est pas publique doit donc vérifier la session
 * elle-même, sinon elle est ouverte à l'internet.
 */
function requireAdminSession(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = request.cookies[config.session.cookieName];
  if (!token) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  try {
    const payload = verifySessionToken(token);
    if (!payload.roles.includes("admin")) {
      reply.code(403).send({ error: "Insufficient role: admin required" });
      return false;
    }
    return true;
  } catch {
    reply.code(401).send({ error: "Invalid or expired session" });
    return false;
  }
}

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password are required" });
    }

    try {
      const result = await authenticate(username, password);
      const token = signSessionToken(result);

      reply.setCookie(config.session.cookieName, token, {
        httpOnly: true,
        secure: config.session.cookieSecure,
        sameSite: "strict",
        path: "/",
      });

      await recordAuditEvent({
        actor: result.username,
        actorDisplayName: result.displayName,
        method: "POST",
        path: "/api/auth/login",
        statusCode: 200,
        ok: true,
      });
      return reply.send({ username: result.username, displayName: result.displayName, roles: result.roles });
    } catch (err) {
      // Échec de login : pas de displayName connu à ce stade (l'annuaire n'a peut-être même
      // pas été atteint) — on trace quand même la tentative avec le login saisi, utile pour
      // repérer un compte ciblé par des tentatives répétées.
      await recordAuditEvent({
        actor: username,
        actorDisplayName: username,
        method: "POST",
        path: "/api/auth/login",
        statusCode: err instanceof LdapAuthError ? 401 : 502,
        ok: false,
      });
      if (err instanceof LdapAuthError) {
        // La réponse HTTP reste volontairement vague (elle ne doit jamais révéler à un anonyme
        // qu'un compte existe) ; la cause précise décodée depuis l'annuaire part dans les journaux
        // serveur, avec l'identifiant tenté — jamais le mot de passe.
        request.log.warn(
          { username, reason: err.reason, adCode: err.adCode, detail: err.detail },
          "Échec d'authentification LDAP",
        );
        return reply.code(401).send({ error: err.message });
      }
      request.log.error(err, "LDAP authentication failed unexpectedly");
      return reply.code(502).send({ error: "Authentication backend unavailable" });
    }
  });

  /**
   * Diagnostic d'un compte annuaire, RÉSERVÉ AUX ADMINS et en lecture seule : aucun mot de passe
   * n'est accepté ni transmis, aucun bind utilisateur n'est tenté (ce qui incrémenterait le
   * compteur de verrouillage AD), rien n'est écrit dans l'annuaire.
   */
  fastify.post<{ Body: DiagnoseBody }>("/api/auth/ldap-diagnose", async (request, reply) => {
    if (!requireAdminSession(request, reply)) return reply;

    const username = request.body?.username?.trim();
    if (!username) {
      return reply.code(400).send({ error: "username is required" });
    }

    try {
      const diagnosis = await diagnoseLdapAccount(username);
      return reply.send(diagnosis);
    } catch (err) {
      request.log.error(err, "LDAP account diagnosis failed");
      return reply.code(502).send({ error: "Diagnostic impossible : annuaire injoignable." });
    }
  });

  fastify.post("/api/auth/logout", async (request, reply) => {
    // /api/auth/* est une route publique côté hook global (voir plugins/auth.ts) :
    // request.authSession n'y est jamais renseigné, même pour un utilisateur connecté — il
    // faut redécoder le cookie ici pour savoir qui se déconnecte.
    const token = request.cookies[config.session.cookieName];
    if (token) {
      try {
        const payload = verifySessionToken(token);
        await recordAuditEvent({
          actor: payload.username,
          actorDisplayName: payload.displayName,
          method: "POST",
          path: "/api/auth/logout",
          statusCode: 200,
          ok: true,
        });
      } catch {
        // cookie déjà invalide/expiré : rien à tracer
      }
    }
    reply.clearCookie(config.session.cookieName, { path: "/" });
    return reply.send({ ok: true });
  });

  fastify.get("/api/session", async (request, reply) => {
    // Protégé par le hook global (src/plugins/auth.ts) : si on atteint ce handler,
    // request.authSession est nécessairement défini.
    if (!request.authSession) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return reply.send(request.authSession);
  });
}
