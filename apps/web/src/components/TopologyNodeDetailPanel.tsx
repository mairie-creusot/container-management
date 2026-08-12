import { useEffect, useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchContainerDetail } from "@/features/containers/containersSlice";
import { fetchImages, fetchScanDetail, fetchScans, scanImage } from "@/features/images/imagesSlice";
import { fetchVolumes } from "@/features/volumes/volumesSlice";
import { fetchNetworks } from "@/features/networks/networksSlice";
import { canOperate } from "@/features/auth/authSlice";
import { apiGet } from "@/api/client";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import MetricsChart from "@/components/MetricsChart";
import { KIND_ICON, formatMem, idWithoutPrefix } from "@/components/topologyGraphShared";
import type { ContainerMetricPoint, Topology, TopologyNode, TopologyNodeKind, VulnSeverity } from "@/types";

/** Rafraîchissement de l'onglet "Métriques" pendant qu'il est affiché — même ordre de grandeur que
 * config.metrics.intervalMs côté API (30s par défaut) : inutile de sonder plus vite qu'un nouveau
 * point n'est réellement écrit par metricsCollector.ts. */
const METRICS_POLL_MS = 30_000;

interface TopologyNodeDetailPanelProps {
  /** Nœud dont on affiche le détail complet — null referme le panneau. */
  node: TopologyNode | null;
  /**
   * Graphe complet déjà chargé côté client — sert UNIQUEMENT à reconstruire, pour un conteneur, la
   * liste RÉELLE des networks auxquels il est attaché : depuis l'introduction des "briques" (voir
   * services/topology.ts), une partie de ces networks n'a plus d'arête dans `topology.edges`
   * (attachés à ce seul conteneur, voir node.attachments) tandis que l'autre partie (partagés/par
   * défaut) en a toujours une — cette reconstruction recombine les deux pour ne rien perdre.
   * `null` tant que le graphe n'a pas encore chargé (le panneau reste utilisable, juste sans cette
   * liste tant que `topology` n'est pas prêt).
   */
  topology: Topology | null;
  onClose: () => void;
  /** Navigation interne (clic sur un network dans l'onglet "Réseau", ou sur une brique d'un autre
   * nœud) : remplace le nœud affiché SANS fermer/rouvrir le panneau — évite l'aller-retour visuel
   * d'une fermeture suivie d'une réouverture pour simplement changer de ressource inspectée. */
  onNavigate: (node: TopologyNode) => void;
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

type TabId = "overview" | "network" | "volumes" | "variables" | "vulnerabilities" | "metrics";

interface TabDef {
  id: TabId;
  label: string;
}

/** Onglets réels (pas de simples sections empilées) — adaptés au kind : un conteneur a les six,
 * les autres kinds (volume/network/nutanix-vm/ad-server) n'ont qu'un seul aperçu, rien d'autre à montrer de
 * pertinent (pas de ports/volumes/variables/vulnérabilités/métriques pour une ressource qui n'en a pas). */
const CONTAINER_TABS: TabDef[] = [
  { id: "overview", label: "Aperçu" },
  { id: "network", label: "Réseau" },
  { id: "volumes", label: "Volumes" },
  { id: "variables", label: "Variables" },
  { id: "vulnerabilities", label: "Vulnérabilités" },
  { id: "metrics", label: "Métriques" },
];
const OVERVIEW_ONLY_TABS: TabDef[] = [{ id: "overview", label: "Aperçu" }];

function tabsForKind(kind: TopologyNodeKind): TabDef[] {
  return kind === "container" ? CONTAINER_TABS : OVERVIEW_ONLY_TABS;
}

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
      <span className="kv-row__key" title={key}>
        {key}
      </span>
      <span className="env-var-row__value-wrap">
        <span className="kv-row__value" title={masked ? undefined : value || "—"}>
          {masked ? "••••••••" : value || "—"}
        </span>
        {looksSecret && (
          <button type="button" className="env-var-row__reveal" onClick={() => setRevealed((r) => !r)}>
            {revealed ? "masquer" : "afficher"}
          </button>
        )}
      </span>
    </div>
  );
}

interface NetworkAttachmentRow {
  id: string; // "network:<id>"
  label: string;
  subtitle: string; // driver
  shared: boolean; // true = vrai nœud du graphe (partagé ou par défaut), false = brique mono-conteneur
}

/**
 * Panneau de détail complet — ANCRÉ en overlay fixe sur le bord droit du canevas (même pattern
 * d'ancrage que TopologySubGraphPanel.tsx : `position: absolute` à l'intérieur de `.topology-graph`,
 * devenu `position: relative`), à onglets réels, largeur fixe raisonnable, pleine hauteur du
 * canevas, jamais de débordement horizontal — remplace l'ancienne TopologyNodeDetailModal.tsx
 * (modal centrée en grille qui débordait encore horizontalement sur écran étroit). Ouvert depuis
 * "Voir le détail" (menu contextuel d'un nœud OU d'une brique volume/network, voir
 * TopologyGraph.tsx/topologyGraphShared.tsx#GraphNode) ou par navigation interne (`onNavigate`).
 *
 * Rien n'est inventé : `GET /api/containers/:id` pour un conteneur, la vraie liste de
 * vulnérabilités du dernier scan réussi de son image (`GET /api/images/:id/scans`), et les objets
 * complets `DockerVolume`/`DockerNetwork` déjà exposés par `GET /api/volumes`/`GET /api/networks`
 * pour les deux autres kinds Docker — y compris pour une ressource "briquée" (plus un nœud
 * top-level du graphe, mais toujours une vraie ressource Docker avec son propre détail complet).
 */
export default function TopologyNodeDetailPanel({ node, topology, onClose, onNavigate }: TopologyNodeDetailPanelProps) {
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

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [metricsPoints, setMetricsPoints] = useState<ContainerMetricPoint[]>([]);
  const [metricsStatus, setMetricsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const kind = node?.kind;
  const rawId = node ? idWithoutPrefix(node.id) : "";

  // Nouveau nœud affiché (y compris via navigation interne) -> repart toujours sur l'onglet Aperçu,
  // jamais bloqué sur un onglet qui n'existe pas pour le nouveau kind (ex: "Vulnérabilités" en
  // arrivant sur un volume).
  useEffect(() => {
    setActiveTab("overview");
    // Idem pour les métriques : jamais afficher un vieux point d'un précédent conteneur pendant
    // le chargement du nouveau (voir l'effet de fetch ci-dessous, gardé par `activeTab === "metrics"`).
    setMetricsPoints([]);
    setMetricsStatus("idle");
  }, [node?.id]);

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
    // nutanix-vm/ad-server : rien à charger, TopologyNode porte déjà tout le détail disponible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, node?.id, node?.kind]);

  // Escape referme le panneau — pas de piège de focus/backdrop façon <Modal> : ce n'est pas une
  // boîte de dialogue modale bloquante, mais un panneau ancré façon Railway/VSCode, le reste du
  // canevas reste utilisable pendant qu'il est ouvert.
  useEffect(() => {
    if (!node) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [node, onClose]);

  // Image suivie (ImageRef) correspondant à "name:tag" du conteneur — même rapprochement par nom
  // que services/topology.ts#vulnSummaryForImage côté serveur (node.subtitle = c.Image = "name:tag").
  const imageRef = kind === "container" ? images.find((i) => `${i.name}:${i.currentTag}` === node!.subtitle) ?? null : null;

  useEffect(() => {
    if (imageRef) dispatch(fetchScans(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, imageRef?.id]);

  // Onglet "Métriques" : chargé à la demande (pas à l'ouverture du panneau, contrairement au
  // détail/aux scans) — GET /api/containers/:id/metrics peut porter jusqu'à 7 jours d'historique
  // (config.metrics.retentionMs côté API), inutile de le récupérer si l'utilisateur ne consulte
  // jamais cet onglet. Rafraîchi périodiquement tant que l'onglet reste affiché (voir
  // METRICS_POLL_MS) pour suivre les nouveaux points écrits par metricsCollector.ts.
  useEffect(() => {
    if (!node || node.kind !== "container" || activeTab !== "metrics") return;
    let cancelled = false;
    async function load() {
      setMetricsStatus((s) => (s === "ready" ? s : "loading"));
      try {
        const points = await apiGet<ContainerMetricPoint[]>(`/containers/${rawId}/metrics`);
        if (!cancelled) {
          setMetricsPoints(points);
          setMetricsStatus("ready");
        }
      } catch {
        if (!cancelled) setMetricsStatus("error");
      }
    }
    void load();
    const interval = setInterval(() => void load(), METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [node, activeTab, rawId]);

  const scans = imageRef ? scansByImageId[imageRef.id] ?? [] : [];
  // "Dernier scan réussi" au sens strict — pas juste le plus récent des scans (qui peut être un
  // scan en cours ou échoué alors qu'un scan plus ancien, réussi, a de vraies données à montrer).
  const latestSuccess = scans.find((s) => s.status === "success") ?? null;
  const latestOverall = scans[0] ?? null;

  // Poll pendant qu'un scan tourne — même principe que ImagesPage.tsx, pour que le panneau se
  // mette à jour tout seul si l'utilisateur vient de lancer un scan depuis ici.
  useEffect(() => {
    if (!imageRef || !latestOverall || latestOverall.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchScanDetail({ imageId: imageRef.id, scanId: latestOverall.id }));
    }, 2000);
    return () => clearInterval(interval);
  }, [dispatch, imageRef, latestOverall]);

  // Reconstruction de la liste RÉELLE des networks connectés à ce conteneur : les networks restés
  // "vrais nœuds" (partagés/par défaut) via les arêtes de `topology`, PLUS les networks "briqués"
  // (mono-conteneur) via node.attachments — voir la doc du prop `topology` ci-dessus, les deux
  // ensembles sont complémentaires et exhaustifs, jamais de recoupement.
  const networkAttachments = useMemo<NetworkAttachmentRow[]>(() => {
    if (!node || node.kind !== "container") return [];
    const rows: NetworkAttachmentRow[] = [];
    if (topology) {
      const nodesById = new Map(topology.nodes.map((n) => [n.id, n]));
      for (const edge of topology.edges) {
        if (edge.kind !== "network") continue;
        const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
        if (!otherId) continue;
        const other = nodesById.get(otherId);
        if (other) rows.push({ id: other.id, label: other.label, subtitle: other.subtitle, shared: true });
      }
    }
    for (const attachment of node.attachments ?? []) {
      if (attachment.kind !== "network") continue;
      rows.push({ id: attachment.id, label: attachment.label, subtitle: attachment.subtitle, shared: false });
    }
    return rows;
  }, [node, topology]);

  if (!node) return null;

  const Icon = KIND_ICON[node.kind];
  const isContainerDetailReady = kind === "container" && detailStatus === "ready" && detail?.id === rawId;
  const volume = kind === "volume" ? volumes.find((v) => v.name === rawId) ?? null : null;
  const network = kind === "network" ? networks.find((n) => n.id === rawId) ?? null : null;
  const tabs = tabsForKind(node.kind);

  // Plafonds de référence RÉELS pour l'onglet "Métriques" (façon Railway "Max 8 vCPU"/"Max 8 GB")
  // — uniquement si une limite a effectivement été configurée à la création du conteneur
  // (HostConfig.Memory/NanoCpus, voir ContainerDetail), jamais une valeur inventée. cpuPercent est
  // normalisé par `onlineCpus * 100` côté API (docker.ts#readContainerUsage) : un NanoCpus de
  // 500 000 000 (0,5 cœur) plafonne donc à 50, pas à 100.
  const maxCpuPercent =
    isContainerDetailReady && detail?.nanoCpus ? (detail.nanoCpus / 1_000_000_000) * 100 : undefined;
  const maxMemBytes = isContainerDetailReady ? detail?.memoryLimitBytes : undefined;

  function handleLaunchScan() {
    if (imageRef) dispatch(scanImage({ id: imageRef.id }));
  }

  function openNetworkAttachment(row: NetworkAttachmentRow) {
    onNavigate({ id: row.id, kind: "network", label: row.label, subtitle: row.subtitle, status: "running" });
  }

  return (
    <div className="topology-detail-panel" role="region" aria-label={`Détail de « ${node.label} »`}>
      <div className="topology-detail-panel__header">
        <span className={`topology-detail-panel__icon topology-detail-panel__icon--${node.kind}`}>
          <Icon />
        </span>
        <div className="topology-detail-panel__heading">
          <div className="topology-detail-panel__title" title={node.label}>
            {node.label}
          </div>
          <div className="topology-detail-panel__subtitle" title={node.subtitle}>
            {node.subtitle}
          </div>
        </div>
        <button type="button" className="topology-detail-panel__close" onClick={onClose} title="Fermer" aria-label="Fermer">
          ✕
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="topology-detail-panel__tabs" role="tablist" aria-label="Sections du détail">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`topology-detail-panel__tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="topology-detail-panel__body">
        {/* --- Conteneur ---------------------------------------------------------------- */}
        {node.kind === "container" && activeTab === "overview" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
              {node.healthStatus && (
                <span className={`status-pill status-pill--${HEALTH_SEMANTIC[node.healthStatus]}`}>
                  {HEALTH_LABEL[node.healthStatus]}
                </span>
              )}
              {node.updateAvailable && <span className="status-pill status-pill--warning">Mise à jour d'image disponible</span>}
              {node.drift && <span className="status-pill status-pill--critical">Dérive GitOps détectée</span>}
            </div>

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
                    { key: "Mode network", value: detail.networkMode },
                  ]}
                />
              </>
            )}

            {isContainerDetailReady && detail && Object.keys(detail.labels).length > 0 && (
              <>
                <div className="inspector-section-title">Labels</div>
                <KeyValueList rows={Object.entries(detail.labels).map(([key, value]) => ({ key, value }))} />
              </>
            )}
          </>
        )}

        {node.kind === "container" && activeTab === "network" && (
          <>
            {isContainerDetailReady && detail && (
              <KeyValueList rows={[{ key: "Mode network", value: detail.networkMode }]} />
            )}

            <div className="inspector-section-title">Ports</div>
            {isContainerDetailReady && detail && detail.ports.length === 0 && (
              <div className="empty-state">Aucun port exposé.</div>
            )}
            {isContainerDetailReady && detail && detail.ports.length > 0 && (
              <KeyValueList
                rows={detail.ports.map((p) => ({
                  key: `${p.containerPort}/${p.proto}`,
                  value: p.hostPort ? `→ ${p.hostPort}` : "non publié",
                }))}
              />
            )}

            <div className="inspector-section-title">Networks connectés</div>
            {networkAttachments.length === 0 && <div className="empty-state">Aucun network connecté.</div>}
            {networkAttachments.length > 0 && (
              <ul className="topology-detail-panel__attachment-list">
                {networkAttachments.map((row) => (
                  <li key={row.id}>
                    <button type="button" className="topology-detail-panel__attachment-btn" onClick={() => openNetworkAttachment(row)}>
                      <span className="topology-detail-panel__attachment-label" title={row.label}>
                        {row.label}
                      </span>
                      <span className="topology-detail-panel__attachment-meta">
                        {row.subtitle}
                        {!row.shared && " · dédié à ce conteneur"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {node.kind === "container" && activeTab === "volumes" && (
          <>
            {isContainerDetailReady && detail && detail.mounts.length === 0 && (
              <div className="empty-state">Aucun volume monté.</div>
            )}
            {isContainerDetailReady && detail && detail.mounts.length > 0 && (
              <KeyValueList
                rows={detail.mounts.map((m) => ({
                  key: m.destination,
                  value: `${m.source}${m.readOnly ? " (ro)" : ""}`,
                }))}
              />
            )}
            {!isContainerDetailReady && detailStatus === "loading" && <div className="empty-state">Chargement…</div>}
          </>
        )}

        {node.kind === "container" && activeTab === "variables" && (
          <>
            {isContainerDetailReady && detail && detail.env.length === 0 && (
              <div className="empty-state">Aucune variable d'environnement.</div>
            )}
            {isContainerDetailReady && detail && detail.env.length > 0 && (
              <>
                <p className="topology-detail-panel__hint">Les clés ressemblant à un secret sont masquées par défaut.</p>
                <div className="kv-list">
                  {detail.env.map((entry, index) => (
                    <EnvVarRow key={`${entry}-${index}`} entry={entry} />
                  ))}
                </div>
              </>
            )}
            {!isContainerDetailReady && detailStatus === "loading" && <div className="empty-state">Chargement…</div>}
          </>
        )}

        {node.kind === "container" && activeTab === "vulnerabilities" && (
          <div className="topology-detail-panel__vulns">
            <div className="inspector-section-title">
              {imageRef ? `Image ${imageRef.name}:${imageRef.currentTag}` : "Vulnérabilités"}
            </div>
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
                  // Scroll INTERNE cantonné à cette table (max-height, voir topology.css) plutôt
                  // que le panneau entier — la seule section qui peut légitimement dépasser sa
                  // hauteur (des dizaines de CVE sur une image mal maintenue).
                  <div className="data-table-wrap scan-vuln-table-wrap topology-detail-panel__vuln-table-wrap">
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
                <p className="topology-detail-panel__hint">
                  {latestSuccess.scanner === "grype" ? "Grype" : "OSV-Scanner"} · terminé {formatDate(latestSuccess.finishedAt)}
                </p>
              </>
            )}
          </div>
        )}

        {node.kind === "container" && activeTab === "metrics" && (
          <div className="topology-detail-panel__metrics">
            {metricsStatus === "loading" && metricsPoints.length === 0 && (
              <div className="empty-state">Chargement des métriques…</div>
            )}
            {metricsStatus === "error" && <div className="error-banner">Impossible de charger l'historique de métriques.</div>}
            {metricsStatus !== "loading" && metricsStatus !== "error" && metricsPoints.length === 0 && (
              <div className="empty-state">
                Aucun point de métrique connu pour ce conteneur pour l'instant — le scrape périodique
                (toutes les 30s) n'a peut-être pas encore eu l'occasion de tourner.
              </div>
            )}
            {metricsPoints.length > 0 && (
              <>
                <MetricsChart
                  title="CPU"
                  points={metricsPoints.map((p) => ({ timestamp: p.timestamp, value: p.cpuPercent }))}
                  formatValue={(v) => `${v.toFixed(0)}%`}
                  color="var(--accent-start, #3b6fef)"
                  {...(maxCpuPercent !== undefined ? { maxValue: maxCpuPercent } : {})}
                />
                <MetricsChart
                  title="Mémoire"
                  points={metricsPoints.map((p) => ({ timestamp: p.timestamp, value: p.memBytes }))}
                  formatValue={formatMem}
                  color="var(--color-warning)"
                  {...(maxMemBytes !== undefined ? { maxValue: maxMemBytes } : {})}
                />
              </>
            )}
          </div>
        )}

        {/* --- Volume -------------------------------------------------------------------- */}
        {node.kind === "volume" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
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
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
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
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            <KeyValueList
              rows={[
                { key: "Cluster", value: node.subtitle },
                { key: "vCPUs", value: String(node.numVcpus ?? "—") },
                { key: "Mémoire", value: node.memoryMib ? formatMem(node.memoryMib * 1024 * 1024) : "—" },
                { key: "État d'alimentation", value: node.status === "running" ? "Allumée" : node.status === "stopped" ? "Éteinte" : "Indéterminé" },
              ]}
            />
          </>
        )}

        {/* --- Contrôleur de domaine / DNS AD (services/adDns.ts) ----------------------------- */}
        {node.kind === "ad-server" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            <KeyValueList
              rows={[
                { key: "Contrôleur de domaine", value: node.label },
                { key: "Zone DNS", value: node.subtitle },
                {
                  key: "Dernière synchronisation",
                  value:
                    node.status === "running"
                      ? "Réussie — le sous-domaine des routes reverse proxy résout automatiquement"
                      : node.status === "stopped"
                        ? "Échec — voir Paramètres › DNS Active Directory pour le détail"
                        : "Aucune tentative depuis le démarrage de QUAI",
                },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
