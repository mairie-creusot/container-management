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
 *                                                    finding M4. Accepte optionnellement
 *                                                    username/password/token/org dès la création
 *                                                    (retour utilisateur du 14/08/2026 : le
 *                                                    formulaire de création n'avait aucun champ
 *                                                    identifiant, forçant un détour par PATCH).
 * GET   /api/registries/:id                      — détail d'un registry.
 * PATCH /api/registries/:id                      — modifie nom/URL/identifiants/org — admin
 *                                                    uniquement, même raison que POST ci-dessus.
 * DELETE /api/registries/:id                     — supprime un registry — admin uniquement, même
 *                                                    raison que POST/PATCH ci-dessus (manquait
 *                                                    jusqu'ici, retour utilisateur du 14/08/2026).
 * GET   /api/registries/:id/repositories          — vrai catalogue distant (pas juste le local).
 * GET   /api/registries/:id/repositories/:repo/tags — tags d'un dépôt du catalogue (:repo encodé, cf. gitops.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createRegistry,
  deleteRegistry,
  getPersistedRegistryConfig,
  getRegistry,
  listRegistries,
  resolveRegistryOrg,
  updateRegistry,
} from "../services/registriesStore.js";
import { listRegistryRepositories, listTagsForImage } from "../services/registries/index.js";
import { getLocalDockerImages } from "../services/docker.js";
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
  // Identifiants + org optionnels dès la création — retour utilisateur du 14/08/2026 ("de plus a
  // la creation ya pas pour mettre les identifiant ou un token") : avant ce correctif, seuls
  // kind/name/url étaient acceptés ici, forçant un détour par PATCH (icône engrenage) pour tout
  // registry privé. Mêmes champs que UpdateRegistryBody ci-dessous.
  username?: string;
  password?: string;
  token?: string;
  org?: string;
}

interface UpdateRegistryBody {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  token?: string;
  // Organisation GitHub (ghcr) / namespace (dockerhub) explicite — voir setupStore.ts#RegistryPatch
  // pour la convention "chaîne vide efface l'org, absence de la clé la laisse inchangée".
  org?: string;
}

export default async function registriesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/registries", async (_request, reply) => {
    return reply.send(await listRegistries());
  });

  fastify.post<{ Body: CreateRegistryBody }>("/api/registries", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const { kind, name, url, username, password, token, org } = request.body ?? {};
    if (!kind || !name || !url) {
      return reply.code(400).send({ error: "kind, name and url are required" });
    }
    if (!VALID_KINDS.includes(kind as RegistryKind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` });
    }
    const registry = await createRegistry({
      kind: kind as RegistryKind,
      name,
      url,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(org !== undefined ? { org } : {}),
    });
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

      const { name, url, username, password, token, org } = request.body ?? {};
      const updated = await updateRegistry(request.params.id, {
        ...(name !== undefined ? { name } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(token !== undefined ? { token } : {}),
        ...(org !== undefined ? { org } : {}),
      });
      if (!updated) {
        return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
      }
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/registries/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const ok = await deleteRegistry(request.params.id);
    if (!ok) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { id: string } }>("/api/registries/:id/repositories", async (request, reply) => {
    const persisted = await getPersistedRegistryConfig(request.params.id);
    if (!persisted) {
      return reply.code(404).send({ error: `Registry "${request.params.id}" not found` });
    }
    // Résolution partagée avec registriesStore.ts#buildRegistryView (compteur "images suivies")
    // — SEULE implémentation de cette logique (voir resolveRegistryOrg) : avant ce correctif,
    // cette route recalculait sa propre variante (ternaire dupliqué ci-dessous, supprimé), un
    // risque de divergence entre le compteur et l'explorateur de catalogue pour le même registry.
    const localImages = await getLocalDockerImages();
    const org = resolveRegistryOrg(persisted, localImages);
    const result = await listRegistryRepositories(persisted.kind, org, persisted.url);
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
