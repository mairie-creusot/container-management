import { useAppSelector } from "@/hooks";
import TopologyGraph from "@/components/TopologyGraph";

// Le graphe EST la Vue d'ensemble — plein écran, sans en-tête de page ni Inspector latéral :
// tout ce qui compte doit être visible ou accessible directement sur les nœuds/arêtes du graphe
// (badges MàJ dispo/dérive GitOps/vulnérabilités, métriques CPU/mémoire inline, menus
// contextuels — voir TopologyGraph.tsx). Seul l'indicateur de rafraîchissement reste, en overlay
// blanc par-dessus le canevas.
const REFRESH_INTERVAL_MS = 9_000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function OverviewPage() {
  // Pas de fetch dédié à cette page : TopologyGraph interroge déjà GET /api/topology toutes les
  // REFRESH_INTERVAL_MS et le serveur horodate chaque réponse (Topology.generatedAt) — le lire
  // ici évite une deuxième boucle de polling rien que pour afficher "Actualisé à…".
  const generatedAt = useAppSelector((s) => s.topology.data?.generatedAt);

  return (
    <div className="workspace overview-workspace">
      <TopologyGraph height={window.innerHeight - 61} refreshIntervalMs={REFRESH_INTERVAL_MS} />

      {generatedAt && (
        <span className="overview-refresh-overlay">
          <span className="overview-refresh-dot" />
          Actualisé à {formatTime(generatedAt)} · toutes les {REFRESH_INTERVAL_MS / 1000}s
        </span>
      )}
    </div>
  );
}
