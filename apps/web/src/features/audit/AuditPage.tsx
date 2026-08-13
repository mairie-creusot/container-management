import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchAuditLog } from "@/features/audit/auditSlice";
import { usePagination } from "@/hooks/usePagination";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
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
 * connus de TOUTES les routes mutantes de l'API (voir apps/api/src/routes/*.ts, une entrée par
 * fastify.post/put/patch/delete enregistrée). Repli générique (méthode + chemin bruts) pour
 * toute route future non encore reconnue ici — jamais un trou silencieux, juste moins lisible
 * en attendant d'être ajoutée ici (voir plugins/audit.ts côté API : la capture elle-même reste
 * automatique pour toute nouvelle route mutante, seule CETTE traduction doit être tenue à jour).
 * Reste volontairement côté frontend, sans toucher au corps de la requête (jamais journalisé
 * côté API — beaucoup de ces routes transportent des identifiants/mots de passe, voir
 * services/auditLog.ts) : uniquement de quoi rendre method+path lisibles, jamais le détail des
 * champs saisis.
 */
function describeAction(event: AuditEvent): string {
  const { method, path } = event;
  const segments = path.split("/").filter(Boolean); // ["api", "containers", ":id", "start"]
  const [, resource, idOrAction, subAction, subId] = segments;

  if (path === "/api/auth/login") return event.ok ? "s'est connecté(e)" : "a échoué à se connecter";
  if (path === "/api/auth/logout") return "s'est déconnecté(e)";
  if (path === "/api/setup/complete") return "a modifié la configuration (assistant)";
  if (path === "/api/setup/reset") return "a réinitialisé l'assistant de configuration";
  if (path.startsWith("/api/setup/test/")) return "a testé une connexion (assistant de configuration)";

  if (resource === "containers") {
    if (method === "POST" && !idOrAction) return "a déployé un conteneur";
    if (subAction === "start") return `a démarré le conteneur ${shortId(idOrAction)}`;
    if (subAction === "stop") return `a arrêté le conteneur ${shortId(idOrAction)}`;
    if (subAction === "restart") return `a redémarré le conteneur ${shortId(idOrAction)}`;
    if (subAction === "rename") return `a renommé le conteneur ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le conteneur ${shortId(idOrAction)}`;
  }
  if (resource === "volumes") {
    if (method === "POST") return "a créé un volume";
    if (method === "DELETE") return `a supprimé le volume "${shortId(idOrAction)}"`;
  }
  if (resource === "networks") {
    if (method === "POST" && !idOrAction) return "a créé un network";
    if (subAction === "connect") return `a connecté un conteneur au network ${shortId(idOrAction)}`;
    if (subAction === "disconnect") return `a déconnecté un conteneur du network ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le network ${shortId(idOrAction)}`;
  }
  if (resource === "images") {
    if (idOrAction === "pull") return "a tiré une image";
    if (subAction === "update") return `a mis à jour l'image ${shortId(idOrAction)}`;
    if (subAction === "scan") return `a lancé un scan de vulnérabilités sur l'image ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé l'image ${shortId(idOrAction)}`;
  }
  if (resource === "registries") {
    if (method === "POST") return "a ajouté un registry";
    if (method === "PATCH") return `a modifié le registry ${shortId(idOrAction)}`;
  }
  if (resource === "secrets") {
    if (method === "POST") return "a créé un secret";
    if (method === "PATCH") return `a modifié le secret ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le secret ${shortId(idOrAction)}`;
    if (subAction === "reveal") return `a révélé la valeur du secret ${shortId(idOrAction)}`;
  }
  if (resource === "cron-jobs") {
    if (method === "POST" && !idOrAction) return "a créé un cron job";
    if (subAction === "trigger") return `a déclenché manuellement le cron job ${shortId(idOrAction)}`;
    if (method === "PATCH") return `a modifié le cron job ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le cron job ${shortId(idOrAction)}`;
  }
  if (resource === "backups") {
    if (method === "POST" && !idOrAction) return "a créé une sauvegarde programmée";
    if (subAction === "run") return `a lancé la sauvegarde ${shortId(idOrAction)}`;
    if (subAction === "restore") return `a restauré la sauvegarde ${shortId(idOrAction)} (run ${shortId(subId)})`;
    if (method === "PATCH") return `a modifié la sauvegarde ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé la sauvegarde ${shortId(idOrAction)}`;
  }
  if (resource === "iac") {
    // /api/iac/workspaces[/:id[/files/:path | /run]] — resource ici vaut toujours "iac", le
    // découpage générique ci-dessus ne suffit pas (segments[2] = "workspaces", pas une action).
    const [, , , workspaceId, action] = segments;
    if (method === "POST" && !workspaceId) return "a créé un workspace Infra-as-code";
    if (method === "PUT" && action === "files") return `a modifié un fichier du workspace Infra-as-code ${shortId(workspaceId)}`;
    if (method === "DELETE" && action === "files") return `a supprimé un fichier du workspace Infra-as-code ${shortId(workspaceId)}`;
    if (action === "run") return `a exécuté une action Infra-as-code sur le workspace ${shortId(workspaceId)}`;
    if (method === "DELETE" && !action) return `a supprimé le workspace Infra-as-code ${shortId(workspaceId)}`;
  }
  if (resource === "gitops" && idOrAction === "sync") return "a synchronisé GitOps";
  if (resource === "github") {
    if (path === "/api/github/token") return "a configuré le jeton d'accès GitHub";
    if (path.endsWith("/deploy")) {
      const [, , , owner, repo] = segments;
      return `a déployé ${owner}/${repo} depuis GitHub`;
    }
    if (path.endsWith("/auto-deploy")) {
      const [, , , owner, repo] = segments;
      return `a configuré le déploiement automatique de ${owner}/${repo}`;
    }
  }
  if (resource === "notification-channels") {
    if (method === "POST" && !idOrAction) return "a créé un canal de notification";
    if (subAction === "test") return `a testé le canal de notification ${shortId(idOrAction)}`;
    if (method === "PATCH") return `a modifié le canal de notification ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le canal de notification ${shortId(idOrAction)}`;
  }
  if (path === "/api/notifications/read-all") return "a marqué toutes les notifications comme lues";
  if (resource === "ad-dns") {
    if (idOrAction === "config" && method === "PUT") return "a configuré la synchronisation DNS Active Directory";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé la synchronisation DNS Active Directory";
    if (idOrAction === "test") return "a testé la connexion DNS Active Directory";
  }
  if (resource === "nutanix") {
    if (idOrAction === "config" && method === "PUT") return "a configuré le cluster Nutanix";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé le cluster Nutanix";
  }
  if (resource === "lxc") {
    if (idOrAction === "config" && method === "PUT") return "a configuré l'hôte LXD";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé l'hôte LXD";
  }
  if (resource === "remote-environments") {
    if (method === "POST") return "a ajouté un environnement Docker distant";
    if (method === "PATCH") return `a modifié l'environnement Docker distant ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé l'environnement Docker distant ${shortId(idOrAction)}`;
  }
  if (resource === "reverse-proxy") {
    if (idOrAction === "routes" && method === "POST" && !subAction) return "a créé une route de reverse proxy";
    if (idOrAction === "routes" && subId === "resync-dns") return `a retesté la synchronisation DNS de la route ${shortId(subAction)}`;
    if (idOrAction === "routes" && method === "DELETE") return `a supprimé la route de reverse proxy ${shortId(subAction)}`;
    if (idOrAction === "push") return "a repoussé la configuration vers Caddy";
  }
  if (resource === "topology") {
    if (idOrAction === "positions") return "a réorganisé le graphe (positions des nœuds)";
    if (idOrAction === "groups" && method === "POST") return "a regroupé des nœuds";
    if (idOrAction === "groups" && method === "PATCH") return `a modifié le groupe ${shortId(subAction)}`;
    if (idOrAction === "groups" && method === "DELETE") return `a dissocié le groupe ${shortId(subAction)}`;
  }

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
