/**
 * GET    /api/notification-channels           — liste des canaux configurés, jamais de secret en
 *                                                 clair (voir notificationChannelsStore.ts#toRef),
 *                                                 ouvert à toute session authentifiée (même
 *                                                 principe que GET /api/remote-environments).
 * POST   /api/notification-channels           — { kind, name, enabled, filter?, webhook?|slack?|
 *                                                 discord?|email? }, admin uniquement.
 * PATCH  /api/notification-channels/:id       — modifie nom/actif/filtre/config du canal, admin
 *                                                 uniquement.
 * DELETE /api/notification-channels/:id       — admin uniquement.
 * POST   /api/notification-channels/:id/test  — envoi RÉEL d'un événement de test au canal, sans
 *                                                 le persister dans le journal de notifications
 *                                                 (voir services/notificationDispatch.ts#sendTestNotification).
 *
 * Un canal de notification sortant est une config sensible comparable à ad-dns/secrets (une URL
 * webhook ou un mot de passe SMTP y transitent) : mêmes règles d'accès que routes/adDns.ts —
 * toutes les mutations (POST/PATCH/DELETE) exigent explicitement le rôle `admin`, pas seulement
 * operator/admin (le hook global n'exige qu'operator/admin pour toute méthode mutante, voir
 * plugins/auth.ts). GET/test restent ouverts à toute session authentifiée : consulter la liste
 * (sans secret) ou déclencher un test n'est pas plus sensible que consulter GET /api/notifications.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannelRef,
  listNotificationChannels,
  NotificationChannelValidationError,
  updateNotificationChannel,
} from "../services/notificationChannelsStore.js";
import type {
  DiscordConfigInput,
  EmailConfigInput,
  SlackConfigInput,
  WebhookConfigInput,
} from "../services/notificationChannelsStore.js";
import { sendTestNotification } from "../services/notificationDispatch.js";
import type { NotificationChannelFilter, NotificationChannelKind } from "../types.js";

interface ChannelBody {
  kind?: NotificationChannelKind;
  name?: string;
  enabled?: boolean;
  filter?: NotificationChannelFilter;
  clearFilter?: boolean;
  webhook?: Partial<WebhookConfigInput>;
  slack?: Partial<SlackConfigInput>;
  discord?: Partial<DiscordConfigInput>;
  email?: Partial<EmailConfigInput>;
}

const VALID_KINDS: NotificationChannelKind[] = ["webhook", "slack", "discord", "email"];

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que adDns.ts/secrets.ts. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

export default async function notificationChannelsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/notification-channels", async (_request, reply) => {
    return reply.send(await listNotificationChannels());
  });

  fastify.post<{ Body: ChannelBody }>("/api/notification-channels", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const name = body.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (!body.kind || !VALID_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` });
    }

    try {
      const created = await createNotificationChannel({
        kind: body.kind,
        name,
        enabled: body.enabled ?? true,
        ...(body.filter ? { filter: body.filter } : {}),
        ...(body.webhook?.url !== undefined ? { webhook: { url: body.webhook.url } } : {}),
        ...(body.slack?.webhookUrl !== undefined ? { slack: { webhookUrl: body.slack.webhookUrl } } : {}),
        ...(body.discord?.webhookUrl !== undefined ? { discord: { webhookUrl: body.discord.webhookUrl } } : {}),
        ...(body.email?.smtpHost !== undefined
          ? {
              email: {
                smtpHost: body.email.smtpHost,
                smtpPort: body.email.smtpPort ?? 587,
                smtpSecure: body.email.smtpSecure ?? false,
                fromAddress: body.email.fromAddress ?? "",
                toAddress: body.email.toAddress ?? "",
                ...(body.email.smtpUsername !== undefined ? { smtpUsername: body.email.smtpUsername } : {}),
                ...(body.email.smtpPassword !== undefined ? { smtpPassword: body.email.smtpPassword } : {}),
              },
            }
          : {}),
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof NotificationChannelValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.patch<{ Params: { id: string }; Body: ChannelBody }>(
    "/api/notification-channels/:id",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const body = request.body ?? {};
      try {
        const updated = await updateNotificationChannel(request.params.id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.filter !== undefined ? { filter: body.filter } : {}),
          ...(body.clearFilter !== undefined ? { clearFilter: body.clearFilter } : {}),
          ...(body.webhook !== undefined ? { webhook: body.webhook } : {}),
          ...(body.slack !== undefined ? { slack: body.slack } : {}),
          ...(body.discord !== undefined ? { discord: body.discord } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
        });
        if (!updated) {
          return reply.code(404).send({ error: `Notification channel "${request.params.id}" not found` });
        }
        return reply.send(updated);
      } catch (err) {
        if (err instanceof NotificationChannelValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/notification-channels/:id", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const deleted = await deleteNotificationChannel(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: `Notification channel "${request.params.id}" not found` });
    }
    return reply.send({ ok: true });
  });

  // Envoi RÉEL vers le canal, jamais persisté dans le journal (voir notificationDispatch.ts#sendTestNotification).
  fastify.post<{ Params: { id: string } }>("/api/notification-channels/:id/test", async (request, reply) => {
    const existing = await getNotificationChannelRef(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: `Notification channel "${request.params.id}" not found` });
    }
    const result = await sendTestNotification(request.params.id);
    return reply.send(result);
  });
}
