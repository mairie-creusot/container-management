import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * CONFIG_PATH isolé (même pattern que remoteEnvironments.test.ts/notificationsStore.test.ts) :
 * notificationChannelsStore.ts écrit notification-channels.json à côté de CONFIG_PATH — sans cet
 * isolement, ces tests pollueraient apps/api/data/ en développement réel.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CONFIG_ENCRYPTION_KEY = "3".repeat(64); // clé fixe pour ce process de test uniquement

const store = await import("../src/services/notificationChannelsStore.js");

/** Forme RÉELLE d'un jeton Telegram : identifiant numérique, deux-points, secret. QUAI refuse
 * d'enregistrer toute valeur qui n'y ressemble pas (voir assertValidTelegramToken). */
const TELEGRAM_TOKEN = "8123456789:AAH1kQwErTyUiOpAsDfGhJkLzXcVbNm0987";

const notificationChannelsPath = path.join(path.dirname(tmpConfigPath), "notification-channels.json");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(notificationChannelsPath, { force: true });
});

describe("notificationChannelsStore — CRUD", () => {
  it("starts empty", async () => {
    expect(await store.listNotificationChannels()).toEqual([]);
  });

  it("creates a webhook channel and never returns the URL in clear via toRef, but exposes hasUrl", async () => {
    const created = await store.createNotificationChannel({
      kind: "webhook",
      name: "webhook-test",
      enabled: true,
      webhook: { url: "https://webhook.example/very-secret-token" },
    });
    expect(created).toMatchObject({ kind: "webhook", name: "webhook-test", enabled: true });
    expect(created.webhook).toEqual({ hasUrl: true });
    expect(JSON.stringify(created)).not.toContain("very-secret-token");

    await store.deleteNotificationChannel(created.id);
  });

  it("rejects a missing name with a validation error", async () => {
    await expect(
      store.createNotificationChannel({ kind: "webhook", name: "", enabled: true, webhook: { url: "https://x.example" } }),
    ).rejects.toThrow(store.NotificationChannelValidationError);
  });

  it("rejects a webhook without a valid http(s) url", async () => {
    await expect(
      store.createNotificationChannel({ kind: "webhook", name: "bad-url", enabled: true, webhook: { url: "not-a-url" } }),
    ).rejects.toThrow(store.NotificationChannelValidationError);
  });

  it("rejects a webhook with no url at all", async () => {
    await expect(
      store.createNotificationChannel({ kind: "webhook", name: "no-url", enabled: true }),
    ).rejects.toThrow(store.NotificationChannelValidationError);
  });

  it("rejects an out-of-range SMTP port for an email channel", async () => {
    await expect(
      store.createNotificationChannel({
        kind: "email",
        name: "bad-port",
        enabled: true,
        email: { smtpHost: "smtp.example", smtpPort: 99999, smtpSecure: false, fromAddress: "a@example.com", toAddress: "b@example.com" },
      }),
    ).rejects.toThrow(store.NotificationChannelValidationError);
  });

  it("updates name/enabled/filter without touching the stored credentials", async () => {
    const created = await store.createNotificationChannel({
      kind: "slack",
      name: "slack-test",
      enabled: true,
      slack: { webhookUrl: "https://hooks.slack.com/services/T0/B0/XXXX" },
    });

    const updated = await store.updateNotificationChannel(created.id, {
      name: "slack-renamed",
      enabled: false,
      filter: { levels: ["error"] },
    });
    expect(updated).toMatchObject({ name: "slack-renamed", enabled: false, filter: { levels: ["error"] } });
    expect(updated?.slack).toEqual({ hasWebhookUrl: true }); // credentials inchangées

    const effective = await store.getEffectiveNotificationChannel(created.id);
    expect(effective?.slack).toEqual({ webhookUrl: "https://hooks.slack.com/services/T0/B0/XXXX" });

    await store.deleteNotificationChannel(created.id);
  });

  it("clearFilter removes a previously set filter", async () => {
    const created = await store.createNotificationChannel({
      kind: "discord",
      name: "discord-test",
      enabled: true,
      filter: { kinds: ["gitops_drift_detected"] },
      discord: { webhookUrl: "https://discord.com/api/webhooks/1/abc" },
    });
    expect(created.filter).toEqual({ kinds: ["gitops_drift_detected"] });

    const cleared = await store.updateNotificationChannel(created.id, { clearFilter: true });
    expect(cleared?.filter).toBeUndefined();

    await store.deleteNotificationChannel(created.id);
  });

  it("telegram : le jeton est chiffré au repos, jamais renvoyé, et conservé si le patch ne le fournit pas", async () => {
    const created = await store.createNotificationChannel({
      kind: "telegram",
      name: "telegram-test",
      enabled: true,
      telegram: { botToken: TELEGRAM_TOKEN, chatId: "42" },
    });
    // La vue "safe" expose le destinataire (pas un secret) mais jamais le jeton.
    expect(created.telegram).toEqual({ chatId: "42", hasBotToken: true });
    expect(JSON.stringify(created)).not.toContain(TELEGRAM_TOKEN);

    const updated = await store.updateNotificationChannel(created.id, { telegram: { chatId: "-1001234567890" } });
    expect(updated?.telegram).toEqual({ chatId: "-1001234567890", hasBotToken: true });

    const effective = await store.getEffectiveNotificationChannel(created.id);
    expect(effective?.telegram).toEqual({ botToken: TELEGRAM_TOKEN, chatId: "-1001234567890" });

    await store.deleteNotificationChannel(created.id);
  });

  it("telegram : refuse une création sans jeton ou sans destinataire", async () => {
    await expect(
      store.createNotificationChannel({ kind: "telegram", name: "x", enabled: true, telegram: { botToken: "", chatId: "42" } }),
    ).rejects.toThrow(/botToken/);
    await expect(
      store.createNotificationChannel({ kind: "telegram", name: "x", enabled: true, telegram: { botToken: TELEGRAM_TOKEN, chatId: "" } }),
    ).rejects.toThrow(/chatId/);
  });

  it("telegram : QUAI ne STOCKE jamais une valeur qui ne peut pas être un jeton", async () => {
    // Cas réel : le champ est de type `password` et un gestionnaire de mots de passe peut le
    // pré-remplir à l'édition — sans ce refus, la valeur autoremplie écrasait un jeton valide et le
    // canal se mettait à échouer en 404 alors que le vrai jeton fonctionnait.
    for (const bad of ["MotDePasseDuNavigateur", `bot${TELEGRAM_TOKEN}`, "8123456789:court", "-1001234567890"]) {
      await expect(
        store.createNotificationChannel({ kind: "telegram", name: "x", enabled: true, telegram: { botToken: bad, chatId: "42" } }),
        bad,
      ).rejects.toThrow(/botToken/);
    }

    // Et il ne peut pas non plus l'écraser par une modification.
    const created = await store.createNotificationChannel({
      kind: "telegram",
      name: "telegram-garde-fou",
      enabled: true,
      telegram: { botToken: TELEGRAM_TOKEN, chatId: "42" },
    });
    await expect(
      store.updateNotificationChannel(created.id, { telegram: { botToken: "MotDePasseDuNavigateur", chatId: "42" } }),
    ).rejects.toThrow(/botToken/);

    // Le jeton d'origine est intact : un refus ne doit rien avoir modifié.
    const effective = await store.getEffectiveNotificationChannel(created.id);
    expect(effective?.telegram?.botToken).toBe(TELEGRAM_TOKEN);
    await store.deleteNotificationChannel(created.id);
  });

  it("404s (undefined) when updating/deleting an unknown id", async () => {
    expect(await store.updateNotificationChannel("does-not-exist", { name: "x" })).toBeUndefined();
    expect(await store.deleteNotificationChannel("does-not-exist")).toBe(false);
  });
});

describe("notificationChannelsStore — secrets encrypted at rest", () => {
  it("never writes a webhook url or an SMTP password in plaintext to the store file on disk", async () => {
    const webhookChannel = await store.createNotificationChannel({
      kind: "webhook",
      name: "encryption-webhook",
      enabled: true,
      webhook: { url: "https://webhook.example/PLAINTEXT-TOKEN" },
    });
    const emailChannel = await store.createNotificationChannel({
      kind: "email",
      name: "encryption-email",
      enabled: true,
      email: {
        smtpHost: "smtp.example",
        smtpPort: 587,
        smtpSecure: false,
        smtpPassword: "PLAINTEXT-SMTP-PASSWORD",
        fromAddress: "quai@example.com",
        toAddress: "it@example.com",
      },
    });

    const raw = await fs.readFile(notificationChannelsPath, "utf-8");
    expect(raw).not.toContain("PLAINTEXT-TOKEN");
    expect(raw).not.toContain("PLAINTEXT-SMTP-PASSWORD");
    expect(raw).toContain("enc:v1:"); // préfixe de crypto.ts#encryptSecret

    const effectiveWebhook = await store.getEffectiveNotificationChannel(webhookChannel.id);
    expect(effectiveWebhook?.webhook).toEqual({ url: "https://webhook.example/PLAINTEXT-TOKEN" });
    const effectiveEmail = await store.getEffectiveNotificationChannel(emailChannel.id);
    expect(effectiveEmail?.email?.smtpPassword).toBe("PLAINTEXT-SMTP-PASSWORD");

    await store.deleteNotificationChannel(webhookChannel.id);
    await store.deleteNotificationChannel(emailChannel.id);
  });

  it("keeps the previously stored SMTP password when a PATCH omits it", async () => {
    const created = await store.createNotificationChannel({
      kind: "email",
      name: "keep-password",
      enabled: true,
      email: {
        smtpHost: "smtp.example",
        smtpPort: 587,
        smtpSecure: false,
        smtpPassword: "ORIGINAL-PASSWORD",
        fromAddress: "quai@example.com",
        toAddress: "it@example.com",
      },
    });

    await store.updateNotificationChannel(created.id, { email: { smtpHost: "smtp2.example" } });
    const effective = await store.getEffectiveNotificationChannel(created.id);
    expect(effective?.email?.smtpHost).toBe("smtp2.example");
    expect(effective?.email?.smtpPassword).toBe("ORIGINAL-PASSWORD"); // conservé malgré l'omission

    await store.deleteNotificationChannel(created.id);
  });
});

describe("notificationChannelsStore — listEffectiveEnabledNotificationChannels", () => {
  it("only returns channels with enabled === true", async () => {
    const enabledChannel = await store.createNotificationChannel({
      kind: "webhook",
      name: "enabled-one",
      enabled: true,
      webhook: { url: "https://webhook.example/enabled" },
    });
    const disabledChannel = await store.createNotificationChannel({
      kind: "webhook",
      name: "disabled-one",
      enabled: false,
      webhook: { url: "https://webhook.example/disabled" },
    });

    const effectiveEnabled = await store.listEffectiveEnabledNotificationChannels();
    const ids = effectiveEnabled.map((c) => c.id);
    expect(ids).toContain(enabledChannel.id);
    expect(ids).not.toContain(disabledChannel.id);

    await store.deleteNotificationChannel(enabledChannel.id);
    await store.deleteNotificationChannel(disabledChannel.id);
  });
});
