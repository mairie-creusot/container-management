import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

/**
 * Formulaire de configuration GÉNÉRÉ à partir d'un schéma déclaré par un greffon.
 * Sous-ensemble volontairement restreint : tout ce qui n'est pas listé dans validateSchema est
 * REFUSÉ explicitement plutôt que rendu à moitié. Composant autonome, encore branché nulle part.
 */

export type SchemaValue = string | number | boolean;
export type SchemaValues = Record<string, SchemaValue>;

export const SUPPORTED_FIELD_TYPES = ["string", "number", "boolean", "enum"] as const;
export type SchemaFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

export interface SchemaEnumOption {
  value: string;
  label: string;
}

/** Dépendance SIMPLE, un seul niveau : « ce champ n'apparaît que si tel autre vaut X ». */
export interface SchemaCondition {
  field: string;
  equals: string | number | boolean;
}

export interface SchemaFieldCommon {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  showIf?: SchemaCondition;
}

export interface SchemaStringField extends SchemaFieldCommon {
  type: "string";
  format?: "password";
  default?: string;
  placeholder?: string;
}

export interface SchemaNumberField extends SchemaFieldCommon {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface SchemaBooleanField extends SchemaFieldCommon {
  type: "boolean";
  default?: boolean;
}

export interface SchemaEnumField extends SchemaFieldCommon {
  type: "enum";
  options: SchemaEnumOption[];
  default?: string;
}

export type SchemaField = SchemaStringField | SchemaNumberField | SchemaBooleanField | SchemaEnumField;

export interface FormSchema {
  fields: SchemaField[];
}

/** État interne : les nombres restent des chaînes pour pouvoir être vidés. */
export type FieldState = string | boolean;
export type FormState = Record<string, FieldState>;

export const SECRET_MASK = "•••";
const KEEP_SUFFIX = " (laisser vide pour conserver l'existant)";

export function isSecretField(field: SchemaField): field is SchemaStringField {
  return field.type === "string" && field.format === "password";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(name: string): string {
  return `« ${name} »`;
}

function checkOptions(name: string, raw: Record<string, unknown>, problems: string[]): void {
  const options = raw["options"];
  if (!Array.isArray(options) || options.length === 0) {
    problems.push(`Champ ${quote(name)} : un champ « enum » doit déclarer un tableau « options » non vide.`);
    return;
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (!isRecord(option)) {
      problems.push(`Champ ${quote(name)} : chaque option doit être un objet { value, label }.`);
      return;
    }
    const value = option["value"];
    const label = option["label"];
    if (typeof value !== "string" || !value) {
      problems.push(`Champ ${quote(name)} : chaque option doit avoir une « value » texte non vide.`);
      return;
    }
    if (typeof label !== "string" || !label) {
      problems.push(`Champ ${quote(name)} : l'option ${quote(value)} n'a pas de « label » texte non vide.`);
      return;
    }
    if (seen.has(value)) {
      problems.push(`Champ ${quote(name)} : la valeur d'option ${quote(value)} est déclarée plusieurs fois.`);
      return;
    }
    seen.add(value);
  }
  const fallback = raw["default"];
  if (fallback !== undefined && (typeof fallback !== "string" || !seen.has(fallback))) {
    problems.push(`Champ ${quote(name)} : la valeur par défaut ne fait pas partie des options déclarées.`);
  }
}

function checkTyped(name: string, type: SchemaFieldType, raw: Record<string, unknown>, problems: string[]): void {
  const format = raw["format"];
  if (format !== undefined) {
    if (type !== "string") {
      problems.push(`Champ ${quote(name)} : « format » n'existe que sur un champ « string ».`);
    } else if (format !== "password") {
      problems.push(`Champ ${quote(name)} : format non supporté (seul « password » l'est).`);
    }
  }

  const fallback = raw["default"];
  if (type === "string") {
    if (format === "password" && fallback !== undefined) {
      problems.push(`Champ ${quote(name)} : un champ secret ne peut pas déclarer de valeur par défaut.`);
    } else if (fallback !== undefined && typeof fallback !== "string") {
      problems.push(`Champ ${quote(name)} : la valeur par défaut doit être un texte.`);
    }
  }
  if (type === "number") {
    if (fallback !== undefined && typeof fallback !== "number") {
      problems.push(`Champ ${quote(name)} : la valeur par défaut doit être un nombre.`);
    }
    const min = raw["min"];
    const max = raw["max"];
    if (min !== undefined && typeof min !== "number") problems.push(`Champ ${quote(name)} : « min » doit être un nombre.`);
    if (max !== undefined && typeof max !== "number") problems.push(`Champ ${quote(name)} : « max » doit être un nombre.`);
    if (typeof min === "number" && typeof max === "number" && min > max) {
      problems.push(`Champ ${quote(name)} : « min » est supérieur à « max ».`);
    }
  }
  if (type === "boolean") {
    if (fallback !== undefined && typeof fallback !== "boolean") {
      problems.push(`Champ ${quote(name)} : la valeur par défaut doit être un booléen.`);
    }
    if (raw["required"] === true) {
      problems.push(`Champ ${quote(name)} : « required » n'a pas de sens sur une case à cocher, elle vaut toujours oui ou non.`);
    }
  }
  if (type === "enum") checkOptions(name, raw, problems);
}

function checkCondition(
  name: string,
  raw: Record<string, unknown>,
  declared: Map<string, { raw: Record<string, unknown>; type: SchemaFieldType }>,
  problems: string[],
): void {
  const showIf = raw["showIf"];
  if (showIf === undefined) return;
  if (!isRecord(showIf)) {
    problems.push(`Champ ${quote(name)} : « showIf » doit être un objet { field, equals }.`);
    return;
  }
  const target = showIf["field"];
  if (typeof target !== "string" || !target) {
    problems.push(`Champ ${quote(name)} : « showIf.field » doit nommer un champ.`);
    return;
  }
  if (target === name) {
    problems.push(`Champ ${quote(name)} : « showIf » ne peut pas dépendre du champ lui-même.`);
    return;
  }
  const controller = declared.get(target);
  if (!controller) {
    problems.push(`Champ ${quote(name)} : « showIf » désigne le champ ${quote(target)}, qui n'est pas déclaré.`);
    return;
  }
  if (controller.raw["showIf"] !== undefined) {
    problems.push(
      `Champ ${quote(name)} : dépendance en chaîne non supportée — le champ ${quote(target)} est lui-même conditionnel.`,
    );
    return;
  }
  const expected = showIf["equals"];
  if (expected === undefined) {
    problems.push(`Champ ${quote(name)} : « showIf.equals » est obligatoire.`);
    return;
  }
  if (controller.type === "boolean" && typeof expected !== "boolean") {
    problems.push(`Champ ${quote(name)} : ${quote(target)} est une case à cocher, « equals » doit être un booléen.`);
    return;
  }
  if (controller.type === "number" && typeof expected !== "number") {
    problems.push(`Champ ${quote(name)} : ${quote(target)} est un nombre, « equals » doit être un nombre.`);
    return;
  }
  if ((controller.type === "string" || controller.type === "enum") && typeof expected !== "string") {
    problems.push(`Champ ${quote(name)} : ${quote(target)} est un texte, « equals » doit être un texte.`);
    return;
  }
  if (controller.type === "enum") {
    const options = controller.raw["options"];
    const values: unknown[] = Array.isArray(options)
      ? options.filter(isRecord).map((option) => option["value"])
      : [];
    if (!values.includes(expected)) {
      problems.push(
        `Champ ${quote(name)} : ${quote(String(expected))} n'est pas une option déclarée par ${quote(target)}.`,
      );
    }
  }
}

/** Liste les raisons de REFUSER le schéma. Vide = schéma entièrement supporté. */
export function validateSchema(schema: unknown): string[] {
  if (!isRecord(schema)) return ["Le schéma doit être un objet."];
  const rawFields = schema["fields"];
  if (!Array.isArray(rawFields)) return ["Le schéma doit déclarer un tableau « fields »."];
  if (rawFields.length === 0) return ["Le schéma ne déclare aucun champ."];

  const problems: string[] = [];
  const declared = new Map<string, { raw: Record<string, unknown>; type: SchemaFieldType }>();

  rawFields.forEach((raw, index) => {
    const position = `Champ n°${index + 1}`;
    if (!isRecord(raw)) {
      problems.push(`${position} : ce n'est pas un objet.`);
      return;
    }
    const name = raw["name"];
    if (typeof name !== "string" || !name.trim()) {
      problems.push(`${position} : « name » manquant ou vide.`);
      return;
    }
    if (declared.has(name)) {
      problems.push(`Champ ${quote(name)} : déclaré plusieurs fois.`);
      return;
    }
    const type = raw["type"];
    if (typeof type !== "string" || !SUPPORTED_FIELD_TYPES.includes(type as SchemaFieldType)) {
      const shown = typeof type === "string" ? quote(type) : "manquant";
      problems.push(
        `Champ ${quote(name)} : type ${shown} non supporté (types supportés : ${SUPPORTED_FIELD_TYPES.join(", ")}).`,
      );
      return;
    }
    const label = raw["label"];
    if (typeof label !== "string" || !label.trim()) {
      problems.push(`Champ ${quote(name)} : « label » manquant ou vide.`);
    }
    const help = raw["help"];
    if (help !== undefined && typeof help !== "string") {
      problems.push(`Champ ${quote(name)} : « help » doit être un texte.`);
    }
    const required = raw["required"];
    if (required !== undefined && typeof required !== "boolean") {
      problems.push(`Champ ${quote(name)} : « required » doit être un booléen.`);
    }
    declared.set(name, { raw, type: type as SchemaFieldType });
  });

  declared.forEach((entry, name) => checkTyped(name, entry.type, entry.raw, problems));
  declared.forEach((entry, name) => checkCondition(name, entry.raw, declared, problems));

  return problems;
}

/** Masque toute valeur secrète SAISIE qui se retrouverait telle quelle dans un message. */
export function redactSecrets(message: string, secretValues: readonly string[]): string {
  let out = message;
  for (const secret of secretValues) {
    const value = secret.trim();
    if (value.length < 3) continue;
    out = out.split(value).join(SECRET_MASK);
  }
  return out;
}

function buildState(fields: SchemaField[], initial: Readonly<Record<string, SchemaValue>> | undefined): FormState {
  const state: FormState = {};
  for (const field of fields) {
    const provided = initial ? initial[field.name] : undefined;
    switch (field.type) {
      case "boolean":
        state[field.name] = typeof provided === "boolean" ? provided : (field.default ?? false);
        break;
      case "number":
        state[field.name] =
          typeof provided === "number"
            ? String(provided)
            : field.default !== undefined
              ? String(field.default)
              : "";
        break;
      case "enum": {
        const known = typeof provided === "string" && field.options.some((option) => option.value === provided);
        state[field.name] = known ? (provided as string) : (field.default ?? "");
        break;
      }
      default:
        // Un secret n'est JAMAIS pré-rempli, même si le parent en fournit un.
        state[field.name] = isSecretField(field)
          ? ""
          : typeof provided === "string"
            ? provided
            : (field.default ?? "");
    }
  }
  return state;
}

function isVisible(field: SchemaField, state: FormState): boolean {
  const condition = field.showIf;
  if (!condition) return true;
  const current = state[condition.field];
  if (current === undefined) return false;
  if (typeof condition.equals === "boolean") return current === condition.equals;
  return current === String(condition.equals);
}

function textOf(state: FormState, name: string): string {
  const raw = state[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function isSatisfied(field: SchemaField, state: FormState, stored: ReadonlySet<string>): boolean {
  if (field.type === "boolean") return true;
  const text = textOf(state, field.name);
  if (isSecretField(field)) return text.length > 0 || stored.has(field.name);
  if (field.type === "number") return text.length > 0 && Number.isFinite(Number(text));
  return text.length > 0;
}

/** Un nombre saisi doit être lisible et dans les bornes déclarées, requis ou non. */
function numberProblem(field: SchemaNumberField, state: FormState): string | null {
  const text = textOf(state, field.name);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return `${quote(field.label)} : valeur numérique attendue.`;
  if (field.min !== undefined && parsed < field.min) return `${quote(field.label)} : minimum ${field.min}.`;
  if (field.max !== undefined && parsed > field.max) return `${quote(field.label)} : maximum ${field.max}.`;
  return null;
}

/** Un champ vide est OMIS : pour un secret, c'est ce qui conserve la valeur enregistrée. */
export function buildSubmission(fields: SchemaField[], state: FormState): SchemaValues {
  const values: SchemaValues = {};
  for (const field of fields) {
    if (!isVisible(field, state)) continue;
    if (field.type === "boolean") {
      values[field.name] = state[field.name] === true;
      continue;
    }
    const text = textOf(state, field.name);
    if (!text) continue;
    values[field.name] = field.type === "number" ? Number(text) : text;
  }
  return values;
}

export interface SchemaFormProps {
  schema: FormSchema;
  onSubmit: (values: SchemaValues) => void | Promise<void>;
  /** Valeurs enregistrées à réafficher — les secrets qui s'y trouveraient sont ignorés. */
  initialValues?: Readonly<Record<string, SchemaValue>>;
  /** Noms des champs secrets dont une valeur est déjà enregistrée côté serveur. */
  storedSecrets?: readonly string[];
  onValuesChange?: (values: SchemaValues) => void;
  onTest?: (values: SchemaValues) => void | Promise<void>;
  onCancel?: () => void;
  error?: string | null;
  submitting?: boolean;
  testing?: boolean;
  submitLabel?: string;
  submittingLabel?: string;
  testLabel?: string;
  testingLabel?: string;
  cancelLabel?: string;
  idPrefix?: string;
  /** Change de valeur = les champs sont reconstruits depuis `initialValues`. */
  resetKey?: string | number;
  footer?: ReactNode;
}

export default function SchemaForm({
  schema,
  onSubmit,
  initialValues,
  storedSecrets,
  onValuesChange,
  onTest,
  onCancel,
  error,
  submitting = false,
  testing = false,
  submitLabel = "Enregistrer",
  submittingLabel = "Enregistrement…",
  testLabel = "Tester la connexion",
  testingLabel = "Test en cours…",
  cancelLabel = "Annuler",
  idPrefix,
  resetKey,
  footer,
}: SchemaFormProps) {
  const autoId = useId();
  const prefix = idPrefix ?? `schema-form-${autoId}`;

  const problems = useMemo(() => validateSchema(schema), [schema]);
  const fields = useMemo<SchemaField[]>(
    () => (problems.length === 0 && Array.isArray(schema.fields) ? schema.fields : []),
    [problems, schema],
  );
  const stored = useMemo(() => new Set(storedSecrets ?? []), [storedSecrets]);

  const [state, setState] = useState<FormState>(() => buildState(fields, initialValues));
  const [appliedReset, setAppliedReset] = useState(resetKey);
  if (resetKey !== appliedReset) {
    setAppliedReset(resetKey);
    setState(buildState(fields, initialValues));
  }

  const changeRef = useRef(onValuesChange);
  changeRef.current = onValuesChange;

  if (problems.length > 0) {
    return (
      <div className="error-banner schema-form__rejected" role="alert">
        <p>Ce formulaire ne peut pas être affiché : le schéma déclaré n'est pas supporté.</p>
        <ul>
          {problems.map((problem, index) => (
            <li key={`${index}-${problem}`}>{problem}</li>
          ))}
        </ul>
      </div>
    );
  }

  function update(name: string, value: FieldState) {
    const next: FormState = { ...state, [name]: value };
    // Changer de mode ne traîne jamais le secret de l'autre mode.
    for (const field of fields) {
      if (isSecretField(field) && !isVisible(field, next)) next[field.name] = "";
    }
    setState(next);
    changeRef.current?.(buildSubmission(fields, next));
  }

  function clearSecrets() {
    const secrets = fields.filter(isSecretField);
    if (secrets.length === 0) return;
    setState((previous) => {
      const next = { ...previous };
      for (const field of secrets) next[field.name] = "";
      return next;
    });
  }

  const visible = fields.filter((field) => isVisible(field, state));
  const missing = visible.filter((field) => field.required === true && !isSatisfied(field, state, stored));
  const numberProblems = visible
    .filter((field): field is SchemaNumberField => field.type === "number")
    .map((field) => numberProblem(field, state))
    .filter((problem): problem is string => problem !== null);
  const blocked = missing.length > 0 || numberProblems.length > 0;

  const secretValues = fields
    .filter(isSecretField)
    .map((field) => textOf(state, field.name))
    .filter((value) => value.length > 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocked || submitting) return;
    let result: unknown;
    try {
      result = onSubmit(buildSubmission(fields, state));
    } catch {
      return; // La saisie est conservée : le parent affiche l'échec via `error`.
    }
    if (result instanceof Promise) {
      void result.then(clearSecrets, () => undefined);
      return;
    }
    clearSecrets();
  }

  function handleTest() {
    if (blocked || submitting || testing || !onTest) return;
    const result: unknown = onTest(buildSubmission(fields, state));
    if (result instanceof Promise) void result.catch(() => undefined);
  }

  function renderField(field: SchemaField) {
    const id = `${prefix}-${field.name}`;
    const raw = state[field.name];
    const help = field.help ? <span className="create-container-hint">{field.help}</span> : null;

    if (field.type === "boolean") {
      return (
        <label className="schema-form__checkbox" htmlFor={id} key={field.name}>
          <input
            id={id}
            type="checkbox"
            checked={raw === true}
            onChange={(event) => update(field.name, event.target.checked)}
            disabled={submitting}
          />
          <span>
            {field.label}
            {help}
          </span>
        </label>
      );
    }

    const value = typeof raw === "string" ? raw : "";
    const secret = isSecretField(field);
    const keeps = secret && stored.has(field.name);
    const mustFill = field.required === true && !keeps;

    return (
      <div className="field" key={field.name}>
        <label htmlFor={id}>
          {field.label}
          {keeps ? KEEP_SUFFIX : ""}
        </label>
        {field.type === "enum" ? (
          <select
            id={id}
            value={value}
            onChange={(event) => update(field.name, event.target.value)}
            disabled={submitting}
            {...(mustFill ? { required: true } : {})}
          >
            {field.default === undefined && <option value="">— Choisir —</option>}
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            value={value}
            onChange={(event) => update(field.name, event.target.value)}
            disabled={submitting}
            {...(field.type === "number"
              ? {
                  type: "number",
                  ...(field.min !== undefined ? { min: field.min } : {}),
                  ...(field.max !== undefined ? { max: field.max } : {}),
                }
              : {})}
            {...(secret ? { type: "password", autoComplete: "new-password" } : {})}
            {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
            {...(mustFill ? { required: true } : {})}
          />
        )}
        {help}
      </div>
    );
  }

  const hasVisibleSecret = visible.some(isSecretField);
  const hasKeptSecret = visible.some((field) => isSecretField(field) && stored.has(field.name));

  return (
    <form className="card schema-form" onSubmit={handleSubmit} noValidate>
      {error && (
        <div className="error-banner" role="alert">
          {redactSecrets(error, secretValues)}
        </div>
      )}

      {visible.map(renderField)}

      {hasVisibleSecret && (
        <p className="create-container-hint">
          {hasKeptSecret
            ? "Les secrets sont stockés chiffrés et ne sont jamais réaffichés : laissez un champ secret vide pour conserver la valeur enregistrée."
            : "Les secrets sont stockés chiffrés et ne sont jamais réaffichés, même tronqués."}
        </p>
      )}

      {footer}

      {missing.length > 0 && (
        <p className="create-container-hint">
          Champs à renseigner avant d'enregistrer : {missing.map((field) => field.label).join(", ")}.
        </p>
      )}
      {numberProblems.map((problem, index) => (
        <p className="create-container-hint" key={`${index}-${problem}`}>
          {problem}
        </p>
      ))}

      <div className="schema-form__actions">
        <button type="submit" className="btn btn-primary" disabled={submitting || blocked}>
          {submitting ? submittingLabel : submitLabel}
        </button>
        {onTest && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleTest}
            disabled={submitting || testing || blocked}
          >
            {testing ? testingLabel : testLabel}
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  );
}
