interface GaugeProps {
  label: string;
  percent: number;
}

function severity(percent: number): "" | "is-warning" | "is-critical" {
  if (percent >= 90) return "is-critical";
  if (percent >= 70) return "is-warning";
  return "";
}

export default function Gauge({ label, percent }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="gauge">
      <div className="gauge__label">
        <span>{label}</span>
        <span className="gauge__value">{clamped.toFixed(0)}%</span>
      </div>
      <div className="gauge__track">
        <div
          className={`gauge__fill ${severity(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
