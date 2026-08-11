import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchTopology } from "@/features/topology/topologySlice";
import { IconContainers, IconNetworks, IconVolumes } from "@/components/icons";
import type { TopologyNode } from "@/types";

const REFRESH_INTERVAL_MS = 15_000;
const COLUMN_X: Record<TopologyNode["kind"], number> = { volume: 0, container: 340, network: 680 };
const ROW_HEIGHT = 110;

const KIND_ICON: Record<TopologyNode["kind"], (props: { className?: string }) => JSX.Element> = {
  container: IconContainers,
  volume: IconVolumes,
  network: IconNetworks,
};

const KIND_LABEL: Record<TopologyNode["kind"], string> = {
  container: "Conteneur",
  volume: "Volume",
  network: "Network",
};

function GraphNode({ data, selected }: NodeProps) {
  const node = data as unknown as TopologyNode;
  const Icon = KIND_ICON[node.kind];
  return (
    <div className={`topology-node topology-node--${node.kind} topology-node--${node.status}${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="topology-node__head">
        <span className="topology-node__icon">
          <Icon />
        </span>
        <span className="topology-node__label">{node.label}</span>
      </div>
      <div className="topology-node__subtitle">{node.subtitle}</div>
      <div className={`topology-node__status topology-node__status--${node.status}`}>
        <span className="topology-node__status-dot" />
        {node.status === "running" ? "En cours" : node.status === "stopped" ? "Arrêté" : node.status}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { graphNode: GraphNode };

interface TopologyGraphProps {
  height?: number;
  onSelectNode?: (node: TopologyNode | null) => void;
}

export default function TopologyGraph({ height = 460, onSelectNode }: TopologyGraphProps) {
  const dispatch = useAppDispatch();
  const { data, status, error } = useAppSelector((s) => s.topology);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchTopology());
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchTopology());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };

    const columnCounters: Record<TopologyNode["kind"], number> = { volume: 0, container: 0, network: 0 };
    const flowNodes: Node[] = data.nodes.map((n) => {
      const row = columnCounters[n.kind]++;
      return {
        id: n.id,
        type: "graphNode",
        position: { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT },
        data: n as unknown as Record<string, unknown>,
        selected: n.id === selectedId,
      };
    });

    const flowEdges: Edge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
      style: { stroke: "var(--color-text-faint)", strokeDasharray: "4 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-text-faint)", width: 16, height: 16 },
    }));

    return { nodes: flowNodes, edges: flowEdges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedId]);

  function handleNodeClick(_event: unknown, node: Node) {
    const next = node.id === selectedId ? null : node.id;
    setSelectedId(next);
    const topoNode = data?.nodes.find((n) => n.id === next) ?? null;
    onSelectNode?.(topoNode);
  }

  if (status === "loading" && !data) {
    return <div className="empty-state" style={{ height }}>Chargement de la topologie…</div>;
  }
  if (error && !data) {
    return <div className="error-banner">{error}</div>;
  }
  if (data && data.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height }}>
        Aucune ressource Docker à représenter pour l'instant.
      </div>
    );
  }

  return (
    <div className="topology-graph" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={() => {
          setSelectedId(null);
          onSelectNode?.(null);
        }}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
      >
        <Background gap={18} size={1} color="var(--color-border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
