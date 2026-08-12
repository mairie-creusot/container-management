/**
 * GET    /api/cron-jobs              — liste des définitions, ouvert à toute session authentifiée.
 * POST   /api/cron-jobs              — { name, containerId, containerName, command, schedule,
 *                                        enabled? } — ADMIN UNIQUEMENT (403 sinon). Choix de rôle
 *                                        documenté ci-dessous.
 * GET    /api/cron-jobs/:id
 * PATCH  /api/cron-jobs/:id          — mêmes champs, tous optionnels — admin uniquement.
 * DELETE /api/cron-jobs/:id          — admin uniquement.
 * GET    /api/cron-jobs/:id/runs     — historique d'exécution, ouvert à toute session authentifiée.
 * POST   /api/cron-jobs/:id/trigger  — déclenchement manuel — operator/admin (hook global, aucune
 *                                       restriction de rôle supplémentaire ici).
 *
 * CHOIX DE RÔLE (demandé explicitement à trancher et documenter, cf. mission) : contrairement aux
 * autres nouveautés "légères" du même lot (métriques, lecture seule), un cron job DÉFINIT une
 * COMMANDE SHELL ARBITRAIRE exécutée sans confirmation, de façon récurrente et non supervisée,
 * dans un conteneur existant — le risque n'est pas la lecture d'une donnée mais la possibilité de
 * planter un mécanisme de persistance/mouvement latéral silencieux (comparable en gravité à
 * /api/secrets, /api/remote-environments, /api/lxc/config, PUT/DELETE /api/ad-dns/config, tous
 * admin-only pour leurs routes mutantes). CRUD (POST/PATCH/DELETE) est donc réservé au rôle
 * `admin`, EXACTEMENT comme ces intégrations. En revanche, DÉCLENCHER manuellement un job DÉJÀ
 * défini (donc déjà revu par un admin à sa création) n'introduit aucune commande nouvelle — c'est
 * l'équivalent d'un `docker exec` ponctuel, déjà réservé à operator/admin pour la console
 * interactive (routes/console.ts) : `POST .../trigger` suit donc le standard operator/admin du
 * hook global, sans restriction supplémentaire.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobs,
  updateCronJob,
} from "../services/cronJobsStore.js";
import { CronJobNotFoundError, isValidCronExpression, listCronJobRuns, triggerCronJobRun } from "../services/cronJobsScheduler.js";

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que secrets.ts/lxc.ts/adDns.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

interface CronJobBody {
  name?: string;
  containerId?: string;
  containerName?: string;
  command?: string;
  schedule?: string;
  enabled?: boolean;
}

export default async function cronJobsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/cron-jobs", async (_request, reply) => {
    return reply.send(await listCronJobs());
  });

  fastify.get<{ Params: { id: string } }>("/api/cron-jobs/:id", async (request, reply) => {
    const job = await getCronJob(request.params.id);
    if (!job) return reply.code(404).send({ error: `Cron job "${request.params.id}" not found` });
    return reply.send(job);
  });

  fastify.post<{ Body: CronJobBody }>("/api/cron-jobs", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const name = body.name?.trim();
    const containerId = body.containerId?.trim();
    const containerName = body.containerName?.trim();
    const command = body.command?.trim();
    const schedule = body.schedule?.trim();

    const missing: string[] = [];
    if (!name) missing.push("name");
    if (!containerId) missing.push("containerId");
    if (!command) missing.push("command");
    if (!schedule) missing.push("schedule");
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
    }
    if (!isValidCronExpression(schedule!)) {
      return reply.code(400).send({
        error: `"${schedule}" n'est pas une expression cron valide (5 champs : minute heure jour-du-mois mois jour-de-semaine, ex "*/5 * * * *")`,
      });
    }

    const created = await createCronJob({
      name: name!,
      containerId: containerId!,
      containerName: containerName || containerId!,
      command: command!,
      schedule: schedule!,
      enabled: body.enabled ?? true,
      createdBy: request.authSession!.username,
    });
    return reply.code(201).send(created);
  });

  fastify.patch<{ Params: { id: string }; Body: CronJobBody }>("/api/cron-jobs/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    if (body.schedule !== undefined && !isValidCronExpression(body.schedule.trim())) {
      return reply.code(400).send({
        error: `"${body.schedule}" n'est pas une expression cron valide (5 champs : minute heure jour-du-mois mois jour-de-semaine, ex "*/5 * * * *")`,
      });
    }
    const updated = await updateCronJob(request.params.id, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.containerId !== undefined ? { containerId: body.containerId.trim() } : {}),
      ...(body.containerName !== undefined ? { containerName: body.containerName.trim() } : {}),
      ...(body.command !== undefined ? { command: body.command.trim() } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule.trim() } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
    if (!updated) return reply.code(404).send({ error: `Cron job "${request.params.id}" not found` });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>("/api/cron-jobs/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const deleted = await deleteCronJob(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `Cron job "${request.params.id}" not found` });
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { id: string } }>("/api/cron-jobs/:id/runs", async (request, reply) => {
    const job = await getCronJob(request.params.id);
    if (!job) return reply.code(404).send({ error: `Cron job "${request.params.id}" not found` });
    return reply.send(await listCronJobRuns(request.params.id));
  });

  fastify.post<{ Params: { id: string } }>("/api/cron-jobs/:id/trigger", async (request, reply) => {
    try {
      const run = await triggerCronJobRun(request.params.id);
      return reply.code(201).send(run);
    } catch (err) {
      if (err instanceof CronJobNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
