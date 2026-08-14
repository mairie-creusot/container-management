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
 * POST   /api/nutanix/vms/:uuid/start   — démarre une VM éteinte (services/nutanix.ts#startNutanixVm).
 * POST   /api/nutanix/vms/:uuid/stop    — arrête GRACIEUSEMENT une VM allumée (ACPI, pas un
 *                                          power-off brutal — services/nutanix.ts#stopNutanixVm).
 * POST   /api/nutanix/vms/:uuid/restart — redémarre GRACIEUSEMENT une VM allumée (extinction ACPI,
 *                                          attente de convergence réelle, rallumage — voir
 *                                          services/nutanix.ts#restartNutanixVm pour le détail du
 *                                          mécanisme, l'API v3 n'a pas d'action "reboot" dédiée).
 * POST   /api/nutanix/vms/:uuid/migrate — migre une VM ALLUMÉE vers un autre hôte physique du
 *                                          MÊME cluster (live migration AHV réelle, voir
 *                                          services/nutanix.ts#migrateNutanixVm) — `{ targetHostUuid }`.
 *                                          Refuse explicitement un hôte cible = hôte actuel ou
 *                                          appartenant à un autre cluster (409 dans les deux cas).
 * DELETE /api/nutanix/vms/:uuid         — supprime définitivement une VM (services/nutanix.ts#
 *                                          deleteNutanixVm) — refuse (409) si la VM est allumée,
 *                                          garde-fou QUAI délibéré vu la sensibilité de l'action
 *                                          (voir JSDoc de la fonction). La confirmation "taper le
 *                                          nom de la VM" est portée par le frontend.
 *
 * Ces 5 routes mutent une VRAIE VM de production Nutanix — operator/admin requis (garde globale
 * plugins/auth.ts sur toute méthode mutante, même pattern que /api/containers/:id/{start,stop,
 * restart} et DELETE /api/containers/:id, voir routes/containers.ts) et auditées automatiquement
 * (plugins/audit.ts, même mécanisme générique que toute route mutante authentifiée — rien à
 * câbler ici). Toutes traduisent NutanixActionError (services/nutanix.ts) via son `httpStatus`
 * porté explicitement par l'erreur (voir sendNutanixActionError ci-dessous) plutôt qu'un 502
 * générique fourre-tout : contrairement aux GET de listing ci-dessus (qui retombent honnêtement
 * sur []/injoignable sans distinction fine), une action doit échouer avec un diagnostic exploitable
 * par l'opérateur (VM déjà dans l'état demandé, hôte cible invalide, VM introuvable...).
 *
 * Fichier dédié plutôt qu'ajouté à routes/environments.ts : GET /api/environments n'expose
 * qu'un nœud PAR CLUSTER PHYSIQUE (compteur de VMs agrégé, cf. nutanix.ts#getNutanixEnvironment),
 * jamais le détail par VM — c'est une ressource distincte (liste de VMs, pas de nœuds de cluster),
 * qui mérite son propre chemin `/api/nutanix/*` plutôt que de surcharger la route environnements.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  deleteNutanixVm,
  getNutanixVms,
  migrateNutanixVm,
  NutanixActionError,
  restartNutanixVm,
  startNutanixVm,
  stopNutanixVm,
  testNutanixConnection,
} from "../services/nutanix.js";
import { clearNutanixConfig, getEffectiveNutanixConfig, setNutanixConfig } from "../services/setupStore.js";
import type { SetupNutanixConfig } from "../services/setupStore.js";
import type { NutanixConfig, NutanixStatus } from "../types.js";

/** Traduit une erreur d'action VM (services/nutanix.ts#{start,stop,restart,delete,migrate}NutanixVm)
 * en réponse HTTP — utilise `httpStatus` porté par NutanixActionError quand présent (diagnostic
 * précis : 400 non configuré, 404 VM/hôte introuvable, 409 garde-fou métier, 502 erreur Prism
 * Central, 504 timeout de convergence), 502 générique sinon (erreur inattendue non prévue par le
 * service, ex: panne réseau brute) — jamais un succès silencieux sur une action mutante. */
function sendNutanixActionError(reply: FastifyReply, err: unknown): void {
  if (err instanceof NutanixActionError) {
    reply.code(err.httpStatus).send({ error: err.message });
    return;
  }
  reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
}

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

  // --- Cycle de vie + migration d'une VM (voir en-tête de fichier) — operator/admin (garde
  // globale plugins/auth.ts), audit automatique (plugins/audit.ts), aucun garde local
  // supplémentaire nécessaire (même niveau de sensibilité que /api/containers/:id/{start,stop,
  // restart}, PAS le niveau admin-only de GET .../files/hexdump). -----------------------------

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/start", async (request, reply) => {
    try {
      const result = await startNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/stop", async (request, reply) => {
    try {
      const result = await stopNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/restart", async (request, reply) => {
    try {
      const result = await restartNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string }; Body: { targetHostUuid?: string } }>(
    "/api/nutanix/vms/:uuid/migrate",
    async (request, reply) => {
      const targetHostUuid = request.body?.targetHostUuid?.trim();
      if (!targetHostUuid) {
        return reply.code(400).send({ error: "targetHostUuid is required" });
      }
      try {
        const result = await migrateNutanixVm(request.params.uuid, targetHostUuid);
        return reply.send(result);
      } catch (err) {
        sendNutanixActionError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid", async (request, reply) => {
    try {
      const result = await deleteNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });
}
