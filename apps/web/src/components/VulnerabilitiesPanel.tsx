import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchScanDetail, fetchScans, scanImage } from "@/features/images/imagesSlice";
import type { ImageRef, VulnSeverity } from "@/types";

const SEVERITY_ORDER: VulnSeverity[] = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
const SEVERITY_SEMANTIC: Record<VulnSeverity, "critical" | "warning" | "neutral"> = {
  Critical: "critical",
  High: "critical",
  Medium: "warning",
  Low: "neutral",
  Negligible: "neutral",
  Unknown: "neutral",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Bloc "Vulnérabilités" (vrais Grype/OSV-Scanner, voir apps/api/src/services/scan.ts) — EXTRAIT le
 * 13/08/2026 de TopologyNodeDetailPanel.tsx (onglet "Vulnérabilités") pour être réutilisé À
 * L'IDENTIQUE dans TopologySubGraphPanel.tsx § "Composition interne" (retour utilisateur : "il faut
 * grâce à grype/syft/osv... voir quel paquet est critique et pourquoi") — même données, même
 * composant, jamais une seconde implémentation qui pourrait diverger.
 *
 * Auto-suffisant : orchestre lui-même son fetch (GET /api/images/:id/scans) et son polling pendant
 * qu'un scan tourne — l'appelant n'a besoin de fournir que `imageRef` (déjà résolu par lui,
 * rapprochement par "name:tag" — voir services/topology.ts#vulnSummaryForImage côté serveur) et
 * `operate` (le bouton "Lancer un scan" reste réservé operator/admin, comme toute action mutante).
 *
 * `onInspectPackage` (optionnel, ajouté le 13/08/2026 pour la fusion Dépendances/Composition
 * interne — voir TopologySubGraphPanel.tsx) : quand fourni, affiche un petit déclencheur
 * "Fichiers" sur chaque ligne de vulnérabilité — l'appelant décide seul de ce qu'il en fait (ici :
 * ouvrir le panneau "paquet -> fichiers réels", GET /api/images/:id/packages/:packageName/files).
 * Absent (TopologyNodeDetailPanel.tsx, onglet "Vulnérabilités" d'origine) : aucune colonne
 * supplémentaire, comportement strictement inchangé.
 */
export default function VulnerabilitiesPanel({
  imageRef,
  operate,
  onInspectPackage,
}: {
  imageRef: ImageRef | null;
  operate: boolean;
  onInspectPackage?: (packageName: string) => void;
}) {
  const dispatch = useAppDispatch();
  const scansByImageId = useAppSelector((s) => s.images.scansByImageId);
  const scanStatus = useAppSelector((s) => s.images.scanStatus);
  const scanError = useAppSelector((s) => s.images.scanError);

  useEffect(() => {
    if (imageRef) dispatch(fetchScans(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, imageRef?.id]);

  const scans = imageRef ? scansByImageId[imageRef.id] ?? [] : [];
  // "Dernier scan réussi" au sens strict — pas juste le plus récent des scans (qui peut être en
  // cours ou échoué alors qu'un scan plus ancien, réussi, a de vraies données à montrer).
  const latestSuccess = scans.find((s) => s.status === "success") ?? null;
  const latestOverall = scans[0] ?? null;

  // Poll pendant qu'un scan tourne — se met à jour tout seul si l'utilisateur vient d'en lancer un.
  useEffect(() => {
    if (!imageRef || !latestOverall || latestOverall.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchScanDetail({ imageId: imageRef.id, scanId: latestOverall.id }));
    }, 2000);
    return () => clearInterval(interval);
  }, [dispatch, imageRef, latestOverall]);

  function handleLaunchScan() {
    if (imageRef) dispatch(scanImage({ id: imageRef.id }));
  }

  return (
    <div className="topology-detail-panel__vulns">
      <div className="inspector-section-title">{imageRef ? `Image ${imageRef.name}:${imageRef.currentTag}` : "Vulnérabilités"}</div>
      {!imageRef && <div className="empty-state">Image introuvable parmi les images suivies.</div>}
      {imageRef && scans.length === 0 && (
        <div className="empty-state">
          Aucun scan n'a jamais été effectué pour cette image.
          {operate && (
            <div className="topology-detail-panel__scan-cta">
              <button type="button" className="btn btn-secondary btn-sm" disabled={scanStatus === "starting"} onClick={handleLaunchScan}>
                {scanStatus === "starting" ? "Lancement…" : "Lancer un scan (Grype)"}
              </button>
            </div>
          )}
        </div>
      )}
      {imageRef && scans.length > 0 && !latestSuccess && (
        <div className="empty-state">
          {latestOverall?.status === "running"
            ? "Un scan est en cours pour cette image…"
            : "Le dernier scan de cette image a échoué, aucune vulnérabilité connue à afficher."}
          {operate && latestOverall?.status !== "running" && (
            <div className="topology-detail-panel__scan-cta">
              <button type="button" className="btn btn-secondary btn-sm" disabled={scanStatus === "starting"} onClick={handleLaunchScan}>
                {scanStatus === "starting" ? "Lancement…" : "Relancer un scan (Grype)"}
              </button>
            </div>
          )}
        </div>
      )}
      {scanStatus === "error" && scanError && <div className="error-banner">{scanError}</div>}
      {latestSuccess && (
        <>
          <div className="scan-summary">
            {latestSuccess.vulnerabilities.length === 0 ? (
              <span className="status-pill status-pill--success">Aucune vulnérabilité connue</span>
            ) : (
              SEVERITY_ORDER.filter((sev) => latestSuccess.summary[sev] > 0).map((sev) => (
                <span key={sev} className={`status-pill status-pill--${SEVERITY_SEMANTIC[sev]}`}>
                  {sev} · {latestSuccess.summary[sev]}
                </span>
              ))
            )}
          </div>
          {latestSuccess.vulnerabilities.length > 0 && (
            // Scroll INTERNE cantonné à cette table (max-height, voir topology.css) plutôt que le
            // panneau entier — la seule section qui peut légitimement dépasser sa hauteur (des
            // dizaines de CVE sur une image mal maintenue).
            <div className="data-table-wrap scan-vuln-table-wrap topology-detail-panel__vuln-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>CVE</th>
                    <th>Sévérité</th>
                    <th>Paquet</th>
                    <th>Version</th>
                    <th>Corrigé</th>
                    {onInspectPackage && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {latestSuccess.vulnerabilities
                    .slice()
                    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
                    .map((vuln) => (
                      <tr key={`${vuln.id}-${vuln.packageName}-${vuln.installedVersion}`}>
                        <td className="cell-mono">{vuln.id}</td>
                        <td>
                          <span className={`status-pill status-pill--${SEVERITY_SEMANTIC[vuln.severity]}`}>{vuln.severity}</span>
                        </td>
                        <td>{vuln.packageName}</td>
                        <td className="cell-mono">{vuln.installedVersion}</td>
                        <td className="cell-mono">{vuln.fixedInVersion ?? "—"}</td>
                        {onInspectPackage && (
                          <td>
                            <button
                              type="button"
                              className="topology-interior__link-btn"
                              onClick={() => onInspectPackage(vuln.packageName)}
                              title={`Retrouver les fichiers réels de "${vuln.packageName}" dans l'image`}
                            >
                              Fichiers
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="topology-detail-panel__hint">
            {latestSuccess.scanner === "grype" ? "Grype" : "OSV-Scanner"} · terminé {formatDate(latestSuccess.finishedAt)}
          </p>
        </>
      )}
    </div>
  );
}
