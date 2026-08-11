import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { closeVolumeBrowser, fetchVolumeFiles } from "@/features/volumes/volumesSlice";
import Modal from "@/components/Modal";
import { IconFolder } from "@/components/icons";

function formatSize(bytes: number, isDirectory: boolean): string {
  if (isDirectory) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Segments cliquables ("racine / a / b") construits depuis le chemin courant ("/a/b"). */
function pathSegments(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const segments: { label: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

/**
 * Explorateur de fichiers d'un volume Docker — LECTURE SEULE (voir ARCHITECTURE.md § "Explorateur
 * de fichiers"). Piloté par `state.volumes.browser` (features/volumes/volumesSlice.ts) : ouvert
 * via openVolumeBrowser(volumeName) depuis VolumesPage.tsx.
 */
export default function VolumeFilesModal() {
  const dispatch = useAppDispatch();
  const { volumeName, path, entries, status, error } = useAppSelector((s) => s.volumes.browser);
  const open = volumeName !== null;

  useEffect(() => {
    if (!volumeName) return;
    dispatch(fetchVolumeFiles({ volumeName, path }));
    // volumeName/path changent ensemble à chaque navigation — cette dépendance couvre les deux.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, volumeName, path]);

  function navigateTo(nextPath: string) {
    if (!volumeName) return;
    dispatch(fetchVolumeFiles({ volumeName, path: nextPath }));
  }

  function handleClose() {
    dispatch(closeVolumeBrowser());
  }

  const segments = pathSegments(path);

  return (
    <Modal open={open} onClose={handleClose} labelledBy="volume-files-title">
      {volumeName && (
        <div className="volume-files-modal">
          <div className="volume-files-modal__header">
            <div>
              <div id="volume-files-title" className="volume-files-modal__title">
                Fichiers — {volumeName}
              </div>
              <div className="volume-files-modal__subtitle">Point de montage /volume dans un conteneur helper éphémère</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
              Fermer
            </button>
          </div>

          <div className="volume-files-modal__readonly-note">
            Lecture seule — cet explorateur ne permet ni édition, ni suppression, ni envoi de fichier.
          </div>

          <div className="volume-files-modal__breadcrumb">
            <button type="button" onClick={() => navigateTo("")} disabled={path === ""}>
              {volumeName}
            </button>
            {segments.map((segment, index) => (
              <span key={segment.path} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                <span>/</span>
                <button
                  type="button"
                  onClick={() => navigateTo(segment.path)}
                  disabled={index === segments.length - 1}
                >
                  {segment.label}
                </button>
              </span>
            ))}
          </div>

          {error && <div className="error-banner">{error}</div>}

          {status === "loading" && <div className="empty-state">Chargement…</div>}

          {status !== "loading" && !error && entries.length === 0 && (
            <div className="empty-state">Ce dossier est vide.</div>
          )}

          {entries.length > 0 && (
            <div className="volume-files-modal__body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Taille</th>
                    <th>Modifié le</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.path}
                      className={entry.isDirectory ? "volume-files-row volume-files-row--dir" : "volume-files-row"}
                      onClick={() => entry.isDirectory && navigateTo(entry.path)}
                    >
                      <td className="cell-primary cell-mono">
                        <span className="volume-files-row__name">
                          {entry.isDirectory && <IconFolder />}
                          {entry.name}
                        </span>
                      </td>
                      <td className="cell-mono">{formatSize(entry.sizeBytes, entry.isDirectory)}</td>
                      <td>{formatDate(entry.modifiedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
