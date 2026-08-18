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

/**
 * Format STRICT d'un id de workspace — toujours un `randomUUID()` généré par createWorkspace()
 * ci-dessous, jamais saisi par un utilisateur. Validé explicitement ici, en plus de la
 * vérification d'existence côté route (getWorkspace(), voir routes/iac.ts) : défense en
 * profondeur pour qu'aucun chemin dérivé de cet id (workspaceFilesPath, et donc le `cwd` du
 * sous-processus tofu/ansible-playbook/packer lancé par iac/runner.ts#startRun) ne puisse
 * JAMAIS contenir un séparateur de chemin ou un `..`, même dans l'hypothèse où un appelant
 * oublierait de vérifier l'existence en amont — même esprit que assertValidVolumeName dans
 * services/docker.ts. Voir finding E2, docs/reports/security-audit-2026-08-12.md.
 */
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

export function workspaceFilesPath(workspaceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    // Erreur nette plutôt qu'un chemin construit à l'aveugle — voir isValidWorkspaceId ci-dessus.
    throw new Error(`Invalid workspace id "${workspaceId}"`);
  }
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
  // Démos RÉELLES et autonomes (aucun accès cloud/identifiants requis) : "init"/"plan"/"apply"/
  // "run"/"build" produisent un vrai résultat visible, pas juste "ça s'est initialisé sans
  // erreur" sur une config vide. Objectif : prouver que le moteur tourne vraiment, pas
  // simuler — remplacez ensuite par votre vraie configuration.
  tofu: {
    "main.tf": `# Démo autoportante — le provider "local" ne nécessite aucun identifiant ni accès
# réseau : "plan" puis "apply" créent réellement un fichier sur le disque du conteneur API,
# preuve tangible qu'OpenTofu s'exécute pour de vrai. "destroy" le supprime.
# Remplacez par votre vraie configuration (providers cloud, Docker, Kubernetes...) une fois
# que vous avez confirmé que le cycle init/plan/apply/destroy fonctionne chez vous.

terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

resource "local_file" "demo" {
  filename = "\${path.module}/quai-demo.txt"
  content  = "Généré par OpenTofu via QUAI le \${timestamp()}\\n"
}

output "chemin_fichier" {
  value = local_file.demo.filename
}
`,
  },
  ansible: {
    "playbook.yml": `---
# Démo autoportante — tourne en local dans le conteneur API (voir inventory.ini), aucun hôte
# distant requis. Affiche des infos système réelles et écrit un vrai fichier, preuve tangible
# qu'Ansible s'exécute pour de vrai. Remplacez "hosts: local" par votre inventaire réel une
# fois confirmé que ça fonctionne chez vous.
- name: Démo QUAI
  hosts: local
  gather_facts: true
  tasks:
    - name: Afficher la date et le système
      ansible.builtin.debug:
        msg: "Exécuté le {{ ansible_date_time.iso8601 }} sur {{ ansible_system }} ({{ ansible_architecture }})"

    - name: Écrire un fichier de preuve
      ansible.builtin.copy:
        dest: "{{ playbook_dir }}/quai-demo.txt"
        content: "Généré par Ansible via QUAI le {{ ansible_date_time.iso8601 }}\\n"
`,
    "inventory.ini": `[local]
localhost ansible_connection=local
`,
  },
  packer: {
    "template.pkr.hcl": `# Démo autoportante — construit une VRAIE image Docker (visible ensuite sur la page Images
# de QUAI) à partir d'alpine, sans identifiant ni accès cloud requis. Preuve tangible que
# Packer s'exécute pour de vrai. Remplacez par votre vrai template (AMI, ISO, VMware...) une
# fois confirmé que ça fonctionne chez vous.

packer {
  required_plugins {
    docker = {
      source  = "github.com/hashicorp/docker"
      version = ">= 1.0.0"
    }
  }
}

source "docker" "demo" {
  image  = "alpine:3.19"
  commit = true
}

build {
  sources = ["source.docker.demo"]

  provisioner "shell" {
    inline = [
      "echo 'Construit par Packer via QUAI' > /quai-demo.txt",
      "date >> /quai-demo.txt"
    ]
  }

  post-processor "docker-tag" {
    repository = "quai-demo"
    tags       = ["latest"]
  }
}
`,
  },
  // Workspaces "docker" : créés UNIQUEMENT par le catalogue de templates (services/templates.ts),
  // qui remplace aussitôt ce scaffold par les fichiers générés — jamais via POST /api/iac/workspaces.
  docker: {
    Dockerfile: `# Scaffold minimal — remplacé par le Dockerfile généré du template (voir services/templates.ts).
FROM alpine:3.20
CMD ["sh"]
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
