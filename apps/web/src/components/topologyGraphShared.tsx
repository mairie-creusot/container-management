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
  type NodeProps,
} from "@xyflow/react";
import { IconBell, IconChevron, IconClose, IconFolder, IconGlobe, IconNetworks, IconPlus, IconVolumes } from "@/components/icons";
import {
  CAPABILITY_DEFS,
  CAPABILITY_PORT_META,
  KIND_ICON,
  NODE_CONTRACT,
  type AutomationTriggerStatus,
  type CapabilityId,
  type EdgeHealthInfo,
  type EdgeHealthState,
  type PortSpec,
} from "@/components/topologyNodeContract";
import type { TopologyEdge, TopologyEdgePort, TopologyGroup, TopologyNode, TopologyNodeAttachment } from "@/types";
import type { LifecycleAction } from "@/features/containers/containersSlice";

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
  KIND_ICON,
  MEMORY_ALERT_RATIO,
  MINIMAP_NODE_COLOR,
  NODE_CONTRACT,
  VOLUME_MOUNT_INFO,
  nutanixVmHostEdgeState,
  type CapabilityDef,
  type CapabilityId,
  type EdgeHealthState,
  type PortSpec,
} from "@/components/topologyNodeContract";

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
 * un groupe replié avec à la fois un port "network" ET un port "provide", tous deux Position.Right
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
 * network/volume), plus "hosts" (source = nœud host, ex: docker-local ; target = conteneur — voir
 * services/topology.ts) qui n'a lui aucun port propre (jamais glissé à la main) mais reste réel et doit rester VISIBLE une
 * fois le groupe replié plutôt que silencieusement masqué :
 *  - arête "mount" (source = volume, target = conteneur) : conteneur membre -> "volume-mount"
 *    (le groupe consomme un volume extérieur) ; volume membre -> "provide" (le groupe fournit un
 *    volume à un conteneur extérieur).
 *  - arête "network" (source = conteneur, target = network) : conteneur membre -> "network" (le
 *    groupe se connecte à un network extérieur) ; network membre -> "attach" (le groupe accueille
 *    un conteneur extérieur).
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
    else if (edge.kind === "network") capabilities.add(sourceIn ? "network" : "attach");
    else if (edge.kind === "hosts" && targetIn) capabilities.add("hosted-by");
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
  stopped: "var(--color-text-faint)",
};

export interface TopologyEdgeLike {
  source: string;
  target: string;
}

/**
 * Construit les arêtes React Flow (couleur/état/animation) depuis les TopologyEdge bruts — logique
 * partagée par le graphe principal ET le sous-graphe de dépendances, pour un rendu identique.
 * `sourceHandle`/`targetHandle` optionnels : utilisés par TopologyGraph.tsx quand une arête a été
 * redirigée vers un nœud de groupe replié (voir deriveGroupPorts ci-dessus) — un groupe peut porter
 * PLUSIEURS handles du même côté (ex: "network" ET "provide", tous deux source/Right), l'id du
 * handle cible devient alors nécessaire pour lever l'ambiguïté (React Flow ne peut plus déduire le
 * bon handle tout seul dès qu'il y en a plusieurs du même type sur un nœud).
 *
 * Deux axes visuels INDÉPENDANTS, chacun porteur d'une information réelle distincte (revu le
 * 13/08/2026 suite à un retour utilisateur — l'ancien système faisait porter au pointillé
 * essentiellement la même information que la couleur) :
 *  - COULEUR = santé/état réel de la ressource à une extrémité — jamais un axe de type de relation.
 *  - POINTILLÉ = confiance de connectivité RÉELLE, jamais une simple redite de la couleur : trait
 *    PLEIN = port publié sur l'hôte / placement vérifié en direct ; tirets fins = configuré mais
 *    non confirmé ; tirets larges = ressource arrêtée/inactive. Une arête "mount" reste
 *    structurelle (jamais de sonde active pertinente pour elle) : toujours pleine.
 *
 * MOTEUR GÉNÉRIQUE depuis la migration vers le contrat (17/08/2026) : quelle extrémité porte le
 * signal et comment il se projette sur couleur/pointillé est déclaré PAR KIND dans
 * NODE_CONTRACT[kind].edgeHealth (topologyNodeContract.tsx) — conteneur (healthStatus/
 * hasPublishedPort), VM Nutanix (nutanixVmHostEdgeState : placement confirmé/incertain, mêmes
 * détails que la légende), source d'automatisation (statut de déclencheur propagé)... Cette
 * fonction interroge la SOURCE puis la CIBLE de chaque arête et retient la première réponse — un
 * contrat se garde LUI-MÊME (edgeKind/role du contexte), ce moteur ne contient plus aucun
 * `if (kind === ...)` de plateforme. Une arête dont aucune extrémité ne répond (ex : cluster ->
 * hôte physique, deux nœuds "host" au contrat edgeHealth null — aucun signal de santé par hôte
 * disponible côté Prism Central) retombe sur le rendu neutre : gris "none", pointillé générique
 * par kind d'arête ci-dessous.
 *
 * Seuls les kinds D'ARÊTE (mount/network/hosts/automation-flow — une notion transverse aux
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
    // Port(s) réellement publié(s) sur l'hôte (voir TopologyEdgePort#publicPort, jamais déduit —
    // absent si Docker n'a mappé aucun port hôte pour ce conteneur) : seul signal d'activité
    // "confirmée" dont QUAI dispose sans sonde active à chaque rafraîchissement du graphe (une
    // vraie sonde TCP par arête, à chaque fetch, coûterait cher — voir services/automationEngine.ts
    // pour la sonde active RÉSERVÉE aux seules routes reverse-proxy explicitement surveillées).
    const hasPublishedPort = e.ports?.some((p) => p.publicPort !== undefined) ?? false;

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
        hasPublishedPort,
        automationUpstreamStatus: triggerStatusByNodeId.get(e.source) ?? "unknown",
      });
      if (edgeHealthInfo) break;
    }

    const state: EdgeHealthState = edgeHealthInfo?.state ?? "none";
    const color = EDGE_STATE_COLOR[state];
    // Pointillé : celui décidé par le contrat porteur du signal — sinon le défaut PAR KIND D'ARÊTE
    // (aucune extrémité ne répond) : mount/hosts structurels toujours pleins, "automation-flow" son
    // motif fixe distinctif (l'axe "port publié" n'a pas de sens pour lui), "network" retombe sur
    // l'axe de confiance générique (plein si port publié, tirets fins sinon — l'état ne peut être
    // "stopped" ici, ce cas n'existe que via un contrat qui a répondu).
    const strokeDasharray = edgeHealthInfo
      ? edgeHealthInfo.strokeDasharray
      : isMount || isHostsEdge
        ? undefined
        : e.kind === "automation-flow"
          ? "2 4"
          : hasPublishedPort
            ? undefined
            : "4 4";
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
        hasPublishedPort,
        ...(e.ports ? { ports: e.ports } : {}),
        ...(e.private !== undefined ? { private: e.private } : {}),
        ...(e.encrypted !== undefined ? { encrypted: e.encrypted } : {}),
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
  /** Arête "hosts" hôte physique -> VM Nutanix UNIQUEMENT (VM allumée sans erreur API, voir
   * buildTopologyEdges ci-dessus) : true = placement confirmé en direct, false = replié sur le
   * dernier hôte assigné/déclaré. Absent pour tout autre cas (VM éteinte/en erreur, cluster ->
   * hôte, conteneur...) — la couleur/le pointillé suffisent déjà à ces cas, pas de badge en plus. */
  nutanixPlacementConfirmed?: boolean;
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
  if (data.nutanixPlacementConfirmed !== undefined) {
    items.push(
      data.nutanixPlacementConfirmed
        ? { text: "Placement confirmé", tone: "good" }
        : { text: "Dernier hôte connu", tone: "warn" },
    );
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
        <LegendLineRow variant="solid" label="Confirmé (port publié / placement vérifié en direct)" />
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
  /** Bouton ＋ au survol d'une carte conteneur (picker Stockage/Variable/Secret) — injecté par
   * TopologyGraph.tsx uniquement pour un rôle operator+ ; absent = bouton non rendu. */
  onOpenAttachPicker?: (event: React.MouseEvent) => void;
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
    // VM Nutanix (voir isNutanixVm/topology-node__specs, GraphNodeImpl ci-dessous, 17/08/2026) —
    // mêmes raisons que cpuPercent/memBytes ci-dessus : réellement rendus, doivent invalider le memo.
    a.numVcpus === b.numVcpus &&
    a.memoryMib === b.memoryMib &&
    a.nutanixHostName === b.nutanixHostName &&
    attachmentsEqual(a.attachments, b.attachments) &&
    domainsEqual(a.domains, b.domains)
  );
}

function GraphNodeImpl({ data, selected }: NodeProps) {
  const node = data as unknown as TopologyNode & GraphNodeCallbacks;
  const Icon = KIND_ICON[node.kind];
  const isContainer = node.kind === "container";
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
  // Répartition des attachments (TopologyNode#attachments — VRAIES données Docker, jamais un
  // nouveau stockage) entre les deux rendus (Phase 2, 17/08/2026, maquette Railway validée par
  // l'utilisateur) : un VOLUME attaché devient un "tiroir" (sous-carte glissée SOUS la carte du
  // service, dépassant du bord inférieur, ton assourdi — voir .topology-node__drawers plus bas),
  // un NETWORK reste une "brique" inline comme avant (chez Railway, le tiroir est le stockage).
  const volumeAttachments = (node.attachments ?? []).filter((a) => a.kind === "volume");
  const networkAttachments = (node.attachments ?? []).filter((a) => a.kind === "network");
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
      <div className="topology-node__subtitle">{node.subtitle}</div>
      {isNutanixVm && (typeof node.numVcpus === "number" || typeof node.memoryMib === "number" || !!node.nutanixHostName) && (
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
      {isContainer && networkAttachments.length > 0 && (
        // "Briques" — désormais les NETWORKS mono-conteneur uniquement (voir
        // TopologyNode#attachments) : les volumes attachés sont passés en "tiroirs" sous la carte
        // (voir le bloc .topology-node__drawers plus bas — Phase 2 du 17/08/2026, maquette Railway
        // validée : le tiroir y est réservé au STOCKAGE, un network reste une propriété inline du
        // service). `nodrag`/`nopan` (classes React Flow) évitent qu'un clic ici ne fasse glisser
        // le nœud entier ou ne panne le canevas ; `stopPropagation` évite en plus de sélectionner/
        // désélectionner le nœud conteneur en même temps qu'on ouvre le détail de la brique.
        <div className="topology-node__attachments">
          {networkAttachments.map((attachment) => {
            const AttachmentIcon = ATTACHMENT_ICON[attachment.kind];
            return (
              <button
                key={attachment.id}
                type="button"
                className={`topology-brick topology-brick--${attachment.kind} nodrag nopan`}
                title={`Network ${attachment.label}`}
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
      {/* ＋ révélé au survol (CSS) — conteneurs uniquement : les VMs Nutanix n'ont pas encore de
          backend d'attache, pas de bouton qui mentirait. Rendu seulement si le callback est
          injecté (operator+, voir GraphNodeCallbacks). */}
      {isContainer && !isCompact && node.onOpenAttachPicker && (
        <button
          type="button"
          className="topology-node__attach-btn nodrag nopan"
          title="Attacher un stockage, une variable ou un secret"
          onClick={(event) => {
            event.stopPropagation();
            node.onOpenAttachPicker?.(event);
          }}
        >
          <IconPlus />
        </button>
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
      {isContainer && !isCompact && volumeAttachments.length > 0 && (
        // "Tiroirs" des VOLUMES attachés (Phase 2, 17/08/2026 — capture Railway de référence
        // validée par l'utilisateur) : chaque volume monté par CE seul conteneur est une SOUS-CARTE
        // glissée SOUS la carte du service (position absolue sous le bord inférieur, ton assourdi,
        // z-index négatif pour paraître passer DERRIÈRE la carte — .topology-node ne crée pas de
        // stacking context, le wrapper React Flow oui, donc le tiroir se place bien entre le fond
        // du canevas et la carte). Ce sont les MÊMES données réelles (TopologyNode#attachments,
        // Mounts Docker) et les MÊMES callbacks (détail/menu contextuel) que les briques d'avant —
        // seul le rendu change. Masqués en zoom compact (comme badges/briques/métriques : sous le
        // seuil, la carte se réduit à icône + statut). Animation d'apparition : voir
        // .topology-drawer dans topology.css (désactivée sous prefers-reduced-motion).
        <div className="topology-node__drawers">
          {volumeAttachments.map((attachment, drawerIndex) => (
            <button
              key={attachment.id}
              type="button"
              className="topology-drawer nodrag nopan"
              // Empilement : chaque tiroir supplémentaire glisse un cran plus bas ET un cran plus
              // "derrière" — l'index pilote le z-index négatif (le 1er tiroir devant le 2e, etc.),
              // le décalage vertical est porté par le flux normal du conteneur flex.
              style={{ zIndex: -1 - drawerIndex }}
              title={`Volume ${attachment.label}${
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
              <span className="topology-drawer__icon">
                <IconVolumes />
              </span>
              <span className="topology-drawer__label">{attachment.label}</span>
              {attachment.destination && <span className="topology-drawer__destination">{attachment.destination}</span>}
              {attachment.readOnly && <span className="topology-drawer__ro">ro</span>}
            </button>
          ))}
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
 * conteneurs -> 2 networks, cas réel constaté).
 *
 * Algorithme (bipartite/DAG simple, suffisant pour la taille réelle d'un groupe — jamais un
 * vrai risque de cycle, `edges` ne vient que de container<->network/volume, jamais l'inverse) :
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
  // Espacement TRÈS généreux (retour utilisateur du 13/08/2026, deux fois confirmé : les cartes se
  // touchaient encore avec un espacement plus timide) — une carte conteneur avec plusieurs badges
  // ET plusieurs attachements volumes (ex : quai-dev-ldap-1, 2 badges + 2 volumes) peut dépasser
  // 300px de hauteur réelle. Mieux vaut trop d'espace par défaut que des cartes qui se chevauchent :
  // l'utilisateur peut de toute façon resserrer lui-même et mémoriser sa propre disposition ensuite
  // (voir persistance côté TopologySubGraphPanel.tsx).
  const LAYER_WIDTH = 420;
  const ROW_HEIGHT = 320;
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
/** Distance (px) entre deux NŒUDS D'UNE MÊME FRATRIE le long de l'axe perpendiculaire à l'arbre
 * (axe Y) — même largeur de référence que LAYER_WIDTH ci-dessus (layeredGroupPositions), une carte
 * .topology-node fait 260px de large/haut. */
const HOST_TREE_SIBLING_SPACING = 300;
/** Distance (px) SUPPLÉMENTAIRE le long de l'axe des niveaux (X) entre deux "lignes" d'une grille
 * d'enfants repliée (voir HOST_TREE_MAX_LINE_CHILDREN ci-dessous) — une carte "nutanix-vm" reste
 * compacte (un seul port, peu de badges), suffisant pour ne jamais chevaucher la colonne suivante
 * de la même grille. */
const HOST_TREE_GRID_LINE_SPACING = 210;
/** Distance (px) entre deux NIVEAUX de la hiérarchie (cluster -> hôte -> VM), le long de l'axe X —
 * plus généreuse que HOST_TREE_GRID_LINE_SPACING seul : une carte "host" (CPU/mémoire/hyperviseur
 * réels) affiche souvent plus de contenu qu'une carte "nutanix-vm". */
const HOST_TREE_LEVEL_SPACING = 260;
/** Au-delà de ce nombre d'enfants DIRECTS et tous eux-mêmes sans enfant propre (des feuilles, ex :
 * des VMs — jamais un hôte, qui a lui-même des VMs dessous), on arrête de les aligner sur une seule
 * ligne (c'était exactement le bug du 17/08/2026 : jusqu'à 29 VMs en une colonne géante) — ils sont
 * repliés en grille compacte plutôt qu'empilés à l'infini dans une seule direction. */
const HOST_TREE_MAX_LINE_CHILDREN = 5;
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
 * Algorithme classique en deux passes (garanti sans chevauchement, PAS de minimisation de
 * croisements au-delà de ce que le centrage parent/enfant apporte déjà — largement suffisant pour
 * la profondeur réelle de ce graphe, 2-3 niveaux) — IDENTIQUE dans son principe à la version
 * verticale d'origine (17/08/2026, "29 VMs empilées en une colonne géante"), seul l'axe change :
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
