/**
 * GET    /api/nutanix/vms    — détail des VMs du cluster Nutanix piloté (nom, état
 *                               d'alimentation, vCPUs, mémoire, cluster physique). Renvoie []
 *                               si Nutanix n'a jamais été configuré, ou si configuré mais
 *                               injoignable — voir services/nutanix.ts#getNutanixVms (aucune
 *                               transformation supplémentaire nécessaire ici, la forme est déjà
 *                               NutanixVm[]).
 * GET    /api/nutanix/config — config Nutanix courante, REDACTÉE (jamais le mot de passe).
 * PUT    /api/nutanix/config — configure/remplace Nutanix EN DEHORS de l'assistant de premier
 *                               lancement (admin uniquement, mêmes identifiants de sensibilité
 *                               comparable à /api/ad-dns/config) — teste réellement la
 *                               connexion à Prism Central avant d'enregistrer, jamais persisté
 *                               à l'aveugle. Répond au trou constaté : avant cette route, la
 *                               SEULE façon d'ajouter Nutanix était l'assistant de premier
 *                               lancement, invisible/inaccessible une fois celui-ci terminé sans
 *                               tout rouvrir (POST /api/setup/reset, LDAP compris).
 * DELETE /api/nutanix/config — retire la configuration (admin uniquement).
 *
 * Fichier dédié plutôt qu'ajouté à routes/environments.ts : GET /api/environments n'expose
 * qu'un nœud PAR CLUSTER PHYSIQUE (compteur de VMs agrégé, cf. nutanix.ts#getNutanixEnvironment),
 * jamais le détail par VM — c'est une ressource distincte (liste de VMs, pas de nœuds de cluster),
 * qui mérite son propre chemin `/api/nutanix/*` plutôt que de surcharger la route environnements.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getNutanixVms, testNutanixConnection } from "../services/nutanix.js";
import { clearNutanixConfig, getEffectiveNutanixConfig, setNutanixConfig } from "../services/setupStore.js";
import type { SetupNutanixConfig } from "../services/setupStore.js";
import type { NutanixConfig, NutanixStatus } from "../types.js";

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que
 * routes/adDns.ts/secrets.ts pour une intégration de sensibilité comparable (identifiants
 * Prism Central donnant un accès large à l'infra virtualisée). */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface NutanixConfigBody {
  prismCentralUrl?: string;
  username?: string;
  password?: string;
}

function toPublicConfig(cfg: SetupNutanixConfig): NutanixConfig {
  return { prismCentralUrl: cfg.prismCentralUrl, username: cfg.username };
}

export default async function nutanixRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/nutanix/vms", async (_request, reply) => {
    return reply.send(await getNutanixVms());
  });

  fastify.get("/api/nutanix/config", async (_request, reply) => {
    const current = await getEffectiveNutanixConfig();
    const status: NutanixStatus = current ? { configured: true, config: toPublicConfig(current) } : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: NutanixConfigBody }>("/api/nutanix/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await getEffectiveNutanixConfig();
    const prismCentralUrl = body.prismCentralUrl?.trim();
    const username = body.username?.trim();
    // password vide/absent = conserver l'existant (même convention que PATCH /api/registries/:id
    // et PUT /api/ad-dns/config) — permet de changer l'URL/l'utilisateur sans ressaisir le mot de
    // passe à chaque fois.
    const password = body.password?.trim() || existing?.password || "";

    if (!prismCentralUrl || !username || !password) {
      return reply.code(400).send({ error: "prismCentralUrl, username and password are required" });
    }

    // Teste réellement la connexion avant d'enregistrer — jamais une config persistée à l'aveugle
    // (même discipline que l'assistant de premier lancement, POST /api/setup/test/nutanix).
    const test = await testNutanixConnection(prismCentralUrl, username, password);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    const saved = await setNutanixConfig({ prismCentralUrl, username, password });
    return reply.send({ configured: true, config: toPublicConfig(saved.nutanix!) } satisfies NutanixStatus);
  });

  fastify.delete("/api/nutanix/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearNutanixConfig();
    return reply.send({ ok: true });
  });
}
