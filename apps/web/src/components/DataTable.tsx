import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { IconChevron, IconClose, IconInfo, IconSearch } from "@/components/icons";
import { SkeletonTable } from "@/components/Skeleton";
import {
  computePageWindow,
  DATA_TABLE_PAGE_SIZES,
  nextSort,
  pageSizeLabel,
  parsePageSize,
  searchFieldsFromColumns,
  slicePage,
  sortRows,
  toSearchableRecord,
  type DataTableColumn,
  type DataTablePageSize,
  type DataTableSort,
} from "@/components/dataTableModel";
import {
  applySuggestion,
  matchesSearchQuery,
  parseSearchQuery,
  suggestCompletions,
} from "@/components/searchQuery";

export type {
  DataTableAlign,
  DataTableColumn,
  DataTablePageSize,
  DataTableSort,
  SortDirection,
} from "@/components/dataTableModel";

export interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string;

  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;

  searchable?: boolean | undefined;
  searchPlaceholder?: string | undefined;
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;

  sort?: DataTableSort | null | undefined;
  defaultSort?: DataTableSort | null | undefined;
  onSortChange?: ((sort: DataTableSort | null) => void) | undefined;

  defaultPageSize?: DataTablePageSize | undefined;
  /** Mémorise la taille de page choisie (localStorage) — une clé stable par tableau. */
  storageKey?: string | undefined;

  onRowClick?: ((row: T) => void) | undefined;
  isRowSelected?: ((row: T) => boolean) | undefined;
  rowClassName?: ((row: T) => string | undefined) | undefined;

  emptyLabel?: string | undefined;
  noResultsLabel?: string | undefined;
  itemsLabel?: string | undefined;
  toolbarExtra?: ReactNode | undefined;
  minWidth?: number | undefined;
}

const STORAGE_PREFIX = "quai.datatable.";

function readStoredPageSize(storageKey: string | undefined): DataTablePageSize | null {
  if (!storageKey) return null;
  try {
    return parsePageSize(globalThis.localStorage?.getItem(STORAGE_PREFIX + storageKey) ?? null);
  } catch {
    return null;
  }
}

function writeStoredPageSize(storageKey: string | undefined, size: DataTablePageSize): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + storageKey, String(size));
  } catch {
    /* stockage indisponible (mode privé, quota) : la taille reste simplement volatile */
  }
}

function defaultCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (value instanceof Date) return value.toLocaleString("fr-FR");
  return String(value);
}

function IconChevronEnd({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 6l6 6-6 6" />
      <path d="M17 6v12" />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  text: "texte",
  number: "nombre",
  boolean: "oui / non",
  date: "date",
};

export default function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  searchable = true,
  searchPlaceholder = "Rechercher…  (ex : statut:actif -test)",
  query: controlledQuery,
  onQueryChange,
  sort: controlledSort,
  defaultSort = null,
  onSortChange,
  defaultPageSize = 25,
  storageKey,
  onRowClick,
  isRowSelected,
  rowClassName,
  emptyLabel = "Aucune donnée à afficher.",
  noResultsLabel = "Aucun résultat pour cette recherche.",
  itemsLabel = "résultats",
  toolbarExtra,
  minWidth,
}: DataTableProps<T>) {
  const [innerQuery, setInnerQuery] = useState("");
  const [innerSort, setInnerSort] = useState<DataTableSort | null>(defaultSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<DataTablePageSize>(
    () => readStoredPageSize(storageKey) ?? defaultPageSize,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const query = controlledQuery ?? innerQuery;
  const sort = controlledSort !== undefined ? controlledSort : innerSort;

  function updateQuery(next: string) {
    if (controlledQuery === undefined) setInnerQuery(next);
    onQueryChange?.(next);
  }

  function updateSort(next: DataTableSort | null) {
    if (controlledSort === undefined) setInnerSort(next);
    onSortChange?.(next);
  }

  function updatePageSize(next: DataTablePageSize) {
    setPageSizeState(next);
    setPage(1);
    writeStoredPageSize(storageKey, next);
  }

  const columnByKey = useMemo(() => {
    const map = new Map<string, DataTableColumn<T>>();
    for (const column of columns) map.set(column.key, column);
    return map;
  }, [columns]);

  const searchFields = useMemo(() => searchFieldsFromColumns(columns), [columns]);
  const parsed = useMemo(() => parseSearchQuery(query, searchFields), [query, searchFields]);

  const records = useMemo(
    () => rows.map((row) => ({ row, record: toSearchableRecord(row, columns) })),
    [rows, columns],
  );

  const filtered = useMemo(() => {
    if (parsed.isEmpty) return rows;
    return records.filter((entry) => matchesSearchQuery(parsed, entry.record)).map((entry) => entry.row);
  }, [rows, records, parsed]);

  const sorted = useMemo(
    () => sortRows(filtered, sort, (row, key) => columnByKey.get(key)?.accessor(row)),
    [filtered, sort, columnByKey],
  );

  // Le tri et la page survivent à un rafraîchissement des données (liste re-pollée) : seule une
  // modification de la recherche ramène à la première page.
  useEffect(() => {
    setPage(1);
  }, [query]);

  const pageWindow = computePageWindow(sorted.length, pageSize, page);
  const pageRows = slicePage(sorted, pageWindow);

  const suggestions = useMemo(
    () => (suggestOpen && searchable ? suggestCompletions(query, searchFields) : []),
    [suggestOpen, searchable, query, searchFields],
  );

  useEffect(() => {
    setSuggestIndex(0);
  }, [query]);

  useEffect(() => {
    if (!searchable) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchable]);

  function acceptSuggestion(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    updateQuery(applySuggestion(query, suggestion));
    inputRef.current?.focus();
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (suggestOpen && suggestions.length > 0) setSuggestOpen(false);
      else if (query !== "") updateQuery("");
      else inputRef.current?.blur();
      return;
    }
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      acceptSuggestion(suggestIndex);
    }
  }

  const isFiltered = !parsed.isEmpty;
  const showTable = !error && pageRows.length > 0;
  const showSkeleton = !error && loading && rows.length === 0;
  const showEmpty = !error && !loading && rows.length === 0;
  const showNoResults = !error && rows.length > 0 && sorted.length === 0;

  return (
    <div className={`dt${loading && rows.length > 0 ? " dt--refreshing" : ""}`}>
      {(searchable || toolbarExtra) && (
        <div className="dt__toolbar">
          {searchable && (
            <div className="dt__search">
              <IconSearch className="dt__search-icon" />
              <input
                ref={inputRef}
                type="text"
                className="dt__search-input"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => {
                  updateQuery(event.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => setSuggestOpen(false)}
                onKeyDown={handleSearchKeyDown}
                role="combobox"
                aria-expanded={suggestions.length > 0}
                aria-controls={`${baseId}-suggestions`}
                aria-autocomplete="list"
                aria-label="Recherche avancée"
              />
              {query === "" ? (
                <kbd className="dt__kbd" title="Raccourci : appuyez sur / pour rechercher">
                  /
                </kbd>
              ) : (
                <button
                  type="button"
                  className="dt__search-clear"
                  aria-label="Effacer la recherche"
                  onClick={() => {
                    updateQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  <IconClose />
                </button>
              )}

              {suggestions.length > 0 && (
                <ul className="dt__suggestions" id={`${baseId}-suggestions`} role="listbox">
                  {suggestions.map((suggestion, index) => (
                    <li key={suggestion.insert}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === suggestIndex}
                        className={`dt__suggestion${index === suggestIndex ? " is-active" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setSuggestIndex(index)}
                        onClick={() => acceptSuggestion(index)}
                      >
                        <span className="dt__suggestion-insert">{suggestion.label}</span>
                        <span className="dt__suggestion-hint">{suggestion.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {searchable && searchFields.length > 0 && (
            <button
              type="button"
              className={`dt__help-toggle${helpOpen ? " is-active" : ""}`}
              onClick={() => setHelpOpen((open) => !open)}
              aria-expanded={helpOpen}
              aria-controls={`${baseId}-help`}
            >
              <IconInfo />
              Aide
            </button>
          )}

          {toolbarExtra}
        </div>
      )}

      {searchable && helpOpen && (
        <div className="dt__help" id={`${baseId}-help`}>
          <div className="dt__help-block">
            <div className="dt__help-title">Champs filtrables</div>
            <div className="dt__help-fields">
              {searchFields.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  className="dt__help-field"
                  onClick={() => {
                    updateQuery(`${query.replace(/\s*$/, "")} ${field.key}:`.trimStart());
                    inputRef.current?.focus();
                  }}
                  title={field.hint ?? `Filtrer sur « ${field.label} »`}
                >
                  <code>{field.key}:</code>
                  <span>
                    {field.label} · {KIND_LABEL[field.kind] ?? field.kind}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="dt__help-block">
            <div className="dt__help-title">Opérateurs</div>
            <ul className="dt__help-ops">
              <li>
                <code>champ:valeur</code> filtre sur une colonne
              </li>
              <li>
                <code>-terme</code> exclut le terme (ou <code>-champ:valeur</code>)
              </li>
              <li>
                <code>&quot;deux mots&quot;</code> expression exacte ; après un champ, égalité stricte
              </li>
              <li>
                <code>champ:&gt;10</code> <code>champ:&lt;10</code> comparent les colonnes numériques
                (<code>&gt;=</code> et <code>&lt;=</code> acceptés)
              </li>
              <li>Plusieurs critères se cumulent (ET). Accents et casse sont ignorés.</li>
            </ul>
          </div>
        </div>
      )}

      {parsed.unknownFields.length > 0 && (
        <div className="dt__notice">
          {parsed.unknownFields.length > 1 ? "Champs inconnus ignorés" : "Champ inconnu ignoré"} :{" "}
          {parsed.unknownFields.map((field, index) => (
            <span key={field}>
              {index > 0 && ", "}
              <code>{field}</code>
            </span>
          ))}{" "}
          — la valeur est cherchée en texte libre.
        </div>
      )}

      {(isFiltered || sorted.length > 0) && !error && (
        <div className="dt__count" aria-live="polite">
          {isFiltered
            ? `${sorted.length} ${itemsLabel} sur ${rows.length}`
            : `${sorted.length} ${itemsLabel}`}
        </div>
      )}

      {error && (
        <div className="error-banner dt__error">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              Réessayer
            </button>
          )}
        </div>
      )}

      {showSkeleton && <SkeletonTable columns={columns.map((column) => column.label)} rows={8} />}

      {showEmpty && <div className="empty-state">{emptyLabel}</div>}

      {showNoResults && (
        <div className="empty-state">
          <span>{noResultsLabel}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => updateQuery("")}>
            Effacer la recherche
          </button>
        </div>
      )}

      {showTable && (
        <div className="data-table-wrap">
          <table
            className={`data-table dt__table${onRowClick ? "" : " dt__table--static"}`}
            style={minWidth ? { minWidth } : undefined}
            aria-busy={loading}
          >
            <thead>
              <tr>
                {columns.map((column) => {
                  const sortable = column.sortable !== false;
                  const active = sort?.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      className={`dt__th dt__th--${column.align ?? "left"}${active ? " is-sorted" : ""}`}
                      style={column.width ? { width: column.width } : undefined}
                      aria-sort={active ? (sort?.direction === "desc" ? "descending" : "ascending") : "none"}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="dt__sort"
                          onClick={() => updateSort(nextSort(sort, column.key))}
                          title={`Trier par ${column.label}`}
                        >
                          <span>{column.label}</span>
                          <span className={`dt__sort-arrow${active ? ` is-${sort?.direction}` : ""}`}>
                            <IconChevron />
                          </span>
                        </button>
                      ) : (
                        <span className="dt__label">{column.label}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const extra = rowClassName?.(row);
                const selected = isRowSelected?.(row) ?? false;
                return (
                  <tr
                    key={rowKey(row)}
                    className={`${selected ? "is-selected" : ""}${extra ? ` ${extra}` : ""}`}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`dt__td--${column.align ?? "left"}${column.className ? ` ${column.className}` : ""}`}
                      >
                        {column.render ? column.render(row) : defaultCell(column.accessor(row))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showTable && (
        <div className="dt__footer">
          <span className="dt__range">
            {pageWindow.firstItem}–{pageWindow.lastItem} sur {pageWindow.totalItems}
          </span>

          <div className="dt__pager">
            <button
              type="button"
              className="icon-btn"
              disabled={pageWindow.page <= 1}
              onClick={() => setPage(1)}
              aria-label="Première page"
            >
              <IconChevronEnd className="dt__chevron--flip" />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={pageWindow.page <= 1}
              onClick={() => setPage(pageWindow.page - 1)}
              aria-label="Page précédente"
            >
              <IconChevron className="dt__chevron--flip" />
            </button>
            <span className="dt__page">
              Page {pageWindow.page} / {pageWindow.totalPages}
            </span>
            <button
              type="button"
              className="icon-btn"
              disabled={pageWindow.page >= pageWindow.totalPages}
              onClick={() => setPage(pageWindow.page + 1)}
              aria-label="Page suivante"
            >
              <IconChevron />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={pageWindow.page >= pageWindow.totalPages}
              onClick={() => setPage(pageWindow.totalPages)}
              aria-label="Dernière page"
            >
              <IconChevronEnd />
            </button>
          </div>

          <label className="dt__size">
            <span className="dt__size-label">Par page</span>
            <select
              className="pagination__size"
              value={String(pageSize)}
              onChange={(event) => updatePageSize(parsePageSize(event.target.value) ?? 25)}
              aria-label="Nombre de lignes par page"
            >
              {DATA_TABLE_PAGE_SIZES.map((size) => (
                <option key={String(size)} value={String(size)}>
                  {pageSizeLabel(size)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
