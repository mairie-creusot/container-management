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
import type { IacEngine, TopologyHostKind, TopologyNode, TopologyNodeKind } from "@/types";

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
 * Désormais : TOUT ce qui est spécifique à un `kind` est déclaré ICI comme DONNÉES
 * (NODE_CONTRACT, un `Record<TopologyNodeKind, NodeContract>` — le compilateur refuse tout kind
 * oublié), consommées par des moteurs de rendu génériques qui ne contiennent plus AUCUN
 * `if (kind === ...)` de plateforme :
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
 * aucun moteur de rendu à modifier.
 *
 * ZÉRO changement visuel/fonctionnel dans cette passe : chaque valeur ci-dessous est la copie
 * exacte du comportement dispersé qu'elle remplace (les commentaires historiques "pourquoi" sont
 * conservés avec elle).
 */

// --- Ports typés (façon Railway) -----------------------------------------------------------------

/**
 * Connexions par capacité — chaque port a une capacité (ce qu'il peut relier) et un type de Handle
 * React Flow (source/target) qui fixe son côté du nœud. "automation-out"/"automation-in"
 * (17/08/2026, migration vers ce contrat) : les Handles des nœuds d'automatisation, autrefois posés
 * par un JSX conditionnel dans GraphNode HORS de toute table (comportement implicite), sont
 * désormais déclarés ici comme n'importe quel autre port — classifyConnection/handleConnect
 * (TopologyGraph.tsx) ne les lisent toujours PAS (la validation/le POST d'une connexion entre deux
 * nœuds d'automatisation passe par un chemin dédié qui ne se fie qu'au kind des deux nœuds visés,
 * voir routes/automation.ts#isValidConnection côté serveur), mais leur EXISTENCE/côté/couleur est
 * enfin une donnée du contrat, pas un cas spécial de rendu.
 */
export type CapabilityId =
  | "volume-mount"
  | "provide"
  | "hosted-by"
  | "hosts"
  | "automation-out"
  | "automation-in"
  | "artifact-out"
  | "artifact-in"
  // Sauvegarde HYCU : "protection-out" côté appliance, "protected-by" côté VM Nutanix protégée
  // (arête "protects") — même patron que artifact-out/artifact-in, et non interactives pour la
  // même raison : c'est une vérité rapportée par HYCU à chaque poll, en LECTURE SEULE stricte.
  | "protection-out"
  | "protected-by";

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
  colorToken: "volume" | "host" | "automation" | "template" | "backup";
}

export interface CapabilityDef {
  /** Capacité compatible attendue à l'autre bout de la connexion. */
  linksTo: CapabilityId;
  /** true = action réelle déclenchée au drop (voir CONNECTION_ACTIONS) ; false = message d'info. */
  interactive: boolean;
  infoMessage?: string;
}

export const CAPABILITY_DEFS: Record<CapabilityId, CapabilityDef> = {
  // Vague 3 (câblage au fil) : le fil ouvre MountVolumePopover pré-rempli — la recréation du
  // conteneur reste confirmée par l'utilisateur, jamais déclenchée par le seul geste.
  "volume-mount": { linksTo: "provide", interactive: true },
  provide: { linksTo: "volume-mount", interactive: true },
  // Posé À LA FOIS sur les ports synthétiques d'un groupe replié (deriveGroupPorts,
  // topologyGraphShared.tsx) ET, depuis le correctif du 14/08/2026, sur tout vrai nœud
  // "nutanix-vm"/"host" — toujours le bout TARGET d'une arête "hosts" (jamais l'origine d'une
  // connexion glissée par l'utilisateur, React Flow ne démarre un geste de connexion que depuis un
  // Handle `type="source"`). Jamais interactif : ce placement est une vérité serveur recalculée à
  // chaque poll, pas une intention à modifier à la main depuis ce port.
  "hosted-by": { linksTo: "hosts", interactive: false, infoMessage: "Relation d'hébergement posée par le serveur, non modifiable ici." },
  // Pendant SOURCE de "hosted-by" ci-dessus — posé UNIQUEMENT sur un vrai nœud "host", jamais sur
  // un port synthétique de groupe (un groupe n'est jamais lui-même la source d'une arête "hosts",
  // voir deriveGroupPorts). Même garde non-interactive que "hosted-by" : un clic-glissé depuis ce
  // port affiche le même message plutôt que de ne rien faire silencieusement.
  hosts: { linksTo: "hosted-by", interactive: false, infoMessage: "Relation d'hébergement posée par le serveur, non modifiable ici." },
  // Connexions entre nœuds d'automatisation (trigger -> condition/action, condition -> action) :
  // interactives (React Flow démarre bien un geste de connexion depuis "automation-out"), mais
  // JAMAIS validées par classifyConnection/CAPABILITY_DEFS — handleConnect (TopologyGraph.tsx)
  // intercepte toute connexion dont un bout est un nœud d'automatisation AVANT d'en arriver là et
  // POST /api/automation/edges avec sa propre règle d'ordre (même règle que le serveur,
  // routes/automation.ts#isValidConnection). `linksTo` déclaré par cohérence documentaire.
  "automation-out": { linksTo: "automation-in", interactive: true },
  "automation-in": { linksTo: "automation-out", interactive: true },
  // Dépendance d'artefact template->template : vérité issue de la RECETTE (étape "artifact"),
  // recalculée à chaque poll — se modifie dans le studio, pas au fil (phase sous-graphe à venir).
  "artifact-out": { linksTo: "artifact-in", interactive: false, infoMessage: "Dépendance d'artefact définie par la recette du template — modifiable dans le studio." },
  "artifact-in": { linksTo: "artifact-out", interactive: false, infoMessage: "Dépendance d'artefact définie par la recette du template — modifiable dans le studio." },
  // Protection HYCU : QUAI lit l'appliance, il ne la pilote JAMAIS (aucune route de mutation) —
  // un fil tiré depuis ce port doit le dire honnêtement plutôt que de laisser espérer une action.
  "protection-out": {
    linksTo: "protected-by",
    interactive: false,
    infoMessage: "Protection rapportée par HYCU (lecture seule) — elle s'assigne dans HYCU, pas depuis QUAI.",
  },
  "protected-by": {
    linksTo: "protection-out",
    interactive: false,
    infoMessage: "Protection rapportée par HYCU (lecture seule) — elle s'assigne dans HYCU, pas depuis QUAI.",
  },
};

/**
 * Métadonnées de rendu d'un port PAR CAPACITÉ (indépendantes du type de nœud qui le porte) —
 * reprises telles quelles des entrées de ports existantes (même position/couleur/libellé pour une
 * capacité donnée, quel que soit le nœud) : un groupe (voir deriveGroupPorts,
 * topologyGraphShared.tsx) n'est PAS un type de nœud avec ses propres ports fixes, ses ports
 * dépendent de ce qu'il contient réellement — cette table permet de construire un Handle
 * synthétique cohérent avec le reste du graphe pour n'importe quelle capacité, sans dupliquer
 * position/couleur/libellé à chaque usage.
 */
export const CAPABILITY_PORT_META: Record<CapabilityId, Pick<PortSpec, "handleType" | "position" | "colorToken" | "label">> = {
  "volume-mount": { handleType: "target", position: Position.Left, colorToken: "volume", label: "Volume (lecture seule)" },
  provide: { handleType: "source", position: Position.Right, colorToken: "volume", label: "Fournit un volume" },
  // Position.Left (bug corrigé le 17/08/2026, même correctif que les ports "nutanix-vm"/"host"
  // ci-dessous — convention TARGET = Left partout) : un groupe hébergé par un nœud "host" externe
  // utilise la même convention que le reste du graphe, jamais un côté à part.
  "hosted-by": { handleType: "target", position: Position.Left, colorToken: "host", label: "Hébergé par" },
  // Jamais réellement lue par deriveGroupPorts (un groupe n'est jamais SOURCE d'une arête "hosts")
  // — entrée requise uniquement pour que ce Record reste total. Valeurs alignées sur le port réel
  // du nœud "host" pour rester cohérentes si jamais réutilisées un jour.
  hosts: { handleType: "source", position: Position.Right, colorToken: "host", label: "Héberge" },
  // Jamais lues par deriveGroupPorts non plus (aucun kind de TopologyEdge ne s'y projette — les
  // arêtes "automation-flow" d'un groupe replié ne produisent aucun port synthétique dans ce
  // premier lot, voir deriveGroupPorts) : entrées requises uniquement par la totalité du Record,
  // valeurs alignées sur les vrais ports des nœuds d'automatisation ci-dessous.
  "automation-out": { handleType: "source", position: Position.Right, colorToken: "automation", label: "Relier vers une condition/action" },
  "automation-in": { handleType: "target", position: Position.Left, colorToken: "automation", label: "Relié depuis un déclencheur/une condition" },
  "artifact-out": { handleType: "source", position: Position.Right, colorToken: "template", label: "Artefact fourni" },
  "artifact-in": { handleType: "target", position: Position.Left, colorToken: "template", label: "Artefact consommé" },
  "protection-out": { handleType: "source", position: Position.Right, colorToken: "backup", label: "Sauvegarde cette VM" },
  "protected-by": { handleType: "target", position: Position.Left, colorToken: "backup", label: "Sauvegardée par HYCU" },
};

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

// Une arête ne porte aucune donnée de santé propre (voir services/topology.ts côté API) : c'est le
// nœud "pertinent" à l'une de ses extrémités qui fournit l'état — chaque kind déclare ci-dessous
// (NodeContract#edgeHealth) s'il porte un signal et comment il se projette sur la MÊME palette,
// jamais un système de couleurs parallèle par plateforme (retour utilisateur du 17/08/2026 : "j'ai
// impression que le systeme n'est pas coherent entre nutanyx et le systeme de container c'est
// comme si la logique etait seprarer en deux").
export type EdgeHealthState = "healthy" | "unhealthy" | "starting" | "none" | "stopped";

/** Dernier état RÉEL observé par le moteur d'automatisation pour un déclencheur — voir
 * TopologyNode#automationLastStatus (types.ts) et services/automationEngine.ts côté API. */
export type AutomationTriggerStatus = "ok" | "failing" | "unknown";

/** Ce qu'une extrémité "porteuse de signal" rend à buildTopologyEdges pour SON arête. */
export interface EdgeHealthInfo {
  state: EdgeHealthState;
  strokeDasharray: string | undefined;
  /** Données supplémentaires à fusionner dans `edge.data` (ex: nutanixPlacementConfirmed, consommé
   * par le badge flottant d'arête — voir edgeBadgeItems, topologyGraphShared.tsx) — le moteur les
   * recopie telles quelles, sans en connaître le sens : aucune clé de plateforme codée en dur dans
   * buildTopologyEdges. */
  extraEdgeData?: Record<string, unknown>;
}

/** Contexte fourni par buildTopologyEdges au `edgeHealth` d'un contrat — tout ce qu'un kind peut
 * légitimement vouloir consulter SANS que le moteur ait à connaître sa plateforme. */
export interface EdgeHealthContext {
  /** Kind de l'arête interrogée — même union que TopologyEdge["kind"]. */
  edgeKind: "mount" | "hosts" | "automation-flow" | "uses-artifact" | "protects";
  /** Rôle de CE nœud sur l'arête — permet à un contrat de ne répondre que pour le bout où son
   * signal a un sens (ex : une VM Nutanix n'est porteuse que comme CIBLE d'une arête "hosts"). */
  role: "source" | "target";
  /** Statut de déclencheur propagé jusqu'à la SOURCE de l'arête le long des arêtes
   * "automation-flow" (pré-passe générique de buildTopologyEdges, alimentée par
   * NodeContract#automationStatusSeed) — "unknown" si aucun signal n'atteint cette arête. */
  automationUpstreamStatus: AutomationTriggerStatus;
}

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
 * État + pointillé d'une arête "protects" (appliance HYCU -> VM Nutanix), lus sur la VM CIBLE —
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

/** Seuils d'alerte de ressources d'un kind — `null` dans NodeContract#resourceAlerts pour tout
 * kind sans métriques d'utilisation live (explicite, jamais une absence implicite : seul
 * "container" expose aujourd'hui cpuPercent/memBytes réels, voir services/topology.ts). */
export interface ResourceAlertsSpec {
  cpuThresholdPercent: number;
  memoryRatio: number;
}

// --- Actions du menu contextuel ------------------------------------------------------------------

/**
 * Ids d'actions par kind — le contrat déclare QUELLES actions existent pour un kind (liste
 * ordonnée, libellé, danger, condition de visibilité sur l'état réel du nœud) ; l'IMPLÉMENTATION
 * (dispatch/confirm/popovers) reste injectée par l'appelant via buildNodeMenuItems ci-dessous,
 * seul à avoir accès aux hooks Redux/au state du composant. Préfixés par kind : deux kinds
 * différents n'exécutent jamais le même code pour un même verbe (ex : "Supprimer" un conteneur
 * passe par runContainerAction, une VM par TopologyNodeDetailPanel uniquement — jamais fusionnés).
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

export interface NodeMenuActionSpec {
  id: NodeMenuActionId;
  label: string;
  /** Style rouge pour les actions destructrices — même sémantique que ContextMenuItem#danger. */
  danger?: boolean;
  /** Rendue seulement si vrai pour CE nœud (état réel) — absente = toujours proposée. */
  visible?: (node: TopologyNode) => boolean;
  /** Entrée visible mais non cliquable, au libellé honnête ("bientôt") — même sémantique que
   * ContextMenuItem#disabled ; incluse SANS handler (une entrée désactivée n'a pas d'action). */
  disabled?: boolean;
}

/**
 * Rend les actions déclarées par le contrat de `node.kind` en items de menu concrets — l'appelant
 * fournit `handlers`, une table PARTIELLE id d'action -> callback réel : une action déclarée mais
 * sans handler est simplement omise (cas assumé : TopologySubGraphPanel.tsx n'implémente
 * volontairement qu'un sous-ensemble — pas de "Renommer"/"Connecter à un network…" dans le
 * sous-graphe, comportement historique inchangé par cette migration), jamais un item mort qui ne
 * ferait rien au clic. Le résultat est structurellement assignable à ContextMenuItem[]
 * (ContextMenu.tsx) sans dépendre de ce composant ici.
 */
export function buildNodeMenuItems(
  node: TopologyNode,
  handlers: Partial<Record<NodeMenuActionId, () => void>>,
): { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] {
  const specs = NODE_CONTRACT[node.kind].menuItems;
  const resolved = typeof specs === "function" ? specs(node) : specs;
  const items: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] = [];
  for (const spec of resolved) {
    if (spec.visible && !spec.visible(node)) continue;
    // Une entrée désactivée est incluse sans handler (aucune action par définition).
    if (spec.disabled) {
      items.push({ label: spec.label, disabled: true, onClick: () => {} });
      continue;
    }
    const handler = handlers[spec.id];
    if (!handler) continue;
    items.push({ label: spec.label, ...(spec.danger ? { danger: true } : {}), onClick: handler });
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
  menuItems: NodeMenuActionSpec[];
}

export const IAC_ENGINE_CONTRACT: Record<IacEngine, IacEngineContract> = {
  tofu: { menuItems: [] },
  ansible: { menuItems: [] },
  packer: { menuItems: [] },
};

// --- Le contrat lui-même -------------------------------------------------------------------------

export interface NodeContract {
  /** Icône de la carte du nœud (et de ses reprises : palette de création, panneau de détail...). */
  icon: (props: { className?: string }) => JSX.Element;
  /** Couleur de la MiniMap — même valeur que celle de l'icône du nœud dans topology.css. */
  minimapColor: string;
  /**
   * Abscisse de la colonne PAR DÉFAUT du kind sur le canevas principal (TopologyGraph.tsx) — ne
   * sert qu'en l'absence de position sauvegardée par l'utilisateur, et plus du tout pour
   * "host"/"nutanix-vm" une fois l'arbre auto-disposé calculé (hostHierarchyPositions,
   * topologyGraphShared.tsx — la colonne fixe n'y reste qu'en repli défensif improbable).
   */
  defaultColumnX: number;
  /** Handles React Flow du nœud — `[]` EXPLICITE pour un kind jamais connectable (jamais une
   * absence implicite : c'est précisément l'oubli qui a rendu les arêtes Nutanix invisibles le
   * 14/08/2026, voir l'entrée "nutanix-vm" ci-dessous). */
  ports: PortSpec[];
  /**
   * Comment une arête dont ce nœud est l'extrémité PERTINENTE calcule son état de santé/pointillé
   * — `null` si ce kind ne porte jamais de signal (l'arête retombe alors sur le rendu neutre
   * générique de buildTopologyEdges). Un contrat se garde LUI-MÊME (edgeKind/role du contexte) :
   * le moteur interroge source puis cible sans aucune connaissance de plateforme.
   */
  edgeHealth: ((node: TopologyNode, ctx: EdgeHealthContext) => EdgeHealthInfo | null) | null;
  /**
   * Statut que ce kind INJECTE dans la propagation le long des arêtes "automation-flow"
   * (pré-passe générique de buildTopologyEdges : le statut d'un déclencheur se propage aux
   * conditions/actions qu'il alimente, pour qu'une arête condition -> action hérite d'un état réel
   * plutôt que de retomber sur "aucun signal") — `null` pour tout kind qui n'émet rien.
   */
  automationStatusSeed: ((node: TopologyNode) => AutomationTriggerStatus) | null;
  /** Seuils d'alertes CPU/mémoire — `null` EXPLICITE pour un kind sans métriques live. */
  resourceAlerts: ResourceAlertsSpec | null;
  /**
   * Actions du menu contextuel PROPRES à ce kind (les entrées génériques — "Voir le détail",
   * "Visualiser les dépendances", "Grouper la sélection" — restent posées par l'appelant, valables
   * pour tous les kinds). Fonction de `node` quand la liste dépend d'une donnée du nœud (cas
   * "iac-workspace" : déclinaison par moteur via IAC_ENGINE_CONTRACT ci-dessus).
   */
  menuItems: NodeMenuActionSpec[] | ((node: TopologyNode) => NodeMenuActionSpec[]);
}

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

export const NODE_CONTRACT: Record<TopologyNodeKind, NodeContract> = {
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
      { id: "container-stop", label: "Arrêter", visible: (n) => n.status === "running" },
      { id: "container-start", label: "Démarrer", visible: (n) => n.status !== "running" },
      { id: "container-restart", label: "Redémarrer" },
      { id: "container-rename", label: "Renommer" },
      // Un réseau n'étant plus un nœud du graphe (24/08/2026), c'est le SEUL chemin de connexion
      // avec le ＋ de la carte : rattacher à un réseau bridge existant ou en créer un.
      { id: "container-connect-network", label: "Connecter à un réseau…" },
      // Même picker que le bouton ＋ au survol de la carte (TopologyGraph.tsx#attachPickerItems).
      { id: "container-attach", label: "Attacher (stockage, réseau, variable)…" },
      { id: "container-remove", label: "Supprimer", danger: true },
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
      { id: "volume-remove", label: "Supprimer", danger: true },
    ],
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
      // Cible de l'arête "protects" HYCU -> VM (18/08/2026) — sans ce Handle, l'arête existerait
      // dans les données mais ne pourrait pas être dessinée (bug réel du 14/08/2026).
      { id: "protected-by", capability: "protected-by", handleType: "target", position: Position.Left, label: "Sauvegardée par HYCU", colorToken: "backup" },
    ],
    // SEUL cas d'arête "hosts" qui porte un vrai signal de santé : la VM comme CIBLE (jamais le
    // cas cluster -> hôte physique, dont les deux bouts sont des nœuds "host" au contrat
    // edgeHealth null — l'arête reste neutre/gris/plein). Le badge "Placement confirmé"/"Dernier
    // hôte connu" (extraEdgeData) n'est posé QUE pour une VM allumée sans erreur API : pour une VM
    // éteinte/en erreur, la couleur/le pointillé portent déjà l'information sans ambiguïté.
    edgeHealth: (node, ctx) => {
      // Arête "protects" HYCU -> VM : c'est la VM (cible) qui porte l'état RÉEL rapporté par HYCU,
      // projeté sur la MÊME palette que le reste du graphe (voir hycuProtectionEdgeState).
      if (ctx.edgeKind === "protects") {
        return ctx.role === "target" ? hycuProtectionEdgeState(node) : null;
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
      { id: "nutanix-vm-stop", label: "Arrêter", visible: (n) => n.status === "running" },
      { id: "nutanix-vm-restart", label: "Redémarrer", visible: (n) => n.status === "running" },
      { id: "nutanix-vm-start", label: "Démarrer", visible: (n) => n.status === "stopped" },
      // Configuration matérielle (18/08/2026, mêmes entrées que le menu "Update VM" de Prism —
      // backend réel : POST /api/nutanix/vms/:uuid/{disks,nics}, PATCH .../compute). Toujours
      // visibles quel que soit le power_state : le hot-add disque/NIC est supporté par AHV, et un
      // refus à-chaud éventuel de Prism (compute) remonte tel quel plutôt que d'être anticipé ici.
      { id: "nutanix-vm-add-disk", label: "Ajouter un disque…" },
      { id: "nutanix-vm-add-nic", label: "Ajouter une carte réseau…" },
      { id: "nutanix-vm-edit-compute", label: "vCPU / Mémoire…" },
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
    menuItems: (node) => {
      const createVmSoon: NodeMenuActionSpec = { id: "host-create-vm", label: "Créer une VM ici — bientôt", disabled: true };
      if (node.hostKind === "quai-master") return [{ id: "host-add-environment", label: "Ajouter un environnement…" }];
      if (node.hostKind === "nutanix-cluster") {
        return [{ id: "host-add-environment", label: "Ajouter un environnement…" }, createVmSoon];
      }
      if (node.hostKind === "nutanix-host") return [createVmSoon];
      return [];
    },
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
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", danger: true }],
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
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", danger: true }],
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
    menuItems: [{ id: "automation-node-remove", label: "Supprimer", danger: true }],
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
      { id: "image-template-build", label: "Construire", visible: (n) => n.templateStatus !== "building" },
      { id: "image-template-view-builds", label: "Voir les builds" },
      { id: "image-template-deploy-vm", label: "Déployer en VM…", visible: (n) => n.templateArtifactType === "nutanix-image" },
      { id: "image-template-create-container", label: "Créer un conteneur…", visible: (n) => n.templateArtifactType === "docker-image" },
      { id: "image-template-remove", label: "Supprimer", danger: true },
    ],
  },
  // Appliance HYCU (services/hycu.ts — contrôleur de sauvegarde RÉEL de la mairie, LECTURE SEULE
  // stricte côté API). Icône IconBackup, comme le kind "backup" et la page Sauvegardes : c'est la
  // même idée métier, la couleur (magenta, ci-dessous) suffit à distinguer l'appliance externe
  // d'une définition de sauvegarde locale. Ports : cible du rattachement au master ("hosted-by")
  // et source des arêtes "protects" vers les VMs qu'elle sauvegarde réellement.
  "hycu-appliance": {
    icon: IconBackup,
    // Magenta — distinct du bleu ciel de "backup" (#0ea5e9) et du rose/rouge de gitops-source
    // (#f43f5e) ; cohérent avec .topology-node--hycu-appliance et .topology-handle--backup
    // (topology.css).
    minimapColor: "#ec4899",
    defaultColumnX: 4760,
    ports: [
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
      { id: "protection-out", capability: "protection-out", handleType: "source", position: Position.Right, label: "Sauvegarde cette VM", colorToken: "backup" },
    ],
    // L'état de santé d'une arête "protects" est porté par la VM CIBLE (voir
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
  },
};

// --- Actions rapides au survol de la carte (18/08/2026) ------------------------------------------

/** Actions de cycle de vie proposées en BOUTONS DIRECTS au survol d'une carte (retour utilisateur :
 * "ajoute directement dessus start stop restart... suivant leur etat") — même grille de visibilité
 * que les entrées de menu du contrat (jamais une seconde règle qui pourrait diverger) : running ->
 * Arrêter/Redémarrer, arrêté -> Démarrer ; une VM au power_state inconnu ("neutral") ne propose
 * RIEN (même nuance que son menu). "Supprimer" volontairement ABSENT des boutons de carte : la
 * suppression garde ses protections existantes (conteneur : menu contextuel + confirmation ; VM :
 * confirmation lourde "taper le nom" du SEUL panneau de détail) — jamais une poubelle en un survol.
 * Fonction PURE consommée par GraphNode (topologyGraphShared.tsx), callbacks injectés par
 * TopologyGraph.tsx (mêmes handlers réels que le menu contextuel, jamais dupliqués). */
export type QuickLifecycleAction = "start" | "stop" | "restart";
export function quickLifecycleActions(node: TopologyNode): QuickLifecycleAction[] {
  if (node.kind === "container") return node.status === "running" ? ["stop", "restart"] : ["start"];
  if (node.kind === "nutanix-vm") {
    if (node.status === "running") return ["stop", "restart"];
    if (node.status === "stopped") return ["start"];
    return [];
  }
  return [];
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
  if (node.kind === "host" && node.hostKind) return HOST_KIND_CONTRACT[node.hostKind].icon ?? NODE_CONTRACT.host.icon;
  return NODE_CONTRACT[node.kind].icon;
}

export function nodeMinimapColor(node: TopologyNode): string {
  if (node.kind === "host" && node.hostKind) return HOST_KIND_CONTRACT[node.hostKind].minimapColor ?? NODE_CONTRACT.host.minimapColor;
  return NODE_CONTRACT[node.kind].minimapColor;
}

// --- Vues dérivées du registre (compatibilité + consommation générique) -------------------------

/** Tous les kinds du registre — dérivé de NODE_CONTRACT (le compilateur garantit déjà la totalité
 * du Record, cette liste ne peut donc jamais oublier un kind). */
export const NODE_KINDS = Object.keys(NODE_CONTRACT) as TopologyNodeKind[];

/** Projette un champ du contrat en Record par kind — pour les consommateurs qui préfèrent une
 * table plate (MiniMap, palette de création...) à un accès NODE_CONTRACT[kind].champ. */
export function mapNodeContract<T>(pick: (contract: NodeContract) => T): Record<TopologyNodeKind, T> {
  const result = {} as Record<TopologyNodeKind, T>;
  for (const kind of NODE_KINDS) result[kind] = pick(NODE_CONTRACT[kind]);
  return result;
}

/** Icône par kind — vue dérivée du registre, mêmes consommateurs qu'avant la migration
 * (GraphNode, CreateSpotlight, TopologyNodeDetailPanel...). */
export const KIND_ICON: Record<TopologyNodeKind, (props: { className?: string }) => JSX.Element> = mapNodeContract((c) => c.icon);

/** Couleurs de la MiniMap par kind — mêmes valeurs que celles de l'icône du nœud correspondant
 * dans topology.css (--accent-start, --color-warning, --accent-end...), le pourquoi de chaque
 * couleur est documenté sur l'entrée du kind dans NODE_CONTRACT. */
export const MINIMAP_NODE_COLOR: Record<TopologyNodeKind, string> = mapNodeContract((c) => c.minimapColor);
