import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/api/client";
import { useDismiss } from "@/components/topologyGraphShared";
import type { ImageTemplateBuild, ImageTemplateBuildStatus } from "@/types";

const BUILD_STATUS_LABEL: Record<ImageTemplateBuildStatus, string> = {
  running: "en cours…",
  success: "réussi",
  failed: "échoué",
};

interface TemplateBuildsPopoverProps {
  templateId: string;
  templateName: string;
  x: number;
  y: number;
  onClose: () => void;
}

/** "Voir les builds" (menu contextuel d'un nœud template) — GET /api/templates/:id/builds, chargé
 * localement à l'ouverture (même pattern que l'onglet Métriques du panneau de détail). */
export default function TemplateBuildsPopover({ templateId, templateName, x, y, onClose }: TemplateBuildsPopoverProps) {
  const { ref, style } = useDismiss(onClose, x, y);
  const [builds, setBuilds] = useState<ImageTemplateBuild[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const items = await apiGet<ImageTemplateBuild[]>(`/templates/${templateId}/builds`);
        if (!cancelled) {
          setBuilds(items);
          setStatus("ready");
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof ApiError && error.status === 404 ? "unavailable" : "error");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  function formatDate(iso: string | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{`Builds de « ${templateName} »`}</div>
      {status === "loading" && <p className="template-modal__hint">Chargement…</p>}
      {status === "unavailable" && (
        <p className="template-modal__hint">Le backend de la fabrique de templates n'est pas encore disponible.</p>
      )}
      {status === "error" && <p className="graph-popover__error">Échec du chargement des builds.</p>}
      {status === "ready" && builds.length === 0 && <p className="template-modal__hint">Aucun build pour l'instant.</p>}
      {status === "ready" && builds.length > 0 && (
        <div className="iac-run-list">
          {builds.map((b) => (
            <div key={b.runId} className={`iac-run-item iac-run-item--${b.status}`}>
              <span className="cell-mono">{b.runId.slice(0, 8)}</span>
              <span className="iac-run-item__meta">
                {BUILD_STATUS_LABEL[b.status]} · {formatDate(b.finishedAt)}
                {b.artifact ? ` · ${b.artifact.reference}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="graph-popover__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}
