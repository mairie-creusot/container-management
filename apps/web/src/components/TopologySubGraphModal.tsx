import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Modal from "@/components/Modal";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { buildTopologyEdges, edgeTypes, nodeTypes } from "@/components/topologyGraphShared";
import type { Topology, TopologyNode } from "@/types";

interface TopologySubGraphModalProps {
  /** Graphe complet déjà chargé côté client (state.topology.data) — le sous-graphe est un pur
   * calcul dérivé, jamais un nouvel appel réseau (voir TopologyGraph.tsx#getTopology côté API pour
   * la construction du graphe complet, inchangée). */
  topology: Topology;
  /** Id du nœud dont on veut visualiser les dépendances — null referme la modal. */
  rootId: string | null;
  onClose: () => void;
  /** Ouvre TopologyNodeDetailModal pour un nœud du sous-graphe (menu contextuel "Voir le détail") —
   * déléguée au parent pour n'avoir qu'UNE seule instance de la modal de détail, partagée entre le
   * graphe principal et ce sous-graphe. */
  onOpenDetail: (node: TopologyNode) => void;
}

/** Rayon (px) du cercle de nœuds voisins autour du nœud racine — disposition "hub and spoke",
 * la plus lisible pour "un nœud + tout ce qui lui est directement relié". */
const RADIUS = 260;

function radialPositions(rootId: string, neighborIds: string[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = { [rootId]: { x: 0, y: 0 } };
  const count = neighborIds.length;
  neighborIds.forEach((id, index) => {
    const angle = (index / Math.max(count, 1)) * 2 * Math.PI - Math.PI / 2;
    positions[id] = { x: Math.round(Math.cos(angle) * RADIUS), y: Math.round(Math.sin(angle) * RADIUS) };
  });
  return positions;
}

/**
 * Sous-graphe de dépendances — ouvert au double-clic sur un nœud du graphe principal (ou via
 * "Visualiser les dépendances" du menu contextuel), affiche UNIQUEMENT ce nœud + tous les nœuds
 * reliés à lui par au moins une arête du graphe complet. Réutilise EXACTEMENT le même rendu de
 * nœud/arête que le graphe principal (topologyGraphShared.tsx) pour un look identique.
 *
 * Profondeur : un seul niveau de dépendances directes à la fois, mais double-cliquer sur un nœud
 * DANS le sous-graphe re-centre la vue sur lui (ses propres dépendances directes) — drill-down
 * récursif naturel sans empiler des modals, avec un fil d'Ariane + bouton "Retour" pour remonter.
 * Choix documenté : pas de "toutes profondeurs à la fois" (graphe complet déjà accessible en
 * fermant cette modal), pour rester lisible même sur un hôte avec beaucoup de ressources.
 */
export default function TopologySubGraphModal({ topology, rootId, onClose, onOpenDetail }: TopologySubGraphModalProps) {
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);

  const open = rootId !== null;

  // Nouvelle ouverture (ou nouveau nœud racine imposé par le parent, ex : ré-ouvert depuis un
  // autre nœud du graphe principal) -> repart d'un historique de navigation vide.
  useEffect(() => {
    if (rootId) {
      setCurrentRootId(rootId);
      setStack([]);
    }
  }, [rootId]);

  const nodesById = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);

  const neighborIds = useMemo(() => {
    if (!currentRootId) return [];
    const ids = new Set<string>();
    for (const edge of topology.edges) {
      if (edge.source === currentRootId) ids.add(edge.target);
      else if (edge.target === currentRootId) ids.add(edge.source);
    }
    return Array.from(ids);
  }, [topology, currentRootId]);

  const subEdges = useMemo(
    () => topology.edges.filter((e) => e.source === currentRootId || e.target === currentRootId),
    [topology, currentRootId],
  );

  // Reconstruit la disposition (racine au centre, voisins en cercle) à chaque recentrage — pas de
  // persistance (contrairement au graphe principal) : une exploration ponctuelle, pas un canevas
  // durable.
  useEffect(() => {
    if (!currentRootId || !nodesById.has(currentRootId)) {
      setFlowNodes([]);
      return;
    }
    const positions = radialPositions(currentRootId, neighborIds);
    const ids = [currentRootId, ...neighborIds];
    setFlowNodes(
      ids
        .map((id) => nodesById.get(id))
        .filter((n): n is TopologyNode => !!n)
        .map((n) => ({
          id: n.id,
          type: "graphNode",
          position: positions[n.id] ?? { x: 0, y: 0 },
          data: n as unknown as Record<string, unknown>,
        })),
    );
  }, [currentRootId, neighborIds, nodesById]);

  const flowEdges = useMemo(() => buildTopologyEdges(subEdges, nodesById), [subEdges, nodesById]);

  function handleNodesChange(changes: NodeChange[]) {
    setFlowNodes((nds) => applyNodeChanges(changes, nds));
  }

  /** Re-centre le sous-graphe sur `id` (drill-down récursif) — double-clic sur un nœud du
   * sous-graphe ou "Visualiser ses dépendances" du menu contextuel. No-op sur la racine actuelle
   * (déjà affichée). */
  function drillInto(id: string) {
    if (id === currentRootId) return;
    setStack((s) => (currentRootId ? [...s, currentRootId] : s));
    setCurrentRootId(id);
  }

  function handleBack() {
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1]!;
    setStack(stack.slice(0, -1));
    setCurrentRootId(previous);
  }

  function handleNodeContextMenu(event: React.MouseEvent, node: Node) {
    event.preventDefault();
    setNodeMenu({ x: event.clientX, y: event.clientY, node: node.data as unknown as TopologyNode });
  }

  const rootNode = currentRootId ? nodesById.get(currentRootId) ?? null : null;
  const breadcrumbLabels = [...stack, ...(currentRootId ? [currentRootId] : [])].map((id) => nodesById.get(id)?.label ?? id);

  function nodeMenuItems(node: TopologyNode): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => onOpenDetail(node) }];
    if (node.id !== currentRootId) {
      items.push({ label: "Visualiser ses dépendances", onClick: () => drillInto(node.id) });
    }
    return items;
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="topology-subgraph-title">
      <div className="topology-subgraph-modal">
        <div className="topology-subgraph-modal__header">
          <div className="topology-subgraph-modal__breadcrumb" id="topology-subgraph-title">
            {breadcrumbLabels.map((label, index) => (
              <span key={index} className="topology-subgraph-modal__crumb">
                {index > 0 && <span className="topology-subgraph-modal__crumb-sep">→</span>}
                {label}
              </span>
            ))}
          </div>
          <div className="topology-subgraph-modal__actions">
            {stack.length > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleBack}>
                ← Retour
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Retour au graphe complet
            </button>
          </div>
        </div>

        {neighborIds.length === 0 && rootNode && (
          <div className="topology-subgraph-modal__note">
            Aucune dépendance directe pour « {rootNode.label} » — ce nœud n'a aucune arête dans le graphe.
          </div>
        )}

        <div className="topology-subgraph-modal__graph">
          <ReactFlow
            key={currentRootId ?? "none"}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={handleNodesChange}
            onNodeDoubleClick={(_event, node) => drillInto(node.id)}
            onNodeContextMenu={handleNodeContextMenu}
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
          >
            <Background gap={20} size={1.6} color="var(--color-text-faint)" />
          </ReactFlow>
        </div>

        {nodeMenu && (
          <ContextMenu x={nodeMenu.x} y={nodeMenu.y} onClose={() => setNodeMenu(null)} items={nodeMenuItems(nodeMenu.node)} />
        )}
      </div>
    </Modal>
  );
}
