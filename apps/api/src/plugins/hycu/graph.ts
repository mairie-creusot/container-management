/**
 * Contribution de HYCU au graphe de topologie — la partie du greffon qui n'est PAS tabulaire.
 *
 * Deux niveaux, volontairement séparés :
 *  1. `buildHycuGraph` : la RÈGLE, à partir d'un instantané HYCU réel — nœud, arêtes et annotations
 *     de VM. Une seule implémentation, partagée par les deux voies ci-dessous ;
 *  2. `hycuGraphContribution` : ce que le socle consomme (Plugin#graph), en deux temps — le nœud de
 *     l'appliance d'abord, puis `link()` une fois TOUS les greffons passés, seul moment où les VMs
 *     Nutanix existent (voir PluginGraphContext). `hycuTopologyParts` en reste la vue directe, pour
 *     un appelant qui a déjà les nœuds VM sous la main.
 *
 * Sens de l'arête "protects" : de la VM Nutanix VERS l'appliance (la VM porte la sortie, HYCU n'a
 * que des entrées) — choix délibéré du 25/08/2026, à ne pas inverser.
 *
 * RAPPROCHEMENT HYCU <-> Nutanix, par ordre de fiabilité décroissante, jamais au-delà :
 *  1. `externalId` (uuid de la VM côté hyperviseur, renseigné par le contrôleur réel) === uuid
 *     d'une VM Nutanix ;
 *  2. `uuid` (identifiant interne de l'objet HYCU) === uuid d'une VM Nutanix — l'égalité stricte
 *     avec une VM réellement listée par Prism Central se prouve d'elle-même quand elle se produit ;
 *  3. `vmName` === nom exact d'UNE SEULE VM Nutanix, ET ce nom n'apparaît qu'une fois côté HYCU :
 *     toute ambiguïté (homonymes d'un côté ou de l'autre) ne produit AUCUNE arête ni annotation
 *     plutôt qu'un rapprochement au hasard.
 * Une VM HYCU qui ne correspond à rien reste visible sur la page Sauvegardes, simplement sans lien
 * dans le graphe.
 */

import type {
  PluginGraphAnnotation,
  PluginGraphContext,
  PluginGraphContribution,
  PluginGraphEdge,
  PluginGraphLinks,
  PluginGraphNode,
} from "@quai/plugin-contract";
import { getHycuTopologySnapshot, hycuVmProtectionState, lastKnownHycuPoll } from "../../services/hycu.js";
import type { HycuPollOutcome, HycuTopologySnapshot } from "../../services/hycu.js";
import type { HycuVmProtectionState, TopologyEdge, TopologyNode } from "../../types.js";
import { isPluginDisabled } from "../activation.js";
import { HYCU_PLUGIN_ID } from "./config.js";

/** Type de nœud contribué — la MÊME valeur que `permissions.graphNodeKinds` du manifeste. */
export const HYCU_GRAPH_NODE_KIND = "hycu-appliance";

/** Au plus un nœud : une seule appliance HYCU peut être configurée. */
export const HYCU_NODE_ID = "hycu-appliance:main";

/**
 * Type de nœud contribué par le greffon NUTANIX, tel qu'il le déclare publiquement dans son
 * manifeste (`permissions.graphNodeKinds`) — c'est par ce vocabulaire, jamais en important son
 * code, que HYCU retrouve les VMs à relier à ses sauvegardes. Nutanix absent ou en pause : aucune
 * VM dans le contexte, donc aucune arête, jamais une erreur.
 */
const NUTANIX_VM_GRAPH_NODE_KIND = "nutanix-vm";

/** Nœud DÉJÀ présent dans le graphe auquel le greffon se raccroche — fourni par le contexte de la
 * phase 2 (PluginGraphContext), qui porte les nœuds de TOUS les greffons. */
export interface HycuGraphVmNode {
  /** id du nœud de graphe ("nutanix-vm:<uuid>"). */
  id: string;
  /** Nom affiché de la VM — support du rapprochement par nom exact non ambigu. */
  label: string;
}

/**
 * Ce que HYCU pose SUR un nœud VM existant, dans le vocabulaire du greffon. Sa forme CONTRACTUELLE
 * est `PluginGraphAnnotation` (nodeId + champs recopiés sur le nœud), produite par `hycuGraphLinks`
 * ci-dessous : le socle n'a plus à connaître les quatre champs de protection par leur nom.
 */
export interface HycuVmGraphAnnotation {
  nodeId: string;
  protection: HycuVmProtectionState;
  policyName?: string;
  complianceStatus?: string;
  /** ISO 8601 de la dernière sauvegarde réellement rapportée. */
  lastBackupAt?: string;
}

export interface HycuGraphResult {
  contribution: PluginGraphContribution;
  vmAnnotations: HycuVmGraphAnnotation[];
}

/**
 * Compteurs RÉELS du dernier poll — les mêmes valeurs servent deux fois, jamais deux calculs :
 * `details` en est la vue portable du contrat (n'importe quel consommateur y lit des paires
 * clé/valeur), `fields` la charge utile que le socle recopie telle quelle sur le nœud du graphe.
 * Elles coïncident ici parce que les compteurs HYCU sont déjà des champs de TopologyNode.
 */
function applianceCounters(snapshot: HycuTopologySnapshot, lastPoll: HycuPollOutcome | null): Record<string, string | number> {
  const counts = snapshot.counts;
  return {
    ...(counts
      ? {
          hycuVmTotal: counts.vms,
          hycuProtectedVmCount: counts.protectedVms,
          hycuPolicyCount: counts.policies,
          hycuTargetCount: counts.targets,
          hycuFailedJobCount: counts.failedJobs,
        }
      : {}),
    ...(lastPoll ? { hycuLastPollAt: lastPoll.at } : {}),
  };
}

function applianceNode(snapshot: HycuTopologySnapshot, lastPoll: HycuPollOutcome | null): PluginGraphNode {
  const details = applianceCounters(snapshot, lastPoll);
  return {
    id: HYCU_NODE_ID,
    kind: HYCU_GRAPH_NODE_KIND,
    label: "HYCU",
    subtitle: snapshot.url,
    status: snapshot.reachable ? "running" : "stopped",
    ...(Object.keys(details).length > 0 ? { details } : {}),
    // L'appliance se rattache au nœud MASTER sans être un ENVIRONNEMENT : elle n'héberge rien, elle
    // protège. Le socle n'a plus à connaître "hycu-appliance" pour le savoir.
    rootAttachment: "integration",
    fields: { ...details },
  };
}

/**
 * Nœud "hycu-appliance" + arêtes "protects" + annotations de protection, à partir d'UN instantané
 * déjà récupéré (jamais un second poll). `vmNodes` vide = aucun rapprochement possible : le greffon
 * contribue alors son nœud SEUL, jamais une arête vers un identifiant supposé.
 */
export function buildHycuGraph(
  snapshot: HycuTopologySnapshot,
  lastPoll: HycuPollOutcome | null,
  vmNodes: readonly HycuGraphVmNode[],
): HycuGraphResult {
  const node = applianceNode(snapshot, lastPoll);
  if (!snapshot.reachable) {
    return { contribution: { nodes: [node], edges: [], attachments: [] }, vmAnnotations: [] };
  }

  const vmNodeByUuid = new Map<string, HycuGraphVmNode>();
  const vmNodesByLabel = new Map<string, HycuGraphVmNode[]>();
  for (const vmNode of vmNodes) {
    vmNodeByUuid.set(vmNode.id.slice("nutanix-vm:".length), vmNode);
    const list = vmNodesByLabel.get(vmNode.label) ?? [];
    list.push(vmNode);
    vmNodesByLabel.set(vmNode.label, list);
  }
  const hycuVmCountByName = new Map<string, number>();
  for (const vm of snapshot.vms) hycuVmCountByName.set(vm.vmName, (hycuVmCountByName.get(vm.vmName) ?? 0) + 1);

  const edges: PluginGraphEdge[] = [];
  const vmAnnotations: HycuVmGraphAnnotation[] = [];
  for (const vm of snapshot.vms) {
    const byExternalId = vm.externalId ? vmNodeByUuid.get(vm.externalId) : undefined;
    const byUuid = vmNodeByUuid.get(vm.uuid);
    const sameName = vmNodesByLabel.get(vm.vmName) ?? [];
    const byName = sameName.length === 1 && hycuVmCountByName.get(vm.vmName) === 1 ? sameName[0] : undefined;
    const vmNode = byExternalId ?? byUuid ?? byName;
    if (!vmNode) continue;

    vmAnnotations.push({
      nodeId: vmNode.id,
      protection: hycuVmProtectionState(vm, snapshot.lastBackupFieldPresent),
      ...(vm.policyName ? { policyName: vm.policyName } : {}),
      ...(vm.complianceStatus ? { complianceStatus: vm.complianceStatus } : {}),
      ...(typeof vm.lastBackupInMillis === "number"
        ? { lastBackupAt: new Date(vm.lastBackupInMillis).toISOString() }
        : {}),
    });
    // Arête UNIQUEMENT pour une VM réellement assignée à une policy : une VM connue de HYCU mais
    // non protégée porte son badge, jamais un lien de sauvegarde qui n'existe pas.
    if (vm.protectionGroupUuid) {
      edges.push({ id: `protects:${vm.uuid}:${vmNode.id}`, source: vmNode.id, target: HYCU_NODE_ID, kind: "protects" });
    }
  }
  return { contribution: { nodes: [node], edges, attachments: [] }, vmAnnotations };
}

function numberDetail(details: Record<string, string | number> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringDetail(details: Record<string, string | number> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Projection d'un nœud contribué sur TopologyNode — `null` pour un `kind` que le graphe ne sait
 * pas rendre (le contrat laisse `kind` libre, TopologyNodeKind est une union fermée). */
function toTopologyNode(node: PluginGraphNode): TopologyNode | null {
  if (node.kind !== HYCU_GRAPH_NODE_KIND) return null;
  const vmTotal = numberDetail(node.details, "hycuVmTotal");
  const protectedVms = numberDetail(node.details, "hycuProtectedVmCount");
  const policies = numberDetail(node.details, "hycuPolicyCount");
  const targets = numberDetail(node.details, "hycuTargetCount");
  const failedJobs = numberDetail(node.details, "hycuFailedJobCount");
  const lastPollAt = stringDetail(node.details, "hycuLastPollAt");
  return {
    id: node.id,
    kind: "hycu-appliance",
    label: node.label,
    subtitle: node.subtitle,
    status: node.status,
    ...(vmTotal !== undefined ? { hycuVmTotal: vmTotal } : {}),
    ...(protectedVms !== undefined ? { hycuProtectedVmCount: protectedVms } : {}),
    ...(policies !== undefined ? { hycuPolicyCount: policies } : {}),
    ...(targets !== undefined ? { hycuTargetCount: targets } : {}),
    ...(failedJobs !== undefined ? { hycuFailedJobCount: failedJobs } : {}),
    ...(lastPollAt !== undefined ? { hycuLastPollAt: lastPollAt } : {}),
  };
}

function toTopologyEdge(edge: PluginGraphEdge): TopologyEdge | null {
  if (edge.kind !== "protects") return null;
  return { id: edge.id, source: edge.source, target: edge.target, kind: "protects" };
}

/**
 * Vue DIRECTE : nœud + arêtes HYCU projetés sur les types du graphe, annotations POSÉES sur les
 * nœuds VM fournis (une seule source de vérité par nœud, pas de table parallèle à recroiser côté
 * frontend). Aucun nœud tant que HYCU n'a jamais été configuré (`null` du snapshot) ; nœud
 * "stopped" sans compteur ni arête si configuré mais injoignable.
 *
 * Ce n'est plus la voie du socle — il agrège `Plugin#graph()` (services/topology.ts) — mais elle
 * s'appuie sur EXACTEMENT le même calcul (`buildHycuGraph`) : les deux ne peuvent pas diverger.
 */
export async function hycuTopologyParts(
  nutanixVmNodes: TopologyNode[],
): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[] }> {
  // Greffon désactivé : le socle ne le consomme plus, ni nœud ni annotation de protection — sa
  // configuration reste écrite et le réactiver le fait réapparaître tel quel.
  if (await isPluginDisabled(HYCU_PLUGIN_ID)) return { nodes: [], edges: [] };

  const snapshot = await getHycuTopologySnapshot();
  if (!snapshot) return { nodes: [], edges: [] };

  const { contribution, vmAnnotations } = buildHycuGraph(snapshot, lastKnownHycuPoll(), nutanixVmNodes);
  const vmNodeById = new Map(nutanixVmNodes.map((n) => [n.id, n]));
  for (const annotation of vmAnnotations) {
    const vmNode = vmNodeById.get(annotation.nodeId);
    if (!vmNode) continue;
    vmNode.hycuProtection = annotation.protection;
    if (annotation.policyName) vmNode.hycuPolicyName = annotation.policyName;
    if (annotation.complianceStatus) vmNode.hycuComplianceStatus = annotation.complianceStatus;
    if (annotation.lastBackupAt) vmNode.hycuLastBackupAt = annotation.lastBackupAt;
  }

  const nodes = contribution.nodes.map(toTopologyNode).filter((n): n is TopologyNode => n !== null);
  const edges = contribution.edges.map(toTopologyEdge).filter((e): e is TopologyEdge => e !== null);
  return { nodes, edges };
}

/** Forme CONTRACTUELLE de l'annotation : les quatre champs de protection, tels quels, sur le nœud
 * VM visé. Aucun n'est inventé — un champ que HYCU n'a pas rapporté reste absent. */
function annotationOf(annotation: HycuVmGraphAnnotation): PluginGraphAnnotation {
  return {
    nodeId: annotation.nodeId,
    fields: {
      hycuProtection: annotation.protection,
      ...(annotation.policyName ? { hycuPolicyName: annotation.policyName } : {}),
      ...(annotation.complianceStatus ? { hycuComplianceStatus: annotation.complianceStatus } : {}),
      ...(annotation.lastBackupAt ? { hycuLastBackupAt: annotation.lastBackupAt } : {}),
    },
  };
}

/**
 * PHASE 2 : le graphe complet est là, les VMs Nutanix aussi. Le rapprochement (uuid, puis nom exact
 * non ambigu — voir buildHycuGraph) est fait ICI, par le greffon qui connaît la règle, jamais par le
 * socle. `snapshot` est celui de la phase 1, capturé par la fermeture : l'appliance n'est JAMAIS
 * interrogée une seconde fois dans le même cycle.
 */
function hycuGraphLinks(
  snapshot: HycuTopologySnapshot,
  lastPoll: HycuPollOutcome | null,
  context: PluginGraphContext,
): PluginGraphLinks {
  const vmNodes = context
    .nodesOfKind(NUTANIX_VM_GRAPH_NODE_KIND)
    .map((node) => ({ id: node.id, label: node.label }));
  const { contribution, vmAnnotations } = buildHycuGraph(snapshot, lastPoll, vmNodes);
  return { edges: contribution.edges, annotations: vmAnnotations.map(annotationOf) };
}

/**
 * Contribution du greffon (voir Plugin#graph) : le nœud de l'appliance en phase 1, puis `link` pour
 * relier les VMs sauvegardées en phase 2. Pas de `link` quand il n'y a rien à contribuer — une
 * contribution vide reste littéralement vide.
 */
export async function hycuGraphContribution(): Promise<PluginGraphContribution> {
  if (await isPluginDisabled(HYCU_PLUGIN_ID)) return { nodes: [], edges: [], attachments: [] };
  const snapshot = await getHycuTopologySnapshot();
  if (!snapshot) return { nodes: [], edges: [], attachments: [] };
  const lastPoll = lastKnownHycuPoll();
  return {
    ...buildHycuGraph(snapshot, lastPoll, []).contribution,
    link: (context) => hycuGraphLinks(snapshot, lastPoll, context),
  };
}
