import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  ReactFlow,
  Background,
  BaseEdge,
  MiniMap,
  MarkerType,
  Handle,
  Position,
  getBezierPath,
  useStore,
  applyNodeChanges,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeProps,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchTopology, fetchTopologyPositions, saveTopologyPositions } from "@/features/topology/topologySlice";
import {
  createContainer,
  renameContainer,
  runContainerAction,
  type LifecycleAction,
} from "@/features/containers/containersSlice";
import { createVolume, removeVolume } from "@/features/volumes/volumesSlice";
import {
  connectContainerToNetwork,
  createNetwork,
  disconnectContainerFromNetwork,
  removeNetwork,
} from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import Skeleton from "@/components/Skeleton";
import { IconContainers, IconNetworks, IconVm, IconVolumes } from "@/components/icons";
import type { TopologyNode } from "@/types";

/** Nombre de nœuds squelettes par colonne (volumes / conteneurs / networks) pendant le premier
 * chargement — silhouette approximative, pas besoin de coller exactement au nombre réel. */
const SKELETON_COLUMN_ROWS = [2, 3, 2];

const REFRESH_INTERVAL_MS = 15_000;
// Colonne "nutanix-vm" à part, après network — nœuds isolés (jamais d'arête vers Docker), une
// colonne dédiée les garde lisibles plutôt que de les mélanger aux conteneurs.
const COLUMN_X: Record<TopologyNode["kind"], number> = { volume: 0, container: 340, network: 680, "nutanix-vm": 1020 };
const ROW_HEIGHT = 130;
const NETWORK_DRIVERS = ["bridge", "overlay", "host", "none"];
const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  remove: "Supprimer",
};

const KIND_ICON: Record<TopologyNode["kind"], (props: { className?: string }) => JSX.Element> = {
  container: IconContainers,
  volume: IconVolumes,
  network: IconNetworks,
  "nutanix-vm": IconVm,
};

/** "container:abcd1234" -> "abcd1234" (l'id du nœud préfixe toujours son type). */
function idWithoutPrefix(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

/**
 * Connexions par capacité, ports typés (façon Railway) — chaque type de nœud déclare la liste des
 * "ports" qu'il expose. Un port a une capacité (ce qu'il peut relier) et un type de Handle React
 * Flow (source/target) qui fixe son côté du nœud. Pour ajouter un futur 4e type de nœud (ex :
 * registry), il suffit de lui déclarer sa propre entrée dans NODE_CAPABILITIES + une entrée dans
 * CAPABILITY_DEFS pour toute nouvelle capacité qu'il introduit — classifyConnection/
 * isValidConnection/handleConnect ci-dessous restent inchangés, ils ne lisent que ces deux tables.
 */
type CapabilityId = "network" | "attach" | "volume-mount" | "provide";

interface PortSpec {
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

const NODE_CAPABILITIES: Record<TopologyNode["kind"], PortSpec[]> = {
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

interface CapabilityDef {
  /** Capacité compatible attendue à l'autre bout de la connexion. */
  linksTo: CapabilityId;
  /** true = action réelle déclenchée au drop (docker network connect) ; false = message d'info. */
  interactive: boolean;
  infoMessage?: string;
}

const VOLUME_MOUNT_INFO =
  "Impossible d'attacher un volume à un conteneur existant : Docker ne permet pas de modifier les montages sans recréer le conteneur.";

const CAPABILITY_DEFS: Record<CapabilityId, CapabilityDef> = {
  network: { linksTo: "attach", interactive: true },
  attach: { linksTo: "network", interactive: true },
  "volume-mount": { linksTo: "provide", interactive: false, infoMessage: VOLUME_MOUNT_INFO },
  provide: { linksTo: "volume-mount", interactive: false, infoMessage: VOLUME_MOUNT_INFO },
};

/** Zoom sémantique : sous ce niveau, un nœud n'affiche plus que son icône et son point de statut. */
const ZOOM_DETAIL_THRESHOLD = 0.6;
/** state.transform du store React Flow est [x, y, zoom] ; ne resélectionne que le zoom pour éviter
 * un re-render de chaque nœud à chaque pan. */
const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

/** Couleurs de la MiniMap par type de nœud — mêmes valeurs que celles utilisées pour l'icône du
 * nœud correspondant dans topology.css (--accent-start, --color-warning, --accent-end). */
const MINIMAP_NODE_COLOR: Record<TopologyNode["kind"], string> = {
  container: "#3b6fef",
  volume: "#f5a524",
  network: "#7c5cfc",
  "nutanix-vm": "#22c55e",
};

function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

// --- Couleur des arêtes selon la santé réelle du/des conteneur(s) qu'elles touchent -------------
// Une arête ne porte aucune donnée de santé propre (voir services/topology.ts côté API) : on lit
// `healthStatus`/`status` du nœud conteneur à l'une ou l'autre extrémité (mount : volume<->
// conteneur ; network : conteneur<->network — il y a toujours exactement un nœud conteneur parmi
// les deux bouts). "stopped" prime sur healthStatus : un conteneur arrêté n'a plus de healthcheck
// qui tourne, ce n'est pas une panne (arrêt souvent volontaire) donc pas rouge, mais clairement
// visuellement "injoignable" (tirets plus espacés, voir topology.css).
type EdgeHealthState = "healthy" | "unhealthy" | "starting" | "none" | "stopped";

const EDGE_STATE_COLOR: Record<EdgeHealthState, string> = {
  healthy: "var(--color-success)",
  unhealthy: "var(--color-critical)",
  starting: "var(--color-warning)",
  none: "var(--color-text-faint)",
  stopped: "var(--color-text-faint)",
};

/** Le nœud conteneur (s'il y en a un) parmi les deux extrémités d'une arête — jamais les deux à
 * la fois dans ce graphe (mount = volume<->conteneur, network = conteneur<->network). */
function edgeContainerNode(edge: TopologyEdgeLike, nodesById: Map<string, TopologyNode>): TopologyNode | null {
  const source = nodesById.get(edge.source);
  if (source?.kind === "container") return source;
  const target = nodesById.get(edge.target);
  if (target?.kind === "container") return target;
  return null;
}

interface TopologyEdgeLike {
  source: string;
  target: string;
}

/** true si l'utilisateur préfère moins d'animations — coupe les particules de flux et les
 * pulsations, garde couleur/information statique (même contrat que le reste du site). */
function usePrefersReducedMotion(): boolean {
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

const edgeTypes = { mountFlow: MountFlowEdge };

function GraphNode({ data, selected }: NodeProps) {
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

const nodeTypes = { graphNode: GraphNode };

/** Ferme un popover au clic en dehors ou à Échap — même pattern que ContextMenu/Topbar. */
function useDismiss(onClose: () => void) {
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

/** Sous-ensemble créable par le popover de création rapide (clic droit sur le canevas) — les
 * VMs Nutanix ne le sont pas (QUAI ne fait que les lire via Prism Central), pas d'entrée pour
 * ce kind ici plutôt qu'une entrée jamais utilisée dans TopologyNode["kind"] au complet. */
type CreatableKind = "container" | "volume" | "network";

interface CreatePopoverProps {
  kind: CreatableKind;
  x: number;
  y: number;
  onClose: () => void;
}

const CREATE_TITLE: Record<CreatableKind, string> = {
  container: "Nouveau conteneur",
  volume: "Nouveau volume",
  network: "Nouveau network",
};

/** Popover de création rapide (clic droit sur le canevas) — réutilise les mêmes thunks Redux
 * que ContainersPage/VolumesPage/NetworksPage, en version minimale positionnée près du clic. */
function CreatePopover({ kind, x, y, onClose }: CreatePopoverProps) {
  const dispatch = useAppDispatch();
  const ref = useDismiss(onClose);
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (kind === "container") {
        const trimmedImage = image.trim();
        if (!trimmedImage) return;
        const result = await dispatch(
          createContainer({
            image: trimmedImage,
            ...(name.trim() ? { name: name.trim() } : {}),
            ports: ports.split(",").map((p) => p.trim()).filter(Boolean),
          }),
        );
        if (createContainer.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du conteneur.");
      } else if (kind === "volume") {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const result = await dispatch(createVolume(trimmedName));
        if (createVolume.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du volume.");
      } else {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const result = await dispatch(createNetwork({ name: trimmedName, driver }));
        if (createNetwork.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du network.");
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = kind === "container" ? image.trim().length > 0 : name.trim().length > 0;

  return (
    <div className="graph-popover" style={{ left: x, top: y }} ref={ref}>
      <div className="graph-popover__title">{CREATE_TITLE[kind]}</div>
      <form onSubmit={handleSubmit}>
        {kind === "container" && (
          <>
            <div className="field">
              <label htmlFor="graph-new-image">Image</label>
              <input
                id="graph-new-image"
                type="text"
                autoFocus
                placeholder="ex : redis:7-alpine"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="graph-new-name">Nom (optionnel)</label>
              <input id="graph-new-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </div>
            <div className="field">
              <label htmlFor="graph-new-ports">Ports (optionnel)</label>
              <input
                id="graph-new-ports"
                type="text"
                placeholder="ex : 8080:80"
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                disabled={busy}
              />
            </div>
          </>
        )}
        {kind === "volume" && (
          <div className="field">
            <label htmlFor="graph-new-volume-name">Nom</label>
            <input
              id="graph-new-volume-name"
              type="text"
              autoFocus
              placeholder="ex : pgdata"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              required
            />
          </div>
        )}
        {kind === "network" && (
          <>
            <div className="field">
              <label htmlFor="graph-new-network-name">Nom</label>
              <input
                id="graph-new-network-name"
                type="text"
                autoFocus
                placeholder="ex : quai-app-net"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="graph-new-network-driver">Driver</label>
              <select id="graph-new-network-driver" value={driver} onChange={(e) => setDriver(e.target.value)} disabled={busy}>
                {NETWORK_DRIVERS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canSubmit}>
            {busy ? "…" : "Créer"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface RenamePopoverProps {
  containerId: string;
  initialName: string;
  x: number;
  y: number;
  onClose: () => void;
}

/** Popover de renommage (menu contextuel d'un nœud conteneur) — POST /api/containers/:id/rename. */
function RenamePopover({ containerId, initialName, x, y, onClose }: RenamePopoverProps) {
  const dispatch = useAppDispatch();
  const ref = useDismiss(onClose);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await dispatch(renameContainer({ id: containerId, name: trimmed }));
    setBusy(false);
    if (renameContainer.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec du renommage.");
    }
  }

  return (
    <div className="graph-popover" style={{ left: x, top: y }} ref={ref}>
      <div className="graph-popover__title">Renommer le conteneur</div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-rename-input">Nouveau nom</label>
          <input
            id="graph-rename-input"
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
            {busy ? "…" : "Renommer"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface TopologyGraphProps {
  height?: number;
  onSelectNode?: (node: TopologyNode | null) => void;
  /** Intervalle de rafraîchissement — 15s par défaut, réduit sur la vue d'ensemble (pièce centrale du dashboard). */
  refreshIntervalMs?: number;
}

export default function TopologyGraph({ height = 460, onSelectNode, refreshIntervalMs = REFRESH_INTERVAL_MS }: TopologyGraphProps) {
  const dispatch = useAppDispatch();
  const { data, status, error, positions } = useAppSelector((s) => s.topology);
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  const confirm = useConfirm();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; source: string; target: string; kind: string } | null>(null);
  const [popover, setPopover] = useState<{ kind: CreatableKind; x: number; y: number } | null>(null);
  const [renamePopover, setRenamePopover] = useState<{ containerId: string; initialName: string; x: number; y: number } | null>(
    null,
  );
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);

  useEffect(() => {
    dispatch(fetchTopology());
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchTopology());
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [dispatch, refreshIntervalMs]);

  // Canevas libre et persistant : positions déplacées à la main, chargées une seule fois depuis
  // le compte de l'utilisateur connecté (GET /api/topology/positions — pas localStorage, la
  // disposition suit l'identité, pas l'appareil) puis tenues à jour par handleNodeDragStop.
  useEffect(() => {
    dispatch(fetchTopologyPositions());
  }, [dispatch]);

  // Recalcule la liste des nœuds à chaque nouveau fetch (toutes les 15s) ou changement de
  // positions sauvegardées — sans écraser la position d'un nœud déjà positionné (à la main ou par
  // un calcul précédent), contrairement à l'ancien recalcul systématique en 3 colonnes fixes.
  useEffect(() => {
    if (!data) {
      setFlowNodes([]);
      return;
    }
    const columnCounters: Record<TopologyNode["kind"], number> = { volume: 0, container: 0, network: 0, "nutanix-vm": 0 };
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return data.nodes.map((n) => {
        const row = columnCounters[n.kind]++;
        const defaultPosition = { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT };
        const position = positions[n.id] ?? prevById.get(n.id)?.position ?? defaultPosition;
        return {
          id: n.id,
          type: "graphNode",
          position,
          data: n as unknown as Record<string, unknown>,
        };
      });
    });
  }, [data, positions]);

  const nodes = useMemo(
    () => flowNodes.map((n) => ({ ...n, selected: n.id === selectedId })),
    [flowNodes, selectedId],
  );

  // Recherche O(1) du nœud à chaque bout d'une arête pour en dériver sa couleur (voir
  // edgeContainerNode ci-dessus) — recalculée seulement quand les données de topologie changent.
  const nodesById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  const edges = useMemo<Edge[]>(() => {
    if (!data) return [];
    return data.edges.map((e) => {
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
  }, [data, nodesById]);

  function selectNode(id: string | null) {
    setSelectedId(id);
    const topoNode = id ? data?.nodes.find((n) => n.id === id) ?? null : null;
    onSelectNode?.(topoNode);
  }

  /** Applique les changements React Flow (drag en cours, redimensionnement...) à l'état local des
   * nœuds — nécessaire pour que le drag reste fluide, un <ReactFlow> "contrôlé" sans ceci ignore
   * les déplacements en cours de geste. */
  function handleNodesChange(changes: NodeChange[]) {
    setFlowNodes((nds) => applyNodeChanges(changes, nds));
  }

  /** Fin de glissé d'un nœud : persiste sa position finale par id, sur le compte de l'utilisateur
   * connecté (PUT /api/topology/positions) — elle survivra au prochain fetch (15s), à un
   * rechargement de page, et suit désormais l'utilisateur d'un poste à l'autre. */
  function handleNodeDragStop(_event: unknown, node: Node) {
    dispatch(saveTopologyPositions({ ...positions, [node.id]: { x: node.position.x, y: node.position.y } }));
  }

  function findPort(nodeId: string | null | undefined, handleId: string | null | undefined): PortSpec | null {
    if (!nodeId || !handleId) return null;
    const node = data?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    return NODE_CAPABILITIES[node.kind].find((p) => p.id === handleId) ?? null;
  }

  /** Classe une tentative de connexion glissée en comparant les capacités des deux ports visés
   * (table déclarative NODE_CAPABILITIES/CAPABILITY_DEFS ci-dessus) — remplace l'ancienne logique
   * à deux paires de kinds codées en dur, sans changer le comportement fonctionnel : container<->
   * network reste la seule connexion réelle, container<->volume reste un message d'information. */
  function classifyConnection(connection: Edge | Connection): CapabilityDef | null {
    if (!connection.source || !connection.target || connection.source === connection.target) return null;
    const sourcePort = findPort(connection.source, connection.sourceHandle);
    const targetPort = findPort(connection.target, connection.targetHandle);
    if (!sourcePort || !targetPort) return null;
    if (CAPABILITY_DEFS[sourcePort.capability].linksTo !== targetPort.capability) return null;
    return CAPABILITY_DEFS[sourcePort.capability];
  }

  function isValidConnection(connection: Edge | Connection): boolean {
    return classifyConnection(connection) !== null;
  }

  function handleConnect(connection: Connection) {
    const def = classifyConnection(connection);
    if (!def) return;
    if (!def.interactive) {
      if (def.infoMessage) dispatch(pushNotification({ level: "info", message: def.infoMessage }));
      return;
    }
    // Seule capacité interactive à ce jour : container <-> network (docker network connect réel).
    const sourceNode = data?.nodes.find((n) => n.id === connection.source);
    const containerNodeId = sourceNode?.kind === "container" ? connection.source! : connection.target!;
    const networkNodeId = containerNodeId === connection.source ? connection.target! : connection.source!;
    const containerId = idWithoutPrefix(containerNodeId);
    const networkId = idWithoutPrefix(networkNodeId);
    dispatch(connectContainerToNetwork({ networkId, containerId })).then((result) => {
      if (connectContainerToNetwork.fulfilled.match(result)) dispatch(fetchTopology());
    });
  }

  function handleNodeClick(_event: unknown, node: Node) {
    selectNode(node.id === selectedId ? null : node.id);
  }

  function handlePaneContextMenu(event: MouseEvent | React.MouseEvent) {
    event.preventDefault();
    if (!operate) return;
    const mouseEvent = event as MouseEvent;
    setCanvasMenu({ x: mouseEvent.clientX, y: mouseEvent.clientY });
  }

  function handleNodeContextMenu(event: React.MouseEvent, node: Node) {
    event.preventDefault();
    const topoNode = node.data as unknown as TopologyNode;
    setNodeMenu({ x: event.clientX, y: event.clientY, node: topoNode });
  }

  function handleEdgeContextMenu(event: React.MouseEvent, edge: Edge) {
    event.preventDefault();
    if (!operate) return;
    const kind = (edge.data as { kind?: string } | undefined)?.kind ?? "mount";
    setEdgeMenu({ x: event.clientX, y: event.clientY, source: edge.source, target: edge.target, kind });
  }

  async function handleContainerAction(id: string, name: string, action: LifecycleAction) {
    if (action === "stop" || action === "remove") {
      const ok = await confirm({
        title: `${ACTION_LABEL[action]} le conteneur`,
        description:
          action === "remove"
            ? `Confirmer la suppression de "${name}" ? Cette action est irréversible.`
            : `Confirmer l'arrêt de "${name}" ?`,
        confirmLabel: ACTION_LABEL[action],
        variant: "danger",
      });
      if (!ok) return;
    }
    const result = await dispatch(runContainerAction({ id, action }));
    if (runContainerAction.fulfilled.match(result)) dispatch(fetchTopology());
  }

  async function handleRemoveVolume(name: string) {
    const ok = await confirm({
      title: "Supprimer le volume",
      description: `Confirmer la suppression du volume "${name}" ? Les données qu'il contient seront perdues.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeVolume(name));
    if (removeVolume.fulfilled.match(result)) dispatch(fetchTopology());
  }

  async function handleRemoveNetwork(id: string, name: string) {
    const ok = await confirm({
      title: "Supprimer le network",
      description: `Confirmer la suppression du network "${name}" ?`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeNetwork({ id, name }));
    if (removeNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  async function handleDisconnectEdge(source: string, target: string) {
    const containerId = idWithoutPrefix(source);
    const networkId = idWithoutPrefix(target);
    const ok = await confirm({
      title: "Déconnecter du network",
      description: "Le conteneur sera détaché de ce network.",
      confirmLabel: "Déconnecter",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(disconnectContainerFromNetwork({ networkId, containerId }));
    if (disconnectContainerFromNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  function nodeMenuItems(node: TopologyNode, x: number, y: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => selectNode(node.id) }];
    if (!operate) return items;

    if (node.kind === "container") {
      const id = idWithoutPrefix(node.id);
      if (node.status === "running") {
        items.push({ label: "Arrêter", onClick: () => handleContainerAction(id, node.label, "stop") });
      } else {
        items.push({ label: "Démarrer", onClick: () => handleContainerAction(id, node.label, "start") });
      }
      items.push({ label: "Redémarrer", onClick: () => handleContainerAction(id, node.label, "restart") });
      items.push({
        label: "Renommer",
        onClick: () => setRenamePopover({ containerId: id, initialName: node.label, x, y }),
      });
      items.push({ label: "Supprimer", danger: true, onClick: () => handleContainerAction(id, node.label, "remove") });
    } else if (node.kind === "volume") {
      const name = idWithoutPrefix(node.id);
      items.push({ label: "Supprimer", danger: true, onClick: () => handleRemoveVolume(name) });
    } else if (node.kind === "network") {
      const id = idWithoutPrefix(node.id);
      if (!["bridge", "host", "none"].includes(node.label)) {
        items.push({ label: "Supprimer", danger: true, onClick: () => handleRemoveNetwork(id, node.label) });
      }
    }
    return items;
  }

  if (status === "loading" && !data) {
    return (
      <div className="topology-graph topology-graph--skeleton" style={{ height }}>
        {SKELETON_COLUMN_ROWS.map((rowCount, columnIndex) => (
          <div className="topology-skeleton-column" key={columnIndex}>
            {Array.from({ length: rowCount }).map((_, rowIndex) => (
              <div className="topology-skeleton-node" key={rowIndex}>
                <div className="skeleton-card__row">
                  <Skeleton variant="circle" width={22} height={22} />
                  <Skeleton variant="text" height={12} width="60%" />
                </div>
                <Skeleton variant="text" height={10} width="80%" />
                <Skeleton variant="text" height={8} width="100%" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (error && !data) {
    return <div className="error-banner">{error}</div>;
  }
  if (data && data.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height }}>
        Aucune ressource à représenter pour l'instant.
      </div>
    );
  }

  return (
    <div className="topology-graph" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={handleNodeClick}
        onPaneClick={() => selectNode(null)}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        nodesConnectable={operate}
        // La disposition est persistée par compte (PUT /api/topology/positions, réservé
        // operator/admin comme toute route mutante — voir plugins/auth.ts) : un viewer ne peut
        // donc pas la faire persister, autant ne pas lui laisser croire qu'un glissé "prend".
        nodesDraggable={operate}
        deleteKeyCode={null}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
      >
        {/* Pas de <Controls> (zoom +/-, fit-view) — la souris (molette + glisser) suffit déjà à
            tout faire ; remplacé plus tard par des boutons en overlay sur mesure. */}
        <Background gap={20} size={1.6} color="var(--color-text-faint)" />
        <MiniMap
          position="top-left"
          nodeColor={(n) => MINIMAP_NODE_COLOR[(n.data as unknown as TopologyNode).kind]}
          nodeStrokeWidth={0}
          nodeBorderRadius={4}
          maskColor="rgba(11, 12, 16, 0.75)"
          pannable
          zoomable
        />
      </ReactFlow>

      {canvasMenu && operate && (
        <ContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(null)}
          items={[
            { label: "Nouveau conteneur", onClick: () => setPopover({ kind: "container", x: canvasMenu.x, y: canvasMenu.y }) },
            { label: "Nouveau volume", onClick: () => setPopover({ kind: "volume", x: canvasMenu.x, y: canvasMenu.y }) },
            { label: "Nouveau network", onClick: () => setPopover({ kind: "network", x: canvasMenu.x, y: canvasMenu.y }) },
          ]}
        />
      )}

      {nodeMenu && (
        <ContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          onClose={() => setNodeMenu(null)}
          items={nodeMenuItems(nodeMenu.node, nodeMenu.x, nodeMenu.y)}
        />
      )}

      {edgeMenu && (
        <ContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          onClose={() => setEdgeMenu(null)}
          items={
            edgeMenu.kind === "network"
              ? [{ label: "Déconnecter du network", danger: true, onClick: () => handleDisconnectEdge(edgeMenu.source, edgeMenu.target) }]
              : [{ label: "Détachement impossible sans recréer le conteneur", onClick: () => {}, disabled: true }]
          }
        />
      )}

      {popover && <CreatePopover kind={popover.kind} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}

      {renamePopover && (
        <RenamePopover
          containerId={renamePopover.containerId}
          initialName={renamePopover.initialName}
          x={renamePopover.x}
          y={renamePopover.y}
          onClose={() => setRenamePopover(null)}
        />
      )}
    </div>
  );
}
