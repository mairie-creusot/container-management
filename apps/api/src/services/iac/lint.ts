// Analyse syntaxique réelle de scripts shell via `sh -n` (aucune exécution) — consommé par le
// studio de templates (vérification en ligne des étapes "script") et validateTemplate.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShellLintError {
  line?: number;
  message: string;
}

export interface ShellLintResult {
  ok: boolean;
  errors: ShellLintError[];
}

const LINT_TIMEOUT_MS = 5_000;
export const LINT_MAX_CONTENT_BYTES = 512 * 1024;

// dash : "fichier: 3: Syntax error: ..." ; bash : "fichier: line 3: ..." — les deux formes couvertes.
function parseShellStderr(stderr: string, tmpPath: string): ShellLintError[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((raw) => {
      const cleaned = raw.startsWith(tmpPath) ? raw.slice(tmpPath.length).replace(/^:\s*/, "") : raw;
      const match = cleaned.match(/^(?:line\s+)?(\d+):\s*(.*)$/);
      if (match) return { line: Number(match[1]), message: match[2] || cleaned };
      return { message: cleaned };
    });
}

export async function lintShellScript(content: string): Promise<ShellLintResult> {
  const tmpPath = path.join(os.tmpdir(), `quai-lint-${randomUUID()}.sh`);
  await fs.writeFile(tmpPath, content, "utf-8");
  try {
    return await new Promise<ShellLintResult>((resolve, reject) => {
      const child = spawn("sh", ["-n", tmpPath], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), LINT_TIMEOUT_MS);
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, errors: [] });
        else resolve({ ok: false, errors: parseShellStderr(stderr, tmpPath) });
      });
    });
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}
