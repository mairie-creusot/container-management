import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { loadOverview } from "@/features/overview/overviewSlice";
import AreaChart from "@/components/AreaChart";
import Donut from "@/components/Donut";
import TopologyGraph from "@/components/TopologyGraph";
import Inspector from "@/components/Inspector";
import KeyValueList from "@/components/KeyValueList";
import StatusPill from "@/components/StatusPill";
import Skeleton from "@/components/Skeleton";
import { registryMeta } from "@/components/RegistryBadge";
import type { TopologyNode } from "@/types";

// Le graphe est désormais la pièce centrale du dashboard : il porte lui-même les informations
// qui étaient auparavant dans des stat-cards séparées (mise à jour d'image, dérive GitOps,
// CPU/mémoire — voir les badges sur chaque nœud dans TopologyGraph.tsx). Rafraîchissement plus
// fréquent qu'avant (15s), sans spammer l'API pour autant.
const REFRESH_INTERVAL_MS = 9_000;

const KIND_LABEL: Record<TopologyNode["kind"], string> = {
  container: "Conteneur",
  volume: "Volume",
  network: "Network",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

export default function OverviewPage() {
  const dispatch = useAppDispatch();
  const { status, error, stats, utilisation, registrySegments, recentCommits, lastRefreshedAt } = useAppSelector(
    (state) => state.overview,
  );
  const [selected, setSelected] = useState<TopologyNode | null>(null);
  // Premier chargement (aucune donnée encore reçue) : affiche des squelettes à la place du
  // texte "Chargement…" — voir apps/web/src/components/Skeleton.tsx.
  const isInitialLoading = status === "loading" && !stats;

  useEffect(() => {
    dispatch(loadOverview());
    // Rafraîchissement périodique tant que la page est ouverte — coupé quand l'onglet est en
    // arrière-plan (visibilitychange) pour ne pas taper l'API sans que personne ne regarde.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(loadOverview());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch]);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Vue d'ensemble</h2>
            <p>
              Infrastructure en direct — clic droit pour créer/gérer une ressource, glisser un
              conteneur vers un network pour le connecter.
              {stats && (
                <>
                  {" "}
                  <span className={stats.healthyNodes === stats.totalNodes ? "" : "overview-summary--warning"}>
                    {stats.healthyNodes}/{stats.totalNodes} environnement(s) sain(s)
                  </span>
                  .
                </>
              )}
            </p>
          </div>
          {lastRefreshedAt && (
            <span className="overview-refresh-hint">
              <span className="overview-refresh-dot" />
              Actualisé à {formatTime(lastRefreshedAt)} · toutes les {REFRESH_INTERVAL_MS / 1000}s
            </span>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <TopologyGraph
          height={Math.max(460, Math.min(760, window.innerHeight - 420))}
          onSelectNode={setSelected}
          refreshIntervalMs={REFRESH_INTERVAL_MS}
        />

        <div className="overview-grid" style={{ marginTop: 18 }}>
          <div className="panel">
            <div className="panel__title">Utilisation du cluster (historique en direct)</div>
            {isInitialLoading ? (
              <Skeleton height={180} />
            ) : (
              <AreaChart
                labels={utilisation.map((point) => point.label)}
                series={[
                  { name: "CPU %", color: "var(--accent-end)", values: utilisation.map((p) => p.cpuPercent) },
                  { name: "Mémoire %", color: "var(--registry-harbor)", values: utilisation.map((p) => p.memPercent) },
                ]}
              />
            )}
          </div>
          <div className="panel">
            <div className="panel__title">Images par registry</div>
            {isInitialLoading ? (
              <div className="donut-wrap">
                <Skeleton variant="circle" width={118} height={118} />
                <div className="donut-legend">
                  <Skeleton variant="text" height={12} width="70%" />
                  <Skeleton variant="text" height={12} width="55%" />
                  <Skeleton variant="text" height={12} width="60%" />
                </div>
              </div>
            ) : (
              <Donut
                segments={registrySegments.map((segment) => ({
                  label: segment.name,
                  value: segment.value,
                  color: registryMeta(segment.kind).color,
                }))}
              />
            )}
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel__title">Activité récente (commits GitOps)</div>
          {isInitialLoading ? (
            <div className="activity-list">
              {Array.from({ length: 4 }).map((_, index) => (
                <div className="activity-item" key={index}>
                  <span className="activity-item__dot" style={{ background: "var(--color-surface-3)" }} />
                  <div style={{ flex: 1 }}>
                    <Skeleton variant="text" height={12} width="70%" />
                    <Skeleton variant="text" height={10} width="40%" style={{ marginTop: 6 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : recentCommits.length === 0 ? (
            <div className="empty-state">Aucune activité récente.</div>
          ) : (
            <div className="activity-list">
              {recentCommits.map((commit) => (
                <div className="activity-item" key={commit.hash}>
                  <span className="activity-item__dot" />
                  <div>
                    <div className="activity-item__message">{commit.message}</div>
                    <div className="activity-item__meta">
                      {commit.author} · {commit.hash.slice(0, 7)} · {formatDate(commit.date)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Inspector
        title={selected?.label}
        subtitle={selected ? KIND_LABEL[selected.kind] : undefined}
        onClose={() => setSelected(null)}
        emptyLabel="Cliquez sur un nœud du graphe pour voir son détail (clic droit pour les actions)."
      >
        {selected && (
          <>
            <StatusPill status={selected.status} />
            <KeyValueList
              rows={[
                { key: "Type", value: KIND_LABEL[selected.kind] },
                { key: "Détail", value: selected.subtitle },
                ...(selected.kind === "container" && typeof selected.cpuPercent === "number"
                  ? [
                      { key: "CPU", value: `${selected.cpuPercent.toFixed(0)}%` },
                      { key: "Mémoire", value: formatMem(selected.memBytes ?? 0) },
                      { key: "Mise à jour d'image", value: selected.updateAvailable ? "Disponible" : "À jour" },
                      { key: "Dérive GitOps", value: selected.drift ? "Détectée" : "Aucune" },
                    ]
                  : []),
              ]}
            />
          </>
        )}
      </Inspector>
    </div>
  );
}
