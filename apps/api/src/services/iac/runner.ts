/**
 * Exécute une vraie commande OpenTofu/Ansible/Packer/docker build pour un workspace donné, en
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
import type { IacEngine, IacRun, ImageTemplateArtifact } from "../../types.js";

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
  // "docker" : réservé aux builds de templates d'images conteneur (services/templates.ts) —
  // jamais proposé par POST /api/iac/workspaces (VALID_ENGINES, routes/iac.ts).
  docker: ["build"],
};

/** Format strict d'un tag `docker build -t` construit par services/templates.ts — validé ici en
 * défense en profondeur avant tout spawn (jamais un tag arbitraire dans argv). */
const DOCKER_TAG_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

export interface StartRunOptions {
  /** Variables d'environnement supplémentaires injectées au spawn (ex PKR_VAR_* lues de
   * getEffectiveNutanixConfig au moment du lancement) — JAMAIS écrites dans le log du run,
   * jamais persistées dans l'index des runs, jamais sur disque. */
  extraEnv?: Record<string, string>;
  /** engine "docker" uniquement : tag de l'image construite (`docker build -t <tag> .`). */
  dockerTag?: string;
  /** packer "build" uniquement : exécute `packer init .` avant le build, dans le même run/log
   * (plugins requis téléchargés à la première exécution). */
  packerInitFirst?: boolean;
  /** Capture d'artefact après un run réussi (voir IacRun#artifact) : "packer-manifest" lit le
   * packer-manifest.json écrit par le post-processor manifest ; "docker-image" reprend le tag. */
  captureArtifact?: "packer-manifest" | "docker-image";
}

/** Construit la ou les commandes réelles à exécuter — des binaires déjà installés (voir
 * engines.ts), jamais un shell arbitraire. Plusieurs commandes = exécution séquentielle dans le
 * même run/log (ex `packer init .` puis `packer build .`), arrêt à la première qui échoue. */
async function buildCommands(
  engine: IacEngine,
  action: string,
  workspaceDir: string,
  options: StartRunOptions,
): Promise<Array<{ bin: string; args: string[] }>> {
  switch (engine) {
    case "tofu": {
      switch (action) {
        case "init":
          return [{ bin: "tofu", args: ["init", "-input=false", "-no-color"] }];
        case "plan":
          return [{ bin: "tofu", args: ["plan", "-input=false", "-no-color"] }];
        case "apply":
          return [{ bin: "tofu", args: ["apply", "-input=false", "-auto-approve", "-no-color"] }];
        case "destroy":
          return [{ bin: "tofu", args: ["destroy", "-input=false", "-auto-approve", "-no-color"] }];
      }
      break;
    }
    case "ansible": {
      if (action === "run") {
        const hasInventory = await fs
          .access(path.join(workspaceDir, "inventory.ini"))
          .then(() => true)
          .catch(() => false);
        return [
          {
            bin: "ansible-playbook",
            args: [...(hasInventory ? ["-i", "inventory.ini"] : []), "playbook.yml"],
          },
        ];
      }
      break;
    }
    case "packer": {
      if (action === "init") return [{ bin: "packer", args: ["init", "."] }];
      if (action === "build") {
        const build = { bin: "packer", args: ["build", "-color=false", "."] };
        return options.packerInitFirst ? [{ bin: "packer", args: ["init", "."] }, build] : [build];
      }
      break;
    }
    case "docker": {
      if (action === "build") {
        const tag = options.dockerTag;
        if (!tag || !DOCKER_TAG_PATTERN.test(tag)) {
          throw new Error(`Invalid or missing docker tag for docker build run`);
        }
        return [{ bin: "docker", args: ["build", "-t", tag, "."] }];
      }
      break;
    }
  }
  throw new Error(`Unsupported action "${action}" for engine "${engine}"`);
}

/** Forme réelle du packer-manifest.json écrit par le post-processor "manifest" de Packer. */
interface PackerManifest {
  builds?: Array<{
    artifact_id?: string;
    custom_data?: Record<string, string>;
  }>;
}

/**
 * Référence d'image Nutanix depuis un manifest Packer : `custom_data.image_name` en priorité
 * (posé explicitement par le template généré, voir services/templates.ts), sinon `artifact_id`
 * brut du builder — `undefined` si rien d'exploitable (jamais une référence inventée).
 */
export function parsePackerManifestArtifact(manifestJson: string): ImageTemplateArtifact | undefined {
  let manifest: PackerManifest;
  try {
    manifest = JSON.parse(manifestJson) as PackerManifest;
  } catch {
    return undefined;
  }
  const lastBuild = manifest.builds?.at(-1);
  const reference = lastBuild?.custom_data?.image_name || lastBuild?.artifact_id;
  if (!reference) return undefined;
  return { type: "nutanix-image", reference };
}

async function captureRunArtifact(
  workspaceDir: string,
  options: StartRunOptions,
): Promise<ImageTemplateArtifact | undefined> {
  if (options.captureArtifact === "docker-image") {
    return options.dockerTag ? { type: "docker-image", reference: options.dockerTag } : undefined;
  }
  if (options.captureArtifact === "packer-manifest") {
    const manifestJson = await fs.readFile(path.join(workspaceDir, "packer-manifest.json"), "utf-8").catch(() => undefined);
    return manifestJson ? parsePackerManifestArtifact(manifestJson) : undefined;
  }
  return undefined;
}

interface ChildResult {
  exitCode: number | null;
  timedOut: boolean;
  spawnError: boolean;
}

/** Lance UNE commande et attend sa fin — même mécanique timeout (config.iac.runTimeoutMs,
 * appliqué à chaque commande) SIGTERM puis SIGKILL (délai de grâce 5s) que l'implémentation
 * historique mono-commande, voir finding M3, docs/reports/security-audit-2026-08-12.md. */
function runChild(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  appendToLog: (chunk: Buffer) => void,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(bin, args, { cwd, env });
    child.stdout?.on("data", appendToLog);
    child.stderr?.on("data", appendToLog);

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      appendToLog(Buffer.from(`\n[quai] run timed out after ${config.iac.runTimeoutMs}ms, killing process (SIGTERM)\n`));
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
    }, config.iac.runTimeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timeoutTimer);
      resolve({ exitCode, timedOut, spawnError: false });
    });
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      appendToLog(Buffer.from(`\n[quai] failed to start process: ${err.message}\n`));
      resolve({ exitCode: null, timedOut, spawnError: true });
    });
  });
}

/**
 * Démarre une commande réelle en arrière-plan et retourne immédiatement l'identifiant du run
 * (statut "running") — la commande continue de tourner et d'écrire son log après le retour de
 * cette fonction ; voir getRun()/tailRunLog() pour suivre sa progression.
 */
export async function startRun(
  workspaceId: string,
  engine: IacEngine,
  action: string,
  startedBy: string,
  options: StartRunOptions = {},
): Promise<IacRun> {
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
  const commands = await buildCommands(engine, action, workspaceDir, options);

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
  const first = commands[0]!;
  await fs.writeFile(logPath, `$ ${first.bin} ${first.args.join(" ")}\n\n`, "utf-8");
  await upsertRun(workspaceId, run);

  const appendToLog = (chunk: Buffer) => {
    void fs.appendFile(logPath, chunk).catch(() => undefined);
  };

  // extraEnv : uniquement dans l'environnement du sous-processus (jamais dans le log ci-dessus,
  // qui ne contient que bin + args, ni dans l'index des runs).
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TF_IN_AUTOMATION: "1",
    PACKER_NO_COLOR: "1",
    ANSIBLE_NOCOLOR: "1",
    NO_COLOR: "1",
    ...(options.extraEnv ?? {}),
  };

  void (async () => {
    let exitCode: number | null = null;
    let failed = false;
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i]!;
      if (i > 0) appendToLog(Buffer.from(`\n$ ${command.bin} ${command.args.join(" ")}\n\n`));
      const result = await runChild(command.bin, command.args, workspaceDir, spawnEnv, appendToLog);
      exitCode = result.exitCode;
      if (result.timedOut || result.spawnError || result.exitCode !== 0) {
        failed = true;
        break;
      }
    }
    const artifact = failed ? undefined : await captureRunArtifact(workspaceDir, options).catch(() => undefined);
    await upsertRun(workspaceId, {
      ...run,
      status: failed ? "failed" : "success",
      finishedAt: new Date().toISOString(),
      exitCode,
      ...(artifact ? { artifact } : {}),
    });
  })();

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
