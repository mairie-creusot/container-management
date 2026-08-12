import { useId, useMemo } from "react";

/**
 * Petit graphique SVG natif réutilisable (aucune dépendance de charting ajoutée) — inspiré de
 * l'onglet "Metrics" de Railway : aire remplie sous une ligne, axe Y en unités réelles, axe X en
 * vrais horodatages, plafond de référence optionnel affiché en haut à droite du titre ("Max X")
 * quand une limite réelle est connue (ex : HostConfig.Memory/NanoCpus du conteneur, voir
 * ContainerDetail#memoryLimitBytes/nanoCpus). Consommé par TopologyNodeDetailPanel.tsx (onglet
 * "Métriques") pour CPU et mémoire — générique pour rester réutilisable ailleurs si besoin.
 */

export interface MetricsChartPoint {
  timestamp: string; // ISO 8601
  value: number;
}

interface MetricsChartProps {
  title: string;
  points: MetricsChartPoint[];
  /** Formatte une valeur brute (axe Y, plafond) en unité réelle — ex: "42%" ou "512 Mo". */
  formatValue: (value: number) => string;
  color: string;
  /** Plafond de référence réel s'il existe (limite CPU/mémoire configurée) — absent = pas de
   * limite connue, jamais une valeur inventée. */
  maxValue?: number;
}

const WIDTH = 480;
const HEIGHT = 168;
const PADDING = { top: 12, right: 14, bottom: 26, left: 48 };
const INNER_WIDTH = WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

interface ChartGeometry {
  areaPoints: string;
  linePoints: string;
  yTicks: { value: number; y: number }[];
  xTicks: { x: number; label: string }[];
}

function buildGeometry(points: MetricsChartPoint[], maxValueHint: number | undefined): ChartGeometry | null {
  if (points.length === 0) return null;

  const times = points.map((p) => new Date(p.timestamp).getTime());
  const minTime = times[0]!;
  const maxTime = times[times.length - 1]!;
  const timeSpan = maxTime - minTime || 1;

  const values = points.map((p) => p.value);
  const dataMax = Math.max(...values, maxValueHint ?? 0);
  // Marge de 10% au-dessus du plus haut point connu — jamais un plafond à 0 qui écraserait la
  // courbe à plat quand toutes les valeurs observées sont nulles.
  const yMax = dataMax > 0 ? dataMax * 1.1 : 1;

  function x(t: number): number {
    return PADDING.left + ((t - minTime) / timeSpan) * INNER_WIDTH;
  }
  function y(v: number): number {
    return PADDING.top + INNER_HEIGHT - (Math.min(v, yMax) / yMax) * INNER_HEIGHT;
  }

  const linePoints = points.map((p, i) => `${x(times[i]!)},${y(p.value)}`).join(" ");
  const baselineY = PADDING.top + INNER_HEIGHT;
  const areaPoints = `${PADDING.left},${baselineY} ${linePoints} ${PADDING.left + INNER_WIDTH},${baselineY}`;

  const yTicks = [0, yMax / 2, yMax].map((value) => ({ value, y: y(value) }));

  // Jusqu'à 4 horodatages réels le long de l'axe X, jamais plus (lisibilité sur une largeur fixe).
  const tickCount = Math.min(4, points.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const idx = tickCount === 1 ? 0 : Math.round((i * (points.length - 1)) / (tickCount - 1));
    const point = points[idx]!;
    return {
      x: x(times[idx]!),
      label: new Date(point.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    };
  });

  return { areaPoints, linePoints, yTicks, xTicks };
}

export default function MetricsChart({ title, points, formatValue, color, maxValue }: MetricsChartProps) {
  const gradientId = `metrics-chart-fill-${useId()}`;
  const geometry = useMemo(() => buildGeometry(points, maxValue), [points, maxValue]);

  return (
    <div className="metrics-chart">
      <div className="metrics-chart__head">
        <span className="metrics-chart__title">{title}</span>
        {maxValue !== undefined && <span className="metrics-chart__cap">Max {formatValue(maxValue)}</span>}
      </div>
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
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
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
          <polygon points={geometry.areaPoints} fill={`url(#${gradientId})`} />
          <polyline
            points={geometry.linePoints}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
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
