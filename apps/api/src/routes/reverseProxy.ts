/**
 * GET    /api/reverse-proxy/routes      — liste des routes actives, ouvert à toute session
 *                                          authentifiée (cf. plugins/auth.ts).
 * POST   /api/reverse-proxy/routes      — { subdomain, targetContainerId? | targetHost?, targetPort }
 *                                          — operator/admin (hook global, aucune restriction de
 *                                          rôle supplémentaire ici contrairement à /api/secrets/*
 *                                          : `targetHost` arbitraire reste une fonctionnalité
 *                                          assumée par conception, voir services/reverseProxy.ts
 *                                          #isForbiddenProxyTarget pour le risque SSRF documenté
 *                                          et le correctif minimal appliqué, finding M1).
 * DELETE /api/reverse-proxy/routes/:id  — operator/admin.
 * POST   /api/reverse-proxy/routes/:id/resync-dns — retente uniquement le push DNS AD
 *                                          (nsupdate) pour cette route, sans la recréer ni
 *                                          toucher à Caddy — operator/admin (voir
 *                                          services/reverseProxy.ts#resyncDns).
 * POST   /api/reverse-proxy/push        — repousse la config complète vers Caddy sans rien
 *                                          changer côté QUAI (utile après un redémarrage de
 *                                          Caddy) — operator/admin.
 * GET    /api/reverse-proxy/status         — Caddy joignable ou non (+ `reconciliation` : état de
 *                                             la boucle qui republie la config perdue à chaque
 *                                             redémarrage de Caddy, voir
 *                                             services/reverseProxyReconciler.ts), même pattern
 *                                             que GET /api/scanners/status (routes/scan.ts).
 * GET    /api/reverse-proxy/ca-certificate — certificat racine (PEM) de l'autorité TLS interne de
 *                                             Caddy, à installer manuellement une fois côté poste
 *                                             client pour que les certificats HTTPS émis pour
 *                                             *.lecreusot.priv soient reconnus (voir
 *                                             services/reverseProxy.ts#getCaCertificate).
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
  ForbiddenProxyTargetError,
  getCaCertificate,
  getReverseProxyStatus,
  InvalidSubdomainError,
  isForbiddenProxyTarget,
  isValidSubdomain,
  listRoutes,
  pushConfigToCaddy,
  resyncDns,
  SubdomainConflictError,
} from "../services/reverseProxy.js";
import { getReverseProxyReconciliationStatus } from "../services/reverseProxyReconciler.js";

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
    // Rejette ici tout caractère hors d'un nom DNS valide (espace, retour à la ligne, guillemet...)
    // — défense en profondeur EN PLUS de la validation dans le service (voir
    // services/reverseProxy.ts#isValidSubdomain) contre une injection dans le script `nsupdate` de
    // la synchronisation DNS AD (docs/reports/security-audit-2026-08-12.md, finding C3).
    if (!isValidSubdomain(subdomain.toLowerCase())) {
      return reply.code(400).send({
        error: `"${subdomain}" is not a valid DNS subdomain (letters, digits, hyphens and dots only, e.g. "monapp.lecreusot.priv")`,
      });
    }
    if (!targetContainerId && !targetHost) {
      return reply.code(400).send({ error: "targetContainerId or targetHost is required" });
    }
    // Rejette ici les cibles évidemment dangereuses (loopback, link-local, l'API d'admin Caddy
    // elle-même) — défense en profondeur EN PLUS de la validation dans le service (voir
    // services/reverseProxy.ts#isForbiddenProxyTarget), même pattern que la validation de
    // `subdomain` ci-dessus (docs/reports/security-audit-2026-08-12.md, finding M1).
    if (targetHost && isForbiddenProxyTarget(targetHost)) {
      return reply.code(400).send({
        error: `"${targetHost}" is not allowed as a reverse-proxy target (loopback/link-local addresses and the Caddy admin API itself are blocked)`,
      });
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
      if (err instanceof InvalidSubdomainError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof ForbiddenProxyTargetError) {
        return reply.code(400).send({ error: err.message });
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

  fastify.post<{ Params: { id: string } }>("/api/reverse-proxy/routes/:id/resync-dns", async (request, reply) => {
    const updated = await resyncDns(request.params.id);
    if (!updated) {
      return reply.code(404).send({ error: `Route "${request.params.id}" not found` });
    }
    return reply.send(updated);
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
    // `reconciliation` est en mémoire process : tant qu'aucun cycle n'a tourné (boucle démarrée
    // depuis index.ts#main() uniquement), ses champs valent null plutôt qu'une valeur inventée.
    return reply.send({ ...(await getReverseProxyStatus()), reconciliation: getReverseProxyReconciliationStatus() });
  });

  fastify.get("/api/reverse-proxy/ca-certificate", async (_request, reply) => {
    try {
      const pem = await getCaCertificate();
      // text/plain (pas application/x-pem-file, non universellement reconnu) + Content-Disposition
      // pour que le navigateur propose directement "Enregistrer sous quai-reverse-proxy-ca.pem"
      // plutôt que d'afficher le PEM brut dans l'onglet.
      return reply
        .header("Content-Type", "application/x-pem-file")
        .header("Content-Disposition", 'attachment; filename="quai-reverse-proxy-ca.pem"')
        .send(pem);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
