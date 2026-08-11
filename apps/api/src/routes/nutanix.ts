/**
 * GET /api/nutanix/vms — détail des VMs du cluster Nutanix piloté (nom, état d'alimentation,
 * vCPUs, mémoire, cluster physique). Renvoie [] si Nutanix n'a jamais été configuré via
 * l'assistant, ou si configuré mais injoignable — voir services/nutanix.ts#getNutanixVms
 * (aucune transformation supplémentaire nécessaire ici, la forme est déjà NutanixVm[]).
 *
 * Fichier dédié plutôt qu'ajouté à routes/environments.ts : GET /api/environments n'expose
 * qu'un nœud PAR CLUSTER PHYSIQUE (compteur de VMs agrégé, cf. nutanix.ts#getNutanixEnvironment),
 * jamais le détail par VM — c'est une ressource distincte (liste de VMs, pas de nœuds de cluster),
 * qui mérite son propre chemin `/api/nutanix/*` plutôt que de surcharger la route environnements.
 */

import type { FastifyInstance } from "fastify";
import { getNutanixVms } from "../services/nutanix.js";

export default async function nutanixRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/nutanix/vms", async (_request, reply) => {
    return reply.send(await getNutanixVms());
  });
}
