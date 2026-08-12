/**
 * GET   /api/registries                          — liste des registries suivis.
 * POST  /api/registries                          — ajoute un registry — admin uniquement (403
 *                                                    sinon), cohérent avec ARCHITECTURE.md
 *                                                    (« admin : + gestion des registries et des
 *                                                    accès ») et le même garde que routes/secrets.ts/
 *                                                    remoteEnvironments.ts/lxc.ts : un `operator`
 *                                                    pouvait jusqu'ici créer un registry ou en
 *                                                    réécrire les identifiants via PATCH, ce que la
 *                                                    doc réservait déjà à `admin` — voir
 *                                                    docs/reports/security-audit-2026-08-12.md,
 *                                                    finding M4.
 * GET   /api/registries/:id                      — détail d'un registry.
 * PATCH /api/registries/:id                      — modifie nom/URL/identifiants — admin uniquement,
 *                                                    même raison que POST ci-dessus.
 * GET   /api/registries/:id/repositories          — vrai catalogue distant (pas juste le local).
 * GET   /api/registries/:id/repositories/:repo/tags — tags d'un dépôt du catalogue (:repo encodé, cf. gitops.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createRegistry,
  getPersistedRegistryConfig,
  getRegistry,
  listRegistries,
  updateRegistry,
} from "../services/registriesStore.js";
import { listRegistryRepositories, listTagsForImage } from "../services/registries/index.js";
import type { RegistryKind } from "../types.js";

const VALID_KINDS: readonly RegistryKind[] = ["dockerhub", "ghcr", "gitlab", "harbor"];

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que secrets.ts/lxc.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface CreateRegistryBody {
  kind?: string;
  name?: string;
  url?: string;
}

interface UpdateRegistryBody {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  token?: string;
}

export default async function registriesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/registries", async (_request, reply) => {
    return reply.send(await listRegistries());
  });

  fastify.post<{ Body: CreateRegistryBody }>("/api/registries", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const { kind, name, url } = request.body ?? {};
    if (!kind || !name || !url) {
      return reply.code(400).send({ error: "kind, name and url are required" });
    }
    if (!VALID_KINDS.includes(kind as RegistryKind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` });
    }
    const registry = await createRegistry({ kind: kind as RegistryKind, name, url });
    return reply.code(201).send(registry);
  });

  fastify.get<{ Params: { id: string } }>("/api/registries/:id", async (request, reply) => {
    const registry = await getRegistry(request.params.id);
    if (!registry) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    return reply.send(registry);
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateRegistryBody }>(
    "/api/registries/:id",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const { name, url, username, password, token } = request.body ?? {};
      const updated = await updateRegistry(request.params.id, {
        ...(name !== undefined ? { name } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(token !== undefined ? { token } : {}),
      });
      if (!updated) {
        return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
      }
      return reply.send(updated);
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/registries/:id/repositories", async (request, reply) => {
    const persisted = await getPersistedRegistryConfig(request.params.id);
    if (!persisted) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    // Le "username" persisté est l'identité d'authentification, pas forcément l'org/namespace du
    // catalogue à parcourir — pour Docker Hub il correspond toujours au namespace (compte
    // perso/org). Pour GHCR, GitHub demande souvent un e-mail comme identifiant de connexion
    // (docker login), qui n'est jamais un nom d'org/user GitHub valide : on ne le passe comme
    // org explicite que s'il n'y ressemble pas, sinon on laisse resolveOrg() le déduire d'une
    // image locale déjà tirée (voir ghcr.ts).
    const namespace =
      persisted.kind === "dockerhub"
        ? persisted.username
        : persisted.kind === "ghcr" && persisted.username && !persisted.username.includes("@")
          ? persisted.username
          : undefined;
    const result = await listRegistryRepositories(persisted.kind, namespace);
    return reply.send(result);
  });

  fastify.get<{ Params: { id: string; repo: string } }>(
    "/api/registries/:id/repositories/:repo/tags",
    async (request, reply) => {
      const persisted = await getPersistedRegistryConfig(request.params.id);
      if (!persisted) {
        return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
      }
      const tags = await listTagsForImage({ name: request.params.repo, registry: persisted.kind });
      return reply.send({ repository: request.params.repo, tags });
    },
  );
}
