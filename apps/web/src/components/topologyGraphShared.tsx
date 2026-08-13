import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  getBezierPath,
  useStore,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import {
  IconBackup,
  IconBell,
  IconBranch,
  IconChevron,
  IconClock,
  IconContainers,
  IconFolder,
  IconGitOps,
  IconGlobe,
  IconHostMachine,
  IconNetworks,
  IconPlay,
  IconServer,
  IconStack,
  IconVm,
  IconVolumes,
} from "@/components/icons";
import type { TopologyEdge, TopologyEdgePort, TopologyGroup, TopologyNode, TopologyNodeAttachment } from "@/types";

/**
 * Éléments du graphe de topologie partagés entre le graphe principal (TopologyGraph.tsx) et le
 * panneau de sous-graphe ouvert au double-clic (TopologySubGraphPanel.tsx) — extraits ici pour
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
  "ad-server": IconServer,
  host: IconHostMachine,
  // Icône générique "infra" (empilement de couches) — un seul kind de nœud pour les 3 moteurs
  // (tofu/ansible/packer, voir TopologyNode#iacEngine), pas d'icône distincte par moteur : IconStack
  // était déjà l'icône Sidebar de l'ancienne page Infra-as-code (voir Sidebar.tsx), aucune icône
  // dédiée par outil n'existe dans icons.tsx et en ajouter 3 pour une distinction que le sous-titre
  // du nœud (label du moteur, services/topology.ts#getIacWorkspaceNodes) porte déjà n'aurait rien
  // apporté de plus lisible sur une carte de 260px de large.
  "iac-workspace": IconStack,
  // Cron job (services/cronJobsStore.ts) — horloge, façon Railway "Cron Jobs".
  "cron-job": IconClock,
  // Sauvegarde (services/backupsStore.ts) — même icône que l'ancienne page BackupsPage.tsx/Sidebar.
  backup: IconBackup,
  // Dépôt Git source GitOps (services/topology.ts#getGitOpsSourceNode) — même icône que l'ancienne
  // page GitOps.tsx/Sidebar (voir icons.tsx#IconGitOps), réutilisée telle quelle.
  "gitops-source": IconGitOps,
  // Déclenchement d'une automatisation (services/automationStore.ts) — cloche d'alerte (IconBell,
  // déjà utilisée par Topbar.tsx pour les notifications) : un trigger surveille un état et "sonne
  // l'alarme", aucune icône éclair dédiée n'existe dans ce fichier, IconBell porte déjà ce sens.
  "automation-trigger": IconBell,
  // Condition d'une automatisation — point de décision qui divise la chaîne en deux issues
  // possibles (voir icons.tsx#IconBranch, ajoutée pour ce chantier faute d'icône de fourche déjà
  // disponible dans icons.tsx).
  "automation-condition": IconBranch,
  // Action d'une automatisation — déclenchement/exécution réelle (voir icons.tsx#IconPlay, déjà
  // utilisée pour "Démarrer"/"Exécuter maintenant" ailleurs dans l'appli), même sens ici : cette
  // action "joue" la commande configurée.
  "automation-action": IconPlay,
};

/** Couleurs de la MiniMap par type de nœud — mêmes valeurs que celles utilisées pour l'icône du
 * nœud correspondant dans topology.css (--accent-start, --color-warning, --accent-end). */
export const MINIMAP_NODE_COLOR: Record<TopologyNode["kind"], string> = {
  container: "#3b6fef",
  volume: "#f5a524",
  network: "#7c5cfc",
  "nutanix-vm": "#22c55e",
  "ad-server": "#e879f9",
  // Teal — distinct des cinq autres couleurs déjà utilisées ci-dessus, cohérent avec
  // .topology-node--host/.topology-detail-panel__icon--host dans topology.css.
  host: "#14b8a6",
  // Orange brûlé — distinct des six autres couleurs déjà utilisées ci-dessus (notamment de l'ambre
  // du volume, #f5a524), cohérent avec .topology-node--iac-workspace/.topology-detail-panel__icon--
  // iac-workspace dans topology.css.
  "iac-workspace": "#f97316",
  // Jaune — distinct des sept autres couleurs déjà utilisées (notamment de l'ambre du volume et de
  // l'orange brûlé de "iac-workspace" ci-dessus), cohérent avec .topology-node--cron-job/
  // .topology-detail-panel__icon--cron-job dans topology.css.
  "cron-job": "#facc15",
  // Bleu ciel — distinct des huit autres couleurs déjà utilisées (notamment du bleu royal du
  // conteneur), cohérent avec .topology-node--backup/.topology-detail-panel__icon--backup dans
  // topology.css.
  backup: "#0ea5e9",
  // Rose/rouge — distinct des neuf autres couleurs déjà utilisées ci-dessus, cohérent avec
  // .topology-node--gitops-source/.topology-detail-panel__icon--gitops-source dans topology.css.
  "gitops-source": "#f43f5e",
  // Rouge vif "alerte" — distinct des dix autres couleurs déjà utilisées ci-dessus (notamment du
  // rose/rouge de gitops-source, plus froid), cohérent avec .topology-node--automation-trigger/
  // .topology-detail-panel__icon--automation-trigger dans topology.css.
  "automation-trigger": "#dc2626",
  // Gris-bleu neutre — une condition n'a pas d'état "positif/négatif" propre, distinct des onze
  // autres couleurs déjà utilisées, cohérent avec .topology-node--automation-condition/
  // .topology-detail-panel__icon--automation-condition dans topology.css.
  "automation-condition": "#64748b",
  // Vert vif (lime) — volontairement une nuance DIFFÉRENTE de --color-success (#22c55e, déjà pris
  // par le statut "running"/nutanix-vm) pour ne pas laisser croire à un statut, distinct des douze
  // autres couleurs déjà utilisées, cohérent avec .topology-node--automation-action/
  // .topology-detail-panel__icon--automation-action dans topology.css.
  "automation-action": "#84cc16",
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
  // Même principe pour le contrôleur de domaine/DNS AD (services/adDns.ts) : jamais relié par une
  // arête (aucune donnée ne prouve un lien réel avec un nœud Docker/Nutanix précis).
  "ad-server": [],
  // Nœuds "host" (cluster Nutanix / environnement Docker distant / hôte LXD, voir
  // services/topology.ts) : pas connectables comme un conteneur/volume/network — la seule arête
  // qui les touche ("hosts", cluster Nutanix -> VM) est posée par le serveur, jamais glissée à la
  // main par l'utilisateur.
  host: [],
  // Workspaces IaC (voir services/topology.ts#getIacWorkspaceNodes) : indépendants de l'infra Docker
  // locale comme les VMs Nutanix/le contrôleur AD ci-dessus — un `tofu apply`/`ansible-playbook`/
  // `packer build` peut provisionner une ressource Docker, mais QUAI n'a aucune donnée reliant
  // RÉELLEMENT ce workspace à un nœud précis du graphe, jamais d'arête ou de port inventés.
  "iac-workspace": [],
  // Cron job/sauvegarde (voir services/topology.ts#getCronJobNodes/getBackupNodes) : même principe
  // — définitions indépendantes de Docker, jamais reliées par une arête à leur conteneur/volume
  // cible (QUAI n'a aucune garantie que cette relation reste vraie dans le temps, ex : conteneur
  // cible renommé/supprimé — voir CronJobDefinition#containerName dénormalisé).
  "cron-job": [],
  backup: [],
  // Dépôt Git source GitOps (voir services/topology.ts#getGitOpsSourceNode) — même principe qu'ad-
  // server/host/iac-workspace ci-dessus : une config globale indépendante de Docker, jamais reliée
  // par une arête à un nœud précis du graphe (QUAI n'a aucune donnée reliant réellement un manifeste
  // à la ressource Docker/Kubernetes qu'il décrit au-delà du rapprochement best-effort déjà utilisé
  // pour le badge "Dérive GitOps" des conteneurs, jamais assez fiable pour une arête).
  "gitops-source": [],
  // Nœuds d'automatisation (trigger/condition/action, voir services/automationStore.ts) : PAS de
  // "port" de connexion typé réseau/volume comme un conteneur — restent [] ici, comme host/
  // iac-workspace/cron-job/backup/gitops-source ci-dessus. Ils sont néanmoins bien connectables
  // entre eux par glisser-déposer (trigger->condition, trigger->action, condition->action) : ce
  // câblage est géré directement par GraphNode (Handles génériques posés ci-dessous, hors de cette
  // table de capacités typées) et par TopologyGraph.tsx#classifyConnection/handleConnect (cas
  // spécial "les deux bouts sont des nœuds d'automatisation", POST /api/automation/edges — voir
  // apps/api/src/routes/automation.ts#isValidConnection pour la même règle d'ordre appliquée ici
  // côté UI avant tout appel réseau).
  "automation-trigger": [],
  "automation-condition": [],
  "automation-action": [],
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

/**
 * Métadonnées de rendu d'un port PAR CAPACITÉ (indépendantes du type de nœud qui le porte) —
 * reprises telles quelles des entrées NODE_CAPABILITIES existantes (même position/couleur/libellé
 * pour une capacité donnée, quel que soit le nœud) : un groupe (voir deriveGroupPorts ci-dessous)
 * n'est PAS un type de nœud avec ses propres ports fixes, ses ports dépendent de ce qu'il contient
 * réellement — cette table permet de construire un Handle synthétique cohérent avec le reste du
 * graphe pour n'importe quelle capacité, sans dupliquer position/couleur/libellé à chaque usage.
 */
const CAPABILITY_PORT_META: Record<CapabilityId, Pick<PortSpec, "handleType" | "position" | "colorToken" | "label">> = {
  network: { handleType: "source", position: Position.Right, colorToken: "network", label: "Network" },
  attach: { handleType: "target", position: Position.Left, colorToken: "network", label: "Attache un conteneur" },
  "volume-mount": { handleType: "target", position: Position.Left, colorToken: "volume", label: "Volume (lecture seule)" },
  provide: { handleType: "source", position: Position.Right, colorToken: "volume", label: "Fournit un volume" },
};

/**
 * Ports d'entrée/sortie d'un groupe (voir TopologyGroup, apps/api/src/types.ts) — DÉRIVÉS des
 * arêtes réelles du graphe complet qui traversent sa frontière (un membre du groupe d'un côté, un
 * nœud extérieur de l'autre), jamais inventés/devinés : un groupe qui ne contient que des nœuds
 * sans aucune connexion externe n'a simplement aucun port. Une arête ENTIÈREMENT interne au groupe
 * (les deux bouts sont membres) ne produit aucun port — elle reste invisible une fois le groupe
 * replié, exactement comme Docker/Railway masquent la plomberie interne d'un service groupé.
 *
 * Règle de correspondance capacité <-> (kind d'arête, membre source ou cible) — copie directe de
 * NODE_CAPABILITIES pour les deux seuls kinds connectables (container/network/volume) :
 *  - arête "mount" (source = volume, target = conteneur) : conteneur membre -> "volume-mount"
 *    (le groupe consomme un volume extérieur) ; volume membre -> "provide" (le groupe fournit un
 *    volume à un conteneur extérieur).
 *  - arête "network" (source = conteneur, target = network) : conteneur membre -> "network" (le
 *    groupe se connecte à un network extérieur) ; network membre -> "attach" (le groupe accueille
 *    un conteneur extérieur).
 */
export function deriveGroupPorts(group: Pick<TopologyGroup, "nodeIds">, edges: TopologyEdge[]): PortSpec[] {
  const memberIds = new Set(group.nodeIds);
  const capabilities = new Set<CapabilityId>();
  for (const edge of edges) {
    const sourceIn = memberIds.has(edge.source);
    const targetIn = memberIds.has(edge.target);
    if (sourceIn === targetIn) continue; // les deux dedans (arête interne) ou les deux dehors (non pertinent ici)
    if (edge.kind === "mount") capabilities.add(targetIn ? "volume-mount" : "provide");
    else if (edge.kind === "network") capabilities.add(sourceIn ? "network" : "attach");
  }
  return Array.from(capabilities).map((capability) => ({ id: capability, capability, ...CAPABILITY_PORT_META[capability] }));
}

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

/**
 * Arête "automation-flow" (trigger -> condition -> action, voir services/automationStore.ts) : ni
 * un mount ni un network, aucun nœud conteneur à l'une de ses deux extrémités (edgeContainerNode
 * ci-dessous retourne toujours `null`) — sans ce cas particulier elle retomberait sur la couleur
 * "none" (gris fade), indiscernable des arêtes "hosts". Couleur fixe volontairement distincte de
 * toutes celles de EDGE_STATE_COLOR ci-dessus ET de MINIMAP_NODE_COLOR (aucune reprise exacte
 * d'une couleur de kind déjà utilisée), cohérente avec .topology-edge--automation-flow dans
 * topology.css.
 */
const AUTOMATION_FLOW_EDGE_COLOR = "#fb923e";

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
 * `sourceHandle`/`targetHandle` optionnels : utilisés par TopologyGraph.tsx quand une arête a été
 * redirigée vers un nœud de groupe replié (voir deriveGroupPorts ci-dessus) — un groupe peut porter
 * PLUSIEURS handles du même côté (ex: "network" ET "provide", tous deux source/Right), l'id du
 * handle cible devient alors nécessaire pour lever l'ambiguïté (React Flow ne peut plus déduire le
 * bon handle tout seul dès qu'il y en a plusieurs du même type sur un nœud).
 */
export function buildTopologyEdges(
  edges: (TopologyEdge & { sourceHandle?: string; targetHandle?: string })[],
  nodesById: Map<string, TopologyNode>,
): Edge[] {
  return edges.map((e) => {
    const containerNode = edgeContainerNode(e, nodesById);
    const stopped = containerNode ? containerNode.status !== "running" : false;
    const state: EdgeHealthState = stopped ? "stopped" : (containerNode?.healthStatus ?? "none");
    // "automation-flow" (voir AUTOMATION_FLOW_EDGE_COLOR ci-dessus) : jamais dérivée de la santé
    // d'un conteneur, toujours sa propre couleur fixe distincte.
    const isAutomationFlowEdge = e.kind === "automation-flow";
    const color = isAutomationFlowEdge ? AUTOMATION_FLOW_EDGE_COLOR : EDGE_STATE_COLOR[state];
    const isMount = e.kind === "mount";
    // "hosts" (cluster Nutanix -> VM, voir services/topology.ts) : relation structurelle statique,
    // pas un flux de trafic — jamais de tirets défilants (contrairement à "network") ni de
    // particules (contrairement à "mount") pour ne pas laisser croire à une activité mesurée.
    const isHostsEdge = e.kind === "hosts";
    // "stopped" prime sur le type : tirets larges et espacés, quel que soit mount/network.
    // Sinon : réseau garde ses tirets fins animés (existant) ; mount reste en trait plein — les
    // particules de MountFlowEdge assurent seules l'impression de flux, un dasharray en plus
    // ferait double emploi visuel. "automation-flow" : tirets plus serrés (2 4), distincts du
    // "4 4" réseau, pour rester reconnaissable au premier coup d'œil.
    const strokeDasharray = isAutomationFlowEdge ? "2 4" : state === "stopped" ? "2 8" : isMount ? undefined : "4 4";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      type: isMount ? "mountFlow" : "networkEdge",
      animated: !isMount && !isHostsEdge,
      className: `topology-edge topology-edge--${e.kind} topology-edge--${state}`,
      style: { stroke: color, ...(strokeDasharray ? { strokeDasharray } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      data: {
        kind: e.kind,
        state,
        color,
        ...(e.ports ? { ports: e.ports } : {}),
        ...(e.private !== undefined ? { private: e.private } : {}),
        ...(e.encrypted !== undefined ? { encrypted: e.encrypted } : {}),
        ...(e.readOnly !== undefined ? { readOnly: e.readOnly } : {}),
      },
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

// --- Badge flottant sur l'arête (façon Railway : "TCP:5432 · Private · Encrypted") -------------
// Toutes les données affichées ici viennent RÉELLEMENT de Docker (voir TopologyEdge#ports/private/
// encrypted/readOnly, services/topology.ts) — aucune latence affichée : QUAI ne sonde jamais
// activement le réseau, ce chiffre serait inventé.

/** "TCP:5432" (premier port), ou "TCP:5432 +2" si le conteneur en publie plusieurs — jamais la
 * liste complète (le badge doit rester un petit pavé lisible, pas un tableau). null si le
 * conteneur ne publie aucun port vers l'hôte (cas le plus courant). */
function formatPortLabel(ports?: TopologyEdgePort[]): string | null {
  if (!ports || ports.length === 0) return null;
  const first = ports[0]!;
  const base = `${first.protocol.toUpperCase()}:${first.privatePort}`;
  return ports.length > 1 ? `${base} +${ports.length - 1}` : base;
}

interface EdgeBadgeData {
  ports?: TopologyEdgePort[];
  private?: boolean;
  encrypted?: boolean;
  readOnly?: boolean;
}

interface EdgeBadgeItem {
  text: string;
  tone: "neutral" | "good" | "warn";
}

function edgeBadgeItems(data: EdgeBadgeData): EdgeBadgeItem[] {
  const items: EdgeBadgeItem[] = [];
  const portLabel = formatPortLabel(data.ports);
  if (portLabel) items.push({ text: portLabel, tone: "neutral" });
  if (data.private !== undefined) items.push({ text: data.private ? "Privé" : "Public", tone: data.private ? "good" : "neutral" });
  if (data.encrypted !== undefined) items.push({ text: data.encrypted ? "Chiffré" : "Non chiffré", tone: data.encrypted ? "good" : "warn" });
  if (data.readOnly !== undefined) items.push({ text: data.readOnly ? "ro" : "rw", tone: "neutral" });
  return items;
}

/** Rendu du badge lui-même — via `EdgeLabelRenderer` (portail React Flow HORS du SVG des arêtes) :
 * seul moyen d'avoir un vrai pavé HTML (bord arrondi, flex, ellipsis) positionné au milieu d'une
 * arête, un `<text>` SVG ne permettrait ni la mise en forme ni le retour à la ligne. Masqué sous
 * ZOOM_DETAIL_THRESHOLD, même seuil que le détail des nœuds (GraphNode) : dézoomé sur toute
 * l'infra, une dizaine de badges superposés au texte devenu illisible ne feraient que noyer le
 * canevas — cohérent avec le reste du "zoom sémantique" du graphe. */
function EdgeBadge({ x, y, data }: { x: number; y: number; data: EdgeBadgeData }) {
  const zoom = useStore(zoomSelector);
  if (zoom < ZOOM_DETAIL_THRESHOLD) return null;
  const items = edgeBadgeItems(data);
  if (items.length === 0) return null;
  return (
    <EdgeLabelRenderer>
      <div className="topology-edge-badge nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
        {items.map((item, index) => (
          <span key={index} className={`topology-edge-badge__item topology-edge-badge__item--${item.tone}`}>
            {item.text}
          </span>
        ))}
      </div>
    </EdgeLabelRenderer>
  );
}

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
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const reducedMotion = usePrefersReducedMotion();
  const edgeData = data as (EdgeBadgeData & { state?: EdgeHealthState; color?: string }) | undefined;
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
      {edgeData && <EdgeBadge x={labelX} y={labelY} data={edgeData} />}
    </>
  );
}

/** Arête "network" (conteneur <-> network) : même tracé/rendu que le type "default" de React Flow
 * (bezier), réimplémenté ici uniquement pour pouvoir y accrocher le badge flottant ci-dessus — le
 * type "default" ne permet pas d'injecter un enfant supplémentaire. */
function NetworkEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const edgeData = data as EdgeBadgeData | undefined;
  return (
    <>
      <BaseEdge id={id} path={edgePath} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      {edgeData && <EdgeBadge x={labelX} y={labelY} data={edgeData} />}
    </>
  );
}

export const edgeTypes = { mountFlow: MountFlowEdge, networkEdge: NetworkEdge };

/** Icône par kind de brique — mêmes icônes que KIND_ICON, sous-ensemble volume/network uniquement
 * (les deux seuls kinds "briquables", voir TopologyNode#attachments). */
const ATTACHMENT_ICON: Record<TopologyNodeAttachment["kind"], (props: { className?: string }) => JSX.Element> = {
  volume: IconVolumes,
  network: IconNetworks,
};

/**
 * Callbacks optionnels posés sur `node.data` par TopologyGraph.tsx/TopologySubGraphPanel.tsx lors
 * de la construction des `flowNodes` (jamais persistés — de simples fonctions en mémoire, le reste
 * de `data` reste le TopologyNode sérialisable tel que renvoyé par GET /api/topology) : GraphNode
 * est un composant partagé sans accès direct à Redux/au state du panneau parent, ces callbacks sont
 * donc le seul moyen pour une "brique" (volume/network à conteneur unique, rendue ICI plutôt que
 * comme un nœud séparé) de rester cliquable/clic-droit-able exactement comme un vrai nœud.
 */
export interface GraphNodeCallbacks {
  onOpenAttachment?: (attachment: TopologyNodeAttachment) => void;
  onAttachmentContextMenu?: (event: React.MouseEvent, attachment: TopologyNodeAttachment) => void;
}

/** Reconstruit un TopologyNode "synthétique" pour une brique (voir TopologyNode#attachments) —
 * une brique n'a PAS de nœud top-level correspondant dans `topology.nodes` (c'est tout l'objet de
 * son "briquage") : ouvrir son détail nécessite donc de reconstituer un TopologyNode minimal mais
 * suffisant (id/kind/label/subtitle attendus par TopologyNodeDetailPanel.tsx pour aller chercher
 * le VRAI détail complet via GET /api/volumes ou GET /api/networks, comme pour un nœud normal).
 * `status: "running"` : même convention que les vrais nœuds volume/network (services/topology.ts),
 * ces ressources n'ont pas d'état "arrêté" propre. */
export function attachmentToTopologyNode(attachment: TopologyNodeAttachment): TopologyNode {
  return { id: attachment.id, kind: attachment.kind, label: attachment.label, subtitle: attachment.subtitle, status: "running" };
}

/** `attachments` (voir TopologyNode#attachments) compte comme égal entre deux rendus si chaque
 * brique affichée (id/label/subtitle/destination/readOnly — les seuls champs rendus par
 * GraphNode) est identique, même si le tableau lui-même a été recréé par le parent. */
function attachmentsEqual(a: TopologyNodeAttachment[] | undefined, b: TopologyNodeAttachment[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((att, index) => {
    const other = b[index];
    return (
      !!other &&
      att.id === other.id &&
      att.label === other.label &&
      att.subtitle === other.subtitle &&
      att.destination === other.destination &&
      att.readOnly === other.readOnly
    );
  });
}

/** `domains` (voir TopologyNode#domains) — même principe que attachmentsEqual ci-dessus, simple
 * tableau de chaînes ici. */
function domainsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((domain, index) => domain === b[index]);
}

/**
 * Comparateur `React.memo` de GraphNode — voir docs/reports/optimization-audit-2026-08-12.md §É9 :
 * `data` est reconstruit avec une NOUVELLE référence à chaque poll réussi de la topologie
 * (TopologyGraph.tsx#flowNodes, `data: {...n, ...callbacks}`), y compris quand aucun champ
 * réellement affiché n'a changé — un `React.memo` par défaut (comparaison par référence) serait
 * donc inefficace pour ce cas précis. On compare ici directement les champs que GraphNode rend
 * VRAIMENT (voir le corps du composant plus bas) plutôt que la référence de `data` : les
 * callbacks (`onOpenAttachment`/`onAttachmentContextMenu`) sont volontairement IGNORÉS de cette
 * comparaison — ils sont recréés à chaque render côté parent mais ferment uniquement sur des
 * arguments passés à l'appel (jamais sur un état de rendu figé) et sur des setters React (stables
 * par nature), donc réutiliser l'ancienne fermeture le temps qu'un vrai champ affiché change ne
 * change aucun comportement observable. `selected` (posé par React Flow à côté de `data`, pas
 * dedans) reste comparé en premier : c'est lui qui doit encore déclencher le re-render des 1-2
 * nœuds concernés par un clic de sélection.
 */
function graphNodePropsEqual(prev: NodeProps, next: NodeProps): boolean {
  if (prev.selected !== next.selected) return false;
  if (prev.data === next.data) return true;
  const a = prev.data as unknown as TopologyNode;
  const b = next.data as unknown as TopologyNode;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.subtitle === b.subtitle &&
    a.status === b.status &&
    a.updateAvailable === b.updateAvailable &&
    a.drift === b.drift &&
    a.vulnCritical === b.vulnCritical &&
    a.vulnHigh === b.vulnHigh &&
    a.healthStatus === b.healthStatus &&
    a.cpuPercent === b.cpuPercent &&
    a.memBytes === b.memBytes &&
    attachmentsEqual(a.attachments, b.attachments) &&
    domainsEqual(a.domains, b.domains)
  );
}

function GraphNodeImpl({ data, selected }: NodeProps) {
  const node = data as unknown as TopologyNode & GraphNodeCallbacks;
  const Icon = KIND_ICON[node.kind];
  const isContainer = node.kind === "container";
  const ports = NODE_CAPABILITIES[node.kind];
  // Nœuds d'automatisation (voir NODE_CAPABILITIES ci-dessus pour le pourquoi de leur entrée []) :
  // Handles génériques posés directement ici plutôt que via la table de ports typés réseau/volume —
  // un trigger n'est jamais une cible (toujours la racine d'une chaîne), une action n'est jamais
  // une source (toujours une feuille, voir isValidConnection côté routes/automation.ts), une
  // condition a les deux. classifyConnection (TopologyGraph.tsx) ne lit jamais ces ids de Handle
  // (aucune entrée NODE_CAPABILITIES correspondante) : la validation/le POST réel d'une connexion
  // entre deux nœuds d'automatisation passe par un chemin dédié dans handleConnect, qui ne se fie
  // qu'au kind des deux nœuds visés, jamais à l'id du Handle glissé.
  const isAutomationTrigger = node.kind === "automation-trigger";
  const isAutomationCondition = node.kind === "automation-condition";
  const isAutomationAction = node.kind === "automation-action";
  const isAutomationNode = isAutomationTrigger || isAutomationCondition || isAutomationAction;
  // Zoom sémantique : en dessous du seuil, on masque libellé/badges/métriques et on ne garde que
  // l'icône + le point de statut — évite un canevas illisible une fois dézoomé sur toute l'infra.
  const zoom = useStore(zoomSelector);
  const isCompact = zoom < ZOOM_DETAIL_THRESHOLD;
  return (
    <div
      className={`topology-node topology-node--${node.kind} topology-node--${node.status}${node.orphan ? " topology-node--orphan" : ""}${selected ? " is-selected" : ""}${isCompact ? " topology-node--compact" : ""}`}
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
      {isAutomationNode && !isAutomationAction && (
        <Handle
          id="automation-out"
          type="source"
          position={Position.Right}
          className="topology-handle topology-handle--automation"
          title="Relier vers une condition/action"
        />
      )}
      {isAutomationNode && !isAutomationTrigger && (
        <Handle
          id="automation-in"
          type="target"
          position={Position.Left}
          className="topology-handle topology-handle--automation"
          title="Relié depuis un déclencheur/une condition"
        />
      )}
      <div className="topology-node__head">
        <span className="topology-node__icon">
          <Icon />
        </span>
        <span className="topology-node__label">{node.label}</span>
      </div>
      {node.orphan && (
        <div className="topology-node__badges">
          <span
            className="topology-badge topology-badge--warning"
            title="Aucun conteneur ne référence cette ressource actuellement — jamais supprimée automatiquement"
          >
            Orphelin
          </span>
        </div>
      )}
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
      {isContainer && !!node.domains?.length && (
        // Domaine(s) de reverse proxy réellement associés à ce conteneur (voir TopologyNode#domains,
        // rapproché par targetContainerId côté services/topology.ts) — affiché directement sous le
        // nom du service façon Railway, cliquable vers l'URL réelle. `nodrag`/`nopan` + `stopPropagation`
        // : même raison que les briques ci-dessous (ne pas faire glisser le nœud / le sélectionner
        // en cliquant sur le lien).
        <div className="topology-node__domains">
          {node.domains.map((domain) => (
            <a
              key={domain}
              href={domain}
              target="_blank"
              rel="noreferrer"
              className="topology-node__domain nodrag nopan"
              title={`Ouvrir ${domain}`}
              onClick={(event) => event.stopPropagation()}
            >
              <IconGlobe className="topology-node__domain-icon" />
              <span className="topology-node__domain-label">{domain.replace(/^https?:\/\//, "")}</span>
            </a>
          ))}
        </div>
      )}
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
      {isContainer && !!node.attachments?.length && (
        // "Briques" (volumes/networks montés par CE seul conteneur, voir TopologyNode#attachments)
        // — façon Railway : une ressource attachée à un service s'affiche comme une propriété du
        // service, pas comme un nœud séparé relié par une arête. `nodrag`/`nopan` (classes React
        // Flow) évitent qu'un clic ici ne fasse glisser le nœud entier ou ne panne le canevas ;
        // `stopPropagation` évite en plus de sélectionner/désélectionner le nœud conteneur en même
        // temps qu'on ouvre le détail de la brique.
        <div className="topology-node__attachments">
          {node.attachments.map((attachment) => {
            const AttachmentIcon = ATTACHMENT_ICON[attachment.kind];
            return (
              <button
                key={attachment.id}
                type="button"
                className={`topology-brick topology-brick--${attachment.kind} nodrag nopan`}
                title={`${attachment.kind === "volume" ? "Volume" : "Network"} ${attachment.label}${
                  attachment.destination ? ` — monté sur ${attachment.destination}` : ""
                }${attachment.readOnly ? " (lecture seule)" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  node.onOpenAttachment?.(attachment);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  node.onAttachmentContextMenu?.(event, attachment);
                }}
              >
                <span className="topology-brick__icon">
                  <AttachmentIcon />
                </span>
                <span className="topology-brick__label">{attachment.label}</span>
                {attachment.readOnly && <span className="topology-brick__ro">ro</span>}
              </button>
            );
          })}
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
                ? node.orphan
                  ? "Inutilisé"
                  : "Indéterminé"
                : node.status}
        </span>
      </div>
    </div>
  );
}

/** Voir graphNodePropsEqual ci-dessus — élimine le re-render des nœuds non affectés par un clic
 * de sélection ou par un poll dont les champs affichés n'ont pas bougé (docs/reports/
 * optimization-audit-2026-08-12.md §É9). */
export const GraphNode = memo(GraphNodeImpl, graphNodePropsEqual);

// --- Regroupement de nœuds ("encapsulation façon Railway/Logisim", voir TopologyGroup) --------
// Sélection multiple + "Regrouper" (TopologyGraph.tsx) -> carte parente repliable/dépliable :
//  - repliée (par défaut à la création) : UN SEUL nœud comme les autres, ports dérivés
//    (deriveGroupPorts ci-dessus) connectables au reste du graphe exactement comme un vrai nœud.
//  - dépliée : les nœuds membres restent affichés à leurs positions normales (inchangées, mêmes
//    arêtes internes/externes que d'habitude) ; GroupFrameNode ci-dessous n'est qu'un CADRE
//    décoratif non connectable/non sélectionnable rendu derrière eux (zIndex négatif) pour les
//    faire lire visuellement comme "contenus" dans le groupe, sans réimplémenter le système de
//    parenting natif de React Flow (positions relatives complexes) pour ce premier lot.

export interface GroupNodeData {
  group: TopologyGroup;
  ports: PortSpec[];
  onToggleCollapse?: () => void;
}

/** Carte repliée d'un groupe — un seul nœud, comme un vrai TopologyNode, avec ses ports dérivés. */
function GroupNodeImpl({ data, selected }: NodeProps) {
  const { group, ports, onToggleCollapse } = data as unknown as GroupNodeData;
  return (
    <div className={`topology-node topology-group-node${selected ? " is-selected" : ""}`}>
      {ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.handleType}
          position={port.position}
          className={`topology-handle topology-handle--${port.colorToken}`}
          title={port.label}
        />
      ))}
      <div className="topology-node__head">
        <span className="topology-node__icon topology-group-node__icon">
          <IconFolder />
        </span>
        <span className="topology-node__label">{group.label}</span>
        <button
          type="button"
          className="topology-group-node__toggle nodrag nopan"
          title="Déplier le groupe"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse?.();
          }}
        >
          <IconChevron className="topology-group-node__chevron topology-group-node__chevron--collapsed" />
        </button>
      </div>
      <div className="topology-node__subtitle">
        {group.nodeIds.length} élément{group.nodeIds.length > 1 ? "s" : ""} regroupé{group.nodeIds.length > 1 ? "s" : ""}
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);

export interface GroupFrameNodeData {
  group: TopologyGroup;
  onToggleCollapse?: () => void;
}

/** Cadre décoratif derrière les membres d'un groupe DÉPLIÉ — non connectable/non sélectionnable
 * (voir nodesConnectable/nodesDraggable posés sur ce node précis par TopologyGraph.tsx), aucun
 * Handle : ce n'est pas une ressource, juste un repère visuel + un en-tête pour replier le groupe. */
function GroupFrameNodeImpl({ data }: NodeProps) {
  const { group, onToggleCollapse } = data as unknown as GroupFrameNodeData;
  return (
    <div className="topology-group-frame">
      <div className="topology-group-frame__header nodrag nopan">
        <span className="topology-group-frame__icon">
          <IconFolder />
        </span>
        <span className="topology-group-frame__label">{group.label}</span>
        <span className="topology-group-frame__count">
          {group.nodeIds.length} élément{group.nodeIds.length > 1 ? "s" : ""}
        </span>
        <button
          type="button"
          className="topology-group-node__toggle"
          title="Replier le groupe"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse?.();
          }}
        >
          <IconChevron className="topology-group-node__chevron topology-group-node__chevron--expanded" />
        </button>
      </div>
    </div>
  );
}

export const GroupFrameNode = memo(GroupFrameNodeImpl);

/**
 * Rayon (px) du cercle de nœuds voisins autour d'un nœud racine — disposition "hub and spoke",
 * réutilisée par TopologySubGraphPanel.tsx pour le sous-graphe de dépendances ET la vue
 * "composition interne" (processus réels autour du nœud conteneur).
 */
const RADIAL_RADIUS = 260;

export function radialPositions(rootId: string, satelliteIds: string[], radius = RADIAL_RADIUS): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = { [rootId]: { x: 0, y: 0 } };
  const count = satelliteIds.length;
  satelliteIds.forEach((id, index) => {
    const angle = (index / Math.max(count, 1)) * 2 * Math.PI - Math.PI / 2;
    positions[id] = { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
  });
  return positions;
}

export const nodeTypes = { graphNode: GraphNode, topologyGroupNode: GroupNode, topologyGroupFrame: GroupFrameNode };

/**
 * Un processus RÉEL du conteneur (`docker top`, voir TopologySubGraphPanel.tsx "composition
 * interne") — nœud délibérément minimal (PID/utilisateur/commande, les seules colonnes qu'on
 * peut identifier avec confiance dans une sortie `ps` dont les colonnes varient selon l'image),
 * jamais cliquable/connectable : ce n'est pas une ressource QUAI, juste une donnée d'observation.
 */
export interface ProcessNodeData {
  pid: string;
  user: string;
  command: string;
}

export function ProcessNode({ data }: NodeProps) {
  const p = data as unknown as ProcessNodeData;
  return (
    <div className="topology-process-node" title={p.command}>
      <div className="topology-process-node__pid">PID {p.pid}</div>
      <div className="topology-process-node__user">{p.user}</div>
      <div className="topology-process-node__command">{p.command || "—"}</div>
    </div>
  );
}

export const interiorNodeTypes = { graphNode: GraphNode, processNode: ProcessNode };

/** Ferme un popover au clic en dehors ou à Échap — même pattern que ContextMenu/Topbar. Partagé
 * par les popovers de création/renommage du graphe principal et par tout futur usage similaire. */
/**
 * Position d'un popover ancré à un point de clic (x, y) TOUJOURS entièrement visible dans le
 * viewport — bascule vers le haut/la gauche quand il n'y a pas la place en dessous/à droite
 * (jamais un simple `Math.min` qui couperait quand même le popover, juste déplacé de l'autre
 * côté). Suit la taille RÉELLE du contenu via ResizeObserver plutôt qu'une hauteur estimée à
 * l'avance : un popover dont le contenu change après le premier rendu (recherche filtrée dans
 * CreateSpotlight, formulaire qui affiche un champ de plus, message d'erreur qui apparaît...)
 * reste entièrement visible à tout moment, pas seulement à l'ouverture — voir capture d'écran
 * utilisateur du 13/08/2026 : la palette de création dépassait en bas de l'écran, rendant les
 * dernières options (et le bouton de soumission des mini-formulaires) inatteignables.
 */
function useClampedPosition(ref: RefObject<HTMLElement>, x: number, y: number): CSSProperties {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  const margin = 12;
  if (!size) return { left: x, top: y };
  const left = x + size.width + margin > window.innerWidth ? Math.max(margin, x - size.width) : x;
  const top = y + size.height + margin > window.innerHeight ? Math.max(margin, y - size.height) : y;
  return { left, top };
}

export function useDismiss(onClose: () => void, x: number, y: number): { ref: RefObject<HTMLDivElement>; style: CSSProperties } {
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
  const style = useClampedPosition(ref, x, y);
  return { ref, style };
}
