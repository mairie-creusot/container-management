/**
 * Validation d'un manifeste/greffon — PURE (aucune E/S, aucune dépendance). Un manifeste invalide
 * est refusé en bloc, avec la liste complète de ce qui cloche : le socle ne charge jamais un
 * greffon à moitié.
 */

import { cloneJson, isPlainObject, resolveSchemaField } from "./jsonSchema.js";
import type { JSONSchema } from "./jsonSchema.js";
import { CORE_API_VERSION } from "./manifest.js";
import type { Plugin, PluginActionSpec, PluginManifest, PluginPermissions, PublicPluginManifest } from "./manifest.js";
import { isSemver, parseSemverRange, satisfiesSemverRange } from "./semver.js";

export interface PluginValidationIssue {
  /** Code stable, utilisable en test et en journalisation. */
  code: string;
  /** Champ fautif du manifeste ("id", "secretFields[0]", "permissions.network[1]"…). */
  field: string;
  message: string;
}

export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: PluginValidationIssue[] };

export type PluginValidationResult =
  | { ok: true; plugin: Plugin }
  | { ok: false; issues: PluginValidationIssue[] };

export interface ValidationOptions {
  /** Version du socle confrontée à `coreApi` — CORE_API_VERSION par défaut. */
  coreApiVersion?: string | undefined;
}

const SHOW_IF_KEYS = ["field", "equals"];
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const KIND_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
const MANIFEST_KEYS = ["id", "name", "version", "coreApi", "configSchema", "secretFields", "permissions", "auditLabels", "actions"];
const PERMISSION_KEYS = ["network", "mutates", "graphNodeKinds"];
const ACTION_SPEC_KEYS = ["input", "severity", "confirm", "target"];
const ACTION_CONFIRM_KEYS = ["title", "message", "confirmLabel", "retype"];
const ACTION_TARGET_KEYS = ["nodeKind", "field", "menuLabel", "when", "servedByCore"];
const ACTION_CONDITION_KEYS = ["field", "equals", "notEquals", "present"];
const ACTION_SEVERITIES = ["safe", "caution", "destructive"];
/** "vm.start", "create-ticket", "image.create" — les formes réellement en service. */
const ACTION_NAME_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/**
 * Où porter un refus. `code` reste STABLE (jeté en test, en journal) même quand `field` désigne une
 * action précise : "actionInput.showIf.type" sur le champ "actions.vm.add-disk.input.properties.x".
 */
interface SchemaScope {
  code: string;
  field: string;
}

const CONFIG_SCHEMA_SCOPE: SchemaScope = { code: "configSchema", field: "configSchema" };

/** Reproduit la valeur fautive dans le message sans jamais déverser un objet entier. */
function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`;
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "un tableau";
  return typeof value === "object" ? "un objet" : `un ${typeof value}`;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** `undefined` si ce n'est pas un schéma d'objet exploitable comme formulaire de configuration. */
function asObjectSchema(value: unknown): JSONSchema | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.type !== "object" || !isPlainObject(value.properties)) return undefined;
  return value as unknown as JSONSchema;
}

/** Ce qu'une propriété peut PILOTER dans une condition — détermine le type attendu de `equals`. */
type ConditionTargetKind = "string" | "number" | "boolean" | "enum" | "unusable";

function targetKind(property: Record<string, unknown>): ConditionTargetKind {
  if (Array.isArray(property.enum)) return "enum";
  if (property.type === "string") return "string";
  if (property.type === "number" || property.type === "integer") return "number";
  if (property.type === "boolean") return "boolean";
  return "unusable";
}

/** Chemins des showIf enfouis SOUS une propriété, où le formulaire ne les lirait jamais. */
function collectNestedConditions(node: unknown, path: string, found: string[]): void {
  if (!isPlainObject(node)) return;
  const properties = node.properties;
  if (isPlainObject(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      const childPath = `${path}.properties.${key}`;
      if (isPlainObject(child) && child.showIf !== undefined) found.push(childPath);
      collectNestedConditions(child, childPath, found);
    }
  }
  const items = node.items;
  if (isPlainObject(items)) {
    const itemsPath = `${path}.items`;
    if (items.showIf !== undefined) found.push(itemsPath);
    collectNestedConditions(items, itemsPath, found);
  }
}

function checkCondition(
  name: string,
  property: Record<string, unknown>,
  properties: Record<string, unknown>,
  scope: SchemaScope,
  issues: PluginValidationIssue[],
): void {
  const showIf = property.showIf;
  if (showIf === undefined) return;
  const field = `${scope.field}.properties.${name}.showIf`;

  if (!isPlainObject(showIf)) {
    issues.push({
      code: `${scope.code}.showIf.type`,
      field,
      message: `showIf doit être un objet { field, equals }, reçu ${describe(showIf)}.`,
    });
    return;
  }
  for (const key of Object.keys(showIf)) {
    if (!SHOW_IF_KEYS.includes(key)) {
      issues.push({
        code: `${scope.code}.showIf.unknownKey`,
        field: `${field}.${key}`,
        message: `Clé inconnue dans showIf : "${key}" — clés autorisées : ${SHOW_IF_KEYS.join(", ")}.`,
      });
    }
  }

  const target = showIf.field;
  if (typeof target !== "string" || target.trim().length === 0) {
    issues.push({
      code: `${scope.code}.showIf.field`,
      field: `${field}.field`,
      message: `showIf.field doit nommer une propriété du même schéma, reçu ${describe(target)}.`,
    });
    return;
  }
  if (target === name) {
    issues.push({
      code: `${scope.code}.showIf.self`,
      field: `${field}.field`,
      message: `La propriété "${name}" ne peut pas conditionner son affichage à elle-même.`,
    });
    return;
  }

  const controller = properties[target];
  if (!isPlainObject(controller)) {
    issues.push({
      code: `${scope.code}.showIf.unknown`,
      field: `${field}.field`,
      message: `showIf désigne la propriété "${target}", absente de ${scope.field}.properties.`,
    });
    return;
  }
  if (controller.showIf !== undefined) {
    issues.push({
      code: `${scope.code}.showIf.chain`,
      field: `${field}.field`,
      message: `Dépendance en chaîne non supportée : "${name}" dépend de "${target}", elle-même conditionnelle.`,
    });
    return;
  }

  const kind = targetKind(controller);
  if (kind === "unusable") {
    issues.push({
      code: `${scope.code}.showIf.target`,
      field: `${field}.field`,
      message:
        `La propriété "${target}" (type ${describe(controller.type)}) ne peut pas piloter une condition d'affichage : ` +
        `seuls un texte, un nombre, un booléen ou une énumération le peuvent.`,
    });
    return;
  }

  const expected = showIf.equals;
  if (expected === undefined) {
    issues.push({
      code: `${scope.code}.showIf.equals`,
      field: `${field}.equals`,
      message: `showIf.equals est obligatoire : sans valeur attendue, la condition ne peut pas être évaluée.`,
    });
    return;
  }

  if (kind === "enum") {
    const values = Array.isArray(controller.enum) ? controller.enum : [];
    if (!values.includes(expected)) {
      issues.push({
        code: `${scope.code}.showIf.equalsEnum`,
        field: `${field}.equals`,
        message:
          `showIf.equals vaut ${describe(expected)}, qui ne figure pas dans l'énumération de "${target}" ` +
          `(${values.map((value) => describe(value)).join(", ")}).`,
      });
    }
    return;
  }

  const actual = typeof expected;
  if (actual !== kind) {
    issues.push({
      code: `${scope.code}.showIf.equalsType`,
      field: `${field}.equals`,
      message: `La propriété "${target}" est de type ${kind} : showIf.equals doit l'être aussi, reçu ${describe(expected)}.`,
    });
  }
}

/** Conditions d'affichage : lisibles UNIQUEMENT sur une propriété de premier niveau. */
function checkConditions(schema: JSONSchema, scope: SchemaScope, issues: PluginValidationIssue[]): void {
  const properties: Record<string, unknown> = schema.properties ?? {};

  if (schema.showIf !== undefined) {
    issues.push({
      code: `${scope.code}.showIf.placement`,
      field: `${scope.field}.showIf`,
      message: `showIf se porte sur une propriété de ${scope.field}, jamais sur le schéma racine lui-même.`,
    });
  }

  for (const [name, property] of Object.entries(properties)) {
    if (!isPlainObject(property)) continue;
    const nested: string[] = [];
    collectNestedConditions(property, `${scope.field}.properties.${name}`, nested);
    for (const path of nested) {
      issues.push({
        code: `${scope.code}.showIf.placement`,
        field: path,
        message: `showIf n'est lu que sur une propriété de premier niveau de ${scope.field} : à "${path}", il serait ignoré.`,
      });
    }
    checkCondition(name, property, properties, scope, issues);
  }
}

/** Mots-clés qu'un formulaire généré sait honorer. Tout le reste est refusé À L'ENREGISTREMENT :
 * sans cette barrière, un greffon s'installe puis se révèle inconfigurable au premier écran. */
const RENDERABLE_KEYWORDS = [
  "type",
  "title",
  "description",
  "enum",
  "enumLabels",
  "default",
  "examples",
  "format",
  "minimum",
  "maximum",
  "minLength",
  "showIf",
];

/** Le sous-ensemble RÉELLEMENT affichable — doit rester aligné avec l'adaptateur du web
 * (apps/web/src/components/formSchemaFromManifest.ts et ses cas réels 3CX/GLPI/AD CS). */
function checkRenderable(schema: JSONSchema, secretFields: string[], scope: SchemaScope, issues: PluginValidationIssue[]): void {
  const properties: Record<string, unknown> = schema.properties ?? {};
  const secrets = new Set(secretFields);

  for (const [name, raw] of Object.entries(properties)) {
    if (!isPlainObject(raw)) continue;
    const property = raw as Record<string, unknown>;
    const field = `${scope.field}.properties.${name}`;
    const push = (suffix: string, message: string) => issues.push({ code: `${scope.code}.${suffix}`, field, message });

    for (const keyword of Object.keys(property)) {
      if (!RENDERABLE_KEYWORDS.includes(keyword)) {
        push("notRenderable", `Mot-clé "${keyword}" : aucun formulaire ne saurait le respecter.`);
      }
    }

    const type = property["type"];
    const isEnum = Array.isArray(property["enum"]);
    if (!isEnum && type !== "string" && type !== "number" && type !== "boolean") {
      push("notRenderable", `type ${describe(type)} : seuls string, number, boolean et enum sont saisissables.`);
    }
    if (property["format"] !== undefined && property["format"] !== "password") {
      push("notRenderable", `format ${describe(property["format"])} : seul "password" est reconnu.`);
    }
    if (secrets.has(name) && type !== "string") {
      push("notRenderable", "un champ secret se saisit toujours en texte.");
    }

    const labels = property["enumLabels"];
    if (labels !== undefined) {
      const values = property["enum"];
      if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || label.trim() === "")) {
        push("enumLabels", `enumLabels doit être un tableau de libellés non vides, reçu ${describe(labels)}.`);
      } else if (!Array.isArray(values)) {
        push("enumLabels", "enumLabels ne se porte que sur une propriété qui déclare enum.");
      } else if (labels.length !== values.length) {
        push("enumLabels", `enumLabels compte ${labels.length} libellés pour ${values.length} valeurs.`);
      }
    }
  }
}

function checkActionCondition(raw: unknown, field: string, issues: PluginValidationIssue[]): void {
  if (!isPlainObject(raw)) {
    issues.push({
      code: "actions.when",
      field,
      message: `Condition d'affichage invalide : objet { field, equals?, notEquals?, present? } attendu, reçu ${describe(raw)}.`,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!ACTION_CONDITION_KEYS.includes(key)) {
      issues.push({
        code: "actions.when",
        field: `${field}.${key}`,
        message: `Clé inconnue dans une condition : "${key}" — clés autorisées : ${ACTION_CONDITION_KEYS.join(", ")}.`,
      });
    }
  }
  if (typeof raw.field !== "string" || raw.field.trim().length === 0) {
    issues.push({
      code: "actions.when",
      field: `${field}.field`,
      message: `Condition sans champ : indiquez le champ du nœud à consulter (ex "status"), reçu ${describe(raw.field)}.`,
    });
  }
  for (const key of ["equals", "notEquals"] as const) {
    const values = raw[key];
    if (values !== undefined && !Array.isArray(values)) {
      issues.push({ code: "actions.when", field: `${field}.${key}`, message: `${key} doit être un tableau de valeurs, reçu ${describe(values)}.` });
    }
  }
  if (raw.present !== undefined && typeof raw.present !== "boolean") {
    issues.push({ code: "actions.when", field: `${field}.present`, message: `present doit être un booléen, reçu ${describe(raw.present)}.` });
  }
}

function checkActionConfirm(raw: unknown, field: string, hasTarget: boolean, issues: PluginValidationIssue[]): void {
  if (!isPlainObject(raw)) {
    issues.push({
      code: "actions.confirm",
      field,
      message: `confirm doit être un objet { title, message, confirmLabel, retype? }, reçu ${describe(raw)}.`,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!ACTION_CONFIRM_KEYS.includes(key)) {
      issues.push({
        code: "actions.confirm",
        field: `${field}.${key}`,
        message: `Clé inconnue dans confirm : "${key}" — clés autorisées : ${ACTION_CONFIRM_KEYS.join(", ")}.`,
      });
    }
  }
  for (const key of ["title", "message", "confirmLabel"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({
        code: "actions.confirm",
        field: `${field}.${key}`,
        message: `confirm.${key} doit être un texte non vide — une confirmation muette ne confirme rien, reçu ${describe(value)}.`,
      });
    }
  }
  if (raw.retype !== undefined) {
    if (typeof raw.retype !== "boolean") {
      issues.push({ code: "actions.confirm", field: `${field}.retype`, message: `confirm.retype doit être un booléen, reçu ${describe(raw.retype)}.` });
    } else if (raw.retype && !hasTarget) {
      // Sans cible, il n'y a aucun nom à retaper : la confirmation forte serait inapplicable.
      issues.push({
        code: "actions.confirm",
        field: `${field}.retype`,
        message: "confirm.retype exige un target : c'est le libellé du nœud visé que l'utilisateur doit retaper.",
      });
    }
  }
}

function checkActionTarget(
  raw: unknown,
  field: string,
  input: JSONSchema | undefined,
  graphNodeKinds: string[],
  issues: PluginValidationIssue[],
): void {
  if (!isPlainObject(raw)) {
    issues.push({
      code: "actions.target",
      field,
      message: `target doit être un objet { nodeKind, field, menuLabel, … }, reçu ${describe(raw)}.`,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!ACTION_TARGET_KEYS.includes(key)) {
      issues.push({
        code: "actions.target",
        field: `${field}.${key}`,
        message: `Clé inconnue dans target : "${key}" — clés autorisées : ${ACTION_TARGET_KEYS.join(", ")}.`,
      });
    }
  }

  const nodeKind = raw.nodeKind;
  if (typeof nodeKind !== "string" || !KIND_PATTERN.test(nodeKind)) {
    issues.push({
      code: "actions.target",
      field: `${field}.nodeKind`,
      message: `target.nodeKind doit être un type de nœud en minuscules, reçu ${describe(nodeKind)}.`,
    });
  } else if (!graphNodeKinds.includes(nodeKind)) {
    issues.push({
      code: "actions.target",
      field: `${field}.nodeKind`,
      message:
        `target.nodeKind vaut "${nodeKind}", absent de permissions.graphNodeKinds : une action ne se propose que sur ` +
        `un type de nœud que ce greffon contribue réellement.`,
    });
  }

  const targetField = raw.field;
  if (typeof targetField !== "string" || targetField.trim().length === 0) {
    issues.push({
      code: "actions.target",
      field: `${field}.field`,
      message: `target.field doit nommer la propriété d'entrée qui reçoit l'identifiant du nœud, reçu ${describe(targetField)}.`,
    });
  } else if (input?.properties && Object.hasOwn(input.properties, targetField)) {
    // La cible vient du nœud sur lequel on a fait un clic droit : la faire ressaisir ouvrirait la
    // porte à jouer l'action sur une AUTRE machine que celle affichée.
    issues.push({
      code: "actions.target",
      field: `${field}.field`,
      message: `target.field "${targetField}" figure aussi dans input.properties : la cible vient du nœud visé, elle ne se saisit jamais.`,
    });
  }

  const hasMenu = raw.menuLabel !== undefined;
  const hasServed = raw.servedByCore !== undefined;
  if (hasMenu && (typeof raw.menuLabel !== "string" || raw.menuLabel.trim().length === 0)) {
    issues.push({
      code: "actions.target",
      field: `${field}.menuLabel`,
      message: `target.menuLabel doit être un libellé non vide : une entrée de menu doit être lisible, reçu ${describe(raw.menuLabel)}.`,
    });
  }
  if (hasMenu && hasServed) {
    issues.push({
      code: "actions.target",
      field: `${field}.menuLabel`,
      message: "target déclare menuLabel ET servedByCore : l'action serait proposée deux fois dans le même menu.",
    });
  }
  if (!hasMenu && !hasServed) {
    issues.push({
      code: "actions.target",
      field,
      message:
        "target doit déclarer menuLabel (l'entrée de menu proposée) ou servedByCore (ce qui rend déjà cette action " +
        "à l'écran) : sans l'un des deux, l'action est rattachée à un nœud sans que rien ne l'y propose.",
    });
  }

  if (raw.when !== undefined) {
    if (!Array.isArray(raw.when)) {
      issues.push({
        code: "actions.when",
        field: `${field}.when`,
        message: `target.when doit être un tableau de conditions, reçu ${describe(raw.when)}.`,
      });
    } else {
      const conditions: unknown[] = raw.when;
      conditions.forEach((condition, index) => checkActionCondition(condition, `${field}.when[${index}]`, issues));
    }
  }

  if (raw.servedByCore !== undefined && (typeof raw.servedByCore !== "string" || raw.servedByCore.trim().length === 0)) {
    issues.push({
      code: "actions.target",
      field: `${field}.servedByCore`,
      message: `target.servedByCore doit nommer l'entrée du cœur qui rend déjà cette action, reçu ${describe(raw.servedByCore)}.`,
    });
  }
}

/**
 * Description des actions. Une action non décrite reste exécutable (entrée transmise telle quelle),
 * mais une description FAUSSE est refusée en bloc : elle produirait un formulaire inexploitable ou
 * une entrée de menu qui ne mène nulle part.
 */
function checkActions(
  raw: unknown,
  permissions: PluginPermissions | undefined,
  issues: PluginValidationIssue[],
): Record<string, PluginActionSpec> | undefined {
  if (!isPlainObject(raw)) {
    issues.push({ code: "actions.type", field: "actions", message: `actions doit être un objet { nom: description }, reçu ${describe(raw)}.` });
    return undefined;
  }

  const names = Object.keys(raw);
  if (names.length > 0 && permissions?.mutates !== true) {
    issues.push({
      code: "actions.readOnly",
      field: "permissions.mutates",
      message: `Le manifeste décrit des actions (${names.join(", ")}) sans permissions.mutates : le socle impose alors la lecture seule.`,
    });
  }

  const graphNodeKinds = permissions?.graphNodeKinds ?? [];
  const specs: Record<string, PluginActionSpec> = {};

  for (const name of names) {
    const field = `actions.${name}`;
    if (!ACTION_NAME_PATTERN.test(name)) {
      issues.push({
        code: "actions.name",
        field,
        message: `Nom d'action invalide : "${name}" — minuscules, chiffres, tirets et points (ex. "vm.start", "create-ticket").`,
      });
    }

    const spec = raw[name];
    if (!isPlainObject(spec)) {
      issues.push({ code: "actions.spec", field, message: `La description de l'action "${name}" doit être un objet, reçu ${describe(spec)}.` });
      continue;
    }
    for (const key of Object.keys(spec)) {
      if (!ACTION_SPEC_KEYS.includes(key)) {
        issues.push({
          code: "actions.unknownKey",
          field: `${field}.${key}`,
          message: `Clé inconnue dans la description d'une action : "${key}" — clés autorisées : ${ACTION_SPEC_KEYS.join(", ")}.`,
        });
      }
    }

    let input: JSONSchema | undefined;
    if (spec.input !== undefined) {
      input = asObjectSchema(spec.input);
      if (!input) {
        issues.push({
          code: "actions.input",
          field: `${field}.input`,
          message: `input doit être un schéma JSON d'objet : { "type": "object", "properties": { … } } — reçu ${describe(spec.input)}.`,
        });
      } else {
        const scope: SchemaScope = { code: "actionInput", field: `${field}.input` };
        const declared = Object.keys(input.properties ?? {});
        for (const [index, required] of (stringArray(input.required) ?? []).entries()) {
          if (!declared.includes(required)) {
            issues.push({
              code: "actionInput.required",
              field: `${field}.input.required[${index}]`,
              message: `input.required désigne "${required}", absent de input.properties.`,
            });
          }
        }
        checkConditions(input, scope, issues);
        // Aucun secretField pour une entrée d'action : rien ne la chiffre, rien ne la caviarde.
        checkRenderable(input, [], scope, issues);
        for (const [property, node] of Object.entries(input.properties ?? {})) {
          if (isPlainObject(node) && node["format"] !== undefined) {
            issues.push({
              code: "actionInput.secret",
              field: `${field}.input.properties.${property}`,
              message: "Une entrée d'action ne porte aucun secret : rien ne la chiffre au repos ni ne la caviarde à l'écran.",
            });
          }
        }
      }
    }

    if (spec.severity !== undefined && (typeof spec.severity !== "string" || !ACTION_SEVERITIES.includes(spec.severity))) {
      issues.push({
        code: "actions.severity",
        field: `${field}.severity`,
        message: `Niveau de danger inconnu : ${describe(spec.severity)} — attendu ${ACTION_SEVERITIES.join(", ")}.`,
      });
    }

    if (spec.target !== undefined) checkActionTarget(spec.target, `${field}.target`, input, graphNodeKinds, issues);
    if (spec.confirm !== undefined) checkActionConfirm(spec.confirm, `${field}.confirm`, spec.target !== undefined, issues);

    specs[name] = cloneJson(spec) as PluginActionSpec;
  }

  return specs;
}

export function validateManifest(input: unknown, options: ValidationOptions = {}): ManifestValidationResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [{ code: "manifest.type", field: "manifest", message: `Le manifeste doit être un objet, reçu ${describe(input)}.` }],
    };
  }

  const coreApiVersion = options.coreApiVersion ?? CORE_API_VERSION;
  const issues: PluginValidationIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.includes(key)) {
      issues.push({
        code: "manifest.unknownKey",
        field: key,
        message: `Clé de manifeste inconnue : "${key}" — clés autorisées : ${MANIFEST_KEYS.join(", ")}.`,
      });
    }
  }

  const rawId = input.id;
  const id = typeof rawId === "string" ? rawId : "";
  if (!ID_PATTERN.test(id) || id.length < 2 || id.length > 32 || id.includes("--")) {
    issues.push({
      code: "id.pattern",
      field: "id",
      message:
        `Identifiant de greffon invalide : ${describe(rawId)} — attendu 2 à 32 caractères en minuscules ` +
        `(lettres, chiffres, tirets), sans tiret en début ni en fin et sans double tiret (ex. "hycu", "3cx").`,
    });
  }

  const rawName = input.name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    issues.push({ code: "name.required", field: "name", message: `Le nom du greffon est obligatoire, reçu ${describe(rawName)}.` });
  }

  const rawVersion = input.version;
  if (!isSemver(rawVersion)) {
    issues.push({
      code: "version.semver",
      field: "version",
      message: `Version de greffon invalide : ${describe(rawVersion)} — semver attendu, sous la forme MAJEUR.MINEUR.CORRECTIF (ex. "1.0.0").`,
    });
  }

  const rawCoreApi = input.coreApi;
  if (typeof rawCoreApi !== "string" || parseSemverRange(rawCoreApi) === undefined) {
    issues.push({
      code: "coreApi.range",
      field: "coreApi",
      message: `Plage de compatibilité coreApi invalide : ${describe(rawCoreApi)} — formats acceptés : "^1.0", "~1.0.2", "1.0.0".`,
    });
  } else if (!satisfiesSemverRange(coreApiVersion, rawCoreApi)) {
    issues.push({
      code: "coreApi.incompatible",
      field: "coreApi",
      message: `Greffon incompatible : il exige coreApi ${describe(rawCoreApi)} alors que le socle expose la version ${coreApiVersion}.`,
    });
  }

  const rawSchema = input.configSchema;
  const schema = asObjectSchema(rawSchema);
  if (!schema) {
    issues.push({
      code: "configSchema.type",
      field: "configSchema",
      message: `configSchema doit être un schéma JSON d'objet : { "type": "object", "properties": { … } } — reçu ${describe(rawSchema)}.`,
    });
  } else {
    const declared = Object.keys(schema.properties ?? {});
    for (const [index, required] of (stringArray(schema.required) ?? []).entries()) {
      if (!declared.includes(required)) {
        issues.push({
          code: "configSchema.required",
          field: `configSchema.required[${index}]`,
          message: `configSchema.required désigne "${required}", absent de configSchema.properties.`,
        });
      }
    }
    checkConditions(schema, CONFIG_SCHEMA_SCOPE, issues);
  }

  const secretFields = stringArray(input.secretFields);
  if (schema) checkRenderable(schema, secretFields ?? [], CONFIG_SCHEMA_SCOPE, issues);
  if (!secretFields) {
    issues.push({
      code: "secretFields.type",
      field: "secretFields",
      message: `secretFields doit être un tableau de noms de champs, reçu ${describe(input.secretFields)}.`,
    });
  } else {
    const seen = new Set<string>();
    for (const [index, field] of secretFields.entries()) {
      if (field.trim().length === 0) {
        issues.push({ code: "secretFields.empty", field: `secretFields[${index}]`, message: "secretFields contient un nom de champ vide." });
        continue;
      }
      if (seen.has(field)) {
        issues.push({ code: "secretFields.duplicate", field: `secretFields[${index}]`, message: `secretFields déclare deux fois le champ "${field}".` });
        continue;
      }
      seen.add(field);
      if (!schema) continue;
      const node = resolveSchemaField(schema, field);
      if (!node) {
        issues.push({
          code: "secretFields.unknown",
          field: `secretFields[${index}]`,
          message: `secretFields désigne le champ "${field}", absent de configSchema.properties.`,
        });
        continue;
      }
      if (node.default !== undefined || node.const !== undefined || node.examples !== undefined) {
        issues.push({
          code: "secretFields.value",
          field: `secretFields[${index}]`,
          message: `Le champ secret "${field}" ne peut pas porter de valeur dans configSchema (default/const/examples) : un secret n'est jamais renvoyé par l'API.`,
        });
      }
    }
  }

  const rawPermissions = input.permissions;
  let permissions: PluginPermissions | undefined;
  if (!isPlainObject(rawPermissions)) {
    issues.push({
      code: "permissions.type",
      field: "permissions",
      message: `permissions doit être un objet ({ network?, mutates?, graphNodeKinds? }), reçu ${describe(rawPermissions)}.`,
    });
  } else {
    permissions = {};
    for (const key of Object.keys(rawPermissions)) {
      if (!PERMISSION_KEYS.includes(key)) {
        issues.push({
          code: "permissions.unknownKey",
          field: `permissions.${key}`,
          message: `Permission inconnue : "${key}" — permissions autorisées : ${PERMISSION_KEYS.join(", ")}.`,
        });
      }
    }

    if (rawPermissions.network !== undefined) {
      const network = stringArray(rawPermissions.network);
      if (!network) {
        issues.push({
          code: "permissions.network",
          field: "permissions.network",
          message: `permissions.network doit être un tableau d'hôtes, reçu ${describe(rawPermissions.network)}.`,
        });
      } else {
        for (const [index, host] of network.entries()) {
          if (!HOST_PATTERN.test(host)) {
            issues.push({
              code: "permissions.network",
              field: `permissions.network[${index}]`,
              message: `permissions.network[${index}] = ${describe(host)} doit être un hôte (nom DNS ou IP), éventuellement suivi de ":port", sans schéma d'URL ni chemin.`,
            });
          }
        }
        permissions.network = network;
      }
    }

    if (rawPermissions.mutates !== undefined) {
      if (typeof rawPermissions.mutates !== "boolean") {
        issues.push({
          code: "permissions.mutates",
          field: "permissions.mutates",
          message: `permissions.mutates doit être un booléen, reçu ${describe(rawPermissions.mutates)}.`,
        });
      } else {
        permissions.mutates = rawPermissions.mutates;
      }
    }

    if (rawPermissions.graphNodeKinds !== undefined) {
      const kinds = stringArray(rawPermissions.graphNodeKinds);
      if (!kinds) {
        issues.push({
          code: "permissions.graphNodeKinds",
          field: "permissions.graphNodeKinds",
          message: `permissions.graphNodeKinds doit être un tableau de types de nœuds, reçu ${describe(rawPermissions.graphNodeKinds)}.`,
        });
      } else {
        for (const [index, kind] of kinds.entries()) {
          if (!KIND_PATTERN.test(kind)) {
            issues.push({
              code: "permissions.graphNodeKinds",
              field: `permissions.graphNodeKinds[${index}]`,
              message: `permissions.graphNodeKinds[${index}] = ${describe(kind)} doit être en minuscules (lettres, chiffres, tirets).`,
            });
          }
        }
        permissions.graphNodeKinds = kinds;
      }
    }
  }

  const rawAuditLabels = input.auditLabels;
  let auditLabels: Record<string, string> | undefined;
  if (!isPlainObject(rawAuditLabels)) {
    issues.push({
      code: "auditLabels.type",
      field: "auditLabels",
      message: `auditLabels doit être un objet { action: libellé }, reçu ${describe(rawAuditLabels)}.`,
    });
  } else {
    auditLabels = {};
    for (const [key, value] of Object.entries(rawAuditLabels)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        issues.push({
          code: "auditLabels.label",
          field: `auditLabels.${key}`,
          message: `auditLabels["${key}"] doit être un libellé non vide, reçu ${describe(value)}.`,
        });
        continue;
      }
      auditLabels[key] = value;
    }
  }

  const actionSpecs = input.actions === undefined ? undefined : checkActions(input.actions, permissions, issues);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    manifest: {
      id,
      name: (rawName as string).trim(),
      version: rawVersion as string,
      coreApi: rawCoreApi as string,
      configSchema: cloneJson(schema as JSONSchema),
      secretFields: [...(secretFields ?? [])],
      permissions: permissions ?? {},
      auditLabels: auditLabels ?? {},
      ...(actionSpecs !== undefined ? { actions: actionSpecs } : {}),
    },
  };
}

export function validatePlugin(input: unknown, options: ValidationOptions = {}): PluginValidationResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [
        {
          code: "plugin.type",
          field: "plugin",
          message: `Un greffon doit être un objet exposant manifest, test() et snapshot(), reçu ${describe(input)}.`,
        },
      ],
    };
  }

  const issues: PluginValidationIssue[] = [];
  const manifestResult = validateManifest(input.manifest, options);
  if (!manifestResult.ok) issues.push(...manifestResult.issues);

  if (typeof input.test !== "function") {
    issues.push({ code: "plugin.test", field: "test", message: "Le greffon doit exposer test(config) : Promise<{ ok, message }>." });
  }
  if (typeof input.snapshot !== "function") {
    issues.push({ code: "plugin.snapshot", field: "snapshot", message: "Le greffon doit exposer snapshot(config) : Promise<ServiceModuleSnapshot>." });
  }
  if (input.graph !== undefined && typeof input.graph !== "function") {
    issues.push({ code: "plugin.graph", field: "graph", message: `graph, s'il est fourni, doit être une fonction, reçu ${describe(input.graph)}.` });
  }

  // Un configStore à moitié fourni est pire que pas de configStore du tout : le socle écrirait par
  // la voie du greffon et lirait par la voie générique, ou l'inverse.
  const rawStore = input.configStore;
  if (rawStore !== undefined) {
    if (!isPlainObject(rawStore)) {
      issues.push({
        code: "plugin.configStore",
        field: "configStore",
        message: `configStore, s'il est fourni, doit être un objet { load, save, remove }, reçu ${describe(rawStore)}.`,
      });
    } else {
      for (const name of ["load", "save", "remove"]) {
        if (typeof rawStore[name] !== "function") {
          issues.push({
            code: "plugin.configStore",
            field: `configStore.${name}`,
            message: `configStore.${name} doit être une fonction, reçu ${describe(rawStore[name])}.`,
          });
        }
      }
    }
  }

  const rawActions = input.actions;
  let actionNames: string[] = [];
  if (rawActions !== undefined) {
    if (!isPlainObject(rawActions)) {
      issues.push({ code: "plugin.actions", field: "actions", message: `actions doit être un objet { nom: fonction }, reçu ${describe(rawActions)}.` });
    } else {
      actionNames = Object.keys(rawActions);
      for (const name of actionNames) {
        if (typeof rawActions[name] !== "function") {
          issues.push({ code: "plugin.actions", field: `actions.${name}`, message: `L'action "${name}" doit être une fonction.` });
        }
      }
    }
  }

  if (manifestResult.ok) {
    const { permissions, auditLabels, actions: declared } = manifestResult.manifest;
    // Une action décrite mais jamais implémentée offrirait une entrée de menu qui ne mène nulle part.
    for (const name of Object.keys(declared ?? {})) {
      if (!actionNames.includes(name)) {
        issues.push({
          code: "actions.notImplemented",
          field: `actions.${name}`,
          message: `Le manifeste décrit l'action "${name}", que le greffon n'implémente pas.`,
        });
      }
    }
    if (actionNames.length > 0 && permissions.mutates !== true) {
      issues.push({
        code: "actions.readOnly",
        field: "permissions.mutates",
        message: `Le greffon déclare des actions (${actionNames.join(", ")}) sans permissions.mutates : le socle impose alors la lecture seule.`,
      });
    }
    for (const name of actionNames) {
      if (typeof auditLabels[name] !== "string") {
        issues.push({
          code: "actions.auditLabel",
          field: `auditLabels.${name}`,
          message: `L'action "${name}" n'a pas de libellé dans auditLabels : toute action doit être traçable.`,
        });
      }
    }
    if (typeof input.graph === "function" && (permissions.graphNodeKinds ?? []).length === 0) {
      issues.push({
        code: "graph.nodeKinds",
        field: "permissions.graphNodeKinds",
        message: "Le greffon fournit graph() sans permissions.graphNodeKinds : déclarez les types de nœuds qu'il ajoute au graphe.",
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plugin: input as unknown as Plugin };
}

/** Manifeste exposable par l'API : copie expurgée de toute valeur portée par un champ secret. */
export function publicManifest(manifest: PluginManifest): PublicPluginManifest {
  const configSchema = cloneJson(manifest.configSchema);
  for (const field of manifest.secretFields) {
    const node = resolveSchemaField(configSchema, field);
    if (!node) continue;
    delete node.default;
    delete node.const;
    delete node.examples;
  }

  const permissions: PluginPermissions = {};
  if (manifest.permissions.network !== undefined) permissions.network = [...manifest.permissions.network];
  if (manifest.permissions.mutates !== undefined) permissions.mutates = manifest.permissions.mutates;
  if (manifest.permissions.graphNodeKinds !== undefined) permissions.graphNodeKinds = [...manifest.permissions.graphNodeKinds];

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    coreApi: manifest.coreApi,
    configSchema,
    secretFields: [...manifest.secretFields],
    permissions,
    auditLabels: { ...manifest.auditLabels },
    // La description des actions n'a AUCUNE valeur à expurger (aucun secret n'y est admis, voir
    // checkActions) : l'interface en a besoin en entier pour déduire menus et formulaires.
    ...(manifest.actions !== undefined ? { actions: cloneJson(manifest.actions) } : {}),
  };
}
