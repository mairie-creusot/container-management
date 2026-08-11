export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  segments: DonutSegment[];
}

export default function Donut({ segments }: DonutProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0) {
    return (
      <div className="donut-wrap">
        <div className="donut" style={{ background: "var(--color-surface-3)" }} />
        <div className="donut-legend">
          <span style={{ color: "var(--color-text-faint)" }}>Aucune donnée</span>
        </div>
      </div>
    );
  }

  let cursor = 0;
  const stops: string[] = [];
  for (const segment of segments) {
    const start = (cursor / total) * 360;
    cursor += segment.value;
    const end = (cursor / total) * 360;
    stops.push(`${segment.color} ${start}deg ${end}deg`);
  }

  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(${stops.join(", ")})` }} />
      <div className="donut-legend">
        {segments.map((segment) => (
          <div className="donut-legend__item" key={segment.label}>
            <span className="donut-legend__swatch" style={{ background: segment.color }} />
            <span>{segment.label}</span>
            <span className="donut-legend__value">{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
