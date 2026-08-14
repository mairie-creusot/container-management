/**
 * Intégration Nutanix via l'API REST v3 de Prism Central
 * (https://www.nutanix.dev/api-reference/ — "Prism Central API v3").
 *
 * IMPORTANT — contrairement à Docker/Kubernetes, il n'existe PAS de repli sur le jeu de
 * données de démonstration ici (voir demoData.ts) : Nutanix n'y a jamais figuré dans le
 * prototype validé. Le principe reste le même que celui corrigé ce soir pour Kubernetes
 * (voir kubernetes.ts#isKubernetesConfigured) : si Nutanix n'a jamais été configuré via
 * l'assistant, on retourne `null`/`[]` — jamais de fausses données. Si Nutanix EST configuré
 * mais injoignable (Prism Central down, identifiants expirés, réseau...), le repli est
 * simplement "vide" (environnement sans nœuds / liste de VMs vide), pas un jeu de VMs
 * fictives, faute de dataset de démonstration Nutanix.
 */

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { config } from "../config.js";
import { getEffectiveNutanixConfig } from "./setupStore.js";
import type { SetupNutanixConfig } from "./setupStore.js";
import type { ClusterNode, Environment, NutanixHost, NutanixVm, NutanixVmDisk, NutanixVmNetwork } from "../types.js";

/**
 * Config Nutanix effective si complète (URL + identifiants), sinon `null` — sert à la fois de
 * garde "Nutanix a été explicitement configuré ?" (voir isKubernetesConfigured dans
 * kubernetes.ts pour le principe équivalent) et de valeur déjà déchiffrée prête à l'emploi,
 * pour éviter un second appel + une assertion de type dans les fonctions ci-dessous.
 */
async function loadNutanixConfig(): Promise<SetupNutanixConfig | null> {
  const effective = await getEffectiveNutanixConfig();
  if (!effective?.prismCentralUrl || !effective.username || !effective.password) return null;
  return effective;
}

function normalizedBaseUrl(prismCentralUrl: string): string {
  return prismCentralUrl.endsWith("/") ? prismCentralUrl : `${prismCentralUrl}/`;
}

/**
 * POST générique vers l'API v3 de Prism Central (toutes les routes de listing v3 sont des
 * POST, ex: /vms/list, /clusters/list — pas de vrai GET côté Nutanix pour ces ressources).
 * Auth Basic (username/password) sur HTTPS. Implémenté avec `node:https` plutôt que `fetch`
 * pour pouvoir désactiver la vérification TLS (voir config.nutanix.tlsRejectUnauthorized)
 * uniquement pour cette connexion précise, sans toucher au reste du process.
 */
async function nutanixPost<T>(prismCentralUrl: string, path: string, username: string, password: string, body: unknown): Promise<T> {
  const target = new URL(path, normalizedBaseUrl(prismCentralUrl));
  const payload = JSON.stringify(body);
  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${auth}`,
          "Content-Length": Buffer.byteLength(payload),
        },
        rejectUnauthorized: config.nutanix.tlsRejectUnauthorized,
        timeout: config.nutanix.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`Nutanix API request to ${path} failed with status ${status}: ${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
          } catch (err) {
            reject(new Error(`Nutanix API returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Nutanix API request to ${path} timed out after ${config.nutanix.requestTimeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

// --- Formes (partielles) des réponses Prism Central v3 — seuls les champs utilisés ici. Vérifiées
// EN CONDITIONS RÉELLES le 14/08/2026 sur l'instance 172.20.0.10:9440 (CLUSTER_AHV_HDV, 29 VMs, 3
// hôtes physiques, 6 subnets) plutôt que supposées depuis la seule documentation Nutanix. ---

/** Un disque brut (status.resources.disk_list[] / spec.resources.disk_list[]) — device_type vaut
 * "DISK" ou "CDROM" en pratique (vérifié en conditions réelles), jamais traduit/deviné ici. */
interface NutanixDiskEntry {
  uuid?: string;
  device_properties?: { device_type?: string };
  disk_size_bytes?: number;
}

/** Une IP réellement assignée à un NIC (ip_endpoint_list[].ip) — vérifié en conditions réelles :
 * absente pour un NIC sans bail DHCP encore attribué (VM tout juste démarrée) ou VM éteinte. */
interface NutanixIpEndpoint {
  ip?: string;
}

/** Un NIC brut (status.resources.nic_list[] / spec.resources.nic_list[]) — `subnet_reference.name`
 * existe bien en pratique mais n'est PAS le nom canonique (voir fetchNutanixSubnets ci-dessous, qui
 * résout le VRAI nom + vlan_id via /subnets/list plutôt que de faire confiance à cette référence
 * dénormalisée, qui peut dater d'un renommage du subnet). */
interface NutanixNicEntry {
  subnet_reference?: NutanixReference;
  ip_endpoint_list?: NutanixIpEndpoint[];
}

interface NutanixEntityResources {
  power_state?: string;
  num_sockets?: number;
  num_vcpus_per_socket?: number;
  memory_size_mib?: number;
  /** uuid + nom de l'hôte AHV qui exécute ACTUELLEMENT la VM — UNIQUEMENT sur `status.resources`
   * (jamais `spec.resources`, vérifié en conditions réelles) : un placement est un état CONSTATÉ,
   * pas une intention de configuration. IMPORTANT (vérifié en conditions réelles) : `name` ici
   * porte en fait l'IP de l'hyperviseur ("172.20.0.5"), PAS un nom lisible façon "HDVNUTA3" — voir
   * mapVmEntity ci-dessous, qui résout le vrai nom via getNutanixHosts() plutôt que ce champ brut. */
  host_reference?: NutanixReference;
  disk_list?: NutanixDiskEntry[];
  nic_list?: NutanixNicEntry[];
}

interface NutanixReference {
  uuid?: string;
  name?: string;
}

interface NutanixVmEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string; resources?: NutanixEntityResources; cluster_reference?: NutanixReference };
  status?: { name?: string; resources?: NutanixEntityResources; cluster_reference?: NutanixReference };
}

interface NutanixVmsListResponse {
  entities?: NutanixVmEntity[];
  metadata?: { total_matches?: number };
}

interface NutanixClusterEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string };
  status?: { name?: string };
}

interface NutanixClustersListResponse {
  entities?: NutanixClusterEntity[];
}

/** Capacité brute d'un hôte AHV (status.resources) — vérifiée en conditions réelles : AUCUNE stat
 * d'utilisation courante (%CPU/mem) sur cet endpoint, uniquement de la capacité statique. */
interface NutanixHostResources {
  cpu_model?: string;
  num_cpu_cores?: number;
  num_cpu_sockets?: number;
  memory_capacity_mib?: number;
  hypervisor?: { num_vms?: number; hypervisor_full_name?: string };
}

/** IMPORTANT (vérifié en conditions réelles) : `status.cluster_reference` d'un hôte ne porte QUE
 * `kind`/`uuid`, JAMAIS `name` (contrairement à celui d'une VM) — d'où l'absence de `name` ici. */
interface NutanixHostEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string };
  status?: { name?: string; cluster_reference?: NutanixReference; resources?: NutanixHostResources };
}

interface NutanixHostsListResponse {
  entities?: NutanixHostEntity[];
  metadata?: { total_matches?: number };
}

interface NutanixSubnetResources {
  vlan_id?: number;
}

interface NutanixSubnetEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string; resources?: NutanixSubnetResources };
  status?: { name?: string; resources?: NutanixSubnetResources };
}

interface NutanixSubnetsListResponse {
  entities?: NutanixSubnetEntity[];
}

function mapPowerState(raw: string | undefined): NutanixVm["powerState"] {
  if (raw === "ON") return "on";
  if (raw === "OFF") return "off";
  return "unknown";
}

/** uuid de subnet -> nom réel + vlan_id réel, résolus une seule fois par poll (voir
 * fetchNutanixSubnets ci-dessous) — jamais un appel réseau par VM/par NIC. */
type NutanixSubnetByUuid = Map<string, { name: string; vlanId?: number }>;
/** uuid d'hôte AHV -> résumé résolu (voir getNutanixHosts ci-dessous) — même principe : une seule
 * liste récupérée par poll, jamais un appel par VM. */
type NutanixHostByUuid = Map<string, NutanixHost>;

function mapVmEntity(entity: NutanixVmEntity, hostsByUuid: NutanixHostByUuid, subnetsByUuid: NutanixSubnetByUuid): NutanixVm {
  const resources = entity.status?.resources ?? entity.spec?.resources ?? {};
  const numSockets = resources.num_sockets ?? 0;
  const numVcpusPerSocket = resources.num_vcpus_per_socket ?? 0;
  // uuid du cluster physique réel qui héberge cette VM (cluster_reference) — absent seulement si
  // Prism Central ne l'a pas renvoyé (rare) : jamais déduit/inventé. Exposé en plus de `cluster`
  // (le NOM, déjà utilisé pour l'affichage) pour que services/topology.ts puisse relier une VM à
  // son VRAI nœud "host" de cluster par identité stable (uuid), pas par un rapprochement de nom
  // fragile (deux clusters pourraient théoriquement partager un nom).
  const clusterUuid = entity.status?.cluster_reference?.uuid ?? entity.spec?.cluster_reference?.uuid;

  // Placement RÉEL et VIVANT de la VM sur son hôte physique — UNIQUEMENT status.resources (voir
  // NutanixEntityResources#host_reference ci-dessus), jamais spec (pas de notion d'"hôte voulu"
  // côté AHV). `host_reference.name` porte en réalité l'IP de l'hyperviseur (vérifié en conditions
  // réelles) : on préfère le VRAI nom résolu via getNutanixHosts(), avec repli sur cette IP
  // UNIQUEMENT si l'hôte n'a pas pu être retrouvé dans la liste résolue à cet instant précis
  // (course entre deux requêtes) — jamais un nom inventé.
  const hostRef = entity.status?.resources?.host_reference;
  const hostUuid = hostRef?.uuid;
  const resolvedHost = hostUuid ? hostsByUuid.get(hostUuid) : undefined;
  const hostName = resolvedHost?.name ?? hostRef?.name;

  const disks: NutanixVmDisk[] = (resources.disk_list ?? []).map((d) => ({
    ...(d.uuid ? { uuid: d.uuid } : {}),
    deviceType: d.device_properties?.device_type ?? "unknown",
    ...(typeof d.disk_size_bytes === "number" ? { sizeBytes: d.disk_size_bytes } : {}),
  }));

  const networks: NutanixVmNetwork[] = (resources.nic_list ?? []).map((n) => {
    const subnetUuid = n.subnet_reference?.uuid;
    const resolvedSubnet = subnetUuid ? subnetsByUuid.get(subnetUuid) : undefined;
    const subnetName = resolvedSubnet?.name ?? n.subnet_reference?.name;
    return {
      ...(subnetUuid ? { subnetUuid } : {}),
      ...(subnetName ? { subnetName } : {}),
      ...(resolvedSubnet?.vlanId !== undefined ? { vlanId: resolvedSubnet.vlanId } : {}),
      ips: (n.ip_endpoint_list ?? []).map((e) => e.ip).filter((ip): ip is string => Boolean(ip)),
    };
  });

  return {
    id: entity.metadata?.uuid ?? entity.status?.name ?? entity.spec?.name ?? "unknown-vm",
    name: entity.status?.name ?? entity.spec?.name ?? "VM sans nom",
    powerState: mapPowerState(resources.power_state),
    numVcpus: numSockets * numVcpusPerSocket,
    memoryMib: resources.memory_size_mib ?? 0,
    cluster: entity.status?.cluster_reference?.name ?? entity.spec?.cluster_reference?.name ?? "unknown-cluster",
    ...(clusterUuid ? { clusterUuid } : {}),
    ...(hostUuid ? { hostUuid } : {}),
    ...(hostName ? { hostName } : {}),
    ...(disks.length > 0 ? { disks } : {}),
    ...(networks.length > 0 ? { networks } : {}),
  };
}

function mapHostEntity(entity: NutanixHostEntity & { metadata: { uuid: string } }): NutanixHost {
  const resources = entity.status?.resources ?? {};
  const clusterUuid = entity.status?.cluster_reference?.uuid;
  return {
    id: entity.metadata.uuid,
    name: entity.status?.name ?? entity.spec?.name ?? entity.metadata.uuid,
    ...(clusterUuid ? { clusterUuid } : {}),
    ...(resources.cpu_model ? { cpuModel: resources.cpu_model } : {}),
    ...(typeof resources.num_cpu_cores === "number" ? { numCpuCores: resources.num_cpu_cores } : {}),
    ...(typeof resources.num_cpu_sockets === "number" ? { numCpuSockets: resources.num_cpu_sockets } : {}),
    ...(typeof resources.memory_capacity_mib === "number" ? { memoryCapacityMib: resources.memory_capacity_mib } : {}),
    ...(typeof resources.hypervisor?.num_vms === "number" ? { hypervisorNumVms: resources.hypervisor.num_vms } : {}),
    ...(resources.hypervisor?.hypervisor_full_name ? { hypervisorFullName: resources.hypervisor.hypervisor_full_name } : {}),
  };
}

/**
 * Liste les subnets réels (uuid -> nom + vlan_id) — UNE SEULE requête par poll (voir getNutanixVms
 * ci-dessous), jamais un appel par VM/par NIC (le nombre de subnets réels sur l'instance vérifiée
 * le 14/08/2026 est 6, `length: 200` laisse une marge confortable sans jamais avoir eu besoin de
 * paginer sur cette instance — mêmes ordres de grandeur que getNutanixClusters ci-dessous). []
 * (silencieux) en cas d'échec réseau : la résolution VLAN d'une VM retombe alors simplement sur le
 * nom brut de subnet_reference (voir mapVmEntity), jamais un VLAN inventé.
 */
async function fetchNutanixSubnets(effective: SetupNutanixConfig): Promise<NutanixSubnetByUuid> {
  const map: NutanixSubnetByUuid = new Map();
  try {
    const data = await nutanixPost<NutanixSubnetsListResponse>(
      effective.prismCentralUrl,
      "/api/nutanix/v3/subnets/list",
      effective.username,
      effective.password,
      { kind: "subnet", length: 200, offset: 0 },
    );
    for (const s of data.entities ?? []) {
      if (!s.metadata?.uuid) continue;
      const resources = s.status?.resources ?? s.spec?.resources ?? {};
      map.set(s.metadata.uuid, {
        name: s.status?.name ?? s.spec?.name ?? s.metadata.uuid,
        ...(typeof resources.vlan_id === "number" ? { vlanId: resources.vlan_id } : {}),
      });
    }
  } catch {
    // [] silencieux — voir JSDoc ci-dessus.
  }
  return map;
}

/**
 * true si Nutanix a été explicitement configuré via l'assistant (URL + identifiants complets)
 * — même principe que kubernetes.ts#isKubernetesConfigured, utilisé par le watchdog
 * (services/watchdog.ts) pour ne jamais surveiller/notifier une intégration qui n'a jamais été
 * configurée.
 */
export async function isNutanixConfigured(): Promise<boolean> {
  return (await loadNutanixConfig()) !== null;
}

/**
 * Sonde de joignabilité utilisée par le watchdog : true si Prism Central répond avec la config
 * effective persistée. Ne jamais appeler sans avoir vérifié isNutanixConfigured() d'abord
 * (sinon false serait renvoyé pour "jamais configuré", pas pour "injoignable").
 */
export async function isNutanixReachable(): Promise<boolean> {
  const effective = await loadNutanixConfig();
  if (!effective) return false;
  const result = await testNutanixConnection(effective.prismCentralUrl, effective.username, effective.password);
  return result.ok;
}

/**
 * Utilisé par l'assistant de configuration (POST /api/setup/test/nutanix) : teste une config
 * Nutanix candidate (pas encore persistée) sans jamais modifier l'état applicatif.
 */
export async function testNutanixConnection(
  prismCentralUrl: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; message: string; vmCount?: number }> {
  if (!prismCentralUrl || !username || !password) {
    return { ok: false, message: "prismCentralUrl, username et password sont requis" };
  }
  try {
    const data = await nutanixPost<NutanixVmsListResponse>(prismCentralUrl, "/api/nutanix/v3/vms/list", username, password, {
      kind: "vm",
      length: 1,
      offset: 0,
    });
    const vmCount = data.metadata?.total_matches ?? data.entities?.length ?? 0;
    return { ok: true, message: "Prism Central est joignable", vmCount };
  } catch (err) {
    return { ok: false, message: `Prism Central injoignable : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Liste les VMs du cluster Nutanix — [] si Nutanix n'a jamais été configuré (voir
 * loadNutanixConfig ci-dessus, même principe que getKubernetesContainers), également []
 * si configuré mais injoignable : il n'existe pas de jeu de VMs de démonstration Nutanix,
 * donc "repli vide" plutôt que "repli démo" dans ce second cas — jamais de fausses VMs.
 *
 * Récupère EN PLUS, en parallèle et une seule fois par appel (jamais un appel par VM), les hôtes
 * physiques (pour résoudre `hostUuid` en un VRAI nom lisible, voir mapVmEntity) et les subnets
 * (pour résoudre VLAN/nom de chaque NIC) — placement/disques/réseau recalculés à CHAQUE appel,
 * jamais mis en cache entre deux polls (une VM AHV peut migrer d'un hôte à l'autre en live
 * migration, voir services/topology.ts#getNutanixTopologyParts).
 */
export async function getNutanixVms(): Promise<NutanixVm[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];

  try {
    const [vmsData, hosts, subnetsByUuid] = await Promise.all([
      nutanixPost<NutanixVmsListResponse>(
        effective.prismCentralUrl,
        "/api/nutanix/v3/vms/list",
        effective.username,
        effective.password,
        { kind: "vm", length: 500, offset: 0 },
      ),
      getNutanixHosts(),
      fetchNutanixSubnets(effective),
    ]);
    const hostsByUuid: NutanixHostByUuid = new Map(hosts.map((h) => [h.id, h]));
    return (vmsData.entities ?? []).map((e) => mapVmEntity(e, hostsByUuid, subnetsByUuid));
  } catch {
    return [];
  }
}

/**
 * Liste les hôtes physiques AHV réels pilotés par Prism Central — équivalent de
 * getNutanixClusters() ci-dessous mais pour le niveau intermédiaire "hôte physique" du graphe de
 * topologie (services/topology.ts#getNutanixTopologyParts, retour utilisateur : "je devrais voir
 * ce node plus 3 autre vue que jai 3 nutanix" — 3 hôtes confirmés en conditions réelles le
 * 14/08/2026 sur l'instance 172.20.0.10:9440). [] si Nutanix n'a jamais été configuré ou si
 * configuré mais injoignable — même garde que getNutanixVms/getNutanixClusters, jamais d'hôte
 * inventé.
 */
export async function getNutanixHosts(): Promise<NutanixHost[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];

  try {
    const data = await nutanixPost<NutanixHostsListResponse>(
      effective.prismCentralUrl,
      "/api/nutanix/v3/hosts/list",
      effective.username,
      effective.password,
      { kind: "host", length: 100, offset: 0 },
    );
    return (data.entities ?? [])
      .filter((h): h is NutanixHostEntity & { metadata: { uuid: string } } => Boolean(h.metadata?.uuid))
      .map(mapHostEntity);
  } catch {
    return [];
  }
}

/** uuid + nom réel d'un cluster physique Nutanix — voir getNutanixClusters ci-dessous. */
export interface NutanixClusterSummary {
  uuid: string;
  name: string;
}

/**
 * Liste les clusters physiques réels pilotés par Prism Central (uuid + nom) — factorisation
 * minimale de l'appel "/clusters/list" déjà fait par getNutanixEnvironment ci-dessous, ajoutée
 * pour services/topology.ts (un TopologyNode "host" par cluster réel, cf. ARCHITECTURE.md §
 * "Graphe de topologie") : topology.ts a besoin du NOM du cluster (pour le label du nœud), pas
 * seulement de son compteur de VMs déjà exposé par getNutanixEnvironment/ClusterNode — d'où cette
 * fonction dédiée plutôt qu'un élargissement de ClusterNode (qui resterait sans nom, un concept
 * générique partagé avec Kubernetes/Docker Swarm). [] si Nutanix n'a jamais été configuré ou si
 * configuré mais injoignable — même garde que getNutanixVms, jamais de cluster inventé.
 */
export async function getNutanixClusters(): Promise<NutanixClusterSummary[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];

  try {
    const data = await nutanixPost<NutanixClustersListResponse>(
      effective.prismCentralUrl,
      "/api/nutanix/v3/clusters/list",
      effective.username,
      effective.password,
      { kind: "cluster", length: 100, offset: 0 },
    );
    return (data.entities ?? [])
      .filter((c): c is NutanixClusterEntity & { metadata: { uuid: string } } => Boolean(c.metadata?.uuid))
      .map((c) => ({ uuid: c.metadata.uuid, name: c.status?.name ?? c.spec?.name ?? c.metadata.uuid }));
  } catch {
    return [];
  }
}

/**
 * Récupère l'environnement Nutanix avec un nœud par cluster physique Nutanix (Prism Central
 * pilote potentiellement plusieurs clusters). `null` si Nutanix n'a jamais été configuré (pas
 * d'environnement "Nutanix" fictif mélangé aux vrais environnements Docker/Kubernetes dans ce
 * cas — voir loadNutanixConfig) ; repli "vide" (nœuds = []) si configuré mais injoignable.
 */
export async function getNutanixEnvironment(): Promise<Environment | null> {
  const effective = await loadNutanixConfig();
  if (!effective) return null;

  try {
    const [clustersData, vmsData] = await Promise.all([
      nutanixPost<NutanixClustersListResponse>(
        effective.prismCentralUrl,
        "/api/nutanix/v3/clusters/list",
        effective.username,
        effective.password,
        { kind: "cluster", length: 100, offset: 0 },
      ),
      nutanixPost<NutanixVmsListResponse>(
        effective.prismCentralUrl,
        "/api/nutanix/v3/vms/list",
        effective.username,
        effective.password,
        { kind: "vm", length: 500, offset: 0 },
      ),
    ]);

    const vmCountByClusterUuid = new Map<string, number>();
    for (const vm of vmsData.entities ?? []) {
      const clusterUuid = vm.status?.cluster_reference?.uuid ?? vm.spec?.cluster_reference?.uuid;
      if (!clusterUuid) continue;
      vmCountByClusterUuid.set(clusterUuid, (vmCountByClusterUuid.get(clusterUuid) ?? 0) + 1);
    }

    const nodes: ClusterNode[] = (clustersData.entities ?? [])
      .filter((c): c is NutanixClusterEntity & { metadata: { uuid: string } } => Boolean(c.metadata?.uuid))
      .map((c) => ({
        id: c.metadata.uuid,
        environmentId: "nutanix",
        role: "cluster",
        // Nécessiterait l'API de métriques Prism (endpoint distinct, coût/complexité
        // disproportionnés pour ce premier lot) : pas de %CPU/mem temps réel pour l'instant,
        // même limite que pour Kubernetes (memPercent) faute de metrics-server garanti.
        cpuPercent: 0,
        memPercent: 0,
        status: "ok" as const,
        containerCount: vmCountByClusterUuid.get(c.metadata.uuid) ?? 0,
      }));

    return {
      id: "nutanix",
      name: "Nutanix",
      orchestrator: "nutanix",
      status: "ok",
      nodes,
    };
  } catch {
    return {
      id: "nutanix",
      name: "Nutanix",
      orchestrator: "nutanix",
      status: "warn",
      nodes: [],
    };
  }
}
