// Analyse de la barre de recherche avancée : fonctions pures, aucun couplage au rendu.

export type SearchFieldKind = "text" | "number" | "boolean" | "date";

export interface SearchFieldSpec {
  key: string;
  label: string;
  kind: SearchFieldKind;
  aliases?: string[];
  values?: string[];
  hint?: string;
}

export type SearchOperator = ":" | ">" | "<" | ">=" | "<=";

export interface SearchTextNode {
  kind: "text";
  value: string;
  raw: string;
  phrase: boolean;
  negated: boolean;
}

export interface SearchFieldNode {
  kind: "field";
  field: string;
  operator: SearchOperator;
  value: string;
  raw: string;
  exact: boolean;
  negated: boolean;
  number: number | null;
}

export type SearchNode = SearchTextNode | SearchFieldNode;

/** Jeton en cours de frappe en fin de requête — pilote les suggestions de complétion. */
export interface SearchPending {
  field: string | null;
  prefix: string;
}

export interface ParsedSearchQuery {
  nodes: SearchNode[];
  unknownFields: string[];
  pending: SearchPending | null;
  isEmpty: boolean;
}

export interface SearchFieldValue {
  text: string;
  number: number | null;
  boolean: boolean | null;
}

export interface SearchableRecord {
  fields: Record<string, SearchFieldValue>;
  text: string;
}

const TRUTHY = new Set(["oui", "yes", "true", "vrai", "1", "actif", "on"]);
const FALSY = new Set(["non", "no", "false", "faux", "0", "inactif", "off"]);

const NUMERIC_RE = /^[+-]?\d+(?:[.,]\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

const COMBINING_MARKS = /\p{M}/gu;

/** Minuscules + suppression des diacritiques : « Numéro » et « numero » se valent. */
export function normalizeSearchText(input: string): string {
  return input.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().trim();
}

export function parseBooleanToken(value: string): boolean | null {
  const normalized = normalizeSearchText(value);
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return null;
}

/** Nombre comparable pour `>`/`<` : numérique brut, sinon date ISO convertie en horodatage. */
export function toComparableNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (raw instanceof Date) {
    const time = raw.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (NUMERIC_RE.test(trimmed)) {
    const parsed = Number(trimmed.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (ISO_DATE_RE.test(trimmed)) {
    const time = Date.parse(trimmed);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

interface RawToken {
  raw: string;
  text: string;
  quoted: boolean[];
  hadQuote: boolean;
}

function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let raw = "";
  let text = "";
  let quoted: boolean[] = [];
  let hadQuote = false;
  let inQuote = false;

  function flush() {
    if (raw.length === 0) return;
    tokens.push({ raw, text, quoted, hadQuote });
    raw = "";
    text = "";
    quoted = [];
    hadQuote = false;
  }

  for (const char of input) {
    if (char === '"') {
      hadQuote = true;
      inQuote = !inQuote;
      raw += char;
      continue;
    }
    if (!inQuote && /\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    text += char;
    quoted.push(inQuote);
  }
  flush();
  return tokens;
}

function buildFieldIndex(fields: SearchFieldSpec[]): Map<string, SearchFieldSpec> {
  const index = new Map<string, SearchFieldSpec>();
  const add = (name: string, spec: SearchFieldSpec) => {
    const key = normalizeSearchText(name);
    if (key !== "" && !index.has(key)) index.set(key, spec);
  };
  for (const spec of fields) add(spec.key, spec);
  for (const spec of fields) for (const alias of spec.aliases ?? []) add(alias, spec);
  for (const spec of fields) add(spec.label, spec);
  return index;
}

function unquotedIndexOf(token: { text: string; quoted: boolean[] }, char: string): number {
  for (let i = 0; i < token.text.length; i += 1) {
    if (token.text[i] === char && token.quoted[i] !== true) return i;
  }
  return -1;
}

interface SplitToken {
  negated: boolean;
  fieldName: string | null;
  operator: SearchOperator;
  value: string;
  valueExact: boolean;
  hadQuote: boolean;
}

/** Découpe un jeton brut en `-` / `champ` / opérateur / valeur, sans jamais lever d'exception. */
function splitToken(token: RawToken): SplitToken {
  let text = token.text;
  let quoted = token.quoted;
  let negated = false;

  if (text.length > 1 && text[0] === "-" && quoted[0] !== true) {
    negated = true;
    text = text.slice(1);
    quoted = quoted.slice(1);
  }

  const colon = unquotedIndexOf({ text, quoted }, ":");
  if (colon <= 0) {
    return {
      negated,
      fieldName: null,
      operator: ":",
      value: text,
      valueExact: text.length > 0 && quoted.every((flag) => flag),
      hadQuote: token.hadQuote,
    };
  }

  const fieldQuoted = quoted.slice(0, colon).some((flag) => flag);
  if (fieldQuoted) {
    return {
      negated,
      fieldName: null,
      operator: ":",
      value: text,
      valueExact: false,
      hadQuote: token.hadQuote,
    };
  }

  const fieldName = text.slice(0, colon);
  let value = text.slice(colon + 1);
  let valueQuoted = quoted.slice(colon + 1);
  let operator: SearchOperator = ":";

  for (const candidate of [">=", "<=", ">", "<"] as const) {
    if (!value.startsWith(candidate)) continue;
    if (valueQuoted.slice(0, candidate.length).some((flag) => flag)) continue;
    operator = candidate;
    value = value.slice(candidate.length);
    valueQuoted = valueQuoted.slice(candidate.length);
    break;
  }

  return {
    negated,
    fieldName,
    operator,
    value,
    valueExact: value.length > 0 && valueQuoted.every((flag) => flag),
    hadQuote: token.hadQuote,
  };
}

export function parseSearchQuery(input: string, fields: SearchFieldSpec[] = []): ParsedSearchQuery {
  const index = buildFieldIndex(fields);
  const tokens = tokenize(input ?? "");
  const nodes: SearchNode[] = [];
  const unknownFields: string[] = [];

  for (const token of tokens) {
    const split = splitToken(token);

    if (split.fieldName === null) {
      const value = normalizeSearchText(split.value);
      if (value === "") continue;
      nodes.push({
        kind: "text",
        value,
        raw: token.raw,
        phrase: token.hadQuote,
        negated: split.negated,
      });
      continue;
    }

    const spec = index.get(normalizeSearchText(split.fieldName));
    const value = normalizeSearchText(split.value);

    if (!spec) {
      if (!unknownFields.includes(split.fieldName)) unknownFields.push(split.fieldName);
      if (value === "") continue;
      // Champ inconnu : la valeur retombe en recherche libre plutôt que de vider le tableau.
      nodes.push({ kind: "text", value, raw: token.raw, phrase: false, negated: split.negated });
      continue;
    }

    if (value === "") continue;

    nodes.push({
      kind: "field",
      field: spec.key,
      operator: split.operator,
      value,
      raw: token.raw,
      exact: split.valueExact,
      negated: split.negated,
      number: toComparableNumber(split.value),
    });
  }

  return {
    nodes,
    unknownFields,
    pending: computePending(input ?? "", tokens, index),
    isEmpty: nodes.length === 0,
  };
}

function computePending(
  input: string,
  tokens: RawToken[],
  index: Map<string, SearchFieldSpec>,
): SearchPending | null {
  if (input === "" || /\s$/.test(input)) return null;
  const last = tokens[tokens.length - 1];
  if (!last) return null;

  const split = splitToken(last);
  if (split.fieldName === null) {
    return { field: null, prefix: normalizeSearchText(split.value) };
  }
  const spec = index.get(normalizeSearchText(split.fieldName));
  if (!spec) return { field: null, prefix: normalizeSearchText(split.fieldName) };
  return { field: spec.key, prefix: normalizeSearchText(split.value) };
}

function matchFieldNode(value: SearchFieldValue, node: SearchFieldNode): boolean {
  if (node.operator !== ":") {
    if (value.number === null || node.number === null) return false;
    if (node.operator === ">") return value.number > node.number;
    if (node.operator === ">=") return value.number >= node.number;
    if (node.operator === "<") return value.number < node.number;
    return value.number <= node.number;
  }
  if (value.boolean !== null) {
    const asBoolean = parseBooleanToken(node.value);
    if (asBoolean !== null) return value.boolean === asBoolean;
  }
  if (node.exact) return value.text === node.value;
  return value.text.includes(node.value);
}

export function matchesSearchQuery(parsed: ParsedSearchQuery, record: SearchableRecord): boolean {
  for (const node of parsed.nodes) {
    let hit: boolean;
    if (node.kind === "text") {
      hit = record.text.includes(node.value);
    } else {
      const value = record.fields[node.field];
      hit = value ? matchFieldNode(value, node) : false;
    }
    if (node.negated ? hit : !hit) return false;
  }
  return true;
}

export interface SearchSuggestion {
  insert: string;
  label: string;
  hint: string;
  appendSpace: boolean;
}

const BOOLEAN_SUGGESTIONS = ["oui", "non"];

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Suggestions déduites des colonnes déclarées — jamais de liste de champs codée en dur. */
export function suggestCompletions(
  input: string,
  fields: SearchFieldSpec[],
  limit = 8,
): SearchSuggestion[] {
  const parsed = parseSearchQuery(input, fields);
  const pending = parsed.pending;
  if (!pending) return [];

  if (pending.field !== null) {
    const spec = fields.find((field) => field.key === pending.field);
    if (!spec) return [];
    const values = spec.kind === "boolean" ? BOOLEAN_SUGGESTIONS : spec.values ?? [];
    return values
      .filter((value) => normalizeSearchText(value).startsWith(pending.prefix))
      .slice(0, limit)
      .map((value) => ({
        insert: `${spec.key}:${quoteIfNeeded(value)}`,
        label: `${spec.key}:${value}`,
        hint: spec.label,
        appendSpace: true,
      }));
  }

  return fields
    .filter((field) => {
      if (pending.prefix === "") return true;
      const names = [field.key, field.label, ...(field.aliases ?? [])];
      return names.some((name) => normalizeSearchText(name).startsWith(pending.prefix));
    })
    .slice(0, limit)
    .map((field) => ({
      insert: `${field.key}:`,
      label: `${field.key}:`,
      hint: field.label,
      appendSpace: false,
    }));
}

/** Remplace le jeton en cours de frappe par la suggestion retenue. */
export function applySuggestion(input: string, suggestion: SearchSuggestion): string {
  const match = /\s*\S*$/.exec(input);
  const head = match && match.index > 0 ? `${input.slice(0, match.index)} ` : "";
  return `${head}${suggestion.insert}${suggestion.appendSpace ? " " : ""}`;
}
