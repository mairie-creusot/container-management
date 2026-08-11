export interface KeyValueRow {
  key: string;
  value: string;
}

export default function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <div className="kv-list">
      {rows.map((row) => (
        <div className="kv-row" key={row.key}>
          <span className="kv-row__key">{row.key}</span>
          <span className="kv-row__value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
