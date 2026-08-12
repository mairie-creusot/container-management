export interface KeyValueRow {
  key: string;
  value: string;
}

/**
 * `title` posé sur la clé ET la valeur : filet de sécurité anti-débordement pour tout conteneur
 * étroit (ex: le panneau de détail ancré de la topologie, ~420-480px, voir
 * TopologyNodeDetailPanel.tsx) — le CSS (.kv-row, components.css) tronque déjà en ellipsis/wrap
 * plutôt que de déborder, `title` restitue la valeur complète au survol sans avoir à l'étirer.
 */
export default function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <div className="kv-list">
      {rows.map((row) => (
        <div className="kv-row" key={row.key}>
          <span className="kv-row__key" title={row.key}>
            {row.key}
          </span>
          <span className="kv-row__value" title={row.value}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
