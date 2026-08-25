/**
 * Contribution de HYCU au graphe de topologie — la partie du greffon qui n'est PAS tabulaire.
 *
 * Deux niveaux, volontairement séparés :
 *  1. `buildHycuGraph` : ce que le CONTRAT sait exprimer (PluginGraphContribution) à partir d'un
 *     instantané HYCU réel, plus les annotations de VM que le contrat ne sait PAS exprimer
 *     (voir HycuVmGraphAnnotation ci-dessous) ;
 *  2. `hycuTopologyParts` : la colle côté socle qui projette cette contribution sur les types du
 *     graphe (TopologyNode/TopologyEdge) et applique les annotations. Elle vit ici tant que le
 *     socle ne sait pas consommer `Plugin#graph()` lui-même — c'est le seul endroit qui connaît à
 *     la fois le contrat et le graphe.
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

import type { PluginGraphContribution, PluginGraphEdge, PluginGraphNode } from "@quai/plugin-contract";
import { getHycuTopologySnapshot, hycuVmProtectionState, lastKnownHycuPoll } from "../../services/hycu.js";
import type { HycuPollOutcome, HycuTopologySnapshot } from "../../services/hycu.js";
import type { HycuVmProtectionState, TopologyEdge, TopologyNode } from "../../types.js";
import { isPluginDisabled } from "../activation.js";
import { HYCU_PLUGIN_ID } from "./config.js";

/** Type de nœud contribué — la MÊME valeur que `permissions.graphNodeKinds` du manifeste. */
export const HYCU_GRAPH_NODE_KIND = "hycu-appliance";

/** Au plus un nœud : une seule appliance HYCU peut être configurée. */
export const HYCU_NODE_ID = "hycu-appliance:main";

/** Nœud DÉJÀ présent dans le graphe auquel le greffon peut se raccrocher. Le contrat ne prévoit
 * rien de tel : sans ce contexte, `graph()` ne peut désigner aucune VM sans l'inventer. */
export interface HycuGraphVmNode {
  /** id du nœud de graphe ("nutanix-vm:<uuid>"). */
  id: string;
  /** Nom affiché de la VM — support du rapprochement par nom exact non ambigu. */
  label: string;
}

/**
 * Ce que HYCU pose SUR un nœud VM existant. Hors contrat : `PluginGraphAttachment` décrit un tiroir
 * (kind/label/subtitle) sous une carte, pas l'enrichissement d'un nœud contribué par un autre.
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

function applianceNode(snapshot: HycuTopologySnapshot, lastPoll: HycuPollOutcome | null): PluginGraphNode {
  const counts = snapshot.counts;
  const details: Record<string, string | number> = {
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
  return {
    id: HYCU_NODE_ID,
    kind: HYCU_GRAPH_NODE_KIND,
    label: "HYCU",
    subtitle: snapshot.url,
    status: snapshot.reachable ? "running" : "stopped",
    ...(Object.keys(details).length > 0 ? { details } : {}),
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
 * Nœud + arêtes HYCU pour services/topology.ts, annotations POSÉES sur les nœuds VM fournis (comme
 * avant la migration : une seule source de vérité par nœud, pas de table parallèle à recroiser côté
 * frontend). Aucun nœud tant que HYCU n'a jamais été configuré (`null` du snapshot) ; nœud
 * "stopped" sans compteur ni arête si configuré mais injoignable.
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

/** Contribution du greffon SANS contexte de graphe (voir Plugin#graph) : le nœud seul. */
export async function hycuGraphContribution(): Promise<PluginGraphContribution> {
  if (await isPluginDisabled(HYCU_PLUGIN_ID)) return { nodes: [], edges: [], attachments: [] };
  const snapshot = await getHycuTopologySnapshot();
  if (!snapshot) return { nodes: [], edges: [], attachments: [] };
  return buildHycuGraph(snapshot, lastKnownHycuPoll(), []).contribution;
}
