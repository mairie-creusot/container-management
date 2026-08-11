import { IconChevron } from "@/components/icons";

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZES = [10, 25, 50, 100];

export default function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  if (totalItems === 0) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="pagination">
      <span className="pagination__summary">
        {start}–{end} sur {totalItems}
      </span>

      <div className="pagination__controls">
        <button
          type="button"
          className="icon-btn"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Page précédente"
        >
          <IconChevron className="pagination__chevron pagination__chevron--prev" />
        </button>
        <span className="pagination__page">
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          className="icon-btn"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Page suivante"
        >
          <IconChevron className="pagination__chevron" />
        </button>
      </div>

      <select
        className="pagination__size"
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        aria-label="Éléments par page"
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size} / page
          </option>
        ))}
      </select>
    </div>
  );
}
