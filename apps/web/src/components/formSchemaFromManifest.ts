/**
 * Traduit le `configSchema` + `secretFields` d'un manifeste de greffon en `FormSchema`. Fonction
 * PURE, alimentée par le JSON de GET /api/plugins : tout ce qui n'est pas convertible est REFUSÉ
 * avec son motif, jamais rendu à moitié.
 */
import {
  validateSchema,
  type FormSchema,
  type SchemaCondition,
  type SchemaEnumOption,
  type SchemaField,
  type SchemaFieldCommon,
} from "./SchemaForm";

export type ManifestFormResult = { ok: true; schema: FormSchema } | { ok: false; problems: string[] };

/** Mots-clés du sous-ensemble @quai/plugin-contract — tout autre est une faute de frappe. */
const KNOWN_KEYWORDS = [
  "type",
  "title",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "enumLabels",
  "default",
  "const",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "additionalProperties",
  "showIf",
];

const CONVERTIBLE_TYPES = ["string", "number", "boolean"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return `« ${value} »`;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`;
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "un tableau";
  return typeof value === "object" ? "un objet" : `un ${typeof value}`;
}

function readSecrets(raw: unknown, names: readonly string[], problems: string[]): Set<string> {
  const secrets = new Set<string>();
  if (raw === undefined) return secrets;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    problems.push(`secretFields doit être un tableau de noms de champs, reçu ${describe(raw)}.`);
    return secrets;
  }
  for (const entry of raw as string[]) {
    if (names.includes(entry)) {
      secrets.add(entry);
      continue;
    }
    problems.push(
      entry.includes(".")
        ? `secretFields désigne ${quote(entry)} : un champ imbriqué n'est pas convertible en formulaire à plat.`
        : `secretFields désigne ${quote(entry)}, absent des propriétés du configSchema.`,
    );
  }
  return secrets;
}

function readRequired(raw: unknown, names: readonly string[], problems: string[]): Set<string> {
  const required = new Set<string>();
  if (raw === undefined) return required;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    problems.push(`configSchema.required doit être un tableau de noms de propriétés, reçu ${describe(raw)}.`);
    return required;
  }
  for (const entry of raw as string[]) {
    if (names.includes(entry)) required.add(entry);
    else problems.push(`configSchema.required désigne ${quote(entry)}, absent des propriétés du configSchema.`);
  }
  return required;
}

function readLabel(name: string, property: Record<string, unknown>, problems: string[]): string {
  const title = property["title"];
  if (title === undefined) return name;
  if (typeof title !== "string" || title.trim().length === 0) {
    problems.push(`Propriété ${quote(name)} : « title » doit être un libellé non vide, reçu ${describe(title)}.`);
    return name;
  }
  return title;
}

function readHelp(name: string, property: Record<string, unknown>, problems: string[]): string | undefined {
  const description = property["description"];
  if (description === undefined) return undefined;
  if (typeof description !== "string" || description.trim().length === 0) {
    problems.push(`Propriété ${quote(name)} : « description » doit être un texte non vide, reçu ${describe(description)}.`);
    return undefined;
  }
  return description;
}

/** Reprise TELLE QUELLE : les règles de cohérence sont celles de SchemaForm#validateSchema. */
function readCondition(name: string, property: Record<string, unknown>, problems: string[]): SchemaCondition | undefined {
  const showIf = property["showIf"];
  if (showIf === undefined) return undefined;
  if (!isRecord(showIf)) {
    problems.push(`Propriété ${quote(name)} : « showIf » doit être un objet { field, equals }, reçu ${describe(showIf)}.`);
    return undefined;
  }
  const target = showIf["field"];
  const equals = showIf["equals"];
  if (typeof target !== "string" || target.trim().length === 0) {
    problems.push(`Propriété ${quote(name)} : « showIf.field » doit nommer une propriété, reçu ${describe(target)}.`);
    return undefined;
  }
  if (typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
    problems.push(
      `Propriété ${quote(name)} : « showIf.equals » doit être un texte, un nombre ou un booléen, reçu ${describe(equals)}.`,
    );
    return undefined;
  }
  return { field: target, equals };
}

/** Seul le PREMIER exemple devient une aide de saisie : le formulaire n'a qu'un placeholder. */
function readPlaceholder(
  name: string,
  property: Record<string, unknown>,
  type: "string" | "number",
  problems: string[],
): string | undefined {
  const examples = property["examples"];
  if (examples === undefined) return undefined;
  if (!Array.isArray(examples) || examples.length === 0) {
    problems.push(`Propriété ${quote(name)} : « examples » doit être un tableau non vide, reçu ${describe(examples)}.`);
    return undefined;
  }
  const first: unknown = examples[0];
  if (type === "number") {
    if (typeof first !== "number") {
      problems.push(`Propriété ${quote(name)} : « examples[0] » doit être un nombre, reçu ${describe(first)}.`);
      return undefined;
    }
    return String(first);
  }
  if (typeof first !== "string" || first.length === 0) {
    problems.push(`Propriété ${quote(name)} : « examples[0] » doit être un texte non vide, reçu ${describe(first)}.`);
    return undefined;
  }
  return first;
}

function readBound(
  name: string,
  property: Record<string, unknown>,
  keyword: "minimum" | "maximum",
  problems: string[],
): number | undefined {
  const bound = property[keyword];
  if (bound === undefined) return undefined;
  if (typeof bound !== "number" || !Number.isFinite(bound)) {
    problems.push(`Propriété ${quote(name)} : ${quote(keyword)} doit être un nombre, reçu ${describe(bound)}.`);
    return undefined;
  }
  return bound;
}

function readOptions(name: string, raw: unknown, rawLabels: unknown, problems: string[]): SchemaEnumOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`Propriété ${quote(name)} : « enum » doit être un tableau de valeurs non vide, reçu ${describe(raw)}.`);
    return [];
  }
  // `enumLabels` est facultatif : sans lui, la valeur brute sert de libellé (« user-token »).
  let labels: string[] | undefined;
  if (rawLabels !== undefined) {
    if (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== "string" || label.trim().length === 0)) {
      problems.push(`Propriété ${quote(name)} : « enumLabels » doit être un tableau de libellés non vides, reçu ${describe(rawLabels)}.`);
    } else if (rawLabels.length !== raw.length) {
      problems.push(`Propriété ${quote(name)} : ${rawLabels.length} libellés pour ${raw.length} valeurs — la correspondance serait arbitraire.`);
    } else {
      labels = rawLabels as string[];
    }
  }
  const options: SchemaEnumOption[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      problems.push(
        `Propriété ${quote(name)} : seule une énumération de textes non vides est convertible, valeur ${describe(value)} reçue.`,
      );
      continue;
    }
    options.push({ value, label: labels?.[index] ?? value });
  }
  return options;
}

/** Contraintes que le formulaire ne saurait pas faire respecter : refusées, jamais ignorées. */
function checkUnsupported(
  name: string,
  property: Record<string, unknown>,
  type: string,
  required: boolean,
  secret: boolean,
  problems: string[],
): void {
  for (const keyword of Object.keys(property)) {
    if (!KNOWN_KEYWORDS.includes(keyword)) {
      problems.push(`Propriété ${quote(name)} : mot-clé inconnu ${quote(keyword)} — le formulaire ne l'interprète pas.`);
    }
  }
  if (property["const"] !== undefined) {
    problems.push(`Propriété ${quote(name)} : « const » fige la valeur — ce n'est pas un champ à saisir.`);
  }
  if (property["pattern"] !== undefined) {
    problems.push(`Propriété ${quote(name)} : « pattern » n'est pas convertible — le formulaire ne vérifie aucune expression régulière.`);
  }
  if (property["maxLength"] !== undefined) {
    problems.push(`Propriété ${quote(name)} : « maxLength » n'est pas convertible — le formulaire ne borne pas la longueur d'une saisie.`);
  }
  const minLength = property["minLength"];
  if (minLength !== undefined) {
    if (typeof minLength !== "number") {
      problems.push(`Propriété ${quote(name)} : « minLength » doit être un nombre, reçu ${describe(minLength)}.`);
    } else if (minLength > 1) {
      problems.push(
        `Propriété ${quote(name)} : « minLength » ${minLength} n'est pas convertible — le formulaire n'impose qu'une saisie non vide.`,
      );
    } else if (minLength === 1 && !required) {
      problems.push(
        `Propriété ${quote(name)} : « minLength » 1 sur un champ facultatif ne serait pas appliqué — déclarez-le dans configSchema.required.`,
      );
    }
  }
  if (property["required"] !== undefined) {
    problems.push(`Propriété ${quote(name)} : « required » se déclare dans configSchema.required, jamais sur la propriété.`);
  }
  for (const keyword of ["properties", "items", "additionalProperties"]) {
    if (property[keyword] !== undefined) {
      problems.push(`Propriété ${quote(name)} : ${quote(keyword)} décrit un sous-schéma, non convertible en champ de formulaire.`);
    }
  }
  if (type !== "number") {
    for (const keyword of ["minimum", "maximum"]) {
      if (property[keyword] !== undefined) {
        problems.push(`Propriété ${quote(name)} : ${quote(keyword)} ne s'applique qu'à une propriété de type « number ».`);
      }
    }
  }
  const format = property["format"];
  if (format !== undefined) {
    if (format !== "password") {
      problems.push(`Propriété ${quote(name)} : format ${describe(format)} non supporté (seul « password » l'est).`);
    } else if (!secret) {
      problems.push(`Propriété ${quote(name)} : un champ de format « password » doit figurer dans secretFields.`);
    }
  }
}

function toField(
  name: string,
  property: Record<string, unknown>,
  required: boolean,
  secret: boolean,
  problems: string[],
): SchemaField | null {
  const type = property["type"];
  if (typeof type !== "string") {
    problems.push(`Propriété ${quote(name)} : « type » manquant — le formulaire ne devine pas le type d'un champ.`);
    return null;
  }
  if (type === "integer") {
    problems.push(
      `Propriété ${quote(name)} : le type « integer » n'est pas convertible — le formulaire ne contraint pas une saisie ` +
        `aux entiers. Déclarez « number ».`,
    );
    return null;
  }
  if (!CONVERTIBLE_TYPES.includes(type)) {
    problems.push(
      `Propriété ${quote(name)} : type ${quote(type)} non convertible en champ de formulaire ` +
        `(types convertibles : ${CONVERTIBLE_TYPES.join(", ")}).`,
    );
    return null;
  }

  checkUnsupported(name, property, type, required, secret, problems);

  const help = readHelp(name, property, problems);
  const condition = readCondition(name, property, problems);
  const base: SchemaFieldCommon = {
    name,
    label: readLabel(name, property, problems),
    ...(help !== undefined ? { help } : {}),
    ...(condition !== undefined ? { showIf: condition } : {}),
  };
  const fallback: unknown = property["default"];

  if (property["enum"] !== undefined) {
    const options = readOptions(name, property["enum"], property["enumLabels"], problems);
    if (type !== "string") {
      problems.push(`Propriété ${quote(name)} : une énumération n'est convertible qu'en propriété de type « string ».`);
    }
    if (secret) problems.push(`Propriété ${quote(name)} : un champ secret ne peut pas être une énumération.`);
    if (property["examples"] !== undefined) {
      problems.push(`Propriété ${quote(name)} : une liste de choix n'affiche aucun exemple — retirez « examples ».`);
    }
    if (fallback !== undefined && typeof fallback !== "string") {
      problems.push(`Propriété ${quote(name)} : la valeur par défaut d'une énumération doit être un texte, reçu ${describe(fallback)}.`);
    }
    return {
      ...base,
      type: "enum",
      options,
      ...(required ? { required: true } : {}),
      ...(typeof fallback === "string" ? { default: fallback } : {}),
    };
  }

  if (type === "boolean") {
    if (secret) problems.push(`Propriété ${quote(name)} : un champ secret doit être de type « string ».`);
    if (required) {
      problems.push(`Propriété ${quote(name)} : une case à cocher ne peut pas être requise — elle vaut toujours oui ou non.`);
    }
    if (property["examples"] !== undefined) {
      problems.push(`Propriété ${quote(name)} : une case à cocher n'affiche aucun exemple — retirez « examples ».`);
    }
    if (fallback !== undefined && typeof fallback !== "boolean") {
      problems.push(`Propriété ${quote(name)} : la valeur par défaut doit être un booléen, reçu ${describe(fallback)}.`);
    }
    return { ...base, type: "boolean", ...(typeof fallback === "boolean" ? { default: fallback } : {}) };
  }

  if (type === "number") {
    if (secret) problems.push(`Propriété ${quote(name)} : un champ secret doit être de type « string ».`);
    if (fallback !== undefined && typeof fallback !== "number") {
      problems.push(`Propriété ${quote(name)} : la valeur par défaut doit être un nombre, reçu ${describe(fallback)}.`);
    }
    const min = readBound(name, property, "minimum", problems);
    const max = readBound(name, property, "maximum", problems);
    const placeholder = readPlaceholder(name, property, "number", problems);
    return {
      ...base,
      type: "number",
      ...(required ? { required: true } : {}),
      ...(typeof fallback === "number" ? { default: fallback } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
    };
  }

  if (secret) {
    if (fallback !== undefined || property["examples"] !== undefined) {
      problems.push(`Propriété ${quote(name)} : un champ secret ne porte ni valeur par défaut ni exemple.`);
    }
    return { ...base, type: "string", format: "password", ...(required ? { required: true } : {}) };
  }

  if (fallback !== undefined && typeof fallback !== "string") {
    problems.push(`Propriété ${quote(name)} : la valeur par défaut doit être un texte, reçu ${describe(fallback)}.`);
  }
  const placeholder = readPlaceholder(name, property, "string", problems);
  return {
    ...base,
    type: "string",
    ...(required ? { required: true } : {}),
    ...(typeof fallback === "string" ? { default: fallback } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
  };
}

export function formSchemaFromManifest(configSchema: unknown, secretFields: unknown): ManifestFormResult {
  if (!isRecord(configSchema)) {
    return { ok: false, problems: [`configSchema doit être un schéma JSON d'objet, reçu ${describe(configSchema)}.`] };
  }
  const properties = configSchema["properties"];
  if (configSchema["type"] !== "object" || !isRecord(properties)) {
    return {
      ok: false,
      problems: [`configSchema doit être un schéma JSON d'objet : { "type": "object", "properties": { … } }.`],
    };
  }
  const names = Object.keys(properties);
  if (names.length === 0) {
    return { ok: false, problems: ["configSchema ne déclare aucune propriété : il n'y a aucun formulaire à rendre."] };
  }

  const problems: string[] = [];
  const secrets = readSecrets(secretFields, names, problems);
  const required = readRequired(configSchema["required"], names, problems);
  if (configSchema["showIf"] !== undefined) {
    problems.push("« showIf » se porte sur une propriété, jamais sur le schéma racine.");
  }

  const fields: SchemaField[] = [];
  for (const name of names) {
    const property = properties[name];
    if (!isRecord(property)) {
      problems.push(`Propriété ${quote(name)} : ce n'est pas un objet de schéma, reçu ${describe(property)}.`);
      continue;
    }
    const field = toField(name, property, required.has(name), secrets.has(name), problems);
    if (field) fields.push(field);
  }

  // Le formulaire reste juge : ce que l'adaptateur produit doit passer SA propre validation.
  problems.push(...validateSchema({ fields }));

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, schema: { fields } };
}
