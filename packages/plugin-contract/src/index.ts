/**
 * `@quai/plugin-contract` — contrat des greffons d'intégration QUAI : types et validateurs PURS,
 * sans Fastify, sans Docker, sans E/S. Toute intégration (HYCU, 3CX, GLPI, Nutanix…) se décrit par
 * un manifeste conforme à ce contrat, validé à l'enregistrement par apps/api/src/plugins/registry.ts.
 *
 * Ce paquet n'a volontairement pas de script `build` : c'est apps/api qui compile son `dist/` avant
 * son propre tsc/vitest (voir apps/api/package.json), pour que la CI n'ait aucune étape à ajouter.
 */

export { CORE_API_VERSION } from "./manifest.js";
export type {
  Plugin,
  PluginAction,
  PluginConfigStore,
  PluginGraphAttachment,
  PluginGraphContribution,
  PluginGraphEdge,
  PluginGraphNode,
  PluginManifest,
  PluginPermissions,
  PluginTestResult,
  PublicPluginManifest,
} from "./manifest.js";

export { cloneJson, isPlainObject, resolveSchemaField } from "./jsonSchema.js";
export type { JSONSchema, JSONSchemaCondition, JSONSchemaType } from "./jsonSchema.js";

export { isSemver, parseSemver, parseSemverRange, satisfiesSemverRange } from "./semver.js";
export type { Semver, SemverRange, SemverRangeOperator } from "./semver.js";

export type {
  ServiceModuleEntity,
  ServiceModuleEntityStatus,
  ServiceModuleRelation,
  ServiceModuleRelationState,
  ServiceModuleSnapshot,
  ServiceModuleStatus,
  ServiceModuleSummaryItem,
  ServiceModuleTone,
} from "./snapshot.js";

export { publicManifest, validateManifest, validatePlugin } from "./validate.js";
export type { ManifestValidationResult, PluginValidationIssue, PluginValidationResult, ValidationOptions } from "./validate.js";
