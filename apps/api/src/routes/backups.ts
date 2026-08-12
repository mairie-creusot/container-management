/**
 * GET    /api/backups                        — liste des définitions de sauvegarde (jamais
 *                                                accessKey/secretKey, voir backupsStore.ts#toRef).
 * POST   /api/backups                        — { name, target, destination, schedule,
 *                                                retentionCount, enabled? }, operator/admin (hook
 *                                                global — voir plugins/auth.ts, aucune règle
 *                                                supplémentaire ici contrairement à
 *                                                secrets.ts/remoteEnvironments.ts).
 * GET    /api/backups/:id                    — détail d'une définition.
 * PATCH  /api/backups/:id                    — modifie nom/cible/destination/planification/
 *                                                rétention/actif, operator/admin.
 * DELETE /api/backups/:id                    — operator/admin.
 * GET    /api/backups/:id/runs               — historique des exécutions (BackupRun[]), les plus
 *                                                récentes en premier.
 * POST   /api/backups/:id/run                — déclenchement manuel immédiat (bouton "Sauvegarder
 *                                                maintenant") — retourne le run à l'état "running"
 *                                                immédiatement (202), la sauvegarde continue en
 *                                                arrière-plan (voir services/backupScheduler.ts).
 * POST   /api/backups/:id/restore/:runId     — restauration RÉELLE et destructive : retélécharge
 *                                                l'archive/le dump depuis S3 et l'écrase sur la
 *                                                ressource cible. Bloquante (attend le résultat
 *                                                définitif) — la confirmation forte vit côté
 *                                                frontend (ConfirmDialog variant destructif,
 *                                                BackupsPage.tsx), cette route ne fait aucune
 *                                                vérification supplémentaire au-delà du rôle.
 *
 * Toutes les mutations (POST/PATCH/DELETE, y compris /run et /restore) exigent déjà
 * operator/admin via le hook global (plugins/auth.ts) : aucune restriction de rôle
 * supplémentaire n'est ajoutée ici, contrairement à secrets.ts/remoteEnvironments.ts (admin
 * uniquement) — une sauvegarde n'est pas un point d'accès administratif à un système entier au
 * même titre qu'un environnement Docker distant.
 */

import type { FastifyInstance } from "fastify";
import {
  BackupValidationError,
  createBackupDefinition,
  deleteBackupDefinition,
  getBackupDefinitionRef,
  listBackupDefinitions,
  listBackupRuns,
  updateBackupDefinition,
} from "../services/backupsStore.js";
import type { BackupDestinationInput, UpdateBackupDefinitionInput } from "../services/backupsStore.js";
import { restoreBackup, runBackupNow } from "../services/backupScheduler.js";
import type { BackupTarget } from "../types.js";

interface DestinationBody {
  endpoint?: string;
  region?: string;
  bucket?: string;
  forcePathStyle?: boolean;
  accessKey?: string;
  secretKey?: string;
}

interface CreateBackupBody {
  name?: string;
  target?: BackupTarget;
  destination?: DestinationBody;
  schedule?: string;
  retentionCount?: number;
  enabled?: boolean;
}

interface UpdateBackupBody {
  name?: string;
  target?: BackupTarget;
  destination?: DestinationBody;
  clearCredentials?: boolean;
  schedule?: string;
  retentionCount?: number;
  enabled?: boolean;
}

function destinationInputFromBody(destination: DestinationBody | undefined): BackupDestinationInput | undefined {
  if (!destination) return undefined;
  return {
    endpoint: destination.endpoint ?? "",
    bucket: destination.bucket ?? "",
    ...(destination.region !== undefined ? { region: destination.region } : {}),
    ...(destination.forcePathStyle !== undefined ? { forcePathStyle: destination.forcePathStyle } : {}),
    ...(destination.accessKey !== undefined ? { accessKey: destination.accessKey } : {}),
    ...(destination.secretKey !== undefined ? { secretKey: destination.secretKey } : {}),
  };
}

export default async function backupsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/backups", async (_request, reply) => {
    return reply.send(await listBackupDefinitions());
  });

  fastify.post<{ Body: CreateBackupBody }>("/api/backups", async (request, reply) => {
    const { name, target, destination, schedule, retentionCount, enabled } = request.body ?? {};
    if (!name || !target || !destination || !schedule || retentionCount === undefined) {
      return reply.code(400).send({ error: "name, target, destination, schedule and retentionCount are required" });
    }
    try {
      const created = await createBackupDefinition({
        name,
        target,
        destination: destinationInputFromBody(destination)!,
        schedule,
        retentionCount,
        ...(enabled !== undefined ? { enabled } : {}),
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof BackupValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/backups/:id", async (request, reply) => {
    const found = await getBackupDefinitionRef(request.params.id);
    if (!found) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
    return reply.send(found);
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateBackupBody }>("/api/backups/:id", async (request, reply) => {
    const { name, target, destination, clearCredentials, schedule, retentionCount, enabled } = request.body ?? {};
    const patch: UpdateBackupDefinitionInput = {
      ...(name !== undefined ? { name } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(destination !== undefined ? { destination: destinationInputFromBody(destination)! } : {}),
      ...(clearCredentials !== undefined ? { clearCredentials } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(retentionCount !== undefined ? { retentionCount } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    try {
      const updated = await updateBackupDefinition(request.params.id, patch);
      if (!updated) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
      return reply.send(updated);
    } catch (err) {
      if (err instanceof BackupValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>("/api/backups/:id", async (request, reply) => {
    const deleted = await deleteBackupDefinition(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { id: string } }>("/api/backups/:id/runs", async (request, reply) => {
    const found = await getBackupDefinitionRef(request.params.id);
    if (!found) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
    return reply.send(await listBackupRuns(request.params.id));
  });

  fastify.post<{ Params: { id: string } }>("/api/backups/:id/run", async (request, reply) => {
    const found = await getBackupDefinitionRef(request.params.id);
    if (!found) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
    try {
      const run = await runBackupNow(request.params.id, "manual");
      return reply.code(202).send(run);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post<{ Params: { id: string; runId: string } }>("/api/backups/:id/restore/:runId", async (request, reply) => {
    const found = await getBackupDefinitionRef(request.params.id);
    if (!found) return reply.code(404).send({ error: `Backup definition "${request.params.id}" not found` });
    try {
      const result = await restoreBackup(request.params.id, request.params.runId);
      return reply.send(result);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
