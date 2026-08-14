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

  it("une URL de webhook malformée ne provoque jamais un throw non maîtrisé (repli explicite, jamais l'URL brute)", async () => {
    getEffectiveNotificationChannelMock.mockResolvedValue(
      fakeChannel({ kind: "webhook", webhook: { url: "pas-une-url-valide" } }),
    );

    const result = await sendTestNotification("chan-1");

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("pas-une-url-valide");
  });
});
