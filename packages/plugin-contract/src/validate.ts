/**
 * Validation d'un manifeste/greffon — PURE (aucune E/S, aucune dépendance). Un manifeste invalide
 * est refusé en bloc, avec la liste complète de ce qui cloche : le socle ne charge jamais un
 * greffon à moitié.
 */

import { cloneJson, isPlainObject, resolveSchemaField } from "./jsonSchema.js";
import type { JSONSchema } from "./jsonSchema.js";
import { CORE_API_VERSION } from "./manifest.js";
import type { Plugin, PluginManifest, PluginPermissions, PublicPluginManifest } from "./manifest.js";
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

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const KIND_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
const MANIFEST_KEYS = ["id", "name", "version", "coreApi", "configSchema", "secretFields", "permissions", "auditLabels"];
const PERMISSION_KEYS = ["network", "mutates", "graphNodeKinds"];

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
  }

  const secretFields = stringArray(input.secretFields);
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
    const { permissions, auditLabels } = manifestResult.manifest;
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
  };
}
