/**
 * Canaux de notification sortants (webhook générique/Slack/Discord/email SMTP) — cf.
 * ARCHITECTURE.md, chapitre "Notifications sortantes vers canaux externes". Liste nommée de
 * canaux persistés, chacun avec un type, un statut actif/inactif et un filtre optionnel par
 * niveau (`SystemNotificationEvent["level"]`) et/ou par type d'événement (`SystemNotificationKind`).
 *
 * Même pattern EXACT que remoteDockerStore.ts/lxcStore.ts : persistance JSON sur disque, cache
 * mémoire process invalidé à chaque écriture, fichier écrit avec des permissions restrictives
 * (0600). Chemin dérivé de CONFIG_PATH (même répertoire, même principe que
 * notificationsStore.ts#resolvedNotificationsLogPath) plutôt qu'une nouvelle variable
 * d'environnement dédiée — pas besoin d'un fichier de config séparé pour une seule petite liste.
 *
 * Secrets au repos : l'URL d'un webhook générique/Slack/Discord porte souvent un jeton
 * d'authentification directement dans l'URL (ex: https://hooks.slack.com/services/T.../B.../XXXX)
 * — traitée comme un secret à part entière, chiffrée au repos (AES-256-GCM, crypto.ts) comme
 * ca/cert/key dans remoteDockerStore.ts. Le mot de passe SMTP est chiffré de la même façon (le
 * reste de la config email — hôte/port/utilisateur/expéditeur/destinataire — n'est pas un secret,
 * stocké en clair, comme host/port dans remoteDockerStore.ts). Aucune route GET ne renvoie jamais
 * ces valeurs en clair (write-only, voir toRef ci-dessous) — seule une fonction interne non
 * exposée (getEffectiveNotificationChannel/listEffectiveEnabledNotificationChannels) les
 * déchiffre, réservée à notificationDispatch.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded } from "./crypto.js";
import { writeFileRestricted } from "../utils/secureFile.js";
import type {
  NotificationChannelFilter,
  NotificationChannelKind,
  NotificationChannelRef,
} from "../types.js";

export interface StoredWebhookConfig {
  url: string; // chiffré au repos
}
export interface StoredSlackConfig {
  webhookUrl: string; // chiffré au repos
}
export interface StoredDiscordConfig {
  webhookUrl: string; // chiffré au repos
}
export interface StoredTelegramConfig {
  botToken: string; // chiffré au repos
  chatId: string;
}
export interface StoredEmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUsername?: string;
  smtpPassword?: string; // chiffré au repos
  smtpSecure: boolean;
  fromAddress: string;
  toAddress: string;
}

interface StoredNotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  filter?: NotificationChannelFilter;
  webhook?: StoredWebhookConfig;
  slack?: StoredSlackConfig;
  discord?: StoredDiscordConfig;
  telegram?: StoredTelegramConfig;
  email?: StoredEmailConfig;
  createdAt: string;
  updatedAt: string;
}

/** Config effective (déchiffrée) d'UN canal — réservée à notificationDispatch.ts, jamais exposée par une route. */
export interface EffectiveNotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  filter?: NotificationChannelFilter;
  webhook?: { url: string };
  slack?: { webhookUrl: string };
  discord?: { webhookUrl: string };
  telegram?: { botToken: string; chatId: string };
  email?: {
    smtpHost: string;
    smtpPort: number;
    smtpUsername?: string;
    smtpPassword?: string;
    smtpSecure: boolean;
    fromAddress: string;
    toAddress: string;
  };
}

export class NotificationChannelValidationError extends Error {}

let cache: StoredNotificationChannel[] | null = null;

function resolvedStorePath(): string {
  // Même répertoire que config.json/notifications-log.jsonl (CONFIG_PATH) — voir notificationsStore.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "notification-channels.json");
}

async function readFromDisk(): Promise<StoredNotificationChannel[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredNotificationChannel[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: StoredNotificationChannel[]): Promise<void> {
  // 0600 réellement forcé, y compris sur un fichier préexistant — voir utils/secureFile.ts.
  await writeFileRestricted(resolvedStorePath(), JSON.stringify(next, null, 2));
}

async function getAll(): Promise<StoredNotificationChannel[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

function toRef(channel: StoredNotificationChannel): NotificationChannelRef {
  return {
    id: channel.id,
    kind: channel.kind,
    name: channel.name,
    enabled: channel.enabled,
    ...(channel.filter ? { filter: channel.filter } : {}),
    ...(channel.webhook ? { webhook: { hasUrl: Boolean(channel.webhook.url) } } : {}),
    ...(channel.slack ? { slack: { hasWebhookUrl: Boolean(channel.slack.webhookUrl) } } : {}),
    ...(channel.discord ? { discord: { hasWebhookUrl: Boolean(channel.discord.webhookUrl) } } : {}),
    ...(channel.telegram
      ? { telegram: { chatId: channel.telegram.chatId, hasBotToken: Boolean(channel.telegram.botToken) } }
      : {}),
    ...(channel.email
      ? {
          email: {
            smtpHost: channel.email.smtpHost,
            smtpPort: channel.email.smtpPort,
            ...(channel.email.smtpUsername ? { smtpUsername: channel.email.smtpUsername } : {}),
            smtpSecure: channel.email.smtpSecure,
            fromAddress: channel.email.fromAddress,
            toAddress: channel.email.toAddress,
            hasSmtpPassword: Boolean(channel.email.smtpPassword),
          },
        }
      : {}),
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function toEffective(channel: StoredNotificationChannel): EffectiveNotificationChannel {
  return {
    id: channel.id,
    kind: channel.kind,
    name: channel.name,
    enabled: channel.enabled,
    ...(channel.filter ? { filter: channel.filter } : {}),
    ...(channel.webhook ? { webhook: { url: decryptSecret(channel.webhook.url) } } : {}),
    ...(channel.slack ? { slack: { webhookUrl: decryptSecret(channel.slack.webhookUrl) } } : {}),
    ...(channel.discord ? { discord: { webhookUrl: decryptSecret(channel.discord.webhookUrl) } } : {}),
    ...(channel.telegram
      ? { telegram: { botToken: decryptSecret(channel.telegram.botToken), chatId: channel.telegram.chatId } }
      : {}),
    ...(channel.email
      ? {
          email: {
            smtpHost: channel.email.smtpHost,
            smtpPort: channel.email.smtpPort,
            ...(channel.email.smtpUsername ? { smtpUsername: channel.email.smtpUsername } : {}),
            ...(channel.email.smtpPassword ? { smtpPassword: decryptSecret(channel.email.smtpPassword) } : {}),
            smtpSecure: channel.email.smtpSecure,
            fromAddress: channel.email.fromAddress,
            toAddress: channel.email.toAddress,
          },
        }
      : {}),
  };
}

export interface WebhookConfigInput {
  url: string;
}
export interface SlackConfigInput {
  webhookUrl: string;
}
export interface DiscordConfigInput {
  webhookUrl: string;
}
export interface TelegramConfigInput {
  botToken: string;
  chatId: string;
}
export interface EmailConfigInput {
  smtpHost: string;
  smtpPort: number;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpSecure: boolean;
  fromAddress: string;
  toAddress: string;
}

export interface NotificationChannelInput {
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  filter?: NotificationChannelFilter;
  webhook?: WebhookConfigInput;
  slack?: SlackConfigInput;
  discord?: DiscordConfigInput;
  telegram?: TelegramConfigInput;
  email?: EmailConfigInput;
}

function assertValidUrl(value: string, field: string): void {
  let ok = false;
  try {
    ok = new URL(value).protocol === "http:" || new URL(value).protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) throw new NotificationChannelValidationError(`${field} must be a valid http(s) URL`);
}

/**
 * Forme d'un jeton de bot Telegram : `<identifiant numérique>:<secret>`. Vérifiée À L'ENREGISTREMENT,
 * pas seulement à l'envoi : QUAI ne doit jamais STOCKER une valeur qui ne peut pas être un jeton.
 *
 * Le cas réel qui a motivé ce contrôle (27/08/2026) : le champ est de type `password`, et un
 * gestionnaire de mots de passe du navigateur peut le pré-remplir à l'ouverture du formulaire
 * d'édition. Sans ce garde-fou, la valeur autoremplie remplaçait silencieusement un jeton valide —
 * le canal se mettait alors à échouer en « HTTP 404 » alors que le vrai jeton, lui, fonctionnait.
 */
const TELEGRAM_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{30,}$/;

function assertValidTelegramToken(value: string): void {
  const token = value.trim();
  if (token.toLowerCase().startsWith("bot")) {
    throw new NotificationChannelValidationError(
      "telegram.botToken : le préfixe « bot » appartient à l'URL de l'API, il ne fait pas partie du jeton de @BotFather.",
    );
  }
  if (!TELEGRAM_TOKEN_SHAPE.test(token)) {
    throw new NotificationChannelValidationError(
      "telegram.botToken : forme attendue « 123456789:AA… » (identifiant numérique, deux-points, secret). " +
        "Si ce champ a été pré-rempli par votre navigateur, ressaisissez le jeton donné par @BotFather.",
    );
  }
}

function assertValidPort(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new NotificationChannelValidationError(`${field} must be an integer between 1 and 65535`);
  }
}

/** Valide name/kind et — si `requireCredentials` — que la config du type déclaré est bien fournie. */
function assertValidInput(input: NotificationChannelInput, requireCredentials: boolean): void {
  if (!input.name.trim()) throw new NotificationChannelValidationError("name is required");

  if (input.kind === "webhook") {
    if (requireCredentials && !input.webhook?.url?.trim()) {
      throw new NotificationChannelValidationError('webhook.url is required for kind "webhook"');
    }
    if (input.webhook?.url) assertValidUrl(input.webhook.url, "webhook.url");
  } else if (input.kind === "slack") {
    if (requireCredentials && !input.slack?.webhookUrl?.trim()) {
      throw new NotificationChannelValidationError('slack.webhookUrl is required for kind "slack"');
    }
    if (input.slack?.webhookUrl) assertValidUrl(input.slack.webhookUrl, "slack.webhookUrl");
  } else if (input.kind === "discord") {
    if (requireCredentials && !input.discord?.webhookUrl?.trim()) {
      throw new NotificationChannelValidationError('discord.webhookUrl is required for kind "discord"');
    }
    if (input.discord?.webhookUrl) assertValidUrl(input.discord.webhookUrl, "discord.webhookUrl");
  } else if (input.kind === "telegram") {
    // Aucune URL à valider : l'API Telegram est toujours api.telegram.org, seuls le jeton du bot
    // et le destinataire varient.
    if (requireCredentials && !input.telegram?.botToken?.trim()) {
      throw new NotificationChannelValidationError('telegram.botToken is required for kind "telegram"');
    }
    if (requireCredentials && !input.telegram?.chatId?.trim()) {
      throw new NotificationChannelValidationError('telegram.chatId is required for kind "telegram"');
    }
    if (input.telegram?.botToken?.trim()) assertValidTelegramToken(input.telegram.botToken);
  } else if (input.kind === "email") {
    const email = input.email;
    if (requireCredentials) {
      if (!email?.smtpHost?.trim()) throw new NotificationChannelValidationError("email.smtpHost is required");
      if (!email?.fromAddress?.trim()) throw new NotificationChannelValidationError("email.fromAddress is required");
      if (!email?.toAddress?.trim()) throw new NotificationChannelValidationError("email.toAddress is required");
    }
    if (email?.smtpPort !== undefined) assertValidPort(email.smtpPort, "email.smtpPort");
  } else {
    throw new NotificationChannelValidationError(`Unknown notification channel kind: ${String(input.kind)}`);
  }
}

function encryptWebhook(input: WebhookConfigInput): StoredWebhookConfig {
  return { url: encryptSecretIfNeeded(input.url.trim()) };
}
function encryptSlack(input: SlackConfigInput): StoredSlackConfig {
  return { webhookUrl: encryptSecretIfNeeded(input.webhookUrl.trim()) };
}
function encryptDiscord(input: DiscordConfigInput): StoredDiscordConfig {
  return { webhookUrl: encryptSecretIfNeeded(input.webhookUrl.trim()) };
}
function encryptTelegram(input: TelegramConfigInput): StoredTelegramConfig {
  return { botToken: encryptSecretIfNeeded(input.botToken.trim()), chatId: input.chatId.trim() };
}
function encryptEmail(input: EmailConfigInput): StoredEmailConfig {
  return {
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort,
    ...(input.smtpUsername?.trim() ? { smtpUsername: input.smtpUsername.trim() } : {}),
    ...(input.smtpPassword ? { smtpPassword: encryptSecretIfNeeded(input.smtpPassword) } : {}),
    smtpSecure: input.smtpSecure,
    fromAddress: input.fromAddress.trim(),
    toAddress: input.toAddress.trim(),
  };
}

/** GET /api/notification-channels — jamais de secret en clair, voir toRef(). */
export async function listNotificationChannels(): Promise<NotificationChannelRef[]> {
  return (await getAll()).map(toRef);
}

export async function getNotificationChannelRef(id: string): Promise<NotificationChannelRef | undefined> {
  const found = (await getAll()).find((c) => c.id === id);
  return found ? toRef(found) : undefined;
}

/** Réservé à notificationDispatch.ts — canaux déchiffrés, ACTIFS uniquement (`enabled === true`). */
export async function listEffectiveEnabledNotificationChannels(): Promise<EffectiveNotificationChannel[]> {
  return (await getAll()).filter((c) => c.enabled).map(toEffective);
}

/** Réservé à notificationDispatch.ts (test d'un canal précis) — sans filtrer sur `enabled` : un
 * test explicite doit fonctionner même pour un canal désactivé, le temps de le valider avant activation. */
export async function getEffectiveNotificationChannel(id: string): Promise<EffectiveNotificationChannel | undefined> {
  const found = (await getAll()).find((c) => c.id === id);
  return found ? toEffective(found) : undefined;
}

/** POST /api/notification-channels — admin uniquement (voir routes/notificationChannels.ts). */
export async function createNotificationChannel(input: NotificationChannelInput): Promise<NotificationChannelRef> {
  assertValidInput(input, true);
  const all = await getAll();
  const now = new Date().toISOString();
  const webhook = input.kind === "webhook" && input.webhook ? encryptWebhook(input.webhook) : undefined;
  const slack = input.kind === "slack" && input.slack ? encryptSlack(input.slack) : undefined;
  const discord = input.kind === "discord" && input.discord ? encryptDiscord(input.discord) : undefined;
  const telegram = input.kind === "telegram" && input.telegram ? encryptTelegram(input.telegram) : undefined;
  const email = input.kind === "email" && input.email ? encryptEmail(input.email) : undefined;
  const created: StoredNotificationChannel = {
    id: randomUUID(),
    kind: input.kind,
    name: input.name.trim(),
    enabled: input.enabled,
    ...(input.filter ? { filter: input.filter } : {}),
    ...(webhook ? { webhook } : {}),
    ...(slack ? { slack } : {}),
    ...(discord ? { discord } : {}),
    ...(telegram ? { telegram } : {}),
    ...(email ? { email } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const next = [...all, created];
  await writeToDisk(next);
  cache = next;
  return toRef(created);
}

export interface NotificationChannelPatch {
  name?: string;
  enabled?: boolean;
  // filter omis = filtre conservé tel quel ; filter: {} explicite = filtre effacé (tous niveaux/
  // types) ; filter avec levels/kinds fourni = remplace le filtre entier (pas de fusion partielle,
  // un filtre est une unité cohérente, même principe que tls dans remoteDockerStore.ts).
  filter?: NotificationChannelFilter;
  clearFilter?: boolean;
  // La config spécifique au type ne peut être modifiée que pour SON PROPRE type (le kind d'un
  // canal existant n'est jamais changé après création — recréer un canal plutôt que reconvertir
  // un webhook en canal email). Champs omis à l'intérieur d'un webhook/slack/discord/email =
  // valeur déjà enregistrée conservée ; url/webhookUrl/smtpPassword vides = valeur déjà
  // enregistrée conservée (même convention que password/token dans setupStore.ts#updateRegistryAt).
  webhook?: Partial<WebhookConfigInput>;
  slack?: Partial<SlackConfigInput>;
  discord?: Partial<DiscordConfigInput>;
  telegram?: Partial<TelegramConfigInput>;
  email?: Partial<EmailConfigInput>;
}

/** PATCH /api/notification-channels/:id — admin uniquement. */
export async function updateNotificationChannel(
  id: string,
  patch: NotificationChannelPatch,
): Promise<NotificationChannelRef | undefined> {
  const all = await getAll();
  const index = all.findIndex((c) => c.id === id);
  if (index === -1) return undefined;
  const existing = all[index]!;

  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new NotificationChannelValidationError("name is required");

  const nextEnabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  const nextFilter = patch.clearFilter ? undefined : (patch.filter ?? existing.filter);

  // Seule la config du type déjà enregistré (existing.kind) peut être modifiée — un patch
  // "webhook"/"slack"/"discord"/"email" ne correspondant pas au kind du canal est simplement
  // ignoré (aucune section ajoutée pour un type qui n'est pas le sien).
  let nextWebhook = existing.webhook;
  if (existing.kind === "webhook" && patch.webhook?.url?.trim()) {
    assertValidUrl(patch.webhook.url, "webhook.url");
    nextWebhook = encryptWebhook({ url: patch.webhook.url });
  }

  let nextSlack = existing.slack;
  if (existing.kind === "slack" && patch.slack?.webhookUrl?.trim()) {
    assertValidUrl(patch.slack.webhookUrl, "slack.webhookUrl");
    nextSlack = encryptSlack({ webhookUrl: patch.slack.webhookUrl });
  }

  let nextDiscord = existing.discord;
  if (existing.kind === "discord" && patch.discord?.webhookUrl?.trim()) {
    assertValidUrl(patch.discord.webhookUrl, "discord.webhookUrl");
    nextDiscord = encryptDiscord({ webhookUrl: patch.discord.webhookUrl });
  }

  let nextTelegram = existing.telegram;
  if (existing.kind === "telegram" && patch.telegram) {
    // Jeton vide = on conserve celui déjà chiffré, même convention que le mot de passe SMTP.
    const chatId = patch.telegram.chatId?.trim() ? patch.telegram.chatId.trim() : (existing.telegram?.chatId ?? "");
    if (!chatId) throw new NotificationChannelValidationError("telegram.chatId is required");
    if (patch.telegram.botToken?.trim()) assertValidTelegramToken(patch.telegram.botToken);
    nextTelegram = {
      botToken: patch.telegram.botToken?.trim()
        ? encryptSecretIfNeeded(patch.telegram.botToken.trim())
        : (existing.telegram?.botToken ?? ""),
      chatId,
    };
    if (!nextTelegram.botToken) throw new NotificationChannelValidationError("telegram.botToken is required");
  }

  let nextEmail = existing.email;
  if (existing.kind === "email" && patch.email) {
    const smtpPort = patch.email.smtpPort ?? existing.email?.smtpPort ?? 587;
    assertValidPort(smtpPort, "email.smtpPort");
    const smtpUsername = patch.email.smtpUsername !== undefined ? patch.email.smtpUsername : existing.email?.smtpUsername;
    nextEmail = {
      smtpHost: patch.email.smtpHost?.trim() ? patch.email.smtpHost.trim() : (existing.email?.smtpHost ?? ""),
      smtpPort,
      ...(smtpUsername?.trim() ? { smtpUsername: smtpUsername.trim() } : {}),
      // smtpPassword vide/absent = conserver le mot de passe déjà chiffré tel quel (jamais
      // redéchiffré/rechiffré inutilement) — une valeur RÉELLEMENT fournie déclenche un remplacement.
      ...(patch.email.smtpPassword
        ? { smtpPassword: encryptSecretIfNeeded(patch.email.smtpPassword) }
        : existing.email?.smtpPassword
          ? { smtpPassword: existing.email.smtpPassword }
          : {}),
      smtpSecure: patch.email.smtpSecure !== undefined ? patch.email.smtpSecure : (existing.email?.smtpSecure ?? false),
      fromAddress: patch.email.fromAddress?.trim() ? patch.email.fromAddress.trim() : (existing.email?.fromAddress ?? ""),
      toAddress: patch.email.toAddress?.trim() ? patch.email.toAddress.trim() : (existing.email?.toAddress ?? ""),
    };
    if (!nextEmail.smtpHost) throw new NotificationChannelValidationError("email.smtpHost is required");
    if (!nextEmail.fromAddress) throw new NotificationChannelValidationError("email.fromAddress is required");
    if (!nextEmail.toAddress) throw new NotificationChannelValidationError("email.toAddress is required");
  }

  const updated: StoredNotificationChannel = {
    id: existing.id,
    kind: existing.kind,
    name: nextName,
    enabled: nextEnabled,
    ...(nextFilter ? { filter: nextFilter } : {}),
    ...(nextWebhook ? { webhook: nextWebhook } : {}),
    ...(nextSlack ? { slack: nextSlack } : {}),
    ...(nextDiscord ? { discord: nextDiscord } : {}),
    ...(nextTelegram ? { telegram: nextTelegram } : {}),
    ...(nextEmail ? { email: nextEmail } : {}),
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const next = all.map((c, i) => (i === index ? updated : c));
  await writeToDisk(next);
  cache = next;
  return toRef(updated);
}

/** DELETE /api/notification-channels/:id — admin uniquement. */
export async function deleteNotificationChannel(id: string): Promise<boolean> {
  const all = await getAll();
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;
  return true;
}
