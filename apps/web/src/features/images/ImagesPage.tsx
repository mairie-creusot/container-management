import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  deleteImage,
  fetchImages,
  fetchScanDetail,
  fetchScans,
  pullImage,
  scanImage,
  selectImage,
  setImageFilter,
  updateImage,
  type ImageStatusFilter,
} from "@/features/images/imagesSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { usePagination } from "@/hooks/usePagination";
import Inspector from "@/components/Inspector";
import StatusPill from "@/components/StatusPill";
import RegistryBadge from "@/components/RegistryBadge";
import KeyValueList from "@/components/KeyValueList";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
import type { VulnSeverity } from "@/types";

const FILTERS: { id: ImageStatusFilter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "update", label: "Mise à jour dispo" },
  { id: "uptodate", label: "À jour" },
];

// Ordre d'affichage des sévérités et mapping vers les couleurs sémantiques déjà définies
// (apps/web/src/styles/variables.css) — Critical/High en rouge, Medium en ambre, Low/Negligible/
// Unknown en neutre pour ne pas noyer les vraies alertes.
const SEVERITY_ORDER: VulnSeverity[] = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
const SEVERITY_SEMANTIC: Record<VulnSeverity, "critical" | "warning" | "neutral"> = {
  Critical: "critical",
  High: "critical",
  Medium: "warning",
  Low: "neutral",
  Negligible: "neutral",
  Unknown: "neutral",
};

const SCAN_POLL_MS = 2000;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Mo";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function ImagesPage() {
  const dispatch = useAppDispatch();
  const {
    items,
    status,
    error,
    filter,
    selectedId,
    updatingId,
    deletingId,
    pullStatus,
    pullError,
    scansByImageId,
    scanStatus,
    scanError,
  } = useAppSelector((s) => s.images);
  const [pullReference, setPullReference] = useState("");
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const selectedEnvironmentId = useAppSelector((s) => s.ui.selectedEnvironmentId);
  const environments = useAppSelector((s) => s.clusters.environments);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();

  useEffect(() => {
    dispatch(fetchImages(filter));
  }, [dispatch, filter]);

  useEffect(() => {
    if (selectedId) dispatch(fetchScans(selectedId));
  }, [dispatch, selectedId]);

  async function handleUpdate(imageId: string, imageName: string, latestTag: string) {
    const ok = await confirm({
      title: "Mettre à jour l'image",
      description: `Confirmer la mise à jour de ${imageName} vers le tag ${latestTag} ?`,
      confirmLabel: "Mettre à jour",
    });
    if (ok) dispatch(updateImage(imageId));
  }

  async function handleDelete(imageId: string, imageName: string) {
    const ok = await confirm({
      title: "Supprimer l'image",
      description: `Confirmer la suppression de "${imageName}" ? Échouera si un conteneur (même arrêté) l'utilise encore.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (ok) dispatch(deleteImage({ id: imageId }));
  }

  function handlePull(event: FormEvent) {
    event.preventDefault();
    const reference = pullReference.trim();
    if (!reference) return;
    dispatch(pullImage(reference)).then((result) => {
      if (pullImage.fulfilled.match(result)) setPullReference("");
    });
  }

  const selectedEnvironmentName = environments.find((e) => e.id === selectedEnvironmentId)?.name;

  const visible = items.filter((image) => {
    if (selectedEnvironmentName && image.environment !== selectedEnvironmentName) return false;
    if (searchQuery && !image.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const selected = items.find((image) => image.id === selectedId) ?? null;
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(visible, 10);

  const currentScan = selected ? scansByImageId[selected.id]?.[0] ?? null : null;

  // Poll le scan en cours toutes les 2s — même principe que le suivi de run IaC (voir
  // apps/web/src/features/iac/IacPage.tsx), plus simple qu'un flux WebSocket pour ce premier lot.
  useEffect(() => {
    if (!selected || !currentScan || currentScan.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchScanDetail({ imageId: selected.id, scanId: currentScan.id }));
    }, SCAN_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, selected, currentScan]);

  function handleScan(imageId: string) {
    dispatch(scanImage(imageId));
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Images</h2>
            <p>Images réellement présentes sur l'hôte Docker, enrichies du dernier tag disponible.</p>
          </div>
          {canOperate(session) && (
            <form className="pull-form" onSubmit={handlePull}>
              <input
                type="text"
                placeholder="Tirer une image — ex : redis:7-alpine"
                value={pullReference}
                onChange={(e) => setPullReference(e.target.value)}
                disabled={pullStatus === "pulling"}
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={pullStatus === "pulling" || pullReference.trim() === ""}
              >
                {pullStatus === "pulling" ? "Pull en cours…" : "Pull"}
              </button>
            </form>
          )}
        </div>

        {pullStatus === "error" && pullError && <div className="error-banner">{pullError}</div>}

        <div className="chip-row">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip${filter === f.id ? " is-active" : ""}`}
              onClick={() => dispatch(setImageFilter(f.id))}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable columns={["Image", "Registry", "Tag courant", "Dernier tag", "Environnement", "Statut"]} rows={8} />
        )}

        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucune image ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Registry</th>
                  <th>Tag courant</th>
                  <th>Dernier tag</th>
                  <th>Environnement</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((image) => (
                  <tr
                    key={image.id}
                    className={image.id === selectedId ? "is-selected" : ""}
                    onClick={() => dispatch(selectImage(image.id))}
                  >
                    <td className="cell-primary cell-mono">{image.name}</td>
                    <td>
                      <RegistryBadge kind={image.registry} />
                    </td>
                    <td className="cell-mono">{image.currentTag}</td>
                    <td className="cell-mono">{image.latestTag}</td>
                    <td>{image.environment}</td>
                    <td>
                      <StatusPill status={image.status} />
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

      <Inspector
        title={selected?.name}
        subtitle={selected?.digest}
        onClose={() => dispatch(selectImage(null))}
      >
        {selected && (
          <>
            <StatusPill status={selected.status} />
            <KeyValueList
              rows={[
                { key: "Registry", value: selected.registry },
                { key: "Tag courant", value: selected.currentTag },
                { key: "Dernier tag", value: selected.latestTag },
                { key: "Environnement", value: selected.environment },
                { key: "Taille", value: formatBytes(selected.sizeBytes) },
                { key: "Couches", value: String(selected.layers) },
              ]}
            />
            <div className="inspector-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={selected.status === "uptodate" || !canOperate(session) || updatingId === selected.id}
                onClick={() => handleUpdate(selected.id, selected.name, selected.latestTag)}
              >
                {updatingId === selected.id ? "Mise à jour…" : "Mettre à jour"}
              </button>
              {canOperate(session) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={scanStatus === "starting" || currentScan?.status === "running"}
                  onClick={() => handleScan(selected.id)}
                >
                  {currentScan?.status === "running" ? "Scan en cours…" : "Scanner"}
                </button>
              )}
              {canOperate(session) && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={deletingId === selected.id}
                  onClick={() => handleDelete(selected.id, selected.name)}
                >
                  {deletingId === selected.id ? "Suppression…" : "Supprimer"}
                </button>
              )}
            </div>
            {!canOperate(session) && (
              <p style={{ fontSize: 11.5, color: "var(--color-text-faint)" }}>
                Rôle operator ou admin requis pour mettre à jour, scanner ou supprimer.
              </p>
            )}

            {scanStatus === "error" && scanError && <div className="error-banner">{scanError}</div>}

            {currentScan && (
              <>
                <div className="inspector-section-title">Vulnérabilités (Grype)</div>
                {currentScan.status === "running" && (
                  <div className="empty-state">
                    Scan en cours… (peut prendre du temps au premier scan, le temps de télécharger la base
                    de vulnérabilités)
                  </div>
                )}
                {currentScan.status === "failed" && (
                  <div className="error-banner">Le scan a échoué (binaire grype absent ou erreur d'exécution).</div>
                )}
                {currentScan.status === "success" && (
                  <>
                    <div className="scan-summary">
                      {currentScan.vulnerabilities.length === 0 ? (
                        <span className="status-pill status-pill--success">Aucune vulnérabilité connue</span>
                      ) : (
                        SEVERITY_ORDER.filter((sev) => currentScan.summary[sev] > 0).map((sev) => (
                          <span key={sev} className={`status-pill status-pill--${SEVERITY_SEMANTIC[sev]}`}>
                            {sev} · {currentScan.summary[sev]}
                          </span>
                        ))
                      )}
                    </div>
                    {currentScan.vulnerabilities.length > 0 && (
                      <div className="data-table-wrap scan-vuln-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>CVE</th>
                              <th>Sévérité</th>
                              <th>Paquet</th>
                              <th>Version</th>
                              <th>Corrigé</th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentScan.vulnerabilities.map((vuln) => (
                              <tr key={`${vuln.id}-${vuln.packageName}-${vuln.installedVersion}`}>
                                <td className="cell-mono">{vuln.id}</td>
                                <td>
                                  <span className={`status-pill status-pill--${SEVERITY_SEMANTIC[vuln.severity]}`}>
                                    {vuln.severity}
                                  </span>
                                </td>
                                <td>{vuln.packageName}</td>
                                <td className="cell-mono">{vuln.installedVersion}</td>
                                <td className="cell-mono">{vuln.fixedInVersion ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p style={{ fontSize: 11.5, color: "var(--color-text-faint)" }}>
                      Terminé {formatDate(currentScan.finishedAt)}
                    </p>
                  </>
                )}
              </>
            )}
          </>
        )}
      </Inspector>
    </div>
  );
}
