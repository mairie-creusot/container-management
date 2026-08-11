/**
 * Scan de vulnérabilités des images de conteneurs — pilote le VRAI binaire Grype
 * (https://github.com/anchore/grype, Apache-2.0, scanner de CVE standard de l'industrie) en
 * sous-processus, exactement comme OpenTofu/Ansible/Packer (voir services/iac/runner.ts et
 * iac/engines.ts pour le pattern exact reproduit ici) : QUAI ne réimplémente jamais ces
 * outils.
 *
 * Persistance : fichier JSON Lines dans le même dossier que CONFIG_PATH — même pattern que
 * auditLog.ts (resolvedAuditLogPath), simple append, aucun secret. Un scan traverse plusieurs
 * états (running -> success|failed) : contrairement aux événements d'audit qui sont immuables,
 * chaque changement d'état ajoute une NOUVELLE ligne (toujours en append, jamais de réécriture
 * du fichier) ; à la lecture, seule la ligne la plus récente pour un id de scan donné est
 * conservée (voir readAllScans). Le fichier peut grossir indéfiniment, comme audit-log.jsonl —
 * acceptable pour ce premier lot.
 *
 * Un scan Grype peut prendre du temps (téléchargement de la base de vulnérabilités NVD à la
 * première exécution) : startScan() retourne immédiatement le scan à l'état "running" et le
 * process continue en arrière-plan ; le frontend récupère le résultat par polling
 * (GET /api/scans/:scanId), même principe que startRun() dans iac/runner.ts.
 */

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { ScanResult, Vulnerability, VulnSeverity } from "../types.js";

const SEVERITIES: readonly VulnSeverity[] = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];

function resolvedScanLogPath(): string {
  // Même dossier que config.json (CONFIG_PATH), fichier séparé — voir setupStore.ts et
  // auditLog.ts#resolvedAuditLogPath (pattern identique).
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "scans.jsonl");
}

async function appendScanEvent(scan: ScanResult): Promise<void> {
  try {
    const filePath = resolvedScanLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(scan)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[scan] failed to persist scan event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Dernière version connue de chaque scan (une ligne par changement d'état, la plus récente gagne). */
async function readAllScans(): Promise<ScanResult[]> {
  try {
    const raw = await fs.readFile(resolvedScanLogPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const latestById = new Map<string, ScanResult>();
    for (const line of lines) {
      try {
        const scan = JSON.parse(line) as ScanResult;
        latestById.set(scan.id, scan);
      } catch {
        // ligne corrompue (écriture interrompue) : ignorée plutôt que de faire échouer toute la lecture
      }
    }
    return [...latestById.values()];
  } catch {
    return [];
  }
}

export interface GrypeStatus {
  available: boolean;
  version: string | null;
}

/** Vérifie que le binaire grype est présent sur le PATH — même pattern que getEngineStatus() (iac/engines.ts). */
export function isGrypeAvailable(): Promise<GrypeStatus> {
  return new Promise((resolve) => {
    const child = spawn("grype", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", () => resolve({ available: false, version: null })); // binaire absent du PATH
    child.on("close", (code) => {
      if (code !== 0 && output === "") {
        resolve({ available: false, version: null });
        return;
      }
      // "grype version" imprime plusieurs lignes ("Application:", "Version:", "BuildDate:", ...).
      const versionLine = output.split("\n").find((l) => l.trim().startsWith("Version:"));
      const version = versionLine?.split(":")[1]?.trim() ?? output.split("\n")[0]?.trim() ?? null;
      resolve({ available: true, version });
    });
  });
}

function emptySummary(): Record<VulnSeverity, number> {
  return { Critical: 0, High: 0, Medium: 0, Low: 0, Negligible: 0, Unknown: 0 };
}

function normalizeSeverity(value: unknown): VulnSeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as VulnSeverity)
    : "Unknown";
}

/**
 * Forme réelle de la sortie `grype -o json` (schéma anchore/grype) — champs vérifiés sur des
 * sorties réelles : le correctif connu vit sous `vulnerability.fix.versions`/`fix.state`
 * ("fixed" | "not-fixed" | "wont-fix" | "unknown"), PAS un champ plat `fixedInVersion` comme
 * une lecture rapide de la doc pourrait le laisser penser.
 */
interface GrypeJsonOutput {
  matches?: Array<{
    vulnerability?: {
      id?: string;
      severity?: string;
      fix?: { versions?: string[]; state?: string };
    };
    artifact?: {
      name?: string;
      version?: string;
    };
  }>;
}

function parseGrypeOutput(stdout: string): { vulnerabilities: Vulnerability[]; summary: Record<VulnSeverity, number> } {
  const parsed = JSON.parse(stdout) as GrypeJsonOutput;
  const summary = emptySummary();
  const vulnerabilities: Vulnerability[] = (parsed.matches ?? []).map((match) => {
    const severity = normalizeSeverity(match.vulnerability?.severity);
    summary[severity] += 1;
    const fix = match.vulnerability?.fix;
    const fixedInVersion =
      fix?.state === "fixed" && fix.versions && fix.versions.length > 0 ? fix.versions.join(", ") : null;
    return {
      id: match.vulnerability?.id ?? "UNKNOWN",
      severity,
      packageName: match.artifact?.name ?? "?",
      installedVersion: match.artifact?.version ?? "?",
      fixedInVersion,
    };
  });
  return { vulnerabilities, summary };
}

/**
 * Lance `grype <imageReference> -o json --quiet` en arrière-plan et retourne immédiatement le
 * scan à l'état "running" — la commande continue de tourner après le retour de cette fonction ;
 * voir getScan()/listScansForImage() pour suivre sa progression par polling.
 */
export async function startScan(imageReference: string): Promise<ScanResult> {
  const scan: ScanResult = {
    id: randomUUID(),
    image: imageReference,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    vulnerabilities: [],
    summary: emptySummary(),
  };
  await appendScanEvent(scan);

  execFile(
    "grype",
    [imageReference, "-o", "json", "--quiet"],
    { maxBuffer: 1024 * 1024 * 64 }, // un rapport JSON de vulnérabilités peut être volumineux sur une image avec beaucoup de couches
    (err, stdout) => {
      if (err) {
        void appendScanEvent({
          ...scan,
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      try {
        const { vulnerabilities, summary } = parseGrypeOutput(stdout);
        void appendScanEvent({
          ...scan,
          status: "success",
          finishedAt: new Date().toISOString(),
          vulnerabilities,
          summary,
        });
      } catch (parseErr) {
        // eslint-disable-next-line no-console
        console.warn(`[scan] failed to parse grype output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        void appendScanEvent({ ...scan, status: "failed", finishedAt: new Date().toISOString() });
      }
    },
  );

  return scan;
}

/** Historique des scans d'une image (référence Docker), les plus récents en premier. */
export async function listScansForImage(imageReference: string): Promise<ScanResult[]> {
  const all = await readAllScans();
  return all.filter((s) => s.image === imageReference).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getScan(scanId: string): Promise<ScanResult | undefined> {
  const all = await readAllScans();
  return all.find((s) => s.id === scanId);
}
