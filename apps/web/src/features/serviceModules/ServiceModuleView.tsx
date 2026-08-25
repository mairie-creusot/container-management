import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, MiniMap } from "@xyflow/react";
import { ApiError } from "@/api/client";
import { edgeTypes } from "@/components/topologyGraphShared";
import { fetchServiceModuleSnapshot } from "./api";
import { buildServiceModuleGraph, serviceModuleNodeTypes } from "./serviceModuleGraph";
import type { ServiceModuleSnapshot } from "./types";

/** Intervalle (ms) de rafraîchissement de l'instantané — court, parce qu'un module montre des
 * états VIVANTS (un appel 3CX en cours dure quelques dizaines de secondes). Démarré/arrêté avec le
 * MONTAGE de ce composant : il n'existe que tant que le panneau de sous-graphe affiche ce module,
 * jamais un sondage de fond — même règle exacte que le sondage de processus de
 * TopologySubGraphPanel.tsx (PROCESS_POLL_INTERVAL_MS). */
export const MODULE_SNAPSHOT_POLL_INTERVAL_MS = 5000;

export interface ServiceModuleViewProps {
  moduleId: string;
  moduleLabel: string;
  /** Nom du nœud porteur — l'utilisateur doit voir de QUELLE machine ce service est la vue. */
  nodeLabel: string;
  /** Liaison automatique : afficher la preuve de correspondance plutôt qu'une liaison opaque. */
  origin: "manual" | "automatic";
  matchedOn?: string;
  reducedMotion: boolean;
}

/**
 * Vue d'un module métier dans le sous-graphe — bandeau de synthèse (`summary`) + canevas React Flow
 * des `entities`/`relations`, sans AUCUNE connaissance du module affiché (voir
 * serviceModuleGraph.tsx). Un module non configuré / injoignable affiche l'état explicite renvoyé
 * par le serveur, jamais un canevas vide muet ni des données de démonstration.
 */
/** Repli quand l'intégration n'a pas fourni son propre message — jamais un état inventé. */
const DEFAULT_STATUS_NOTE: Record<ServiceModuleSnapshot["status"], string> = {
  ready: "",
  "not-configured": "Intégration non configurée — aucune donnée réelle à afficher.",
  unreachable: "Intégration configurée mais injoignable — aucune donnée réelle à afficher.",
  denied: "Accès refusé par le service — les identifiants sont acceptés mais les droits manquent.",
  failed: "Le service a répondu par une erreur — aucune donnée réelle à afficher.",
};

export default function ServiceModuleView({
  moduleId,
  moduleLabel,
  nodeLabel,
  origin,
  matchedOn,
  reducedMotion,
}: ServiceModuleViewProps) {
  const [snapshot, setSnapshot] = useState<ServiceModuleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Le sondage ne doit jamais vider la vue le temps d'un aller-retour : on garde le dernier
  // instantané valide affiché (même bug réel que la liste de processus, corrigé le 14/08/2026).
  const currentModuleRef = useRef(moduleId);

  useEffect(() => {
    currentModuleRef.current = moduleId;
    setSnapshot(null);
    setError(null);
    setLoading(true);
    let cancelled = false;

    async function load() {
      try {
        const next = await fetchServiceModuleSnapshot(moduleId);
        if (cancelled || currentModuleRef.current !== moduleId) return;
        setSnapshot(next);
        setError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Impossible de récupérer l'état de ce module.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(() => void load(), MODULE_SNAPSHOT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [moduleId]);

  const graph = useMemo(
    () => (snapshot ? buildServiceModuleGraph(snapshot, { reducedMotion }) : { nodes: [], edges: [] }),
    [snapshot, reducedMotion],
  );

  return (
    <div className="topology-module">
      <div className="topology-module__caption">
        Module <strong>{moduleLabel}</strong> — vue métier réelle du service porté par « {nodeLabel} », en{" "}
        <strong>lecture seule</strong>, rafraîchie toutes les {MODULE_SNAPSHOT_POLL_INTERVAL_MS / 1000}s tant que ce
        panneau est ouvert.{" "}
        {origin === "automatic"
          ? `Liaison automatique : l'hôte configuré de l'intégration correspond réellement à ce nœud${matchedOn ? ` (${matchedOn})` : ""}.`
          : "Liaison posée manuellement."}
      </div>

      {loading && !snapshot && !error && <div className="empty-state">Chargement du module…</div>}
      {error && <div className="error-banner">{error}</div>}

      {snapshot && snapshot.status !== "ready" && (
        <div className="topology-subgraph-panel__note">
          {snapshot.message ?? DEFAULT_STATUS_NOTE[snapshot.status]}
        </div>
      )}
      {snapshot && snapshot.status === "ready" && snapshot.message && (
        <div className="topology-subgraph-panel__note">{snapshot.message}</div>
      )}

      {snapshot && snapshot.summary.length > 0 && (
        <div className="topology-module__summary">
          {snapshot.summary.map((item) => (
            <div key={item.label} className={`topology-module__summary-item topology-module__summary-item--${item.tone ?? "neutral"}`}>
              <span className="topology-module__summary-label">{item.label}</span>
              <span className="topology-module__summary-value">{item.value}</span>
            </div>
          ))}
        </div>
      )}

      {snapshot && snapshot.status === "ready" && snapshot.entities.length === 0 && (
        <div className="topology-subgraph-panel__note">
          Ce module est configuré et joignable, mais ne rapporte actuellement aucun élément — état réel, jamais
          un contenu fabriqué pour remplir la vue.
        </div>
      )}

      {snapshot && snapshot.entities.length > 0 && (
        <div className="topology-module__graph">
          <ReactFlow
            key={moduleId}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={serviceModuleNodeTypes}
            edgeTypes={edgeTypes}
            nodesConnectable={false}
            nodesDraggable={false}
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
          >
            <Background gap={20} size={1.6} color="var(--color-text-faint)" />
            <MiniMap
              position="top-left"
              nodeColor="#a78bfa"
              nodeStrokeWidth={0}
              nodeBorderRadius={4}
              maskColor="rgba(11, 12, 16, 0.75)"
              pannable
              zoomable
            />
          </ReactFlow>
        </div>
      )}

      {snapshot && (
        <div className="topology-module__footer">
          Instantané du {new Date(snapshot.generatedAt).toLocaleTimeString("fr-FR")} · {snapshot.entities.length} élément
          {snapshot.entities.length > 1 ? "s" : ""} · {snapshot.relations.length} relation
          {snapshot.relations.length > 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
