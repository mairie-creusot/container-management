import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { createVolume, fetchVolumes, openVolumeBrowser, removeVolume, selectVolume } from "@/features/volumes/volumesSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { usePagination } from "@/hooks/usePagination";
import Inspector from "@/components/Inspector";
import KeyValueList from "@/components/KeyValueList";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
import VolumeFilesModal from "@/components/VolumeFilesModal";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Orphelin = existant sur l'hôte Docker (cette liste vient bien de GET /api/volumes, un vrai
 * `docker volume ls`) mais monté par AUCUN conteneur — même définition et même champ `inUseBy`
 * (calculé côté serveur à partir des Mounts réels de tous les conteneurs, docker.ts#listVolumes)
 * que le graphe de topologie utilise pour décider quels volumes afficher. Pas de route dédiée
 * GET /api/orphans : cette page liste déjà TOUS les volumes réels avec cette même information,
 * un badge + un filtre ici est plus cohérent avec l'UX existante qu'une vue séparée redondante.
 */
function isOrphanVolume(v: { inUseBy: number }): boolean {
  return v.inUseBy === 0;
}

export default function VolumesPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, selectedName, mutatingName } = useAppSelector((s) => s.volumes);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    dispatch(fetchVolumes());
  }, [dispatch]);

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch(createVolume(trimmed)).then((result) => {
      if (createVolume.fulfilled.match(result)) {
        setFormOpen(false);
        setName("");
      }
    });
  }

  async function handleRemove(volumeName: string, inUseBy: number) {
    const ok = await confirm({
      title: "Supprimer le volume",
      description:
        inUseBy > 0
          ? `"${volumeName}" est monté par ${inUseBy} conteneur(s) — la suppression échouera tant qu'il est utilisé.`
          : `Confirmer la suppression du volume "${volumeName}" ? Les données qu'il contient seront perdues.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (ok) dispatch(removeVolume(volumeName));
  }

  const orphanNames = items.filter(isOrphanVolume).map((v) => v.name);

  /** Action groupée "Nettoyer les orphelins" — une seule confirmation explicite pour le lot
   * entier (jamais de suppression sans confirmation, jamais de purge automatique en tâche de
   * fond), puis suppressions réelles séquentielles via le même thunk que la suppression
   * individuelle (removeVolume, DELETE /api/volumes/:name — pas une simulation). */
  async function handleCleanupOrphans() {
    if (orphanNames.length === 0) return;
    const ok = await confirm({
      title: "Nettoyer les volumes orphelins",
      description: `Confirmer la suppression définitive de ${orphanNames.length} volume(s) orphelin(s) (non monté par aucun conteneur) ? Les données qu'ils contiennent seront perdues.`,
      confirmLabel: `Nettoyer (${orphanNames.length})`,
      variant: "danger",
    });
    if (!ok) return;
    setCleaning(true);
    try {
      for (const volumeName of orphanNames) {
        await dispatch(removeVolume(volumeName));
      }
    } finally {
      setCleaning(false);
    }
  }

  const visible = items.filter(
    (v) =>
      (!searchQuery || v.name.toLowerCase().includes(searchQuery.toLowerCase())) &&
      (!orphansOnly || isOrphanVolume(v)),
  );
  const selected = items.find((v) => v.name === selectedName) ?? null;
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(visible, 10);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Volumes</h2>
            <p>Volumes Docker réels de l'hôte.</p>
          </div>
          <div className="page-header-actions">
            {canOperate(session) && orphanNames.length > 0 && (
              <button type="button" className="btn btn-danger btn-sm" disabled={cleaning} onClick={handleCleanupOrphans}>
                {cleaning ? "Nettoyage…" : `Nettoyer les orphelins (${orphanNames.length})`}
              </button>
            )}
            {canOperate(session) && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormOpen((o) => !o)}>
                {formOpen ? "Annuler" : "+ Ajouter un volume"}
              </button>
            )}
          </div>
        </div>

        <label className="filter-toggle">
          <input type="checkbox" checked={orphansOnly} onChange={(e) => setOrphansOnly(e.target.checked)} />
          Orphelins uniquement {orphanNames.length > 0 && `(${orphanNames.length})`}
        </label>

        {formOpen && canOperate(session) && (
          <form className="create-container-form" onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="volume-name">Nom</label>
              <input
                id="volume-name"
                type="text"
                placeholder="ex : pgdata"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Créer
            </button>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable columns={["Nom", "Driver", "Point de montage", "Créé le", "Utilisation", ""]} rows={8} />
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun volume ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Driver</th>
                  <th>Point de montage</th>
                  <th>Créé le</th>
                  <th>Utilisation</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr
                    key={v.name}
                    className={v.name === selectedName ? "is-selected" : ""}
                    onClick={() => dispatch(selectVolume(v.name))}
                  >
                    <td className="cell-primary cell-mono">{v.name}</td>
                    <td>{v.driver}</td>
                    <td className="cell-mono">{v.mountpoint}</td>
                    <td>{formatDate(v.createdAt)}</td>
                    <td>
                      {v.inUseBy > 0 ? (
                        <span className="chip chip--accent">{v.inUseBy} conteneur(s)</span>
                      ) : (
                        <span className="chip chip--danger">Orphelin</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {canOperate(session) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={mutatingName === v.name}
                          onClick={() => handleRemove(v.name, v.inUseBy)}
                        >
                          {mutatingName === v.name ? "…" : "Supprimer"}
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

      <Inspector title={selected?.name} subtitle={selected?.mountpoint} onClose={() => dispatch(selectVolume(null))}>
        {selected && (
          <>
            <div className="inspector-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => dispatch(openVolumeBrowser(selected.name))}
              >
                Parcourir
              </button>
            </div>
            <KeyValueList
              rows={[
                { key: "Driver", value: selected.driver },
                { key: "Scope", value: selected.scope },
                { key: "Point de montage", value: selected.mountpoint },
                { key: "Créé le", value: formatDate(selected.createdAt) },
                { key: "Utilisé par", value: `${selected.inUseBy} conteneur(s)` },
                ...(Object.keys(selected.labels).length > 0
                  ? Object.entries(selected.labels).map(([k, v]) => ({ key: k, value: v }))
                  : []),
              ]}
            />
          </>
        )}
      </Inspector>

      <VolumeFilesModal />
    </div>
  );
}
