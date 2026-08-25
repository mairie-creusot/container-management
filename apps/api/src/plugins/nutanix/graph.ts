/**
 * Contribution de Nutanix au graphe — DÉPLACÉE ICI depuis services/topology.ts (migration en
 * greffon), sans changer une seule règle : mêmes identifiants de nœuds, mêmes arêtes, mêmes
 * sous-titres. topology.ts appelle `getNutanixTopologyParts()` exactement comme avant.
 *
 * Deux vues de la MÊME hiérarchie, jamais deux calculs :
 *  - `getNutanixTopologyParts()` : la vue RICHE (TopologyNode/TopologyEdge), celle que l'écran
 *    consomme aujourd'hui — disques, VLAN/IP, placement confirmé, erreur Prism.
 *  - `nutanixGraphContribution()` : la même hiérarchie projetée dans `PluginGraphContribution`, ce
 *    que le contrat de greffon sait exprimer. La projection PERD des informations réelles (voir
 *    plugins/nutanix/index.ts, section « manques du contrat ») : elle n'est donc jamais utilisée
 *    pour rendre l'écran, seulement pour servir le contrat.
 */

import type { PluginGraphContribution, PluginGraphEdge, PluginGraphNode } from "@quai/plugin-contract";
import { getNutanixClusters, getNutanixHosts, getNutanixVms, isNutanixConfigured } from "../../services/nutanix.js";
import type { NutanixVm, TopologyEdge, TopologyNode } from "../../types.js";
import { isPluginDisabled } from "../activation.js";
import { NUTANIX_PLUGIN_ID } from "./config.js";

export const NUTANIX_VM_NODE_PREFIX = "nutanix-vm:";

function mapNutanixPowerState(powerState: NutanixVm["powerState"]): TopologyNode["status"] {
  if (powerState === "on") return "running";
  if (powerState === "off") return "stopped";
  return "neutral";
}

/**
 * Cartes réseau RÉELLES d'une VM (status.resources.nic_list, voir nutanix.ts#NutanixVmNetwork)
 * projetées en tiroirs sous sa carte — MÊME contrat que les réseaux d'un conteneur
 * (TopologyNodeAttachment), pour un rendu unique côté frontend. `networkId` = uuid du subnet, ce
 * qui permet de mettre en évidence les autres VMs du MÊME subnet au survol du tiroir ; absent si
 * Prism Central n'a pas renvoyé de subnet_reference (aucun rapprochement tenté alors). `id` reste
 * unique au sein de la VM même si deux NICs partagent un subnet.
 */
function nutanixVmNetworkAttachments(vm: NutanixVm): NonNullable<TopologyNode["attachments"]> {
  return (vm.networks ?? []).map((nic, index) => {
    const ip = nic.ips[0];
    return {
      kind: "network" as const,
      id: `network:${vm.id}:${index}`,
      label: nic.subnetName ?? "Carte réseau",
      subtitle: typeof nic.vlanId === "number" ? `VLAN ${nic.vlanId}` : "",
      ...(nic.subnetUuid ? { networkId: nic.subnetUuid } : {}),
      ...(ip ? { ipAddress: ip } : {}),
      ...(typeof nic.vlanId === "number" ? { vlanId: nic.vlanId } : {}),
    };
  });
}

function nutanixVmToNode(vm: NutanixVm): TopologyNode {
  const networkAttachments = nutanixVmNetworkAttachments(vm);
  return {
    id: `${NUTANIX_VM_NODE_PREFIX}${vm.id}`,
    kind: "nutanix-vm",
    label: vm.name,
    subtitle: vm.cluster,
    status: mapNutanixPowerState(vm.powerState),
    numVcpus: vm.numVcpus,
    memoryMib: vm.memoryMib,
    // Placement réel + disques/réseau (voir nutanix.ts#NutanixVm, mission "corrige le j'ai rien" —
    // retour utilisateur du 14/08/2026) : simple report des champs déjà résolus par nutanix.ts,
    // aucun recalcul ici — TopologyNodeDetailPanel.tsx les affiche tels quels.
    ...(vm.hostName ? { nutanixHostName: vm.hostName } : {}),
    // Placement CONFIRMÉ en direct (status.resources.host_reference) vs REPLI sur le dernier hôte
    // assigné/déclaré (spec.resources.host_reference) — voir nutanix.ts#mapVmEntity pour le calcul
    // complet. Consommé UNIQUEMENT par topologyGraphShared.tsx (web) pour la couleur/le pointillé
    // d'une arête "hosts" hôte physique -> VM, jamais recalculé ici.
    ...(typeof vm.hostPlacementConfirmed === "boolean" ? { nutanixHostPlacementConfirmed: vm.hostPlacementConfirmed } : {}),
    ...(vm.disks && vm.disks.length > 0 ? { nutanixDisks: vm.disks } : {}),
    ...(vm.networks && vm.networks.length > 0 ? { nutanixNetworks: vm.networks } : {}),
    ...(networkAttachments.length > 0 ? { attachments: networkAttachments } : {}),
    // VRAI état d'erreur Prism Central (status.state === "ERROR"), DISTINCT d'une VM simplement
    // éteinte — voir nutanix.ts#mapVmEntity. Absent (pas false) si aucune erreur.
    ...(vm.apiError ? { nutanixApiError: true, ...(vm.apiErrorMessage ? { nutanixApiErrorMessage: vm.apiErrorMessage } : {}) } : {}),
  };
}

export function nutanixClusterHostNodeId(clusterUuid: string): string {
  return `host:nutanix-cluster:${clusterUuid}`;
}

/** "host:nutanix-host:<uuid>" — voir nutanixClusterHostNodeId ci-dessus pour le même principe au
 * niveau cluster (préfixe distinct : un cluster ET un hôte physique ne partagent jamais le même
 * uuid côté Prism Central, mais le préfixe garde les deux espaces d'id lisiblement séparés). */
export function nutanixHostNodeId(hostUuid: string): string {
  return `host:nutanix-host:${hostUuid}`;
}

/** "256881 Mio" -> "251 Go RAM" (arrondi à l'entier, cohérent avec l'affichage frontend
 * formatMem/topologyGraphShared.tsx) — formaté ici côté backend car ce n'est qu'un sous-titre
 * informatif de nœud, pas une donnée structurée à retraiter côté client. */
function formatHostMemorySubtitle(memoryCapacityMib: number): string {
  return `${(memoryCapacityMib / 1024).toFixed(0)} Go RAM`;
}

/**
 * Nœuds VM Nutanix + nœuds "host" (cluster physique ET, niveau intermédiaire, hôte physique AHV) +
 * arêtes réelles qui les relient — une seule fonction pour l'ensemble (plutôt que des appels
 * séparés) : les arêtes ont besoin des VMs, des clusters ET des hôtes physiques en même temps,
 * autant récupérer les trois d'un coup et les combiner ici.
 *
 * Hiérarchie (retour utilisateur du 14/08/2026 : "je devrais voir ce node plus 3 autre vue que jai
 * 3 nutanix et ensuite tout les node vm" / "je doit pouvoir voir sur quelle cluster et sur quelle
 * node chaque vm tourne car defois elle se deplace" — 3 hôtes physiques confirmés en conditions
 * réelles sur l'instance 172.20.0.10:9440) : cluster (nœud "host"/hostKind "nutanix-cluster", déjà
 * existant) -> hôte physique AHV (nœud "host"/hostKind "nutanix-host", NOUVEAU) -> VM. Le
 * rattachement VM -> hôte est réévalué à CHAQUE appel (jamais figé) : `vm.hostUuid` vient de
 * nutanix.ts#getNutanixVms, recalculé à chaque poll depuis `status.resources.host_reference`
 * (placement live) avec repli sur `spec.resources.host_reference` (dernier hôte assigné/déclaré)
 * pour une VM éteinte — voir nutanix.ts#mapVmEntity. Une VM qui a migré en live migration change
 * donc d'arête dès le prochain rafraîchissement du graphe.
 *
 * Bug réel corrigé le 17/08/2026 (retour utilisateur, capture d'écran à l'appui : "ya un probleme
 * dans les edge normalement je doi en avoir que troie la entre ahv et nut 1 nut 2 nut 3 car les vm
 * sont atacher e ceux ci donc ya des edge en trop") : l'invariant attendu du nœud cluster est au
 * plus une arête PAR HÔTE PHYSIQUE réel. Voir le repli cluster -> VM plus bas, réintroduit le même
 * jour une fois que le frontend a su distinguer visuellement un placement confirmé d'un placement
 * incertain.
 *
 * [] partout si Nutanix n'a jamais été configuré (isNutanixConfigured) — ni VM, ni cluster, ni
 * hôte, ni arête inventée. Si configuré mais injoignable, getNutanixVms()/getNutanixClusters()/
 * getNutanixHosts() retombent chacun sur [] indépendamment : le graphe reste honnêtement vide
 * plutôt que partiellement peuplé avec des données obsolètes.
 */
export async function getNutanixTopologyParts(): Promise<{
  vmNodes: TopologyNode[];
  hostNodes: TopologyNode[];
  hostEdges: TopologyEdge[];
}> {
  // Greffon désactivé : le socle ne le consomme plus, aucun appel réseau et aucun nœud — sa
  // configuration reste écrite et le réactiver le fait réapparaître tel quel.
  if (await isPluginDisabled(NUTANIX_PLUGIN_ID)) return { vmNodes: [], hostNodes: [], hostEdges: [] };
  if (!(await isNutanixConfigured())) return { vmNodes: [], hostNodes: [], hostEdges: [] };

  const [vms, clusters, hosts] = await Promise.all([getNutanixVms(), getNutanixClusters(), getNutanixHosts()]);
  const vmNodes = vms.map(nutanixVmToNode);

  // Nombre RÉEL de VMs par cluster, déduit des VMs déjà récupérées ci-dessus (pas un second appel
  // réseau) — utilisé uniquement pour un sous-titre informatif sur le nœud "host".
  const vmCountByClusterUuid = new Map<string, number>();
  const vmCountByHostUuid = new Map<string, number>();
  for (const vm of vms) {
    if (vm.clusterUuid) vmCountByClusterUuid.set(vm.clusterUuid, (vmCountByClusterUuid.get(vm.clusterUuid) ?? 0) + 1);
    if (vm.hostUuid) vmCountByHostUuid.set(vm.hostUuid, (vmCountByHostUuid.get(vm.hostUuid) ?? 0) + 1);
  }

  const clusterNodes: TopologyNode[] = clusters.map((c) => {
    const vmCount = vmCountByClusterUuid.get(c.uuid) ?? 0;
    return {
      id: nutanixClusterHostNodeId(c.uuid),
      kind: "host",
      hostKind: "nutanix-cluster",
      label: c.name,
      subtitle: `Cluster Nutanix · ${vmCount} VM${vmCount > 1 ? "s" : ""}`,
      // Un cluster qu'on vient de lister via l'API v3 est par définition joignable à cet instant —
      // pas de notion de "cluster configuré mais injoignable" séparée ici : s'il ne l'était pas,
      // getNutanixClusters() ne l'aurait simplement pas renvoyé.
      status: "running",
    };
  });

  const hostPhysicalNodes: TopologyNode[] = hosts.map((h) => {
    const vmCount = vmCountByHostUuid.get(h.id) ?? 0;
    const specParts = [
      typeof h.numCpuCores === "number" ? `${h.numCpuCores} cœurs` : null,
      typeof h.memoryCapacityMib === "number" ? formatHostMemorySubtitle(h.memoryCapacityMib) : null,
    ].filter((p): p is string => p !== null);
    return {
      id: nutanixHostNodeId(h.id),
      kind: "host",
      hostKind: "nutanix-host",
      label: h.name,
      subtitle: [`${vmCount} VM${vmCount > 1 ? "s" : ""}`, ...specParts].join(" · "),
      // Un hôte qu'on vient de lister via l'API v3 est par définition joignable à cet instant —
      // même principe que les nœuds cluster ci-dessus.
      status: "running",
      ...(h.cpuModel ? { nutanixHostCpuModel: h.cpuModel } : {}),
      ...(typeof h.numCpuCores === "number" ? { nutanixHostNumCpuCores: h.numCpuCores } : {}),
      ...(typeof h.numCpuSockets === "number" ? { nutanixHostNumCpuSockets: h.numCpuSockets } : {}),
      ...(typeof h.memoryCapacityMib === "number" ? { nutanixHostMemoryCapacityMib: h.memoryCapacityMib } : {}),
      ...(h.hypervisorFullName ? { nutanixHostHypervisorFullName: h.hypervisorFullName } : {}),
    };
  });

  const knownClusterUuids = new Set(clusters.map((c) => c.uuid));
  const knownHostUuids = new Set(hosts.map((h) => h.id));
  const hostEdges: TopologyEdge[] = [];

  // Cluster -> hôte physique (niveau intermédiaire) — jamais d'arête vers un cluster qu'on n'a pas
  // pu lister soi-même (course entre les deux appels, cluster supprimé entre-temps...).
  for (const h of hosts) {
    if (!h.clusterUuid || !knownClusterUuids.has(h.clusterUuid)) continue;
    hostEdges.push({ id: `hosts:${h.clusterUuid}:${h.id}`, source: nutanixClusterHostNodeId(h.clusterUuid), target: nutanixHostNodeId(h.id), kind: "hosts" });
  }

  // Hôte physique -> VM (placement réel, voir JSDoc ci-dessus : status.resources.host_reference en
  // priorité, repli spec.resources.host_reference pour une VM éteinte).
  //
  // Repli cluster -> VM RÉINTRODUIT le 17/08/2026 (retiré plus tôt le même jour, puis remis après
  // retour utilisateur : "les vm arreter ici se sont pas relier" — un nœud totalement flottant,
  // sans AUCUNE arête, est pire qu'un rattachement honnêtement affiché comme non confirmé). Ce qui
  // a changé entre-temps : buildTopologyEdges (topologyGraphShared.tsx) sait maintenant distinguer
  // visuellement un placement confirmé en direct (vert plein) d'un placement incertain (gris,
  // tirets larges pour une VM éteinte) — le problème d'origine n'était donc pas "une arête
  // cluster->VM existe", mais "elle ressemblait exactement à une arête hôte->VM confirmée". Une VM
  // sans hôte déterminable par AUCUN des deux champs (status ni spec), ou dont l'hôte référencé
  // n'est plus dans la liste réellement retournée par getNutanixHosts() à cet instant (course entre
  // deux requêtes), se rattache donc au CLUSTER plutôt qu'à un hôte précis — jamais inventé,
  // toujours visuellement distingué comme non confirmé côté frontend.
  for (const vm of vms) {
    if (vm.hostUuid && knownHostUuids.has(vm.hostUuid)) {
      hostEdges.push({ id: `hosts:${vm.hostUuid}:${vm.id}`, source: nutanixHostNodeId(vm.hostUuid), target: `${NUTANIX_VM_NODE_PREFIX}${vm.id}`, kind: "hosts" });
    } else if (vm.clusterUuid && knownClusterUuids.has(vm.clusterUuid)) {
      hostEdges.push({ id: `hosts:${vm.clusterUuid}:${vm.id}`, source: nutanixClusterHostNodeId(vm.clusterUuid), target: `${NUTANIX_VM_NODE_PREFIX}${vm.id}`, kind: "hosts" });
    }
  }

  return { vmNodes, hostNodes: [...clusterNodes, ...hostPhysicalNodes], hostEdges };
}

/** Types de nœuds contribués — doit rester égal à `permissions.graphNodeKinds` du manifeste. */
export const NUTANIX_GRAPH_NODE_KINDS = ["nutanix-cluster", "nutanix-host", "nutanix-vm"] as const;

/** Le contrat n'a qu'un `kind` : le couple (kind "host", hostKind "nutanix-cluster"/"nutanix-host")
 * du graphe réel y devient un kind à part entière. Les identifiants de nœuds, eux, sont INCHANGÉS. */
function contractKind(node: TopologyNode): string {
  if (node.kind === "nutanix-vm") return "nutanix-vm";
  return node.hostKind === "nutanix-cluster" ? "nutanix-cluster" : "nutanix-host";
}

/** `details` du contrat n'accepte que des chaînes et des nombres : seules les valeurs RÉELLEMENT
 * présentes sont reportées, jamais un 0 ni un "inconnu" fabriqué. */
function contractDetails(node: TopologyNode): Record<string, string | number> {
  const details: Record<string, string | number> = {};
  if (typeof node.numVcpus === "number") details["vCPU"] = node.numVcpus;
  if (typeof node.memoryMib === "number") details["Mémoire (Mio)"] = node.memoryMib;
  if (node.nutanixHostName) details["Hôte physique"] = node.nutanixHostName;
  if (typeof node.nutanixHostPlacementConfirmed === "boolean") {
    details["Placement"] = node.nutanixHostPlacementConfirmed ? "confirmé en direct" : "dernier hôte déclaré";
  }
  if (node.nutanixApiErrorMessage) details["Erreur Prism Central"] = node.nutanixApiErrorMessage;
  if (node.nutanixHostCpuModel) details["Processeur"] = node.nutanixHostCpuModel;
  if (typeof node.nutanixHostNumCpuCores === "number") details["Cœurs"] = node.nutanixHostNumCpuCores;
  if (typeof node.nutanixHostNumCpuSockets === "number") details["Sockets"] = node.nutanixHostNumCpuSockets;
  if (typeof node.nutanixHostMemoryCapacityMib === "number") details["Mémoire (Mio)"] = node.nutanixHostMemoryCapacityMib;
  if (node.nutanixHostHypervisorFullName) details["Hyperviseur"] = node.nutanixHostHypervisorFullName;
  return details;
}

/** Ce que le nœud porte EN PLUS de son en-tête (id/label/subtitle/status) : tout le reste du
 * TopologyNode déjà construit, `kind`/`hostKind`/disques/cartes réseau/tiroirs compris. Le socle le
 * recopie tel quel sur le nœud du graphe (PluginGraphNode#fields) — c'est ce qui rend la projection
 * SANS PERTE, là où `details` (chaînes et nombres, libellés humains) ne pouvait pas la porter. */
const NODE_HEADER_KEYS: ReadonlySet<string> = new Set(["id", "label", "subtitle", "status"]);

function contractFields(node: TopologyNode): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!NODE_HEADER_KEYS.has(key)) fields[key] = value;
  }
  return fields;
}

/**
 * La MÊME hiérarchie cluster -> hôte -> VM, exprimée dans le contrat de greffon : mêmes
 * identifiants de nœuds et d'arêtes qu'aujourd'hui, donc la même forme de graphe.
 *
 * Deux façons de décrire un même nœud, volontairement :
 *  - `details` : la vue PORTABLE (libellés humains), lisible par n'importe quel consommateur du
 *    contrat, incapable de transporter un disque ou une carte réseau ;
 *  - `fields` : la charge utile recopiée telle quelle par le socle, seule à préserver le couple
 *    (kind "host", hostKind "nutanix-cluster"/"nutanix-host"), les disques, les VLAN/IP réels.
 * Même remarque pour les tiroirs : `attachments` en est la vue portable (voir index.ts, manque
 * n°5), `fields.attachments` la version réelle que l'écran consomme.
 *
 * `rootAttachment` (nouveau) répond au manque n°8 : un cluster Nutanix EST un environnement, il se
 * rattache donc au nœud MASTER — le socle n'a plus à savoir que "nutanix-cluster" en est un.
 */
export async function nutanixGraphContribution(): Promise<PluginGraphContribution> {
  const { vmNodes, hostNodes, hostEdges } = await getNutanixTopologyParts();

  // VMs puis hôtes : le MÊME ordre que celui dans lequel le graphe les listait avant l'agrégation.
  const nodes: PluginGraphNode[] = [...vmNodes, ...hostNodes].map((node) => {
    const details = contractDetails(node);
    return {
      id: node.id,
      kind: contractKind(node),
      label: node.label,
      subtitle: node.subtitle,
      status: node.status,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(node.hostKind === "nutanix-cluster" ? { rootAttachment: "environment" as const } : {}),
      fields: contractFields(node),
    };
  });

  const edges: PluginGraphEdge[] = hostEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  }));

  const attachments = vmNodes.flatMap((node) =>
    (node.attachments ?? []).map((attachment) => ({
      nodeId: node.id,
      kind: attachment.kind,
      id: attachment.id,
      label: attachment.label,
      subtitle: attachment.subtitle,
    })),
  );

  return { nodes, edges, attachments };
}
