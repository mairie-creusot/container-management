import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, MiniMap, applyNodeChanges, type Edge, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { apiGet, apiPut } from "@/api/client";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { fetchContainerProcesses, runContainerAction, type LifecycleAction } from "@/features/containers/containersSlice";
import { removeVolume } from "@/features/volumes/volumesSlice";
import { removeNetwork } from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import { fetchImageHistory, fetchImages } from "@/features/images/imagesSlice";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { ContainerConsoleBody } from "@/components/ContainerConsole";
import { ContainerLogsBody } from "@/features/containers/ContainerLogs";
import VulnerabilitiesPanel from "@/components/VulnerabilitiesPanel";
import {
  ACTION_LABEL,
  MINIMAP_NODE_COLOR,
  attachmentToTopologyNode,
  buildTopologyEdges,
  deriveGroupPorts,
  edgeTypes,
  formatMem,
  idWithoutPrefix,
  interiorNodeTypes,
  layeredGroupPositions,
  nodeTypes,
  radialPositions,
  resolveGroupMemberNodeIds,
  type GraphNodeCallbacks,
  type GroupNodeData,
  type ProcessNodeData,
} from "@/components/topologyGraphShared";
import type { Topology, TopologyEdge, TopologyGroup, TopologyNode } from "@/types";

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
  /** Ouvre TopologyNodeDetailPanel pour un nœud (ou une brique, voir brickCallbacks ci-dessous) du
   * sous-graphe — déléguée au parent pour n'avoir qu'UNE seule instance du panneau de détail,
   * partagée entre le graphe principal et ce panneau. */
  onOpenDetail: (node: TopologyNode) => void;
}

/** Rayon (px) du cercle de voisins autour du nœud racine — sous-graphe de dépendances. */
const DEPENDENCY_RADIUS = 260;
/** Rayon (px) du cercle de processus autour du nœud conteneur — vue "composition interne", plus
 * serré : les nœuds "processus" sont volontairement plus petits que les nœuds de ressources. */
const PROCESS_RADIUS = 200;

type ViewMode = "shell" | "logs" | "dependencies" | "interior";

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
 * Jusqu'à quatre vues, choisies par bascule (`viewMode`) :
 * - "shell"/"logs" (conteneurs UNIQUEMENT, vue par défaut à l'ouverture sur un conteneur — retour
 *   utilisateur du 13/08/2026 : le shell/les logs sont la destination la plus utile pour un
 *   conteneur, pas une simple carte de dépendances) : mêmes composants RÉELS que les modales
 *   ContainerConsole.tsx/ContainerLogs.tsx (GET (WS) /api/console/:id,
 *   /api/containers/:id/logs(/stream)), affichés ici inline (ContainerConsoleBody/
 *   ContainerLogsBody) plutôt que dans une fenêtre superposée.
 * - "dependencies" (par défaut pour tout kind AUTRE que "container", et pour un GROUPE) :
 *   UNIQUEMENT ce nœud + tous les nœuds reliés à lui par au moins une arête du graphe complet déjà
 *   chargé côté client — inchangé par rapport à l'ancienne TopologySubGraphModal.tsx, disposition
 *   radiale, drill-down récursif au double-clic avec fil d'Ariane + bouton "Retour". Groupes
 *   imbriqués (13/08/2026, voir apps/api/src/types.ts#TopologyGroup) : quand la racine est un
 *   GROUPE (double-clic sur une carte de groupe repliée), cette vue affiche ses MEMBRES DIRECTS
 *   (résolus depuis `topology.groups`, jamais depuis les arêtes — un groupe n'est jamais source/
 *   target d'une vraie TopologyEdge) au lieu du calcul `neighborIds` habituel ; un membre lui-même
 *   groupe s'affiche comme sa propre carte repliée (GroupNode), drillable à son tour. Le fil
 *   d'Ariane affiche alors en plus un indicateur "Layer N" (N = profondeur d'imbrication de
 *   groupes traversée, limite RÉELLE de 5 niveaux/256 nœuds appliquée côté serveur, voir
 *   topologyGroupsStore.ts).
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
  const confirm = useConfirm();
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);
  // Menu contextuel d'une carte de groupe (groupes imbriqués, 13/08/2026) — distinct de `nodeMenu`
  // ci-dessus (un groupe n'est pas un TopologyNode réel), même principe que TopologyGraph.tsx#groupMenu.
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: TopologyGroup } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("dependencies");
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  /**
   * Disposition des membres DIRECTS d'un groupe déplacés à la main dans SA vue "composition
   * interne" (retour utilisateur du 13/08/2026 : "laisse à l'utilisateur le choix de le replacer
   * et de mémoriser leur emplacement") — GET/PUT /api/topology/groups/:id/positions, par
   * utilisateur ET par groupe (voir services/topologyGroupInteriorPositionsStore.ts) : jamais le
   * même stockage que `positions` du graphe principal (TopologyGraph.tsx), un même conteneur y a
   * une position complètement différente selon le contexte. Prioritaire sur la disposition
   * calculée (layeredGroupPositions) quand elle existe pour ce membre précis.
   */
  const [groupInteriorPositions, setGroupInteriorPositions] = useState<Record<string, { x: number; y: number }>>({});

  const processes = useAppSelector((s) => s.containers.processes);
  const processesStatus = useAppSelector((s) => s.containers.processesStatus);
  const processesError = useAppSelector((s) => s.containers.processesError);
  const processesContainerId = useAppSelector((s) => s.containers.processesContainerId);
  const images = useAppSelector((s) => s.images.items);
  const historyByImageId = useAppSelector((s) => s.images.historyByImageId);
  const historyStatus = useAppSelector((s) => s.images.historyStatus);
  const historyError = useAppSelector((s) => s.images.historyError);

  // Nouvelle ouverture (nouveau nœud racine imposé par le parent) -> repart d'un historique de
  // navigation vide.
  useEffect(() => {
    if (rootId) {
      setCurrentRootId(rootId);
      setStack([]);
    }
  }, [rootId]);

  const nodesById = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);
  // Groupes imbriqués (13/08/2026, voir apps/api/src/types.ts#TopologyGroup) : la racine du
  // sous-graphe peut désormais être un GROUPE (double-clic sur une carte de groupe repliée, voir
  // TopologyGraph.tsx#openSubGraph — déjà appelé avec l'id RÉEL du groupe, aucun changement
  // nécessaire là-bas). `currentGroup` distingue ce cas de celui d'un vrai TopologyNode ci-dessus.
  const groupsById = useMemo(() => new Map(topology.groups.map((g) => [g.id, g])), [topology]);
  const currentGroup = currentRootId ? groupsById.get(currentRootId) ?? null : null;
  /** Libellé d'un id quelconque du sous-graphe (vrai nœud OU groupe) — jamais l'id brut affiché à
   * l'utilisateur (fil d'Ariane) si un libellé réel existe. */
  const labelForId = (id: string): string => nodesById.get(id)?.label ?? groupsById.get(id)?.label ?? id;

  // Recharge la disposition mémorisée dès qu'on entre dans un groupe différent (ou qu'on en sort) —
  // {} tant que rien n'a encore été déplacé à la main dans CE groupe précis (voir
  // groupInteriorPositions ci-dessus).
  useEffect(() => {
    if (!currentGroup) {
      setGroupInteriorPositions({});
      return;
    }
    let cancelled = false;
    apiGet<Record<string, { x: number; y: number }>>(`/topology/groups/${encodeURIComponent(currentGroup.id)}/positions`)
      .then((positions) => {
        if (!cancelled) setGroupInteriorPositions(positions);
      })
      .catch(() => {
        // Échec silencieux : la disposition calculée (layeredGroupPositions) reste un repli honnête,
        // même pattern que le reste de ce panneau (aucune persistance n'est bloquante ici).
      });
    return () => {
      cancelled = true;
    };
  }, [currentGroup?.id]);

  // Nouvelle racine (ouverture initiale OU drill-down récursif, voir drillInto plus bas) -> repart
  // sur la vue par défaut adaptée à SON kind : "shell" pour un conteneur (retour utilisateur du
  // 13/08/2026 : c'est la destination la plus utile, jamais une simple carte de dépendances pour
  // ce kind précis), "dependencies" pour tout le reste (aucun shell/logs/composition interne n'a
  // de sens pour un volume/network/host/nœud d'automatisation/etc., ni pour un groupe).
  //
  // Bug réel corrigé le 13/08/2026 (retour utilisateur : l'onglet Logs/Dépendances/Composition
  // interne "se remet sur Shell" tout seul après quelques secondes, tuant au passage la connexion
  // Logs avant même qu'elle ait fini de s'établir) : `nodesById` était en dépendance — recréé à
  // CHAQUE rafraîchissement de la topologie (poll périodique de TopologyGraph.tsx, ~15s), donc
  // d'IDENTITÉ toujours nouvelle même quand son CONTENU est inchangé. Cet effet se redéclenchait
  // alors en boucle, réinitialisant `viewMode` sur la valeur par défaut à chaque poll — écrasant
  // tout choix manuel de l'utilisateur (Logs, Dépendances, Composition interne) quelques secondes
  // après l'avoir fait. Seul un changement RÉEL de racine (nouvelle navigation) doit rejouer ce
  // calcul — `nodesById` reste lu à l'intérieur (closure), jamais dans les dépendances.
  useEffect(() => {
    setViewMode(currentRootId && nodesById.get(currentRootId)?.kind === "container" ? "shell" : "dependencies");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRootId]);
  const rootNode = currentRootId ? nodesById.get(currentRootId) ?? null : null;
  const rawRootId = currentRootId ? idWithoutPrefix(currentRootId) : "";

  const neighborIds = useMemo(() => {
    if (!currentRootId) return [];
    // Racine = un groupe (13/08/2026) : ses "voisins" sont ses MEMBRES DIRECTS, résolus depuis
    // `topology.groups` — un groupe n'est JAMAIS source/target d'une vraie TopologyEdge (voir
    // services/topology.ts), le calcul habituel par arêtes ne renverrait donc toujours rien pour
    // lui. Un membre qui est lui-même un groupe reste tel quel dans la liste (rendu comme sa propre
    // carte repliée, voir flowNodes ci-dessous), jamais déplié ici.
    if (currentGroup) return [...currentGroup.nodeIds];
    const ids = new Set<string>();
    for (const edge of topology.edges) {
      if (edge.source === currentRootId) ids.add(edge.target);
      else if (edge.target === currentRootId) ids.add(edge.source);
    }
    return Array.from(ids);
  }, [topology, currentRootId, currentGroup]);

  const subEdges = useMemo(
    () => topology.edges.filter((e) => e.source === currentRootId || e.target === currentRootId),
    [topology, currentRootId],
  );

  /** "Propriétaire" direct (au sens de cette vue) de chaque vrai TopologyNode réel — un membre
   * direct du groupe qui est lui-même un sous-groupe possède, transitivement, tous les vrais nœuds
   * qu'il contient (resolveGroupMemberNodeIds) ; un membre direct qui est un vrai nœud se possède
   * lui-même. Sert à redescendre une arête réelle vers la carte VISIBLE à ce niveau (le vrai nœud
   * lui-même, ou la carte repliée du sous-groupe qui le contient) — même principe que
   * resolveVisibleGroupTarget (TopologyGraph.tsx), mais restreint à UN seul niveau (les membres
   * directs de `currentGroup`, jamais toute la hiérarchie globale du graphe).
   */
  const memberOwnerByRealNodeId = useMemo(() => {
    const map = new Map<string, string>();
    if (!currentGroup) return map;
    for (const memberId of currentGroup.nodeIds) {
      const subGroup = groupsById.get(memberId);
      const realIds = subGroup ? resolveGroupMemberNodeIds(subGroup.nodeIds, topology.groups) : [memberId];
      for (const realId of realIds) map.set(realId, memberId);
    }
    return map;
  }, [currentGroup, groupsById, topology.groups]);

  /**
   * Arêtes RÉELLES entre les membres directs d'un groupe (retour utilisateur du 13/08/2026 : "une
   * fois groupé il ne son plus relié") — bug réel corrigé : cette vue n'affichait jusqu'ici QUE des
   * traits neutres groupe -> chaque membre (voir `groupMemberEdges` plus bas, conservé en repli
   * pour un groupe sans aucune arête interne), jamais les arêtes RÉELLES qui existaient entre les
   * membres eux-mêmes (ex : conteneur -> network) — l'information de connectivité qui a justement
   * amené l'utilisateur à les grouper ensemble disparaissait entièrement une fois à l'intérieur.
   * `sOwner === tOwner` exclue une arête entièrement interne à un même sous-groupe MEMBRE (déjà
   * masquée par sa propre carte repliée, voir deriveGroupPorts) ; une arête touchant un nœud hors de
   * TOUT membre direct (donc hors du groupe entier) est elle aussi exclue (`!sOwner || !tOwner`) —
   * cette vue ne montre que la composition interne de CE groupe, jamais ses connexions externes
   * (déjà visibles, une fois replié, via ses propres ports — voir deriveGroupPorts).
   */
  const groupInternalEdges = useMemo<(TopologyEdge & { sourceHandle?: string; targetHandle?: string })[]>(() => {
    if (!currentGroup) return [];
    const result: (TopologyEdge & { sourceHandle?: string; targetHandle?: string })[] = [];
    for (const e of topology.edges) {
      const sOwner = memberOwnerByRealNodeId.get(e.source);
      const tOwner = memberOwnerByRealNodeId.get(e.target);
      if (!sOwner || !tOwner || sOwner === tOwner) continue;
      const sourceRedirected = sOwner !== e.source;
      const targetRedirected = tOwner !== e.target;
      if (!sourceRedirected && !targetRedirected) {
        result.push(e);
        continue;
      }
      // Même règle de correspondance capacité <-> Handle qu'à la racine du graphe principal (voir
      // TopologyGraph.tsx#groupedTopologyEdges/deriveGroupPorts) — nécessaire seulement quand une
      // extrémité est redirigée vers la carte repliée d'un sous-groupe (qui peut porter plusieurs
      // Handles du même côté).
      result.push({
        ...e,
        id: `${e.id}__group-interior`,
        source: sOwner,
        target: tOwner,
        ...(sourceRedirected ? { sourceHandle: e.kind === "mount" ? "provide" : "network" } : {}),
        ...(targetRedirected
          ? { targetHandle: e.kind === "mount" ? "volume-mount" : e.kind === "hosts" ? "hosted-by" : "attach" }
          : {}),
      });
    }
    return result;
  }, [currentGroup, memberOwnerByRealNodeId, topology.edges]);

  // Reconstruit la disposition à chaque recentrage — pas de persistance (contrairement au graphe
  // principal) : une exploration ponctuelle, pas un canevas durable. Racine = un vrai nœud : cercle
  // radial autour de lui (radialPositions, inchangé). Racine = un GROUPE (13/08/2026, retour
  // utilisateur "tas de merde" sur le cercle radial précédent) : AUCUN nœud central réel (un groupe
  // n'a aucune arête vers ses membres, voir plus haut) — layeredGroupPositions dispose plutôt les
  // membres en couches selon leurs arêtes RÉELLES entre eux (groupInternalEdges ci-dessus), le
  // groupe lui-même n'apparaît alors plus comme un nœud flottant dans cette vue (déjà représenté
  // par l'en-tête/le fil d'Ariane de ce panneau).
  useEffect(() => {
    if (!currentRootId || !(nodesById.has(currentRootId) || groupsById.has(currentRootId))) {
      setFlowNodes([]);
      return;
    }
    // `groupInteriorPositions` (mémorisée, voir sa définition plus haut) est prioritaire membre par
    // membre sur la disposition calculée — un membre jamais déplacé à la main retombe sur
    // layeredGroupPositions, jamais une position vide/inventée.
    const computedPositions = currentGroup
      ? layeredGroupPositions(neighborIds, groupInternalEdges)
      : radialPositions(currentRootId, neighborIds, DEPENDENCY_RADIUS);
    const positions = currentGroup ? { ...computedPositions, ...groupInteriorPositions } : computedPositions;
    const ids = currentGroup ? neighborIds : [currentRootId, ...neighborIds];
    setFlowNodes(
      ids
        .map((id): Node | null => {
          // Un membre qui est lui-même un groupe (groupes imbriqués, 13/08/2026) s'affiche comme
          // sa PROPRE carte repliée — même composant GroupNode que le graphe principal, ports
          // dérivés récursivement (deriveGroupPorts) — reste drillable par un nouveau double-clic
          // (drillInto ci-dessous, déjà récursif, réutilisé tel quel).
          const subGroup = groupsById.get(id);
          if (subGroup) {
            const groupData: GroupNodeData = {
              group: subGroup,
              ports: deriveGroupPorts(subGroup, topology.edges, topology.groups),
              realNodeCount: resolveGroupMemberNodeIds(subGroup.nodeIds, topology.groups).length,
            };
            return {
              id: subGroup.id,
              type: "topologyGroupNode",
              position: positions[id] ?? { x: 0, y: 0 },
              data: groupData as unknown as Record<string, unknown>,
            };
          }
          const n = nodesById.get(id);
          if (!n) return null;
          return {
            id: n.id,
            type: "graphNode",
            position: positions[n.id] ?? { x: 0, y: 0 },
            // Briques (voir GraphNode/TopologyNode#attachments) : mêmes callbacks que le graphe
            // principal (TopologyGraph.tsx) pour rester cliquables/clic-droit-ables ICI aussi — pas
            // de "Connecter à un network…"/déconnexion depuis ce panneau en revanche (ce sous-graphe
            // n'a jamais eu d'action de (dé)connexion réseau propre, même pour une arête réelle :
            // scope volontairement inchangé, seule "Voir le détail" est couverte).
            data: {
              ...n,
              ...(brickCallbacks(n.kind)),
            } as unknown as Record<string, unknown>,
          };
        })
        .filter((n): n is Node => !!n),
    );
  }, [currentRootId, currentGroup, neighborIds, groupInternalEdges, nodesById, groupsById, topology]);

  // Racine = un GROUPE (13/08/2026, retour utilisateur — voir groupInternalEdges ci-dessus) : les
  // VRAIES arêtes entre membres, plutôt que les traits neutres groupe -> membre d'avant (qui de
  // toute façon pointeraient maintenant vers un nœud absent de ce panneau, le groupe n'y étant plus
  // représenté — voir l'effet ci-dessus). Un groupe sans aucune arête interne (membres réellement
  // sans rapport entre eux) n'affiche alors honnêtement aucune arête, jamais un trait inventé.
  const flowEdges = useMemo(
    () => (currentGroup ? buildTopologyEdges(groupInternalEdges, nodesById) : buildTopologyEdges(subEdges, nodesById)),
    [currentGroup, groupInternalEdges, subEdges, nodesById],
  );

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
      data: { ...rootNode, ...brickCallbacks(rootNode.kind) } as unknown as Record<string, unknown>,
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

  /** Mémorise la position d'UN membre glissé à la main dans la vue "composition interne" d'un
   * groupe (retour utilisateur du 13/08/2026) — PUT /api/topology/groups/:id/positions, fusion
   * plutôt que remplacement complet pour ne jamais perdre le placement déjà mémorisé d'un AUTRE
   * membre non touché par ce geste précis. No-op hors du contexte "racine = groupe" (la vue
   * dépendances classique reste, comme avant, une exploration ponctuelle sans persistance) et pour
   * un viewer (operate false, aucune route mutante ne doit être appelée pour ce rôle). */
  function handleNodeDragStop(_event: unknown, node: Node) {
    if (!currentGroup || !operate) return;
    const next = { ...groupInteriorPositions, [node.id]: { x: node.position.x, y: node.position.y } };
    setGroupInteriorPositions(next);
    void apiPut(`/topology/groups/${encodeURIComponent(currentGroup.id)}/positions`, { positions: next });
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
    // Une carte de groupe (groupes imbriqués, 13/08/2026, voir GroupNodeData) n'est PAS un vrai
    // TopologyNode (ni `kind`, ni `label` au même endroit que sur `node.data` d'un vrai nœud) — menu
    // contextuel dédié, même garde de type que TopologyGraph.tsx#handleNodeContextMenu.
    if (node.type === "topologyGroupNode") {
      const group = (node.data as unknown as { group: TopologyGroup }).group;
      setGroupMenu({ x: event.clientX, y: event.clientY, group });
      return;
    }
    setNodeMenu({ x: event.clientX, y: event.clientY, node: node.data as unknown as TopologyNode });
  }

  /** Callbacks de brique (voir GraphNode/TopologyNode#attachments) pour un nœud de kind `kind` —
   * seuls les nœuds "container" en rendent, `{}` pour les autres (GraphNode gère déjà l'absence de
   * callback sans erreur, `?.()`). Réutilise le MÊME `nodeMenu` que pour un vrai nœud pour le clic
   * droit (voir nodeMenuItems ci-dessous, gardé contre le drilldown sur un id synthétique). */
  function brickCallbacks(kind: TopologyNode["kind"]): GraphNodeCallbacks {
    if (kind !== "container") return {};
    return {
      onOpenAttachment: (attachment) => onOpenDetail(attachmentToTopologyNode(attachment)),
      onAttachmentContextMenu: (event, attachment) =>
        setNodeMenu({ x: event.clientX, y: event.clientY, node: attachmentToTopologyNode(attachment) }),
    };
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

  const breadcrumbLabels = [...stack, ...(currentRootId ? [currentRootId] : [])].map((id) => labelForId(id));
  // "Layer N" (groupes imbriqués, 13/08/2026) : N = position dans `stack` + 1, le tout premier
  // niveau ouvert = Layer 1 — affiché SEULEMENT quand la racine actuelle ou une racine de la pile
  // est un groupe (concept spécifique à l'imbrication de groupes, pas à la navigation générale déjà
  // existante — jamais affiché pour un simple nœud conteneur/volume/etc.).
  const isGroupNavigation = [...stack, ...(currentRootId ? [currentRootId] : [])].some((id) => groupsById.has(id));

  /** Actions réelles conteneur/volume/network — retour utilisateur du 13/08/2026 : "le clic droit
   * n'est pas sur le node il manque supprimer ou autre element aussi", le menu contextuel de ce
   * panneau se limitait à "Voir le détail"/"Visualiser ses dépendances", contrairement à celui du
   * graphe principal (TopologyGraph.tsx#handleContainerAction/handleRemoveVolume/
   * handleRemoveNetwork, mêmes thunks/confirmations réutilisés ici à l'identique — aucune logique
   * dupliquée avec un comportement différent). `dispatch(fetchTopology())` après succès : ce
   * panneau reçoit `topology` en PROP depuis TopologyGraph.tsx (pas de fetch propre), il faut donc
   * explicitement redéclencher le rafraîchissement partagé pour voir l'effet ici aussi. */
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
    const result = await dispatch(removeVolume({ name }));
    if (removeVolume.fulfilled.match(result)) dispatch(fetchTopology());
    else dispatch(pushNotification({ level: "error", message: result.payload ?? "Échec de la suppression du volume." }));
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
    else dispatch(pushNotification({ level: "error", message: result.payload ?? "Échec de la suppression du network." }));
  }

  function nodeMenuItems(node: TopologyNode): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => onOpenDetail(node) }];
    // `nodesById.has(node.id)` exclut le drilldown sur une brique (TopologyNode synthétique
    // reconstruit par attachmentToTopologyNode, voir brickCallbacks ci-dessus) : son id ne
    // correspond à AUCUN nœud top-level de `topology.nodes` (tout l'objet du "briquage"), le
    // sous-graphe n'aurait rien de réel à recentrer dessus.
    if (node.id !== currentRootId && nodesById.has(node.id)) {
      items.push({ label: "Visualiser ses dépendances", onClick: () => drillInto(node.id) });
    }
    if (!operate) return items;
    // Une brique (id absent de `nodesById`, voir ci-dessus) n'est qu'une vue de lecture d'un
    // attachement — aucune action de cycle de vie propre ici (déjà proposées, le cas échéant,
    // depuis le vrai nœud conteneur qui la porte).
    if (!nodesById.has(node.id)) return items;
    if (node.kind === "container") {
      const id = idWithoutPrefix(node.id);
      if (node.status === "running") {
        items.push({ label: "Arrêter", onClick: () => void handleContainerAction(id, node.label, "stop") });
      } else {
        items.push({ label: "Démarrer", onClick: () => void handleContainerAction(id, node.label, "start") });
      }
      items.push({ label: "Redémarrer", onClick: () => void handleContainerAction(id, node.label, "restart") });
      items.push({ label: "Supprimer", danger: true, onClick: () => void handleContainerAction(id, node.label, "remove") });
    } else if (node.kind === "volume") {
      items.push({ label: "Supprimer", danger: true, onClick: () => void handleRemoveVolume(idWithoutPrefix(node.id)) });
    } else if (node.kind === "network") {
      const id = idWithoutPrefix(node.id);
      if (!["bridge", "host", "none"].includes(node.label)) {
        items.push({ label: "Supprimer", danger: true, onClick: () => void handleRemoveNetwork(id, node.label) });
      }
    }
    return items;
  }

  /** Menu contextuel d'une carte de groupe (groupes imbriqués, 13/08/2026) — un groupe se drille
   * comme n'importe quel autre membre (double-clic déjà supporté, voir onNodeDoubleClick plus bas),
   * cette entrée offre le même geste depuis le clic droit. */
  function groupMenuItems(group: TopologyGroup): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (group.id !== currentRootId) items.push({ label: "Explorer le groupe", onClick: () => drillInto(group.id) });
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
      aria-label={`Sous-graphe de « ${rootNode?.label ?? currentGroup?.label ?? ""} »`}
    >
      <div className="topology-subgraph-panel__header">
        <div className="topology-subgraph-panel__breadcrumb">
          {breadcrumbLabels.map((label, index) => (
            <span key={index} className="topology-subgraph-panel__crumb">
              {index > 0 && <span className="topology-subgraph-panel__crumb-sep">→</span>}
              {label}
            </span>
          ))}
          {isGroupNavigation && (
            <span
              className="topology-subgraph-panel__layer"
              title="Profondeur d'imbrication de groupes (voir apps/api/src/services/topologyGroupsStore.ts, max 5 niveaux)"
            >
              Layer {stack.length + 1}
            </span>
          )}
        </div>
        <div className="topology-subgraph-panel__actions">
          {isContainerRoot && (
            <div className="topology-subgraph-panel__mode-toggle" role="tablist" aria-label="Vue du sous-graphe">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "shell"}
                className={`topology-subgraph-panel__mode-btn${viewMode === "shell" ? " is-active" : ""}`}
                onClick={() => setViewMode("shell")}
              >
                Shell
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "logs"}
                className={`topology-subgraph-panel__mode-btn${viewMode === "logs" ? " is-active" : ""}`}
                onClick={() => setViewMode("logs")}
              >
                Logs
              </button>
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

      {viewMode === "shell" && rootNode && rootNode.status === "running" && (
        <div className="topology-subgraph-panel__shell">
          <ContainerConsoleBody containerId={rawRootId} containerName={rootNode.label} />
        </div>
      )}
      {viewMode === "shell" && rootNode && rootNode.status !== "running" && (
        <div className="empty-state topology-interior__status-message">
          Ce conteneur est arrêté — un shell interactif nécessite un conteneur en cours d'exécution. Voir l'onglet
          "Logs" pour comprendre pourquoi il s'est arrêté.
        </div>
      )}

      {viewMode === "logs" && rootNode && (
        <div className="topology-subgraph-panel__shell">
          <ContainerLogsBody containerId={rawRootId} containerName={rootNode.label} />
        </div>
      )}

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
              onNodeDragStop={handleNodeDragStop}
              onNodeDoubleClick={(_event, node) => drillInto(node.id)}
              onNodeContextMenu={handleNodeContextMenu}
              nodesConnectable={false}
              deleteKeyCode={null}
              fitView
              proOptions={{ hideAttribution: true }}
              minZoom={0.3}
            >
              <Background gap={20} size={1.6} color="var(--color-text-faint)" />
              {/* Manquait (retour utilisateur du 13/08/2026) — même composant/couleurs que le
                  graphe principal (TopologyGraph.tsx), pas de bouton "grille" ici en revanche
                  (toujours affichée : ce sous-graphe reste une exploration ponctuelle et
                  généralement bien plus petite que le graphe principal). */}
              <MiniMap
                position="top-left"
                nodeColor={(n) =>
                  n.type === "topologyGroupNode" ? "#e879f9" : MINIMAP_NODE_COLOR[(n.data as unknown as TopologyNode).kind]
                }
                nodeStrokeWidth={0}
                nodeBorderRadius={4}
                maskColor="rgba(11, 12, 16, 0.75)"
                pannable
                zoomable
              />
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

            <div className="topology-interior__sidebar">
              {/* Retour utilisateur du 13/08/2026 : "il faut grâce à grype/syft/osv... voir quel
                  paquet est critique et pourquoi" — même composant que l'onglet "Vulnérabilités" du
                  panneau de détail (voir VulnerabilitiesPanel.tsx), pas une seconde implémentation. */}
              <div className="topology-interior__vulns">
                <VulnerabilitiesPanel imageRef={imageRef} operate={operate} />
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
        </div>
      )}

      {nodeMenu && (
        <ContextMenu x={nodeMenu.x} y={nodeMenu.y} onClose={() => setNodeMenu(null)} items={nodeMenuItems(nodeMenu.node)} />
      )}

      {groupMenu && (
        <ContextMenu x={groupMenu.x} y={groupMenu.y} onClose={() => setGroupMenu(null)} items={groupMenuItems(groupMenu.group)} />
      )}
    </div>
  );
}
