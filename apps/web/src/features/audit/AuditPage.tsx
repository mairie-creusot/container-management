import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchAuditLog } from "@/features/audit/auditSlice";
import { usePagination } from "@/hooks/usePagination";
import Pagination from "@/components/Pagination";
import type { AuditEvent } from "@/types";

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

/** Segment "identifiant" d'un path (ID Docker, nom...) — tronqué s'il ressemble à un hash long. */
function shortId(segment: string | undefined): string {
  if (!segment) return "";
  return segment.length > 16 ? `${segment.slice(0, 12)}…` : decodeURIComponent(segment);
}

/**
 * Traduit method+path en description humaine ("a démarré le conteneur abc123…") — motifs
 * connus des routes mutantes de l'API (voir apps/api/src/routes/*.ts). Repli générique
 * (méthode + chemin bruts) pour toute route future non encore reconnue ici.
 */
function describeAction(event: AuditEvent): string {
  const { method, path } = event;
  const segments = path.split("/").filter(Boolean); // ["api", "containers", ":id", "start"]
  const [, resource, idOrAction, subAction] = segments;

  if (path === "/api/auth/login") return event.ok ? "s'est connecté(e)" : "a échoué à se connecter";
  if (path === "/api/auth/logout") return "s'est déconnecté(e)";
  if (path === "/api/setup/complete") return "a modifié la configuration (assistant)";
  if (path === "/api/setup/reset") return "a réinitialisé l'assistant de configuration";

  if (resource === "containers") {
    if (method === "POST" && !idOrAction) return "a créé un conteneur";
    if (subAction === "start") return `a démarré le conteneur ${shortId(idOrAction)}`;
    if (subAction === "stop") return `a arrêté le conteneur ${shortId(idOrAction)}`;
    if (subAction === "restart") return `a redémarré le conteneur ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le conteneur ${shortId(idOrAction)}`;
  }
  if (resource === "volumes") {
    if (method === "POST") return "a créé un volume";
    if (method === "DELETE") return `a supprimé le volume "${shortId(idOrAction)}"`;
  }
  if (resource === "networks") {
    if (method === "POST") return "a créé un network";
    if (method === "DELETE") return `a supprimé le network ${shortId(idOrAction)}`;
  }
  if (resource === "images") {
    if (idOrAction === "pull") return "a tiré une image";
    if (subAction === "update") return `a mis à jour l'image ${shortId(idOrAction)}`;
  }
  if (resource === "registries" && method === "POST") return "a ajouté un registry";

  return `${method} ${path}`;
}

export default function AuditPage() {
  const dispatch = useAppDispatch();
  const { items, status, error } = useAppSelector((s) => s.audit);
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(items, 25);

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
      {status === "loading" && items.length === 0 && <div className="empty-state">Chargement…</div>}
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
                    <td className="cell-primary">{event.actorDisplayName}</td>
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
