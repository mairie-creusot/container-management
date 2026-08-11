import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { loadOverview } from "@/features/overview/overviewSlice";
import { setCurrentView } from "@/features/ui/uiSlice";
import AreaChart from "@/components/AreaChart";
import Donut from "@/components/Donut";
import TopologyGraph from "@/components/TopologyGraph";
import { registryMeta } from "@/components/RegistryBadge";

const REFRESH_INTERVAL_MS = 15_000;

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

export default function OverviewPage() {
  const dispatch = useAppDispatch();
  const { status, error, stats, utilisation, registrySegments, recentCommits, lastRefreshedAt } = useAppSelector(
    (state) => state.overview,
  );

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
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Vue d'ensemble</h2>
          <p>État courant du cluster, des images et de la dérive GitOps.</p>
        </div>
        {lastRefreshedAt && (
          <span className="overview-refresh-hint">
            <span className="overview-refresh-dot" />
            Actualisé à {formatTime(lastRefreshedAt)} · toutes les {REFRESH_INTERVAL_MS / 1000}s
          </span>
        )}
      </div>

      {status === "loading" && !stats && <div className="empty-state">Chargement…</div>}
      {error && <div className="error-banner">{error}</div>}

      {stats && (
        <div className="stat-grid">
          <div className="stat-card stat-card--hero">
            <span className="stat-card__label">Conteneurs actifs</span>
            <span className="stat-card__value">{stats.activeContainers}</span>
            <span className="stat-card__hint">En cours d'exécution</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Images à mettre à jour</span>
            <span className="stat-card__value">{stats.imagesToUpdate}</span>
            <span className={`stat-card__hint ${stats.imagesToUpdate > 0 ? "is-warning" : "is-success"}`}>
              {stats.imagesToUpdate > 0 ? "Nouvelles versions disponibles" : "Tout est à jour"}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Nœuds sains</span>
            <span className="stat-card__value">
              {stats.healthyNodes}/{stats.totalNodes}
            </span>
            <span
              className={`stat-card__hint ${stats.healthyNodes === stats.totalNodes ? "is-success" : "is-warning"}`}
            >
              Sur l'ensemble des environnements
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Dérive GitOps</span>
            <span className="stat-card__value">{stats.driftCount}</span>
            <span className={`stat-card__hint ${stats.driftCount > 0 ? "is-critical" : "is-success"}`}>
              {stats.driftCount > 0 ? "Manifestes désynchronisés" : "Cluster synchronisé"}
            </span>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel__title-row">
          <div className="panel__title">Topologie de l'infrastructure</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => dispatch(setCurrentView("topology"))}>
            Vue plein écran
          </button>
        </div>
        <TopologyGraph height={420} />
      </div>

      <div className="overview-grid">
        <div className="panel">
          <div className="panel__title">Utilisation du cluster (historique en direct)</div>
          <AreaChart
            labels={utilisation.map((point) => point.label)}
            series={[
              { name: "CPU %", color: "var(--accent-end)", values: utilisation.map((p) => p.cpuPercent) },
              { name: "Mémoire %", color: "var(--registry-harbor)", values: utilisation.map((p) => p.memPercent) },
            ]}
          />
        </div>
        <div className="panel">
          <div className="panel__title">Images par registry</div>
          <Donut
            segments={registrySegments.map((segment) => ({
              label: segment.name,
              value: segment.value,
              color: registryMeta(segment.kind).color,
            }))}
          />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel__title">Activité récente (commits GitOps)</div>
        {recentCommits.length === 0 ? (
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
  );
}
