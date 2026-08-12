/**
 * Exécute une vraie commande OpenTofu/Ansible/Packer pour un workspace donné, en
 * sous-processus (node:child_process, PAS de réimplémentation de ces outils). La sortie
 * (stdout+stderr entrelacés, comme un vrai terminal) est journalisée en direct dans un
 * fichier, lu en polling par le frontend pendant que la commande tourne (voir
 * routes/iac.ts) — plus simple qu'un flux WebSocket pour ce premier lot, même principe que
 * le rafraîchissement périodique de la page Vue d'ensemble.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { getWorkspace, workspaceFilesPath, WorkspaceNotFoundError } from "./workspaces.js";
import type { IacEngine, IacRun } from "../../types.js";

function iacRootPath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "iac");
}

function runsDir(workspaceId: string): string {
  return path.join(iacRootPath(), workspaceId, "runs");
}

function runsIndexPath(workspaceId: string): string {
  return path.join(runsDir(workspaceId), "index.json");
}

function runLogPath(workspaceId: string, runId: string): string {
  return path.join(runsDir(workspaceId), `${runId}.log`);
}

async function readRunsIndex(workspaceId: string): Promise<IacRun[]> {
  try {
    return JSON.parse(await fs.readFile(runsIndexPath(workspaceId), "utf-8")) as IacRun[];
  } catch {
    return [];
  }
}

async function writeRunsIndex(workspaceId: string, runs: IacRun[]): Promise<void> {
  await fs.mkdir(runsDir(workspaceId), { recursive: true });
  await fs.writeFile(runsIndexPath(workspaceId), JSON.stringify(runs, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function upsertRun(workspaceId: string, run: IacRun): Promise<void> {
  const runs = await readRunsIndex(workspaceId);
  const index = runs.findIndex((r) => r.id === run.id);
  if (index >= 0) runs[index] = run;
  else runs.unshift(run);
  await writeRunsIndex(workspaceId, runs);
}

export const ENGINE_ACTIONS: Record<IacEngine, string[]> = {
  tofu: ["init", "plan", "apply", "destroy"],
  ansible: ["run"],
  packer: ["init", "build"],
};

/** Construit la commande réelle à exécuter — un binaire déjà installé (voir engines.ts), jamais un shell arbitraire. */
async function buildCommand(engine: IacEngine, action: string, workspaceDir: string): Promise<{ bin: string; args: string[] }> {
  switch (engine) {
    case "tofu": {
      switch (action) {
        case "init":
          return { bin: "tofu", args: ["init", "-input=false", "-no-color"] };
        case "plan":
          return { bin: "tofu", args: ["plan", "-input=false", "-no-color"] };
        case "apply":
          return { bin: "tofu", args: ["apply", "-input=false", "-auto-approve", "-no-color"] };
        case "destroy":
          return { bin: "tofu", args: ["destroy", "-input=false", "-auto-approve", "-no-color"] };
      }
      break;
    }
    case "ansible": {
      if (action === "run") {
        const hasInventory = await fs
          .access(path.join(workspaceDir, "inventory.ini"))
          .then(() => true)
          .catch(() => false);
        return {
          bin: "ansible-playbook",
          args: [...(hasInventory ? ["-i", "inventory.ini"] : []), "playbook.yml"],
        };
      }
      break;
    }
    case "packer": {
      if (action === "init") return { bin: "packer", args: ["init", "."] };
      if (action === "build") return { bin: "packer", args: ["build", "-color=false", "."] };
      break;
    }
  }
  throw new Error(`Unsupported action "${action}" for engine "${engine}"`);
}

/**
 * Démarre une commande réelle en arrière-plan et retourne immédiatement l'identifiant du run
 * (statut "running") — la commande continue de tourner et d'écrire son log après le retour de
 * cette fonction ; voir getRun()/tailRunLog() pour suivre sa progression.
 */
export async function startRun(workspaceId: string, engine: IacEngine, action: string, startedBy: string): Promise<IacRun> {
  // Vérifie que le workspace existe RÉELLEMENT (index workspaces.json) avant tout usage de son
  // chemin de fichiers ou tout `spawn` — jamais construire un `cwd` de sous-processus à partir
  // d'un id non vérifié, même si workspaceFilesPath() valide déjà son FORMAT ci-dessous (défense
  // en profondeur, voir finding E2, docs/reports/security-audit-2026-08-12.md).
  if (!(await getWorkspace(workspaceId))) {
    throw new WorkspaceNotFoundError(`Workspace "${workspaceId}" not found`);
  }

  if (!ENGINE_ACTIONS[engine].includes(action)) {
    throw new Error(`Unsupported action "${action}" for engine "${engine}" (allowed: ${ENGINE_ACTIONS[engine].join(", ")})`);
  }

  const workspaceDir = workspaceFilesPath(workspaceId);
  const { bin, args } = await buildCommand(engine, action, workspaceDir);

  const run: IacRun = {
    id: randomUUID(),
    workspaceId,
    engine,
    action,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    startedBy,
  };

  await fs.mkdir(runsDir(workspaceId), { recursive: true });
  const logPath = runLogPath(workspaceId, run.id);
  await fs.writeFile(logPath, `$ ${bin} ${args.join(" ")}\n\n`, "utf-8");
  await upsertRun(workspaceId, run);

  const child = spawn(bin, args, {
    cwd: workspaceDir,
    env: { ...process.env, TF_IN_AUTOMATION: "1", PACKER_NO_COLOR: "1", ANSIBLE_NOCOLOR: "1", NO_COLOR: "1" },
  });

  const appendToLog = (chunk: Buffer) => {
    void fs.appendFile(logPath, chunk).catch(() => undefined);
  };
  child.stdout?.on("data", appendToLog);
  child.stderr?.on("data", appendToLog);

  // Timeout configurable (config.iac.runTimeoutMs) — sans lui, un `tofu apply`/`ansible-playbook`/
  // `packer build` qui bloque (attente réseau, provisioner qui hang) tournerait indéfiniment,
  // sans aucune route d'annulation pour le rattraper (voir finding M3,
  // docs/reports/security-audit-2026-08-12.md). SIGTERM d'abord (laisse une chance au process de
  // nettoyer proprement, ex: verrou d'état tofu), SIGKILL de secours si toujours vivant après un
  // court délai de grâce — même esprit que services/adDns.ts#runWithStdin, qui tue déjà ses
  // sous-processus `kinit`/`nsupdate` de cette façon sur timeout.
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    appendToLog(
      Buffer.from(`\n[quai] run timed out after ${config.iac.runTimeoutMs}ms, killing process (SIGTERM)\n`),
    );
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
  }, config.iac.runTimeoutMs);

  child.on("close", (exitCode) => {
    clearTimeout(timeoutTimer);
    void upsertRun(workspaceId, {
      ...run,
      status: !timedOut && exitCode === 0 ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timeoutTimer);
    appendToLog(Buffer.from(`\n[quai] failed to start process: ${err.message}\n`));
    void upsertRun(workspaceId, { ...run, status: "failed", finishedAt: new Date().toISOString(), exitCode: null });
  });

  return run;
}

export async function listRuns(workspaceId: string): Promise<IacRun[]> {
  return readRunsIndex(workspaceId);
}

export async function getRun(workspaceId: string, runId: string): Promise<IacRun | undefined> {
  return (await readRunsIndex(workspaceId)).find((r) => r.id === runId);
}

export async function readRunLog(workspaceId: string, runId: string): Promise<string> {
  try {
    return await fs.readFile(runLogPath(workspaceId, runId), "utf-8");
  } catch {
    return "";
  }
}
