import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// CONFIG_PATH isolé dans un SOUS-DOSSIER dédié : notificationsStore.ts écrit
// notifications-log.jsonl/notifications-read-state.json à côté de CONFIG_PATH. Un simple fichier
// unique dans os.tmpdir() ne suffisait pas — le DOSSIER restait partagé avec toutes les autres
// suites, qui enregistrent elles aussi des notifications : "marquer tout comme lu" pouvait alors
// s'appliquer à un événement écrit par une autre suite exécutée en parallèle (échec réel en CI le
// 24/08/2026, invisible en local où l'ordre d'exécution différait).
const tmpDataDir = path.join(os.tmpdir(), `quai-api-test-notifications-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tmpConfigPath = path.join(tmpDataDir, "config.json");
process.env.CONFIG_PATH = tmpConfigPath;

const { recordNotificationEvent, listNotificationEvents, markAllNotificationsRead } = await import(
  "../src/services/notificationsStore.js"
);

afterAll(async () => {
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

describe("notificationsStore", () => {
  it("returns an empty list before any event is recorded", async () => {
    expect(await listNotificationEvents()).toEqual([]);
  });

  it("persists a recorded event and returns it unread, most recent first", async () => {
    await recordNotificationEvent({ kind: "image_update_available", level: "info", message: "Nouvelle version disponible pour nginx:1.25 -> 1.27" });
    await recordNotificationEvent({ kind: "integration_unreachable", level: "error", message: "Kubernetes injoignable depuis 11:42" });

    const events = await listNotificationEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("integration_unreachable"); // le plus récent en premier
    expect(events[1]!.kind).toBe("image_update_available");
    expect(events.every((e) => e.read === false)).toBe(true);
    expect(events.every((e) => typeof e.id === "string" && e.id.length > 0)).toBe(true);
  });

  it("marks every currently known event as read, but not a later one", async () => {
    await markAllNotificationsRead();
    const afterMarkAllRead = await listNotificationEvents();
    expect(afterMarkAllRead.every((e) => e.read === true)).toBe(true);

    await recordNotificationEvent({ kind: "integration_reachable", level: "success", message: "Kubernetes de nouveau joignable" });
    const events = await listNotificationEvents();
    const newest = events.find((e) => e.kind === "integration_reachable");
    expect(newest?.read).toBe(false);
    expect(events.filter((e) => e.kind !== "integration_reachable").every((e) => e.read === true)).toBe(true);
  });

  it("filters by `since` (strictly after the given timestamp)", async () => {
    const all = await listNotificationEvents();
    const cursor = all[all.length - 1]!.timestamp; // le plus ancien
    const filtered = await listNotificationEvents(cursor);
    expect(filtered.length).toBe(all.length - 1);
    expect(filtered.some((e) => e.timestamp === cursor)).toBe(false);
  });
});
