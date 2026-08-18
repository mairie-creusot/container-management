// Persistance du catalogue de templates (data/templates.json, 0600) — fichier JSON simple, même
// pattern que services/iac/workspaces.ts. Aucun secret ici. Les templates v1 (kind/baseVersion/
// components) sont migrés vers le modèle recette (base + steps) À LA LECTURE, réécrits une fois.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ImageTemplate, ImageTemplateLastBuild, ImageTemplateStatus, TemplateBase, TemplateStep } from "../types.js";

function templatesIndexPath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "templates.json");
}

interface StoredTemplateV1 {
  id: string;
  name: string;
  kind: "vm-ubuntu" | "container-scratch" | "container-alpine";
  baseVersion: string;
  components: string[];
  status: ImageTemplateStatus;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  lastBuild?: ImageTemplateLastBuild;
}

// Mêmes correspondances composant -> paquets réels que le catalogue fermé v1 (jamais un nom deviné).
const V1_UBUNTU_APT: Record<string, string[]> = {
  docker: ["docker.io"],
  "docker-compose": ["docker-compose-v2"],
  git: ["git"],
  curl: ["curl"],
  htop: ["htop"],
  python3: ["python3"],
  "build-essential": ["build-essential"],
  "qemu-guest-agent": ["qemu-guest-agent"],
};

const V1_ALPINE_APK: Record<string, string[]> = {
  "docker-cli": ["docker-cli"],
  "docker-compose": ["docker-cli-compose"],
  git: ["git"],
  curl: ["curl"],
  bash: ["bash"],
  python3: ["python3"],
  nodejs: ["nodejs"],
  openssl: ["openssl"],
};

/** Conversion d'un template v1 vers le modèle recette — même sémantique de build, rien perdu. */
export function migrateV1Template(v1: StoredTemplateV1): ImageTemplate {
  let base: TemplateBase;
  const steps: TemplateStep[] = [];
  switch (v1.kind) {
    case "vm-ubuntu": {
      base = { type: "cloud-image", distro: "ubuntu", version: v1.baseVersion };
      const packages = v1.components.flatMap((c) => V1_UBUNTU_APT[c] ?? []);
      if (packages.length > 0) steps.push({ type: "packages", packages });
      if (v1.components.includes("docker")) steps.push({ type: "service", name: "docker", enable: true });
      break;
    }
    case "container-alpine": {
      base = { type: "container", image: `alpine:${v1.baseVersion}` };
      const packages = v1.components.flatMap((c) => V1_ALPINE_APK[c] ?? []);
      if (packages.length > 0) steps.push({ type: "packages", packages });
      break;
    }
    case "container-scratch":
      base = { type: "container", image: "scratch" };
      break;
  }
  return {
    id: v1.id,
    name: v1.name,
    base,
    steps,
    status: v1.status,
    workspaceId: v1.workspaceId,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    ...(v1.lastBuild ? { lastBuild: v1.lastBuild } : {}),
  };
}

async function readIndex(): Promise<ImageTemplate[]> {
  let raw: Array<ImageTemplate | StoredTemplateV1>;
  try {
    raw = JSON.parse(await fs.readFile(templatesIndexPath(), "utf-8")) as Array<ImageTemplate | StoredTemplateV1>;
  } catch {
    return [];
  }
  let migrated = false;
  const templates = raw.map((entry) => {
    if ("base" in entry) return entry;
    migrated = true;
    return migrateV1Template(entry);
  });
  if (migrated) await writeIndex(templates);
  return templates;
}

async function writeIndex(templates: ImageTemplate[]): Promise<void> {
  await fs.mkdir(path.dirname(templatesIndexPath()), { recursive: true });
  await fs.writeFile(templatesIndexPath(), JSON.stringify(templates, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export class TemplateNotFoundError extends Error {}

export async function listStoredTemplates(): Promise<ImageTemplate[]> {
  return readIndex();
}

export async function getStoredTemplate(id: string): Promise<ImageTemplate | undefined> {
  return (await readIndex()).find((t) => t.id === id);
}

export async function insertTemplate(template: ImageTemplate): Promise<void> {
  const templates = await readIndex();
  templates.push(template);
  await writeIndex(templates);
}

export async function updateStoredTemplate(
  id: string,
  patch: Partial<Omit<ImageTemplate, "id">>,
): Promise<ImageTemplate> {
  const templates = await readIndex();
  const index = templates.findIndex((t) => t.id === id);
  const existing = templates[index];
  if (!existing) throw new TemplateNotFoundError(`Template "${id}" not found`);
  const updated: ImageTemplate = { ...existing, ...patch, id: existing.id };
  templates[index] = updated;
  await writeIndex(templates);
  return updated;
}

export async function removeStoredTemplate(id: string): Promise<void> {
  const templates = await readIndex();
  const next = templates.filter((t) => t.id !== id);
  if (next.length === templates.length) throw new TemplateNotFoundError(`Template "${id}" not found`);
  await writeIndex(next);
}
