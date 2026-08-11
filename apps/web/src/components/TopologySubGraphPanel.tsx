import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, applyNodeChanges, type Edge, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchContainerProcesses } from "@/features/containers/containersSlice";
import { fetchImageHistory, fetchImages } from "@/features/images/imagesSlice";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import {
  buildTopologyEdges,
  edgeTypes,
  formatMem,
  idWithoutPrefix,
  interiorNodeTypes,
  nodeTypes,
  radialPositions,
  type ProcessNodeData,
} from "@/components/topologyGraphShared";
import type { Topology, TopologyNode } from "@/types";

interface TopologySubGraphPanelProps {
  /** Graphe complet déjà chargé côté client (state.topology.data) — le sous-graphe est un pur
   * calcul dérivé, jamais un nouvel appel réseau. */
  topology: Topology;
  /** Id du nœud dont on veut visualiser les dépendances — garanti non-null tant que ce composant
   * est monté par TopologyGraph.tsx (voir sa condition `subGraphMounted && data && ...`). */
  rootId: string | null;
  /** Pilote la transition d'entrée/sortie (voir TopologyGraph.tsx) : `false` juste après le montage
   * (position de départ, scale réduit + transparent) puis bascule à `true` une frame plus tard pour
   * jouer la transition CSS "zoom dans le nœud". Repasse à `false` pour l'animation de sortie. */
  visible: boolean;
  /** Point d'origine (%, relatif à la zone du graphe) de la transition scale+fade — position à
   * l'écran du nœud sur lequel l'utilisateur a double-cliqué / choisi "Visualiser les dépendances". */
  origin: { x: number; y: number };
  reducedMotion: boolean;
  /** L'utilisateur demande à ressortir vers le graphe principal — ne démonte PAS immédiatement
   * (TopologyGraph.tsx joue d'abord l'animation de sortie), voir `onExited`. */
  onRequestClose: () => void;
  /** L'animation de sortie est terminée (ou sautée sous `prefers-reduced-motion`) : le parent peut
   * démonter ce composant sans à-coup visuel. */
  onExited: () => void;
  /** Ouvre TopologyNodeDetailModal pour un nœud du sous-graphe (menu contextuel "Voir le détail") —
   * déléguée au parent pour n'avoir qu'UNE seule instance de la modal de détail, partagée entre le
   * graphe principal et ce panneau. */
  onOpenDetail: (node: TopologyNode) => void;
}

/** Rayon (px) du cercle de voisins autour du nœud racine — sous-graphe de dépendances. */
const DEPENDENCY_RADIUS = 260;
/** Rayon (px) du cercle de processus autour du nœud conteneur — vue "composition interne", plus
 * serré : les nœuds "processus" sont volontairement plus petits que les nœuds de ressources. */
const PROCESS_RADIUS = 200;

type ViewMode = "dependencies" | "interior";

/** Colonnes `docker top` identifiées avec confiance (le reste des colonnes réelles — TIME, STIME,
 * PPID... — existe toujours dans `titles`/`processes` mais n'est pas affiché sur le nœud, la carte
 * resterait illisible avec 8 colonnes par nœud). Repli honnête si une colonne n'est pas reconnue :
 * jamais de valeur inventée, seulement "?" ou le contenu réel de la dernière colonne (CMD est
 * conventionnellement toujours la dernière colonne d'une sortie `ps`, quel que soit l'OS cible). */
function findColumn(titles: string[], patterns: RegExp[]): number {
  return titles.findIndex((title) => patterns.some((pattern) => pattern.test(title.trim())));
}

/**
 * Panneau de sous-graphe — remplace le graphe principal EN PLACE (même zone, voir
 * TopologyGraph.tsx qui gère le montage/démontage et la transition scale+fade "zoom dans le
 * nœud") au double-clic sur un nœud (ou "Visualiser les dépendances" du menu contextuel).
 *
 * Deux vues, choisies par bascule (`viewMode`, uniquement proposée pour un nœud "container") :
 * - "dependencies" (par défaut, TOUS les kinds) : UNIQUEMENT ce nœud + tous les nœuds reliés à lui
 *   par au moins une arête du graphe complet déjà chargé côté client — inchangé par rapport à
 *   l'ancienne TopologySubGraphModal.tsx, disposition radiale, drill-down récursif au double-clic
 *   avec fil d'Ariane + bouton "Retour".
 * - "interior" (conteneurs uniquement) : composition RÉELLE interne — processus en cours
 *   d'exécution (`docker top`, GET /api/containers/:id/processes) rendus comme des nœuds
 *   "processus" reliés au nœud conteneur, et historique des couches de l'image (`docker history`,
 *   GET /api/images/:id/history) en liste compacte. QUAI n'invente RIEN sur l'architecture
 *   applicative interne (impossible à connaître sans tracing applicatif, hors périmètre) : cette
 *   vue documente explicitement, dans son propre libellé, qu'il s'agit de données Docker réelles
 *   et lesquelles précisément.
 */
export default function TopologySubGraphPanel({
  topology,
  rootId,
  visible,
  origin,
  reducedMotion,
  onRequestClose,
  onExited,
  onOpenDetail,
}: TopologySubGraphPanelProps) {
  const dispatch = useAppDispatch();
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("dependencies");

  const processes = useAppSelector((s) => s.containers.processes);
  const processesStatus = useAppSelector((s) => s.containers.processesStatus);
  const processesError = useAppSelector((s) => s.containers.processesError);
  const processesContainerId = useAppSelector((s) => s.containers.processesContainerId);
  const images = useAppSelector((s) => s.images.items);
  const historyByImageId = useAppSelector((s) => s.images.historyByImageId);
  const historyStatus = useAppSelector((s) => s.images.historyStatus);
  const historyError = useAppSelector((s) => s.images.historyError);

  // Nouvelle ouverture (nouveau nœud racine imposé par le parent) -> repart d'un historique de
  // navigation vide et de la vue "dépendances" par défaut.
  useEffect(() => {
    if (rootId) {
      setCurrentRootId(rootId);
      setStack([]);
    }
  }, [rootId]);

  useEffect(() => {
    setViewMode("dependencies");
  }, [currentRootId]);

  const nodesById = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);
  const rootNode = currentRootId ? nodesById.get(currentRootId) ?? null : null;
  const rawRootId = currentRootId ? idWithoutPrefix(currentRootId) : "";

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
    const positions = radialPositions(currentRootId, neighborIds, DEPENDENCY_RADIUS);
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

  // --- Vue "composition interne" (conteneurs uniquement) ----------------------------------------
  const isContainerRoot = rootNode?.kind === "container";

  useEffect(() => {
    if (viewMode !== "interior" || !rootNode || rootNode.kind !== "container") return;
    if (rootNode.status === "running") dispatch(fetchContainerProcesses(rawRootId));
    dispatch(fetchImages());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, viewMode, currentRootId]);

  const imageRef =
    isContainerRoot && rootNode ? images.find((i) => `${i.name}:${i.currentTag}` === rootNode.subtitle) ?? null : null;

  useEffect(() => {
    if (viewMode === "interior" && imageRef) dispatch(fetchImageHistory(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, viewMode, imageRef?.id]);

  const historyLayers = imageRef ? historyByImageId[imageRef.id] ?? null : null;
  const processesReady = processesStatus === "ready" && processesContainerId === rawRootId;
  const effectiveProcesses = processesReady ? processes : null;

  const interiorNodes = useMemo<Node[]>(() => {
    if (!rootNode || !effectiveProcesses) return [];
    const satelliteIds = effectiveProcesses.processes.map((_, i) => `process:${i}`);
    const positions = radialPositions(rootNode.id, satelliteIds, PROCESS_RADIUS);
    const rootFlowNode: Node = {
      id: rootNode.id,
      type: "graphNode",
      position: positions[rootNode.id] ?? { x: 0, y: 0 },
      data: rootNode as unknown as Record<string, unknown>,
      draggable: false,
    };
    const pidIdx = findColumn(effectiveProcesses.titles, [/^pid$/i]);
    const userIdx = findColumn(effectiveProcesses.titles, [/^uid$/i, /^user$/i]);
    const cmdIdx = findColumn(effectiveProcesses.titles, [/^cmd$/i, /^command$/i]);
    const processFlowNodes: Node[] = effectiveProcesses.processes.map((row, index) => {
      const id = `process:${index}`;
      const data: ProcessNodeData = {
        pid: pidIdx >= 0 ? row[pidIdx] ?? "?" : "?",
        user: userIdx >= 0 ? row[userIdx] ?? "?" : "?",
        // Repli honnête sur la dernière colonne réelle (convention universelle de `ps`) si "CMD"/
        // "COMMAND" n'a pas été reconnu — jamais une valeur inventée.
        command: cmdIdx >= 0 ? row[cmdIdx] ?? "" : row[row.length - 1] ?? "",
      };
      return {
        id,
        type: "processNode",
        position: positions[id] ?? { x: 0, y: 0 },
        data: data as unknown as Record<string, unknown>,
        draggable: false,
        selectable: false,
      };
    });
    return [rootFlowNode, ...processFlowNodes];
  }, [rootNode, effectiveProcesses]);

  const interiorEdges = useMemo<Edge[]>(() => {
    if (!rootNode || !effectiveProcesses) return [];
    return effectiveProcesses.processes.map((_, index) => ({
      id: `process-edge-${index}`,
      source: rootNode.id,
      target: `process:${index}`,
      style: { stroke: "var(--color-text-faint)", strokeWidth: 1.2 },
    }));
  }, [rootNode, effectiveProcesses]);

  // --- Navigation -------------------------------------------------------------------------------

  function handleNodesChange(changes: NodeChange[]) {
    setFlowNodes((nds) => applyNodeChanges(changes, nds));
  }

  /** Re-centre le sous-graphe sur `id` (drill-down récursif) — double-clic sur un nœud du
   * sous-graphe ou "Visualiser ses dépendances" du menu contextuel. No-op sur la racine actuelle
   * (déjà affichée). Continue de fonctionner à l'identique dans ce panneau plein écran. */
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

  useEffect(() => {
    if (!visible) return;
    function handleKeyDown(event: KeyboardEvent) {
      // Un menu contextuel ouvert gère déjà sa propre touche Échap (ContextMenu.tsx) — éviter de
      // fermer le panneau ENTIER en même temps qu'un simple menu contextuel.
      if (event.key === "Escape" && !nodeMenu) onRequestClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [visible, nodeMenu, onRequestClose]);

  const breadcrumbLabels = [...stack, ...(currentRootId ? [currentRootId] : [])].map((id) => nodesById.get(id)?.label ?? id);

  function nodeMenuItems(node: TopologyNode): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => onOpenDetail(node) }];
    if (node.id !== currentRootId) {
      items.push({ label: "Visualiser ses dépendances", onClick: () => drillInto(node.id) });
    }
    return items;
  }

  function handleTransitionEnd(event: React.TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
    if (!visible) onExited();
  }

  return (
    <div
      className={`topology-subgraph-panel${visible ? " topology-subgraph-panel--visible" : ""}`}
      style={{ transformOrigin: `${origin.x}% ${origin.y}%` }}
      onTransitionEnd={reducedMotion ? undefined : handleTransitionEnd}
      role="region"
      aria-label={`Sous-graphe de « ${rootNode?.label ?? ""} »`}
    >
      <div className="topology-subgraph-panel__header">
        <div className="topology-subgraph-panel__breadcrumb">
          {breadcrumbLabels.map((label, index) => (
            <span key={index} className="topology-subgraph-panel__crumb">
              {index > 0 && <span className="topology-subgraph-panel__crumb-sep">→</span>}
              {label}
            </span>
          ))}
        </div>
        <div className="topology-subgraph-panel__actions">
          {isContainerRoot && (
            <div className="topology-subgraph-panel__mode-toggle" role="tablist" aria-label="Vue du sous-graphe">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "dependencies"}
                className={`topology-subgraph-panel__mode-btn${viewMode === "dependencies" ? " is-active" : ""}`}
                onClick={() => setViewMode("dependencies")}
              >
                Dépendances
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "interior"}
                className={`topology-subgraph-panel__mode-btn${viewMode === "interior" ? " is-active" : ""}`}
                onClick={() => setViewMode("interior")}
              >
                Composition interne
              </button>
            </div>
          )}
          {stack.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleBack}>
              ← Retour
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRequestClose}>
            ↑ Remonter au graphe complet
          </button>
        </div>
      </div>

      {viewMode === "dependencies" && (
        <>
          {neighborIds.length === 0 && rootNode && (
            <div className="topology-subgraph-panel__note">
              Aucune dépendance directe pour « {rootNode.label} » — ce nœud n'a aucune arête dans le graphe.
            </div>
          )}

          <div className="topology-subgraph-panel__graph">
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
        </>
      )}

      {viewMode === "interior" && rootNode && (
        <div className="topology-interior">
          <div className="topology-interior__caption">
            Processus réels en cours d'exécution — <code>docker top</code> (équivalent à la commande{" "}
            <code>docker top {rawRootId.slice(0, 12)}</code>). Ceci n'est <strong>pas</strong> une carte
            d'architecture applicative : QUAI ne peut pas connaître l'organisation logicielle interne de ce
            conteneur (il faudrait du tracing applicatif, hors périmètre), seulement les processus que le
            noyau hôte y voit réellement tourner.
          </div>
          <div className="topology-interior__body">
            <div className="topology-interior__graph">
              {rootNode.status !== "running" && (
                <div className="empty-state topology-interior__status-message">
                  Ce conteneur est arrêté — <code>docker top</code> nécessite un conteneur en cours d'exécution.
                </div>
              )}
              {rootNode.status === "running" && processesStatus === "loading" && (
                <div className="empty-state topology-interior__status-message">Chargement des processus réels…</div>
              )}
              {rootNode.status === "running" && processesStatus === "error" && processesContainerId === rawRootId && (
                <div className="error-banner topology-interior__status-message">{processesError}</div>
              )}
              {rootNode.status === "running" && processesReady && (
                <ReactFlow
                  key={`interior-${currentRootId}`}
                  nodes={interiorNodes}
                  edges={interiorEdges}
                  nodeTypes={interiorNodeTypes}
                  nodesConnectable={false}
                  nodesDraggable={false}
                  deleteKeyCode={null}
                  fitView
                  proOptions={{ hideAttribution: true }}
                  minZoom={0.3}
                >
                  <Background gap={20} size={1.6} color="var(--color-text-faint)" />
                </ReactFlow>
              )}
            </div>

            <div className="topology-interior__history">
              <div className="topology-interior__history-title">
                Historique des couches de l'image — <code>docker history</code>
              </div>
              {!imageRef && <div className="empty-state">Image introuvable parmi les images suivies.</div>}
              {imageRef && historyStatus === "loading" && !historyLayers && (
                <div className="empty-state">Chargement…</div>
              )}
              {imageRef && historyStatus === "error" && <div className="error-banner">{historyError}</div>}
              {historyLayers && (
                <ol className="topology-interior__layers">
                  {historyLayers.map((layer, index) => (
                    <li key={`${layer.id}-${index}`} className="topology-interior__layer">
                      <span className="topology-interior__layer-size">{formatMem(layer.sizeBytes)}</span>
                      <span className="topology-interior__layer-cmd" title={layer.createdBy}>
                        {layer.createdBy || "—"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}

      {nodeMenu && (
        <ContextMenu x={nodeMenu.x} y={nodeMenu.y} onClose={() => setNodeMenu(null)} items={nodeMenuItems(nodeMenu.node)} />
      )}
    </div>
  );
}
