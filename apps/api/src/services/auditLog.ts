/**
 * Registre d'audit — traçabilité "qui a fait quoi" pour les actions authentifiées, visible
 * par tous les admins (voir GET /api/audit, réservé au rôle admin car ça expose l'activité de
 * tous les utilisateurs, pas seulement la sienne).
 *
 * Persistance : fichier JSON Lines (une ligne = un événement, ajout en append — pas de
 * réécriture du fichier entier à chaque événement comme pour config.json). Même répertoire
 * que CONFIG_PATH par convention (voir resolvedAuditLogPath ci-dessous), donc dans le même
 * volume monté que le reste des données persistées en conteneur.
 *
 * Ce module ne doit jamais lancer d'exception vers l'appelant : un problème d'écriture du
 * journal d'audit ne doit jamais faire échouer l'action métier elle-même.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export interface AuditEvent {
  id: string;
  timestamp: string; // ISO 8601
  actor: string; // username LDAP, ou "anonymous" pour un login échoué
  actorDisplayName: string;
  method: string;
  path: string;
  statusCode: number;
  ok: boolean;
}

const MAX_EVENTS_RETURNED = 500;

function resolvedAuditLogPath(): string {
  // Même dossier que config.json (CONFIG_PATH), fichier séparé — voir setupStore.ts.
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "audit-log.jsonl");
}

export async function recordAuditEvent(entry: Omit<AuditEvent, "id" | "timestamp">): Promise<void> {
  try {
    const event: AuditEvent = { id: randomUUID(), timestamp: new Date().toISOString(), ...entry };
    const filePath = resolvedAuditLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audit] failed to record event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Les plus récents en premier, limités à MAX_EVENTS_RETURNED (le fichier peut grossir indéfiniment). */
export async function listAuditEvents(): Promise<AuditEvent[]> {
  try {
    const raw = await fs.readFile(resolvedAuditLogPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // ligne corrompue (écriture interrompue) : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return events.reverse().slice(0, MAX_EVENTS_RETURNED);
  } catch {
    return [];
  }
}
