import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  applyNodeChanges,
  type Node,
  type Edge,
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
  fetchNetworks,
  removeNetwork,
} from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import Skeleton from "@/components/Skeleton";
import TopologyNodeDetailPanel from "@/components/TopologyNodeDetailPanel";
import TopologySubGraphPanel from "@/components/TopologySubGraphPanel";
import {
  CAPABILITY_DEFS,
  MINIMAP_NODE_COLOR,
  NODE_CAPABILITIES,
  attachmentToTopologyNode,
  buildTopologyEdges,
  edgeTypes,
  idWithoutPrefix,
  nodeTypes,
  useDismiss,
  usePrefersReducedMotion,
  type CapabilityDef,
  type GraphNodeCallbacks,
  type PortSpec,
} from "@/components/topologyGraphShared";
import type { TopologyNode, TopologyNodeAttachment } from "@/types";

/** Nombre de nœuds squelettes par colonne (volumes / conteneurs / networks) pendant le premier
 * chargement — silhouette approximative, pas besoin de coller exactement au nombre réel. */
const SKELETON_COLUMN_ROWS = [2, 3, 2];

const REFRESH_INTERVAL_MS = 15_000;
// Colonnes "nutanix-vm"/"ad-server" à part, après network — nœuds isolés (jamais d'arête vers
// Docker), des colonnes dédiées les gardent lisibles plutôt que de les mélanger aux conteneurs.
const COLUMN_X: Record<TopologyNode["kind"], number> = {
  volume: 0,
  container: 340,
  network: 680,
  "nutanix-vm": 1020,
  "ad-server": 1360,
};
const ROW_HEIGHT = 130;
const NETWORK_DRIVERS = ["bridge", "overlay", "host", "none"];
const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  remove: "Supprimer",
};

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

interface NetworkConnectPopoverProps {
  containerId: string;
  /** Ids Docker bruts (pas "network:<id>") des networks déjà connectés à ce conteneur — retirés du
   * choix, qu'ils soient restés un vrai nœud (partagé/par défaut) ou devenus une brique. */
  excludeNetworkIds: Set<string>;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Popover "Connecter à un network…" (menu contextuel d'un nœud conteneur) — depuis l'introduction
 * des "briques" (voir services/topology.ts § "Briques"), un network attaché à un seul conteneur
 * n'est plus un nœud du graphe : le glisser-connecter historique (container -> network, toujours
 * fonctionnel pour les networks restés de vrais nœuds, partagés/par défaut) n'a alors plus de
 * cible à viser. Cette action, disponible pour TOUT network existant (brique ou nœud), couvre ce
 * cas sans exiger de point de connexion dédié sur chaque brique — POST /api/networks/:id/connect
 * comme le glisser-connecter, résultat strictement identique.
 */
function NetworkConnectPopover({ containerId, excludeNetworkIds, x, y, onClose }: NetworkConnectPopoverProps) {
  const dispatch = useAppDispatch();
  const ref = useDismiss(onClose);
  const networks = useAppSelector((s) => s.networks.items);
  const [networkId, setNetworkId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchNetworks());
  }, [dispatch]);

  const options = networks.filter((n) => !excludeNetworkIds.has(n.id));

  useEffect(() => {
    if (!networkId && options.length > 0) setNetworkId(options[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!networkId) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(connectContainerToNetwork({ networkId, containerId }));
    setBusy(false);
    if (connectContainerToNetwork.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de la connexion au network.");
    }
  }

  return (
    <div className="graph-popover" style={{ left: x, top: y }} ref={ref}>
      <div className="graph-popover__title">Connecter à un network</div>
      <form onSubmit={handleSubmit}>
        {options.length === 0 ? (
          <p className="graph-popover__error" style={{ color: "var(--color-text-faint)" }}>
            Aucun network disponible à connecter (déjà tous connectés, ou aucun n'existe encore).
          </p>
        ) : (
          <div className="field">
            <label htmlFor="graph-network-connect-select">Network</label>
            <select
              id="graph-network-connect-select"
              value={networkId}
              onChange={(e) => setNetworkId(e.target.value)}
              disabled={busy}
              required
            >
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.driver})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !networkId || options.length === 0}>
            {busy ? "…" : "Connecter"}
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
  // Menu contextuel d'une "brique" (volume/network monté par un seul conteneur, voir
  // TopologyNode#attachments et GraphNode dans topologyGraphShared.tsx) — clic droit sur une
  // brique plutôt que sur un nœud/une arête, distinct de `nodeMenu`/`edgeMenu` (une brique n'est
  // ni l'un ni l'autre : pas de nœud top-level, pas d'arête, voir services/topology.ts).
  const [attachmentMenu, setAttachmentMenu] = useState<{
    x: number;
    y: number;
    containerNodeId: string;
    attachment: TopologyNodeAttachment;
  } | null>(null);
  // Popover "Connecter à un network…" (menu contextuel d'un conteneur) — voir NetworkConnectPopover
  // ci-dessus : chemin de connexion qui fonctionne même quand le network visé est une brique (donc
  // sans nœud à glisser-déposer dessus).
  const [networkConnectPopover, setNetworkConnectPopover] = useState<{ containerId: string; x: number; y: number } | null>(
    null,
  );
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  // Panneau de détail complet, ancré en overlay sur le canevas (clic droit sur un nœud ou une
  // brique -> "Voir le détail") — voir TopologyNodeDetailPanel.tsx. Distincte de `selectedId`
  // (simple surbrillance visuelle du nœud, conservée) : ce n'est plus l'Inspector latéral (retiré
  // de la Vue d'ensemble) qui affiche quoi que ce soit ici, uniquement ce panneau ouvert à la
  // demande.
  const [detailNode, setDetailNode] = useState<TopologyNode | null>(null);
  // Sous-graphe de dépendances/composition interne (double-clic sur un nœud, ou "Visualiser les
  // dépendances" du menu contextuel) — voir TopologySubGraphPanel.tsx. Ne stocke que l'id racine :
  // le sous-graphe se recalcule depuis `data` (déjà en mémoire), jamais de nouvel appel réseau.
  // Remplace le graphe principal EN PLACE (pas une modal flottante) avec une transition "on rentre
  // dans le nœud" (scale+fade depuis sa position à l'écran) : `subGraphMounted` garde le panneau
  // monté pendant l'animation de sortie (`subGraphVisible -> false`), `handleSubGraphExited` fait
  // le démontage réel une fois cette animation terminée (voir onTransitionEnd du panneau).
  const [subGraphRootId, setSubGraphRootId] = useState<string | null>(null);
  const [subGraphMounted, setSubGraphMounted] = useState(false);
  const [subGraphVisible, setSubGraphVisible] = useState(false);
  const [subGraphOrigin, setSubGraphOrigin] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

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
    const columnCounters: Record<TopologyNode["kind"], number> = { volume: 0, container: 0, network: 0, "nutanix-vm": 0, "ad-server": 0 };
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return data.nodes.map((n) => {
        const row = columnCounters[n.kind]++;
        const defaultPosition = { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT };
        const prevNode = prevById.get(n.id);
        // Défense en profondeur contre un id de nœud recyclé DANS LA MÊME SESSION : un volume
        // (ou network) supprimé puis recréé sous EXACTEMENT le même nom reprend le même id
        // `volume:<nom>` (Docker n'expose aucun identifiant immuable pour un volume local
        // au-delà de son nom, contrairement à un conteneur/network dont l'id est un hash Docker
        // jamais réattribué — voir TopologyNode#createdAt). Si les deux nœuds portent un
        // horodatage de création et qu'ils diffèrent, ce n'est pas la même ressource : on ignore
        // la position héritée du nœud précédent plutôt que de la lui appliquer à tort. (La
        // position persistée côté serveur, `positions[n.id]`, ne porte pas cet horodatage et
        // reste donc un angle mort résiduel dans le cas plus rare d'une recréation à l'identique
        // entre deux sessions — voir services/topologyPositionsStore.ts.)
        const prevCreatedAt = (prevNode?.data as { createdAt?: string } | undefined)?.createdAt;
        const sameResource = !prevCreatedAt || !n.createdAt || prevCreatedAt === n.createdAt;
        const position = positions[n.id] ?? (sameResource ? prevNode?.position : undefined) ?? defaultPosition;
        // Briques (voir GraphNode, topologyGraphShared.tsx) : callbacks posés UNIQUEMENT sur les
        // nœuds conteneur (seul kind qui en rend), liés par fermeture à CE nœud précis — une
        // brique elle-même ne porte aucun id de nœud top-level, ces callbacks sont son seul moyen
        // d'ouvrir son détail / son menu contextuel.
        const callbacks: GraphNodeCallbacks =
          n.kind === "container"
            ? {
                onOpenAttachment: (attachment) => handleOpenAttachment(attachment),
                onAttachmentContextMenu: (event, attachment) => handleAttachmentContextMenu(event, n.id, attachment),
              }
            : {};
        return {
          id: n.id,
          type: "graphNode",
          position,
          data: { ...n, ...callbacks } as unknown as Record<string, unknown>,
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

  // Construction des arêtes déléguée à buildTopologyEdges (topologyGraphShared.tsx), partagée
  // avec le sous-graphe de dépendances ouvert au double-clic — même couleur/état/animation.
  const edges = useMemo<Edge[]>(() => (data ? buildTopologyEdges(data.edges, nodesById) : []), [data, nodesById]);

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

  /** "Voir le détail" ouvre TopologyNodeDetailPanel (contenu complet — env/ports/mounts/
   * vulnérabilités réelles selon le kind) ; `selectNode` reste appelé en plus pour la surbrillance
   * visuelle du nœud sur le graphe (déjà utilisée ailleurs via `selected`), les deux ne s'excluent
   * pas. Pour une brique (id synthétique, jamais un nœud top-level réel — voir
   * attachmentToTopologyNode), `selectNode` est un no-op visuel inoffensif : aucun flowNode ne
   * porte cet id, rien ne se met en surbrillance, mais rien ne casse non plus. */
  function openNodeDetail(node: TopologyNode) {
    selectNode(node.id);
    setDetailNode(node);
  }

  /** Clic sur une brique (volume/network monté par un seul conteneur, voir GraphNode) -> ouvre le
   * MÊME panneau de détail qu'un vrai nœud, avec un TopologyNode synthétique reconstruit depuis
   * l'attachment (le panneau va chercher lui-même le détail complet réel via GET /api/volumes ou
   * GET /api/networks, il n'a besoin que de id/kind pour ça). */
  function handleOpenAttachment(attachment: TopologyNodeAttachment) {
    openNodeDetail(attachmentToTopologyNode(attachment));
  }

  function handleAttachmentContextMenu(event: React.MouseEvent, containerNodeId: string, attachment: TopologyNodeAttachment) {
    setAttachmentMenu({ x: event.clientX, y: event.clientY, containerNodeId, attachment });
  }

  function attachmentMenuItems(containerNodeId: string, attachment: TopologyNodeAttachment): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => handleOpenAttachment(attachment) }];
    // Un volume ne peut pas être détaché sans recréer le conteneur (identique à .edgeMenu "mount"
    // ci-dessous) — seule la déconnexion d'un network briqué a un sens réel ici.
    if (operate && attachment.kind === "network") {
      items.push({
        label: "Déconnecter du network",
        danger: true,
        onClick: () => handleDisconnectAttachment(containerNodeId, attachment),
      });
    }
    return items;
  }

  async function handleDisconnectAttachment(containerNodeId: string, attachment: TopologyNodeAttachment) {
    const containerId = idWithoutPrefix(containerNodeId);
    const networkId = idWithoutPrefix(attachment.id);
    const ok = await confirm({
      title: "Déconnecter du network",
      description: `Le conteneur sera détaché du network "${attachment.label}".`,
      confirmLabel: "Déconnecter",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(disconnectContainerFromNetwork({ networkId, containerId }));
    if (disconnectContainerFromNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  /** Ids Docker bruts (pas "network:<id>") de TOUS les networks déjà connectés au conteneur
   * `containerNodeId` — partagés/par défaut (vrais nœuds, via les arêtes) ET briqués (via
   * node.attachments) — pour ne pas les reproposer dans NetworkConnectPopover. Ensemble vide si le
   * nœud n'existe plus (course avec un rafraîchissement entre l'ouverture du menu et son usage). */
  function connectedNetworkIds(containerNodeId: string): Set<string> {
    const ids = new Set<string>();
    const node = data?.nodes.find((n) => n.id === containerNodeId);
    if (!node) return ids;
    for (const a of node.attachments ?? []) if (a.kind === "network") ids.add(idWithoutPrefix(a.id));
    if (data) {
      for (const e of data.edges) {
        if (e.kind !== "network") continue;
        if (e.source === node.id) ids.add(idWithoutPrefix(e.target));
        else if (e.target === node.id) ids.add(idWithoutPrefix(e.source));
      }
    }
    return ids;
  }

  /** Ouvre le panneau de sous-graphe sur `nodeId`, avec une transition "on rentre dans le nœud" —
   * `clientX`/`clientY` (coordonnées écran du double-clic, ou du clic droit d'origine ayant ouvert
   * le menu contextuel) fixent le point de départ du scale+fade (voir TopologySubGraphPanel.tsx).
   * Sous `prefers-reduced-motion`, le panneau apparaît directement visible (pas d'étape
   * intermédiaire à transitionner). */
  function openSubGraph(nodeId: string, clientX: number, clientY: number) {
    const rect = graphContainerRef.current?.getBoundingClientRect();
    setSubGraphOrigin(
      rect && rect.width > 0 && rect.height > 0
        ? { x: ((clientX - rect.left) / rect.width) * 100, y: ((clientY - rect.top) / rect.height) * 100 }
        : { x: 50, y: 50 },
    );
    setSubGraphRootId(nodeId);
    setSubGraphMounted(true);
    if (reducedMotion) {
      setSubGraphVisible(true);
      return;
    }
    // Monté d'abord non visible (scale réduit + transparent), puis basculé à visible une frame
    // plus tard pour que le navigateur ait le temps d'appliquer l'état de départ avant de
    // transitionner vers l'état final — sans ce double rAF, les deux styles seraient posés dans
    // le même frame et la transition CSS ne jouerait pas (aucun changement d'état détecté).
    setSubGraphVisible(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setSubGraphVisible(true)));
  }

  /** L'utilisateur remonte vers le graphe complet — sous `prefers-reduced-motion`, démontage
   * immédiat (pas d'animation à attendre) ; sinon, `TopologySubGraphPanel` joue l'animation de
   * sortie et appelle `handleSubGraphExited` une fois terminée. */
  function closeSubGraph() {
    if (reducedMotion) {
      setSubGraphVisible(false);
      setSubGraphMounted(false);
      setSubGraphRootId(null);
      return;
    }
    setSubGraphVisible(false);
  }

  function handleSubGraphExited() {
    setSubGraphMounted(false);
    setSubGraphRootId(null);
  }

  function nodeMenuItems(node: TopologyNode, x: number, y: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: "Voir le détail", onClick: () => openNodeDetail(node) },
      // Toujours proposé, même pour un nœud isolé (ex : VM Nutanix, jamais reliée à Docker) — le
      // sous-graphe affiche alors simplement le nœud seul avec un message explicite plutôt que de
      // masquer l'entrée du menu selon le kind. Origine de la transition = position du clic droit
      // qui a ouvert CE menu (x, y), pas la position du clic sur l'entrée de menu elle-même.
      { label: "Visualiser les dépendances", onClick: () => openSubGraph(node.id, x, y) },
    ];
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
      // Depuis les "briques" (voir GraphNode/services/topology.ts), un network mono-conteneur
      // n'est plus un nœud du graphe à viser au glisser-déposer — cette action couvre ce cas (et
      // reste disponible aussi pour un network resté un vrai nœud, résultat identique).
      items.push({
        label: "Connecter à un network…",
        onClick: () => setNetworkConnectPopover({ containerId: id, x, y }),
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
    // Même traitement que .empty-state juste en dessous (largeur/hauteur pleines, centré) —
    // sans ça .error-banner (block, largeur au contenu) se retrouvait étiré sur toute la hauteur
    // du flex du parent .workspace mais étroit, une colonne rouge disgracieuse plutôt qu'un
    // message centré. Trouvé en testant réellement l'échec de GET /api/topology (capture d'écran
    // Playwright), pas une supposition.
    return (
      <div className="empty-state" style={{ height }}>
        <div className="error-banner">{error}</div>
      </div>
    );
  }
  if (data && data.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height }}>
        Aucune ressource à représenter pour l'instant.
      </div>
    );
  }

  return (
    <div className="topology-graph" style={{ height }} ref={graphContainerRef}>
      {/* Graphe principal — s'efface/se dézoome légèrement quand le panneau de sous-graphe est
          monté par-dessus (topology-graph__main--receded, voir topology.css), pour l'effet "on
          rentre dans le nœud" plutôt qu'un calque flottant classique. `pointer-events: none` dans
          cet état évite toute interaction fantôme avec le graphe caché derrière le panneau. */}
      <div className={`topology-graph__main${subGraphMounted ? " topology-graph__main--receded" : ""}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={(event, node) => openSubGraph(node.id, event.clientX, event.clientY)}
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
      </div>

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

      {attachmentMenu && (
        <ContextMenu
          x={attachmentMenu.x}
          y={attachmentMenu.y}
          onClose={() => setAttachmentMenu(null)}
          items={attachmentMenuItems(attachmentMenu.containerNodeId, attachmentMenu.attachment)}
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

      {networkConnectPopover && (
        <NetworkConnectPopover
          containerId={networkConnectPopover.containerId}
          excludeNetworkIds={connectedNetworkIds(`container:${networkConnectPopover.containerId}`)}
          x={networkConnectPopover.x}
          y={networkConnectPopover.y}
          onClose={() => setNetworkConnectPopover(null)}
        />
      )}

      {/* Sous-graphe de dépendances/composition interne (double-clic sur un nœud, ou "Visualiser
          les dépendances" du menu contextuel) — remplace le graphe principal EN PLACE (voir
          .topology-graph__main--receded ci-dessus), rendu APRÈS les popovers/menus mais AVANT la
          modal de détail ci-dessous dans le DOM, pour qu'une modal de détail ouverte depuis
          l'intérieur du panneau s'affiche bien par-dessus (même z-index, l'ordre de montage
          tranche). Resté monté pendant l'animation de sortie (`subGraphMounted`), démonté
          seulement une fois celle-ci terminée (`handleSubGraphExited`, voir openSubGraph/
          closeSubGraph ci-dessus). */}
      {subGraphMounted && data && (
        <TopologySubGraphPanel
          topology={data}
          rootId={subGraphRootId}
          visible={subGraphVisible}
          origin={subGraphOrigin}
          reducedMotion={reducedMotion}
          onRequestClose={closeSubGraph}
          onExited={handleSubGraphExited}
          onOpenDetail={openNodeDetail}
        />
      )}

      {/* Panneau de détail complet — ANCRÉ en overlay sur le bord droit du canevas (voir
          TopologyNodeDetailPanel.tsx, même pattern d'ancrage que .topology-subgraph-panel
          ci-dessus), rendu EN DERNIER dans le DOM pour rester au-dessus du sous-graphe quand il
          est ouvert depuis l'intérieur de celui-ci (onOpenDetail). Clic droit sur un nœud ou une
          brique -> "Voir le détail" (voir nodeMenuItems/attachmentMenuItems ci-dessus). */}
      <TopologyNodeDetailPanel
        node={detailNode}
        topology={data ?? null}
        onClose={() => setDetailNode(null)}
        onNavigate={openNodeDetail}
      />
    </div>
  );
}
