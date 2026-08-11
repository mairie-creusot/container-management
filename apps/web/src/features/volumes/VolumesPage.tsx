import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { createVolume, fetchVolumes, removeVolume, selectVolume } from "@/features/volumes/volumesSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { usePagination } from "@/hooks/usePagination";
import Inspector from "@/components/Inspector";
import KeyValueList from "@/components/KeyValueList";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function VolumesPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, selectedName, mutatingName } = useAppSelector((s) => s.volumes);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");

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

  const visible = items.filter(
    (v) => !searchQuery || v.name.toLowerCase().includes(searchQuery.toLowerCase()),
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
          {canOperate(session) && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormOpen((o) => !o)}>
              {formOpen ? "Annuler" : "+ Ajouter un volume"}
            </button>
          )}
        </div>

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
                        <span className="chip chip--muted">Inutilisé</span>
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
        )}
      </Inspector>
    </div>
  );
}
