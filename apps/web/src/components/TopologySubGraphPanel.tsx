import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlow, Background, MiniMap, SelectionMode, applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { apiGet, apiPut, ApiError } from "@/api/client";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import {
  fetchContainerProcessesDetailed,
  killContainerProcess,
  restartContainerProcess,
  runContainerAction,
  type LifecycleAction,
} from "@/features/containers/containersSlice";
import { removeVolume } from "@/features/volumes/volumesSlice";
import { removeNetwork } from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { createTopologyGroup, fetchTopology } from "@/features/topology/topologySlice";
import { fetchImageHistory, fetchImages } from "@/features/images/imagesSlice";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { ContainerConsoleBody } from "@/components/ContainerConsole";
import { ContainerLogsBody } from "@/features/containers/ContainerLogs";
import VulnerabilitiesPanel from "@/components/VulnerabilitiesPanel";
import { formatCpuTime, formatProcessAge, hexdumpRows } from "@/utils/containerInternalsFormat";
// Actions de menu par kind déclarées dans le registre (voir topologyNodeContract.tsx#NODE_CONTRACT
// et nodeMenuItems ci-dessous) — ce panneau n'injecte qu'un sous-ensemble volontaire de callbacks.
import { buildNodeMenuItems } from "@/components/topologyNodeContract";
import {
  ACTION_LABEL,
  GroupLabelPopover,
  attachmentToTopologyNode,
  buildTopologyEdges,
  deriveGroupPorts,
  edgeTypes,
  formatMem,
  idWithoutPrefix,
  layeredGroupPositions,
  nodeMinimapColor,
  nodeTypes,
  radialPositions,
  resolveGroupMemberNodeIds,
  type GraphNodeCallbacks,
  type GroupNodeData,
} from "@/components/topologyGraphShared";
import type {
  ContainerProcessDetail,
  ContainerProcessInspection,
  FileHexdump,
  PackageFilesResult,
  Topology,
  TopologyEdge,
  TopologyGroup,
  TopologyNode,
} from "@/types";

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

/** Intervalle (ms) de rafraîchissement de la liste de processus détaillée dans la vue
 * "Composition interne" — assez court pour donner un vrai sentiment de "temps réel" (retour
 * utilisateur du 13/08/2026 : "voir le temp entre chaque processu... une vue façon Matrix") sans
 * saturer le conteneur cible d'exec Docker : démarré/arrêté avec `viewMode`, jamais en continu
 * quand un autre onglet (Shell/Logs) est affiché — voir l'effet de polling plus bas. */
const PROCESS_POLL_INTERVAL_MS = 2500;

/** Fenêtre (octets) demandée par défaut à chaque appel de GET .../files/hexdump — voir
 * openHexdump/hexdumpOffset plus bas pour la pagination (précédent/suivant) au-delà de cette
 * fenêtre. Volontairement petite : un hexdump reste une inspection ponctuelle d'un fichier
 * suspect, jamais un téléchargement de fichier entier. */
const HEXDUMP_WINDOW_BYTES = 512;

type ViewMode = "shell" | "logs" | "dependencies" | "interior";

/**
 * Panneau repliable générique de la vue "Composition interne" (fusion du 13/08/2026) — état
 * ouvert/fermé NON contrôlé (propre à chaque panneau, pas de lifting inutile vers le composant
 * parent). Retour utilisateur du 13/08/2026 : "chaque panneau reste indépendant et peut se
 * replier" — sur un conteneur peu bruyant (pas de vulnérabilité, pas de port en écoute), le
 * panneau correspondant se réduit à une ligne plutôt que d'occuper de l'espace pour rien, jamais
 * un panneau vide muet : le titre (et son compte, voir `subtitle`) reste visible replié, un état
 * honnête même à zéro plutôt qu'une absence totale d'indication.
 */
function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="topology-interior__panel">
      <button
        type="button"
        className="topology-interior__panel-title"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`topology-interior__panel-chevron${open ? " is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="topology-interior__panel-title-text">{title}</span>
        {subtitle !== undefined && <span className="topology-interior__panel-subtitle">{subtitle}</span>}
      </button>
      {open && <div className="topology-interior__panel-body">{children}</div>}
    </div>
  );
}

/**
 * Panneau de sous-graphe — remplace le graphe principal EN PLACE (même zone, voir
 * TopologyGraph.tsx qui gère le montage/démontage et la transition scale+fade "zoom dans le
 * nœud") au double-clic sur un nœud (ou "Visualiser les dépendances" du menu contextuel).
 *
 * Vues internes (`viewMode`), choisies par bascule — pour un conteneur, TROIS onglets exposés
 * (Shell, Logs, Composition interne) ; pour tout AUTRE kind (volume/network/host/groupe/etc.) OU
 * un GROUPE, aucune bascule n'est affichée du tout, "dependencies" reste le seul contenu (rien ne
 * change ici, hors de la portée de la fusion du 13/08/2026 ci-dessous) :
 * - "shell"/"logs" (conteneurs UNIQUEMENT, vue par défaut à l'ouverture sur un conteneur — retour
 *   utilisateur du 13/08/2026 : le shell/les logs sont la destination la plus utile pour un
 *   conteneur, pas une simple carte de dépendances) : mêmes composants RÉELS que les modales
 *   ContainerConsole.tsx/ContainerLogs.tsx (GET (WS) /api/console/:id,
 *   /api/containers/:id/logs(/stream)), affichés ici inline (ContainerConsoleBody/
 *   ContainerLogsBody) plutôt que dans une fenêtre superposée.
 * - "dependencies" (PAS un onglet exposé pour un conteneur — voir "interior" ci-dessous ; reste
 *   le seul contenu, sans bascule, pour tout kind AUTRE que "container" et pour un GROUPE) :
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
 * - "interior" (conteneurs uniquement) — "Composition interne" : FUSION du 13/08/2026 (retour
 *   utilisateur : "il faut me faire une proposition pour regroupe dependance et composition
 *   interne", proposition validée en artifact "Radiographie du conteneur") de l'ancien onglet
 *   "Dépendances" (le réseau EXTERNE — mêmes `flowNodes`/`flowEdges`/`neighborIds` que la vue
 *   "dependencies" ci-dessus, calculés une seule fois plus haut et réutilisés ici tels quels dans
 *   un panneau repliable, voir renderExternalDependenciesGraph) DANS "Composition interne", qui
 *   n'est donc plus un onglet séparé pour un conteneur. Panneaux, tous en données RÉELLES,
 *   jamais une reconstruction devinée de l'architecture applicative interne (impossible à
 *   connaître sans tracing applicatif, hors périmètre) :
 *     - Processus réels DEPUIS L'INTÉRIEUR du conteneur (GET .../processes/detailed, PID dans SA
 *       PROPRE numérotation — remplace le panneau `docker top` d'origine, PID HÔTE, dans CETTE
 *       vue précise uniquement), avec actions inspecter/tuer/relancer et polling court tant que
 *       cette vue est affichée (voir PROCESS_POLL_INTERVAL_MS).
 *     - Réseau interne, dérivé des `listenPorts` de chaque process ci-dessus (aucune route réseau
 *       séparée n'existe côté API).
 *     - Réseau externe (ex-onglet "Dépendances", voir plus haut).
 *     - Vulnérabilités réelles (Grype/OSV-Scanner, VulnerabilitiesPanel), avec lien vers les
 *       fichiers réels d'un paquet (GET /api/images/:id/packages/:packageName/files) puis, pour
 *       un fichier listé, un hexdump réel à la demande (GET .../files/hexdump, ADMIN uniquement).
 *     - Historique des couches de l'image (`docker history`, inchangé).
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

  // --- Regroupement de nœuds dans le sous-graphe (14/08/2026, retour utilisateur : "dans le
  // subgraph il faut garder le meme comportement que le graph layer 1 c'est a dire la posibiliter
  // de refaire des groupes") — EXACTEMENT la même logique que TopologyGraph.tsx (mêmes noms d'état,
  // même thunk createTopologyGroup, même popover GroupLabelPopover désormais partagé via
  // topologyGraphShared.tsx), appliquée au(x) canevas <ReactFlow> de ce panneau qui affichent de
  // VRAIS TopologyNode/TopologyGroup sélectionnables : renderExternalDependenciesGraph ci-dessous
  // (vue "Dépendances" plein écran ET panneau embarqué "Réseau externe" de "Composition interne"),
  // jamais la vue "processus"/"réseau interne" (docker top/ports en écoute, aucun vrai nœud QUAI à
  // regrouper là). Un seul état partagé pour les deux usages de renderExternalDependenciesGraph :
  // ils affichent toujours exactement les mêmes `flowNodes`/`flowEdges` et ne sont JAMAIS montés
  // simultanément (un seul `viewMode` actif à la fois, voir sa JSDoc), rien à distinguer entre eux.
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  // Dernière sélection RAPPORTÉE par React Flow pendant un geste de rectangle de sélection — voir
  // TopologyGraph.tsx#lastReactFlowSelectionIds, même rôle exact.
  const lastReactFlowSelectionIds = useRef<string[]>([]);
  /** Voir TopologyGraph.tsx#isBoxSelecting (bug réel corrigé le 13/08/2026, JSDoc complète là-bas) —
   * même protection EXACTE ici : sans elle, le memo `nodesWithSelection` ci-dessous écraserait le
   * `selected` que React Flow vient de poser pendant le glissé, empêchant la sélection d'aboutir. */
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [groupLabelPopover, setGroupLabelPopover] = useState<{ mode: "create"; nodeIds: string[]; x: number; y: number } | null>(
    null,
  );
  /** Clic droit sur le canevas VIDE pendant une sélection multiple active — voir
   * TopologyGraph.tsx#selectionMenu, même rôle exact. */
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>("dependencies");
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  // Hexdump (GET .../files/hexdump) est ADMIN UNIQUEMENT côté serveur — bouton absent plutôt
  // qu'un clic qui échouerait en 403, voir renderPackageFilesPanel plus bas.
  const admin = canAdminister(session);
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

  // Processus détaillés (GET .../processes/detailed, remplace `docker top` DANS cette vue
  // précise — voir containersSlice.ts, `processes`/`fetchContainerProcesses` restent inchangés,
  // potentiellement utilisés ailleurs) — polling démarré/arrêté avec `viewMode`, voir plus bas.
  const processesDetailed = useAppSelector((s) => s.containers.processesDetailed);
  const processesDetailedStatus = useAppSelector((s) => s.containers.processesDetailedStatus);
  const processesDetailedError = useAppSelector((s) => s.containers.processesDetailedError);
  const processesDetailedContainerId = useAppSelector((s) => s.containers.processesDetailedContainerId);
  const processActionPendingPid = useAppSelector((s) => s.containers.processActionPendingPid);
  const images = useAppSelector((s) => s.images.items);
  const historyByImageId = useAppSelector((s) => s.images.historyByImageId);
  const historyStatus = useAppSelector((s) => s.images.historyStatus);
  const historyError = useAppSelector((s) => s.images.historyError);

  // --- État local des inspecteurs "à la demande" de la vue "Composition interne" (13/08/2026) ---
  // Même pattern que `groupInteriorPositions` ci-dessus (apiGet direct + useState local, pas de
  // slice Redux) : données ponctuelles propres à CE panneau, jamais réutilisées ailleurs dans
  // l'app — contrairement aux mutations (kill/restart de process, via Redux ci-dessus) qui
  // suivent le même pattern que le reste des actions de cycle de vie de ce fichier.

  /** PID (numérotation conteneur, voir ContainerProcessDetail) actuellement inspecté — "Inspecter"
   * d'une ligne de la liste de processus. */
  const [inspectedPid, setInspectedPid] = useState<number | null>(null);
  const [processInspection, setProcessInspection] = useState<ContainerProcessInspection | null>(null);
  const [processInspectionStatus, setProcessInspectionStatus] = useState<"idle" | "loading" | "error">("idle");
  const [processInspectionError, setProcessInspectionError] = useState<string | null>(null);

  /** Nom du paquet (Vulnerability#packageName) dont on affiche les fichiers réels — déclenché par
   * VulnerabilitiesPanel#onInspectPackage. */
  const [inspectedPackage, setInspectedPackage] = useState<string | null>(null);
  const [packageFiles, setPackageFiles] = useState<PackageFilesResult | null>(null);
  const [packageFilesStatus, setPackageFilesStatus] = useState<"idle" | "loading" | "error">("idle");
  const [packageFilesError, setPackageFilesError] = useState<string | null>(null);

  /** Chemin absolu du fichier dont on affiche le hexdump — déclenché depuis un fichier listé par
   * le panneau "paquet -> fichiers" ci-dessus ("Voir en hex", ADMIN uniquement). */
  const [hexdumpPath, setHexdumpPath] = useState<string | null>(null);
  const [hexdumpOffset, setHexdumpOffset] = useState(0);
  const [hexdump, setHexdump] = useState<FileHexdump | null>(null);
  const [hexdumpStatus, setHexdumpStatus] = useState<"idle" | "loading" | "error">("idle");
  const [hexdumpError, setHexdumpError] = useState<string | null>(null);

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
    // Nouvelle racine -> les inspecteurs ponctuels de l'ancienne "Composition interne" (process
    // inspecté, paquet, hexdump) n'ont plus de sens pour CE conteneur précis, jamais reportés
    // silencieusement sur le nouveau (voir leurs effets de fetch plus bas, gardés par ces états).
    setInspectedPid(null);
    setInspectedPackage(null);
    setHexdumpPath(null);
    setHexdumpOffset(0);
    // Une sélection multiple en cours (voir multiSelectedIds ci-dessus) n'a plus de sens une fois la
    // racine changée (drill-down/retour) — les nœuds sélectionnés ne sont même plus affichés.
    setMultiSelectedIds(new Set());
    setGroupLabelPopover(null);
    setSelectionMenu(null);
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

  // `selected` reflète la sélection multiple en cours pour "Regrouper" (`multiSelectedIds`) — même
  // principe EXACT que TopologyGraph.tsx#nodes : pendant un glissé de rectangle (`isBoxSelecting`),
  // on respecte le `selected` que React Flow vient de poser lui-même sur `n` plutôt que de le
  // remplacer par `false`, sous peine d'empêcher le geste d'aboutir (voir isBoxSelecting ci-dessus).
  const nodesWithSelection = useMemo(
    () =>
      flowNodes.map((n) => ({
        ...n,
        selected: multiSelectedIds.has(n.id) || (isBoxSelecting && !!n.selected),
      })),
    [flowNodes, multiSelectedIds, isBoxSelecting],
  );

  // --- Vue "Composition interne" (conteneurs uniquement, fusion du 13/08/2026) -------------------
  const isContainerRoot = rootNode?.kind === "container";

  useEffect(() => {
    if (viewMode !== "interior" || !rootNode || rootNode.kind !== "container") return;
    dispatch(fetchImages());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, viewMode, currentRootId]);

  // Polling court (PROCESS_POLL_INTERVAL_MS) de la liste de processus détaillée TANT QUE cette vue
  // est affichée — retour utilisateur du 13/08/2026 ("voir le temp entre chaque processu... une
  // vue façon Matrix") : démarré/arrêté avec `viewMode` exactement comme les autres effets à durée
  // de vie liée à un onglet de ce fichier (voir Shell/Logs), jamais en continu quand un autre
  // onglet est affiché — économise des exec Docker inutiles sur le conteneur cible.
  useEffect(() => {
    if (viewMode !== "interior" || !rootNode || rootNode.kind !== "container" || rootNode.status !== "running") return;
    dispatch(fetchContainerProcessesDetailed(rawRootId));
    const interval = setInterval(() => dispatch(fetchContainerProcessesDetailed(rawRootId)), PROCESS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch, viewMode, currentRootId, rootNode?.status, rawRootId]);

  const imageRef =
    isContainerRoot && rootNode ? images.find((i) => `${i.name}:${i.currentTag}` === rootNode.subtitle) ?? null : null;

  useEffect(() => {
    if (viewMode === "interior" && imageRef) dispatch(fetchImageHistory(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, viewMode, imageRef?.id]);

  const historyLayers = imageRef ? historyByImageId[imageRef.id] ?? null : null;
  // Bug réel corrigé le 14/08/2026 (retour utilisateur : le panneau "Processus réels" se vide/
  // rétrécit puis se repeuple/regrandit en boucle, "effet bizarre buggé") — root-causé : cette
  // condition exigeait `status === "ready"`, mais le sondage périodique (PROCESS_POLL_INTERVAL_MS,
  // ~2,5s) repasse par `"loading"` À CHAQUE cycle AVANT que la nouvelle réponse arrive, alors même
  // que `processesDetailed` contient encore la DERNIÈRE liste valide, inchangée. La liste entière
  // disparaissait donc brièvement à chaque sondage puis réapparaissait dès la résolution — jamais
  // un vrai premier chargement, juste un rafraîchissement en arrière-plan qui n'a aucune raison de
  // cacher des données déjà correctes. On garde maintenant la DERNIÈRE liste connue affichée tant
  // qu'elle correspond au bon conteneur, quel que soit le statut du sondage EN COURS — seul un
  // changement de conteneur (id différent) ou l'absence de toute donnée doit la vider.
  const processesDetailedReady = processesDetailedContainerId === rawRootId && processesDetailed !== null;
  const effectiveProcessesDetailed = processesDetailedReady ? processesDetailed : null;

  /** "Carte réseau interne" — dérivée des `listenPorts` réels de chaque process, aucune route
   * réseau séparée n'existe côté API (voir types.ts#ContainerProcessDetail). */
  const listeningProcesses = useMemo<ContainerProcessDetail[]>(
    () => (effectiveProcessesDetailed?.processes ?? []).filter((p) => (p.listenPorts?.length ?? 0) > 0),
    [effectiveProcessesDetailed],
  );

  // --- Inspecteurs "à la demande" (process/paquet/hexdump) — apiGet direct + useState local,
  // même pattern que `groupInteriorPositions` plus haut (données ponctuelles propres à ce panneau).

  useEffect(() => {
    if (inspectedPid == null || !currentRootId) {
      setProcessInspection(null);
      return;
    }
    let cancelled = false;
    setProcessInspectionStatus("loading");
    setProcessInspectionError(null);
    apiGet<ContainerProcessInspection>(`/containers/${rawRootId}/processes/${inspectedPid}/inspect`)
      .then((data) => {
        if (cancelled) return;
        setProcessInspection(data);
        setProcessInspectionStatus("idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProcessInspectionStatus("error");
        setProcessInspectionError(error instanceof ApiError ? error.message : "Impossible d'inspecter ce processus.");
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedPid, currentRootId, rawRootId]);

  // Dépend de `imageRef?.id` (valeur stable), jamais de l'objet `imageRef` entier — même
  // précaution que l'effet d'historique des couches plus haut (et le commentaire "Bug réel corrigé
  // le 13/08/2026" sur `nodesById` en tête de fichier) : `imageRef` est recalculé à CHAQUE rendu
  // depuis `images.find(...)`, une nouvelle identité d'objet à chaque refetch d'`images` aurait pu
  // redéclencher cet effet sans changement réel de ce qu'on affiche.
  useEffect(() => {
    if (!inspectedPackage || !imageRef) {
      setPackageFiles(null);
      return;
    }
    let cancelled = false;
    setPackageFilesStatus("loading");
    setPackageFilesError(null);
    apiGet<PackageFilesResult>(`/images/${encodeURIComponent(imageRef.id)}/packages/${encodeURIComponent(inspectedPackage)}/files`)
      .then((data) => {
        if (cancelled) return;
        setPackageFiles(data);
        setPackageFilesStatus("idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPackageFilesStatus("error");
        setPackageFilesError(
          error instanceof ApiError ? error.message : "Impossible de récupérer les fichiers de ce paquet.",
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectedPackage, imageRef?.id]);

  useEffect(() => {
    if (!hexdumpPath || !currentRootId) {
      setHexdump(null);
      return;
    }
    let cancelled = false;
    setHexdumpStatus("loading");
    setHexdumpError(null);
    apiGet<FileHexdump>(
      `/containers/${rawRootId}/files/hexdump?path=${encodeURIComponent(hexdumpPath)}&offset=${hexdumpOffset}&length=${HEXDUMP_WINDOW_BYTES}`,
    )
      .then((data) => {
        if (cancelled) return;
        setHexdump(data);
        setHexdumpStatus("idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHexdumpStatus("error");
        setHexdumpError(error instanceof ApiError ? error.message : "Impossible de lire ce fichier.");
      });
    return () => {
      cancelled = true;
    };
  }, [hexdumpPath, hexdumpOffset, currentRootId, rawRootId]);

  /** Ouvre le hexdump d'un nouveau fichier (repart toujours de l'offset 0 — un fichier précédent
   * consulté plus loin ne doit jamais teinter la fenêtre initiale du suivant). */
  function openHexdump(path: string) {
    setHexdumpPath(path);
    setHexdumpOffset(0);
  }

  /** Tue RÉELLEMENT un process (PID ≠ 1, voir la garde préventive sur le rendu des boutons plus
   * bas — un PID 1 n'affiche jamais ce bouton). Confirmation nommée obligatoire. Défense en
   * profondeur : si le serveur répond malgré tout 409 `useContainerStopInstead` (course entre
   * deux onglets, ou tout autre cas non anticipé côté client), redirige vers l'action "Arrêter le
   * conteneur" déjà existante plutôt qu'un message d'erreur brut. */
  async function handleKillProcess(proc: ContainerProcessDetail) {
    if (!rootNode) return;
    const ok = await confirm({
      title: "Tuer le processus",
      description: `Tuer le processus « ${proc.command} » (PID ${proc.pid}) ?`,
      confirmLabel: "Tuer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(killContainerProcess({ id: rawRootId, pid: proc.pid }));
    if (killContainerProcess.fulfilled.match(result)) {
      dispatch(fetchContainerProcessesDetailed(rawRootId));
      return;
    }
    if (result.payload?.useContainerStopInstead) {
      const stopOk = await confirm({
        title: "Arrêter le conteneur",
        description: `Tuer le PID 1 arrêterait tout le conteneur "${rootNode.label}" — arrêter le conteneur à la place ?`,
        confirmLabel: "Arrêter le conteneur",
        variant: "danger",
      });
      if (stopOk) await handleContainerAction(rawRootId, rootNode.label, "stop");
      return;
    }
    // Échec réel (process déjà mort, permission refusée...) — jamais avalé en silence, même
    // pattern que handleRemoveVolume/handleRemoveNetwork ci-dessous (pushNotification, la seule
    // surface d'erreur mutante réellement affichée dans ce fichier).
    dispatch(pushNotification({ level: "error", message: result.payload?.message ?? "Échec de l'arrêt du processus." }));
  }

  /** Relance EXACTEMENT la même cmdline d'un process (PID ≠ 1). Même défense en profondeur que
   * handleKillProcess ci-dessus pour le 409 `useContainerRestartInstead`. */
  async function handleRestartProcess(proc: ContainerProcessDetail) {
    if (!rootNode) return;
    const ok = await confirm({
      title: "Relancer le processus",
      description: `Relancer le processus « ${proc.command} » (PID ${proc.pid}) ?`,
      confirmLabel: "Relancer",
    });
    if (!ok) return;
    const result = await dispatch(restartContainerProcess({ id: rawRootId, pid: proc.pid }));
    if (restartContainerProcess.fulfilled.match(result)) {
      dispatch(fetchContainerProcessesDetailed(rawRootId));
      return;
    }
    if (result.payload?.useContainerRestartInstead) {
      const restartOk = await confirm({
        title: "Redémarrer le conteneur",
        description: `Relancer le PID 1 redémarrerait tout le conteneur "${rootNode.label}" — redémarrer le conteneur à la place ?`,
        confirmLabel: "Redémarrer le conteneur",
      });
      if (restartOk) await handleContainerAction(rawRootId, rootNode.label, "restart");
      return;
    }
    dispatch(
      pushNotification({ level: "error", message: result.payload?.message ?? "Échec du redémarrage du processus." }),
    );
  }

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

  // --- Regroupement de nœuds (voir multiSelectedIds ci-dessus) — même comportement EXACT que
  // TopologyGraph.tsx#handleNodeClick/handlePaneClick/handlePaneContextMenu/openCreateGroupPopover/
  // submitGroupLabelPopover, appliqué ici à renderExternalDependenciesGraph.

  /** Maj+clic accumule/retire de la sélection multiple, uniquement pour "Regrouper" — un clic simple
   * (sans Maj) ne fait rien ici (ce panneau n'a pas de simple surbrillance de nœud comme le graphe
   * principal, seul le double-clic — drillInto — et le clic droit — nodeMenu — ont un sens hors
   * sélection multiple). */
  function handleNodeClick(event: React.MouseEvent, node: Node) {
    if (!event.shiftKey || !operate) return;
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  function handlePaneClick() {
    if (multiSelectedIds.size > 0) setMultiSelectedIds(new Set());
  }

  /** Clic droit sur le canevas VIDE : propose "Grouper la sélection" seulement si une sélection
   * multiple est active (voir TopologyGraph.tsx#handlePaneContextMenu) — sinon ne fait rien (ce
   * panneau n'a pas de picker de création au clic droit sur le vide, contrairement au graphe
   * principal, hors du périmètre de cette mission). */
  function handlePaneContextMenu(event: MouseEvent | React.MouseEvent) {
    if (!operate || multiSelectedIds.size < 2) return;
    event.preventDefault();
    const mouseEvent = event as MouseEvent;
    setSelectionMenu({ x: mouseEvent.clientX, y: mouseEvent.clientY });
  }

  /** Ouvre le popover de nom pour la sélection multiple en cours (bouton flottant "Regrouper", voir
   * renderExternalDependenciesGraph plus bas) — jamais moins de 2 nœuds (bouton non affiché sinon). */
  function openCreateGroupPopover(x: number, y: number) {
    if (multiSelectedIds.size < 2) return;
    setGroupLabelPopover({ mode: "create", nodeIds: Array.from(multiSelectedIds), x, y });
  }

  /** Réutilise TEL QUEL le thunk createTopologyGroup (topologySlice.ts) — POST /api/topology/groups
   * réel, EXACTEMENT la même route que le bouton "Regrouper" du graphe principal, jamais une
   * seconde implémentation. `dispatch(fetchTopology())` après succès : ce panneau reçoit `topology`
   * en PROP (pas de fetch propre), il faut donc explicitement redéclencher le rafraîchissement
   * partagé pour voir le nouveau groupe apparaître ici (et dans le graphe principal en ressortant). */
  async function submitGroupLabelPopover(label: string): Promise<{ ok: boolean; error?: string }> {
    if (!groupLabelPopover) return { ok: false };
    const result = await dispatch(createTopologyGroup({ label, nodeIds: groupLabelPopover.nodeIds }));
    if (createTopologyGroup.fulfilled.match(result)) {
      setMultiSelectedIds(new Set());
      dispatch(
        pushNotification({ level: "success", message: `Groupe « ${label} » créé (${groupLabelPopover.nodeIds.length} éléments).` }),
      );
      dispatch(fetchTopology());
      return { ok: true };
    }
    return { ok: false, error: result.payload ?? "Échec de la création du groupe." };
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

  function nodeMenuItems(node: TopologyNode, x: number, y: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => onOpenDetail(node) }];
    // `nodesById.has(node.id)` exclut le drilldown sur une brique (TopologyNode synthétique
    // reconstruit par attachmentToTopologyNode, voir brickCallbacks ci-dessus) : son id ne
    // correspond à AUCUN nœud top-level de `topology.nodes` (tout l'objet du "briquage"), le
    // sous-graphe n'aurait rien de réel à recentrer dessus.
    if (node.id !== currentRootId && nodesById.has(node.id)) {
      items.push({ label: "Visualiser ses dépendances", onClick: () => drillInto(node.id) });
    }
    // "Grouper la sélection" (même règle EXACTE que TopologyGraph.tsx#nodeMenuItems) — affiché
    // seulement quand CE nœud fait partie de la sélection multiple en cours (>= 2).
    if (operate && multiSelectedIds.size >= 2 && multiSelectedIds.has(node.id)) {
      items.push({ label: `Grouper la sélection (${multiSelectedIds.size})`, onClick: () => openCreateGroupPopover(x, y) });
    }
    if (!operate) return items;
    // Une brique (id absent de `nodesById`, voir ci-dessus) n'est qu'une vue de lecture d'un
    // attachement — aucune action de cycle de vie propre ici (déjà proposées, le cas échéant,
    // depuis le vrai nœud conteneur qui la porte).
    if (!nodesById.has(node.id)) return items;
    // Actions PAR KIND : la LISTE (id/libellé/danger/condition de visibilité) est déclarée dans le
    // contrat (NODE_CONTRACT[kind].menuItems, topologyNodeContract.tsx — même source de vérité que
    // le menu du graphe principal, jamais une liste dupliquée qui pourrait diverger) ; ce panneau
    // ne fournit VOLONTAIREMENT qu'un sous-ensemble de callbacks — pas de "Renommer"/"Connecter à
    // un network…" ni d'action VM Nutanix/automatisation dans le sous-graphe (comportement
    // historique, inchangé par la migration du 17/08/2026) : buildNodeMenuItems omet simplement
    // toute action déclarée sans handler, jamais un item mort.
    const id = idWithoutPrefix(node.id);
    items.push(
      ...buildNodeMenuItems(node, {
        "container-stop": () => void handleContainerAction(id, node.label, "stop"),
        "container-start": () => void handleContainerAction(id, node.label, "start"),
        "container-restart": () => void handleContainerAction(id, node.label, "restart"),
        "container-remove": () => void handleContainerAction(id, node.label, "remove"),
        "volume-remove": () => void handleRemoveVolume(id),
        "network-remove": () => void handleRemoveNetwork(id, node.label),
      }),
    );
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

  /**
   * Graphe des dépendances EXTERNES (réseau/volumes/autres conteneurs reliés par une vraie arête)
   * — EXACTEMENT le même rendu que l'ancien onglet "Dépendances" (mêmes `flowNodes`/`flowEdges`/
   * gestionnaires, déjà calculés plus haut pour `currentRootId`), réutilisé tel quel à deux
   * endroits : la vue "dependencies" (nœuds NON-conteneur/groupes, inchangée) et le panneau
   * "Réseau externe" de "Composition interne" ci-dessous (fusion du 13/08/2026) — jamais une
   * seconde implémentation qui pourrait diverger (même principe que VulnerabilitiesPanel.tsx).
   * Les deux appelants ne sont jamais montés simultanément (un seul `viewMode` actif à la fois).
   */
  /**
   * `compact` (ajouté le 14/08/2026, retour utilisateur : "bug de resize" — la MiniMap, pensée
   * pour la vue plein écran d'origine, se réaffichait telle quelle dans le petit panneau repliable
   * "Réseau externe" de Composition interne, ~280px de haut : une carte miniature DANS une carte
   * déjà miniature, illisible et visuellement cassée) : `true` pour l'usage EMBARQUÉ dans un
   * panneau réduit (masque la MiniMap, inutile à cette échelle), `false` pour l'ancien usage plein
   * écran (root non-conteneur, seul contexte qui garde "Dépendances" en contenu principal) — même
   * calcul de nœuds/arêtes dans les deux cas, aucune deuxième implémentation.
   */
  function renderExternalDependenciesGraph(compact: boolean) {
    return (
      <>
        <ReactFlow
          key={currentRootId ?? "none"}
          nodes={nodesWithSelection}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={(_event, node) => drillInto(node.id)}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          onNodeContextMenu={handleNodeContextMenu}
          nodesConnectable={false}
          // Sélection multiple (Maj+clic, voir handleNodeClick) + rectangle de sélection au
          // clic-glissé sur le canevas VIDE — EXACTEMENT les mêmes props que TopologyGraph.tsx (voir
          // ses commentaires détaillés, non répétés ici) : réservé operator/admin, seul rôle qui peut
          // ensuite "Regrouper" (le bouton flottant reste de toute façon masqué pour un viewer).
          multiSelectionKeyCode="Shift"
          panOnDrag={operate ? [1, 2] : true}
          selectionOnDrag={operate}
          selectionMode={SelectionMode.Partial}
          onSelectionChange={(params) => {
            lastReactFlowSelectionIds.current = params.nodes.map((n) => n.id);
          }}
          onSelectionStart={() => setIsBoxSelecting(true)}
          onSelectionEnd={() => {
            setIsBoxSelecting(false);
            if (lastReactFlowSelectionIds.current.length >= 2) {
              setMultiSelectedIds(new Set(lastReactFlowSelectionIds.current));
            }
          }}
          deleteKeyCode={null}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
        >
          <Background gap={20} size={1.6} color="var(--color-text-faint)" />
          {!compact && (
            <MiniMap
              position="top-left"
              nodeColor={(n) =>
                n.type === "topologyGroupNode" ? "#e879f9" : nodeMinimapColor(n.data as unknown as TopologyNode)
              }
              nodeStrokeWidth={0}
              nodeBorderRadius={4}
              maskColor="rgba(11, 12, 16, 0.75)"
              pannable
              zoomable
            />
          )}
        </ReactFlow>

        {/* Bouton flottant "Regrouper" (voir multiSelectedIds ci-dessus) — même bouton EXACT que
            TopologyGraph.tsx, coin haut-droit de CE canevas précis (`renderExternalDependenciesGraph`
            a deux appelants qui ne sont jamais montés simultanément, voir sa JSDoc). En contexte
            `compact` (panneau embarqué "Réseau externe" de Composition interne, ~280px de haut, voir
            .topology-interior__depgraph), un modificateur CSS réduit le bouton en overlay discret
            plutôt qu'un bouton plein qui déborderait de ce mini-canevas (voir topology.css). */}
        {operate && multiSelectedIds.size >= 2 && (
          <div className={`topology-toolbar-top-right${compact ? " topology-toolbar-top-right--compact" : ""}`}>
            <button
              type="button"
              className="btn btn-primary btn-sm topology-group-action-btn"
              onClick={(event) => openCreateGroupPopover(event.clientX, event.clientY)}
            >
              Regrouper ({multiSelectedIds.size})
            </button>
          </div>
        )}
      </>
    );
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
              {/* Fusion du 13/08/2026 : plus d'onglet "Dépendances" séparé pour un conteneur — le
                  réseau externe est désormais un panneau DANS "Composition interne" (voir
                  renderExternalDependenciesGraph plus bas), `viewMode` ne passe donc plus jamais
                  à "dependencies" pour ce kind précis (aucun bouton ne le déclenche ici). */}
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

          <div className="topology-subgraph-panel__graph">{renderExternalDependenciesGraph(false)}</div>
        </>
      )}

      {viewMode === "interior" && rootNode && (
        <div className="topology-interior">
          <div className="topology-interior__caption">
            Composition interne réelle — processus DEPUIS L'INTÉRIEUR du conteneur (
            <code>/proc</code> via <code>docker exec</code>, GET /processes/detailed), leur réseau interne/externe,
            les vulnérabilités réelles (Grype/OSV-Scanner) et l'historique des couches de l'image (
            <code>docker history</code>). Ceci n'est <strong>pas</strong> une carte d'architecture applicative :
            QUAI ne peut pas connaître l'organisation logicielle interne de ce conteneur (il faudrait du tracing
            applicatif, hors périmètre), seulement ce que le noyau hôte y voit réellement tourner et ce que
            Grype/OSV-Scanner y détectent réellement.
          </div>

          <div className="topology-interior__unified-grid">
            <div className="topology-interior__unified-col">
              {/* --- Processus réels (GET .../processes/detailed) — remplace le panneau `docker top`
                  d'origine DANS CETTE VUE PRÉCISE, voir containersSlice.ts. Pas de CollapsibleSection
                  ici : c'est le contenu principal de la vue, jamais replié. */}
              <div className="topology-interior__panel">
                <div className="topology-interior__panel-title topology-interior__panel-title--static">
                  <span className="topology-interior__panel-title-text">
                    Processus réels — <code>/proc</code> depuis l'intérieur
                  </span>
                  {rootNode.status === "running" && processesDetailedReady && effectiveProcessesDetailed && (
                    <span className="topology-interior__panel-subtitle">
                      {effectiveProcessesDetailed.processes.length} · rafraîchi toutes les {PROCESS_POLL_INTERVAL_MS / 1000}s
                    </span>
                  )}
                </div>
                <div className="topology-interior__panel-body">
                  {rootNode.status !== "running" && (
                    <div className="empty-state">
                      Ce conteneur est arrêté — l'inspection détaillée des processus nécessite un conteneur en
                      cours d'exécution.
                    </div>
                  )}
                  {rootNode.status === "running" && processesDetailedStatus === "loading" && !effectiveProcessesDetailed && (
                    <div className="empty-state">Chargement des processus réels…</div>
                  )}
                  {rootNode.status === "running" &&
                    processesDetailedStatus === "error" &&
                    processesDetailedContainerId === rawRootId && (
                      <div className="error-banner">{processesDetailedError}</div>
                    )}
                  {rootNode.status === "running" && effectiveProcessesDetailed && !effectiveProcessesDetailed.shellAvailable && (
                    <div className="empty-state">
                      Aucun shell POSIX dans ce conteneur, impossible d'inspecter ses processus en détail (image
                      "distroless"/scratch, typiquement).
                    </div>
                  )}
                  {rootNode.status === "running" && effectiveProcessesDetailed && effectiveProcessesDetailed.shellAvailable && (
                    <div className="topology-interior__proc-list">
                      <div className="topology-interior__proc-row topology-interior__proc-row--head">
                        <span></span>
                        <span>PID</span>
                        <span>Commande</span>
                        <span>CPU cumulé</span>
                        <span>Âge</span>
                        <span></span>
                      </div>
                      {effectiveProcessesDetailed.processes.map((proc) => (
                        <div key={proc.pid} className="topology-interior__proc-row">
                          <span
                            className={`topology-interior__proc-dot${proc.state === "R" ? " is-running" : ""}`}
                            title={`État réel (man 5 proc) : ${proc.state}`}
                          />
                          <span className="topology-interior__proc-pid cell-mono">{proc.pid}</span>
                          <span className="topology-interior__proc-cmd cell-mono" title={proc.command}>
                            {proc.command}
                          </span>
                          <span className="topology-interior__proc-cpu cell-mono">{formatCpuTime(proc.cpuTimeMs)}</span>
                          <span className="topology-interior__proc-age cell-mono">{formatProcessAge(proc.ageSeconds)}</span>
                          <span className="topology-interior__proc-actions">
                            <button
                              type="button"
                              className="topology-interior__link-btn"
                              onClick={() => setInspectedPid(proc.pid)}
                            >
                              Inspecter
                            </button>
                            {operate && proc.pid === 1 && (
                              // Garde préventive (mêmes PID que le serveur, voir types.ts#ContainerProcessDetail) :
                              // jamais de tentative de kill/restart sur le PID 1 depuis cette UI — redirige
                              // directement vers l'action de cycle de vie du conteneur existante. Le serveur
                              // refuserait de toute façon en 409 (défense en profondeur dans handleKillProcess/
                              // handleRestartProcess), mais cette garde évite l'aller-retour raté.
                              // Libellés courts + `title` pour le détail complet (retour utilisateur du
                              // 14/08/2026 : "bug de resize" — "Redémarrer le conteneur"/"Arrêter le
                              // conteneur" en entier forçaient cette ligne, et donc toute la grille, plus
                              // large que le panneau ; le contexte de la ligne PID 1 rend déjà clair de
                              // quel conteneur il s'agit, la répétition n'apportait rien).
                              <>
                                <button
                                  type="button"
                                  className="topology-interior__link-btn"
                                  title="Redémarrer le conteneur (PID 1 = tout le conteneur)"
                                  onClick={() => void handleContainerAction(rawRootId, rootNode.label, "restart")}
                                >
                                  Redémarrer
                                </button>
                                <button
                                  type="button"
                                  className="topology-interior__link-btn topology-interior__link-btn--danger"
                                  title="Arrêter le conteneur (PID 1 = tout le conteneur)"
                                  onClick={() => void handleContainerAction(rawRootId, rootNode.label, "stop")}
                                >
                                  Arrêter
                                </button>
                              </>
                            )}
                            {operate && proc.pid !== 1 && (
                              <>
                                <button
                                  type="button"
                                  className="topology-interior__link-btn"
                                  disabled={processActionPendingPid === proc.pid}
                                  onClick={() => void handleRestartProcess(proc)}
                                >
                                  Relancer
                                </button>
                                <button
                                  type="button"
                                  className="topology-interior__link-btn topology-interior__link-btn--danger"
                                  disabled={processActionPendingPid === proc.pid}
                                  onClick={() => void handleKillProcess(proc)}
                                >
                                  Tuer
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {inspectedPid != null && (
                <CollapsibleSection
                  title={`Process PID ${inspectedPid}`}
                  subtitle={
                    <button type="button" className="topology-interior__link-btn" onClick={() => setInspectedPid(null)}>
                      Fermer
                    </button>
                  }
                >
                  {processInspectionStatus === "loading" && <div className="empty-state">Inspection du process…</div>}
                  {processInspectionStatus === "error" && <div className="error-banner">{processInspectionError}</div>}
                  {processInspection && (
                    <>
                      <p className="topology-interior__hint cell-mono">{processInspection.cmdline.join(" ")}</p>
                      {processInspection.partial && (
                        <div className="empty-state">
                          Certaines informations (variables d'environnement et/ou fichiers ouverts) n'ont pas pu être
                          lues pour ce process précis — permission refusée par le noyau, jamais un contenu inventé.
                        </div>
                      )}
                      {processInspection.environ && (
                        <>
                          <div className="topology-interior__history-title">Variables d'environnement</div>
                          <ul className="topology-interior__file-list">
                            {Object.entries(processInspection.environ).map(([key, value]) => (
                              <li key={key}>
                                <span className="cell-mono">
                                  {key}={value}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {processInspection.openFiles && (
                        <>
                          <div className="topology-interior__history-title">Fichiers ouverts</div>
                          <ul className="topology-interior__file-list">
                            {processInspection.openFiles.map((file, index) => (
                              <li key={`${file}-${index}`}>
                                <span className="cell-mono">{file}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </CollapsibleSection>
              )}

              {/* "Carte réseau interne" — dérivée des `listenPorts` réels de chaque process ci-dessus,
                  aucune route réseau séparée n'existe côté API (voir types.ts#ContainerProcessDetail). */}
              <CollapsibleSection
                title="Réseau interne"
                subtitle={`${listeningProcesses.length} process en écoute`}
                defaultOpen={listeningProcesses.length > 0}
              >
                {listeningProcesses.length === 0 ? (
                  <div className="empty-state">
                    Aucun port en LISTEN détecté parmi les processus réels de ce conteneur.
                  </div>
                ) : (
                  <div className="topology-interior__netmap">
                    {listeningProcesses.flatMap((proc) =>
                      (proc.listenPorts ?? []).map((port) => (
                        <div key={`${proc.pid}-${port}`} className="topology-interior__netmap-row">
                          <span className="topology-interior__netmap-port cell-mono">:{port}</span>
                          <span className="topology-interior__netmap-owner cell-mono">
                            PID {proc.pid} · {proc.command}
                          </span>
                        </div>
                      )),
                    )}
                  </div>
                )}
              </CollapsibleSection>

              {/* Réseau EXTERNE — ex-onglet "Dépendances", fusionné ici le 13/08/2026 (voir
                  renderExternalDependenciesGraph, même calcul/rendu que la vue "dependencies"). */}
              <CollapsibleSection
                title="Réseau externe (dépendances)"
                subtitle={`${neighborIds.length} nœud${neighborIds.length > 1 ? "s" : ""} relié${neighborIds.length > 1 ? "s" : ""}`}
                defaultOpen={neighborIds.length > 0}
              >
                {neighborIds.length === 0 ? (
                  <div className="empty-state">
                    Aucune dépendance directe pour « {rootNode.label} » — ce nœud n'a aucune arête dans le graphe.
                  </div>
                ) : (
                  <div className="topology-interior__depgraph">{renderExternalDependenciesGraph(true)}</div>
                )}
              </CollapsibleSection>
            </div>

            <div className="topology-interior__unified-col">
              {/* Retour utilisateur du 13/08/2026 : "il faut grâce à grype/syft/osv... voir quel
                  paquet est critique et pourquoi" — même composant que l'onglet "Vulnérabilités" du
                  panneau de détail (voir VulnerabilitiesPanel.tsx), pas une seconde implémentation.
                  `onInspectPackage` (ajouté le 13/08/2026) ouvre le panneau "paquet -> fichiers"
                  ci-dessous plutôt que de dupliquer l'appel GET .../packages/:packageName/files ici. */}
              <div className="topology-interior__panel">
                <div className="topology-interior__panel-body">
                  <VulnerabilitiesPanel imageRef={imageRef} operate={operate} onInspectPackage={setInspectedPackage} />
                </div>
              </div>

              {inspectedPackage && (
                <CollapsibleSection
                  title={`Fichiers du paquet « ${inspectedPackage} »`}
                  subtitle={
                    <button
                      type="button"
                      className="topology-interior__link-btn"
                      onClick={() => setInspectedPackage(null)}
                    >
                      Fermer
                    </button>
                  }
                >
                  {packageFilesStatus === "loading" && (
                    <div className="empty-state">Recherche des fichiers réels de « {inspectedPackage} » dans l'image…</div>
                  )}
                  {packageFilesStatus === "error" && <div className="error-banner">{packageFilesError}</div>}
                  {packageFiles && !packageFiles.available && (
                    <div className="empty-state">
                      {packageFiles.reason ?? `Aucun fichier trouvé pour "${inspectedPackage}".`}
                    </div>
                  )}
                  {packageFiles && packageFiles.available && (
                    <>
                      {packageFiles.reason && <p className="topology-interior__hint">{packageFiles.reason}</p>}
                      {packageFiles.packageRoot && (
                        <p className="topology-interior__hint">
                          Racine : <code>{packageFiles.packageRoot}</code>
                        </p>
                      )}
                      <ul className="topology-interior__file-list">
                        {(packageFiles.files ?? []).map((file) => (
                          <li key={file}>
                            <span className="cell-mono">{file}</span>
                            {admin && (
                              <button
                                type="button"
                                className="topology-interior__link-btn"
                                onClick={() => openHexdump(file)}
                              >
                                Voir en hex
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </CollapsibleSection>
              )}

              {hexdumpPath && (
                <CollapsibleSection
                  title={`Hexdump — ${hexdumpPath}`}
                  subtitle={
                    <button type="button" className="topology-interior__link-btn" onClick={() => setHexdumpPath(null)}>
                      Fermer
                    </button>
                  }
                >
                  {hexdumpStatus === "loading" && <div className="empty-state">Lecture du fichier…</div>}
                  {hexdumpStatus === "error" && <div className="error-banner">{hexdumpError}</div>}
                  {hexdump && (
                    <>
                      <div className="topology-interior__hint">
                        {formatMem(hexdump.sizeBytes)} au total{hexdump.truncated ? " · fenêtre tronquée" : ""} — octets{" "}
                        {hexdump.offset}–{hexdump.offset + hexdump.length}
                      </div>
                      <pre className="topology-interior__hexdump">
                        {hexdumpRows(hexdump.bytes, hexdump.offset).map((row) => (
                          <div key={row.offsetLabel} className="topology-interior__hexdump-row">
                            <span className="topology-interior__hexdump-offset">{row.offsetLabel}:</span>
                            <span className="topology-interior__hexdump-hex">{row.groups.join(" ")}</span>
                            <span className="topology-interior__hexdump-ascii">{row.ascii}</span>
                          </div>
                        ))}
                      </pre>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={hexdumpOffset === 0}
                          onClick={() => setHexdumpOffset((o) => Math.max(0, o - HEXDUMP_WINDOW_BYTES))}
                        >
                          ← Précédent
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!hexdump.truncated}
                          onClick={() => setHexdumpOffset((o) => o + HEXDUMP_WINDOW_BYTES)}
                        >
                          Suivant →
                        </button>
                      </div>
                    </>
                  )}
                </CollapsibleSection>
              )}

              <div className="topology-interior__panel">
                <div className="topology-interior__panel-title topology-interior__panel-title--static">
                  <span className="topology-interior__panel-title-text">
                    Image — <code>docker history</code>
                  </span>
                </div>
                <div className="topology-interior__panel-body">
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
        </div>
      )}

      {nodeMenu && (
        <ContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          onClose={() => setNodeMenu(null)}
          items={nodeMenuItems(nodeMenu.node, nodeMenu.x, nodeMenu.y)}
        />
      )}

      {groupMenu && (
        <ContextMenu x={groupMenu.x} y={groupMenu.y} onClose={() => setGroupMenu(null)} items={groupMenuItems(groupMenu.group)} />
      )}

      {selectionMenu && operate && (
        <ContextMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onClose={() => setSelectionMenu(null)}
          items={[
            {
              label: `Grouper la sélection (${multiSelectedIds.size})`,
              onClick: () => openCreateGroupPopover(selectionMenu.x, selectionMenu.y),
            },
          ]}
        />
      )}

      {groupLabelPopover && (
        <GroupLabelPopover
          title="Regrouper la sélection"
          initialLabel={`Groupe (${groupLabelPopover.nodeIds.length} éléments)`}
          submitLabel="Regrouper"
          x={groupLabelPopover.x}
          y={groupLabelPopover.y}
          onSubmit={submitGroupLabelPopover}
          onClose={() => setGroupLabelPopover(null)}
        />
      )}
    </div>
  );
}
