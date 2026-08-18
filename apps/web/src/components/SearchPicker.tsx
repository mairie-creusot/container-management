import { useEffect, useRef, useState, type ReactNode } from "react";

export type SearchPickerOutcome<T> = { state: "ok"; results: T[] } | { state: "unavailable" };

interface SearchPickerProps<T> {
  id: string;
  label: ReactNode;
  placeholder: string;
  busy?: boolean | undefined;
  /** Relance la recherche quand cette clé change (ex : distro), en plus de la saisie. */
  searchKey?: string | undefined;
  search: (q: string) => Promise<SearchPickerOutcome<T>>;
  keyOf: (item: T) => string;
  isItemDisabled?: ((item: T) => boolean) | undefined;
  onPick: (item: T) => void;
  renderItem: (item: T) => ReactNode;
  emptyMessage: (q: string) => ReactNode;
  unavailableMessage: ReactNode;
  listAriaLabel: string;
}

/** Combobox de recherche serveur générique (paquets, images Docker Hub…) : debounce 400 ms dès
 * 2 caractères, navigation clavier (flèches + Entrée, Échap efface), échec amont = message
 * discret — jamais de fausse liste, la saisie libre du parent reste le repli. */
export default function SearchPicker<T>({
  id,
  label,
  placeholder,
  busy,
  searchKey,
  search,
  keyOf,
  isItemDisabled,
  onPick,
  renderItem,
  emptyMessage,
  unavailableMessage,
  listAriaLabel,
}: SearchPickerProps<T>) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [highlight, setHighlight] = useState(-1);
  const seqRef = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const q = query.trim();
    seqRef.current += 1;
    if (q.length < 2) {
      setItems([]);
      setStatus("idle");
      setHighlight(-1);
      return;
    }
    const seq = seqRef.current;
    setStatus("loading");
    const timer = setTimeout(() => {
      void searchRef.current(q).then((result) => {
        if (seqRef.current !== seq) return;
        if (result.state === "unavailable") {
          setItems([]);
          setStatus("unavailable");
          setHighlight(-1);
          return;
        }
        setItems(result.results);
        setStatus("ready");
        setHighlight(result.results.length > 0 ? 0 : -1);
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [query, searchKey]);

  const open = status === "ready" && items.length > 0;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="search-picker">
        <input
          id={id}
          type="text"
          className="cell-mono"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-results`}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const item = open && highlight >= 0 ? items[highlight] : undefined;
              if (item && !(isItemDisabled?.(item) ?? false)) onPick(item);
              return;
            }
            if (!open) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % items.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + items.length) % items.length);
            } else if (e.key === "Escape" && query !== "") {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={placeholder}
          disabled={busy}
        />
        {status === "loading" && (
          <span className="search-picker__loading" aria-label="Recherche en cours">
            …
          </span>
        )}
      </div>
      {status === "unavailable" && <p className="template-modal__hint">{unavailableMessage}</p>}
      {status === "ready" && items.length === 0 && <p className="template-modal__hint">{emptyMessage(query.trim())}</p>}
      {open && (
        <ul className="search-picker__results" id={`${id}-results`} role="listbox" aria-label={listAriaLabel}>
          {items.map((item, i) => (
            <li key={keyOf(item)}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`search-picker__item${i === highlight ? " is-highlighted" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => onPick(item)}
                disabled={busy || (isItemDisabled?.(item) ?? false)}
              >
                {renderItem(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
