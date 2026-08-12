import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// CONFIG_PATH isolé (même pattern que scanScheduler.test.ts/watchdog.test.ts) — les fonctions
// testées ici (parseCronExpression/decideCronJobTick) sont pures et ne touchent jamais le disque,
// mais on s'isole quand même préventivement puisque le module importe transitivement config.js.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { decideCronJobTick, isValidCronExpression, minuteKey, parseCronExpression } = await import(
  "../src/services/cronJobsScheduler.js"
);

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

describe("parseCronExpression — syntaxe", () => {
  it("accepts a plain star field on all five fields (matches everything)", () => {
    const matcher = parseCronExpression("* * * * *");
    expect(matcher.matches(new Date("2026-08-12T00:00:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-01-01T23:59:00.000Z"))).toBe(true);
  });

  it("rejects an expression without exactly 5 fields", () => {
    expect(() => parseCronExpression("* * * *")).toThrow();
    expect(() => parseCronExpression("* * * * * *")).toThrow();
    expect(isValidCronExpression("* * * *")).toBe(false);
  });

  it("rejects a field out of range", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow();
    expect(() => parseCronExpression("* 24 * * *")).toThrow();
    expect(() => parseCronExpression("* * 32 * *")).toThrow();
    expect(() => parseCronExpression("* * * 13 *")).toThrow();
    expect(() => parseCronExpression("* * * * 7")).toThrow();
  });

  it("rejects garbage syntax", () => {
    expect(() => parseCronExpression("abc * * * *")).toThrow();
    expect(isValidCronExpression("not a cron expression at all")).toBe(false);
  });

  it("matches an exact minute value", () => {
    const matcher = parseCronExpression("30 * * * *");
    expect(matcher.matches(new Date("2026-08-12T10:30:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T10:31:00.000Z"))).toBe(false);
  });

  it("supports comma-separated lists", () => {
    const matcher = parseCronExpression("0,15,30,45 * * * *");
    expect(matcher.matches(new Date("2026-08-12T10:15:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T10:20:00.000Z"))).toBe(false);
  });

  it("supports ranges", () => {
    const matcher = parseCronExpression("* 9-17 * * *");
    expect(matcher.matches(new Date("2026-08-12T09:00:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T17:00:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T18:00:00.000Z"))).toBe(false);
    expect(matcher.matches(new Date("2026-08-12T08:59:00.000Z"))).toBe(false);
  });

  it("supports a full-field step (every N minutes, the Railway example)", () => {
    const matcher = parseCronExpression("*/5 * * * *");
    for (const minute of [0, 5, 10, 55]) {
      expect(matcher.matches(new Date(`2026-08-12T10:${String(minute).padStart(2, "0")}:00.000Z`))).toBe(true);
    }
    for (const minute of [1, 4, 6, 59]) {
      expect(matcher.matches(new Date(`2026-08-12T10:${String(minute).padStart(2, "0")}:00.000Z`))).toBe(false);
    }
  });

  it("supports a step starting from a specific value (N/S — from N to the field's max)", () => {
    const matcher = parseCronExpression("15/20 * * * *");
    expect(matcher.matches(new Date("2026-08-12T10:15:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T10:35:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T10:55:00.000Z"))).toBe(true);
    expect(matcher.matches(new Date("2026-08-12T10:14:00.000Z"))).toBe(false);
    expect(matcher.matches(new Date("2026-08-12T10:20:00.000Z"))).toBe(false);
  });

  it("uses Vixie cron OR semantics when both day-of-month AND day-of-week are restricted", () => {
    // "0 0 1 * 1" = à minuit, le 1er du mois OU tous les lundis (OR, pas AND).
    const matcher = parseCronExpression("0 0 1 * 1");
    // 2026-08-01 est un samedi (jour-du-mois matche, jour-de-semaine non) -> doit matcher (OR).
    expect(matcher.matches(new Date("2026-08-01T00:00:00.000Z"))).toBe(true);
    // 2026-08-03 est un lundi (jour-de-semaine matche, jour-du-mois non) -> doit matcher (OR).
    expect(matcher.matches(new Date("2026-08-03T00:00:00.000Z"))).toBe(true);
    // 2026-08-04 est un mardi, pas le 1er -> ne matche ni l'un ni l'autre.
    expect(matcher.matches(new Date("2026-08-04T00:00:00.000Z"))).toBe(false);
  });

  it("uses AND semantics when only one of day-of-month/day-of-week is restricted", () => {
    // "0 0 * * 1" = tous les lundis à minuit seulement (jour-de-semaine restreint, jour-du-mois "*").
    const matcher = parseCronExpression("0 0 * * 1");
    expect(matcher.matches(new Date("2026-08-03T00:00:00.000Z"))).toBe(true); // lundi
    expect(matcher.matches(new Date("2026-08-04T00:00:00.000Z"))).toBe(false); // mardi
  });
});

describe("decideCronJobTick — cadence + garde anti-chevauchement", () => {
  const NOW = new Date("2026-08-12T10:00:00.000Z"); // matche "*/5 * * * *" (minute 0)

  it("is not-due when the job is disabled, even if the schedule matches", () => {
    expect(decideCronJobTick({ enabled: false, schedule: "*/5 * * * *" }, NOW, undefined, false)).toBe("not-due");
  });

  it("is not-due when the schedule does not match this minute", () => {
    expect(decideCronJobTick({ enabled: true, schedule: "*/5 * * * *" }, new Date("2026-08-12T10:01:00.000Z"), undefined, false)).toBe(
      "not-due",
    );
  });

  it("fires when enabled, schedule matches, not already handled this minute, and no overlap", () => {
    expect(decideCronJobTick({ enabled: true, schedule: "*/5 * * * *" }, NOW, undefined, false)).toBe("fire");
  });

  it("is not-due when this exact minute was already handled (avoids double-firing across ticks in the same minute)", () => {
    const key = minuteKey(NOW);
    expect(decideCronJobTick({ enabled: true, schedule: "*/5 * * * *" }, NOW, key, false)).toBe("not-due");
  });

  it("fires again on a later minute even if a previous minute was already handled", () => {
    const previousKey = minuteKey(new Date("2026-08-12T09:55:00.000Z"));
    expect(decideCronJobTick({ enabled: true, schedule: "*/5 * * * *" }, NOW, previousKey, false)).toBe("fire");
  });

  it("skip-overlap when the schedule matches but a previous run of this job is still executing (Railway spec: 'skip the next cycle')", () => {
    expect(decideCronJobTick({ enabled: true, schedule: "*/5 * * * *" }, NOW, undefined, true)).toBe("skip-overlap");
  });

  it("never fires (not-due) for an unparseable schedule rather than throwing — a scheduler cycle must never crash on one bad job", () => {
    expect(decideCronJobTick({ enabled: true, schedule: "not a cron expression" }, NOW, undefined, false)).toBe("not-due");
  });
});
