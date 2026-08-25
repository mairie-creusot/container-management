/**
 * Sous-ensemble de JSON Schema réellement exploité par QUAI : décrire le formulaire de
 * configuration d'un greffon et localiser ses champs secrets. Volontairement fermé (pas de
 * signature d'index) : ce schéma pilote un formulaire, une clé mal orthographiée doit échouer à
 * la compilation plutôt que d'être silencieusement ignorée.
 */
export type JSONSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/**
 * Extension QUAI au sous-ensemble : dépendance SIMPLE, un seul niveau — « cette propriété n'est
 * demandée que si telle autre vaut X ». JSON Schema exprimerait cela par if/then, hors sous-ensemble
 * et intraduisible en formulaire ; sans ce mot-clé, aucun manifeste ne saurait décrire la bascule
 * jeton/compte de service de 3CX, de GLPI ou d'AD CS.
 */
export interface JSONSchemaCondition {
  /** Nom d'une AUTRE propriété du même objet — jamais un chemin pointé. */
  field: string;
  equals: string | number | boolean;
}

export interface JSONSchema {
  type?: JSONSchemaType | undefined;
  title?: string | undefined;
  description?: string | undefined;
  properties?: Record<string, JSONSchema> | undefined;
  required?: string[] | undefined;
  items?: JSONSchema | undefined;
  enum?: unknown[] | undefined;
  /** Libellés affichés pour `enum`, dans le MÊME ordre. Sans eux, l'écran montre la valeur brute
   * ("user-token" au lieu de « Jeton utilisateur »). */
  enumLabels?: string[] | undefined;
  default?: unknown;
  const?: unknown;
  examples?: unknown[] | undefined;
  format?: string | undefined;
  pattern?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  additionalProperties?: boolean | undefined;
  /** Uniquement sur une propriété de PREMIER niveau de configSchema (voir validateManifest). */
  showIf?: JSONSchemaCondition | undefined;
}

/** Chemin pointé ("proxy.token") pour atteindre un champ imbriqué — `undefined` si absent du schéma. */
export function resolveSchemaField(schema: JSONSchema, path: string): JSONSchema | undefined {
  const segments = path.split(".");
  let current: JSONSchema | undefined = schema;
  for (const segment of segments) {
    if (segment.length === 0) return undefined;
    const properties: Record<string, JSONSchema> | undefined = current?.properties;
    if (!properties) return undefined;
    current = properties[segment];
    if (!current) return undefined;
  }
  return current;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copie profonde JSON — les schémas et manifestes sont des données JSON pures. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
