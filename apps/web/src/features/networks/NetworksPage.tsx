import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { createNetwork, fetchNetworks, removeNetwork, selectNetwork } from "@/features/networks/networksSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { usePagination } from "@/hooks/usePagination";
import Inspector from "@/components/Inspector";
import KeyValueList from "@/components/KeyValueList";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";

const DRIVERS = ["bridge", "overlay", "host", "none"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Orphelin = existant sur l'hôte Docker (cette liste vient de GET /api/networks, un vrai
 * `docker network ls`) mais attaché à AUCUN conteneur (`containerCount`, calculé côté serveur à
 * partir de `n.Containers`, docker.ts#listNetworks) — SAUF les 3 networks internes par défaut de
 * Docker (bridge/host/none), jamais des ressources à nettoyer : même exclusion par nom que celle
 * déjà appliquée pour masquer le bouton "Supprimer" individuel plus bas et dans
 * TopologyGraph.tsx#nodeMenuItems (menu contextuel réseau du graphe).
 */
const DEFAULT_NETWORK_NAMES = ["bridge", "host", "none"];

function isOrphanNetwork(n: { name: string; containerCount: number }): boolean {
  return n.containerCount === 0 && !DEFAULT_NETWORK_NAMES.includes(n.name);
}

export default function NetworksPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, selectedId, mutatingId } = useAppSelector((s) => s.networks);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    dispatch(fetchNetworks());
  }, [dispatch]);

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch(createNetwork({ name: trimmed, driver })).then((result) => {
      if (createNetwork.fulfilled.match(result)) {
        setFormOpen(false);
        setName("");
      }
    });
  }

  async function handleRemove(id: string, netName: string) {
    const ok = await confirm({
      title: "Supprimer le network",
      description: `Confirmer la suppression du network "${netName}" ?`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (ok) dispatch(removeNetwork({ id, name: netName }));
  }

  const orphans = items.filter(isOrphanNetwork);

  /** Action groupée "Nettoyer les orphelins" — une seule confirmation explicite pour le lot
   * entier (jamais de suppression sans confirmation, jamais de purge automatique en tâche de
   * fond), puis suppressions réelles séquentielles via le même thunk que la suppression
   * individuelle (removeNetwork, DELETE /api/networks/:id — pas une simulation). */
  async function handleCleanupOrphans() {
    if (orphans.length === 0) return;
    const ok = await confirm({
      title: "Nettoyer les networks orphelins",
      description: `Confirmer la suppression définitive de ${orphans.length} network(s) orphelin(s) (aucun conteneur attaché) ?`,
      confirmLabel: `Nettoyer (${orphans.length})`,
      variant: "danger",
    });
    if (!ok) return;
    setCleaning(true);
    try {
      for (const n of orphans) {
        await dispatch(removeNetwork({ id: n.id, name: n.name }));
      }
    } finally {
      setCleaning(false);
    }
  }

  const visible = items.filter(
    (n) =>
      (!searchQuery || n.name.toLowerCase().includes(searchQuery.toLowerCase())) &&
      (!orphansOnly || isOrphanNetwork(n)),
  );
  const selected = items.find((n) => n.id === selectedId) ?? null;
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(visible, 10);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Networks</h2>
            <p>Réseaux Docker réels de l'hôte.</p>
          </div>
          <div className="page-header-actions">
            {canOperate(session) && orphans.length > 0 && (
              <button type="button" className="btn btn-danger btn-sm" disabled={cleaning} onClick={handleCleanupOrphans}>
                {cleaning ? "Nettoyage…" : `Nettoyer les orphelins (${orphans.length})`}
              </button>
            )}
            {canOperate(session) && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormOpen((o) => !o)}>
                {formOpen ? "Annuler" : "+ Créer un network"}
              </button>
            )}
          </div>
        </div>

        <label className="filter-toggle">
          <input type="checkbox" checked={orphansOnly} onChange={(e) => setOrphansOnly(e.target.checked)} />
          Orphelins uniquement {orphans.length > 0 && `(${orphans.length})`}
        </label>

        {formOpen && canOperate(session) && (
          <form className="create-container-form" onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="network-name">Nom</label>
              <input
                id="network-name"
                type="text"
                placeholder="ex : quai-app-net"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="network-driver">Driver</label>
              <select id="network-driver" value={driver} onChange={(e) => setDriver(e.target.value)}>
                {DRIVERS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Créer
            </button>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable columns={["Nom", "Driver", "Scope", "Conteneurs attachés", "Créé le", ""]} rows={8} />
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun network ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Driver</th>
                  <th>Scope</th>
                  <th>Conteneurs attachés</th>
                  <th>Créé le</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((n) => (
                  <tr
                    key={n.id}
                    className={n.id === selectedId ? "is-selected" : ""}
                    onClick={() => dispatch(selectNetwork(n.id))}
                  >
                    <td className="cell-primary cell-mono">{n.name}</td>
                    <td>{n.driver}</td>
                    <td>{n.scope}</td>
                    <td>
                      {n.containerCount > 0 ? (
                        n.containerCount
                      ) : isOrphanNetwork(n) ? (
                        <span className="chip chip--danger">Orphelin</span>
                      ) : (
                        n.containerCount
                      )}
                    </td>
                    <td>{formatDate(n.createdAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {canOperate(session) && !DEFAULT_NETWORK_NAMES.includes(n.name) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={mutatingId === n.id}
                          onClick={() => handleRemove(n.id, n.name)}
                        >
                          {mutatingId === n.id ? "…" : "Supprimer"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={visible.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Inspector title={selected?.name} subtitle={selected?.id.slice(0, 12)} onClose={() => dispatch(selectNetwork(null))}>
        {selected && (
          <KeyValueList
            rows={[
              { key: "Driver", value: selected.driver },
              { key: "Scope", value: selected.scope },
              { key: "Interne", value: selected.internal ? "Oui" : "Non" },
              { key: "Conteneurs attachés", value: String(selected.containerCount) },
              { key: "Créé le", value: formatDate(selected.createdAt) },
              { key: "ID complet", value: selected.id },
            ]}
          />
        )}
      </Inspector>
    </div>
  );
}
