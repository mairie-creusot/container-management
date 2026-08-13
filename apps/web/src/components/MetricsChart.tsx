import { useId, useMemo } from "react";

/**
 * Petit graphique SVG natif réutilisable (aucune dépendance de charting ajoutée) — inspiré de
 * l'onglet "Metrics" de Railway : aire remplie sous une ligne (une seule série) ou lignes fines
 * superposées (plusieurs séries, ex Réseau réception/émission — pas d'aire remplie dans ce cas,
 * la superposition deviendrait illisible), axe Y en unités réelles, axe X en vrais horodatages,
 * plafond de référence optionnel affiché en haut à droite du titre ("Max X") quand une limite
 * réelle est connue (ex : HostConfig.Memory/NanoCpus du conteneur, voir
 * ContainerDetail#memoryLimitBytes/nanoCpus). Consommé par TopologyNodeDetailPanel.tsx (onglet
 * "Métriques") pour CPU/Mémoire/Réseau/E·S disque — générique pour rester réutilisable ailleurs.
 */

export interface MetricsChartPoint {
  timestamp: string; // ISO 8601
  value: number;
}

/** Une série nommée (ex: "Réception"/"Émission" sur le graphique Réseau) — plusieurs séries sur un
 * même graphique partagent le même axe Y/la même échelle temporelle, chacune sa propre couleur et
 * sa légende. Un graphique à une seule métrique (CPU, Mémoire) reste un tableau à 1 élément. */
export interface MetricsSeries {
  label: string;
  points: MetricsChartPoint[];
  color: string;
}

interface MetricsChartProps {
  title: string;
  series: MetricsSeries[];
  /** Formatte une valeur brute (axe Y, plafond, légende) en unité réelle — ex: "42%" ou "512 Mo". */
  formatValue: (value: number) => string;
  /** Plafond de référence réel s'il existe (limite CPU/mémoire configurée) — absent = pas de
   * limite connue, jamais une valeur inventée. */
  maxValue?: number;
}

const WIDTH = 480;
const HEIGHT = 168;
const PADDING = { top: 12, right: 14, bottom: 26, left: 48 };
const INNER_WIDTH = WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

interface SeriesGeometry {
  label: string;
  color: string;
  areaPoints?: string;
  linePoints: string;
}

interface ChartGeometry {
  series: SeriesGeometry[];
  yTicks: { value: number; y: number }[];
  xTicks: { x: number; label: string }[];
}

function buildGeometry(series: MetricsSeries[], maxValueHint: number | undefined): ChartGeometry | null {
  const nonEmpty = series.filter((s) => s.points.length > 0);
  if (nonEmpty.length === 0) return null;

  // Échelle temporelle/de valeur PARTAGÉE entre toutes les séries — sinon deux courbes du même
  // graphique (ex Réception/Émission réseau) ne seraient pas comparables visuellement.
  const allTimes = nonEmpty.flatMap((s) => s.points.map((p) => new Date(p.timestamp).getTime()));
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const timeSpan = maxTime - minTime || 1;

  const allValues = nonEmpty.flatMap((s) => s.points.map((p) => p.value));
  const dataMax = Math.max(...allValues, maxValueHint ?? 0);
  // Marge de 10% au-dessus du plus haut point connu — jamais un plafond à 0 qui écraserait la
  // courbe à plat quand toutes les valeurs observées sont nulles.
  const yMax = dataMax > 0 ? dataMax * 1.1 : 1;

  function x(t: number): number {
    return PADDING.left + ((t - minTime) / timeSpan) * INNER_WIDTH;
  }
  function y(v: number): number {
    return PADDING.top + INNER_HEIGHT - (Math.min(v, yMax) / yMax) * INNER_HEIGHT;
  }

  // L'aire remplie sous la courbe ne garde son sens que pour une SEULE série visible à la fois —
  // superposer plusieurs aires translucides deviendrait vite illisible (voir JSDoc en tête de
  // fichier) : uniquement calculée quand ce graphique n'a qu'une série.
  const fillArea = nonEmpty.length === 1;
  const baselineY = PADDING.top + INNER_HEIGHT;

  const seriesGeometry: SeriesGeometry[] = nonEmpty.map((s) => {
    const times = s.points.map((p) => new Date(p.timestamp).getTime());
    const linePoints = s.points.map((p, i) => `${x(times[i]!)},${y(p.value)}`).join(" ");
    return {
      label: s.label,
      color: s.color,
      linePoints,
      ...(fillArea ? { areaPoints: `${PADDING.left},${baselineY} ${linePoints} ${PADDING.left + INNER_WIDTH},${baselineY}` } : {}),
    };
  });

  const yTicks = [0, yMax / 2, yMax].map((value) => ({ value, y: y(value) }));

  // Jusqu'à 4 horodatages réels le long de l'axe X, jamais plus (lisibilité sur une largeur fixe)
  // — dérivés de la série la plus longue (le plus de points disponibles pour un axe précis).
  const longest = nonEmpty.reduce((a, b) => (b.points.length > a.points.length ? b : a));
  const tickCount = Math.min(4, longest.points.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const idx = tickCount === 1 ? 0 : Math.round((i * (longest.points.length - 1)) / (tickCount - 1));
    const point = longest.points[idx]!;
    return {
      x: x(new Date(point.timestamp).getTime()),
      label: new Date(point.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    };
  });

  return { series: seriesGeometry, yTicks, xTicks };
}

export default function MetricsChart({ title, series, formatValue, maxValue }: MetricsChartProps) {
  const gradientBaseId = `metrics-chart-fill-${useId()}`;
  const geometry = useMemo(() => buildGeometry(series, maxValue), [series, maxValue]);
  const showLegend = series.length > 1;

  return (
    <div className="metrics-chart">
      <div className="metrics-chart__head">
        <span className="metrics-chart__title">{title}</span>
        {maxValue !== undefined && <span className="metrics-chart__cap">Max {formatValue(maxValue)}</span>}
      </div>
      {showLegend && (
        <div className="metrics-chart__legend">
          {series.map((s) => (
            <span key={s.label} className="metrics-chart__legend-item">
              <span className="metrics-chart__legend-dot" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {!geometry ? (
        <div className="empty-state">Aucune donnée de métrique pour l'instant.</div>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="metrics-chart__svg"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Graphique ${title} dans le temps`}
        >
          <defs>
            {geometry.series.map((s, index) => (
              <linearGradient key={index} id={`${gradientBaseId}-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {geometry.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={tick.y}
                y2={tick.y}
                className="metrics-chart__gridline"
              />
              <text x={PADDING.left - 6} y={tick.y} className="metrics-chart__y-label" textAnchor="end" dominantBaseline="middle">
                {formatValue(tick.value)}
              </text>
            </g>
          ))}
          {geometry.series.map((s, index) => (
            <g key={index}>
              {s.areaPoints && <polygon points={s.areaPoints} fill={`url(#${gradientBaseId}-${index})`} />}
              <polyline
                points={s.linePoints}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
          {geometry.xTicks.map((tick, index) => (
            <text key={index} x={tick.x} y={HEIGHT - 6} className="metrics-chart__x-label" textAnchor="middle">
              {tick.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}
