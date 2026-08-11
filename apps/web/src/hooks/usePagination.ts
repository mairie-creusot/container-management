import { useEffect, useState } from "react";

export interface UsePaginationResult<T> {
  page: number;
  totalPages: number;
  pageItems: T[];
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
}

/**
 * Pagination côté client : toutes les listes de l'app (volumes, conteneurs, images...) sont
 * déjà entièrement chargées en mémoire (pas d'endpoint paginé côté API — la volumétrie réelle
 * d'un hôte Docker reste de l'ordre de dizaines/centaines d'éléments, pas de quoi justifier
 * une pagination serveur pour l'instant). Revient à la page 1 si la liste rétrécit sous la
 * page courante (changement de filtre/recherche).
 */
export function usePagination<T>(items: T[], initialPageSize = 10): UsePaginationResult<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return { page: clampedPage, totalPages, pageItems, setPage, pageSize, setPageSize };
}
