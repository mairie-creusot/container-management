import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  getBezierPath,
  useStore,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { IconContainers, IconNetworks, IconVm, IconVolumes } from "@/components/icons";
import type { TopologyEdge, TopologyNode } from "@/types";

/**
 * Éléments du graphe de topologie partagés entre le graphe principal (TopologyGraph.tsx) et le
 * sous-graphe de dépendances ouvert au double-clic (TopologySubGraphModal.tsx) — extraits ici pour
 * que les deux rendus aient EXACTEMENT le même look (mêmes nœuds, mêmes arêtes, mêmes couleurs),
 * sans dupliquer le JSX/CSS. Voir ARCHITECTURE.md § "Graphe de topologie" pour le contexte complet.
 */

/** "container:abcd1234" -> "abcd1234" (l'id du nœud préfixe toujours son type). */
export function idWithoutPrefix(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

export function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

export const KIND_ICON: Record<TopologyNode["kind"], (props: { className?: string }) => JSX.Element> = {
  container: IconContainers,
  volume: IconVolumes,
  network: IconNetworks,
  "nutanix-vm": IconVm,
};

/** Couleurs de la MiniMap par type de nœud — mêmes valeurs que celles utilisées pour l'icône du
 * nœud correspondant dans topology.css (--accent-start, --color-warning, --accent-end). */
export const MINIMAP_NODE_COLOR: Record<TopologyNode["kind"], string> = {
  container: "#3b6fef",
  volume: "#f5a524",
  network: "#7c5cfc",
  "nutanix-vm": "#22c55e",
};

/**
 * Connexions par capacité, ports typés (façon Railway) — chaque type de nœud déclare la liste des
 * "ports" qu'il expose. Un port a une capacité (ce qu'il peut relier) et un type de Handle React
 * Flow (source/target) qui fixe son côté du nœud. Pour ajouter un futur 4e type de nœud (ex :
 * registry), il suffit de lui déclarer sa propre entrée dans NODE_CAPABILITIES + une entrée dans
 * CAPABILITY_DEFS pour toute nouvelle capacité qu'il introduit — classifyConnection/
 * isValidConnection/handleConnect (TopologyGraph.tsx) restent inchangés, ils ne lisent que ces
 * deux tables.
 */
export type CapabilityId = "network" | "attach" | "volume-mount" | "provide";

export interface PortSpec {
  /** Id du Handle React Flow — unique au sein d'un même type de nœud. */
  id: string;
  capability: CapabilityId;
  handleType: "source" | "target";
  position: Position;
  /** Tooltip du Handle. */
  label: string;
  /** Suffixe de classe .topology-handle--<token> — couleur reprise de celle de l'icône du même
   * type de nœud (variables.css), pas de couleur arbitraire ajoutée. */
  colorToken: "network" | "volume";
}

export const NODE_CAPABILITIES: Record<TopologyNode["kind"], PortSpec[]> = {
  container: [
    { id: "network", capability: "network", handleType: "source", position: Position.Right, label: "Network", colorToken: "network" },
    {
      id: "volume-mount",
      capability: "volume-mount",
      handleType: "target",
      position: Position.Left,
      label: "Volume (lecture seule)",
      colorToken: "volume",
    },
  ],
  volume: [
    { id: "provide", capability: "provide", handleType: "source", position: Position.Right, label: "Fournit un volume", colorToken: "volume" },
  ],
  network: [
    { id: "attach", capability: "attach", handleType: "target", position: Position.Left, label: "Attache un conteneur", colorToken: "network" },
  ],
  // Aucun port pour ce premier lot : les VMs Nutanix sont indépendantes de l'infra Docker locale
  // (voir services/topology.ts), pas de capacité de connexion à déclarer. GraphNode ci-dessous
  // gère déjà un tableau de ports vide sans erreur (ports.map sur []).
  "nutanix-vm": [],
};

export interface CapabilityDef {
  /** Capacité compatible attendue à l'autre bout de la connexion. */
  linksTo: CapabilityId;
  /** true = action réelle déclenchée au drop (docker network connect) ; false = message d'info. */
  interactive: boolean;
  infoMessage?: string;
}

export const VOLUME_MOUNT_INFO =
  "Impossible d'attacher un volume à un conteneur existant : Docker ne permet pas de modifier les montages sans recréer le conteneur.";

export const CAPABILITY_DEFS: Record<CapabilityId, CapabilityDef> = {
  network: { linksTo: "attach", interactive: true },
  attach: { linksTo: "network", interactive: true },
  "volume-mount": { linksTo: "provide", interactive: false, infoMessage: VOLUME_MOUNT_INFO },
  provide: { linksTo: "volume-mount", interactive: false, infoMessage: VOLUME_MOUNT_INFO },
};

/** Zoom sémantique : sous ce niveau, un nœud n'affiche plus que son icône et son point de statut. */
export const ZOOM_DETAIL_THRESHOLD = 0.6;
/** state.transform du store React Flow est [x, y, zoom] ; ne resélectionne que le zoom pour éviter
 * un re-render de chaque nœud à chaque pan. */
export const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

// --- Couleur des arêtes selon la santé réelle du/des conteneur(s) qu'elles touchent -------------
// Une arête ne porte aucune donnée de santé propre (voir services/topology.ts côté API) : on lit
// `healthStatus`/`status` du nœud conteneur à l'une ou l'autre extrémité (mount : volume<->
// conteneur ; network : conteneur<->network — il y a toujours exactement un nœud conteneur parmi
// les deux bouts). "stopped" prime sur healthStatus : un conteneur arrêté n'a plus de healthcheck
// qui tourne, ce n'est pas une panne (arrêt souvent volontaire) donc pas rouge, mais clairement
// visuellement "injoignable" (tirets plus espacés, voir topology.css).
export type EdgeHealthState = "healthy" | "unhealthy" | "starting" | "none" | "stopped";

export const EDGE_STATE_COLOR: Record<EdgeHealthState, string> = {
  healthy: "var(--color-success)",
  unhealthy: "var(--color-critical)",
  starting: "var(--color-warning)",
  none: "var(--color-text-faint)",
  stopped: "var(--color-text-faint)",
};

export interface TopologyEdgeLike {
  source: string;
  target: string;
}

/** Le nœud conteneur (s'il y en a un) parmi les deux extrémités d'une arête — jamais les deux à
 * la fois dans ce graphe (mount = volume<->conteneur, network = conteneur<->network). */
export function edgeContainerNode(edge: TopologyEdgeLike, nodesById: Map<string, TopologyNode>): TopologyNode | null {
  const source = nodesById.get(edge.source);
  if (source?.kind === "container") return source;
  const target = nodesById.get(edge.target);
  if (target?.kind === "container") return target;
  return null;
}

/**
 * Construit les arêtes React Flow (couleur/état/animation) depuis les TopologyEdge bruts — logique
 * partagée par le graphe principal ET le sous-graphe de dépendances, pour un rendu identique.
 */
export function buildTopologyEdges(edges: TopologyEdge[], nodesById: Map<string, TopologyNode>): Edge[] {
  return edges.map((e) => {
    const containerNode = edgeContainerNode(e, nodesById);
    const stopped = containerNode ? containerNode.status !== "running" : false;
    const state: EdgeHealthState = stopped ? "stopped" : (containerNode?.healthStatus ?? "none");
    const color = EDGE_STATE_COLOR[state];
    const isMount = e.kind === "mount";
    // "stopped" prime sur le type : tirets larges et espacés, quel que soit mount/network.
    // Sinon : réseau garde ses tirets fins animés (existant) ; mount reste en trait plein — les
    // particules de MountFlowEdge assurent seules l'impression de flux, un dasharray en plus
    // ferait double emploi visuel.
    const strokeDasharray = state === "stopped" ? "2 8" : isMount ? undefined : "4 4";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      ...(isMount ? { type: "mountFlow" } : {}),
      animated: !isMount,
      className: `topology-edge topology-edge--${e.kind} topology-edge--${state}`,
      style: { stroke: color, ...(strokeDasharray ? { strokeDasharray } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      data: { kind: e.kind, state, color },
    };
  });
}

/** true si l'utilisateur préfère moins d'animations — coupe les particules de flux et les
 * pulsations, garde couleur/information statique (même contrat que le reste du site). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(query.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/** Nombre de particules simultanées par arête "mount" — impression de flux continu sans arête
 * trop "vide" entre deux particules, tout en restant un petit nombre fixe d'éléments SVG par
 * arête (coût de rendu borné même avec des dizaines d'arêtes affichées en même temps). */
const MOUNT_PARTICLE_COUNT = 3;
const MOUNT_PARTICLE_DURATION_S = 2.2;

/**
 * Arête "mount" (conteneur <-> volume, des fichiers/données qui transitent) : un rendu distinct
 * de l'animation générique "tirets qui défilent" des arêtes "network" — trait plein + particules
 * qui voyagent réellement le long du tracé de l'arête via la propriété CSS `offset-path` (animation
 * native du navigateur sur la propriété `offset-distance`, donc aucun recalcul JS par frame, coût
 * quasi nul même avec beaucoup d'arêtes à l'écran). Rien ne "coule" si le conteneur est arrêté
 * (aucune donnée ne transite réellement) ou si l'utilisateur préfère moins d'animations — dans les
 * deux cas on retombe sur le simple trait coloré, sans les particules.
 */
function MountFlowEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const reducedMotion = usePrefersReducedMotion();
  const edgeData = data as { state?: EdgeHealthState; color?: string } | undefined;
  const flowing = edgeData?.state !== "stopped" && !reducedMotion;
  return (
    <>
      <BaseEdge id={id} path={edgePath} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      {flowing &&
        Array.from({ length: MOUNT_PARTICLE_COUNT }).map((_, particleIndex) => {
          const particleColor = edgeData?.color ?? "var(--color-warning)";
          const particleStyle: CSSProperties = {
            offsetPath: `path('${edgePath}')`,
            animationDuration: `${MOUNT_PARTICLE_DURATION_S}s`,
            animationDelay: `${(particleIndex * MOUNT_PARTICLE_DURATION_S) / MOUNT_PARTICLE_COUNT}s`,
            fill: particleColor,
            color: particleColor, // lu par le filtre drop-shadow (currentColor) en CSS, voir topology.css
          };
          return <circle key={particleIndex} r={2.6} className="topology-edge-particle" style={particleStyle} />;
        })}
    </>
  );
}

export const edgeTypes = { mountFlow: MountFlowEdge };

export function GraphNode({ data, selected }: NodeProps) {
  const node = data as unknown as TopologyNode;
  const Icon = KIND_ICON[node.kind];
  const isContainer = node.kind === "container";
  const ports = NODE_CAPABILITIES[node.kind];
  // Zoom sémantique : en dessous du seuil, on masque libellé/badges/métriques et on ne garde que
  // l'icône + le point de statut — évite un canevas illisible une fois dézoomé sur toute l'infra.
  const zoom = useStore(zoomSelector);
  const isCompact = zoom < ZOOM_DETAIL_THRESHOLD;
  return (
    <div
      className={`topology-node topology-node--${node.kind} topology-node--${node.status}${selected ? " is-selected" : ""}${isCompact ? " topology-node--compact" : ""}`}
      title={isCompact ? node.label : undefined}
    >
      {ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.handleType}
          position={port.position}
          className={`topology-handle topology-handle--${port.colorToken}${
            CAPABILITY_DEFS[port.capability].interactive ? "" : " topology-handle--readonly"
          }`}
          title={port.label}
        />
      ))}
      <div className="topology-node__head">
        <span className="topology-node__icon">
          <Icon />
        </span>
        <span className="topology-node__label">{node.label}</span>
      </div>
      {isContainer &&
        (node.updateAvailable ||
          node.drift ||
          !!node.vulnCritical ||
          !!node.vulnHigh ||
          node.healthStatus === "unhealthy" ||
          node.healthStatus === "starting") && (
        <div className="topology-node__badges">
          {node.healthStatus === "unhealthy" && (
            <span
              className="topology-badge topology-badge--critical topology-badge--pulse"
              title="Healthcheck Docker natif en échec (State.Health.Status = unhealthy)"
            >
              Unhealthy
            </span>
          )}
          {node.healthStatus === "starting" && (
            <span
              className="topology-badge topology-badge--warning"
              title="Healthcheck Docker natif en cours de démarrage (State.Health.Status = starting)"
            >
              Healthcheck…
            </span>
          )}
          {node.updateAvailable && (
            <span className="topology-badge topology-badge--warning" title="Mise à jour d'image disponible">
              MàJ dispo
            </span>
          )}
          {node.drift && (
            <span className="topology-badge topology-badge--critical" title="Dérive GitOps détectée">
              Dérive GitOps
            </span>
          )}
          {!!node.vulnCritical && (
            <span
              className="topology-badge topology-badge--critical"
              title={`${node.vulnCritical} vulnérabilité(s) critique(s) détectée(s) (dernier scan)`}
            >
              {node.vulnCritical} critique{node.vulnCritical > 1 ? "s" : ""}
            </span>
          )}
          {!node.vulnCritical && !!node.vulnHigh && (
            <span
              className="topology-badge topology-badge--warning"
              title={`${node.vulnHigh} vulnérabilité(s) élevée(s) détectée(s) (dernier scan)`}
            >
              {node.vulnHigh} élevée{node.vulnHigh > 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
      <div className="topology-node__subtitle">{node.subtitle}</div>
      {isContainer && typeof node.cpuPercent === "number" && (
        <div className="topology-node__metrics">
          <div className="topology-node__metric-row">
            <span className="topology-node__metric-label">CPU</span>
            <div className="topology-node__metric-track">
              <div className="topology-node__metric-fill" style={{ width: `${Math.min(100, node.cpuPercent)}%` }} />
            </div>
            <span className="topology-node__metric-value">{node.cpuPercent.toFixed(0)}%</span>
          </div>
          <div className="topology-node__metric-mem">{formatMem(node.memBytes ?? 0)}</div>
        </div>
      )}
      <div className={`topology-node__status topology-node__status--${node.status}`}>
        <span className="topology-node__status-dot" />
        <span className="topology-node__status-label">
          {node.status === "running"
            ? "En cours"
            : node.status === "stopped"
              ? "Arrêté"
              : node.status === "neutral"
                ? "Indéterminé"
                : node.status}
        </span>
      </div>
    </div>
  );
}

export const nodeTypes = { graphNode: GraphNode };

/** Ferme un popover au clic en dehors ou à Échap — même pattern que ContextMenu/Topbar. Partagé
 * par les popovers de création/renommage du graphe principal et par tout futur usage similaire. */
export function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as globalThis.Node)) onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);
  return ref;
}
