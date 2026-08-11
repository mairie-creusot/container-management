import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  fetchEnvironmentNodes,
  fetchEnvironments,
  selectNode,
  toggleEnvironmentExpanded,
} from "@/features/clusters/clustersSlice";
import Inspector from "@/components/Inspector";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import { IconChevron } from "@/components/icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Mo";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 1) return `${(bytes / (1024 * 1024)).toFixed(0)} Mo`;
  return `${gb.toFixed(1)} Go`;
}

export default function EnvironmentsPage() {
  const dispatch = useAppDispatch();
  const { environments, status, error, expandedIds, nodesStatusByEnv, selectedNodeId } =
    useAppSelector((s) => s.clusters);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);

  useEffect(() => {
    if (status === "idle") dispatch(fetchEnvironments());
  }, [dispatch, status]);

  function handleToggle(environmentId: string) {
    const willExpand = !expandedIds.includes(environmentId);
    dispatch(toggleEnvironmentExpanded(environmentId));
    if (willExpand && nodesStatusByEnv[environmentId] !== "ready") {
      dispatch(fetchEnvironmentNodes(environmentId));
    }
  }

  const visible = environments.filter(
    (env) => !searchQuery || env.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const selectedNode = environments
    .flatMap((env) => env.nodes)
    .find((node) => node.id === selectedNodeId) ?? null;
  const selectedNodeEnv = selectedNode
    ? environments.find((env) => env.id === selectedNode.environmentId)
    : null;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Environnements</h2>
            <p>Environnements Swarm, Kubernetes et Compose, et leurs nœuds.</p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && environments.length === 0 && (
          <div className="empty-state">Chargement…</div>
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun environnement configuré.</div>
        )}

        <div className="env-tree">
          {visible.map((env) => {
            const isOpen = expandedIds.includes(env.id);
            const nodesStatus = nodesStatusByEnv[env.id] ?? "idle";
            return (
              <div className="env-node" key={env.id}>
                <button type="button" className="env-node__head" onClick={() => handleToggle(env.id)}>
                  <span className={`env-node__caret${isOpen ? " is-open" : ""}`}>
                    <IconChevron />
                  </span>
                  <span className="env-node__name">{env.name}</span>
                  <span className="env-node__orchestrator">{env.orchestrator}</span>
                  <StatusPill status={env.status} />
                </button>

                {env.hostInfo && (
                  <div className="env-node__hostinfo">
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.serverVersion}</strong> Docker Engine
                    </span>
                    <span className="env-node__hostinfo-item cell-mono">{env.hostInfo.endpoint}</span>
                    <span className="env-node__hostinfo-sep" />
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.containersRunning}</strong> actif(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.containersStopped}</strong> arrêté(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.imagesCount}</strong> image(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.volumesCount}</strong> volume(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.cpus}</strong> CPU
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{formatBytes(env.hostInfo.totalMemBytes)}</strong> RAM
                    </span>
                    <span className="env-node__hostinfo-item">{env.hostInfo.os} · {env.hostInfo.architecture}</span>
                  </div>
                )}

                {isOpen && (
                  <div className="node-list">
                    {nodesStatus === "loading" && env.nodes.length === 0 && (
                      <div className="empty-state">Chargement des nœuds…</div>
                    )}
                    {env.nodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className={`node-row${node.id === selectedNodeId ? " is-selected" : ""}`}
                        onClick={() => dispatch(selectNode(node.id))}
                      >
                        <span className="node-row__name">{node.id}</span>
                        <span className="node-row__role">{node.role}</span>
                        <span className="cell-mono">{node.containerCount} conteneur(s)</span>
                        <StatusPill status={node.status} />
                      </button>
                    ))}
                    {nodesStatus !== "loading" && env.nodes.length === 0 && (
                      <div className="empty-state">Aucun nœud.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Inspector
        title={selectedNode?.id}
        subtitle={selectedNodeEnv ? `${selectedNodeEnv.name} · ${selectedNode?.role}` : undefined}
        onClose={() => dispatch(selectNode(null))}
      >
        {selectedNode && (
          <>
            <StatusPill status={selectedNode.status} />
            <Gauge label="CPU" percent={selectedNode.cpuPercent} />
            <Gauge label="Mémoire" percent={selectedNode.memPercent} />
            <KeyValueList
              rows={[
                { key: "Rôle", value: selectedNode.role },
                { key: "Conteneurs", value: String(selectedNode.containerCount) },
              ]}
            />
          </>
        )}
      </Inspector>
    </div>
  );
}
