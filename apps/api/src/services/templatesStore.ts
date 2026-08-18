/**
 * Persistance du catalogue de templates d'images (data/templates.json, 0600) — même pattern
 * fichier JSON simple que services/iac/workspaces.ts (index à côté de config.json, pas de base
 * de données). Aucun secret ici : un template ne porte que des métadonnées de build ; les
 * identifiants Prism ne sont jamais écrits sur disque par ce chantier (voir services/templates.ts
 * pour l'injection à l'exécution).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ImageTemplate } from "../types.js";

function templatesIndexPath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "templates.json");
}

async function readIndex(): Promise<ImageTemplate[]> {
  try {
    return JSON.parse(await fs.readFile(templatesIndexPath(), "utf-8")) as ImageTemplate[];
  } catch {
    return [];
  }
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
