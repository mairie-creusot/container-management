export type Semantic = "success" | "warning" | "critical" | "neutral";

const STATUS_MAP: Record<string, { semantic: Semantic; label: string }> = {
  // Images
  uptodate: { semantic: "success", label: "À jour" },
  update: { semantic: "warning", label: "Mise à jour dispo" },
  // Registries
  connected: { semantic: "success", label: "Connecté" },
  unconfigured: { semantic: "neutral", label: "Non configuré" },
  error: { semantic: "critical", label: "Erreur" },
  // Conteneurs
  running: { semantic: "success", label: "En cours" },
  restarting: { semantic: "warning", label: "Redémarrage" },
  stopped: { semantic: "critical", label: "Arrêté" },
  // Nœuds / environnements
  ok: { semantic: "success", label: "Sain" },
  warn: { semantic: "warning", label: "Attention" },
  crit: { semantic: "critical", label: "Critique" },
};

interface StatusPillProps {
  status: string;
  label?: string;
}

export default function StatusPill({ status, label }: StatusPillProps) {
  const meta = STATUS_MAP[status] ?? { semantic: "neutral" as Semantic, label: status };
  return (
    <span className={`status-pill status-pill--${meta.semantic}`}>{label ?? meta.label}</span>
  );
}
