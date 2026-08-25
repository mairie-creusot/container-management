import { Position } from "@xyflow/react";
import { IconInfo } from "@/components/icons";
import type { TopologyNode } from "@/types";

/**
 * REGISTRE des contrats de nœud — ouvert à l'exécution (Phase 3, 25/08/2026).
 *
 * Ce fichier porte le VOCABULAIRE d'un contrat (capacités/ports, santé d'arête, actions déclarées)
 * et le registre lui-même ; topologyNodeContract.tsx déclare les types du CŒUR et les enregistre à
 * son import. Un greffon peut enregistrer ses propres types au même endroit, sans modifier aucun
 * moteur de rendu.
 *
 * Ce qu'on perd : la totalité vérifiée par le compilateur (`Record<TopologyNodeKind, NodeContract>`
 * ne peut plus couvrir un kind inventé à l'exécution). Ce qui la remplace : validateNodeContract,
 * qui REFUSE à l'enregistrement un contrat incomplet, et nodeContractFor, qui ne rend jamais
 * `undefined` — un kind non enregistré retombe sur UNKNOWN_NODE_CONTRACT ("type inconnu", rendu de
 * repli honnête) plutôt que de faire planter le graphe ou de disparaître silencieusement.
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
  // Sauvegarde HYCU : la donnée REMONTE de la VM vers l'appliance — "protection-out" est donc posé
  // sur la VM (sortie à droite) et "protected-by" sur HYCU (entrée à gauche), qui ne fait que
  // recevoir. Non interactives : c'est une vérité rapportée par HYCU à chaque poll, en lecture seule.
  | "protection-out"
  | "protected-by";

/** Jetons de couleur de port disponibles — un greffon réutilise l'un d'eux (une valeur libre
 * donnerait une classe .topology-handle--<token> sans style, donc un Handle invisible). */
export const PORT_COLOR_TOKENS = ["volume", "host", "automation", "template", "backup"] as const;

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
  colorToken: (typeof PORT_COLOR_TOKENS)[number];
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
  "protection-out": { handleType: "source", position: Position.Right, colorToken: "backup", label: "Sauvegardée vers HYCU" },
  "protected-by": { handleType: "target", position: Position.Left, colorToken: "backup", label: "Sauvegarde cette VM" },
};

// --- Santé des arêtes (couleur/pointillé) --------------------------------------------------------

// Une arête ne porte aucune donnée de santé propre (voir services/topology.ts côté API) : c'est le
// nœud "pertinent" à l'une de ses extrémités qui fournit l'état — chaque kind déclare
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

/** Seuils d'alerte de ressources d'un kind — `null` dans NodeContract#resourceAlerts pour tout
 * kind sans métriques d'utilisation live (explicite, jamais une absence implicite : seul
 * "container" expose aujourd'hui cpuPercent/memBytes réels, voir services/topology.ts). */
export interface ResourceAlertsSpec {
  cpuThresholdPercent: number;
  memoryRatio: number;
}

// --- Actions déclarées ---------------------------------------------------------------------------

/** Niveau de danger d'une action. "destructive" est le SEUL rendu en rouge aujourd'hui (danger de
 * ContextMenuItem) — "caution" est déclarable mais rendu comme "safe" tant qu'aucun style
 * intermédiaire n'existe (aucun changement visuel introduit par cette passe). */
export type NodeActionSeverity = "safe" | "caution" | "destructive";

export type NodeStateValue = string | number | boolean | null;

/**
 * Condition de visibilité SÉRIALISABLE, évaluée sur l'état RÉEL du nœud — un greffon serveur ne
 * peut pas livrer de closure, sa déclaration doit traverser le réseau en JSON.
 */
export interface NodeStateCondition {
  /** Champ réel du nœud consulté ("status", "hostKind", "templateArtifactType"…). */
  field: Extract<keyof TopologyNode, string> | (string & {});
  /** Visible si la valeur du champ est l'une de celles-ci. */
  equals?: NodeStateValue[];
  /** Masquée si la valeur du champ est l'une de celles-ci. */
  notEquals?: NodeStateValue[];
  /** true = champ renseigné obligatoire ; false = champ absent obligatoire. */
  present?: boolean;
}

/** Évalue une condition déclarative (plusieurs conditions = ET). `undefined` = toujours vraie. */
export function matchesNodeState(node: TopologyNode, when: NodeStateCondition | NodeStateCondition[] | undefined): boolean {
  if (!when) return true;
  const conditions = Array.isArray(when) ? when : [when];
  for (const condition of conditions) {
    const value: unknown = (node as unknown as Record<string, unknown>)[condition.field];
    if (condition.present !== undefined && (value !== undefined && value !== null) !== condition.present) return false;
    if (condition.equals && !condition.equals.some((candidate) => (candidate as unknown) === value)) return false;
    if (condition.notEquals && condition.notEquals.some((candidate) => (candidate as unknown) === value)) return false;
  }
  return true;
}

/**
 * Entrée de menu contextuel DÉCLARÉE par un type de nœud — identifiant, libellé, condition de
 * visibilité sur l'état réel, niveau de danger. L'IMPLÉMENTATION (dispatch/confirm/popovers) reste
 * injectée par l'appelant via buildNodeMenuItems (topologyNodeContract.tsx), seul à avoir accès aux
 * hooks Redux/au state du composant.
 */
export interface NodeMenuActionSpec {
  id: string;
  label: string;
  /** Défaut "safe" — voir NodeActionSeverity. */
  severity?: NodeActionSeverity;
  /** Condition déclarative (sérialisable) sur l'état réel du nœud. */
  when?: NodeStateCondition | NodeStateCondition[];
  /** Prédicat libre, pour ce qui ne s'exprime pas dans `when` — ET avec `when` si les deux sont
   * posés. Inutilisable par un greffon distant (une closure ne traverse pas le réseau). */
  visible?: (node: TopologyNode) => boolean;
  /** Entrée visible mais non cliquable, au libellé honnête ("bientôt") — même sémantique que
   * ContextMenuItem#disabled ; incluse SANS handler (une entrée désactivée n'a pas d'action). */
  disabled?: boolean;
}

/** Boutons de cycle de vie proposés directement au survol d'une carte. */
export type QuickLifecycleAction = "start" | "stop" | "restart";

/** Même grammaire de visibilité que les entrées de menu — jamais une seconde règle qui pourrait
 * diverger de celle du menu contextuel. */
export interface QuickLifecycleActionSpec {
  action: QuickLifecycleAction;
  when?: NodeStateCondition | NodeStateCondition[];
  visible?: (node: TopologyNode) => boolean;
}

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
   * 14/08/2026, voir l'entrée "nutanix-vm" de NODE_CONTRACT). */
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
   * pour tous les kinds). La forme fonction reste admise quand la liste dépend d'un sous-registre
   * (cas "iac-workspace" : déclinaison par moteur via IAC_ENGINE_CONTRACT) — inutilisable par un
   * greffon distant, qui déclare toujours un tableau.
   */
  menuItems: NodeMenuActionSpec[] | ((node: TopologyNode) => NodeMenuActionSpec[]);
  /** Boutons rapides de cycle de vie au survol de la carte — `[]` EXPLICITE pour un kind sans
   * cycle de vie pilotable depuis le graphe. */
  quickActions: QuickLifecycleActionSpec[];
}

// --- Contrat de repli "type inconnu" -------------------------------------------------------------

/**
 * Rendu HONNÊTE d'un nœud dont le kind n'est enregistré par personne : icône neutre, aucun port,
 * aucune action, aucune alerte. Un nœud renvoyé par le serveur reste ainsi VISIBLE (avec un badge
 * "Type inconnu", voir GraphNode) au lieu de faire planter le graphe (comportement d'avant cette
 * passe : `NODE_CONTRACT[kind].ports` sur `undefined`) ou de se retrouver à une position NaN.
 */
export const UNKNOWN_NODE_CONTRACT: NodeContract = {
  icon: IconInfo,
  // Gris ardoise neutre — ne réutilise aucune couleur de kind existant, pour ne pas laisser croire
  // à un type connu sur la MiniMap.
  minimapColor: "#94a3b8",
  // Colonne à droite de tous les kinds du cœur (hycu-appliance = 4760, même pas de 340).
  defaultColumnX: 5100,
  ports: [],
  edgeHealth: null,
  automationStatusSeed: null,
  resourceAlerts: null,
  menuItems: [],
  quickActions: [],
};

// --- Validation à l'enregistrement ---------------------------------------------------------------

export interface NodeContractIssue {
  /** Champ fautif du contrat ("icon", "ports[1].label"…). */
  field: string;
  message: string;
}

/** Même convention que `permissions.graphNodeKinds` d'un manifeste de greffon
 * (packages/plugin-contract/src/validate.ts) : minuscules, chiffres et tirets. */
const KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_CAPABILITIES = new Set<string>(Object.keys(CAPABILITY_DEFS));
const KNOWN_COLOR_TOKENS = new Set<string>(PORT_COLOR_TOKENS);
const KNOWN_SEVERITIES = new Set<string>(["safe", "caution", "destructive"]);
const KNOWN_QUICK_ACTIONS = new Set<string>(["start", "stop", "restart"]);

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validateCondition(when: unknown, field: string, issues: NodeContractIssue[]): void {
  if (when === undefined) return;
  const conditions: unknown[] = Array.isArray(when) ? when : [when];
  conditions.forEach((raw, index) => {
    const at = Array.isArray(when) ? `${field}[${index}]` : field;
    if (typeof raw !== "object" || raw === null) {
      issues.push({ field: at, message: "Condition de visibilité invalide : objet { field, equals?, notEquals?, present? } attendu." });
      return;
    }
    const condition = raw as Partial<NodeStateCondition>;
    if (!isFilledString(condition.field)) {
      issues.push({ field: `${at}.field`, message: "Condition de visibilité sans champ : indiquez le champ du nœud à consulter (ex \"status\")." });
    }
    for (const key of ["equals", "notEquals"] as const) {
      const values = condition[key];
      if (values !== undefined && !Array.isArray(values)) {
        issues.push({ field: `${at}.${key}`, message: `${key} doit être un tableau de valeurs.` });
      }
    }
    if (condition.present !== undefined && typeof condition.present !== "boolean") {
      issues.push({ field: `${at}.present`, message: "present doit être un booléen." });
    }
  });
}

function validateMenuAction(raw: unknown, field: string, issues: NodeContractIssue[]): void {
  if (typeof raw !== "object" || raw === null) {
    issues.push({ field, message: "Action invalide : objet { id, label, … } attendu." });
    return;
  }
  const action = raw as Partial<NodeMenuActionSpec>;
  if (!isFilledString(action.id)) issues.push({ field: `${field}.id`, message: "Action sans identifiant." });
  if (!isFilledString(action.label)) issues.push({ field: `${field}.label`, message: "Action sans libellé : une entrée de menu doit être lisible." });
  if (action.severity !== undefined && !KNOWN_SEVERITIES.has(action.severity)) {
    issues.push({ field: `${field}.severity`, message: `Niveau de danger inconnu "${String(action.severity)}" — attendu "safe", "caution" ou "destructive".` });
  }
  if (action.visible !== undefined && typeof action.visible !== "function") {
    issues.push({ field: `${field}.visible`, message: "visible doit être une fonction (node) => boolean." });
  }
  if (action.disabled !== undefined && typeof action.disabled !== "boolean") {
    issues.push({ field: `${field}.disabled`, message: "disabled doit être un booléen." });
  }
  validateCondition(action.when, `${field}.when`, issues);
}

function validatePort(raw: unknown, field: string, seenIds: Set<string>, issues: NodeContractIssue[]): void {
  if (typeof raw !== "object" || raw === null) {
    issues.push({ field, message: "Port invalide : objet { id, capability, handleType, position, label, colorToken } attendu." });
    return;
  }
  const port = raw as Partial<PortSpec>;
  if (!isFilledString(port.id)) {
    issues.push({ field: `${field}.id`, message: "Port sans identifiant (React Flow ancre chaque arête sur un id de Handle)." });
  } else if (seenIds.has(port.id)) {
    issues.push({ field: `${field}.id`, message: `Deux ports partagent l'id "${port.id}" — un id de Handle est unique au sein d'un même type de nœud.` });
  } else {
    seenIds.add(port.id);
  }
  if (!isFilledString(port.label)) {
    issues.push({ field: `${field}.label`, message: "Port sans libellé : l'infobulle du Handle est obligatoire." });
  }
  if (typeof port.capability !== "string" || !KNOWN_CAPABILITIES.has(port.capability)) {
    issues.push({
      field: `${field}.capability`,
      message: `Capacité inconnue "${String(port.capability)}" — attendu l'une de ${[...KNOWN_CAPABILITIES].join(", ")}.`,
    });
  }
  if (typeof port.colorToken !== "string" || !KNOWN_COLOR_TOKENS.has(port.colorToken)) {
    issues.push({
      field: `${field}.colorToken`,
      message: `Couleur de port inconnue "${String(port.colorToken)}" — attendu l'une de ${PORT_COLOR_TOKENS.join(", ")} (toute autre valeur donnerait un Handle sans style).`,
    });
    return;
  }
  if (port.handleType !== "source" && port.handleType !== "target") {
    issues.push({ field: `${field}.handleType`, message: "handleType doit valoir \"source\" ou \"target\"." });
    return;
  }
  // Convention transverse du graphe (bug réel du 17/08/2026 : des Handles Top/Bottom sur les nœuds
  // Nutanix) — la position d'un Handle ne reflète QUE son rôle, jamais une hypothèse de mise en page.
  const expected = port.handleType === "target" ? Position.Left : Position.Right;
  if (port.position !== expected) {
    issues.push({
      field: `${field}.position`,
      message: `Position ${String(port.position)} interdite : convention du graphe TARGET = Left / SOURCE = Right (attendu ${expected}).`,
    });
  }
}

function validateQuickAction(raw: unknown, field: string, issues: NodeContractIssue[]): void {
  if (typeof raw !== "object" || raw === null) {
    issues.push({ field, message: "Action rapide invalide : objet { action, when? } attendu." });
    return;
  }
  const spec = raw as Partial<QuickLifecycleActionSpec>;
  if (typeof spec.action !== "string" || !KNOWN_QUICK_ACTIONS.has(spec.action)) {
    issues.push({ field: `${field}.action`, message: `Action rapide inconnue "${String(spec.action)}" — attendu "start", "stop" ou "restart".` });
  }
  if (spec.visible !== undefined && typeof spec.visible !== "function") {
    issues.push({ field: `${field}.visible`, message: "visible doit être une fonction (node) => boolean." });
  }
  validateCondition(spec.when, `${field}.when`, issues);
}

/**
 * Contrôle qu'un contrat est COMPLET avant de l'accepter — remplace la totalité qu'assurait le
 * compilateur sur `Record<TopologyNodeKind, NodeContract>`. Rend la liste des manques (vide = valide).
 */
export function validateNodeContract(kind: string, candidate: unknown): NodeContractIssue[] {
  const issues: NodeContractIssue[] = [];
  if (!isFilledString(kind) || !KIND_PATTERN.test(kind)) {
    issues.push({ field: "kind", message: `Type de nœud "${String(kind)}" invalide : minuscules, chiffres et tirets uniquement.` });
  }
  if (typeof candidate !== "object" || candidate === null) {
    issues.push({ field: "contract", message: "Contrat absent : un objet NodeContract est attendu." });
    return issues;
  }
  const contract = candidate as Partial<NodeContract>;
  if (typeof contract.icon !== "function") {
    issues.push({ field: "icon", message: "icon manquante : sans icône, la carte du nœud n'a rien à afficher." });
  }
  if (!isFilledString(contract.minimapColor)) {
    issues.push({ field: "minimapColor", message: "minimapColor manquante : couleur de la MiniMap obligatoire (ex \"#22c55e\")." });
  }
  if (typeof contract.defaultColumnX !== "number" || !Number.isFinite(contract.defaultColumnX)) {
    issues.push({ field: "defaultColumnX", message: "defaultColumnX manquante : sans abscisse par défaut, le nœud se retrouve à une position invalide." });
  }
  if (!Array.isArray(contract.ports)) {
    issues.push({ field: "ports", message: "ports manquants : déclarez [] EXPLICITEMENT pour un type jamais connectable." });
  } else {
    const seenIds = new Set<string>();
    contract.ports.forEach((port, index) => validatePort(port, `ports[${index}]`, seenIds, issues));
  }
  if (contract.edgeHealth !== null && typeof contract.edgeHealth !== "function") {
    issues.push({ field: "edgeHealth", message: "edgeHealth manquante : déclarez null EXPLICITEMENT si ce type ne porte aucun signal de santé." });
  }
  if (contract.automationStatusSeed !== null && typeof contract.automationStatusSeed !== "function") {
    issues.push({ field: "automationStatusSeed", message: "automationStatusSeed manquante : déclarez null EXPLICITEMENT si ce type n'émet aucun statut d'automatisation." });
  }
  if (contract.resourceAlerts !== null) {
    const alerts = contract.resourceAlerts as Partial<ResourceAlertsSpec> | undefined;
    if (
      !alerts ||
      typeof alerts.cpuThresholdPercent !== "number" ||
      !Number.isFinite(alerts.cpuThresholdPercent) ||
      typeof alerts.memoryRatio !== "number" ||
      !Number.isFinite(alerts.memoryRatio)
    ) {
      issues.push({
        field: "resourceAlerts",
        message: "resourceAlerts invalide : { cpuThresholdPercent, memoryRatio } ou null EXPLICITE si ce type n'expose aucune métrique live.",
      });
    }
  }
  // Forme fonction : rien à valider ici, la liste dépend du nœud et n'existe qu'au rendu.
  if (typeof contract.menuItems !== "function") {
    if (!Array.isArray(contract.menuItems)) {
      issues.push({ field: "menuItems", message: "menuItems manquantes : déclarez [] EXPLICITEMENT pour un type sans action propre." });
    } else {
      contract.menuItems.forEach((item, index) => validateMenuAction(item, `menuItems[${index}]`, issues));
    }
  }
  if (!Array.isArray(contract.quickActions)) {
    issues.push({ field: "quickActions", message: "quickActions manquantes : déclarez [] EXPLICITEMENT pour un type sans cycle de vie pilotable." });
  } else {
    contract.quickActions.forEach((raw, index) => validateQuickAction(raw, `quickActions[${index}]`, issues));
  }
  return issues;
}

// --- Le registre ---------------------------------------------------------------------------------

/** Origine d'un contrat — reprise telle quelle dans les messages de refus. */
export const CORE_CONTRACT_SOURCE = "cœur";

interface RegisteredContract {
  contract: NodeContract;
  source: string;
}

const REGISTRY = new Map<string, RegisteredContract>();
/** Refus mémorisés (kind -> message explicite) : le rendu de repli peut ainsi DIRE pourquoi ce
 * type n'est pas rendu normalement, plutôt qu'un "type inconnu" sans cause. */
const REFUSALS = new Map<string, string>();

export type NodeContractRegistration = { ok: true } | { ok: false; message: string; issues: NodeContractIssue[] };

/**
 * Enregistre le contrat d'un type de nœud. Refuse (sans jamais lever) un contrat incomplet ou un
 * kind déjà pris — le message rendu est explicite et mémorisé pour le rendu de repli.
 */
export function registerNodeContract(kind: string, contract: NodeContract, source: string = "greffon"): NodeContractRegistration {
  const issues = validateNodeContract(kind, contract);
  const existing = REGISTRY.get(kind);
  if (existing) {
    issues.push({
      field: "kind",
      message: `Type de nœud "${kind}" déjà enregistré par ${existing.source} — un enregistrement ne remplace jamais un contrat existant.`,
    });
  }
  if (issues.length > 0) {
    const message = `Contrat du type de nœud "${kind}" REFUSÉ (${source}) : ${issues.map((issue) => `${issue.field} — ${issue.message}`).join(" ; ")}`;
    // Mémorisé pour le rendu de repli seulement si ce kind n'a AUCUN contrat valide : un doublon
    // refusé ne doit pas faire passer le contrat déjà en place pour cassé.
    if (!existing) REFUSALS.set(kind, message);
    return { ok: false, message, issues };
  }
  REFUSALS.delete(kind);
  REGISTRY.set(kind, { contract, source });
  return { ok: true };
}

/** Retire un contrat de greffon (déchargement/rechargement) et son éventuel refus mémorisé — un
 * contrat du cœur n'est jamais retirable, il est la base du graphe. */
export function unregisterNodeContract(kind: string): boolean {
  const existing = REGISTRY.get(kind);
  if (existing?.source === CORE_CONTRACT_SOURCE) return false;
  REFUSALS.delete(kind);
  if (!existing) return false;
  REGISTRY.delete(kind);
  return true;
}

/**
 * LECTURE UNIQUE d'un contrat — ne rend jamais `undefined` : un kind non enregistré (greffon absent,
 * contrat refusé, type ajouté côté serveur avant l'interface) retombe sur UNKNOWN_NODE_CONTRACT.
 */
export function nodeContractFor(kind: string): NodeContract {
  return REGISTRY.get(kind)?.contract ?? UNKNOWN_NODE_CONTRACT;
}

export function isNodeKindRegistered(kind: string): boolean {
  return REGISTRY.has(kind);
}

/** Tous les kinds actuellement enregistrés (cœur + greffons), dans l'ordre d'enregistrement. */
export function registeredNodeKinds(): string[] {
  return [...REGISTRY.keys()];
}

export function nodeContractSource(kind: string): string | undefined {
  return REGISTRY.get(kind)?.source;
}

/** Message de refus mémorisé pour ce kind — affiché en infobulle du rendu de repli. */
export function nodeContractRefusal(kind: string): string | undefined {
  return REFUSALS.get(kind);
}

/**
 * Table par kind qui ne rend jamais `undefined` : une clé absente de la table figée est résolue à
 * l'exécution (contrat enregistré par un greffon, sinon contrat de repli). Passerelle pour les
 * consommateurs historiques qui indexent encore une table (COLUMN_X, KIND_ICON…) — un accès direct
 * y renvoyait `undefined` pour un kind hors cœur (position NaN, `<Icon />` sur undefined).
 */
export function tableWithRuntimeFallback<K extends string, T>(table: Record<K, T>, resolve: (kind: string) => T): Record<K, T> {
  const proxy = new Proxy(table, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property in target) return Reflect.get(target, property, receiver);
      return resolve(property);
    },
  });
  return proxy as Record<K, T>;
}
