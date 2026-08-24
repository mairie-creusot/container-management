import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
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
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { IconBell, IconChevron, IconClose, IconFolder, IconGlobe, IconNetworks, IconPlay, IconPlus, IconRestart, IconStop, IconVolumes } from "@/components/icons";
import {
  CAPABILITY_DEFS,
  CAPABILITY_PORT_META,
  KIND_ICON,
  NODE_CONTRACT,
  hycuProtectionBadge,
  nodeIcon,
  quickLifecycleActions,
  serviceModuleBadge,
  type AutomationTriggerStatus,
  type CapabilityId,
  type EdgeHealthInfo,
  type EdgeHealthState,
  type NodeServiceModuleBinding,
  type PortSpec,
  type QuickLifecycleAction,
} from "@/components/topologyNodeContract";
import type { ImageTemplate, TemplateStep, TopologyEdge, TopologyGroup, TopologyNode, TopologyNodeAttachment } from "@/types";
import type { LifecycleAction } from "@/features/containers/containersSlice";
// Logique PURE de recette réutilisée telle quelle (libellés/résumés du studio — jamais dupliqués).
import { STEP_TYPE_LABEL, stepSummary, templateBaseLabel } from "@/features/templates/templateCatalog";

/**
 * Registre déclaratif des kinds (17/08/2026) : TOUT ce qui est spécifique à un `kind` de nœud
 * (icône, couleur MiniMap, ports/Handles, santé d'arête, seuils d'alertes de ressources, actions
 * du menu contextuel, colonne par défaut) vit désormais dans topologyNodeContract.tsx#NODE_CONTRACT
 * — ce fichier n'est plus que le MOTEUR DE RENDU générique qui le consomme (GraphNode,
 * buildTopologyEdges, computeNodeResourceAlerts...), sans plus aucun `if (kind === ...)` de
 * plateforme. Ré-exports ci-dessous : compatibilité d'import pour les consommateurs historiques
 * (TopologyGraph.tsx, TopologySubGraphPanel.tsx, TopologyNodeDetailPanel.tsx,
 * topologyGraphShared.test.ts) — mêmes noms publics qu'avant la migration, un seul déménagement de
 * source de vérité, pas une cascade de changements d'imports dans la même passe.
 */
export {
  CAPABILITY_DEFS,
  CPU_ALERT_THRESHOLD_PERCENT,
  HOST_KIND_CONTRACT,
  KIND_ICON,
  MEMORY_ALERT_RATIO,
  MINIMAP_NODE_COLOR,
  NODE_CONTRACT,
  nodeIcon,
  nodeMinimapColor,
  nutanixVmHostEdgeState,
  hycuProtectionEdgeState,
  serviceModuleBadge,
  type CapabilityDef,
  type CapabilityId,
  type EdgeHealthState,
  type NodeServiceModuleBinding,
  type PortSpec,
} from "@/components/topologyNodeContract";

/**
 * Éléments du graphe de topologie partagés entre le graphe principal (TopologyGraph.tsx) et le
 * panneau de sous-graphe ouvert au double-clic (TopologySubGraphPanel.tsx) — extraits ici pour
 * que les deux rendus aient EXACTEMENT le même look (mêmes nœuds, mêmes arêtes, mêmes couleurs),
 * sans dupliquer le JSX/CSS. Voir ARCHITECTURE.md § "Graphe de topologie" pour le contexte complet.
 */

/** "2026-08-18T02:00:00Z" -> "18/08/26" — chip compacte de carte (l'horodatage complet reste dans
 * l'attribut title, jamais tronqué sans recours). */
function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** "container:abcd1234" -> "abcd1234" (l'id du nœud préfixe toujours son type). */
export function idWithoutPrefix(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

export function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

/** Libellés d'action conteneur (start/stop/restart/remove) — source UNIQUE partagée entre
 * TopologyGraph.tsx (menu contextuel du graphe principal) et TopologySubGraphPanel.tsx (menu
 * contextuel du sous-graphe, retour utilisateur du 13/08/2026 : "le clic droit n'est pas sur le
 * node il manque supprimer ou autre element aussi" — les mêmes actions doivent être accessibles
 * aux DEUX endroits, jamais une liste dupliquée qui pourrait diverger). */
export const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  remove: "Supprimer",
};

/**
 * Écarte visuellement plusieurs Handles qui partageraient le même `position` sur un même nœud (ex
 * un groupe replié avec à la fois un port "provide" ET un port "hosts", tous deux Position.Right
 * — voir deriveGroupPorts ci-dessus) : React Flow centre par défaut TOUS les handles d'un même
 * côté au même endroit (`top: 50%` pour Left/Right, `left: 50%` pour Top/Bottom) sans répartition
 * explicite, les rendant visuellement superposés et impossibles à distinguer/cliquer séparément —
 * bug constaté en conditions réelles le 13/08/2026 sur un groupe à ports multiples. Un seul port
 * sur ce côté garde le centrage par défaut (retourne `undefined`, aucun style forcé).
 */
function portOffsetStyle(port: PortSpec, allPorts: PortSpec[]): CSSProperties | undefined {
  const sameSide = allPorts.filter((p) => p.position === port.position);
  if (sameSide.length <= 1) return undefined;
  const index = sameSide.findIndex((p) => p.id === port.id);
  const percent = 25 + (index * 50) / (sameSide.length - 1);
  const isVertical = port.position === Position.Left || port.position === Position.Right;
  return isVertical ? { top: `${percent}%` } : { left: `${percent}%` };
}

/**
 * Déplie récursivement `nodeIds` (membres directs d'un groupe) jusqu'aux vrais ids de TopologyNode
 * — jamais un id de groupe dans le résultat (groupes imbriqués, 13/08/2026, voir
 * apps/api/src/types.ts#TopologyGroup#nodeIds) : un membre qui est lui-même l'id d'un AUTRE
 * TopologyGroup de `allGroups` est déplié à son tour, récursivement, jusqu'à n'obtenir que des ids
 * de vrais nœuds. Même garde anti-boucle infinie que côté serveur
 * (topologyGroupsStore.ts#resolveRealNodeIds) même si un cycle existait déjà par erreur — jamais
 * censé arriver en usage normal (la création refuse déjà tout cycle côté API).
 */
export function resolveGroupMemberNodeIds(nodeIds: string[], allGroups: TopologyGroup[], visited: Set<string> = new Set()): string[] {
  const groupsById = new Map(allGroups.map((g) => [g.id, g]));
  const result: string[] = [];
  for (const id of nodeIds) {
    const subGroup = groupsById.get(id);
    if (!subGroup) {
      result.push(id); // vrai TopologyNode
      continue;
    }
    if (visited.has(subGroup.id)) continue; // cycle corrompu : jamais censé arriver, on n'y revient simplement pas
    result.push(...resolveGroupMemberNodeIds(subGroup.nodeIds, allGroups, new Set(visited).add(subGroup.id)));
  }
  return result;
}

/**
 * Ports d'entrée/sortie d'un groupe (voir TopologyGroup, apps/api/src/types.ts) — DÉRIVÉS des
 * arêtes réelles du graphe complet qui traversent sa frontière (un membre du groupe d'un côté, un
 * nœud extérieur de l'autre), jamais inventés/devinés : un groupe qui ne contient que des nœuds
 * sans aucune connexion externe n'a simplement aucun port. Une arête ENTIÈREMENT interne au groupe
 * (les deux bouts sont membres) ne produit aucun port — elle reste invisible une fois le groupe
 * replié, exactement comme Docker/Railway masquent la plomberie interne d'un service groupé.
 * `allGroups` (groupes imbriqués, 13/08/2026) : sert à résoudre récursivement (voir
 * resolveGroupMemberNodeIds ci-dessus) les vrais ids de nœuds membres à travers tout sous-groupe
 * imbriqué — sans ça un groupe contenant un sous-groupe n'aurait aucun port dérivé pour les arêtes
 * de ce sous-groupe (ses membres directs seraient des ids de groupe, jamais présents comme source/
 * target d'une vraie TopologyEdge).
 *
 * Règle de correspondance capacité <-> (kind d'arête, membre source ou cible) — copie directe de
 * NODE_CONTRACT[kind].ports (topologyNodeContract.tsx) pour les kinds connectables (container/
 * volume), plus "hosts" (source = nœud host, ex: docker-local ; target = conteneur — voir
 * services/topology.ts) qui n'a lui aucun port propre (jamais glissé à la main) mais reste réel et doit rester VISIBLE une
 * fois le groupe replié plutôt que silencieusement masqué :
 *  - arête "mount" (source = volume, target = conteneur) : conteneur membre -> "volume-mount"
 *    (le groupe consomme un volume extérieur) ; volume membre -> "provide" (le groupe fournit un
 *    volume à un conteneur extérieur).
 *  - arête "hosts" : conteneur membre (toujours target) -> "hosted-by" (le groupe est hébergé par
 *    un nœud host extérieur, ex: docker-local) — jamais l'inverse dans ce premier lot (grouper un
 *    nœud "host" lui-même avec d'autres nœuds n'est pas un cas réel supporté ici).
 */
export function deriveGroupPorts(group: Pick<TopologyGroup, "nodeIds">, edges: TopologyEdge[], allGroups: TopologyGroup[]): PortSpec[] {
  const memberIds = new Set(resolveGroupMemberNodeIds(group.nodeIds, allGroups));
  const capabilities = new Set<CapabilityId>();
  for (const edge of edges) {
    const sourceIn = memberIds.has(edge.source);
    const targetIn = memberIds.has(edge.target);
    if (sourceIn === targetIn) continue; // les deux dedans (arête interne) ou les deux dehors (non pertinent ici)
    if (edge.kind === "mount") capabilities.add(targetIn ? "volume-mount" : "provide");
    else if (edge.kind === "hosts" && targetIn) capabilities.add("hosted-by");
    // Sauvegarde HYCU : un groupe replié contenant une VM protégée (ou l'appliance) garde un port
    // réel — sans lui, l'arête redirigée vers le groupe n'aurait aucun ancrage et disparaîtrait.
    else if (edge.kind === "protects") capabilities.add(targetIn ? "protected-by" : "protection-out");
  }
  return Array.from(capabilities).map((capability) => ({ id: capability, capability, ...CAPABILITY_PORT_META[capability] }));
}

/** Une alerte de ressource RÉELLE détectée pour un nœud précis — `key` distingue CPU/mémoire quand
 * les deux sont dépassées simultanément sur le même nœud (voir computeNodeResourceAlerts). */
export interface NodeResourceAlert {
  key: "cpu" | "memory";
  title: string;
  message: string;
}

/**
 * Détecte les alertes de ressource (CPU/mémoire) RÉELLES d'un nœud — fonction PURE, moteur
 * GÉNÉRIQUE des seuils désormais déclarés PAR KIND dans le contrat (NODE_CONTRACT[kind].
 * resourceAlerts, topologyNodeContract.tsx — seul "container" en déclare aujourd'hui, les kinds
 * sans métriques live déclarent explicitement `null` et retournent [] ici, jamais un
 * `if kind === "container"` implicite qui oublierait la prochaine plateforme à métriques).
 * Appelée par TopologyAlertStack ci-dessous (pile fixe haut-droite, TopologyGraph.tsx) pour
 * construire la liste d'alertes à travers TOUS les nœuds du graphe. Extraite ici (retour
 * utilisateur du 17/08/2026, capture d'écran à l'appui : "ce genre alert devrais aparaitre en haut
 * a droite" — l'ancien rendu, ANCRÉ à chaque nœud individuellement dans le canevas, restait
 * invisible dès que l'utilisateur n'était pas en train de regarder/zoomer exactement sur ce nœud
 * précis) précisément pour que la logique de seuil ne puisse plus JAMAIS diverger entre deux
 * emplacements de rendu : un seul calcul, réutilisé partout où une alerte doit être affichée.
 * Seuils RÉELS sur node.cpuPercent/memBytes (déjà calculés server-side, docker.ts#
 * readContainerUsage), jamais sur une ressource arrêtée. L'alerte mémoire ne se déclenche QUE
 * quand `memoryLimitBytes` existe réellement — jamais un seuil absolu inventé en son absence
 * (voir MEMORY_ALERT_RATIO, topologyNodeContract.tsx).
 */
export function computeNodeResourceAlerts(node: TopologyNode): NodeResourceAlert[] {
  const spec = NODE_CONTRACT[node.kind].resourceAlerts;
  if (!spec) return [];
  const hasCpuAlert =
    node.status === "running" && typeof node.cpuPercent === "number" && node.cpuPercent > spec.cpuThresholdPercent;
  const hasMemoryAlert =
    node.status === "running" &&
    typeof node.memBytes === "number" &&
    typeof node.memoryLimitBytes === "number" &&
    node.memoryLimitBytes > 0 &&
    node.memBytes / node.memoryLimitBytes > spec.memoryRatio;
  return [
    ...(hasCpuAlert
      ? [
          {
            key: "cpu" as const,
            title: "CPU élevé",
            message: `« ${node.label} » utilise ${node.cpuPercent!.toFixed(0)}% de CPU — risque de ralentissement ou d'arrêt.`,
          },
        ]
      : []),
    ...(hasMemoryAlert
      ? [
          {
            key: "memory" as const,
            title: "Mémoire élevée",
            message: `« ${node.label} » utilise ${formatMem(node.memBytes!)} sur ${formatMem(node.memoryLimitBytes!)} configurés (${Math.round((node.memBytes! / node.memoryLimitBytes!) * 100)}%) — risque d'arrêt (OOM kill).`,
          },
        ]
      : []),
  ];
}

export interface TopologyAlertStackProps {
  /** TOUS les nœuds du graphe (TopologyGraph.tsx#data.nodes) — pas seulement ceux actuellement
   * visibles/dépliés à l'écran : une alerte doit rester découvrable même si le nœud concerné est
   * replié dans un groupe ou hors de la zone de zoom actuelle. */
  nodes: TopologyNode[];
  /** Ouvre le panneau de détail du nœud concerné sur l'onglet "Métriques" (même callback que
   * l'ancien "Voir les métriques" ancré-au-nœud, voir TopologyGraph.tsx#openNodeDetail). */
  onViewMetrics: (node: TopologyNode) => void;
  /** Redémarre le conteneur concerné — MÊME chemin réel (runContainerAction) que "Redémarrer" du
   * menu contextuel du nœud, avec confirmation posée par l'appelant (voir TopologyGraph.tsx#
   * handleCpuAlertRestart). */
  onRestart: (node: TopologyNode) => void;
}

/**
 * Pile FIXE (indépendante du pan/zoom du graphe, `position: fixed` — voir topology.css#
 * .topology-alert-stack) en haut à droite de l'écran, listant TOUTES les alertes CPU/mémoire
 * actives à travers TOUS les nœuds du graphe — REMPLACE l'ancien rendu qui ancrait chaque carte
 * d'alerte individuellement au-dessus du nœud concerné dans le canevas (`.topology-node-alert-stack`,
 * retiré de GraphNodeImpl ci-dessous, voir son historique dans le commentaire resté sur
 * CPU_ALERT_THRESHOLD_PERCENT/MEMORY_ALERT_RATIO). Recalculée à CHAQUE rendu depuis `nodes` via
 * computeNodeResourceAlerts ci-dessus (même fonction pure, jamais dupliquée) : une carte disparaît
 * donc automatiquement dès que le nœud concerné repasse sous le seuil au prochain rafraîchissement
 * de la topologie (REFRESH_INTERVAL_MS, TopologyGraph.tsx) — aucun état à nettoyer explicitement
 * ici, la pile n'est jamais qu'une simple projection de `nodes` à l'instant présent. Réutilise TEL
 * QUEL le style visuel existant (`.topology-node-cpu-alert` et ses sous-classes) — seul le
 * conteneur change (`.topology-alert-stack`, `position: fixed` plutôt qu'absolute-ancré-au-nœud).
 */
export function TopologyAlertStack({ nodes, onViewMetrics, onRestart }: TopologyAlertStackProps) {
  const alerts = nodes.flatMap((node) => computeNodeResourceAlerts(node).map((alert) => ({ node, ...alert })));
  if (alerts.length === 0) return null;
  return (
    <div className="topology-alert-stack" role="region" aria-label="Alertes de ressources">
      {alerts.map(({ node, key, title, message }) => (
        <div key={`${node.id}:${key}`} className="topology-node-cpu-alert">
          <div className="topology-node-cpu-alert__head">
            <IconBell className="topology-node-cpu-alert__icon" />
            <span className="topology-node-cpu-alert__title">{title}</span>
          </div>
          <p className="topology-node-cpu-alert__message">{message}</p>
          <div className="topology-node-cpu-alert__actions">
            <button type="button" className="topology-node-cpu-alert__btn" onClick={() => onViewMetrics(node)}>
              Voir les métriques
            </button>
            <button
              type="button"
              className="topology-node-cpu-alert__btn topology-node-cpu-alert__btn--danger"
              onClick={() => onRestart(node)}
            >
              Redémarrer
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Zoom sémantique : sous ce niveau, un nœud n'affiche plus que son icône et son point de statut. */
export const ZOOM_DETAIL_THRESHOLD = 0.6;
/** state.transform du store React Flow est [x, y, zoom] ; ne resélectionne que le zoom pour éviter
 * un re-render de chaque nœud à chaque pan. */
export const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

// --- Couleur des arêtes selon la santé réelle de la ressource qu'elles touchent ------------------
// Une arête ne porte aucune donnée de santé propre (voir services/topology.ts côté API) : c'est le
// CONTRAT du nœud "pertinent" à l'une de ses extrémités qui fournit couleur/pointillé
// (NODE_CONTRACT[kind].edgeHealth, topologyNodeContract.tsx — conteneur, VM Nutanix, source
// d'automatisation... chacun une implémentation de la MÊME interface, projetée sur la MÊME palette
// ci-dessous, jamais un système de couleurs parallèle par plateforme). buildTopologyEdges
// (ci-dessous) n'est plus qu'un moteur générique : il interroge source puis cible, sans plus aucun
// `if (kind === ...)` de plateforme — le pourquoi de chaque grille (conteneur "stopped" prime sur
// healthStatus, Nutanix placement confirmé/incertain, propagation de statut de déclencheur) est
// documenté SUR le contrat du kind concerné, à côté de la donnée qu'il lit.
export const EDGE_STATE_COLOR: Record<EdgeHealthState, string> = {
  healthy: "var(--color-success)",
  unhealthy: "var(--color-critical)",
  starting: "var(--color-warning)",
  none: "var(--color-text-faint)",
  // Rouge (choix utilisateur explicite : "une machine éteinte doit être rouge, pas grise") — le
  // pointillé large 2 8 distingue toujours "éteinte" (rouge pointillé) de "en panne" (rouge plein).
  stopped: "var(--color-critical)",
};

export interface TopologyEdgeLike {
  source: string;
  target: string;
}

// Capacité attendue à chaque bout d'une arête selon son kind — permet d'ancrer chaque arête sur le
// port EXACT du contrat (un nœud peut porter plusieurs Handles du même type, ex : conteneur
// volume-mount + hosted-by, React Flow ne peut plus deviner seul).
const EDGE_KIND_PORT_CAPABILITY: Record<TopologyEdge["kind"], { source: CapabilityId; target: CapabilityId }> = {
  mount: { source: "provide", target: "volume-mount" },
  hosts: { source: "hosts", target: "hosted-by" },
  "automation-flow": { source: "automation-out", target: "automation-in" },
  "uses-artifact": { source: "artifact-out", target: "artifact-in" },
  protects: { source: "protection-out", target: "protected-by" },
};

function portIdForCapability(node: TopologyNode | undefined, capability: CapabilityId): string | undefined {
  if (!node) return undefined;
  return NODE_CONTRACT[node.kind].ports.find((p) => p.capability === capability)?.id;
}

/**
 * Construit les arêtes React Flow (couleur/état/animation) depuis les TopologyEdge bruts — logique
 * partagée par le graphe principal ET le sous-graphe de dépendances, pour un rendu identique.
 * `sourceHandle`/`targetHandle` optionnels : utilisés par TopologyGraph.tsx quand une arête a été
 * redirigée vers un nœud de groupe replié (voir deriveGroupPorts ci-dessus) — un groupe peut porter
 * PLUSIEURS handles du même côté (ex: "provide" ET "hosts", tous deux source/Right), l'id du
 * handle cible devient alors nécessaire pour lever l'ambiguïté (React Flow ne peut plus déduire le
 * bon handle tout seul dès qu'il y en a plusieurs du même type sur un nœud).
 *
 * Deux axes visuels INDÉPENDANTS, chacun porteur d'une information réelle distincte (revu le
 * 13/08/2026 suite à un retour utilisateur — l'ancien système faisait porter au pointillé
 * essentiellement la même information que la couleur) :
 *  - COULEUR = santé/état réel de la ressource à une extrémité — jamais un axe de type de relation.
 *  - POINTILLÉ = confiance de connectivité RÉELLE, jamais une simple redite de la couleur : trait
 *    PLEIN = placement vérifié en direct ; tirets fins = configuré mais non confirmé ; tirets
 *    larges = ressource arrêtée/inactive. Les arêtes "mount"/"hosts" Docker restent structurelles
 *    (jamais de sonde active pertinente pour elles) : toujours pleines.
 *
 * MOTEUR GÉNÉRIQUE depuis la migration vers le contrat (17/08/2026) : quelle extrémité porte le
 * signal et comment il se projette sur couleur/pointillé est déclaré PAR KIND dans
 * NODE_CONTRACT[kind].edgeHealth (topologyNodeContract.tsx) — conteneur (healthStatus),
 * VM Nutanix (nutanixVmHostEdgeState : placement confirmé/incertain, mêmes
 * détails que la légende), source d'automatisation (statut de déclencheur propagé)... Cette
 * fonction interroge la SOURCE puis la CIBLE de chaque arête et retient la première réponse — un
 * contrat se garde LUI-MÊME (edgeKind/role du contexte), ce moteur ne contient plus aucun
 * `if (kind === ...)` de plateforme. Une arête dont aucune extrémité ne répond (ex : cluster ->
 * hôte physique, deux nœuds "host" au contrat edgeHealth null — aucun signal de santé par hôte
 * disponible côté Prism Central) retombe sur le rendu neutre : gris "none", pointillé générique
 * par kind d'arête ci-dessous.
 *
 * Seuls les kinds D'ARÊTE (mount/hosts/automation-flow — une notion transverse aux
 * plateformes, portée par TopologyEdge#kind côté API) restent testés ici : type de rendu
 * (particules pour "mount"), animation (jamais de tirets défilants pour "hosts", relation
 * structurelle sans flux de trafic à représenter — ni pour "mount", qui a ses particules) et
 * pointillé PAR DÉFAUT quand aucune extrémité ne porte de signal.
 */
export function buildTopologyEdges(
  edges: (TopologyEdge & { sourceHandle?: string; targetHandle?: string })[],
  nodesById: Map<string, TopologyNode>,
): Edge[] {
  // Pré-passe GÉNÉRIQUE : chaque kind peut déclarer un statut qu'il INJECTE dans la propagation le
  // long des arêtes "automation-flow" (NODE_CONTRACT[kind].automationStatusSeed — seul
  // "automation-trigger" en déclare un aujourd'hui). Le statut se propage à la/aux condition(s)
  // alimentée(s), pour qu'une arête condition -> action (qui n'a elle-même aucun déclencheur à
  // l'une de ses deux extrémités) hérite quand même d'un état réel plutôt que de retomber sur
  // "aucun signal".
  const triggerStatusByNodeId = new Map<string, AutomationTriggerStatus>();
  for (const n of nodesById.values()) {
    const seed = NODE_CONTRACT[n.kind].automationStatusSeed;
    if (seed) triggerStatusByNodeId.set(n.id, seed(n));
  }
  for (const e of edges) {
    if (e.kind !== "automation-flow") continue;
    const inherited = triggerStatusByNodeId.get(e.source);
    if (inherited && !triggerStatusByNodeId.has(e.target)) triggerStatusByNodeId.set(e.target, inherited);
  }

  return edges.map((e) => {
    const isMount = e.kind === "mount";
    const isHostsEdge = e.kind === "hosts";
    // "protects" (HYCU -> VM) : relation structurelle comme "hosts" — une sauvegarde est un
    // événement périodique, jamais un flux continu à animer en tirets défilants.
    const isProtectsEdge = e.kind === "protects";

    // Interroge le contrat de chaque extrémité — SOURCE d'abord (une arête "automation-flow" lit
    // son signal côté source, comportement historique conservé), puis CIBLE (arêtes "mount" volume
    // -> conteneur, "hosts" hôte -> VM). Chaque contrat se garde lui-même via le contexte
    // (edgeKind/role) et rend null pour toute arête où son signal n'a pas de sens ; une extrémité
    // absente de `nodesById` (course entre deux requêtes, ou id de groupe replié — jamais un
    // TopologyNode) est simplement sautée — retombe sur le rendu neutre comme avant ce chantier.
    let edgeHealthInfo: EdgeHealthInfo | null = null;
    for (const endpoint of [
      { id: e.source, role: "source" as const },
      { id: e.target, role: "target" as const },
    ]) {
      const node = nodesById.get(endpoint.id);
      if (!node) continue;
      const edgeHealth = NODE_CONTRACT[node.kind].edgeHealth;
      if (!edgeHealth) continue;
      edgeHealthInfo = edgeHealth(node, {
        edgeKind: e.kind,
        role: endpoint.role,
        automationUpstreamStatus: triggerStatusByNodeId.get(e.source) ?? "unknown",
      });
      if (edgeHealthInfo) break;
    }

    const state: EdgeHealthState = edgeHealthInfo?.state ?? "none";
    const color = EDGE_STATE_COLOR[state];
    // Pointillé : celui décidé par le contrat porteur du signal — sinon le défaut PAR KIND D'ARÊTE
    // (aucune extrémité ne répond) : "automation-flow" son motif fixe distinctif, tout le reste
    // (mount/hosts/protects/uses-artifact, relations structurelles) plein.
    const strokeDasharray = edgeHealthInfo
      ? edgeHealthInfo.strokeDasharray
      : e.kind === "automation-flow"
        ? "2 4"
        : undefined;
    // Ancrage sur le port du contrat dont la capacité correspond au kind de l'arête — un handle
    // déjà fixé par l'appelant (arête redirigée vers un groupe) reste prioritaire.
    const sourceHandle = e.sourceHandle ?? portIdForCapability(nodesById.get(e.source), EDGE_KIND_PORT_CAPABILITY[e.kind].source);
    const targetHandle = e.targetHandle ?? portIdForCapability(nodesById.get(e.target), EDGE_KIND_PORT_CAPABILITY[e.kind].target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      type: isMount ? "mountFlow" : "linkEdge",
      animated: !isMount && !isHostsEdge && !isProtectsEdge,
      className: `topology-edge topology-edge--${e.kind} topology-edge--${state}`,
      style: { stroke: color, ...(strokeDasharray ? { strokeDasharray } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      data: {
        kind: e.kind,
        state,
        color,
        // Nature du lien (pastille au milieu de l'arête, voir EDGE_KIND_LABEL/edgeBadgeItems).
        kindLabel: EDGE_KIND_LABEL[e.kind](nodesById.get(e.source), nodesById.get(e.target)),
        ...(e.readOnly !== undefined ? { readOnly: e.readOnly } : {}),
        // Données supplémentaires posées par le contrat porteur du signal (ex :
        // nutanixPlacementConfirmed pour le badge "Placement confirmé"/"Dernier hôte connu", voir
        // edgeBadgeItems ci-dessous et NODE_CONTRACT["nutanix-vm"].edgeHealth) — recopiées telles
        // quelles, ce moteur n'en connaît aucune clé.
        ...(edgeHealthInfo?.extraEdgeData ?? {}),
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

/** Nombre de particules simultanées par arête — impression de flux continu sans arête
 * trop "vide" entre deux particules, tout en restant un petit nombre fixe d'éléments SVG par
 * arête (coût de rendu borné même avec des dizaines d'arêtes affichées en même temps). */
const FLOW_PARTICLE_COUNT = 3;
const FLOW_PARTICLE_DURATION_S = 2.2;

/** Arête ACTIVE = seule porteuse de particules (vague 3) : healthy/starting uniquement, jamais
 * stopped/none/unhealthy — rien ne "coule" sans signal réel de bonne santé. */
export function isActiveEdgeState(state: EdgeHealthState | undefined): boolean {
  return state === "healthy" || state === "starting";
}

/** Particules le long du tracé (offset-path CSS natif, aucun recalcul JS par frame) — partagées
 * par MountFlowEdge et LinkEdge ci-dessous. */
function EdgeFlowParticles({ edgePath, color }: { edgePath: string; color: string }) {
  return (
    <>
      {Array.from({ length: FLOW_PARTICLE_COUNT }).map((_, particleIndex) => {
        const particleStyle: CSSProperties = {
          offsetPath: `path('${edgePath}')`,
          animationDuration: `${FLOW_PARTICLE_DURATION_S}s`,
          animationDelay: `${(particleIndex * FLOW_PARTICLE_DURATION_S) / FLOW_PARTICLE_COUNT}s`,
          fill: color,
          color, // lu par le filtre drop-shadow (currentColor) en CSS, voir topology.css
        };
        return <circle key={particleIndex} r={2.6} className="topology-edge-particle" style={particleStyle} />;
      })}
    </>
  );
}

// --- Badge flottant sur l'arête (façon Railway) -------------------------------------------------
// Toutes les données affichées ici viennent RÉELLEMENT de Docker/Prism Central (voir
// TopologyEdge#readOnly et NodeContract#edgeHealth) — aucune latence affichée : QUAI ne sonde
// jamais activement le réseau, ce chiffre serait inventé.

/** Libellé de la NATURE du lien, par kind d'arête (pastille au milieu — maquette validée). */
export const EDGE_KIND_LABEL: Record<
  TopologyEdge["kind"],
  (source: TopologyNode | undefined, target: TopologyNode | undefined) => string
> = {
  mount: () => "montage",
  // Cluster -> hôte AHV = "hôte physique" ; hôte/environnement -> conteneur ou VM = "hébergement".
  // Master -> appliance HYCU = "intégration" : QUAI la lit, il ne l'héberge pas.
  hosts: (_source, target) =>
    target?.kind === "host" ? "hôte physique" : target?.kind === "hycu-appliance" ? "intégration" : "hébergement",
  "automation-flow": () => "automatisation",
  "uses-artifact": (source) => (source ? `artefact ${source.label}` : "artefact"),
  // HYCU -> VM : nom de la politique RÉELLE quand HYCU l'a résolue, sinon la nature du lien seule.
  protects: (_source, target) => (target?.hycuPolicyName ? `sauvegarde ${target.hycuPolicyName}` : "sauvegarde"),
};

export interface EdgeBadgeData {
  readOnly?: boolean;
  /** Arête "hosts" hôte physique -> VM Nutanix UNIQUEMENT (VM allumée sans erreur API, voir
   * buildTopologyEdges ci-dessus) : true = placement confirmé en direct, false = replié sur le
   * dernier hôte assigné/déclaré. Absent pour tout autre cas (VM éteinte/en erreur, cluster ->
   * hôte, conteneur...) — la couleur/le pointillé suffisent déjà à ces cas, pas de badge en plus. */
  nutanixPlacementConfirmed?: boolean;
  /** Libellé de nature du lien (EDGE_KIND_LABEL) — masqué si un badge spécifique prime. */
  kindLabel?: string;
  /** État de santé de l'arête (buildTopologyEdges) — colore la pastille de nature du lien. */
  state?: EdgeHealthState;
}

interface EdgeBadgeItem {
  text: string;
  tone: "neutral" | "good" | "warn" | "critical";
}

/** Couleur de la pastille de nature du lien, héritée de l'état de l'arête. */
function edgeStateTone(state: EdgeHealthState | undefined): EdgeBadgeItem["tone"] {
  if (state === "healthy") return "good";
  if (state === "starting") return "warn";
  if (state === "unhealthy" || state === "stopped") return "critical";
  return "neutral";
}

export function edgeBadgeItems(data: EdgeBadgeData): EdgeBadgeItem[] {
  const items: EdgeBadgeItem[] = [];
  if (data.readOnly !== undefined) items.push({ text: data.readOnly ? "ro" : "rw", tone: "neutral" });
  if (data.nutanixPlacementConfirmed !== undefined) {
    items.push(
      data.nutanixPlacementConfirmed
        ? { text: "Placement confirmé", tone: "good" }
        : { text: "Dernier hôte connu", tone: "warn" },
    );
  }
  // Un badge spécifique (placement Nutanix) prime : jamais un 2e libellé empilé dessus.
  if (data.kindLabel && data.nutanixPlacementConfirmed === undefined) {
    items.unshift({ text: data.kindLabel, tone: edgeStateTone(data.state) });
  }
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
 * de l'animation générique "tirets qui défilent" des autres arêtes — trait plein + particules
 * qui voyagent réellement le long du tracé de l'arête via la propriété CSS `offset-path` (animation
 * native du navigateur sur la propriété `offset-distance`, donc aucun recalcul JS par frame, coût
 * quasi nul même avec beaucoup d'arêtes à l'écran). Vague 3 : particules réservées aux arêtes
 * ACTIVES (isActiveEdgeState — healthy/starting), plus jamais pour none/unhealthy ; coupées aussi
 * si l'utilisateur préfère moins d'animations — on retombe alors sur le simple trait coloré.
 */
function MountFlowEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const reducedMotion = usePrefersReducedMotion();
  const edgeData = data as (EdgeBadgeData & { state?: EdgeHealthState; color?: string }) | undefined;
  const flowing = isActiveEdgeState(edgeData?.state) && !reducedMotion;
  return (
    <>
      <BaseEdge id={id} path={edgePath} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      {flowing && <EdgeFlowParticles edgePath={edgePath} color={edgeData?.color ?? "var(--color-warning)"} />}
      {edgeData && <EdgeBadge x={labelX} y={labelY} data={edgeData} />}
    </>
  );
}

/** Arête générique (tout kind sauf "mount") : même tracé/rendu que le type "default" de React Flow
 * (bezier), réimplémenté ici uniquement pour pouvoir y accrocher le badge flottant ci-dessus — le
 * type "default" ne permet pas d'injecter un enfant supplémentaire. Renommée de "networkEdge" à
 * "linkEdge" le 24/08/2026 (plus aucune arête de réseau n'existe). Particules de flux sur TOUTE
 * arête ACTIVE, jamais sur stopped/none/unhealthy ni sous prefers-reduced-motion. */
function LinkEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const reducedMotion = usePrefersReducedMotion();
  const edgeData = data as (EdgeBadgeData & { kind?: string; state?: EdgeHealthState; color?: string }) | undefined;
  const flowing = isActiveEdgeState(edgeData?.state) && !reducedMotion;
  return (
    <>
      <BaseEdge id={id} path={edgePath} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      {flowing && <EdgeFlowParticles edgePath={edgePath} color={edgeData?.color ?? "var(--accent-end)"} />}
      {edgeData && <EdgeBadge x={labelX} y={labelY} data={edgeData} />}
    </>
  );
}

export const edgeTypes = { mountFlow: MountFlowEdge, linkEdge: LinkEdge };

// --- Panneau "Légende" repliable du graphe (TopologyGraph.tsx) ----------------------------------
// Retour utilisateur (mission du 17/08/2026, point 4) : la grille couleur/pointillé documentée
// juste au-dessus (buildTopologyEdges/nutanixVmHostEdgeState) n'existait QUE dans le code,
// invisible pour quiconque utilise l'application sans lire les sources. Ce panneau reprend les
// MÊMES valeurs EXACTES (EDGE_STATE_COLOR, mêmes libellés de pointillé) — jamais une seconde
// palette/description à tenir cohérente en plus du code qui dessine réellement les arêtes.

/** "il y a 3 min" / "à l'instant" / "il y a 2 h 05" — jamais une date absolue seule (moins lisible
 * d'un coup d'œil pour juger une fraîcheur) : voir TopologyLegendPanel ci-dessous, seul usage. */
function relativeTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `il y a ${hours} h${rest > 0 ? ` ${String(rest).padStart(2, "0")}` : ""}`;
}

export interface TopologyLegendPanelProps {
  /** Voir Topology#nutanixLastPoll (apps/api/src/types.ts) — absent tant que Nutanix n'a jamais
   * été configuré ou jamais encore pollé depuis le démarrage du process API. `reachable: false` =
   * le DERNIER poll a échoué : les VM/hôtes Nutanix peuvent être temporairement absents du graphe
   * pour cette raison plutôt que réellement supprimés (voir services/nutanix.ts#
   * lastKnownNutanixPoll) — jamais affiché comme une alerte permanente une fois qu'un poll
   * ultérieur réussit à nouveau. */
  nutanixLastPoll?: { reachable: boolean; at: string };
  onClose?: () => void;
}

/** Une ligne "pastille de couleur + libellé" de la section "Couleur — santé" ci-dessous. */
function LegendColorRow({ state, label }: { state: EdgeHealthState; label: string }) {
  return (
    <div className="topology-legend-row">
      <span className="topology-legend-dot" style={{ background: EDGE_STATE_COLOR[state] }} />
      <span>{label}</span>
    </div>
  );
}

/** Une ligne "trait + libellé" de la section "Pointillé — confiance" ci-dessous. */
function LegendLineRow({ variant, label }: { variant: "solid" | "dashed-fine" | "dashed-wide"; label: string }) {
  return (
    <div className="topology-legend-row">
      <span className={`topology-legend-line topology-legend-line--${variant}`} />
      <span>{label}</span>
    </div>
  );
}

/**
 * Contenu du panneau "Légende" — voir TopologyLegendPanelProps ci-dessus et TopologyGraph.tsx pour
 * le bouton bascule (barre d'outils du canevas, façon Railway, même pattern que le bouton
 * "vue d'ensemble"/MiniMap déjà en place) et le positionnement (coin bas-droit du canevas, seul
 * coin libre : haut-gauche = Contrôles/MiniMap, haut-droit = "Regrouper" en sélection multiple,
 * bas-gauche = "Nettoyer les orphelins").
 */
export function TopologyLegendPanel({ nutanixLastPoll, onClose }: TopologyLegendPanelProps) {
  return (
    <div className="topology-legend-panel nodrag nopan" onClick={(event) => event.stopPropagation()}>
      <div className="topology-legend-panel__head">
        <span className="topology-legend-panel__title">Légende</span>
        {onClose && (
          <button type="button" className="topology-legend-panel__close" title="Fermer la légende" onClick={onClose}>
            <IconClose />
          </button>
        )}
      </div>

      <div className="topology-legend-panel__section">
        <div className="topology-legend-panel__section-title">Couleur — santé</div>
        <LegendColorRow state="healthy" label="Sain / placement confirmé en direct" />
        <LegendColorRow state="starting" label="Healthcheck en cours / placement incertain" />
        <LegendColorRow state="unhealthy" label="Panne / erreur réelle signalée" />
        <LegendColorRow state="stopped" label="Arrêté (arrêt volontaire, pas une panne)" />
        <LegendColorRow state="none" label="Aucun signal disponible" />
      </div>

      <div className="topology-legend-panel__section">
        <div className="topology-legend-panel__section-title">Pointillé — confiance de connexion</div>
        <LegendLineRow variant="solid" label="Confirmé (placement vérifié en direct / lien structurel)" />
        <LegendLineRow variant="dashed-fine" label="Configuré, non confirmé (pas de sonde active)" />
        <LegendLineRow variant="dashed-wide" label="Ressource arrêtée / inactive" />
      </div>

      <div className="topology-legend-panel__section">
        <div className="topology-legend-panel__section-title">VM Nutanix (hôte physique → VM)</div>
        <p className="topology-legend-panel__text">
          Vert plein = la VM tourne sur l'hôte affiché, vérifié à ce poll. Orange tirets fins = la VM tourne, mais son
          placement affiché est le dernier hôte assigné connu (pas reconfirmé à ce poll précis). Gris tirets larges =
          VM éteinte. Rouge = VRAIE erreur signalée par Prism Central (jamais un simple arrêt).
        </p>
      </div>

      {nutanixLastPoll && !nutanixLastPoll.reachable && (
        // Retour utilisateur (mission du 17/08/2026, point 2) : sans caching d'aucune sorte côté
        // API (voir services/nutanix.ts en-tête), un poll Nutanix en échec fait DISPARAÎTRE les
        // nœuds VM/cluster/hôte de cette réponse plutôt que d'en afficher une valeur obsolète — ce
        // bandeau est le seul moyen de savoir que c'est la cause, plutôt qu'une vraie absence de VM.
        <div className="topology-legend-panel__note" title={new Date(nutanixLastPoll.at).toLocaleString("fr-FR")}>
          Nutanix injoignable au dernier poll ({relativeTimeAgo(nutanixLastPoll.at)}) — les VM/hôtes Nutanix peuvent
          être temporairement absents du graphe pour cette raison.
        </div>
      )}
    </div>
  );
}

/** Icône par kind de tiroir — mêmes icônes que l'ancien KIND_ICON des nœuds volume/network. */
const ATTACHMENT_ICON: Record<TopologyNodeAttachment["kind"], (props: { className?: string }) => JSX.Element> = {
  volume: IconVolumes,
  network: IconNetworks,
};

/**
 * Callbacks optionnels posés sur `node.data` par TopologyGraph.tsx/TopologySubGraphPanel.tsx lors
 * de la construction des `flowNodes` (jamais persistés — de simples fonctions en mémoire, le reste
 * de `data` reste le TopologyNode sérialisable tel que renvoyé par GET /api/topology) : GraphNode
 * est un composant partagé sans accès direct à Redux/au state du panneau parent, ces callbacks sont
 * donc le seul moyen pour un "tiroir" (volume dédié ou réseau, rendu ICI plutôt que comme un nœud
 * séparé) de rester cliquable/clic-droit-able exactement comme un vrai nœud.
 */
export interface GraphNodeCallbacks {
  onOpenAttachment?: (attachment: TopologyNodeAttachment) => void;
  onAttachmentContextMenu?: (event: React.MouseEvent, attachment: TopologyNodeAttachment) => void;
  /** Survol d'un tiroir RÉSEAU (`null` à la sortie) — compense la disparition du nœud réseau, qui
   * montrait d'un coup d'œil qui partageait un réseau : l'appelant s'en sert pour mettre en
   * évidence les autres nœuds réellement rattachés au même `networkId`. */
  onAttachmentHover?: (attachment: TopologyNodeAttachment | null) => void;
  /** Bouton ＋ au survol d'une carte conteneur OU VM Nutanix (picker contextuel par kind :
   * conteneur -> Stockage/Variable ; VM -> Disque/Carte réseau/vCPU-Mémoire) — injecté par
   * TopologyGraph.tsx uniquement pour un rôle operator+ ; absent = bouton non rendu. */
  onOpenAttachPicker?: (event: React.MouseEvent) => void;
  /** Boutons d'action directs au survol (Démarrer/Arrêter/Redémarrer selon l'état RÉEL, voir
   * quickLifecycleActions dans topologyNodeContract.tsx) — MÊMES handlers réels que le menu
   * contextuel (confirmations comprises), injectés par TopologyGraph.tsx pour operator+ ;
   * absent = boutons non rendus. */
  onQuickAction?: (action: QuickLifecycleAction, event: React.MouseEvent) => void;
  /** true si une action est déjà en cours sur CE nœud (nutanix.actionPendingUuid /
   * containers.actionPendingId) — désactive les boutons rapides, comparé par graphNodePropsEqual. */
  actionPending?: boolean;
  /** Suppression en cours sur CE nœud (confirmation comprise) — contour rouge pulsé jusqu'à ce que
   * le nœud disparaisse réellement du graphe. */
  deletePending?: boolean;
}

/** Métadonnées de recette injectées par TopologyGraph.tsx sur `node.data` d'un nœud
 * "image-template" (depuis state.templates.items — la projection topologie ne porte ni le nombre
 * d'étapes ni le détail de la base) : la carte du graphe principal est "l'appliance repliée",
 * ces chips résument ce que le sous-graphe déplie. Absentes tant que la liste de templates n'est
 * pas chargée (backend 404 compris) — aucun compte inventé. */
export interface GraphNodeTemplateMeta {
  templateStepCount?: number;
  templateBaseLabel?: string;
}

/**
 * Module métier porté par CETTE instance de nœud (voir topologyNodeContract.tsx#
 * NodeServiceModuleBinding et features/serviceModules/) — injecté sur `node.data` par l'appelant
 * qui dispose des liaisons (useServiceModuleBindings), jamais lu depuis le graphe lui-même : un
 * TopologyNode n'a aucune notion de module côté serveur. Absent = carte strictement inchangée.
 */
export interface GraphNodeServiceModuleMeta {
  serviceModule?: NodeServiceModuleBinding;
}

/** Reconstruit un TopologyNode "synthétique" pour un tiroir VOLUME (voir TopologyNode#attachments)
 * — un volume dédié n'a PAS de nœud top-level correspondant dans `topology.nodes` : ouvrir son
 * détail nécessite donc de reconstituer un TopologyNode minimal mais suffisant (id/kind/label/
 * subtitle attendus par TopologyNodeDetailPanel.tsx pour aller chercher le VRAI détail complet via
 * GET /api/volumes). `status: "running"` : même convention que les vrais nœuds volume
 * (services/topology.ts), un volume n'a pas d'état "arrêté" propre. Jamais appelée pour un tiroir
 * réseau : un réseau n'a plus de kind de nœud, son détail s'ouvre sur le nœud PORTEUR. */
export function attachmentToTopologyNode(attachment: TopologyNodeAttachment): TopologyNode {
  return { id: attachment.id, kind: "volume", label: attachment.label, subtitle: attachment.subtitle, status: "running" };
}

/** `attachments` (voir TopologyNode#attachments) compte comme égal entre deux rendus si chaque
 * tiroir affiché (les seuls champs rendus par GraphNode) est identique, même si le tableau
 * lui-même a été recréé par le parent. */
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
      att.readOnly === other.readOnly &&
      att.ipAddress === other.ipAddress &&
      att.vlanId === other.vlanId
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
  const a = prev.data as unknown as TopologyNode & GraphNodeCallbacks & GraphNodeTemplateMeta & GraphNodeServiceModuleMeta;
  const b = next.data as unknown as TopologyNode & GraphNodeCallbacks & GraphNodeTemplateMeta & GraphNodeServiceModuleMeta;
  return (
    a.kind === b.kind &&
    // Boutons rapides (18/08/2026) : l'état "action en cours" est RENDU (boutons désactivés) —
    // doit invalider le memo, contrairement aux callbacks eux-mêmes (voir JSDoc ci-dessus).
    a.actionPending === b.actionPending &&
    a.deletePending === b.deletePending &&
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
    // VM Nutanix (voir isNutanixVm/topology-node__specs, GraphNodeImpl ci-dessous, 17/08/2026) —
    // mêmes raisons que cpuPercent/memBytes ci-dessus : réellement rendus, doivent invalider le memo.
    a.numVcpus === b.numVcpus &&
    a.memoryMib === b.memoryMib &&
    a.nutanixHostName === b.nutanixHostName &&
    // Protection HYCU RÉELLEMENT rendue sur la carte d'une VM (badge + date) — mêmes raisons.
    a.hycuProtection === b.hycuProtection &&
    a.hycuLastBackupAt === b.hycuLastBackupAt &&
    // Compteurs de la carte de l'appliance HYCU — rendus, donc comparés (ils bougent à chaque poll).
    a.hycuVmTotal === b.hycuVmTotal &&
    a.hycuProtectedVmCount === b.hycuProtectedVmCount &&
    a.hycuPolicyCount === b.hycuPolicyCount &&
    a.hycuTargetCount === b.hycuTargetCount &&
    a.hycuFailedJobCount === b.hycuFailedJobCount &&
    // Chips "appliance repliée" d'un nœud image-template (voir GraphNodeTemplateMeta) — rendues,
    // donc comparées, comme le reste des champs affichés.
    a.templateStepCount === b.templateStepCount &&
    a.templateBaseLabel === b.templateBaseLabel &&
    // Pastille "module <label>" (voir GraphNodeServiceModuleMeta) — réellement rendue, donc comparée.
    a.serviceModule?.moduleLabel === b.serviceModule?.moduleLabel &&
    a.serviceModule?.origin === b.serviceModule?.origin &&
    attachmentsEqual(a.attachments, b.attachments) &&
    domainsEqual(a.domains, b.domains) &&
    domainsEqual(a.publishedPorts?.map(String), b.publishedPorts?.map(String))
  );
}

function GraphNodeImpl({ data, selected }: NodeProps) {
  const node = data as unknown as TopologyNode & GraphNodeCallbacks & GraphNodeTemplateMeta & GraphNodeServiceModuleMeta;
  const Icon = nodeIcon(node);
  const isContainer = node.kind === "container";
  // Flash bref du point de statut quand le statut constaté change entre deux polls — le `key`
  // remonte le <span> pour rejouer l'animation CSS (voir .topology-node__status-dot--flash).
  const [statusFlashKey, setStatusFlashKey] = useState(0);
  const prevStatusRef = useRef(node.status);
  useEffect(() => {
    if (prevStatusRef.current !== node.status) {
      prevStatusRef.current = node.status;
      setStatusFlashKey((k) => k + 1);
    }
  }, [node.status]);
  // Bouton rapide précisément cliqué — seul lui affiche le spinner pendant actionPending.
  const [clickedAction, setClickedAction] = useState<QuickLifecycleAction | null>(null);
  const wasPendingRef = useRef(false);
  useEffect(() => {
    if (wasPendingRef.current && !node.actionPending) setClickedAction(null);
    wasPendingRef.current = !!node.actionPending;
  }, [node.actionPending]);
  // Retour utilisateur du 17/08/2026 : "le meme logique que pour els container na pas ete
  // appliquer verifie tout" — une carte "nutanix-vm" n'affichait jusqu'ici QUE icône/libellé/
  // sous-titre/statut, une fraction du niveau d'info déjà dense d'une carte conteneur (badges/
  // métriques/briques), ce qui la faisait paraître disproportionnée pour son contenu réel ("il son
  // gros" — même largeur fixe de carte que tout le reste du graphe, voir topology.css, mais très
  // peu remplie). vCPUs/mémoire/hôte physique actuel sont déjà des données RÉELLES exposées par
  // apps/api/src/services/topology.ts#nutanixVmToNode (jamais recalculées ici) — voir le résumé
  // compact ajouté plus bas (topology-node__specs), même esprit que le résumé CPU/mémoire d'un
  // conteneur juste en dessous, mais des specs STATIQUES (vCPU/RAM alloués) plutôt qu'une jauge
  // d'usage live : Prism Central ne renvoie aucune métrique d'utilisation courante par VM sur les
  // endpoints déjà utilisés ici (voir NutanixHostResources côté nutanix.ts), jamais une jauge
  // inventée pour imiter visuellement le conteneur. La carte "host" (cluster/hôte physique) reste
  // volontairement inchangée : son sous-titre porte déjà CPU/RAM (voir services/topology.ts,
  // formatHostMemorySubtitle) — un résumé identique en double sur la carte n'ajouterait rien.
  const isNutanixVm = node.kind === "nutanix-vm";
  const isHycuAppliance = node.kind === "hycu-appliance";
  // Badge de protection HYCU (VM Nutanix uniquement) — `null` dès que HYCU ne dit rien de réel.
  const hycuBadge = isNutanixVm ? hycuProtectionBadge(node) : null;
  // Pastille discrète "module <label>" — `null` pour tout nœud sans module lié (l'immense
  // majorité) : la carte reste alors strictement identique à ce qu'elle était.
  const moduleBadge = serviceModuleBadge(node.serviceModule);
  // Tiroirs (TopologyNode#attachments — VRAIES données Docker/Prism Central, jamais un nouveau
  // stockage) : sous-cartes glissées SOUS la carte du service, dépassant du bord inférieur, ton
  // assourdi (voir .topology-node__drawers plus bas). Volumes d'abord, puis réseaux — depuis le
  // 24/08/2026 les réseaux y passent aussi (ils n'ont plus de nœud), avec le MÊME composant que
  // les volumes plutôt qu'un rendu parallèle.
  const drawerAttachments = [
    ...(node.attachments ?? []).filter((a) => a.kind === "volume"),
    ...(node.attachments ?? []).filter((a) => a.kind === "network"),
  ];
  // TOUS les Handles du nœud viennent du contrat (NODE_CONTRACT[kind].ports,
  // topologyNodeContract.tsx) — y compris ceux des nœuds d'automatisation, autrefois posés par un
  // JSX conditionnel par-kind juste en dessous (comportement implicite rendu explicite par la
  // migration du 17/08/2026 : mêmes ids "automation-out"/"automation-in", mêmes côtés, même classe
  // .topology-handle--automation, désormais déclarés comme n'importe quel autre port).
  const ports = NODE_CONTRACT[node.kind].ports;
  // Zoom sémantique : en dessous du seuil, on masque libellé/badges/métriques et on ne garde que
  // l'icône + le point de statut — évite un canevas illisible une fois dézoomé sur toute l'infra.
  const zoom = useStore(zoomSelector);
  const isCompact = zoom < ZOOM_DETAIL_THRESHOLD;
  return (
    <div
      className={`topology-node topology-node--${node.kind}${node.kind === "host" && node.hostKind ? ` topology-node--host-${node.hostKind}` : ""} topology-node--${node.status}${node.orphan ? " topology-node--orphan" : ""}${selected ? " is-selected" : ""}${isCompact ? " topology-node--compact" : ""}${node.actionPending ? " topology-node--pending" : ""}${node.deletePending ? " topology-node--deleting" : ""}`}
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
          {...(portOffsetStyle(port, ports) ? { style: portOffsetStyle(port, ports) } : {})}
        />
      ))}
      {/* Alertes de ressource "CPU élevé"/"Mémoire élevée" (voir CPU_ALERT_THRESHOLD_PERCENT/
          MEMORY_ALERT_RATIO/computeNodeResourceAlerts ci-dessus) : plus rendues ICI, ancrées au
          nœud — retour utilisateur du 17/08/2026 ("ce genre alert devrais aparaitre en haut a
          droite", capture d'écran à l'appui) : une carte ancrée au nœud restait invisible dès que
          l'utilisateur n'était pas en train de regarder/zoomer exactement sur ce nœud précis, dans
          un graphe pouvant contenir des dizaines de nœuds éparpillés. Voir TopologyAlertStack
          (ci-dessus, montée par TopologyGraph.tsx en pile FIXE haut-droite de l'écran, indépendante
          du pan/zoom) — seul emplacement de rendu désormais, jamais les deux à la fois. */}
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
      {/* Protection HYCU RÉELLE d'une VM Nutanix (voir hycuProtectionBadge) — rien du tout tant que
          HYCU n'est pas configuré/joignable ou ne connaît pas cette VM : jamais un "non
          sauvegardée" déduit d'un silence. */}
      {hycuBadge && (
        <div className="topology-node__badges">
          <span className={`topology-badge topology-badge--${hycuBadge.tone}`} title={hycuBadge.title}>
            {hycuBadge.label}
          </span>
        </div>
      )}
      {/* Module métier porté par CE nœud précis (voir GraphNodeServiceModuleMeta) — signale que le
          double-clic ouvre la vue du service, pas une simple carte de dépendances. */}
      {moduleBadge && (
        <div className="topology-node__badges">
          <span className="topology-badge topology-badge--module" title={moduleBadge.title}>
            {moduleBadge.label}
          </span>
        </div>
      )}
      <div className="topology-node__subtitle">{node.subtitle}</div>
      {isHycuAppliance && (typeof node.hycuProtectedVmCount === "number" || typeof node.hycuPolicyCount === "number") && (
        // Compteurs RÉELS du dernier poll (services/topology.ts) — absents si l'appliance est
        // injoignable, où seul le statut "stopped" de la carte parle.
        <div className="topology-node__specs">
          {typeof node.hycuProtectedVmCount === "number" && (
            <span className="topology-node__spec-chip" title="VMs protégées / VMs vues par HYCU">
              {node.hycuProtectedVmCount}/{node.hycuVmTotal ?? node.hycuProtectedVmCount} VMs
            </span>
          )}
          {typeof node.hycuPolicyCount === "number" && (
            <span className="topology-node__spec-chip" title="Politiques de sauvegarde">
              {node.hycuPolicyCount} politique{node.hycuPolicyCount > 1 ? "s" : ""}
            </span>
          )}
          {typeof node.hycuTargetCount === "number" && (
            <span className="topology-node__spec-chip" title="Cibles de sauvegarde">
              {node.hycuTargetCount} cible{node.hycuTargetCount > 1 ? "s" : ""}
            </span>
          )}
          {!!node.hycuFailedJobCount && (
            <span className="topology-node__spec-chip topology-node__spec-chip--critical" title="Jobs récents en échec (statut ERROR)">
              {node.hycuFailedJobCount} job{node.hycuFailedJobCount > 1 ? "s" : ""} en échec
            </span>
          )}
        </div>
      )}
      {isNutanixVm &&
        (typeof node.numVcpus === "number" || typeof node.memoryMib === "number" || !!node.nutanixHostName || !!node.hycuLastBackupAt) && (
        // Résumé compact des specs RÉELLES de la VM (voir isNutanixVm ci-dessus pour le pourquoi) —
        // chips non interactives (pas de nodrag/nopan/stopPropagation nécessaires, rien n'est
        // cliquable ici contrairement aux briques d'un conteneur juste plus bas).
        <div className="topology-node__specs">
          {typeof node.numVcpus === "number" && (
            <span className="topology-node__spec-chip" title="vCPUs alloués">
              {node.numVcpus} vCPU
            </span>
          )}
          {typeof node.memoryMib === "number" && (
            <span className="topology-node__spec-chip" title="Mémoire allouée">
              {formatMem(node.memoryMib * 1024 * 1024)}
            </span>
          )}
          {!!node.nutanixHostName && (
            <span className="topology-node__spec-chip" title="Hôte physique actuel">
              {node.nutanixHostName}
            </span>
          )}
          {!!node.hycuLastBackupAt && (
            <span className="topology-node__spec-chip" title={`Dernière sauvegarde rapportée par HYCU : ${new Date(node.hycuLastBackupAt).toLocaleString("fr-FR")}`}>
              Sauv. {formatShortDate(node.hycuLastBackupAt)}
            </span>
          )}
        </div>
      )}
      {node.kind === "image-template" && (typeof node.templateStepCount === "number" || !!node.templateBaseLabel) && (
        // "Appliance repliée" (voir GraphNodeTemplateMeta) : mêmes chips discrètes que les specs VM.
        <div className="topology-node__specs">
          {typeof node.templateStepCount === "number" && (
            <span
              className="topology-node__spec-chip"
              title="Étapes de la recette — double-clic sur la carte pour ouvrir et éditer le sous-graphe"
            >
              {node.templateStepCount} étape{node.templateStepCount > 1 ? "s" : ""}
            </span>
          )}
          {!!node.templateBaseLabel && (
            <span className="topology-node__spec-chip" title="Base de la recette (noyau de départ)">
              {node.templateBaseLabel}
            </span>
          )}
        </div>
      )}
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
      {isContainer && !node.domains?.length && !!node.publishedPorts?.length && (
        // Aucun sous-domaine ne sert ce conteneur, mais il publie un port : lien direct vers l'hôte
        // qui sert cette page (les ports publiés le sont sur ce même hôte). Deux au maximum.
        <div className="topology-node__domains">
          {node.publishedPorts.slice(0, 2).map((port) => (
            <a
              key={port}
              href={`http://${window.location.hostname}:${port}`}
              target="_blank"
              rel="noreferrer"
              className="topology-node__domain nodrag nopan"
              title={`Ouvrir le port ${port} publié par ce conteneur (aucun sous-domaine ne le sert)`}
              onClick={(event) => event.stopPropagation()}
            >
              <IconGlobe className="topology-node__domain-icon" />
              <span className="topology-node__domain-label">{`${window.location.hostname}:${port}`}</span>
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
      {/* Boutons d'action directs révélés au survol (18/08/2026, retour utilisateur : "ajoute
          directement dessus start stop restart... suivant leur etat") — actions dérivées de l'état
          RÉEL par quickLifecycleActions (contrat, même grille que le menu contextuel), handlers
          RÉELS injectés par TopologyGraph.tsx (confirmations existantes comprises, jamais
          dupliquées). Désactivés pendant une action en cours (actionPending). "Supprimer"
          volontairement absent — voir quickLifecycleActions (topologyNodeContract.tsx). */}
      {!isCompact && node.onQuickAction && quickLifecycleActions(node).length > 0 && (
        <div className="topology-node__quick-actions nodrag nopan">
          {quickLifecycleActions(node).map((action) => {
            const QuickIcon = action === "start" ? IconPlay : action === "stop" ? IconStop : IconRestart;
            return (
              <button
                key={action}
                type="button"
                className={`topology-node__quick-btn topology-node__quick-btn--${action}${
                  node.actionPending && clickedAction === action ? " topology-node__quick-btn--busy" : ""
                }`}
                title={node.actionPending ? "Action en cours…" : ACTION_LABEL[action]}
                disabled={node.actionPending}
                onClick={(event) => {
                  event.stopPropagation();
                  setClickedAction(action);
                  node.onQuickAction?.(action, event);
                }}
              >
                <QuickIcon />
              </button>
            );
          })}
        </div>
      )}
      {/* ＋ révélé au survol (CSS) — conteneurs ET VMs Nutanix (18/08/2026 : le backend d'attache
          VM existe désormais, voir routes/nutanix.ts disks/nics/compute) ; le picker ouvert est
          contextuel par kind (TopologyGraph.tsx#attachPicker). Rendu seulement si le callback est
          injecté (operator+, voir GraphNodeCallbacks). */}
      {(isContainer || isNutanixVm) && !isCompact && node.onOpenAttachPicker && (
        <button
          type="button"
          className="topology-node__attach-btn nodrag nopan"
          title={isNutanixVm ? "Ajouter un disque, une carte réseau ou modifier vCPU/mémoire" : "Attacher un stockage, un réseau ou une variable"}
          onClick={(event) => {
            event.stopPropagation();
            node.onOpenAttachPicker?.(event);
          }}
        >
          <IconPlus />
        </button>
      )}
      <div className={`topology-node__status topology-node__status--${node.status}`}>
        <span
          key={statusFlashKey}
          className={`topology-node__status-dot${statusFlashKey > 0 ? " topology-node__status-dot--flash" : ""}`}
        />
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
      {!isCompact && drawerAttachments.length > 0 && (
        // "Tiroirs" (Phase 2, 17/08/2026 — capture Railway de référence validée par l'utilisateur ;
        // étendus aux RÉSEAUX le 24/08/2026) : chaque volume dédié / réseau rattaché est une
        // SOUS-CARTE glissée SOUS la carte du service (position absolue sous le bord inférieur, ton
        // assourdi, z-index négatif pour paraître passer DERRIÈRE la carte — .topology-node ne crée
        // pas de stacking context, le wrapper React Flow oui, donc le tiroir se place bien entre le
        // fond du canevas et la carte). Masqués en zoom compact (comme badges/métriques : sous le
        // seuil, la carte se réduit à icône + statut). Animation d'apparition : voir
        // .topology-drawer dans topology.css (désactivée sous prefers-reduced-motion).
        <div className="topology-node__drawers">
          {drawerAttachments.map((attachment, drawerIndex) => {
            const AttachmentIcon = ATTACHMENT_ICON[attachment.kind];
            const isNetwork = attachment.kind === "network";
            // Colonne de droite : point de montage réel pour un volume, IP réellement attribuée
            // pour un réseau — un tiret quand aucune IP ne l'est (jamais d'adresse fabriquée).
            const trailing = isNetwork ? attachment.ipAddress ?? "—" : attachment.destination;
            const title = isNetwork
              ? `${isNutanixVm ? "Carte réseau" : "Réseau"} ${attachment.label}${attachment.subtitle ? ` (${attachment.subtitle})` : ""} — ${
                  attachment.ipAddress ? `IP ${attachment.ipAddress}` : "aucune IP attribuée"
                }`
              : `Volume ${attachment.label}${attachment.destination ? ` — monté sur ${attachment.destination}` : ""}${
                  attachment.readOnly ? " (lecture seule)" : ""
                }`;
            return (
              <button
                key={attachment.id}
                type="button"
                className={`topology-drawer topology-drawer--${attachment.kind} nodrag nopan`}
                {...(isNetwork && attachment.networkId ? { "data-network-id": attachment.networkId } : {})}
                // Empilement : chaque tiroir supplémentaire glisse un cran plus bas ET un cran plus
                // "derrière" — l'index pilote le z-index négatif (le 1er tiroir devant le 2e, etc.),
                // le décalage vertical est porté par le flux normal du conteneur flex.
                style={{ zIndex: -1 - drawerIndex }}
                title={title}
                onClick={(event) => {
                  event.stopPropagation();
                  node.onOpenAttachment?.(attachment);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  node.onAttachmentContextMenu?.(event, attachment);
                }}
                {...(isNetwork
                  ? {
                      onMouseEnter: () => node.onAttachmentHover?.(attachment),
                      onMouseLeave: () => node.onAttachmentHover?.(null),
                    }
                  : {})}
              >
                <span className="topology-drawer__icon">
                  <AttachmentIcon />
                </span>
                <span className="topology-drawer__label">{attachment.label}</span>
                {trailing && <span className="topology-drawer__destination">{trailing}</span>}
                {attachment.readOnly && <span className="topology-drawer__ro">ro</span>}
              </button>
            );
          })}
        </div>
      )}
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
  /**
   * Nombre RÉEL de vrais TopologyNode transitivement contenus (groupes imbriqués, 13/08/2026 —
   * voir resolveGroupMemberNodeIds ci-dessus) — calculé par l'appelant (TopologyGraph.tsx/
   * TopologySubGraphPanel.tsx, qui seuls ont `allGroups` sous la main) plutôt qu'ici : `group.
   * nodeIds.length` seul pourrait être un mélange de vrais nœuds ET de sous-groupes, jamais le bon
   * compte à afficher à l'utilisateur.
   */
  realNodeCount: number;
}

/** Carte repliée d'un groupe — un seul nœud, comme un vrai TopologyNode, avec ses ports dérivés. */
function GroupNodeImpl({ data, selected }: NodeProps) {
  const { group, ports, onToggleCollapse, realNodeCount } = data as unknown as GroupNodeData;
  // Même zoom sémantique que GraphNode ci-dessus (retour utilisateur du 13/08/2026 : une carte de
  // groupe restait pleine taille/détaillée alors que tous les autres nœuds se réduisaient déjà à
  // leur icône en dessous du seuil — incohérent une fois dézoomé sur un graphe qui en contient
  // plusieurs). Même seuil, mêmes classes CSS partagées (.topology-node--compact,
  // .topology-node__label/__subtitle) : aucune règle CSS dédiée nécessaire.
  const zoom = useStore(zoomSelector);
  const isCompact = zoom < ZOOM_DETAIL_THRESHOLD;
  return (
    <div
      className={`topology-node topology-group-node${selected ? " is-selected" : ""}${isCompact ? " topology-node--compact" : ""}`}
      title={isCompact ? group.label : undefined}
    >
      {ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.handleType}
          position={port.position}
          className={`topology-handle topology-handle--${port.colorToken}`}
          title={port.label}
          {...(portOffsetStyle(port, ports) ? { style: portOffsetStyle(port, ports) } : {})}
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
        {realNodeCount} élément{realNodeCount > 1 ? "s" : ""} regroupé{realNodeCount > 1 ? "s" : ""}
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

/**
 * Disposition en COUCHES (Sugiyama simplifié) des membres DIRECTS d'un groupe, pour sa vue
 * "composition interne" (TopologySubGraphPanel.tsx, root = groupe) — bug réel corrigé le
 * 13/08/2026 (retour utilisateur : "une fois groupé il ne son plus relié... trouve un algorithme
 * pour les placer correctement pas en tas"). Contrairement à `radialPositions` (voisins d'UN vrai
 * nœud, disposés en cercle AUTOUR de lui) : un groupe n'a par nature AUCUNE arête vers ses membres
 * (voir services/topology.ts), il n'y a donc aucun "centre" réel à faire orbiter — la disposition
 * doit au contraire refléter comment les membres sont réellement reliés ENTRE EUX (ex : 5
 * conteneurs -> 2 volumes partagés, cas réel constaté).
 *
 * Algorithme (bipartite/DAG simple, suffisant pour la taille réelle d'un groupe — jamais un
 * vrai risque de cycle, `edges` ne vient que de volume->conteneur/hôte->conteneur, jamais l'inverse) :
 * 1) couche 0 par défaut pour tout membre ; 2) chaque arête INTERNE (les deux bouts sont des
 * membres directs, voir l'appelant) pousse sa cible à au moins couche(source)+1, en passes
 * successives bornées par `memberIds.length` (jamais une boucle infinie même sur des données
 * corrompues) ; 3) un membre jamais touché par une arête interne (îlot au sein du groupe) reste en
 * couche 0 — jamais une position inventée hors de tout repère réel. Au sein d'une couche, simple
 * espacement vertical centré (pas de minimisation de croisements : hors de portée utile pour la
 * taille d'un groupe dans ce premier lot).
 */
export function layeredGroupPositions(
  memberIds: string[],
  internalEdges: { source: string; target: string }[],
): Record<string, { x: number; y: number }> {
  const layerById = new Map<string, number>();
  for (const id of memberIds) layerById.set(id, 0);
  for (let pass = 0; pass < memberIds.length; pass++) {
    let changed = false;
    for (const e of internalEdges) {
      if (!layerById.has(e.source) || !layerById.has(e.target)) continue;
      const next = layerById.get(e.source)! + 1;
      if (next > layerById.get(e.target)!) {
        layerById.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const membersByLayer = new Map<number, string[]>();
  for (const id of memberIds) {
    const layer = layerById.get(id) ?? 0;
    (membersByLayer.get(layer) ?? membersByLayer.set(layer, []).get(layer)!).push(id);
  }
  // Mêmes constantes de base que l'arbre "host" (maquette : espacement serré et régulier), élargies
  // ici car une carte conteneur (badges + attachements volumes) peut dépasser 300px de hauteur.
  const LAYER_WIDTH = AUTO_LAYOUT_LEVEL_SPACING + 40;
  const ROW_HEIGHT = AUTO_LAYOUT_SIBLING_SPACING + 100;
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [layer, ids] of membersByLayer) {
    ids.forEach((id, row) => {
      positions[id] = { x: layer * LAYER_WIDTH, y: (row - (ids.length - 1) / 2) * ROW_HEIGHT };
    });
  }
  return positions;
}

// --- Disposition automatique de la hiérarchie "host" (cluster Nutanix -> hôte AHV -> VM, mais
// générique à TOUTE hiérarchie reliée par une arête "hosts" — un environnement Docker distant/un
// hôte LXD isolé, sans enfant, y devient simplement un arbre à une seule racine) -----------------
// Retour utilisateur du 17/08/2026, captures d'écran à l'appui : "29 VMs Nutanix empilées en une
// colonne géante, plein d'arêtes qui se croisent en éventail... un système qui permet de placer
// correctement... un peu à un circuit imprimé". Root-causé (TopologyGraph.tsx, avant ce correctif) :
// TOUS les nœuds "nutanix-vm" partageaient une seule colonne fixe (COLUMN_X["nutanix-vm"]) et un
// simple compteur de ligne PAR TYPE, sans aucune notion de "sous quel hôte/cluster" — d'où la
// colonne géante, jamais une vraie disposition en arbre.
//
// N'est volontairement PAS un simple appel à layeredGroupPositions ci-dessus : cette dernière
// résout une forme de problème différente (placer les MEMBRES D'UN GROUPE, un DAG en couches par
// plus long chemin, sans notion de parent unique à centrer dessus) — la hiérarchie host est, elle,
// un VRAI arbre (chaque nœud a AU PLUS un parent, voir l'arête "hosts" source -> target côté
// services/topology.ts#getNutanixTopologyParts) qui doit se lire comme un organigramme : chaque
// enfant centré sous SON parent, jamais un simple index de ligne global qui mélangerait les VMs de
// plusieurs hôtes différents. On reprend en revanche le même ESPRIT que layeredGroupPositions
// (mêmes noms de constantes, même espacement généreux "mieux vaut trop que des cartes qui se
// touchent" tiré du retour utilisateur du 13/08/2026, même principe "position calculée seulement en
// l'absence de position sauvegardée" — voir l'appelant, TopologyGraph.tsx) plutôt qu'une seconde
// logique de layout sans rapport avec le reste de ce fichier.
//
// Orientation HORIZONTALE (niveau -> colonne X, fratrie -> ligne Y), pas verticale — changé le
// 17/08/2026 EN MÊME TEMPS que le correctif des ports Left/Right (NODE_CONTRACT
// ["nutanix-vm"/"host"].ports, topologyNodeContract.tsx) : la mission précédente avait disposé cet arbre verticalement (parent
// au-dessus, enfants dessous) pour accompagner des ports Top/Bottom — une fois les ports remis en
// Left/Right (cohérence avec TOUT le reste du graphe, voir plus haut), garder un arbre vertical
// aurait fait partir chaque arête du CÔTÉ d'une carte pour rejoindre le dessus/dessous de la
// suivante (un repli en S disgracieux, le parent et l'enfant centrés à la même abscisse). Tourner
// l'arbre de 90° aligne au contraire ce correctif sur la convention DÉJÀ établie par TOUT le reste
// de ce graphe (COLUMN_X, TopologyGraph.tsx) : les nœuds reliés par un port source/target Left/
// Right sont disposés en COLONNES horizontales adjacentes (source à gauche, target à droite),
// jamais empilés verticalement — le port "Right" d'un parent (capacité "hosts") pointe alors
// naturellement vers le port "Left" de son enfant (capacité "hosted-by") juste à sa droite, sans
// repli. L'algorithme lui-même (largeur de sous-arbre bornée, grille compacte au-delà de
// HOST_TREE_MAX_LINE_CHILDREN feuilles) reste IDENTIQUE à celui qui a réglé "29 VMs empilées en une
// colonne géante" le 17/08/2026 — seul l'axe (x <-> y) est inversé, jamais réinventé.
/** Espacements PARTAGÉS des dispositions automatiques du graphe ET du sous-graphe — une carte
 * .topology-node fait 260px de large. Élargis d'environ 30% le 18/08/2026 (300/220 -> 380/280,
 * retour utilisateur : "ajouter un padding entre les node un peut plus important") : les tiroirs
 * d'attachements dépassent SOUS les cartes (.topology-node__drawers, topology.css) et une carte
 * conteneur riche approche 300px de haut — l'ancienne fratrie à 220px pouvait faire affleurer un
 * tiroir sur la carte du dessous. */
export const AUTO_LAYOUT_LEVEL_SPACING = 380;
export const AUTO_LAYOUT_SIBLING_SPACING = 280;

/** Distance (px) entre deux NŒUDS D'UNE MÊME FRATRIE le long de l'axe perpendiculaire à l'arbre
 * (axe Y). */
const HOST_TREE_SIBLING_SPACING = AUTO_LAYOUT_SIBLING_SPACING;
/** Distance (px) SUPPLÉMENTAIRE le long de l'axe des niveaux (X) entre deux "lignes" d'une grille
 * d'enfants repliée (voir HOST_TREE_MAX_LINE_CHILDREN ci-dessous) — au-dessus des 260px de large
 * d'une carte, avec la même marge élargie du 18/08/2026 que le reste du layout (270 -> 340). */
const HOST_TREE_GRID_LINE_SPACING = 340;
/** Distance (px) entre deux NIVEAUX de la hiérarchie (cluster -> hôte -> VM), le long de l'axe X. */
const HOST_TREE_LEVEL_SPACING = AUTO_LAYOUT_LEVEL_SPACING;
/** Au-delà de ce nombre d'enfants DIRECTS et tous eux-mêmes sans enfant propre (des feuilles, ex :
 * des VMs — jamais un hôte, qui a lui-même des VMs dessous), on arrête de les aligner sur une seule
 * ligne (c'était exactement le bug du 17/08/2026 : jusqu'à 29 VMs en une colonne géante) — ils sont
 * repliés en grille compacte plutôt qu'empilés à l'infini dans une seule direction. Relevé de 5 à
 * 10 le 18/08/2026 ("aucun cable ne se croise") : une colonne unique garantit ZÉRO croisement entre
 * arêtes de l'arbre, alors qu'en grille les arêtes vers les colonnes 2+ passent visuellement
 * par-dessus les cartes de la colonne 1 — on préfère donc la colonne unique tant qu'elle reste
 * raisonnable (10 x 280px), la grille ne servant plus qu'aux très grandes fratries où une colonne
 * de 3000px+ serait pire que ce compromis documenté. */
const HOST_TREE_MAX_LINE_CHILDREN = 10;
/** Nombre de "lignes" MAXIMUM (le long de l'axe des fratries, Y) d'une grille repliée (voir
 * ci-dessus) — le nombre réel utilisé est `min(HOST_TREE_MAX_GRID_LINES, ceil(sqrt(nombre
 * d'enfants)))`, une grille aussi proche que possible d'un carré ("circuit imprimé" plutôt qu'une
 * bande large et basse ou haute et étroite) plafonnée pour ne jamais produire une grille plus
 * "haute" que ce plafond. */
const HOST_TREE_MAX_GRID_LINES = 6;

/** true si tous les `childIds` donnés n'ont eux-mêmes AUCUN enfant dans `childrenOf` — un hôte avec
 * des VMs dessous ne doit JAMAIS être replié en grille (il a sa propre sous-hiérarchie à dessiner
 * dessous), seul un groupe de VRAIES feuilles (VMs, ou un hôte sans VM le cas échéant) le peut. */
function allChildrenAreLeaves(childIds: string[], childrenOf: Map<string, string[]>): boolean {
  return childIds.every((id) => (childrenOf.get(id)?.length ?? 0) === 0);
}

/**
 * Disposition en ARBRE HORIZONTAL (façon organigramme couché sur le côté, un seul parent par nœud
 * via `hostsEdges`) de tout sous-ensemble `nodeIds` relié par des arêtes "hosts" — chaque enfant
 * est centré À DROITE de son parent (axe X = niveau, axe Y = fratrie ; orientation choisie le
 * 17/08/2026 pour rester cohérente avec les ports Left/Right désormais posés sur "nutanix-vm"/
 * "host", voir NODE_CONTRACT (topologyNodeContract.tsx) et le bloc de constantes HOST_TREE_* juste au-dessus) ;
 * un parent avec BEAUCOUP d'enfants-feuilles (ex : un hôte AHV avec 29 VMs) les replie en grille
 * compacte (voir HOST_TREE_MAX_LINE_CHILDREN/HOST_TREE_MAX_GRID_LINES ci-dessus) plutôt que de les
 * aligner sur une seule ligne géante ; un nœud sans parent DANS ce sous-ensemble (racine réelle —
 * cluster Nutanix, ou tout hôte/VM isolé sans arête "hosts", ex : un environnement Docker distant
 * sans VM hébergée) devient sa propre racine d'arbre, plusieurs racines étant simplement empilées
 * les unes sous les autres (jamais de collision, chaque sous-arbre réserve sa propre plage sur
 * l'axe des fratries, voir `place` ci-dessous).
 *
 * CROISEMENTS (retour utilisateur du 18/08/2026 : "aucun cable ne se croise") — garanties réelles :
 * chaque sous-arbre réserve un intervalle Y CONTIGU et disjoint de ses frères, le parent est centré
 * sur son propre intervalle — sur un arbre strict (un seul parent par nœud, cas de "hosts"), cette
 * seule propriété garantit ZÉRO croisement entre les arêtes de l'arbre pour toute fratrie en
 * colonne unique ; le tri barycentre (étape Sugiyama, voir `barycenter` ci-dessous) ordonne en plus
 * les frères selon l'ordre global d'apparition de leurs descendants (éventail court et
 * déterministe, jamais un sous-arbre "croisé" loin de ses voisins naturels). Deux limites HONNÊTES,
 * hors de portée d'un layout : en grille repliée (fratrie > HOST_TREE_MAX_LINE_CHILDREN), les
 * arêtes vers les colonnes 2+ passent visuellement par-dessus les cartes de la colonne 1 ; et les
 * arêtes NON-arbre ("mount" vers les colonnes fixes de droite) peuvent toujours croiser —
 * aucune promesse là-dessus.
 *
 * Algorithme classique en deux passes (garanti sans chevauchement) — IDENTIQUE dans son principe à
 * la version verticale d'origine (17/08/2026, "29 VMs empilées en une colonne géante"), seul l'axe
 * change :
 *  1) `subtreeWidthUnits` (post-ordre, mémoïsé) : "largeur" du sous-arbre de chaque nœud le long de
 *     l'axe des fratries (Y), en unités — 1 pour une feuille ; somme des largeurs des enfants pour
 *     un nœud à peu d'enfants (alignés sur une même ligne verticale, cas normal : un cluster avec 3
 *     hôtes) ; BORNÉE par `ceil(sqrt(n))` (plafonnée) pour un nœud à beaucoup d'enfants-feuilles
 *     (cas réel : un hôte avec 29 VMs) — c'est cette borne, jamais proportionnelle au nombre
 *     d'enfants, qui empêche la colonne géante du 17/08/2026.
 *  2) `place` (pré-ordre) : attribue une position centrée à chaque nœud à partir de la largeur déjà
 *     connue de son sous-arbre, avance le curseur le long de l'axe des fratries (Y) pour le frère
 *     suivant.
 */
export function hostHierarchyPositions(
  nodeIds: string[],
  hostsEdges: TopologyEdgeLike[],
  anchor: { x: number; y: number } = { x: 0, y: 0 },
): Record<string, { x: number; y: number }> {
  const idSet = new Set(nodeIds);
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const e of hostsEdges) {
    // Un enfant n'a jamais deux parents dans ce modèle (une VM n'est jamais hébergée par deux
    // hôtes/clusters à la fois) — `parentOf.has` défend malgré tout contre une arête dupliquée/
    // corrompue plutôt que d'écraser silencieusement le premier parent trouvé.
    if (!idSet.has(e.source) || !idSet.has(e.target) || parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
    (childrenOf.get(e.source) ?? childrenOf.set(e.source, []).get(e.source)!).push(e.target);
  }
  const roots = nodeIds.filter((id) => !parentOf.has(id));

  // Tri barycentre (Sugiyama) : clé d'une feuille = son rang dans `nodeIds`, clé d'un nœud interne
  // = moyenne des clés de ses enfants — les fratries (et les racines entre elles) sont triées par
  // cette clé, en préservant la contiguïté des sous-arbres (donc la garantie zéro croisement).
  const entryIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const baryCache = new Map<string, number>();
  function barycenter(id: string): number {
    const cached = baryCache.get(id);
    if (cached !== undefined) return cached;
    baryCache.set(id, entryIndex.get(id) ?? 0); // garde anti-cycle corrompu, même esprit que parentOf.has
    const children = childrenOf.get(id) ?? [];
    const value =
      children.length === 0
        ? entryIndex.get(id) ?? 0
        : children.reduce((sum, c) => sum + barycenter(c), 0) / children.length;
    baryCache.set(id, value);
    return value;
  }
  for (const children of childrenOf.values()) children.sort((a, b) => barycenter(a) - barycenter(b));
  roots.sort((a, b) => barycenter(a) - barycenter(b));

  const positions: Record<string, { x: number; y: number }> = {};
  const widthCache = new Map<string, number>();
  /** "Largeur" du sous-arbre = combien d'unités il occupe le long de l'axe des FRATRIES (Y) — le
   * nom garde le vocabulaire "largeur/colonne" de l'algorithme d'origine (17/08/2026), seul l'axe
   * physique auquel il correspond a tourné de 90° (voir JSDoc de hostHierarchyPositions/le bloc de
   * constantes ci-dessus). */
  function subtreeWidthUnits(id: string): number {
    const cached = widthCache.get(id);
    if (cached !== undefined) return cached;
    const children = childrenOf.get(id) ?? [];
    let width: number;
    if (children.length === 0) width = 1;
    else if (children.length > HOST_TREE_MAX_LINE_CHILDREN && allChildrenAreLeaves(children, childrenOf)) {
      width = Math.min(HOST_TREE_MAX_GRID_LINES, Math.ceil(Math.sqrt(children.length)));
    } else width = children.reduce((sum, c) => sum + subtreeWidthUnits(c), 0);
    const clamped = Math.max(1, width);
    widthCache.set(id, clamped);
    return clamped;
  }

  /** Place `id` (et tout son sous-arbre) à partir de l'unité libre `startUnits` le long de l'axe
   * des fratries (Y) ; retourne la première unité libre APRÈS lui pour que le frère suivant
   * reprenne juste après. `depth` porte l'axe des NIVEAUX (X) — un parent est toujours une colonne
   * X entière à gauche de ses enfants, jamais au-dessus (voir JSDoc ci-dessus pour le pourquoi de
   * cette orientation horizontale, cohérente avec les ports Left/Right du 17/08/2026). */
  function place(id: string, depth: number, startUnits: number): number {
    const ownWidth = subtreeWidthUnits(id);
    const centerUnits = startUnits + ownWidth / 2;
    positions[id] = { x: anchor.x + depth * HOST_TREE_LEVEL_SPACING, y: anchor.y + centerUnits * HOST_TREE_SIBLING_SPACING };
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return startUnits + ownWidth;
    if (children.length > HOST_TREE_MAX_LINE_CHILDREN && allChildrenAreLeaves(children, childrenOf)) {
      const lines = Math.min(HOST_TREE_MAX_GRID_LINES, Math.ceil(Math.sqrt(children.length)));
      const gridStartUnits = centerUnits - lines / 2;
      children.forEach((child, index) => {
        // `line` avance le long de l'axe des fratries (Y, même axe que `centerUnits`) ; `extraLevel`
        // pousse plus loin le long de l'axe des niveaux (X) pour ne jamais chevaucher la colonne
        // suivante de la même grille repliée — mêmes indices que l'algorithme d'origine (`col`/`row`
        // avant rotation), juste réassignés au nouvel axe physique correspondant.
        const line = index % lines;
        const extraLevel = Math.floor(index / lines);
        positions[child] = {
          x: anchor.x + (depth + 1) * HOST_TREE_LEVEL_SPACING + extraLevel * HOST_TREE_GRID_LINE_SPACING,
          y: anchor.y + (gridStartUnits + line + 0.5) * HOST_TREE_SIBLING_SPACING,
        };
      });
    } else {
      let cursor = startUnits;
      for (const child of children) cursor = place(child, depth + 1, cursor);
    }
    return startUnits + ownWidth;
  }

  let cursor = 0;
  for (const root of roots) cursor = place(root, 0, cursor);
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

// --- Sous-graphe "recette" d'un template d'image (18/08/2026) -----------------------------------
// La recette (ImageTemplate#base + steps) devient un pipeline éditable dans le sous-graphe :
// nœuds SYNTHÉTIQUES frontend (même approche que ProcessNode ci-dessus — jamais des TopologyNode,
// jamais envoyés au backend), l'ordre visuel gauche -> droite = l'ordre réel d'exécution de steps[].

/** Données d'un nœud synthétique de la vue recette — voir buildTemplateRecipeGraph ci-dessous. */
export interface TemplateRecipeNodeData {
  role: "base" | "step" | "artifact-source";
  /** Ligne haute de la carte (ex : "Base", "Étape 2 — Paquets", nom du template source). */
  title: string;
  /** Résumé réel (templateCatalog.ts#stepSummary / templateBaseLabel) — jamais le contenu complet. */
  summary: string;
  /** Rôle "step" uniquement : index réel dans steps[] (= ordre d'exécution). */
  stepIndex?: number;
  stepType?: TemplateStep["type"];
  /** Rôle "artifact-source" uniquement : id réel du template producteur (drill-down/menu). */
  sourceTemplateId?: string;
}

/** Espacement horizontal entre deux maillons de la chaîne (cartes ~230px de large). */
export const RECIPE_COLUMN_SPACING = 300;
/** Décalage vertical d'un nœud "template source" au-dessus de l'étape artifact qui le consomme. */
export const RECIPE_SOURCE_OFFSET_Y = -170;

export function templateRecipeNodeId(role: TemplateRecipeNodeData["role"], key: string | number): string {
  return `recipe:${role}:${key}`;
}

function TemplateRecipeNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as TemplateRecipeNodeData;
  return (
    <div className={`topology-recipe-node topology-recipe-node--${d.role}${selected ? " is-selected" : ""}`} title={d.summary}>
      {d.role !== "base" && d.role !== "artifact-source" && (
        <Handle id="chain-in" type="target" position={Position.Left} className="topology-handle topology-handle--template" title="Étape précédente" />
      )}
      {d.role !== "artifact-source" && (
        <Handle id="chain-out" type="source" position={Position.Right} className="topology-handle topology-handle--template" title="Étape suivante" />
      )}
      {d.role === "step" && d.stepType === "artifact" && (
        <Handle id="artifact-in" type="target" position={Position.Top} className="topology-handle topology-handle--template" title="Artefact consommé" />
      )}
      {d.role === "artifact-source" && (
        <Handle id="artifact-out" type="source" position={Position.Bottom} className="topology-handle topology-handle--template" title="Artefact fourni" />
      )}
      <div className="topology-recipe-node__title">
        {typeof d.stepIndex === "number" && <span className="topology-recipe-node__index">{d.stepIndex + 1}</span>}
        <span>{d.title}</span>
      </div>
      <div className="topology-recipe-node__summary">{d.summary}</div>
    </div>
  );
}

export const TemplateRecipeNode = memo(TemplateRecipeNodeImpl);
export const templateRecipeNodeTypes = { templateRecipeNode: TemplateRecipeNode };

/**
 * Construit le pipeline React Flow de la recette d'un template : un nœud BASE à gauche, puis un
 * nœud par étape câblés en chaîne (ordre visuel = steps[]) ; chaque étape "artifact" reçoit en plus
 * une arête entrante cyan depuis un nœud représentant le template source (esthétique uses-artifact,
 * badge "artefact <nom>"). Fonction pure — les positions sont recalculées à chaque rendu, la
 * recette est un pipeline fixe, pas un canevas à disposition libre.
 */
export function buildTemplateRecipeGraph(
  template: ImageTemplate,
  options: { reducedMotion: boolean; templateNameById: Map<string, string> },
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const baseId = templateRecipeNodeId("base", "root");
  nodes.push({
    id: baseId,
    type: "templateRecipeNode",
    position: { x: 0, y: 0 },
    draggable: false,
    data: { role: "base", title: "Base", summary: templateBaseLabel(template.base) } satisfies TemplateRecipeNodeData as unknown as Record<string, unknown>,
  });

  const chainStyle = { stroke: "var(--accent-end)" } as const;
  let previousId = baseId;
  const sourceNodeByTemplateId = new Map<string, string>();
  template.steps.forEach((step, index) => {
    const stepId = templateRecipeNodeId("step", index);
    nodes.push({
      id: stepId,
      type: "templateRecipeNode",
      position: { x: (index + 1) * RECIPE_COLUMN_SPACING, y: 0 },
      draggable: false,
      data: {
        role: "step",
        title: STEP_TYPE_LABEL[step.type],
        summary: stepSummary(step),
        stepIndex: index,
        stepType: step.type,
      } satisfies TemplateRecipeNodeData as unknown as Record<string, unknown>,
    });
    edges.push({
      id: `recipe-chain:${index}`,
      source: previousId,
      target: stepId,
      sourceHandle: "chain-out",
      targetHandle: "chain-in",
      type: "linkEdge",
      animated: false,
      className: "topology-edge topology-edge--recipe-chain",
      style: chainStyle,
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent-end)", width: 16, height: 16 },
    });
    previousId = stepId;

    if (step.type === "artifact" && step.templateId) {
      // Un même template source consommé par plusieurs étapes ne produit qu'UN nœud (au-dessus de
      // sa première étape consommatrice), avec une arête par consommation.
      let sourceId = sourceNodeByTemplateId.get(step.templateId);
      if (!sourceId) {
        sourceId = templateRecipeNodeId("artifact-source", step.templateId);
        sourceNodeByTemplateId.set(step.templateId, sourceId);
        nodes.push({
          id: sourceId,
          type: "templateRecipeNode",
          position: { x: (index + 1) * RECIPE_COLUMN_SPACING, y: RECIPE_SOURCE_OFFSET_Y },
          draggable: false,
          data: {
            role: "artifact-source",
            title: options.templateNameById.get(step.templateId) ?? step.templateId,
            summary: "Template source — artefact injecté par cette étape",
            sourceTemplateId: step.templateId,
          } satisfies TemplateRecipeNodeData as unknown as Record<string, unknown>,
        });
      }
      const sourceLabel = options.templateNameById.get(step.templateId) ?? step.templateId;
      edges.push({
        id: `recipe-artifact:${index}`,
        source: sourceId,
        target: stepId,
        sourceHandle: "artifact-out",
        targetHandle: "artifact-in",
        type: "linkEdge",
        animated: !options.reducedMotion,
        className: "topology-edge topology-edge--uses-artifact",
        style: { stroke: "#22d3ee", strokeDasharray: "4 4" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#22d3ee", width: 16, height: 16 },
        data: { kindLabel: `artefact ${sourceLabel}` },
      });
    }
  });
  return { nodes, edges };
}

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

export interface GroupLabelPopoverProps {
  title: string;
  initialLabel: string;
  submitLabel: string;
  x: number;
  y: number;
  onSubmit: (label: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

/**
 * Popover de saisie du libellé d'un groupe — réutilisé pour "Regrouper" (label initial suggéré, voir
 * openCreateGroupPopover) ET pour "Renommer" un groupe existant (label initial = son nom actuel).
 * Même pattern que RenamePopover (TopologyGraph.tsx, un seul champ texte). Extrait ici (14/08/2026,
 * voir "posibiliter de refaire des groupes" dans le sous-graphe) pour que TopologyGraph.tsx ET
 * TopologySubGraphPanel.tsx partagent EXACTEMENT le même popover — jamais une seconde implémentation
 * qui pourrait diverger, même principe que le reste de ce fichier.
 */
export function GroupLabelPopover({ title, initialLabel, submitLabel, x, y, onSubmit, onClose }: GroupLabelPopoverProps) {
  const { ref, style } = useDismiss(onClose, x, y);
  const [label, setLabel] = useState(initialLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const result = await onSubmit(trimmed);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? "Échec de l'opération.");
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{title}</div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-group-label-input">Nom du groupe</label>
          <input
            id="graph-group-label-input"
            type="text"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !label.trim()}>
            {busy ? "…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
