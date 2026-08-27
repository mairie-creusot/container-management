/**
 * GET /api/windows/services?host=... — services RÉELS d'un Windows Server, lus par WinRM sous
 * l'identité de la personne connectée (services/kerberosSession.ts + services/winrm.ts).
 *
 * Aucune vérification de droits côté QUAI au-delà de l'authentification : c'est WINDOWS qui tranche.
 * Une personne sans droits sur ce serveur reçoit un refus du serveur lui-même, rapporté tel quel —
 * QUAI ne lui accorde rien que son compte n'aurait pas ailleurs, et ne lui refuse rien qu'il aurait.
 *
 * LECTURE SEULE : aucune route mutante ici, donc aucune ligne d'audit à écrire pour ce premier lot.
 */

import type { FastifyInstance } from "fastify";
import { listWindowsServices } from "../services/windowsServices.js";
import { ticketStatusFor } from "../services/kerberosSession.js";

/** Un état honnête vaut un 200 : « injoignable » ou « refusé » est une RÉPONSE, pas une panne de
 * QUAI. Seule l'absence de paramètre est une erreur de la requête. */
export default async function windowsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { host?: string } }>("/api/windows/services", async (request, reply) => {
    const host = request.query?.host?.trim();
    if (!host) return reply.code(400).send({ error: "Paramètre requis : host" });

    return reply.send(await listWindowsServices(host, request.authSession!.username));
  });

  /** Ce que l'interface a besoin de savoir avant de proposer un onglet Windows : ai-je un ticket ? */
  fastify.get("/api/windows/ticket", async (request, reply) => {
    return reply.send(ticketStatusFor(request.authSession!.username));
  });
}
