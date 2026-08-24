import { useEffect, useMemo } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchAuditLog } from "@/features/audit/auditSlice";
import { usePagination } from "@/hooks/usePagination";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
import type { AuditEvent } from "@/types";
import { describeAction, directoryDisplayNames } from "@/features/audit/auditMessage";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function AuditPage() {
  const dispatch = useAppDispatch();
  const { items, status, error } = useAppSelector((s) => s.audit);
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(items, 25);
  const displayNames = useMemo(() => directoryDisplayNames(items), [items]);

  useEffect(() => {
    dispatch(fetchAuditLog());
  }, [dispatch]);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Traçabilité</h2>
          <p>Journal des actions administratives — qui a fait quoi, sur tout l'historique disponible.</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {status === "loading" && items.length === 0 && (
        <SkeletonTable columns={["Horodatage", "Utilisateur", "Action", "Résultat"]} rows={10} />
      )}
      {status !== "loading" && items.length === 0 && !error && (
        <div className="empty-state">Aucune action enregistrée pour l'instant.</div>
      )}

      {items.length > 0 && (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Horodatage</th>
                  <th>Utilisateur</th>
                  <th>Action</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((event) => (
                  <tr key={event.id}>
                    <td className="cell-mono">{formatDate(event.timestamp)}</td>
                    <td className="cell-primary">{displayNames.get(event.actor) ?? event.actorDisplayName}</td>
                    <td>{describeAction(event)}</td>
                    <td>
                      <span className={`chip ${event.ok ? "chip--accent" : "chip--danger"}`}>
                        {event.ok ? "OK" : `Échec (${event.statusCode})`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={items.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  );
}
