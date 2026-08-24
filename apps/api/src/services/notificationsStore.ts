/**
 * Notifications système — événements détectés tout seuls en tâche de fond par le watchdog
 * (voir services/watchdog.ts), PAS déclenchés par une action utilisateur. Persistance JSON
 * Lines append-only, même pattern que services/auditLog.ts (une ligne = un événement, jamais
 * de réécriture du fichier entier pour en ajouter un) : les événements survivent à un
 * redémarrage de l'API et sont visibles par tous les utilisateurs connectés, pas seulement
 * celui dont le navigateur était ouvert au moment de la détection.
 *
 * "Lu/non lu" est un simple curseur temporel (`readAllBeforeIso`) plutôt qu'un ensemble d'ids
 * lus : marquer "tout lu" (voir markAllNotificationsRead) fixe ce curseur à l'instant présent,
 * et un événement est considéré lu s'il est STRICTEMENT antérieur à ce curseur — cohérent avec le
 * comportement du bouton existant (notificationsSlice.ts#markAllRead côté web), qui marque tout
 * ce qui est actuellement visible comme lu, pas des événements choisis individuellement.
 *
 * Deux précautions rendent ce curseur FIABLE malgré la résolution à la milliseconde (sans elles,
 * un événement enregistré dans la même milliseconde que le clic était marqué lu sans avoir jamais
 * été affiché — échec réel en CI le 24/08/2026, invisible en local car plus lent) :
 *  - les horodatages émis ici sont STRICTEMENT croissants (voir nextTimestamp) ;
 *  - le curseur est l'horodatage du PLUS RÉCENT événement connu au moment du clic, pas "maintenant"
 *    — tout événement postérieur est donc forcément strictement supérieur, donc non lu.
 *
 * Comme auditLog.ts : ce module ne doit jamais lancer d'exception vers l'appelant, une panne
 * d'écriture/lecture ne doit jamais faire échouer le cycle du watchdog ni une requête HTTP.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { dispatchNotificationEvent } from "./notificationDispatch.js";
import type { SystemNotificationEvent, SystemNotificationKind } from "../types.js";

const MAX_EVENTS_RETURNED = 300;

/** Dernière milliseconde émise — garantit des horodatages strictement croissants (voir en-tête). */
let lastEmittedMs = 0;

function nextTimestamp(): string {
  const now = Date.now();
  lastEmittedMs = now > lastEmittedMs ? now : lastEmittedMs + 1;
  return new Date(lastEmittedMs).toISOString();
}

function resolvedNotificationsLogPath(): string {
  // Même dossier que config.json/audit-log.jsonl (CONFIG_PATH) — voir auditLog.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "notifications-log.jsonl");
}

function resolvedReadStatePath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "notifications-read-state.json");
}

export interface RecordNotificationInput {
  kind: SystemNotificationKind;
  level: SystemNotificationEvent["level"];
  message: string;
}

/** Ajoute un événement au journal — jamais appelé directement par une route, seulement par le watchdog. */
export async function recordNotificationEvent(entry: RecordNotificationInput): Promise<void> {
  try {
    const event: Omit<SystemNotificationEvent, "read"> = { id: randomUUID(), timestamp: nextTimestamp(), ...entry };
    const filePath = resolvedNotificationsLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });

    // Dispatch sortant vers les canaux externes configurés (webhook/Slack/Discord/email — voir
    // services/notificationDispatch.ts) : fire-and-forget APRÈS l'écriture JSONL réussie ci-dessus,
    // jamais attendu (`void`) et jamais capable de faire échouer ce cycle — dispatchNotificationEvent
    // avale déjà toutes ses propres erreurs, mais on ne laisse même pas une exception synchrone
    // improbable remonter jusqu'ici.
    void dispatchNotificationEvent(event).catch(() => {});
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[notifications] failed to record event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readReadCursor(): Promise<string | null> {
  try {
    const raw = await fs.readFile(resolvedReadStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as { readAllBeforeIso?: string };
    return parsed.readAllBeforeIso ?? null;
  } catch {
    return null;
  }
}

/** Les plus récents en premier, filtrés par `since` si fourni, limités à MAX_EVENTS_RETURNED. */
export async function listNotificationEvents(since?: string): Promise<SystemNotificationEvent[]> {
  try {
    const [raw, readCursor] = await Promise.all([fs.readFile(resolvedNotificationsLogPath(), "utf-8"), readReadCursor()]);
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const events: SystemNotificationEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Omit<SystemNotificationEvent, "read">;
        if (since && parsed.timestamp <= since) continue;
        events.push({ ...parsed, read: readCursor !== null && parsed.timestamp <= readCursor });
      } catch {
        // ligne corrompue (écriture interrompue) : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return events.reverse().slice(0, MAX_EVENTS_RETURNED);
  } catch {
    return [];
  }
}

/**
 * Marque comme lus tous les événements actuellement connus (curseur temporel, voir
 * commentaire de tête). N'échoue jamais explicitement vers l'appelant : en cas d'erreur
 * d'écriture, le prochain GET /api/notifications retombera simplement sur l'ancien curseur
 * (ou aucun), sans casser la route.
 */
export async function markAllNotificationsRead(): Promise<void> {
  try {
    // Curseur = horodatage du plus récent événement CONNU, jamais "maintenant" (voir en-tête) :
    // sans événement, "maintenant" fait l'affaire, il n'y a rien à marquer.
    const known = await listNotificationEvents();
    const cursor = known[0]?.timestamp ?? new Date().toISOString();
    const filePath = resolvedReadStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ readAllBeforeIso: cursor }, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[notifications] failed to persist read state: ${err instanceof Error ? err.message : String(err)}`);
  }
}
