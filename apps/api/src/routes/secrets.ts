/**
 * GET    /api/secrets       — liste des secrets (id/name/description/dates/usedBy/version/
 *                              expiresAt, JAMAIS la valeur), ouvert à toute session authentifiée
 *                              (cf. plugins/auth.ts). Purge d'abord silencieusement, dans
 *                              `usedBy` de chaque secret, les entrées dont le conteneur n'existe
 *                              plus (voir purgeStaleSecretUsages — filet de sécurité, même esprit
 *                              que GET /api/topology/positions).
 * POST   /api/secrets       — { name, value, description?, expiresAt? }, admin uniquement.
 * PATCH  /api/secrets/:id   — { name?, value?, description?, expiresAt? }, value omise/vide =
 *                              valeur conservée (une valeur RÉELLEMENT fournie déclenche une
 *                              rotation, voir historique ci-dessous), admin uniquement.
 * DELETE /api/secrets/:id   — admin uniquement.
 * GET    /api/secrets/:id/versions — métadonnées SEULES (version + date, jamais de valeur) de
 *                              l'historique borné façon Vault KV v2, admin uniquement.
 * POST   /api/secrets/:id/reveal — déchiffre et renvoie { value } UNE FOIS, admin uniquement.
 *                              Body optionnel { version? } pour révéler une version passée
 *                              (voir GET .../versions) plutôt que la version courante. POST (pas
 *                              GET) pour ne jamais apparaître dans une URL journalisée (logs
 *                              d'accès, historique navigateur) — déjà journalisée dans l'audit
 *                              log via plugins/audit.ts (hook générique sur toute requête
 *                              mutante), sans rien à câbler de plus ici.
 *
 * Un secret est plus sensible qu'un registry (routes/registries.ts, operator/admin suffit) :
 * le hook global (plugins/auth.ts) exige déjà operator/admin pour toute méthode mutante, mais
 * on restreint explicitement les handlers mutants ci-dessous à "admin" — même principe que
 * requireAdmin pour /api/setup/* une fois l'assistant terminé.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDockerContainers } from "../services/docker.js";
import {
  createSecret,
  deleteSecret,
  getDecryptedSecretValueById,
  listSecretVersions,
  purgeStaleSecretUsages,
  SecretNameConflictError,
  updateSecret,
} from "../services/secretsStore.js";

interface CreateSecretBody {
  name?: string;
  value?: string;
  description?: string;
  expiresAt?: string;
}

interface UpdateSecretBody {
  name?: string;
  value?: string;
  description?: string;
  expiresAt?: string | null;
}

interface RevealSecretBody {
  version?: number;
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
    // Conteneurs Docker RÉELLEMENT vivants en ce moment — sert à purger, avant de répondre,
    // toute entrée `usedBy` devenue orpheline (voir purgeStaleSecretUsages). Ne couvre que
    // Docker (secretEnv n'est résolu qu'à la création d'un conteneur Docker, jamais Kubernetes).
    const dockerContainers = await getDockerContainers();
    const liveContainerIds = new Set(dockerContainers.map((c) => c.id));
    return reply.send(await purgeStaleSecretUsages(liveContainerIds));
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
    // Optionnelle — voir SecretExpiredError (secretsStore.ts). Une date invalide/mal formée
    // n'est simplement jamais considérée comme dépassée (comparaison via `new Date().getTime()`,
    // NaN < Date.now() vaut toujours false) plutôt que de faire échouer la création : cohérent
    // avec le reste du formulaire, aucun autre champ de cette route n'est strictement validé.
    const expiresAt = request.body?.expiresAt?.trim() || undefined;

    try {
      const created = await createSecret({
        name,
        value,
        ...(description ? { description } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
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

      const { name, value, description, expiresAt } = request.body ?? {};
      if (name !== undefined && !name.trim()) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }

      try {
        const updated = await updateSecret(request.params.id, {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(value ? { value } : {}),
          ...(description !== undefined ? { description } : {}),
          // undefined (clé absente du body) = expiration inchangée ; null = effacée
          // explicitement ; chaîne = nouvelle date — voir UpdateSecretInput (secretsStore.ts).
          ...(expiresAt !== undefined ? { expiresAt } : {}),
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

  // Métadonnées SEULES (jamais de valeur) — façon Vault KV v2 "consulter l'historique avant de
  // révéler/restaurer une version précise". Admin uniquement, même sensibilité que reveal.
  fastify.get<{ Params: { id: string } }>("/api/secrets/:id/versions", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const versions = await listSecretVersions(request.params.id);
    if (!versions) {
      return reply.code(404).send({ error: `Secret "${request.params.id}" not found` });
    }
    return reply.send(versions);
  });

  // POST (pas GET) : une valeur de secret ne doit jamais transiter dans une URL (logs d'accès,
  // historique navigateur). Mutant -> déjà admin-only via rejectIfNotAdmin ci-dessous, et déjà
  // journalisé par l'audit log générique (plugins/audit.ts, hook onResponse sur toute requête
  // mutante authentifiée) sans rien à câbler de plus ici. Ne renvoie la valeur qu'une fois par
  // appel : le frontend ne doit jamais la persister au-delà d'un state local temporaire. Body
  // optionnel `{ version }` (voir GET .../versions) pour révéler une version passée plutôt que
  // la version courante — reste permissif même si le secret a une `expiresAt` dépassée : un
  // admin doit pouvoir consulter une valeur expirée pour la faire tourner (contrairement à
  // secretEnv à la création d'un conteneur, voir routes/containers.ts#SecretExpiredError).
  fastify.post<{ Params: { id: string }; Body: RevealSecretBody }>(
    "/api/secrets/:id/reveal",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const value = await getDecryptedSecretValueById(request.params.id, request.body?.version);
      if (value === null) {
        return reply.code(404).send({ error: `Secret "${request.params.id}" not found` });
      }
      return reply.send({ value });
    },
  );
}
