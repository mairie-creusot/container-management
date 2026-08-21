// Contrat de colonnes + logique pure de tri/pagination du DataTable (aucun rendu ici).
import type { ReactNode } from "react";
import {
  normalizeSearchText,
  toComparableNumber,
  type SearchFieldKind,
  type SearchFieldSpec,
  type SearchFieldValue,
  type SearchableRecord,
} from "@/components/searchQuery";

export type DataTableAlign = "left" | "center" | "right";

export interface DataTableColumn<T> {
  /** Clé technique : identifie la colonne ET le nom filtrable dans `champ:valeur`. */
  key: string;
  label: string;
  accessor: (row: T) => unknown;
  render?: (row: T) => ReactNode;
  /** Défaut : true. */
  sortable?: boolean;
  align?: DataTableAlign;
  /** Défaut : "text". "number"/"date" activent `>` et `<`, "boolean" accepte oui/non. */
  kind?: SearchFieldKind;
  /** Participe à la recherche en texte libre — défaut true. */
  searchable?: boolean;
  /** Exposée comme `champ:` dans l'aide et les suggestions — défaut true. */
  filterable?: boolean;
  /** Autres noms acceptés devant les deux-points (ex. "ext" pour "extension"). */
  aliases?: string[];
  /** Valeurs proposées en complétion après `champ:`. */
  values?: string[];
  hint?: string;
  className?: string;
  width?: string;
}

export type SortDirection = "asc" | "desc";

export interface DataTableSort {
  key: string;
  direction: SortDirection;
}

/** Cycle au clic sur un en-tête : aucun tri -> ascendant -> descendant -> aucun tri. */
export function nextSort(current: DataTableSort | null, key: string): DataTableSort | null {
  if (!current || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

export function compareCellValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();

  const numA = toComparableNumber(a);
  const numB = toComparableNumber(b);
  if (numA !== null && numB !== null && numA !== numB) return numA - numB;

  return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });
}

/** Tri stable ; les valeurs vides restent en fin de liste dans les deux sens. */
export function sortRows<T>(
  rows: T[],
  sort: DataTableSort | null,
  accessor: (row: T, key: string) => unknown,
): T[] {
  if (!sort) return rows;
  const factor = sort.direction === "desc" ? -1 : 1;
  return rows.slice().sort((left, right) => {
    const a = accessor(left, sort.key);
    const b = accessor(right, sort.key);
    const emptyA = isEmptyValue(a);
    const emptyB = isEmptyValue(b);
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    return compareCellValues(a, b) * factor;
  });
}

export type DataTablePageSize = number | "all";

export const DATA_TABLE_PAGE_SIZES: DataTablePageSize[] = [25, 50, 100, "all"];

export interface DataTablePageWindow {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  firstItem: number;
  lastItem: number;
  totalItems: number;
  pageSize: DataTablePageSize;
}

export function parsePageSize(raw: string | number | null | undefined): DataTablePageSize | null {
  if (raw === null || raw === undefined) return null;
  if (raw === "all") return "all";
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** Borne toujours la page dans [1, totalPages] : une page devenue hors limites après filtrage
 *  retombe sur la dernière page existante au lieu de renvoyer une fenêtre vide. */
export function computePageWindow(
  totalItems: number,
  pageSize: DataTablePageSize,
  requestedPage: number,
): DataTablePageWindow {
  const total = Number.isFinite(totalItems) && totalItems > 0 ? Math.floor(totalItems) : 0;
  const size = pageSize === "all" || !Number.isFinite(pageSize) || pageSize <= 0 ? "all" : Math.floor(pageSize);
  const totalPages = size === "all" ? 1 : Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(requested, 1), totalPages);
  const startIndex = size === "all" ? 0 : (page - 1) * size;
  const endIndex = size === "all" ? total : Math.min(startIndex + size, total);

  return {
    page,
    totalPages,
    startIndex,
    endIndex,
    firstItem: total === 0 ? 0 : startIndex + 1,
    lastItem: endIndex,
    totalItems: total,
    pageSize: size,
  };
}

export function slicePage<T>(rows: T[], window: DataTablePageWindow): T[] {
  return rows.slice(window.startIndex, window.endIndex);
}

export function pageSizeLabel(size: DataTablePageSize): string {
  return size === "all" ? "Tout" : String(size);
}

/** Spécifications de recherche dérivées des colonnes déclarées — jamais écrites à la main. */
export function searchFieldsFromColumns<T>(columns: DataTableColumn<T>[]): SearchFieldSpec[] {
  const specs: SearchFieldSpec[] = [];
  for (const column of columns) {
    if (column.filterable === false) continue;
    const spec: SearchFieldSpec = {
      key: column.key,
      label: column.label,
      kind: column.kind ?? "text",
    };
    if (column.aliases) spec.aliases = column.aliases;
    if (column.values) spec.values = column.values;
    if (column.hint) spec.hint = column.hint;
    specs.push(spec);
  }
  return specs;
}

function toFieldValue(raw: unknown, kind: SearchFieldKind): SearchFieldValue {
  if (typeof raw === "boolean") {
    return { text: raw ? "oui" : "non", number: raw ? 1 : 0, boolean: raw };
  }
  if (raw === null || raw === undefined) {
    return { text: "", number: null, boolean: null };
  }
  const text = raw instanceof Date ? raw.toISOString() : String(raw);
  const number = kind === "text" ? null : toComparableNumber(raw);
  return { text: normalizeSearchText(text), number, boolean: null };
}

/** Projection d'une ligne en enregistrement cherchable (valeurs normalisées, une seule fois). */
export function toSearchableRecord<T>(row: T, columns: DataTableColumn<T>[]): SearchableRecord {
  const fields: Record<string, SearchFieldValue> = {};
  const freeText: string[] = [];
  for (const column of columns) {
    const raw = column.accessor(row);
    const value = toFieldValue(raw, column.kind ?? "text");
    if (column.filterable !== false) fields[column.key] = value;
    if (column.searchable !== false && value.text !== "") freeText.push(value.text);
  }
  return { fields, text: freeText.join(" ") };
}
