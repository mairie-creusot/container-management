/**
 * GET /api/windows/services?host=... — services RÉELS d'un Windows Server, lus par WinRM sous
 * l'identité de la personne connectée (services/kerberosSession.ts + services/winrm.ts).
 *
 * Aucune vérification de droits côté QUAI au-delà de l'authentification : c'est WINDOWS qui tranche.
 * Une personne sans droits sur ce serveur reçoit un refus du serveur lui-même, rapporté tel quel —
 * QUAI ne lui accorde rien que son compte n'aurait pas ailleurs, et ne lui refuse rien qu'il aurait.
 *
 * La lecture n'écrit rien. Démarrer ou arrêter un service, en revanche, est une MUTATION sur une
 * machine de production : journalisée automatiquement (plugins/audit.ts), confirmée par l'interface
 * avant d'arriver ici, et son statut HTTP dit la vérité — un refus de Windows ne doit jamais
 * apparaître comme un « OK » dans le journal.
 */

import type { FastifyInstance } from "fastify";
import { controlWindowsService, listWindowsServices } from "../services/windowsServices.js";
import { ticketStatusFor } from "../services/kerberosSession.js";
import { listWindowsRoles } from "../services/windowsRoles.js";

/** Un état honnête vaut un 200 : « injoignable » ou « refusé » est une RÉPONSE, pas une panne de
 * QUAI. Seule l'absence de paramètre est une erreur de la requête. */
export default async function windowsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { host?: string } }>("/api/windows/services", async (request, reply) => {
    const host = request.query?.host?.trim();
    if (!host) return reply.code(400).send({ error: "Paramètre requis : host" });

    return reply.send(await listWindowsServices(host, request.authSession!.username));
  });

  /** Rôles RÉELLEMENT installés — ce qui décide des onglets proposés pour cette machine. */
  fastify.get<{ Querystring: { host?: string } }>("/api/windows/roles", async (request, reply) => {
    const host = request.query?.host?.trim();
    if (!host) return reply.code(400).send({ error: "Paramètre requis : host" });

    return reply.send(await listWindowsRoles(host, request.authSession!.username));
  });

  /** Ce que l'interface a besoin de savoir avant de proposer un onglet Windows : ai-je un ticket ? */
  fastify.get("/api/windows/ticket", async (request, reply) => {
    return reply.send(ticketStatusFor(request.authSession!.username));
  });

  /**
   * Démarre ou arrête un service RÉEL. Mutante : journalisée automatiquement (plugins/audit.ts),
   * et l'interface la fait confirmer avant d'arriver ici.
   *
   * Le hook global exige déjà operator/admin pour toute méthode mutante ; c'est ensuite WINDOWS qui
   * tranche, avec les droits du compte de la personne connectée.
   */
  fastify.post<{ Params: { name: string; action: string }; Querystring: { host?: string } }>(
    "/api/windows/services/:name/:action",
    async (request, reply) => {
      const host = request.query?.host?.trim();
      if (!host) return reply.code(400).send({ error: "Paramètre requis : host" });

      const { action } = request.params;
      if (action !== "start" && action !== "stop") {
        return reply.code(400).send({ error: `Action inconnue : "${action}" — "start" ou "stop" attendu.` });
      }

      const outcome = await controlWindowsService(host, request.params.name, action, request.authSession!.username);
      // Un refus de Windows n'est pas une panne de QUAI, mais ce n'est pas non plus un succès : le
      // statut HTTP doit le dire, sinon le journal marquerait « OK » une action qui n'a rien fait.
      if (outcome.status === "done") return reply.send(outcome);
      const code = outcome.status === "denied" ? 403 : outcome.status === "unreachable" ? 502 : 409;
      return reply.code(code).send(outcome);
    },
  );
}
