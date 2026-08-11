/**
 * Workspaces infra-as-code : un dossier réel sur disque par workspace (data/iac/<id>/files/),
 * contenant la config native de l'outil choisi — pas d'abstraction QUAI ici, ce sont
 * exactement les fichiers que tofu/ansible-playbook/packer liraient en CLI. Les métadonnées
 * (nom, moteur, créateur...) sont indexées séparément (data/iac/workspaces.json), même
 * pattern que setupStore.ts/registriesStore.ts pour la persistance simple sans base de données.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { IacEngine, IacFileEntry, IacWorkspace } from "../../types.js";

function iacRootPath(): string {
  // Même racine de données que config.json/audit-log.jsonl (voir setupStore.ts/auditLog.ts).
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "iac");
}

function indexPath(): string {
  return path.join(iacRootPath(), "workspaces.json");
}

export function workspaceFilesPath(workspaceId: string): string {
  return path.join(iacRootPath(), workspaceId, "files");
}

async function readIndex(): Promise<IacWorkspace[]> {
  try {
    const raw = await fs.readFile(indexPath(), "utf-8");
    return JSON.parse(raw) as IacWorkspace[];
  } catch {
    return [];
  }
}

async function writeIndex(workspaces: IacWorkspace[]): Promise<void> {
  await fs.mkdir(iacRootPath(), { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(workspaces, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Contenu de départ par moteur — un workspace nouvellement créé est immédiatement exécutable. */
const SCAFFOLD: Record<IacEngine, Record<string, string>> = {
  tofu: {
    "main.tf": `# Exemple minimal — remplacez par votre configuration réelle.
# Documentation des providers OpenTofu : https://search.opentofu.org

terraform {
  required_providers {
    # ex: docker = { source = "kreuzwerker/docker" }
  }
}
`,
  },
  ansible: {
    "playbook.yml": `---
- name: Exemple de playbook
  hosts: all
  gather_facts: false
  tasks:
    - name: Ping
      ansible.builtin.ping:
`,
    "inventory.ini": `[local]
localhost ansible_connection=local
`,
  },
  packer: {
    "template.pkr.hcl": `# Exemple minimal — remplacez par votre configuration réelle.
# Documentation des builders Packer : https://developer.hashicorp.com/packer/plugins/builders

packer {
  required_plugins {
    # ex: docker = { source = "github.com/hashicorp/docker", version = ">= 1.0.0" }
  }
}
`,
  },
};

export async function listWorkspaces(): Promise<IacWorkspace[]> {
  return readIndex();
}

export async function getWorkspace(id: string): Promise<IacWorkspace | undefined> {
  return (await readIndex()).find((w) => w.id === id);
}

export class WorkspaceNotFoundError extends Error {}

export async function createWorkspace(input: {
  name: string;
  engine: IacEngine;
  createdBy: string;
}): Promise<IacWorkspace> {
  const workspace: IacWorkspace = {
    id: randomUUID(),
    name: input.name,
    engine: input.engine,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };

  const filesDir = workspaceFilesPath(workspace.id);
  await fs.mkdir(filesDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(SCAFFOLD[input.engine])) {
    await fs.writeFile(path.join(filesDir, relativePath), content, "utf-8");
  }

  const workspaces = await readIndex();
  workspaces.push(workspace);
  await writeIndex(workspaces);
  return workspace;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const workspaces = await readIndex();
  const next = workspaces.filter((w) => w.id !== id);
  if (next.length === workspaces.length) throw new WorkspaceNotFoundError(`Workspace "${id}" not found`);
  await writeIndex(next);
  await fs.rm(path.join(iacRootPath(), id), { recursive: true, force: true });
}

/** Empêche toute évasion du dossier du workspace via un chemin relatif malicieux ("../../etc/passwd"). */
function resolveSafeFilePath(workspaceId: string, relativePath: string): string {
  const base = workspaceFilesPath(workspaceId);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Invalid file path (path traversal attempt)");
  }
  return resolved;
}

export async function listFiles(workspaceId: string): Promise<IacFileEntry[]> {
  const base = workspaceFilesPath(workspaceId);
  let entries: string[];
  try {
    entries = (await fs.readdir(base, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const files: IacFileEntry[] = [];
  for (const entry of entries) {
    const absolute = path.join(base, entry);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile()) {
      files.push({ path: entry.split(path.sep).join("/"), sizeBytes: stat.size });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFile(workspaceId: string, relativePath: string): Promise<string> {
  return fs.readFile(resolveSafeFilePath(workspaceId, relativePath), "utf-8");
}

export async function writeFile(workspaceId: string, relativePath: string, content: string): Promise<void> {
  const absolute = resolveSafeFilePath(workspaceId, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf-8");
}

export async function deleteFile(workspaceId: string, relativePath: string): Promise<void> {
  await fs.rm(resolveSafeFilePath(workspaceId, relativePath), { force: true });
}
