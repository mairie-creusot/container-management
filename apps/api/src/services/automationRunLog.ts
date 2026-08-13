/**
 * Journal d'exécution du moteur d'automatisation (services/automationEngine.ts) — une ligne par
 * CHAÎNE trigger -> [condition] -> action(s) réellement exécutée (succès ou échec réel de
 * l'action, jamais une simulation), même pattern EXACT que services/auditLog.ts : fichier JSON
 * Lines, ajout en append uniquement, jamais réécrit. Fichier séparé (`config.automation.
 * historyPath`) plutôt que le journal d'audit générique : ce n'est pas une action d'un
 * utilisateur authentifié, mais l'historique propre au moteur.
 *
 * Ce module ne doit jamais lancer d'exception vers l'appelant : un problème d'écriture du
 * journal ne doit jamais faire échouer/interrompre le cycle du moteur qui vient de l'appeler.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { AutomationRunLogEntry } from "../types.js";

const MAX_RUNS_RETURNED = 200;

function resolvedHistoryPath(): string {
  return path.resolve(config.automation.historyPath);
}

export async function recordAutomationRun(entry: Omit<AutomationRunLogEntry, "id" | "at">): Promise<AutomationRunLogEntry> {
  const run: AutomationRunLogEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry };
  try {
    const filePath = resolvedHistoryPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(run)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[automation] failed to record run log entry: ${err instanceof Error ? err.message : String(err)}`);
  }
  return run;
}

/** GET /api/automation/runs — les plus récents en premier, limités à MAX_RUNS_RETURNED (même
 * convention que auditLog.ts#listAuditEvents : le fichier peut grossir indéfiniment). */
export async function listAutomationRuns(): Promise<AutomationRunLogEntry[]> {
  try {
    const raw = await fs.readFile(resolvedHistoryPath(), "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const runs: AutomationRunLogEntry[] = [];
    for (const line of lines) {
      try {
        runs.push(JSON.parse(line) as AutomationRunLogEntry);
      } catch {
        // ligne corrompue (écriture interrompue) : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return runs.reverse().slice(0, MAX_RUNS_RETURNED);
  } catch {
    return [];
  }
}
