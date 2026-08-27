import { useEffect, useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchAuditLog } from "@/features/audit/auditSlice";
import { usePagination } from "@/hooks/usePagination";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
import { directoryDisplayNames, pluginAuditLabels } from "@/features/audit/auditMessage";
import {
  auditActorOptions,
  auditDomainOptions,
  buildAuditRows,
  EMPTY_AUDIT_FILTERS,
  filterAuditRows,
  hasActiveFilter,
  type AuditFilters,
  type AuditOutcome,
  type AuditPeriod,
} from "@/features/audit/auditFilters";

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

const PERIOD_LABELS: { value: AuditPeriod; label: string }[] = [
  { value: "all", label: "Depuis toujours" },
  { value: "24h", label: "24 dernières heures" },
  { value: "7d", label: "7 derniers jours" },
  { value: "30d", label: "30 derniers jours" },
];

const OUTCOME_LABELS: { value: AuditOutcome; label: string }[] = [
  { value: "all", label: "Tous les résultats" },
  { value: "ok", label: "Réussites" },
  { value: "failed", label: "Échecs" },
];

/**
 * Journal « qui a fait quoi » — ouvert aux rôles qui AGISSENT sur le parc (admin et operator, voir
 * routes/audit.ts) : une équipe informatique doit voir ce que font ses collègues sur les mêmes
 * machines. La recherche porte sur ce qui est LU (le nom et la phrase de l'action), jamais sur le
 * chemin technique qu'on a justement cessé d'afficher.
 */
export default function AuditPage() {
  const dispatch = useAppDispatch();
  const { items, status, error } = useAppSelector((s) => s.audit);
  const displayNames = useMemo(() => directoryDisplayNames(items), [items]);
  // Libellés des actions de greffons (GET /api/plugins, chargé une fois au démarrage par App.tsx) :
  // sans eux, une ligne du canal générique n'afficherait que l'identifiant brut de l'action.
  const plugins = useAppSelector((s) => s.plugins.items);
  const actionLabels = useMemo(() => pluginAuditLabels(plugins), [plugins]);

  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);

  const rows = useMemo(() => buildAuditRows(items, displayNames, actionLabels), [items, displayNames, actionLabels]);
  // `Date.now()` figé au rendu : un filtre de période ne doit pas faire glisser la liste sous le
  // curseur pendant qu'on la lit.
  const filtered = useMemo(() => filterAuditRows(rows, filters, Date.now()), [rows, filters]);
  const actors = useMemo(() => auditActorOptions(rows), [rows]);
  const domains = useMemo(() => auditDomainOptions(rows), [rows]);

  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(filtered, 25);

  useEffect(() => {
    dispatch(fetchAuditLog());
  }, [dispatch]);

  // Un filtre resserré alors qu'on est page 7 laisserait un tableau vide sans rien expliquer.
  useEffect(() => {
    setPage(1);
  }, [filters, setPage]);

  function update<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Traçabilité</h2>
          <p>
            Journal des actions administratives — qui a fait quoi, sur tout l'historique disponible. Visible par
            l'ensemble des personnes autorisées à agir sur le parc, y compris vos propres actions.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {items.length > 0 && (
        <div className="audit-filters">
          <input
            type="search"
            className="audit-filters__search"
            placeholder="Rechercher une personne ou une action…"
            aria-label="Rechercher dans le journal"
            value={filters.query}
            onChange={(event) => update("query", event.target.value)}
          />
          <select aria-label="Filtrer par personne" value={filters.actor} onChange={(e) => update("actor", e.target.value)}>
            <option value="">Tout le monde</option>
            {actors.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} ({option.count})
              </option>
            ))}
          </select>
          <select aria-label="Filtrer par domaine" value={filters.domain} onChange={(e) => update("domain", e.target.value)}>
            <option value="">Tous les domaines</option>
            {domains.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} ({option.count})
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrer par résultat"
            value={filters.outcome}
            onChange={(e) => update("outcome", e.target.value as AuditOutcome)}
          >
            {OUTCOME_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrer par période"
            value={filters.period}
            onChange={(e) => update("period", e.target.value as AuditPeriod)}
          >
            {PERIOD_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {hasActiveFilter(filters) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(EMPTY_AUDIT_FILTERS)}>
              Réinitialiser
            </button>
          )}
          <span className="audit-filters__count">
            {filtered.length} / {rows.length} action{rows.length > 1 ? "s" : ""}
          </span>
        </div>
      )}

      {status === "loading" && items.length === 0 && (
        <SkeletonTable columns={["Horodatage", "Utilisateur", "Action", "Résultat"]} rows={10} />
      )}
      {status !== "loading" && items.length === 0 && !error && (
        <div className="empty-state">Aucune action enregistrée pour l'instant.</div>
      )}
      {items.length > 0 && filtered.length === 0 && (
        <div className="empty-state">Aucune action ne correspond à ces critères.</div>
      )}

      {filtered.length > 0 && (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Horodatage</th>
                  <th>Utilisateur</th>
                  <th>Domaine</th>
                  <th>Action</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((row) => (
                  <tr key={row.event.id}>
                    <td className="cell-mono">{formatDate(row.event.timestamp)}</td>
                    <td className="cell-primary">{row.who}</td>
                    <td>
                      <span className="chip">{row.domainLabel}</span>
                    </td>
                    <td>{row.what}</td>
                    <td>
                      <span className={`chip ${row.event.ok ? "chip--accent" : "chip--danger"}`}>
                        {row.event.ok ? "OK" : `Échec (${row.event.statusCode})`}
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
            totalItems={filtered.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  );
}
