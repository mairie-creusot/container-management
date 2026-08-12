/**
 * Scan de vulnérabilités des images de conteneurs — pilote les VRAIS binaires Grype
 * (https://github.com/anchore/grype, Apache-2.0, scanner de CVE standard de l'industrie) ET
 * OSV-Scanner (https://github.com/google/osv-scanner, Apache-2.0, scanner basé sur la base
 * OSV.dev de Google) en sous-processus, exactement comme OpenTofu/Ansible/Packer (voir
 * services/iac/runner.ts et iac/engines.ts pour le pattern exact reproduit ici) : QUAI ne
 * réimplémente jamais ces outils. Les deux scanners coexistent (l'un n'exclut pas l'autre) —
 * toute la logique commune (persistance, cycle de vie d'un scan, lecture) est paramétrée par
 * `scanner: ScannerId` plutôt que dupliquée ; seule la construction de la commande et le parsing
 * du JSON de sortie diffèrent réellement entre les deux (SCANNER_RUN_SPEC ci-dessous).
 *
 * Persistance : fichier JSON Lines dans le même dossier que CONFIG_PATH — même pattern que
 * auditLog.ts (resolvedAuditLogPath), simple append, aucun secret. Un scan traverse plusieurs
 * états (running -> success|failed) : contrairement aux événements d'audit qui sont immuables,
 * chaque changement d'état ajoute une NOUVELLE ligne (toujours en append, jamais de réécriture
 * du fichier) ; à la lecture, seule la ligne la plus récente pour un id de scan donné est
 * conservée (voir readAllScans). Le fichier peut grossir indéfiniment, comme audit-log.jsonl —
 * acceptable pour ce premier lot. Grype et OSV-Scanner partagent le même fichier et le même
 * historique par image (readAllScans/listScansForImage ne filtrent pas par scanner) : chaque
 * ligne porte son propre champ `scanner`, donc le frontend peut afficher les deux résultats côte
 * à côte pour une même image sans rien dupliquer côté stockage.
 *
 * Un scan (Grype comme OSV-Scanner) peut prendre du temps (téléchargement de base de
 * vulnérabilités à la première exécution) : startScan() retourne immédiatement le scan à l'état
 * "running" et le process continue en arrière-plan ; le frontend récupère le résultat par
 * polling (GET /api/scans/:scanId), même principe que startRun() dans iac/runner.ts.
 *
 * `trigger` ("manual" | "automatic", voir types.ts#ScanTrigger) distingue un scan lancé par un
 * clic operator/admin (ImagesPage.tsx) d'un scan lancé tout seul par services/scanScheduler.ts
 * sur une image réellement déployée — même fichier, même historique, seul un champ change.
 */

import { execFile, spawn, type ExecFileException } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { ScannerId, ScannerStatus, ScanResult, ScanTrigger, Vulnerability, VulnSeverity } from "../types.js";

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

// --- Disponibilité des binaires (Grype / OSV-Scanner) ---------------------------------------

interface VersionCheckSpec {
  bin: string;
  args: string[];
  /** Isole le numéro de version depuis la sortie brute de la commande — format différent par outil. */
  extractVersion: (output: string) => string | null;
}

const VERSION_CHECK: Record<ScannerId, VersionCheckSpec> = {
  grype: {
    bin: "grype",
    args: ["version"],
    // "grype version" imprime plusieurs lignes ("Application:", "Version:", "BuildDate:", ...).
    extractVersion: (output) => {
      const versionLine = output.split("\n").find((l) => l.trim().startsWith("Version:"));
      return versionLine?.split(":")[1]?.trim() ?? output.split("\n")[0]?.trim() ?? null;
    },
  },
  "osv-scanner": {
    bin: "osv-scanner",
    args: ["--version"],
    // "osv-scanner --version" imprime "osv-scanner version: X.Y.Z" en première ligne, suivi de
    // "osv-scalibr version: ...", "commit: ...", "built at: ..." — vérifié sur le binaire réel.
    extractVersion: (output) => {
      const versionLine = output.split("\n").find((l) => l.trim().startsWith("osv-scanner version:"));
      return versionLine?.split(":")[1]?.trim() ?? output.split("\n")[0]?.trim() ?? null;
    },
  },
};

/** Vérifie qu'un binaire de scanner est présent sur le PATH — même pattern que getEngineStatus() (iac/engines.ts). */
function checkScannerAvailability(scanner: ScannerId): Promise<ScannerStatus> {
  const { bin, args, extractVersion } = VERSION_CHECK[scanner];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", () => resolve({ scanner, available: false, version: null })); // binaire absent du PATH
    child.on("close", (code) => {
      if (code !== 0 && output === "") {
        resolve({ scanner, available: false, version: null });
        return;
      }
      resolve({ scanner, available: true, version: extractVersion(output) });
    });
  });
}

export function isGrypeAvailable(): Promise<ScannerStatus> {
  return checkScannerAvailability("grype");
}

export function isOsvScannerAvailable(): Promise<ScannerStatus> {
  return checkScannerAvailability("osv-scanner");
}

/** Statut des deux scanners, pour GET /api/scanners/status (bouton "Scanner" côté frontend). */
export function listScannerStatuses(): Promise<ScannerStatus[]> {
  return Promise.all((["grype", "osv-scanner"] as const).map(checkScannerAvailability));
}

// --- Parsing de la sortie JSON --------------------------------------------------------------

function emptySummary(): Record<VulnSeverity, number> {
  return { Critical: 0, High: 0, Medium: 0, Low: 0, Negligible: 0, Unknown: 0 };
}

function normalizeGrypeSeverity(value: unknown): VulnSeverity {
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
    const severity = normalizeGrypeSeverity(match.vulnerability?.severity);
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
 * Forme réelle de la sortie `osv-scanner scan image --format json` (schéma OSV, vérifié sur une
 * sortie réelle produite par le binaire lui-même — voir apps/api/src/services/scan.ts). Les
 * résultats sont groupés par "source" (ex: /var/lib/dpkg/status pour les paquets OS) puis par
 * paquet ; chaque paquet porte à la fois une liste `groups` (une entrée par identifiant/alias
 * d'un même problème, avec `max_severity` = score CVSS de base déjà calculé par OSV-Scanner) et
 * une liste `vulnerabilities` (le détail par id). Contrairement à Grype, il n'y a PAS de champ
 * plat `severity` sur la vulnérabilité elle-même : OSV expose soit un vecteur CVSS complet
 * (`vulnerability.severity[].score`, ex: "CVSS:3.1/AV:N/..."), soit (pour les avis GHSA
 * npm/pip/...) une étiquette catégorielle sous `database_specific.severity` — voir
 * osvSeverity() ci-dessous pour l'ordre de préférence retenu.
 */
interface OsvGroup {
  ids?: string[];
  aliases?: string[];
  max_severity?: string;
}

interface OsvVulnerability {
  id?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    database_specific?: { severity?: string };
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
}

interface OsvPackage {
  package?: { name?: string; version?: string };
  groups?: OsvGroup[];
  vulnerabilities?: OsvVulnerability[];
}

interface OsvJsonOutput {
  results?: Array<{ packages?: OsvPackage[] }>;
}

/** Score CVSS de base (0-10, déjà calculé par OSV-Scanner sur `groups[].max_severity`) -> même
 * échelle que la classification CVSS standard (None/Low/Medium/High/Critical). */
function severityFromCvssScore(raw: string | undefined): VulnSeverity | null {
  if (!raw) return null;
  const score = Number.parseFloat(raw);
  if (Number.isNaN(score)) return null;
  if (score >= 9) return "Critical";
  if (score >= 7) return "High";
  if (score >= 4) return "Medium";
  if (score > 0) return "Low";
  return "Negligible";
}

/** Étiquette catégorielle GHSA (`database_specific.severity`, ex: "CRITICAL"/"MODERATE"/"LOW"). */
function severityFromLabel(raw: string | undefined): VulnSeverity | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "CRITICAL") return "Critical";
  if (upper === "HIGH") return "High";
  if (upper === "MODERATE" || upper === "MEDIUM") return "Medium";
  if (upper === "LOW") return "Low";
  if (upper === "NEGLIGIBLE") return "Negligible";
  return null;
}

/**
 * Sévérité d'une vulnérabilité OSV : score CVSS de base du groupe (le plus fiable, déjà calculé
 * par OSV-Scanner) en premier, puis l'étiquette catégorielle GHSA si présente (directement sur la
 * vulnérabilité ou sur l'un de ses `affected[]`), sinon "Unknown" — jamais de sévérité devinée.
 */
function osvSeverity(vuln: OsvVulnerability, group: OsvGroup | undefined): VulnSeverity {
  const fromScore = severityFromCvssScore(group?.max_severity);
  if (fromScore) return fromScore;
  const fromOwnLabel = severityFromLabel(vuln.database_specific?.severity);
  if (fromOwnLabel) return fromOwnLabel;
  for (const affected of vuln.affected ?? []) {
    const fromAffectedLabel = severityFromLabel(affected.database_specific?.severity);
    if (fromAffectedLabel) return fromAffectedLabel;
  }
  return "Unknown";
}

/** Concatène tous les correctifs connus (`affected[].ranges[].events[].fixed`) — plusieurs
 * `affected` peuvent chacun documenter un correctif pour une branche de version différente. */
function osvFixedInVersion(vuln: OsvVulnerability): string | null {
  const fixed = new Set<string>();
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) fixed.add(event.fixed);
      }
    }
  }
  return fixed.size > 0 ? [...fixed].join(", ") : null;
}

/** Préfère un alias "CVE-*" (plus reconnaissable, cohérent avec l'affichage Grype) quand le
 * groupe en connaît un ; sinon retombe sur l'id natif OSV (GHSA-/DEBIAN-CVE-/OSV-...). */
function osvPreferredId(vuln: OsvVulnerability, group: OsvGroup | undefined): string {
  const cveAlias = group?.aliases?.find((alias) => alias.startsWith("CVE-"));
  return cveAlias ?? vuln.id ?? "UNKNOWN";
}

function parseOsvOutput(stdout: string): { vulnerabilities: Vulnerability[]; summary: Record<VulnSeverity, number> } {
  const parsed = JSON.parse(stdout) as OsvJsonOutput;
  const summary = emptySummary();
  const vulnerabilities: Vulnerability[] = [];
  for (const result of parsed.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const groups = pkg.groups ?? [];
      for (const vuln of pkg.vulnerabilities ?? []) {
        const group = groups.find((g) => (vuln.id ? (g.ids ?? []).includes(vuln.id) : false));
        const severity = osvSeverity(vuln, group);
        summary[severity] += 1;
        vulnerabilities.push({
          id: osvPreferredId(vuln, group),
          severity,
          packageName: pkg.package?.name ?? "?",
          installedVersion: pkg.package?.version ?? "?",
          fixedInVersion: osvFixedInVersion(vuln),
        });
      }
    }
  }
  return { vulnerabilities, summary };
}

// --- Invocation ---------------------------------------------------------------------------

interface ScannerRunSpec {
  bin: string;
  buildArgs: (imageReference: string) => string[];
  parse: (stdout: string) => { vulnerabilities: Vulnerability[]; summary: Record<VulnSeverity, number> };
  /**
   * Codes de sortie qui n'indiquent PAS un échec réel de l'outil. Grype retourne toujours 0 hors
   * erreur d'exécution ; OSV-Scanner, lui, retourne 1 quand des vulnérabilités ont été trouvées
   * (0 = aucune trouvée) — vérifié en lançant le binaire réel sur alpine:3.20 (0, aucune trouvée)
   * et node:22-slim (1, des dizaines trouvées, JSON valide dans les deux cas). Un vrai échec
   * (binaire absent, image introuvable) ressort avec un autre code (127 constaté) et aucun JSON
   * exploitable sur stdout.
   */
  isSuccessExitCode: (code: number) => boolean;
}

const SCANNER_RUN_SPEC: Record<ScannerId, ScannerRunSpec> = {
  grype: {
    bin: "grype",
    buildArgs: (imageReference) => [imageReference, "-o", "json", "--quiet"],
    parse: parseGrypeOutput,
    isSuccessExitCode: (code) => code === 0,
  },
  "osv-scanner": {
    bin: "osv-scanner",
    buildArgs: (imageReference) => ["scan", "image", "--format", "json", imageReference],
    parse: parseOsvOutput,
    isSuccessExitCode: (code) => code === 0 || code === 1,
  },
};

/** Code de sortie exploitable d'un execFile terminé : null si le process n'a pas pu être lancé
 * du tout (ENOENT, etc — err.code est alors une chaîne, pas un code de sortie numérique). */
function execFileExitCode(err: ExecFileException | null): number | null {
  if (!err) return 0;
  return typeof err.code === "number" ? err.code : null;
}

/**
 * Lance le scanner demandé sur `imageReference` en arrière-plan et retourne immédiatement le
 * scan à l'état "running" — la commande continue de tourner après le retour de cette fonction ;
 * voir getScan()/listScansForImage() pour suivre sa progression par polling. `scanner` par
 * défaut à "grype" et `trigger` par défaut à "manual" pour ne rien changer au comportement des
 * appelants existants (POST /api/images/:id/scan) ; `trigger: "automatic"` est passé uniquement
 * par services/scanScheduler.ts (scan périodique en tâche de fond, jamais déclenché par un clic).
 */
export async function startScan(
  imageReference: string,
  scanner: ScannerId = "grype",
  trigger: ScanTrigger = "manual",
): Promise<ScanResult> {
  const scan: ScanResult = {
    id: randomUUID(),
    scanner,
    image: imageReference,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    vulnerabilities: [],
    summary: emptySummary(),
    trigger,
  };
  await appendScanEvent(scan);

  const spec = SCANNER_RUN_SPEC[scanner];
  execFile(
    spec.bin,
    spec.buildArgs(imageReference),
    { maxBuffer: 1024 * 1024 * 64 }, // un rapport JSON de vulnérabilités peut être volumineux sur une image avec beaucoup de couches
    (err, stdout) => {
      const exitCode = execFileExitCode(err);
      if (exitCode === null || !spec.isSuccessExitCode(exitCode)) {
        void appendScanEvent({
          ...scan,
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      try {
        const { vulnerabilities, summary } = spec.parse(stdout);
        void appendScanEvent({
          ...scan,
          status: "success",
          finishedAt: new Date().toISOString(),
          vulnerabilities,
          summary,
        });
      } catch (parseErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[scan] failed to parse ${scanner} output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
        void appendScanEvent({ ...scan, status: "failed", finishedAt: new Date().toISOString() });
      }
    },
  );

  return scan;
}

/** Historique des scans d'une image (référence Docker), tous scanners confondus, les plus récents en premier. */
export async function listScansForImage(imageReference: string): Promise<ScanResult[]> {
  const all = await readAllScans();
  return all.filter((s) => s.image === imageReference).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getScan(scanId: string): Promise<ScanResult | undefined> {
  const all = await readAllScans();
  return all.find((s) => s.id === scanId);
}

/** Tous les scans connus, toutes images et tous scanners confondus — voir topology.ts pour le
 * rapprochement best-effort par image utilisé sur les badges de vulnérabilités du graphe. */
export async function listAllScans(): Promise<ScanResult[]> {
  return readAllScans();
}
