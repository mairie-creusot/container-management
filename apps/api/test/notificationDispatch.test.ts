import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveNotificationChannel } from "../src/services/notificationChannelsStore.js";

/**
 * Fuite réelle trouvée pendant l'analyse d'écart Vault (voir rapport de mission) : l'URL complète
 * d'un webhook Slack/Discord/générique — qui EST elle-même le secret d'authentification du canal
 * (ex: https://hooks.slack.com/services/T000/B000/XXXXXXXX, le token est le chemin) — remontait en
 * clair dans le message d'erreur de postJson() (notificationDispatch.ts), donc jusque dans le log
 * serveur (console.warn), la réponse HTTP de POST /api/notification-channels/:id/test, et
 * l'historique persistant d'automatisation. Corrigé par redactWebhookUrlForLogging() : seule
 * l'origine (protocole+hôte) doit survivre dans un message d'erreur, jamais le chemin/la query.
 *
 * Ces tests appellent le VRAI code de dispatch (sendTestNotification/dispatchNotificationEvent),
 * seul `fetch` est mocké (échec réseau simulé) — pas un test de la regex de redaction en isolation,
 * mais du comportement de bout en bout tel qu'un appelant HTTP/log le verrait réellement.
 */

const SECRET_TOKEN = "T000/B000/XXXXXXXXSUPERSECRETSLACKTOKEN";
const SLACK_WEBHOOK_URL = `https://hooks.slack.com/services/${SECRET_TOKEN}`;
const GENERIC_WEBHOOK_URL_WITH_QUERY_TOKEN = "https://notify.example.com/incoming?token=super-secret-generic-token";
/** Forme RÉELLE d'un jeton Telegram : identifiant numérique, deux-points, secret. Un jeton d'une
 * autre forme est refusé AVANT tout appel réseau (voir telegramTokenComplaint). */
const TELEGRAM_TOKEN = "8123456789:AAH1kQwErTyUiOpAsDfGhJkLzXcVbNm0987";

function fakeChannel(overrides: Partial<EffectiveNotificationChannel>): EffectiveNotificationChannel {
  return {
    id: "chan-1",
    kind: "slack",
    name: "Canal de test",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as EffectiveNotificationChannel;
}

let getEffectiveNotificationChannelMock: ReturnType<typeof vi.fn>;
let listEffectiveEnabledNotificationChannelsMock: ReturnType<typeof vi.fn>;

vi.mock("../src/services/notificationChannelsStore.js", () => ({
  getEffectiveNotificationChannel: (...args: unknown[]) => getEffectiveNotificationChannelMock(...args),
  listEffectiveEnabledNotificationChannels: (...args: unknown[]) => listEffectiveEnabledNotificationChannelsMock(...args),
}));

const { sendTestNotification, sendChannelNotification, dispatchNotificationEvent } = await import(
  "../src/services/notificationDispatch.js"
);

describe("notificationDispatch — ne journalise/ne persiste/ne renvoie jamais l'URL secrète d'un webhook en clair", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getEffectiveNotificationChannelMock = vi.fn();
    listEffectiveEnabledNotificationChannelsMock = vi.fn();
    // Toute requête réseau échoue (canal injoignable) — c'est justement le chemin qui déclenchait
    // la fuite : le message d'erreur embarquait l'URL complète.
    fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleWarnSpy.mockRestore();
  });

  it("sendTestNotification (réponse API admin) ne renvoie jamais le token Slack embarqué dans l'URL", async () => {
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "slack", slack: { webhookUrl: SLACK_WEBHOOK_URL } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(SECRET_TOKEN);
    expect(result.message).not.toContain(SLACK_WEBHOOK_URL);
    // L'origine seule (non sensible) peut légitimement rester, utile pour diagnostiquer.
    expect(result.message).toContain("hooks.slack.com");
  });

  it("sendChannelNotification (utilisé par le moteur d'automatisation, persisté dans son historique) ne renvoie jamais un jeton porté en query string", async () => {
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "webhook", webhook: { url: GENERIC_WEBHOOK_URL_WITH_QUERY_TOKEN } }),
    );

    const result = await sendChannelNotification("chan-1", "message de test");

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("super-secret-generic-token");
    expect(result.message).toContain("notify.example.com");
  });

  it("dispatchNotificationEvent (log serveur console.warn) ne journalise jamais le token du canal en échec", async () => {
    listEffectiveEnabledNotificationChannelsMock.mockResolvedValue([
      fakeChannel({ kind: "discord", discord: { webhookUrl: `https://discord.com/api/webhooks/${SECRET_TOKEN}` } }),
    ]);

    await dispatchNotificationEvent({
      id: "evt-1",
      timestamp: new Date().toISOString(),
      kind: "integration_reachable",
      level: "error",
      message: "test",
    });

    expect(consoleWarnSpy).toHaveBeenCalled();
    const loggedText = consoleWarnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText).not.toContain(SECRET_TOKEN);
    expect(loggedText).toContain("discord.com");
  });

  it("Telegram : le jeton du bot n'apparaît jamais dans un message d'échec (il est dans l'URL)", async () => {
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "telegram", telegram: { botToken: TELEGRAM_TOKEN, chatId: "123456789" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(TELEGRAM_TOKEN);
    expect(result.message).toContain("api.telegram.org");
  });

  it("Telegram : un refus de l'API ({ ok: false }) est un échec, même en HTTP 200", async () => {
    // sendMessage refuse, puis getMe départage : ici le bot est valide, donc c'est le destinataire.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { username: "quai_bot" } }),
      });
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "telegram", telegram: { botToken: TELEGRAM_TOKEN, chatId: "999" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("chat not found");
    expect(result.message).not.toContain(TELEGRAM_TOKEN);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
    expect(JSON.parse(String((init as { body: string }).body)).chat_id).toBe("999");
  });

  it("Telegram : un jeton refusé est nommé comme tel, pas confondu avec un destinataire introuvable", async () => {
    // Les deux causes donnent « 404 Not Found » côté Telegram : c'est getMe qui les départage.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }),
    });
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "telegram", telegram: { botToken: TELEGRAM_TOKEN, chatId: "-1001234567890" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("jeton du bot est refusé");
    expect(result.message).toContain("BotFather");
    expect(result.message).not.toContain(TELEGRAM_TOKEN);
  });

  it("Telegram : un destinataire refusé nomme le bot reconnu et ce qu'il faut vérifier", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { username: "quai_bot" } }),
      });
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "telegram", telegram: { botToken: TELEGRAM_TOKEN, chatId: "42" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.message).toContain("@quai_bot");
    expect(result.message).toContain('"42"');
    expect(result.message).toContain("-100");
  });

  it("Telegram : une saisie manifestement fautive est expliquée SANS appeler l'API", async () => {
    for (const [botToken, expected] of [
      ["bot8123456789:AAH1kQwErTyUiOpAsDfGhJkLzXcVbNm0987", "préfixe"],
      ["-1001234567890", "intervertis"],
      ["8123456789:court", "forme attendue"],
    ] as const) {
      getEffectiveNotificationChannelMock.mockResolvedValue(
        fakeChannel({ kind: "telegram", telegram: { botToken, chatId: "123" } }),
      );
      const result = await sendTestNotification("chan-1");

      expect(result.ok, botToken).toBe(false);
      expect(result.message, botToken).toContain(expected);
    }
    // Aucun appel réseau : une erreur de saisie se dit sans déranger Telegram.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("une URL de webhook malformée ne provoque jamais un throw non maîtrisé (repli explicite, jamais l'URL brute)", async () => {
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "webhook", webhook: { url: "pas-une-url-valide" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("pas-une-url-valide");
  });
});
