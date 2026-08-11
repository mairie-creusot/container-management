import { useRef, useState, type PointerEvent } from "react";

export interface AreaChartSeries {
  name: string;
  color: string;
  values: number[]; // même longueur que `labels`
}

interface AreaChartProps {
  labels: string[];
  series: AreaChartSeries[];
  maxValue?: number;
  height?: number;
  /** Suffixe affiché après chaque valeur dans l'infobulle au survol (ex: "%", " Go"). */
  unit?: string;
}

const WIDTH = 600;

export default function AreaChart({ labels, series, maxValue = 100, height = 180, unit = "%" }: AreaChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (labels.length === 0) {
    return <div className="empty-state">Aucune donnée d'utilisation disponible.</div>;
  }

  const padding = 8;
  const innerWidth = WIDTH - padding * 2;
  const innerHeight = height - padding * 2;
  const stepX = labels.length > 1 ? innerWidth / (labels.length - 1) : 0;

  function pointsFor(values: number[]): { x: number; y: number }[] {
    return values.map((value, index) => {
      const ratio = Math.max(0, Math.min(1, value / maxValue));
      return {
        x: padding + index * stepX,
        y: padding + innerHeight - ratio * innerHeight,
      };
    });
  }

  function areaPath(points: { x: number; y: number }[]): string {
    if (points.length === 0) return "";
    const first = points[0];
    if (!first) return "";
    const line = points.map((p) => `${p.x},${p.y}`).join(" L ");
    const last = points[points.length - 1] ?? first;
    return `M ${first.x},${padding + innerHeight} L ${line} L ${last.x},${padding + innerHeight} Z`;
  }

  function linePath(points: { x: number; y: number }[]): string {
    if (points.length === 0) return "";
    const first = points[0];
    if (!first) return "";
    return `M ${first.x},${first.y} L ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`;
  }

  /** Convertit une position pointeur (pixels écran) en index de point le plus proche, en
   * passant par le repère utilisateur du SVG (getScreenCTM) — fiable même si le SVG est
   * redimensionné en CSS (viewBox différent de la taille affichée, preserveAspectRatio="none"). */
  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const userPoint = point.matrixTransform(ctm.inverse());
    const rawIndex = stepX > 0 ? Math.round((userPoint.x - padding) / stepX) : 0;
    setHoverIndex(Math.max(0, Math.min(labels.length - 1, rawIndex)));
  }

  const gridLines = [0, 25, 50, 75, 100];
  const seriesPoints = series.map((serie) => pointsFor(serie.values));
  const hoverX = hoverIndex !== null ? padding + hoverIndex * stepX : null;
  // Bascule l'infobulle à gauche du curseur passé la moitié du graphique pour ne jamais sortir du viewBox.
  const tooltipWidth = 148;
  const tooltipHeight = 20 + series.length * 16;
  const tooltipX =
    hoverX !== null ? Math.min(Math.max(hoverX + 10, padding), WIDTH - padding - tooltipWidth) : 0;

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
      >
        {gridLines.map((g) => {
          const y = padding + innerHeight - (g / 100) * innerHeight;
          return (
            <line
              key={g}
              x1={padding}
              x2={WIDTH - padding}
              y1={y}
              y2={y}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
          );
        })}
        {series.map((serie, seriesIndex) => (
          <g key={serie.name}>
            <path d={areaPath(seriesPoints[seriesIndex]!)} fill={serie.color} opacity={0.14} />
            <path d={linePath(seriesPoints[seriesIndex]!)} fill="none" stroke={serie.color} strokeWidth={2} />
          </g>
        ))}

        {hoverIndex !== null && hoverX !== null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={padding}
              y2={padding + innerHeight}
              stroke="var(--color-border-strong, var(--color-border))"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {series.map((serie, seriesIndex) => {
              const p = seriesPoints[seriesIndex]![hoverIndex]!;
              return <circle key={serie.name} cx={p.x} cy={p.y} r={3.5} fill={serie.color} />;
            })}
            <g transform={`translate(${tooltipX}, ${padding})`}>
              <rect
                width={tooltipWidth}
                height={tooltipHeight}
                rx={6}
                fill="var(--color-surface-2)"
                stroke="var(--color-border)"
              />
              <text x={10} y={16} fontSize={11} fill="var(--color-text-muted)">
                {labels[hoverIndex]}
              </text>
              {series.map((serie, seriesIndex) => (
                <text key={serie.name} x={10} y={32 + seriesIndex * 16} fontSize={11.5} fill="var(--color-text)">
                  <tspan fill={serie.color}>●</tspan> {serie.name} : {serie.values[hoverIndex]?.toFixed(1)}
                  {unit}
                </text>
              ))}
            </g>
          </g>
        )}

        {/* Zone de capture du survol : couvre toute la surface du graphe, au-dessus des tracés. */}
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={height}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>
      <div className="donut-legend" style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
        {series.map((serie) => (
          <div className="donut-legend__item" key={serie.name}>
            <span className="donut-legend__swatch" style={{ background: serie.color }} />
            <span>{serie.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
