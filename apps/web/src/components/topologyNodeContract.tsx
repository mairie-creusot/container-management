import { Position } from "@xyflow/react";
import {
  IconBackup,
  IconBell,
  IconBranch,
  IconClock,
  IconContainers,
  IconGitOps,
  IconHostMachine,
  IconImages,
  IconPlay,
  IconStack,
  IconTopology,
  IconVm,
  IconVolumes,
} from "@/components/icons";
import {
  CAPABILITY_DEFS,
  CORE_CONTRACT_SOURCE,
  matchesNodeState,
  nodeContractFor,
  registerNodeContract,
  tableWithRuntimeFallback,
  type AutomationTriggerStatus,
  type CapabilityId,
  type EdgeHealthContext,
  type EdgeHealthInfo,
  type EdgeHealthState,
  type NodeContract,
  type NodeMenuActionSpec,
  type QuickLifecycleAction,
} from "@/components/topologyNodeRegistry";
import type { IacEngine, TopologyHostKind, TopologyNode, TopologyNodeKind } from "@/types";

/**
 * Vocabulaire du contrat (capacités/ports, santé d'arête, actions déclarées) et REGISTRE :
 * topologyNodeRegistry.tsx. Ré-exports ci-dessous — mêmes noms publics qu'avant l'ouverture du
 * registre, aucun import à modifier chez les consommateurs.
 */
export {
  CAPABILITY_DEFS,
  CAPABILITY_PORT_META,
  PORT_COLOR_TOKENS,
  UNKNOWN_NODE_CONTRACT,
  isNodeKindRegistered,
  matchesNodeState,
  nodeContractFor,
  nodeContractRefusal,
  nodeContractSource,
  registerNodeContract,
  registeredNodeKinds,
  unregisterNodeContract,
  validateNodeContract,
  type AutomationTriggerStatus,
  type CapabilityDef,
  type CapabilityId,
  type EdgeHealthContext,
  type EdgeHealthInfo,
  type EdgeHealthState,
  type NodeActionSeverity,
  type NodeContract,
  type NodeContractIssue,
  type NodeContractRegistration,
  type NodeMenuActionSpec,
  type NodeStateCondition,
  type NodeStateValue,
  type PortSpec,
  type QuickLifecycleAction,
  type QuickLifecycleActionSpec,
  type ResourceAlertsSpec,
} from "@/components/topologyNodeRegistry";

/**
 * CONTRAT GÉNÉRIQUE DES NŒUDS DU GRAPHE DE TOPOLOGIE — registre déclaratif UNIQUE (17/08/2026).
 *
 * Pourquoi ce fichier existe (diagnostic confirmé après une série de bugs corrigés au coup par
 * coup le même jour — ports Top/Bottom incohérents pour Nutanix, couleur de santé câblée
 * uniquement pour kind === "container", règle de rattachement changée trois fois) : chaque type de
 * nœud du graphe était un FORK du précédent, pas une instance d'un contrat commun. Ports, couleur
 * de santé, alertes de ressources et actions de menu contextuel étaient des choix codés par type
 * de nœud, dispersés entre topologyGraphShared.tsx (NODE_CAPABILITIES, CAPABILITY_PORT_META,
 * nutanixVmHostEdgeState, computeNodeResourceAlerts) et TopologyGraph.tsx (nodeMenuItems,
 * COLUMN_X...) — chaque nouvelle plateforme (bientôt Proxmox/VMware/SSH) aurait refait les mêmes
 * erreurs.
 *
 * Désormais : TOUT ce qui est spécifique à un `kind` est déclaré comme DONNÉES (NODE_CONTRACT
 * ci-dessous pour les types du CŒUR, le registre de topologyNodeRegistry.tsx pour ceux qu'un
 * greffon ajoute à l'exécution), consommées par des moteurs de rendu génériques qui ne contiennent
 * plus AUCUN `if (kind === ...)` de plateforme :
 *  - GraphNode (topologyGraphShared.tsx) pose les Handles depuis `ports` — y compris les Handles
 *    d'automatisation, autrefois posés par un JSX conditionnel hors table (comportement implicite
 *    rendu explicite par ce chantier).
 *  - buildTopologyEdges (topologyGraphShared.tsx) interroge `edgeHealth` de chaque extrémité pour
 *    la couleur/le pointillé d'une arête — la logique conteneur (healthStatus) et
 *    la logique Nutanix (nutanixVmHostEdgeState) sont deux implémentations de la MÊME interface.
 *  - computeNodeResourceAlerts (topologyGraphShared.tsx) lit `resourceAlerts` (seuils déclaratifs)
 *    — un kind sans métriques déclare `null`, jamais un `if kind === "container"` implicite.
 *  - nodeMenuItems (TopologyGraph.tsx/TopologySubGraphPanel.tsx) rend `menuItems` via
 *    buildNodeMenuItems ci-dessous — le contrat déclare LA LISTE {id, label, danger?, visible?},
 *    l'appelant injecte les callbacks réels par id d'action (lui seul a accès à dispatch/confirm).
 *
 * Pour ajouter une future plateforme (Proxmox/VMware/SSH) : ajouter son kind à TopologyNodeKind
 * (types.ts) puis UNE entrée ici — le compilateur signale chaque champ à décider explicitement,
 * aucun moteur de rendu à modifier. Un GREFFON, lui, n'a pas ce luxe (son kind n'existe pas dans
 * l'union figée) : il enregistre son contrat à l'exécution via registerNodeContract
 * (topologyNodeRegistry.tsx), qui le REFUSE s'il est incomplet.
 *
 * ZÉRO changement visuel/fonctionnel : chaque valeur ci-dessous est la copie exacte du comportement
 * dispersé qu'elle remplace (les commentaires historiques "pourquoi" sont conservés avec elle).
 */

// --- Câblage manuel au fil (React Flow onConnect) ------------------------------------------------

/** Action réelle déclenchée au drop d'un fil — l'implémentation (popovers pré-remplis) reste chez
 * l'appelant (TopologyGraph.tsx#connectionWireHandlers), même principe que buildNodeMenuItems.
 * "connect-container-to-network" a été retiré le 24/08/2026 : un réseau n'étant plus un nœud, un
 * fil n'a plus de cible à viser — la connexion passe par le ＋ / le menu du conteneur. */
export type ConnectionActionId = "mount-volume-on-container";

export type CapabilityPairKey = `${CapabilityId}->${CapabilityId}`;

export function capabilityPairKey(source: CapabilityId, target: CapabilityId): CapabilityPairKey {
  return `${source}->${target}`;
}

/**
 * Paire de capacités (bout SOURCE du fil -> bout TARGET, toujours normalisée dans ce sens par
 * React Flow quel que soit le bout où le geste a commencé) -> action réelle. Seules les paires avec
 * un vrai backend y figurent ; une paire interactive absente de cette table retombe sur un message
 * d'info non bloquant (TopologyGraph.tsx#handleConnect). Les paires automation-* passent par le
 * chemin dédié de handleConnect (jamais par cette table), les paires non interactives (hosts)
 * gardent leur infoMessage.
 */
export const CONNECTION_ACTIONS: Partial<Record<CapabilityPairKey, ConnectionActionId>> = {
  // volume -> conteneur : MountVolumePopover pré-rempli (recréation confirmée par l'utilisateur).
  "provide->volume-mount": "mount-volume-on-container",
};

// --- Santé des arêtes (couleur/pointillé) --------------------------------------------------------

// Types (EdgeHealthState/EdgeHealthInfo/EdgeHealthContext) : topologyNodeRegistry.tsx, ré-exportés
// en tête de ce fichier. Restent ici les implémentations RÉELLES de chaque plateforme, projetées
// sur la MÊME palette, jamais un système de couleurs parallèle (retour utilisateur du 17/08/2026 :
// "j'ai impression que le systeme n'est pas coherent entre nutanyx et le systeme de container c'est
// comme si la logique etait seprarer en deux").

/**
 * État réel d'un déclencheur d'automatisation projeté sur la même palette que EDGE_STATE_COLOR —
 * "ok" partage le vert "healthy", "failing" le rouge "unhealthy", "unknown" (jamais encore évalué)
 * le gris "none" : un SEUL système de couleurs pour tout le graphe.
 */
export function automationTriggerEdgeState(status: AutomationTriggerStatus): EdgeHealthState {
  if (status === "ok") return "healthy";
  if (status === "failing") return "unhealthy";
  return "none";
}

/**
 * État réel + pointillé d'une arête "hosts" hôte physique AHV -> VM (voir services/topology.ts#
 * getNutanixTopologyParts), `vmNode` étant le nœud `kind: "nutanix-vm"` à l'extrémité CIBLE de
 * cette arête — MÊME grille couleur/pointillé que les arêtes conteneur (EDGE_STATE_COLOR,
 * topologyGraphShared.tsx), jamais un second système parallèle (retour utilisateur du 17/08/2026,
 * voir en-tête de section) :
 *  - VM éteinte (`status === "stopped"`) -> "stopped" (gris), tirets larges — EXACTEMENT le même
 *    code visuel qu'un conteneur arrêté. Prime sur tout le reste : un arrêt volontaire n'est
 *    jamais une panne (jamais rouge) ni un placement "incertain" (jamais orange).
 *  - VM allumée avec un VRAI état d'erreur Prism Central (`nutanixApiError`, DISTINCT du simple
 *    power_state) -> "unhealthy" (rouge), réservé à ce cas précis.
 *  - VM allumée, placement CONFIRMÉ EN DIRECT (`nutanixHostPlacementConfirmed === true`) ->
 *    "healthy" (vert), plein.
 *  - VM allumée, placement REPLIÉ sur le dernier hôte ASSIGNÉ/déclaré -> "starting" (orange,
 *    réutilisé pour "pas encore confirmé/incertain"), tirets fins.
 *  - Tout le reste (power_state "unknown") -> "none" (gris), plein : aucun signal exploitable.
 * Cluster -> hôte physique : jamais concerné (le contrat "nutanix-vm" ne répond que pour le bout
 * TARGET d'une arête "hosts", voir NODE_CONTRACT ci-dessous) — reste neutre/gris/plein.
 * Exportée telle quelle (pas seulement embarquée dans le contrat) : fonction pure historique,
 * verrouillée par topologyGraphShared.test.ts.
 */
export function nutanixVmHostEdgeState(vmNode: TopologyNode): { state: EdgeHealthState; strokeDasharray: string | undefined } {
  if (vmNode.status === "stopped") return { state: "stopped", strokeDasharray: "2 8" };
  // Pointillé de confiance de placement, indépendant de la couleur ci-dessous (même principe que
  // la santé d'un conteneur) : "4 4" (tirets fins) tant que le placement n'est pas
  // confirmé en direct, `undefined` (plein) dès qu'il l'est — s'applique aussi bien à "unhealthy"
  // qu'à "healthy"/"starting", ces deux axes restant volontairement indépendants.
  const strokeDasharray = vmNode.nutanixHostPlacementConfirmed ? undefined : "4 4";
  if (vmNode.nutanixApiError) return { state: "unhealthy", strokeDasharray };
  if (vmNode.status === "running") return { state: vmNode.nutanixHostPlacementConfirmed ? "healthy" : "starting", strokeDasharray };
  return { state: "none", strokeDasharray: undefined };
}

/**
 * État + pointillé d'une arête "protects" (VM Nutanix -> appliance HYCU), lus sur la VM SOURCE —
 * même palette/grammaire que tout le reste du graphe, jamais un second système :
 *  - "protected" -> vert plein : HYCU la sauvegarde et ne signale rien d'anormal ;
 *  - "non-compliant" -> rouge : HYCU renvoie une conformité hors des valeurs saines (valeur brute
 *    reportée telle quelle sur la carte, jamais réinterprétée) ;
 *  - "never-backed-up" -> orange, tirets fins : protégée mais aucune sauvegarde datée à ce jour ;
 *  - tout le reste (dont "unprotected", qui ne produit de toute façon aucune arête) -> gris.
 */
export function hycuProtectionEdgeState(vmNode: TopologyNode): EdgeHealthInfo {
  if (vmNode.hycuProtection === "protected") return { state: "healthy", strokeDasharray: undefined };
  if (vmNode.hycuProtection === "non-compliant") return { state: "unhealthy", strokeDasharray: undefined };
  if (vmNode.hycuProtection === "never-backed-up") return { state: "starting", strokeDasharray: "4 4" };
  return { state: "none", strokeDasharray: undefined };
}

/** Badge de protection à afficher sur une carte de VM Nutanix — `null` tant que HYCU ne dit RIEN
 * de cette VM (jamais un "non sauvegardée" déduit d'un silence). `tone` reprend les variantes de
 * .topology-badge (topology.css). */
export function hycuProtectionBadge(node: TopologyNode): { label: string; tone: "ok" | "warning" | "critical"; title: string } | null {
  switch (node.hycuProtection) {
    case "protected":
      return { label: "Protégée", tone: "ok", title: `Sauvegardée par HYCU${node.hycuPolicyName ? ` — politique ${node.hycuPolicyName}` : ""}` };
    case "non-compliant":
      return {
        label: "Non conforme",
        tone: "critical",
        title: `Conformité rapportée par HYCU : ${node.hycuComplianceStatus ?? "valeur non conforme"}`,
      };
    case "never-backed-up":
      return { label: "Jamais sauvegardée", tone: "warning", title: "Assignée à une politique HYCU, mais aucune date de sauvegarde rapportée" };
    case "unprotected":
      return { label: "Non protégée", tone: "warning", title: "VM connue de HYCU mais assignée à aucune politique de sauvegarde" };
    default:
      return null;
  }
}

// --- Module métier porté par un nœud (19/08/2026) ------------------------------------------------

/**
 * Un "module" est la vue métier du service qui tourne RÉELLEMENT sur un nœud (3CX sur la VM
 * HDV3CX, Active Directory/DNS sur le contrôleur de domaine, DHCP…) — voir
 * apps/api/src/services/serviceModules.ts et features/serviceModules/ côté web.
 *
 * Volontairement PAS une entrée de NODE_CONTRACT : un module est lié à une INSTANCE de nœud
 * (telle VM précise), jamais à un `kind` entier — deux VMs Nutanix identiques en tout point n'ont
 * aucune raison de porter le même service. Le contrat reste donc indexé par kind pour ce qui est
 * structurel (ports, santé, actions), et ce couple de helpers couvre ce qui est propre à
 * l'instance, en gardant la déclaration du rendu (badge, entrée de menu) au même endroit que le
 * reste — même patron exact que hycuProtectionBadge ci-dessus.
 */
export interface NodeServiceModuleBinding {
  /** Libellé HUMAIN du module ("Active Directory / DNS"), jamais son id technique. */
  moduleLabel: string;
  /** "automatic" = correspondance VÉRIFIÉE côté serveur (nom/IP réelle du nœud) ; "manual" =
   * liaison explicitement posée par un operator/admin. */
  origin: "manual" | "automatic";
  /** origin "automatic" : la valeur exacte qui a permis la correspondance (preuve affichée en
   * infobulle — jamais une liaison opaque que l'utilisateur ne pourrait pas vérifier). */
  matchedOn?: string;
}

/** Pastille DISCRÈTE "module <label>" d'une carte de nœud lié — `null` pour un nœud sans module
 * (comportement du graphe strictement inchangé, aucune pastille par défaut). Ton "neutral" :
 * porter un module n'est ni une alerte ni une réussite, juste une information de nature. */
export function serviceModuleBadge(
  binding: NodeServiceModuleBinding | undefined,
): { label: string; tone: "neutral"; title: string } | null {
  if (!binding) return null;
  return {
    label: `module ${binding.moduleLabel}`,
    tone: "neutral",
    title:
      binding.origin === "automatic"
        ? `Module ${binding.moduleLabel} — liaison automatique vérifiée${binding.matchedOn ? ` (${binding.matchedOn})` : ""}. Double-clic pour l'ouvrir.`
        : `Module ${binding.moduleLabel} — liaison posée manuellement. Double-clic pour l'ouvrir.`,
  };
}

// --- Alertes de ressources (CPU/mémoire) ---------------------------------------------------------

/** Seuil réel (pourcentage, cohérent avec TopologyNode#cpuPercent) à partir duquel un nœud
 * `running` déclenche une alerte "CPU élevé" — réévalué à chaque rafraîchissement de la topologie,
 * aucun débounce/hystérésis pour ce premier lot : la carte apparaît/disparaît avec l'état réel. */
export const CPU_ALERT_THRESHOLD_PERCENT = 90;

/** Même principe, mais pour la mémoire — RATIO (pas un seuil absolu en octets, sans aucun sens
 * comparé d'un conteneur à l'autre) de `memBytes` sur `memoryLimitBytes`. Contrairement au CPU
 * (plafond naturel implicite, 100% par cœur), la mémoire n'a AUCUN plafond réel sans une limite
 * explicitement configurée à la création (voir services/docker.ts#ContainerHealthAndLimits) —
 * cette alerte ne se déclenche donc QUE quand `memoryLimitBytes` existe réellement, jamais un
 * seuil absolu inventé en son absence (voir computeNodeResourceAlerts, topologyGraphShared.tsx). */
export const MEMORY_ALERT_RATIO = 0.9;

// --- Actions du menu contextuel ------------------------------------------------------------------

/**
 * Ids d'actions du CŒUR — le contrat déclare QUELLES actions existent pour un kind (liste
 * ordonnée, libellé, niveau de danger, condition de visibilité sur l'état réel du nœud) ;
 * l'IMPLÉMENTATION (dispatch/confirm/popovers) reste injectée par l'appelant via buildNodeMenuItems
 * ci-dessous, seul à avoir accès aux hooks Redux/au state du composant. Préfixés par kind : deux
 * kinds différents n'exécutent jamais le même code pour un même verbe (ex : "Supprimer" un
 * conteneur passe par runContainerAction, une VM par TopologyNodeDetailPanel uniquement — jamais
 * fusionnés). Un greffon déclare ses propres ids (NodeMenuActionSpec#id est une chaîne libre) : le
 * compilateur ne peut plus les connaître, seul le préfixe par kind évite les collisions.
 */
export type NodeMenuActionId =
  | "container-stop"
  | "container-start"
  | "container-restart"
  | "container-rename"
  | "container-connect-network"
  | "container-attach"
  | "container-remove"
  | "nutanix-vm-stop"
  | "nutanix-vm-restart"
  | "nutanix-vm-start"
  | "nutanix-vm-add-disk"
  | "nutanix-vm-add-nic"
  | "nutanix-vm-edit-compute"
  | "volume-mount-on-container"
  | "volume-remove"
  | "host-add-environment"
  | "host-create-vm"
  | "automation-node-remove"
  | "image-template-build"
  | "image-template-view-builds"
  | "image-template-deploy-vm"
  | "image-template-create-container"
  | "image-template-remove"
  // Appliance HYCU : navigation/consultation UNIQUEMENT — QUAI n'expose AUCUNE mutation vers
  // l'appliance réelle (pas de "lancer une sauvegarde" tant qu'aucune route backend n'existe).
  | "hycu-open-page"
  | "hycu-view-jobs"
  | "hycu-configure";

/** Entrée de menu d'un kind du CŒUR — même forme déclarative que celle d'un greffon
 * (NodeMenuActionSpec, topologyNodeRegistry.tsx), avec l'id restreint à l'union ci-dessus : une
 * faute de frappe dans NODE_CONTRACT reste une erreur de compilation. */
export type CoreMenuActionSpec = Omit<NodeMenuActionSpec, "id"> & { id: NodeMenuActionId };

/** Table id d'action -> callback réel. Les ids du cœur restent proposés en autocomplétion ; la
 * seconde moitié (index libre) accepte l'id d'une action déclarée par un greffon. */
export type NodeActionHandlers = Partial<Record<NodeMenuActionId, () => void>> & Partial<Record<string, () => void>>;

/**
 * Rend les actions déclarées par le contrat de `node.kind` en items de menu concrets — l'appelant
 * fournit `handlers`, une table PARTIELLE id d'action -> callback réel : une action déclarée mais
 * sans handler est simplement omise (cas assumé : TopologySubGraphPanel.tsx n'implémente
 * volontairement qu'un sous-ensemble — pas de "Renommer"/"Connecter à un network…" dans le
 * sous-graphe, comportement historique inchangé par cette migration), jamais un item mort qui ne
 * ferait rien au clic. Le résultat est structurellement assignable à ContextMenuItem[]
 * (ContextMenu.tsx) sans dépendre de ce composant ici. Un kind non enregistré n'a aucune action :
 * menu vide, jamais une exception.
 */
export function buildNodeMenuItems(
  node: TopologyNode,
  handlers: NodeActionHandlers,
): { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] {
  const specs = nodeContractFor(node.kind).menuItems;
  const resolved = typeof specs === "function" ? specs(node) : specs;
  const items: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] = [];
  for (const spec of resolved) {
    if (!matchesNodeState(node, spec.when)) continue;
    if (spec.visible && !spec.visible(node)) continue;
    // Une entrée désactivée est incluse sans handler (aucune action par définition).
    if (spec.disabled) {
      items.push({ label: spec.label, disabled: true, onClick: () => {} });
      continue;
    }
    const handler = handlers[spec.id];
    if (!handler) continue;
    // Seul "destructive" passe en rouge — voir NodeActionSeverity (topologyNodeRegistry.tsx).
    items.push({ label: spec.label, ...(spec.severity === "destructive" ? { danger: true } : {}), onClick: handler });
  }
  return items;
}

// --- Moteurs Infra-as-code (OpenTofu/Ansible/Packer) — déclinaison PAR MOTEUR du kind
// "iac-workspace" -------------------------------------------------------------------------------

/**
 * Ce qu'un MOTEUR IaC précis décline du contrat du kind "iac-workspace" — le moteur réel d'un
 * workspace est porté par TopologyNode#iacEngine (services/topology.ts#getIacWorkspaceNodes, champ
 * dédié, jamais déduit du sous-titre). Aujourd'hui les trois moteurs partagent volontairement la
 * même icône (IconStack — décision documentée sur l'entrée "iac-workspace" ci-dessous) et
 * n'exposent AUCUNE action de menu depuis le graphe (les runs réels se pilotent depuis le panneau
 * de détail du nœud, TopologyNodeDetailPanel.tsx — comportement historique, inchangé par cette
 * passe de structure) : chaque entrée est donc vide, mais EXPLICITE — ajouter en Phase 2 une
 * action par moteur (ex : "Lancer plan/apply" pour OpenTofu, "Lancer le playbook" pour Ansible,
 * "Builder l'image" pour Packer) se fera en déclarant l'id + le libellé ici et son handler dans
 * TopologyGraph.tsx, sans toucher au moteur de rendu.
 */
export interface IacEngineContract {
  /** Actions de menu SPÉCIFIQUES à ce moteur, ajoutées à la suite de celles du kind — [] pour les
   * trois moteurs dans cette passe (zéro changement visible). */
  menuItems: CoreMenuActionSpec[];
}

export const IAC_ENGINE_CONTRACT: Record<IacEngine, IacEngineContract> = {
  tofu: { menuItems: [] },
  ansible: { menuItems: [] },
  packer: { menuItems: [] },
};

// --- Le contrat lui-même -------------------------------------------------------------------------

/** L'interface NodeContract vit dans topologyNodeRegistry.tsx (partagée avec les greffons) — les
 * entrées du CŒUR se déclarent avec des ids d'action restreints à NodeMenuActionId. */
export type CoreNodeContract = Omit<NodeContract, "menuItems"> & {
  menuItems: CoreMenuActionSpec[] | ((node: TopologyNode) => CoreMenuActionSpec[]);
};

/** Santé "conteneur" — extrémité conteneur d'une arête "mount" (volume partagé <-> conteneur) ou
 * "hosts" (Docker local -> conteneur). "stopped" prime sur healthStatus : un conteneur arrêté n'a
 * plus de healthcheck qui tourne, ce n'est pas une panne (arrêt souvent volontaire) donc pas rouge,
 * mais clairement "injoignable". Les deux kinds d'arête touchant un conteneur sont STRUCTURELS
 * (aucune sonde active pertinente) : trait toujours plein, seule la couleur bouge — comportement
 * historique de buildTopologyEdges, conservé tel quel. */
function containerEdgeHealth(node: TopologyNode, ctx: EdgeHealthContext): EdgeHealthInfo | null {
  // Une arête "automation-flow" ne lit JAMAIS un conteneur (son signal vient de la propagation de
  // statut de déclencheur, chemin dédié) — comportement historique : buildTopologyEdges traitait
  // isAutomationFlowEdge avant même de chercher un conteneur aux extrémités.
  if (ctx.edgeKind === "automation-flow") return null;
  const state: EdgeHealthState = node.status !== "running" ? "stopped" : (node.healthStatus ?? "none");
  return { state, strokeDasharray: undefined };
}

/** Santé "source d'automatisation" (déclencheur OU condition héritière) — répond UNIQUEMENT comme
 * SOURCE d'une arête "automation-flow" : c'est toujours la source qui porte le signal propagé
 * (comportement historique de buildTopologyEdges : `triggerStatusByNodeId.get(e.source)`), la
 * cible n'est jamais consultée. Motif "2 4" fixe : l'axe pointillé "port publié" n'a aucun sens
 * pour ce kind d'arête, un motif distinctif constant le remplace. */
function automationSourceEdgeHealth(_node: TopologyNode, ctx: EdgeHealthContext): EdgeHealthInfo | null {
  if (ctx.edgeKind !== "automation-flow" || ctx.role !== "source") return null;
  return { state: automationTriggerEdgeState(ctx.automationUpstreamStatus), strokeDasharray: "2 4" };
}

/** Contrats des types de nœud du CŒUR — totalité toujours vérifiée par le compilateur pour EUX
 * (`Record<TopologyNodeKind, …>`) ; les types d'un greffon vivent dans le registre. */
const NODE_CONTRACT_CORE: Record<TopologyNodeKind, CoreNodeContract> = {
  container: {
    icon: IconContainers,
    minimapColor: "#3b6fef",
    defaultColumnX: 340,
    // Plus de port "network" (retiré le 24/08/2026) : un réseau n'est plus un nœud, ce Handle
    // n'aurait plus aucune cible à viser — la connexion à un réseau passe par le ＋ / le menu.
    ports: [
      {
        id: "volume-mount",
        capability: "volume-mount",
        handleType: "target",
        position: Position.Left,
        label: "Volume (lecture seule)",
        colorToken: "volume",
      },
      // Cible de l'arête "hosts" Docker local -> conteneur (buildTopologyEdges ancre chaque arête
      // sur le port dont la capacité correspond à son kind).
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
    ],
    edgeHealth: containerEdgeHealth,
    automationStatusSeed: null,
    // Seul kind avec des métriques d'utilisation live (cpuPercent/memBytes réels, docker.ts#
    // readContainerUsage) — les seuils/le pourquoi de chaque valeur : voir
    // CPU_ALERT_THRESHOLD_PERCENT/MEMORY_ALERT_RATIO ci-dessus.
    resourceAlerts: { cpuThresholdPercent: CPU_ALERT_THRESHOLD_PERCENT, memoryRatio: MEMORY_ALERT_RATIO },
    menuItems: [
      // Démarrer/Arrêter mutuellement exclusifs selon l'état RÉEL — même règle qu'avant migration
      // (TopologyGraph.tsx#nodeMenuItems historique) : "running" propose Arrêter, tout le reste
      // (stopped/restarting/neutral) propose Démarrer.
      { id: "container-stop", label: "Arrêter", when: { field: "status", equals: ["running"] } },
      { id: "container-start", label: "Démarrer", when: { field: "status", notEquals: ["running"] } },
      { id: "container-restart", label: "Redémarrer" },
      { id: "container-rename", label: "Renommer" },
      // Un réseau n'étant plus un nœud du graphe (24/08/2026), c'est le SEUL chemin de connexion
      // avec le ＋ de la carte : rattacher à un réseau bridge existant ou en créer un.
      { id: "container-connect-network", label: "Connecter à un réseau…" },
      // Même picker que le bouton ＋ au survol de la carte (TopologyGraph.tsx#attachPickerItems).
      { id: "container-attach", label: "Attacher (stockage, réseau, variable)…" },
      { id: "container-remove", label: "Supprimer", severity: "destructive" },
    ],
    // Boutons directs au survol — MÊME grille d'état que les entrées de menu ci-dessus (jamais une
    // seconde règle qui pourrait diverger) ; "Supprimer" volontairement absent, voir
    // quickLifecycleActions plus bas.
    quickActions: [
      { action: "stop", when: { field: "status", equals: ["running"] } },
      { action: "restart", when: { field: "status", equals: ["running"] } },
      { action: "start", when: { field: "status", notEquals: ["running"] } },
    ],
  },
  volume: {
    icon: IconVolumes,
    minimapColor: "#f5a524",
    defaultColumnX: 0,
    ports: [
      { id: "provide", capability: "provide", handleType: "source", position: Position.Right, label: "Fournit un volume", colorToken: "volume" },
    ],
    edgeHealth: null, // l'arête "mount" lit la santé du CONTENEUR à l'autre bout, jamais le volume
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [
      // "Monter sur un conteneur…" (Phase 2, 17/08/2026) : monte ce volume sur un conteneur
      // EXISTANT en le RECRÉANT réellement (Docker n'a aucun hot-mount — POST
      // /api/containers/:id/mounts, voir apps/api/src/services/docker.ts#mountVolumeOnContainer,
      // rollback compris). Le handler (TopologyGraph.tsx#MountVolumePopover) affiche
      // l'avertissement explicite + confirmation danger AVANT tout appel — jamais un montage
      // présenté comme anodin. Volontairement absent du sous-graphe (TopologySubGraphPanel ne
      // fournit pas ce handler — buildNodeMenuItems omet alors l'entrée, jamais un item mort).
      { id: "volume-mount-on-container", label: "Monter sur un conteneur…" },
      { id: "volume-remove", label: "Supprimer", severity: "destructive" },
    ],
    quickActions: [],
  },
  // Le kind "network" a été retiré le 24/08/2026 : un réseau est un tiroir sous la carte du nœud
  // qui y est rattaché (TopologyNodeAttachment), jamais un nœud du graphe.
  // Bug réel corrigé le 14/08/2026 (retour utilisateur, capture d'écran : "c'est pas relier
  // corectement cluster au hote 1 2 3 eu vm cncerner") : `ports: []` ici faisait que GraphNode ne
  // posait AUCUN <Handle> React Flow sur ce nœud — sans ancrage DOM des deux côtés, React Flow ne
  // peut simplement PAS dessiner une arête, même quand elle existe bel et bien dans les données
  // (services/topology.ts#getNutanixTopologyParts produisait déjà la bonne arête `kind: "hosts"`
  // host->VM, invisible côté rendu uniquement). Un seul port TARGET ("hosted-by") suffit : une VM
  // Nutanix n'est jamais elle-même la SOURCE d'une arête "hosts". Reste non-interactif au
  // clic-glissé (voir CAPABILITY_DEFS["hosted-by"]) : ce placement est une vérité serveur
  // recalculée à chaque poll, pas une intention à modifier à la main depuis ce port.
  //
  // Position.Left (PAS Top, bug corrigé le 17/08/2026 — retour utilisateur, capture d'écran :
  // "les input et outpute ne sont pas a gauche et droite comme les autre node il sont en haut en
  // bas donc sa vas pas") : la convention établie partout ailleurs est TARGET = Left / SOURCE =
  // Right, quelle que soit la disposition spatiale réelle des nœuds — la position d'un Handle ne
  // doit refléter QUE son rôle source/target, jamais une hypothèse de mise en page. Voir
  // hostHierarchyPositions (topologyGraphShared.tsx) pour l'ajustement de layout qui accompagne.
  "nutanix-vm": {
    icon: IconVm,
    minimapColor: "#22c55e",
    defaultColumnX: 1020,
    ports: [
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
      // Origine de l'arête "protects" VM -> HYCU : la sauvegarde part de la VM, la poignée est
      // donc à DROITE (24/08/2026 — auparavant une entrée à gauche, les arêtes contournaient la
      // carte pour rejoindre une appliance située à droite).
      { id: "protection-out", capability: "protection-out", handleType: "source", position: Position.Right, label: "Sauvegardée vers HYCU", colorToken: "backup" },
    ],
    // SEUL cas d'arête "hosts" qui porte un vrai signal de santé : la VM comme CIBLE (jamais le
    // cas cluster -> hôte physique, dont les deux bouts sont des nœuds "host" au contrat
    // edgeHealth null — l'arête reste neutre/gris/plein). Le badge "Placement confirmé"/"Dernier
    // hôte connu" (extraEdgeData) n'est posé QUE pour une VM allumée sans erreur API : pour une VM
    // éteinte/en erreur, la couleur/le pointillé portent déjà l'information sans ambiguïté.
    edgeHealth: (node, ctx) => {
      // Arête "protects" VM -> HYCU : c'est la VM (désormais la source) qui porte l'état RÉEL
      // rapporté par HYCU, projeté sur la MÊME palette que le reste du graphe.
      if (ctx.edgeKind === "protects") {
        return ctx.role === "source" ? hycuProtectionEdgeState(node) : null;
      }
      if (ctx.edgeKind !== "hosts" || ctx.role !== "target") return null;
      const { state, strokeDasharray } = nutanixVmHostEdgeState(node);
      return {
        state,
        strokeDasharray,
        ...(node.status === "running" && !node.nutanixApiError
          ? { extraEdgeData: { nutanixPlacementConfirmed: node.nutanixHostPlacementConfirmed === true } }
          : {}),
      };
    },
    automationStatusSeed: null,
    // Prism Central ne renvoie aucune métrique d'utilisation courante par VM sur les endpoints
    // utilisés (voir nutanix.ts) — specs statiques (vCPU/RAM alloués) uniquement, jamais une jauge
    // inventée : pas d'alerte de ressources possible sans mesure réelle.
    resourceAlerts: null,
    menuItems: [
      // "Supprimer" volontairement ABSENT de ce menu rapide — la confirmation lourde "taper le nom
      // de la VM" vit UNIQUEMENT dans TopologyNodeDetailPanel.tsx (ouvert via "Voir le détail") :
      // une seule source de vérité pour l'action la plus destructrice. Démarrer/Arrêter/Redémarrer
      // mutuellement exclusifs selon l'état RÉEL — noter la nuance avec "container" : un statut
      // "neutral" (power_state unknown) ne propose RIEN, jamais un "Démarrer" par défaut.
      { id: "nutanix-vm-stop", label: "Arrêter", when: { field: "status", equals: ["running"] } },
      { id: "nutanix-vm-restart", label: "Redémarrer", when: { field: "status", equals: ["running"] } },
      { id: "nutanix-vm-start", label: "Démarrer", when: { field: "status", equals: ["stopped"] } },
      // Configuration matérielle (18/08/2026, mêmes entrées que le menu "Update VM" de Prism —
      // backend réel : POST /api/nutanix/vms/:uuid/{disks,nics}, PATCH .../compute). Toujours
      // visibles quel que soit le power_state : le hot-add disque/NIC est supporté par AHV, et un
      // refus à-chaud éventuel de Prism (compute) remonte tel quel plutôt que d'être anticipé ici.
      { id: "nutanix-vm-add-disk", label: "Ajouter un disque…" },
      { id: "nutanix-vm-add-nic", label: "Ajouter une carte réseau…" },
      { id: "nutanix-vm-edit-compute", label: "vCPU / Mémoire…" },
    ],
    // Nuance conservée par rapport à "container" : un power_state inconnu ("neutral") ne propose
    // RIEN, jamais un "Démarrer" par défaut.
    quickActions: [
      { action: "stop", when: { field: "status", equals: ["running"] } },
      { action: "restart", when: { field: "status", equals: ["running"] } },
      { action: "start", when: { field: "status", equals: ["stopped"] } },
    ],
  },
  // Le kind "ad-server" a été retiré le 24/08/2026 : les contrôleurs de domaine sont des VMs
  // Nutanix déjà présentes dans le graphe, et la configuration AD/DNS vit dans les Réglages.
  // Nœuds "host" (cluster Nutanix physique / hôte AHV physique / environnement Docker distant /
  // hôte LXD, voir services/topology.ts) — ce kind peut être LES DEUX bouts d'une arête "hosts"
  // selon le hostKind réel (un cluster est toujours SOURCE vers ses hôtes physiques ; un hôte AHV
  // est TARGET depuis son cluster ET SOURCE vers ses VMs) : les deux Handles sont posés
  // INCONDITIONNELLEMENT sur tout nœud "host" (table indexée par `kind`, pas par `hostKind` —
  // exactement comme un conteneur affiche toujours ses ports network/volume-mount/hosted-by même
  // s'il n'utilise que l'un d'eux). Un hôte Docker distant/LXD qui ne participe à aucune arête
  // "hosts" affiche donc ces deux points de connexion sans jamais s'en servir — cosmétique, pas un
  // bug (même compromis assumé que pour tout autre kind du graphe).
  //
  // edgeHealth null — vérifié le 17/08/2026 (mission "vérifie les autres types d'hôtes pour la
  // même ambiguïté") : (1) une arête cluster -> hôte physique n'a AUCUN signal de santé par hôte
  // disponible côté Prism Central sur les endpoints utilisés — volontairement neutre/grise/pleine ;
  // (2) un hôte Docker distant/LXD ne porte aujourd'hui aucune arête "hosts" vers un enfant, et
  // son `status` reflète déjà la joignabilité réelle recalculée à chaque poll — il n'existe pas,
  // pour lui, de notion de "placement live confirmé VS dernier placement assigné" comparable à la
  // migration live d'une VM AHV.
  host: {
    icon: IconHostMachine,
    // Teal — distinct des autres couleurs, cohérent avec .topology-node--host dans topology.css.
    minimapColor: "#14b8a6",
    defaultColumnX: 1700,
    ports: [
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
      { id: "hosts", capability: "hosts", handleType: "source", position: Position.Right, label: "Héberge", colorToken: "host" },
    ],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    // Aucune action de cycle de vie (un cluster/hôte ne se démarre/supprime pas depuis QUAI).
    // "Créer une VM ici" : aucun backend de création de VM Nutanix n'existe — entrée désactivée
    // honnête plutôt qu'une fausse action. "Ajouter un environnement…" ouvre la vraie modale
    // RemoteEnvironmentCreateModal (handler injecté par TopologyGraph.tsx, admin uniquement).
    // Liste déclarative depuis le 25/08/2026 (auparavant une fonction en cascade sur hostKind) —
    // mêmes entrées, même ordre, mêmes hostKind concernés.
    menuItems: [
      { id: "host-add-environment", label: "Ajouter un environnement…", when: { field: "hostKind", equals: ["quai-master", "nutanix-cluster"] } },
      {
        id: "host-create-vm",
        label: "Créer une VM ici — bientôt",
        disabled: true,
        when: { field: "hostKind", equals: ["nutanix-cluster", "nutanix-host"] },
      },
    ],
    quickActions: [],
  },
  // Cron job (services/cronJobsStore.ts) — horloge, façon Railway "Cron Jobs". Jamais relié par
  // une arête à son conteneur cible (QUAI n'a aucune garantie que cette relation reste vraie dans
  // le temps, ex : conteneur cible renommé/supprimé — voir CronJobDefinition#containerName
  // dénormalisé).
  "cron-job": {
    icon: IconClock,
    // Jaune — distinct de l'ambre du volume et de l'orange brûlé d'iac-workspace, cohérent avec
    // .topology-node--cron-job dans topology.css.
    minimapColor: "#facc15",
    defaultColumnX: 2380,
    ports: [],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [],
    quickActions: [],
  },
  // Sauvegarde (services/backupsStore.ts) — même icône que l'ancienne page BackupsPage.tsx.
  backup: {
    icon: IconBackup,
    // Bleu ciel — distinct du bleu royal du conteneur, cohérent avec .topology-node--backup.
    minimapColor: "#0ea5e9",
    defaultColumnX: 2720,
    ports: [],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [],
    quickActions: [],
  },
  // Workspace Infra-as-code (services/iac/workspaces.ts) — UN SEUL kind de nœud pour les 3 moteurs
  // (tofu/ansible/packer), le moteur réel étant porté par TopologyNode#iacEngine (champ dédié,
  // services/topology.ts#getIacWorkspaceNodes) et son libellé par le sous-titre serveur : icône
  // générique "infra" (IconStack, déjà l'icône Sidebar de l'ancienne page Infra-as-code), aucune
  // icône dédiée par outil n'existe dans icons.tsx et en ajouter 3 pour une distinction que le
  // sous-titre porte déjà n'aurait rien apporté de plus lisible sur une carte de 260px de large.
  // Indépendant de l'infra Docker locale (un `tofu apply` peut provisionner une ressource Docker,
  // mais QUAI n'a aucune donnée reliant RÉELLEMENT ce workspace à un nœud précis du graphe) —
  // ports: [] EXPLICITE, jamais d'arête ou de port inventés.
  "iac-workspace": {
    icon: IconStack,
    // Orange brûlé — distinct de l'ambre du volume (#f5a524), cohérent avec
    // .topology-node--iac-workspace dans topology.css. Volontairement IDENTIQUE pour les 3 moteurs
    // (même raison que l'icône unique ci-dessus) — une déclinaison par moteur passerait par
    // IAC_ENGINE_CONTRACT le jour où elle serait réellement souhaitée.
    minimapColor: "#f97316",
    defaultColumnX: 2040,
    ports: [],
    // Un workspace IaC porte un état réel (TopologyNode#iacLastRunStatus — statut EXACT du dernier
    // run, `null` si jamais exécuté) : déclaré ici comme source de santé sur la MÊME palette que
    // les conteneurs/VMs (running -> "starting", success -> "healthy", failed -> "unhealthy",
    // jamais exécuté -> "none"), jamais un système parallèle. AUJOURD'HUI jamais appelé en
    // pratique : aucune arête serveur ne touche ce kind (voir services/topology.ts — "PAS d'arête
    // vers un nœud Docker/Nutanix : aucune donnée ne prouve un lien réel") — le jour où une arête
    // réelle "workspace -> ressource provisionnée" existera (Phase 2, côté API), sa couleur sera
    // déjà correcte sans toucher au moteur de rendu. Trait plein : relation structurelle, même
    // choix que "mount" (aucune sonde active pertinente).
    edgeHealth: (node) => {
      const lastRun = node.iacLastRunStatus;
      const state: EdgeHealthState =
        lastRun === "running" ? "starting" : lastRun === "success" ? "healthy" : lastRun === "failed" ? "unhealthy" : "none";
      return { state, strokeDasharray: undefined };
    },
    automationStatusSeed: null,
    resourceAlerts: null,
    // Déclinaison par moteur via IAC_ENGINE_CONTRACT (voir sa JSDoc) — [] pour les trois moteurs
    // aujourd'hui : les runs réels se pilotent depuis le panneau de détail du nœud
    // (TopologyNodeDetailPanel.tsx), comportement historique inchangé par cette passe. Un
    // workspace sans moteur connu (jamais censé arriver, le champ est toujours renvoyé par l'API)
    // retombe honnêtement sur "aucune action" plutôt qu'une liste inventée.
    menuItems: (node) => (node.iacEngine ? IAC_ENGINE_CONTRACT[node.iacEngine].menuItems : []),
    quickActions: [],
  },
  // Dépôt Git source GitOps (services/topology.ts#getGitOpsSourceNode) — config globale
  // indépendante de Docker, jamais reliée par une arête à un nœud précis du graphe (le
  // rapprochement best-effort du badge "Dérive GitOps" n'est jamais assez fiable pour une arête).
  "gitops-source": {
    icon: IconGitOps,
    // Rose/rouge — distinct des autres couleurs, cohérent avec .topology-node--gitops-source.
    minimapColor: "#f43f5e",
    defaultColumnX: 3060,
    ports: [],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [],
    quickActions: [],
  },
  // Déclencheur d'automatisation (services/automationStore.ts) — cloche d'alerte (IconBell, déjà
  // utilisée par Topbar.tsx pour les notifications) : un trigger surveille un état et "sonne
  // l'alarme". Toujours la RACINE d'une chaîne : port de sortie uniquement, jamais de cible.
  "automation-trigger": {
    icon: IconBell,
    // Rouge vif "alerte" — distinct du rose/rouge de gitops-source (plus froid), cohérent avec
    // .topology-node--automation-trigger dans topology.css.
    minimapColor: "#dc2626",
    defaultColumnX: 3400,
    ports: [
      {
        id: "automation-out",
        capability: "automation-out",
        handleType: "source",
        position: Position.Right,
        label: "Relier vers une condition/action",
        colorToken: "automation",
      },
    ],
    edgeHealth: automationSourceEdgeHealth,
    // SEUL kind qui émet un statut dans la propagation automation-flow — son dernier état réel
    // observé par le moteur ("unknown" tant que jamais évalué depuis le démarrage du process).
    automationStatusSeed: (node) => node.automationLastStatus ?? "unknown",
    resourceAlerts: null,
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", severity: "destructive" }],
    quickActions: [],
  },
  // Condition — point de décision qui divise la chaîne (voir icons.tsx#IconBranch). Les deux ports
  // (cible ET source) : reliée depuis un déclencheur, relie vers une action.
  "automation-condition": {
    icon: IconBranch,
    // Gris-bleu neutre — une condition n'a pas d'état "positif/négatif" propre.
    minimapColor: "#64748b",
    defaultColumnX: 3740,
    ports: [
      {
        id: "automation-out",
        capability: "automation-out",
        handleType: "source",
        position: Position.Right,
        label: "Relier vers une condition/action",
        colorToken: "automation",
      },
      {
        id: "automation-in",
        capability: "automation-in",
        handleType: "target",
        position: Position.Left,
        label: "Relié depuis un déclencheur/une condition",
        colorToken: "automation",
      },
    ],
    // Une condition ne porte aucun statut PROPRE mais reste la SOURCE d'une arête condition ->
    // action : elle relaie le statut hérité de son déclencheur amont (propagation générique de
    // buildTopologyEdges, voir automationStatusSeed du trigger ci-dessus).
    edgeHealth: automationSourceEdgeHealth,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", severity: "destructive" }],
    quickActions: [],
  },
  // Action — déclenchement/exécution réelle (voir icons.tsx#IconPlay). Toujours une FEUILLE :
  // port d'entrée uniquement, jamais source d'une arête (routes/automation.ts#isValidConnection
  // refuse toute connexion partant d'une action) — edgeHealth null en découle : jamais l'extrémité
  // porteuse du signal (c'est la source de l'arête qui le porte, voir automationSourceEdgeHealth).
  "automation-action": {
    icon: IconPlay,
    // Vert vif (lime) — volontairement une nuance DIFFÉRENTE de --color-success (#22c55e, déjà
    // pris par le statut "running"/nutanix-vm) pour ne pas laisser croire à un statut.
    minimapColor: "#84cc16",
    defaultColumnX: 4080,
    ports: [
      {
        id: "automation-in",
        capability: "automation-in",
        handleType: "target",
        position: Position.Left,
        label: "Relié depuis un déclencheur/une condition",
        colorToken: "automation",
      },
    ],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", severity: "destructive" }],
    quickActions: [],
  },
  // Template d'image (fabrique de templates, contrat types.ts#ImageTemplate) — le nœud topologie
  // sera posé par le backend À VENIR : d'ici là ce kind compile et reste simplement invisible.
  // ports: [] EXPLICITE (aucune arête serveur ne touche ce kind pour l'instant).
  "image-template": {
    icon: IconImages,
    // Cyan clair — distinct du bleu ciel de backup (#0ea5e9), cohérent avec
    // .topology-node--image-template dans topology.css.
    minimapColor: "#22d3ee",
    defaultColumnX: 4420,
    ports: [
      { id: "artifact-in", capability: "artifact-in", handleType: "target", position: Position.Left, label: "Artefact consommé", colorToken: "template" },
      { id: "artifact-out", capability: "artifact-out", handleType: "source", position: Position.Right, label: "Artefact fourni", colorToken: "template" },
    ],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    // Visibilités sur l'état RÉEL du template projeté sur le nœud (types.ts#TopologyNode#template*)
    // — "Déployer en VM"/"Créer un conteneur" n'apparaissent qu'avec un artifact du bon type,
    // jamais une action qui échouerait faute d'image construite.
    menuItems: [
      { id: "image-template-build", label: "Construire", when: { field: "templateStatus", notEquals: ["building"] } },
      { id: "image-template-view-builds", label: "Voir les builds" },
      { id: "image-template-deploy-vm", label: "Déployer en VM…", when: { field: "templateArtifactType", equals: ["nutanix-image"] } },
      { id: "image-template-create-container", label: "Créer un conteneur…", when: { field: "templateArtifactType", equals: ["docker-image"] } },
      { id: "image-template-remove", label: "Supprimer", severity: "destructive" },
    ],
    quickActions: [],
  },
  // Appliance HYCU (services/hycu.ts — contrôleur de sauvegarde RÉEL de la mairie, LECTURE SEULE
  // stricte côté API). Icône IconBackup, comme le kind "backup" et la page Sauvegardes : c'est la
  // même idée métier, la couleur (magenta, ci-dessous) suffit à distinguer l'appliance externe
  // d'une définition de sauvegarde locale. Ports : cible du rattachement au master ("hosted-by")
  // et cible des arêtes "protects" venant des VMs qu'elle sauvegarde réellement.
  "hycu-appliance": {
    icon: IconBackup,
    // Magenta — distinct du bleu ciel de "backup" (#0ea5e9) et du rose/rouge de gitops-source
    // (#f43f5e) ; cohérent avec .topology-node--hycu-appliance et .topology-handle--backup
    // (topology.css).
    minimapColor: "#ec4899",
    defaultColumnX: 4760,
    ports: [
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
      { id: "protected-by", capability: "protected-by", handleType: "target", position: Position.Left, label: "Sauvegarde cette VM", colorToken: "backup" },
    ],
    // L'état de santé d'une arête "protects" est porté par la VM SOURCE (voir
    // NODE_CONTRACT["nutanix-vm"].edgeHealth) : l'appliance elle-même n'ajoute aucun signal — son
    // `status` (joignable/injoignable) est déjà lisible sur sa carte.
    edgeHealth: null,
    automationStatusSeed: null,
    // HYCU n'expose aucune métrique d'utilisation de l'appliance sur les endpoints REST utilisés.
    resourceAlerts: null,
    // AUCUNE action de mutation (pas de "lancer une sauvegarde") : services/hycu.ts n'émet que des
    // GET contre une appliance de production — une entrée qui échouerait serait un mensonge.
    // "Configurer" n'apparaît que si l'appelant injecte son handler (admin uniquement, voir
    // buildNodeMenuItems et TopologyGraph.tsx).
    menuItems: [
      { id: "hycu-open-page", label: "Ouvrir la page Sauvegardes" },
      { id: "hycu-view-jobs", label: "Voir les jobs" },
      { id: "hycu-configure", label: "Configurer…" },
    ],
    quickActions: [],
  },
};

// Enregistrement des types du CŒUR — effet de bord à l'import de ce module, avant tout rendu : un
// greffon qui enregistre le sien plus tard ne peut ni remplacer ni masquer l'un d'eux.
for (const [kind, contract] of Object.entries(NODE_CONTRACT_CORE) as [TopologyNodeKind, CoreNodeContract][]) {
  registerNodeContract(kind, contract, CORE_CONTRACT_SOURCE);
}

/**
 * Vue "table" des contrats du cœur — conservée pour les consommateurs qui indexent encore par kind.
 * Une clé hors cœur (type d'un greffon, type inconnu) est résolue à l'exécution par
 * nodeContractFor plutôt que de rendre `undefined` : aucun accès historique ne peut plus faire
 * planter le graphe. Tout nouveau code passe par nodeContractFor.
 */
export const NODE_CONTRACT: Record<TopologyNodeKind, NodeContract> = tableWithRuntimeFallback<TopologyNodeKind, NodeContract>(
  NODE_CONTRACT_CORE,
  nodeContractFor,
);

// --- Actions rapides au survol de la carte (18/08/2026) ------------------------------------------

/** Actions de cycle de vie proposées en BOUTONS DIRECTS au survol d'une carte (retour utilisateur :
 * "ajoute directement dessus start stop restart... suivant leur etat") — même grille de visibilité
 * que les entrées de menu du contrat (jamais une seconde règle qui pourrait diverger) : running ->
 * Arrêter/Redémarrer, arrêté -> Démarrer ; une VM au power_state inconnu ("neutral") ne propose
 * RIEN (même nuance que son menu). "Supprimer" volontairement ABSENT des boutons de carte : la
 * suppression garde ses protections existantes (conteneur : menu contextuel + confirmation ; VM :
 * confirmation lourde "taper le nom" du SEUL panneau de détail) — jamais une poubelle en un survol.
 * Fonction PURE consommée par GraphNode (topologyGraphShared.tsx), callbacks injectés par
 * TopologyGraph.tsx (mêmes handlers réels que le menu contextuel, jamais dupliqués). Depuis
 * l'ouverture du registre (25/08/2026), la LISTE et ses conditions sont déclarées par chaque
 * contrat (NodeContract#quickActions) — cette fonction n'est plus que le moteur générique qui les
 * filtre, sans plus aucun `if (kind === ...)`. */
export function quickLifecycleActions(node: TopologyNode): QuickLifecycleAction[] {
  return nodeContractFor(node.kind)
    .quickActions.filter((spec) => matchesNodeState(node, spec.when) && (!spec.visible || spec.visible(node)))
    .map((spec) => spec.action);
}

// --- Déclinaison PAR hostKind du kind "host" (même principe que IAC_ENGINE_CONTRACT) ------------

export interface HostKindContract {
  /** Icône/couleur MiniMap qui remplacent celles du kind "host" — absentes = valeurs du kind. */
  icon?: (props: { className?: string }) => JSX.Element;
  minimapColor?: string;
}

export const HOST_KIND_CONTRACT: Record<TopologyHostKind, HostKindContract> = {
  // Racine MASTER "QUAI" — indigo accentué, voir .topology-node--host-quai-master (topology.css).
  "quai-master": { icon: IconTopology, minimapColor: "#6366f1" },
  "docker-env": { icon: IconContainers },
  "nutanix-cluster": {},
  "nutanix-host": {},
  "remote-docker": {},
  lxc: {},
};

export function nodeIcon(node: TopologyNode): (props: { className?: string }) => JSX.Element {
  const contract = nodeContractFor(node.kind);
  if (node.kind === "host" && node.hostKind) return HOST_KIND_CONTRACT[node.hostKind].icon ?? contract.icon;
  return contract.icon;
}

export function nodeMinimapColor(node: TopologyNode): string {
  const contract = nodeContractFor(node.kind);
  if (node.kind === "host" && node.hostKind) return HOST_KIND_CONTRACT[node.hostKind].minimapColor ?? contract.minimapColor;
  return contract.minimapColor;
}

// --- Vues dérivées du registre (compatibilité + consommation générique) -------------------------

/** Kinds du CŒUR uniquement (totalité vérifiée par le compilateur) — pour la liste VIVANTE, cœur
 * et greffons compris, voir registeredNodeKinds() (topologyNodeRegistry.tsx). */
export const NODE_KINDS = Object.keys(NODE_CONTRACT_CORE) as TopologyNodeKind[];

/** Projette un champ du contrat en Record par kind — pour les consommateurs qui préfèrent une
 * table plate (MiniMap, palette de création...) à un accès nodeContractFor(kind).champ. Même
 * garde que NODE_CONTRACT : une clé hors cœur est projetée à l'exécution, jamais `undefined`. */
export function mapNodeContract<T>(pick: (contract: NodeContract) => T): Record<TopologyNodeKind, T> {
  const result = {} as Record<TopologyNodeKind, T>;
  for (const kind of NODE_KINDS) result[kind] = pick(nodeContractFor(kind));
  return tableWithRuntimeFallback<TopologyNodeKind, T>(result, (kind) => pick(nodeContractFor(kind)));
}

/** Icône par kind — vue dérivée du registre, mêmes consommateurs qu'avant la migration
 * (GraphNode, CreateSpotlight, TopologyNodeDetailPanel...). */
export const KIND_ICON: Record<TopologyNodeKind, (props: { className?: string }) => JSX.Element> = mapNodeContract((c) => c.icon);

/** Couleurs de la MiniMap par kind — mêmes valeurs que celles de l'icône du nœud correspondant
 * dans topology.css (--accent-start, --color-warning, --accent-end...), le pourquoi de chaque
 * couleur est documenté sur l'entrée du kind dans NODE_CONTRACT. */
export const MINIMAP_NODE_COLOR: Record<TopologyNodeKind, string> = mapNodeContract((c) => c.minimapColor);
