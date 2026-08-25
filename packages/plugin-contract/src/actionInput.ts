/**
 * Validation de l'ENTRÉE d'une action, contre le schéma que son manifeste déclare
 * (PluginActionSpec#input). PURE : aucune E/S, aucune connaissance d'une intégration.
 *
 * Le socle refuse ici ce qu'aucun formulaire n'aurait laissé passer — champ obligatoire absent,
 * type faux, valeur hors bornes, choix hors énumération — plutôt que de transmettre à une action
 * MUTANTE une entrée qu'elle n'attend pas. Les bornes restent celles du service réel : ce contrôle
 * s'ajoute au sien, il ne le remplace jamais.
 *
 * Ce qui n'est PAS refusé mais ÉCARTÉ : une propriété masquée par son `showIf` — même règle que le
 * formulaire (SchemaForm#buildSubmission n'émet jamais un champ invisible).
 */

import { isPlainObject } from "./jsonSchema.js";
import type { JSONSchema } from "./jsonSchema.js";

export interface ActionInputIssue {
  /** Nom de la propriété fautive, ou "input" pour le corps entier. */
  field: string;
  message: string;
}

export type ActionInputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; issues: ActionInputIssue[] };

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`;
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "un tableau";
  return typeof value === "object" ? "un objet" : `un ${typeof value}`;
}

/** Valeur effectivement retenue pour une propriété : celle fournie, sinon son `default`. */
function effectiveValue(property: JSONSchema, provided: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(provided, name) && provided[name] !== undefined ? provided[name] : property.default;
}

function isVisible(property: JSONSchema, properties: Record<string, JSONSchema>, provided: Record<string, unknown>): boolean {
  const condition = property.showIf;
  if (!condition) return true;
  const controller = properties[condition.field];
  if (!controller) return false;
  return effectiveValue(controller, provided, condition.field) === condition.equals;
}

function checkValue(name: string, property: JSONSchema, value: unknown, issues: ActionInputIssue[]): boolean {
  const label = property.title ?? name;

  if (Array.isArray(property.enum)) {
    if (!property.enum.includes(value)) {
      issues.push({
        field: name,
        message: `${label} : valeur ${describe(value)} hors des choix proposés (${property.enum.map((entry) => describe(entry)).join(", ")}).`,
      });
      return false;
    }
    return true;
  }

  if (property.type === "number" || property.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ field: name, message: `${label} : un nombre est attendu, reçu ${describe(value)}.` });
      return false;
    }
    if (property.type === "integer" && !Number.isInteger(value)) {
      issues.push({ field: name, message: `${label} : un nombre entier est attendu, reçu ${value}.` });
      return false;
    }
    if (property.minimum !== undefined && value < property.minimum) {
      issues.push({ field: name, message: `${label} : ${value} est en dessous du minimum ${property.minimum}.` });
      return false;
    }
    if (property.maximum !== undefined && value > property.maximum) {
      issues.push({ field: name, message: `${label} : ${value} dépasse le maximum ${property.maximum}.` });
      return false;
    }
    return true;
  }

  if (property.type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({ field: name, message: `${label} : oui ou non attendu, reçu ${describe(value)}.` });
      return false;
    }
    return true;
  }

  if (typeof value !== "string") {
    issues.push({ field: name, message: `${label} : un texte est attendu, reçu ${describe(value)}.` });
    return false;
  }
  if (property.minLength !== undefined && value.length < property.minLength) {
    issues.push({ field: name, message: `${label} : ${property.minLength} caractère(s) au minimum.` });
    return false;
  }
  if (property.maxLength !== undefined && value.length > property.maxLength) {
    issues.push({ field: name, message: `${label} : ${property.maxLength} caractère(s) au maximum.` });
    return false;
  }
  return true;
}

/**
 * `schema` absent = l'action ne décrit pas son entrée : rien n'est vérifié et rien n'est retenu —
 * c'est à l'appelant de décider s'il transmet le corps tel quel (voie historique) ou non.
 */
export function validateActionInput(schema: JSONSchema | undefined, raw: unknown): ActionInputResult {
  if (!schema) return { ok: true, input: {} };

  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return { ok: false, issues: [{ field: "input", message: `L'entrée de l'action doit être un objet, reçue ${describe(raw)}.` }] };
  }
  const provided: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const properties: Record<string, JSONSchema> = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const issues: ActionInputIssue[] = [];

  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(properties, name)) {
      issues.push({ field: name, message: `Champ inconnu "${name}" : cette action ne l'attend pas.` });
    }
  }

  const input: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (!isVisible(property, properties, provided)) continue;
    const value = effectiveValue(property, provided, name);
    if (value === undefined || value === "") {
      // Chaîne vide = champ laissé vide dans le formulaire, jamais une valeur transmise.
      if (required.has(name)) issues.push({ field: name, message: `${property.title ?? name} est obligatoire.` });
      continue;
    }
    if (checkValue(name, property, value, issues)) input[name] = value;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, input };
}
