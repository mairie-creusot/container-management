/**
 * Dispatch sortant des événements système (`SystemNotificationEvent`) vers les canaux de
 * notification externes configurés (voir services/notificationChannelsStore.ts) — cf.
 * ARCHITECTURE.md, chapitre "Notifications sortantes vers canaux externes".
 *
 * Appelé UNIQUEMENT depuis notificationsStore.ts#recordNotificationEvent, en fire-and-forget,
 * après l'écriture réussie du journal JSONL interne — jamais avant, jamais bloquant. Même
 * discipline que tout le reste de ce fichier/du watchdog : une panne d'envoi (canal injoignable,
 * mauvaise config...) ne doit JAMAIS faire échouer le cycle du watchdog/réconciliateur/scheduler
 * qui a émis l'événement, ni remonter d'exception à l'appelant. `dispatchNotificationEvent` et
 * `sendTestNotification` (POST /api/notification-channels/:id/test) partagent la même fonction
 * d'envoi bas niveau (`sendToChannel`) — un test envoie donc RÉELLEMENT au canal choisi, avec
 * exactement le même code que la production, sans persister l'événement de test dans le journal.
 *
 * Formats de payload (vérifiés dans la documentation officielle) :
 * - Slack (Incoming Webhooks) : POST JSON `{ "text": "..." }` — https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
 * - Discord (Execute Webhook) : POST JSON `{ "content": "..." }` (max 2000 caractères) — https://discord.com/developers/docs/resources/webhook#execute-webhook
 * - Webhook générique : POST JSON brut, le `SystemNotificationEvent` tel quel.
 * - Email : SMTP réel via nodemailer (package établi, aucune réimplémentation SMTP maison).
 */

import nodemailer from "nodemailer";
import { config } from "../config.js";
import {
  getEffectiveNotificationChannel,
  listEffectiveEnabledNotificationChannels,
} from "./notificationChannelsStore.js";
import type { EffectiveNotificationChannel } from "./notificationChannelsStore.js";
import type { SystemNotificationEvent } from "../types.js";

const DISCORD_CONTENT_MAX_LENGTH = 2000;

function matchesFilter(channel: EffectiveNotificationChannel, event: Omit<SystemNotificationEvent, "read">): boolean {
  const filter = channel.filter;
  if (!filter) return true;
  if (filter.levels && filter.levels.length > 0 && !filter.levels.includes(event.level)) return false;
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) return false;
  return true;
}

/**
 * Résumé sûr d'une URL de webhook pour un message d'erreur (jamais loggé/persisté tel quel) — ne
 * renvoie JAMAIS le chemin ni la query string, qui embarquent le secret d'authentification du
 * canal pour Slack/Discord/un webhook générique (ex: https://hooks.slack.com/services/T000/B000/
 * XXXXXXXX, le TOKEN est le chemin lui-même ; un webhook générique peut porter un jeton en query
 * string) : seule l'origine (protocole + hôte + port) est utile pour diagnostiquer un canal
 * injoignable, et elle n'est jamais sensible. Le message produit par postJson() remonte tel quel
 * jusqu'à trois endroits qui ne doivent jamais voir le secret en clair : le log serveur
 * (dispatchNotificationEvent -> console.warn), l'historique PERSISTANT d'automatisation
 * (automationRunLog via automationEngine.ts) et la réponse HTTP de POST
 * /api/notification-channels/:id/test (sendTestNotification, exposée à un admin via l'API) —
 * corrige la fuite trouvée lors de l'analyse d'écart Vault (jamais un secret en clair dans un log,
 * cf. docs/reports/security-audit-2026-08-12.md pour le même principe appliqué ailleurs dans QUAI).
 */
function redactWebhookUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/••• (chemin masqué : peut contenir le jeton du canal)`;
  } catch {
    return "URL de webhook invalide";
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.notificationChannels.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${config.notificationChannels.requestTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`${redactWebhookUrlForLogging(url)}: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

function levelLabel(level: SystemNotificationEvent["level"]): string {
  return level === "error" ? "Erreur" : level === "success" ? "Succès" : "Info";
}

async function sendEmail(email: NonNullable<EffectiveNotificationChannel["email"]>, event: Omit<SystemNotificationEvent, "read">): Promise<void> {
  // nodemailer (package établi, ~cf. mission) — aucune réimplémentation SMTP maison. Le timeout
  // couvre autant la connexion que l'envoi (mêmes options que fetch/AbortController ci-dessus,
  // nodemailer expose ses propres options de timeout dédiées côté transport SMTP).
  const transporter = nodemailer.createTransport({
    host: email.smtpHost,
    port: email.smtpPort,
    secure: email.smtpSecure,
    ...(email.smtpUsername && email.smtpPassword
      ? { auth: { user: email.smtpUsername, pass: email.smtpPassword } }
      : {}),
    connectionTimeout: config.notificationChannels.requestTimeoutMs,
    greetingTimeout: config.notificationChannels.requestTimeoutMs,
    socketTimeout: config.notificationChannels.requestTimeoutMs,
  });
  await transporter.sendMail({
    from: email.fromAddress,
    to: email.toAddress,
    subject: `[QUAI] ${levelLabel(event.level)} — ${event.kind}`,
    text: `${event.message}\n\n(${event.timestamp})`,
  });
}

/**
 * Telegram Bot API : POST https://api.telegram.org/bot<jeton>/sendMessage, corps
 * `{ chat_id, text }`. Le jeton fait partie de l'URL — il ne doit JAMAIS apparaître dans un
 * message d'erreur, d'où l'URL remplacée par un libellé fixe dans le rapport d'échec. Un refus
 * répond 200 ou 4xx avec `{ ok: false, description }` : les deux sont traités comme un échec.
 */
async function sendTelegram(telegram: { botToken: string; chatId: string }, event: Omit<SystemNotificationEvent, "read">): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.notificationChannels.requestTimeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text: `[QUAI] ${levelLabel(event.level)} — ${event.message}`,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const raw = await response.text().catch(() => "");
    let description = "";
    try {
      const parsed = JSON.parse(raw) as { ok?: boolean; description?: string };
      if (parsed.ok === false) description = parsed.description ?? "refus sans motif";
    } catch {
      description = response.ok ? "" : raw.slice(0, 300);
    }
    if (!response.ok || description) {
      throw new Error(`HTTP ${response.status}${description ? `: ${description}` : ""}`);
    }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${config.notificationChannels.requestTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`api.telegram.org (jeton masqué): ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Envoi RÉEL vers un seul canal — lève en cas d'échec (l'appelant décide de logger/avaler). */
async function sendToChannel(channel: EffectiveNotificationChannel, event: Omit<SystemNotificationEvent, "read">): Promise<void> {
  if (channel.kind === "webhook" && channel.webhook) {
    await postJson(channel.webhook.url, event);
    return;
  }
  if (channel.kind === "slack" && channel.slack) {
    await postJson(channel.slack.webhookUrl, { text: `*[QUAI] ${levelLabel(event.level)}* — ${event.message}` });
    return;
  }
  if (channel.kind === "discord" && channel.discord) {
    const content = `**[QUAI] ${levelLabel(event.level)}** — ${event.message}`.slice(0, DISCORD_CONTENT_MAX_LENGTH);
    await postJson(channel.discord.webhookUrl, { content });
    return;
  }
  if (channel.kind === "telegram" && channel.telegram) {
    await sendTelegram(channel.telegram, event);
    return;
  }
  if (channel.kind === "email" && channel.email) {
    await sendEmail(channel.email, event);
    return;
  }
  throw new Error(`Notification channel "${channel.name}" (${channel.kind}) has no usable configuration`);
}

/**
 * Point d'entrée appelé depuis notificationsStore.ts#recordNotificationEvent — fire-and-forget,
 * n'échoue JAMAIS vers l'appelant (voir en-tête de fichier). Chaque canal actif dont le filtre
 * matche reçoit l'envoi ; l'échec d'UN canal n'affecte jamais les autres (Promise.allSettled, pas
 * Promise.all).
 */
export async function dispatchNotificationEvent(event: Omit<SystemNotificationEvent, "read">): Promise<void> {
  try {
    const channels = await listEffectiveEnabledNotificationChannels();
    const targets = channels.filter((c) => matchesFilter(c, event));
    if (targets.length === 0) return;

    const results = await Promise.allSettled(targets.map((c) => sendToChannel(c, event)));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const channel = targets[i]!;
        // eslint-disable-next-line no-console
        console.warn(
          `[notificationDispatch] failed to send to channel "${channel.name}" (${channel.kind}): ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[notificationDispatch] dispatch cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * POST /api/notification-channels/:id/test — envoi RÉEL au canal choisi, jamais persisté dans le
 * journal (`notificationsStore.ts` n'est pas appelé ici). Ignore `enabled`/`filter` du canal : un
 * test explicite doit toujours partir, y compris pour un canal désactivé ou dont le filtre
 * exclurait normalement ce niveau/type — c'est justement ce qu'un admin veut vérifier avant
 * d'activer le canal pour de vrai.
 */
export async function sendTestNotification(channelId: string): Promise<{ ok: boolean; message: string }> {
  const channel = await getEffectiveNotificationChannel(channelId);
  if (!channel) {
    return { ok: false, message: `Notification channel "${channelId}" not found` };
  }
  const testEvent: Omit<SystemNotificationEvent, "read"> = {
    id: "test",
    timestamp: new Date().toISOString(),
    kind: "integration_reachable",
    level: "info",
    message: `Test du canal "${channel.name}" — si vous recevez ce message, la configuration est valide.`,
  };
  try {
    await sendToChannel(channel, testEvent);
    return { ok: true, message: `Envoi de test réussi vers "${channel.name}"` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Échec de l'envoi de test vers "${channel.name}" : ${reason}` };
  }
}

/**
 * Envoi RÉEL d'un message libre vers un canal — réutilisé par le moteur d'automatisation
 * (services/automationEngine.ts, action "send-notification") : même fonction bas niveau
 * (`sendToChannel`) que dispatchNotificationEvent/sendTestNotification ci-dessus, donc mêmes
 * formats de payload par type de canal (Slack/Discord/webhook générique/SMTP). Ignore `enabled`/
 * `filter` du canal, exactement comme sendTestNotification : une action d'automatisation qui
 * cible explicitement ce canal doit toujours partir. Jamais persisté dans le journal de
 * notifications système (ce n'est pas un SystemNotificationEvent détecté tout seul par le
 * watchdog/scanScheduler, mais un envoi explicitement déclenché par une chaîne d'automatisation).
 */
export async function sendChannelNotification(channelId: string, message: string): Promise<{ ok: boolean; message: string }> {
  const channel = await getEffectiveNotificationChannel(channelId);
  if (!channel) {
    return { ok: false, message: `Notification channel "${channelId}" not found` };
  }
  const event: Omit<SystemNotificationEvent, "read"> = {
    id: "automation",
    timestamp: new Date().toISOString(),
    kind: "automation_triggered",
    level: "error",
    message,
  };
  try {
    await sendToChannel(channel, event);
    return { ok: true, message: `Notification envoyée vers "${channel.name}"` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Échec de l'envoi vers "${channel.name}" : ${reason}` };
  }
}
