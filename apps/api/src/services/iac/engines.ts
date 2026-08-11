/**
 * Détection des vrais binaires infra-as-code installés sur l'hôte (voir
 * deploy/docker/Dockerfile.api.dev pour leur installation en environnement de dev/conteneur).
 * QUAI ne réimplémente ni OpenTofu, ni Ansible, ni Packer — il les pilote en sous-processus
 * (voir runner.ts) ; ce module se contente de vérifier leur présence et leur version.
 */

import { spawn } from "node:child_process";
import type { IacEngine, IacEngineStatus } from "../../types.js";

const VERSION_COMMAND: Record<IacEngine, { bin: string; args: string[] }> = {
  tofu: { bin: "tofu", args: ["version"] },
  ansible: { bin: "ansible-playbook", args: ["--version"] },
  packer: { bin: "packer", args: ["version"] },
};

function runVersionCheck(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", () => resolve(null)); // binaire absent du PATH
    child.on("close", (code) => {
      if (code !== 0 && output === "") {
        resolve(null);
        return;
      }
      resolve(output.split("\n")[0]?.trim() ?? null);
    });
  });
}

export async function getEngineStatus(engine: IacEngine): Promise<IacEngineStatus> {
  const { bin, args } = VERSION_COMMAND[engine];
  const version = await runVersionCheck(bin, args);
  return { engine, available: version !== null, version };
}

export async function listEngineStatuses(): Promise<IacEngineStatus[]> {
  return Promise.all((["tofu", "ansible", "packer"] as const).map(getEngineStatus));
}
