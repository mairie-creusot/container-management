import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchContainerDetail } from "@/features/containers/containersSlice";
import { fetchImages, fetchScanDetail, fetchScans, scanImage } from "@/features/images/imagesSlice";
import { fetchVolumes } from "@/features/volumes/volumesSlice";
import { fetchNetworks } from "@/features/networks/networksSlice";
import { canOperate } from "@/features/auth/authSlice";
import Modal from "@/components/Modal";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import { KIND_ICON, formatMem, idWithoutPrefix } from "@/components/topologyGraphShared";
import type { TopologyNode, VulnSeverity } from "@/types";

interface TopologyNodeDetailModalProps {
  /** Nœud dont on affiche le détail complet — null referme la modal (voir Modal.tsx#open). */
  node: TopologyNode | null;
  onClose: () => void;
}

const SEVERITY_ORDER: VulnSeverity[] = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
const SEVERITY_SEMANTIC: Record<VulnSeverity, "critical" | "warning" | "neutral"> = {
  Critical: "critical",
  High: "critical",
  Medium: "warning",
  Low: "neutral",
  Negligible: "neutral",
  Unknown: "neutral",
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthcheck OK",
  unhealthy: "Healthcheck en échec",
  starting: "Healthcheck en cours de démarrage",
  none: "Pas de healthcheck défini",
};
const HEALTH_SEMANTIC: Record<string, "success" | "critical" | "warning" | "neutral"> = {
  healthy: "success",
  unhealthy: "critical",
  starting: "warning",
  none: "neutral",
};

/** Heuristique de masquage des variables d'environnement qui RESSEMBLENT à un secret par leur nom
 * de clé — ce composant n'a aucune idée de ce qui est un VRAI secret géré par le gestionnaire de
 * secrets de l'app (SecretRef, écrit-seul côté API) : mieux vaut masquer par prudence une variable
 * qui n'en est pas vraiment un que l'inverse. */
const SECRET_KEY_PATTERN = /PASSWORD|SECRET|TOKEN|KEY/i;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Ligne "clé = valeur" d'une variable d'environnement, avec révélation à la demande si la clé
 * ressemble à un secret — même esprit visuel que .kv-row (KeyValueList) mais avec un bouton en
 * plus, donc composant dédié plutôt qu'un détournement de KeyValueList. */
function EnvVarRow({ entry }: { entry: string }) {
  const [revealed, setRevealed] = useState(false);
  const eq = entry.indexOf("=");
  const key = eq >= 0 ? entry.slice(0, eq) : entry;
  const value = eq >= 0 ? entry.slice(eq + 1) : "";
  const looksSecret = SECRET_KEY_PATTERN.test(key);
  const masked = looksSecret && !revealed;
  return (
    <div className="kv-row">
      <span className="kv-row__key">{key}</span>
      <span className="env-var-row__value-wrap">
        <span className="kv-row__value">{masked ? "••••••••" : value || "—"}</span>
        {looksSecret && (
          <button type="button" className="env-var-row__reveal" onClick={() => setRevealed((r) => !r)}>
            {revealed ? "masquer" : "afficher"}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Modal de détail complet ouverte depuis "Voir le détail" (menu contextuel d'un nœud du graphe de
 * topologie, voir TopologyGraph.tsx) — contrairement au résumé déjà affiché SUR le nœud
 * (TopologyNode, juste de quoi peupler des badges), cette modal va chercher le détail réel :
 * `GET /api/containers/:id` pour un conteneur, la vraie liste de vulnérabilités du dernier scan
 * réussi de son image (`GET /api/images/:id/scans`), et les objets complets `DockerVolume`/
 * `DockerNetwork` déjà exposés par `GET /api/volumes`/`GET /api/networks` pour les deux autres
 * kinds Docker. Rien n'est inventé : un champ absent reste absent, un scan jamais lancé le dit
 * explicitement plutôt que d'afficher une liste vide silencieuse.
 */
export default function TopologyNodeDetailModal({ node, onClose }: TopologyNodeDetailModalProps) {
  const dispatch = useAppDispatch();
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  const { detail, detailStatus } = useAppSelector((s) => s.containers);
  const images = useAppSelector((s) => s.images.items);
  const scansByImageId = useAppSelector((s) => s.images.scansByImageId);
  const scanStatus = useAppSelector((s) => s.images.scanStatus);
  const scanError = useAppSelector((s) => s.images.scanError);
  const volumes = useAppSelector((s) => s.volumes.items);
  const networks = useAppSelector((s) => s.networks.items);

  const open = node !== null;
  const kind = node?.kind;
  const rawId = node ? idWithoutPrefix(node.id) : "";

  // Récupère le détail complet selon le kind à l'ouverture (ou changement de nœud) — les résumés
  // déjà présents sur `node` (TopologyNode) ne suffisent pas pour cette vue.
  useEffect(() => {
    if (!node) return;
    if (node.kind === "container") {
      dispatch(fetchContainerDetail(rawId));
      dispatch(fetchImages());
    } else if (node.kind === "volume") {
      dispatch(fetchVolumes());
    } else if (node.kind === "network") {
      dispatch(fetchNetworks());
    }
    // nutanix-vm : rien à charger, TopologyNode porte déjà tout le détail disponible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, node?.id, node?.kind]);

  // Image suivie (ImageRef) correspondant à "name:tag" du conteneur — même rapprochement par nom
  // que services/topology.ts#vulnSummaryForImage côté serveur (node.subtitle = c.Image = "name:tag").
  const imageRef = kind === "container" ? images.find((i) => `${i.name}:${i.currentTag}` === node!.subtitle) ?? null : null;

  useEffect(() => {
    if (imageRef) dispatch(fetchScans(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, imageRef?.id]);

  const scans = imageRef ? scansByImageId[imageRef.id] ?? [] : [];
  // "Dernier scan réussi" au sens strict — pas juste le plus récent des scans (qui peut être un
  // scan en cours ou échoué alors qu'un scan plus ancien, réussi, a de vraies données à montrer).
  const latestSuccess = scans.find((s) => s.status === "success") ?? null;
  const latestOverall = scans[0] ?? null;

  // Poll pendant qu'un scan tourne — même principe que ImagesPage.tsx, pour que la modal se mette
  // à jour toute seule si l'utilisateur vient de lancer un scan depuis ici.
  useEffect(() => {
    if (!imageRef || !latestOverall || latestOverall.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchScanDetail({ imageId: imageRef.id, scanId: latestOverall.id }));
    }, 2000);
    return () => clearInterval(interval);
  }, [dispatch, imageRef, latestOverall]);

  if (!node) {
    return (
      <Modal open={false} onClose={onClose}>
        {null}
      </Modal>
    );
  }

  const Icon = KIND_ICON[node.kind];
  const isContainerDetailReady = kind === "container" && detailStatus === "ready" && detail?.id === rawId;
  const volume = kind === "volume" ? volumes.find((v) => v.name === rawId) ?? null : null;
  const network = kind === "network" ? networks.find((n) => n.id === rawId) ?? null : null;

  function handleLaunchScan() {
    if (imageRef) dispatch(scanImage({ id: imageRef.id }));
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="topology-detail-title">
      <div className="topology-detail-modal">
        <div className="topology-detail-modal__header">
          <span className={`topology-detail-modal__icon topology-detail-modal__icon--${node.kind}`}>
            <Icon />
          </span>
          <div className="topology-detail-modal__heading">
            <div id="topology-detail-title" className="topology-detail-modal__title">
              {node.label}
            </div>
            <div className="topology-detail-modal__subtitle">{node.subtitle}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Fermer
          </button>
        </div>

        <div className="topology-detail-modal__body">
          <div className="chip-row">
            <StatusPill status={node.status} />
            {node.kind === "container" && node.healthStatus && (
              <span className={`status-pill status-pill--${HEALTH_SEMANTIC[node.healthStatus]}`}>
                {HEALTH_LABEL[node.healthStatus]}
              </span>
            )}
            {node.updateAvailable && <span className="status-pill status-pill--warning">Mise à jour d'image disponible</span>}
            {node.drift && <span className="status-pill status-pill--critical">Dérive GitOps détectée</span>}
          </div>

          {/* --- Conteneur ---------------------------------------------------------------- */}
          {node.kind === "container" && (
            <>
              {typeof node.cpuPercent === "number" && (
                <>
                  <Gauge label="CPU" percent={node.cpuPercent} />
                  <KeyValueList rows={[{ key: "Mémoire", value: formatMem(node.memBytes ?? 0) }]} />
                </>
              )}

              {detailStatus === "loading" && <div className="empty-state">Chargement du détail…</div>}
              {detailStatus === "error" && <div className="error-banner">Impossible de charger le détail de ce conteneur.</div>}

              {isContainerDetailReady && detail && (
                <>
                  <div className="inspector-section-title">Détail</div>
                  <KeyValueList
                    rows={[
                      { key: "ID complet", value: detail.fullId },
                      { key: "Créé le", value: formatDate(detail.createdAt) },
                      { key: "Commande", value: detail.command || "—" },
                      { key: "Politique de redémarrage", value: detail.restartPolicy },
                      { key: "Network", value: detail.networkMode },
                    ]}
                  />

                  {detail.ports.length > 0 && (
                    <>
                      <div className="inspector-section-title">Ports</div>
                      <KeyValueList
                        rows={detail.ports.map((p) => ({
                          key: `${p.containerPort}/${p.proto}`,
                          value: p.hostPort ? `→ ${p.hostPort}` : "non publié",
                        }))}
                      />
                    </>
                  )}

                  {detail.mounts.length > 0 && (
                    <>
                      <div className="inspector-section-title">Volumes montés</div>
                      <KeyValueList
                        rows={detail.mounts.map((m) => ({
                          key: m.destination,
                          value: `${m.source}${m.readOnly ? " (ro)" : ""}`,
                        }))}
                      />
                    </>
                  )}

                  {Object.keys(detail.labels).length > 0 && (
                    <>
                      <div className="inspector-section-title">Labels</div>
                      <KeyValueList rows={Object.entries(detail.labels).map(([key, value]) => ({ key, value }))} />
                    </>
                  )}

                  {detail.env.length > 0 && (
                    <>
                      <div className="inspector-section-title">
                        Variables d'environnement
                        <span className="topology-detail-modal__hint"> — les clés ressemblant à un secret sont masquées</span>
                      </div>
                      <div className="kv-list">
                        {detail.env.map((entry, index) => (
                          <EnvVarRow key={`${entry}-${index}`} entry={entry} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}

              <div className="inspector-section-title">
                Vulnérabilités{imageRef ? ` (image ${imageRef.name}:${imageRef.currentTag})` : ""}
              </div>
              {!imageRef && <div className="empty-state">Image introuvable parmi les images suivies.</div>}
              {imageRef && scans.length === 0 && (
                <div className="empty-state">
                  Aucun scan n'a jamais été effectué pour cette image.
                  {operate && (
                    <div className="topology-detail-modal__scan-cta">
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
                    <div className="topology-detail-modal__scan-cta">
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
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="topology-detail-modal__hint">
                    {latestSuccess.scanner === "grype" ? "Grype" : "OSV-Scanner"} · terminé {formatDate(latestSuccess.finishedAt)}
                  </p>
                </>
              )}
            </>
          )}

          {/* --- Volume -------------------------------------------------------------------- */}
          {node.kind === "volume" && (
            <>
              {!volume && <div className="empty-state">Chargement du détail du volume…</div>}
              {volume && (
                <>
                  <KeyValueList
                    rows={[
                      { key: "Nom", value: volume.name },
                      { key: "Driver", value: volume.driver },
                      { key: "Point de montage", value: volume.mountpoint },
                      { key: "Scope", value: volume.scope },
                      { key: "Créé le", value: formatDate(volume.createdAt) },
                      { key: "Utilisé par", value: `${volume.inUseBy} conteneur(s)` },
                    ]}
                  />
                  {Object.keys(volume.labels).length > 0 && (
                    <>
                      <div className="inspector-section-title">Labels</div>
                      <KeyValueList rows={Object.entries(volume.labels).map(([key, value]) => ({ key, value }))} />
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* --- Network --------------------------------------------------------------------- */}
          {node.kind === "network" && (
            <>
              {!network && <div className="empty-state">Chargement du détail du network…</div>}
              {network && (
                <KeyValueList
                  rows={[
                    { key: "Nom", value: network.name },
                    { key: "Driver", value: network.driver },
                    { key: "Scope", value: network.scope },
                    { key: "Conteneurs attachés", value: String(network.containerCount) },
                    { key: "Créé le", value: formatDate(network.createdAt) },
                    { key: "Interne", value: network.internal ? "Oui" : "Non" },
                  ]}
                />
              )}
            </>
          )}

          {/* --- VM Nutanix -------------------------------------------------------------------- */}
          {node.kind === "nutanix-vm" && (
            <KeyValueList
              rows={[
                { key: "Cluster", value: node.subtitle },
                { key: "vCPUs", value: String(node.numVcpus ?? "—") },
                { key: "Mémoire", value: node.memoryMib ? formatMem(node.memoryMib * 1024 * 1024) : "—" },
                { key: "État d'alimentation", value: node.status === "running" ? "Allumée" : node.status === "stopped" ? "Éteinte" : "Indéterminé" },
              ]}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
