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
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { config } from "../config.js";
import { getEffectiveNutanixConfig } from "./setupStore.js";
import type { SetupNutanixConfig } from "./setupStore.js";
import type {
  ClusterNode,
  Environment,
  NutanixHost,
  NutanixImageSummary,
  NutanixTaskStatus,
  NutanixVm,
  NutanixVmDisk,
  NutanixVmNetwork,
} from "../types.js";

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

/**
 * GET/PUT/DELETE générique vers l'API v3 de Prism Central — pendant de nutanixPost ci-dessus, mais
 * pour les actions de cycle de vie/migration/suppression d'UNE ressource individuelle (mission
 * "démarrer/arrêter/redémarrer/supprimer/migrer une VM", voir plus bas). Vérifié EN CONDITIONS
 * RÉELLES le 14/08/2026 sur l'instance 172.20.0.10:9440 (VM réelle "HDVAPPLI", GET UNIQUEMENT —
 * voir garde-fou de prudence en tête de ce fichier de mission) : contrairement aux endpoints
 * `/list` (toujours POST, voir nutanixPost), une ressource individuelle suit le modèle REST v3
 * classique sur `/vms/{uuid}` : GET renvoie l'entité complète (api_version + metadata + spec +
 * status), PUT la met à jour en renvoyant la MÊME forme, DELETE la supprime. Prism Central v3 n'a
 * PAS de sous-ressource d'action dédiée façon v1/v2 (`/vms/{uuid}/set_power_state`,
 * `/vms/{uuid}/migrate`) — confirmé par la forme réelle observée, jamais supposé depuis la seule
 * documentation : toute mutation passe par un PUT déclaratif de l'entité entière.
 */
async function nutanixRequest<T>(
  prismCentralUrl: string,
  method: "GET" | "PUT" | "DELETE" | "POST",
  path: string,
  username: string,
  password: string,
  body?: unknown,
): Promise<{ status: number; data: T | null; raw: string }> {
  const target = new URL(path, normalizedBaseUrl(prismCentralUrl));
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${auth}`,
          ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
          try {
            resolve({ status, data: raw ? (JSON.parse(raw) as T) : null, raw });
          } catch (err) {
            reject(new Error(`Nutanix API returned invalid JSON for ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Nutanix API request ${method} ${path} timed out after ${config.nutanix.requestTimeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    if (payload !== undefined) req.write(payload);
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
  /** uuid + nom de l'hôte AHV — sur `status.resources`, c'est l'hôte qui exécute ACTUELLEMENT la VM
   * (état CONSTATÉ, absent pour une VM éteinte : Prism Central ne rapporte un placement live que
   * pour une VM allumée, vérifié en conditions réelles le 14/08/2026). Retour utilisateur du
   * 17/08/2026 (VMs éteintes rattachées à tort directement au nœud cluster faute d'hôte
   * déterminable, voir mapVmEntity) : `spec.resources.host_reference` porte lui le dernier hôte
   * ASSIGNÉ/déclaré à la VM et reste présent même VM éteinte pour toute VM déjà démarrée au moins
   * une fois — utilisé désormais comme repli quand `status.resources.host_reference` est absent.
   * Vérification en conditions réelles de CE repli spec précis bloquée le 17/08/2026 par une
   * indisponibilité temporaire de l'instance 172.20.0.10:9440 (401 Prism Central, condition
   * externe) — à reconfirmer dès l'instance de nouveau joignable (voir mapVmEntity pour le detail
   * du repli et le cas résiduel où AUCUN des deux n'est renseigné). IMPORTANT (vérifié en
   * conditions réelles) : `name` ici porte en fait l'IP de l'hyperviseur ("172.20.0.5"), PAS un nom
   * lisible façon "HDVNUTA3" — voir mapVmEntity ci-dessous, qui résout le vrai nom via
   * getNutanixHosts() plutôt que ce champ brut. */
  host_reference?: NutanixReference;
  disk_list?: NutanixDiskEntry[];
  nic_list?: NutanixNicEntry[];
}

interface NutanixReference {
  uuid?: string;
  name?: string;
}

/** Un message d'erreur réel porté par `status.message_list` (Prism Central v3, uniquement peuplé
 * quand `status.state === "ERROR"`) — vérifié en conditions réelles le 17/08/2026 sur l'instance
 * 172.20.0.10:9440 : `status.state` existe bel et bien sur toutes les 24 VMs réelles observées
 * (`"COMPLETE"` pour chacune, aucune en erreur à cet instant) — un signal DISTINCT et fiable du
 * simple `power_state`, jamais confondu avec "éteinte" (voir mapVmEntity ci-dessous). La forme
 * exacte de `message_list` en cas d'ERROR réel n'a PAS pu être vérifiée sur cette instance (aucune
 * VM en erreur à disposition) — typée ici selon la sémantique v3 documentée par Nutanix, jamais
 * supposée à l'aveugle : si la forme réelle diverge le jour où une VM entre effectivement en
 * erreur, `message` resterait simplement absent plutôt que de faire planter le mapping (tous les
 * champs sont optionnels ici).
 */
interface NutanixMessageListEntry {
  message?: string;
  reason?: string;
}

interface NutanixVmEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string; resources?: NutanixEntityResources; cluster_reference?: NutanixReference };
  status?: {
    name?: string;
    resources?: NutanixEntityResources;
    cluster_reference?: NutanixReference;
    /** État RÉEL de l'entité côté Prism Central ("COMPLETE"/"PENDING"/"ERROR", vérifié en
     * conditions réelles — voir NutanixMessageListEntry ci-dessus) — DISTINCT de
     * `resources.power_state` : une VM peut être "COMPLETE" et éteinte (arrêt volontaire, pas une
     * erreur) ou, en théorie, "ERROR" (échec réel constaté par Prism Central sur cette entité,
     * quel que soit son power_state). Consommé par mapVmEntity ci-dessous pour distinguer "éteinte"
     * (gris) d'une VRAIE erreur (rouge) côté topologyGraphShared.tsx (web) — jamais les confondre. */
    state?: string;
    message_list?: NutanixMessageListEntry[];
  };
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

  // Placement de la VM sur son hôte physique — préfère TOUJOURS le placement RÉEL et VIVANT
  // (status.resources.host_reference). Retour utilisateur du 17/08/2026, capture d'écran à
  // l'appui : "ya des edge en trop... normalement je doi en avoir que troie [arêtes] la entre ahv
  // et nut 1 nut 2 nut 3 car les vm sont atacher e ceux ci" — vérifié en conditions réelles le
  // même jour : une VM ÉTEINTE ne renvoie simplement PAS status.resources.host_reference (Prism
  // Central ne rapporte un placement "live" que pour une VM allumée), ce qui faisait retomber
  // TopologyGraph sur un rattachement direct cluster -> VM (voir l'ancien commentaire de
  // services/topology.ts#getNutanixTopologyParts) — plusieurs arêtes en plus des 3 attendues
  // cluster -> hôte, polluant visuellement le nœud cluster. Repli sur spec.resources.host_reference
  // (l'hôte DÉCLARÉ/persisté, distinct du placement live) AVANT de renoncer complètement : le
  // modèle de données Prism Central v3 sépare `status` (état constaté) de `spec` (config
  // déclarée) — `spec.resources.host_reference` porte le dernier hôte assigné à la VM et reste
  // présent dans la réponse même VM éteinte pour une VM déjà démarrée au moins une fois. `hostUuid`
  // reste `undefined` si NI l'un NI l'autre n'est renseigné (VM jamais démarrée) : voir
  // services/topology.ts#getNutanixTopologyParts, qui ne fabrique alors plus AUCUNE arête "hosts"
  // pour cette VM plutôt que d'inventer un rattachement direct au cluster. `host_reference.name`
  // porte en réalité l'IP de l'hyperviseur (vérifié en conditions réelles) : on préfère le VRAI nom
  // résolu via getNutanixHosts(), avec repli sur cette IP UNIQUEMENT si l'hôte n'a pas pu être
  // retrouvé dans la liste résolue à cet instant précis (course entre deux requêtes) — jamais un
  // nom inventé.
  const liveHostRef = entity.status?.resources?.host_reference;
  const hostRef = liveHostRef ?? entity.spec?.resources?.host_reference;
  const hostUuid = hostRef?.uuid;
  const resolvedHost = hostUuid ? hostsByUuid.get(hostUuid) : undefined;
  const hostName = resolvedHost?.name ?? hostRef?.name;
  // true si `hostUuid` ci-dessus vient bien du placement CONSTATÉ en direct (`liveHostRef`, non
  // undefined) ; false s'il vient du repli `spec.resources.host_reference` (dernier hôte
  // assigné/déclaré, pas confirmé en direct à cet instant — typiquement une VM éteinte, voir JSDoc
  // ci-dessus). `undefined` dans les mêmes conditions que `hostUuid` (VM jamais démarrée, ni
  // status ni spec renseignés) : jamais un booléen fabriqué sans hôte déterminable derrière.
  // Consommé par services/topology.ts#nutanixVmToNode puis topologyGraphShared.tsx (web) pour
  // distinguer visuellement (vert "confirmé" vs orange "incertain") une arête "hosts" hôte
  // physique -> VM — retour utilisateur du 17/08/2026 : "j'ai impression que le systeme n'est pas
  // coherent entre nutanyx et le systeme de container c'est comme si la logique etait seprarer en
  // deux", même grille couleur/pointillé qu'un conteneur, jamais un second système parallèle.
  const hostPlacementConfirmed = hostUuid ? liveHostRef?.uuid !== undefined : undefined;

  // Signal d'erreur RÉEL distinct de power_state (voir NutanixVmEntity#status#state ci-dessus,
  // vérifié en conditions réelles le 17/08/2026 : le champ existe, vaut "COMPLETE" sur les 24 VMs
  // réelles observées, aucune en erreur à cet instant — jamais exercé mais un champ authentique de
  // cette instance, pas une supposition). Une VM ÉTEINTE n'est PAS en erreur (state reste
  // "COMPLETE") : `apiError` ne devient true QUE sur un VRAI "ERROR" explicitement rapporté par
  // Prism Central, jamais déduit du power_state — cohérent avec la règle déjà en place côté
  // conteneurs ("stopped" != "unhealthy", un arrêt volontaire n'est pas une panne).
  const apiError = entity.status?.state === "ERROR";
  const apiErrorMessage = apiError ? entity.status?.message_list?.[0]?.message : undefined;

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
    ...(typeof hostPlacementConfirmed === "boolean" ? { hostPlacementConfirmed } : {}),
    ...(disks.length > 0 ? { disks } : {}),
    ...(networks.length > 0 ? { networks } : {}),
    ...(apiError ? { apiError: true, ...(apiErrorMessage ? { apiErrorMessage } : {}) } : {}),
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
 * Dernier essai RÉEL de rafraîchissement de l'intégration Nutanix (getNutanixVms ci-dessous,
 * appelée à CHAQUE getTopology(), voir services/topology.ts#getNutanixTopologyParts) — en mémoire
 * process UNIQUEMENT, perdu au redémarrage (même principe que reverseProxy.ts#lastKnownDnsSync
 * pour AD DNS). N'est mis à jour QUE si Nutanix a été explicitement configuré (jamais pour "jamais
 * configuré", qui n'est pas une notion de joignabilité) — voir getNutanixVms.
 *
 * Sert UNIQUEMENT à distinguer, côté UI (panneau Légende du graphe, topologyGraphShared.tsx), "ce
 * poll n'a trouvé aucune VM" de "Nutanix est peut-être injoignable en ce moment" : sans caching
 * d'aucune sorte (voir JSDoc de getNutanixVms ci-dessous, "jamais mis en cache entre deux polls"),
 * un poll en échec fait simplement DISPARAÎTRE tous les nœuds nutanix-vm/nutanix-cluster/nutanix-
 * host de la réponse ce cycle-là plutôt que d'afficher une dernière valeur connue obsolète —
 * cohérent avec la philosophie "jamais de fausse donnée" de ce fichier, mais qui rend ce
 * signal indispensable pour que l'utilisateur sache si l'absence est un fait réel ou un accroc
 * réseau passager.
 */
export interface NutanixPollOutcome {
  reachable: boolean;
  at: string; // ISO 8601
}
let lastPollOutcome: NutanixPollOutcome | null = null;
export function lastKnownNutanixPoll(): NutanixPollOutcome | null {
  return lastPollOutcome;
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
    lastPollOutcome = { reachable: true, at: new Date().toISOString() };
    return (vmsData.entities ?? []).map((e) => mapVmEntity(e, hostsByUuid, subnetsByUuid));
  } catch {
    lastPollOutcome = { reachable: false, at: new Date().toISOString() };
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

// ============================================================================================
// Actions de cycle de vie (démarrer/arrêter/redémarrer/supprimer) + migration hôte-à-hôte d'une
// VM Nutanix — mission demandée par retour utilisateur : "il manque suprimer redemarer creer
// toute interface et la logique" (cycle de vie) + "si jai node A B C je doit pouvoire deplace de
// a a b" (migration, restreinte au SEUL cluster existant chez cet utilisateur : migration
// hôte-à-hôte DANS un même cluster physique, jamais inter-cluster tant qu'un second cluster
// n'existe pas réellement — voir migrateNutanixVm ci-dessous).
//
// TOUTES ces fonctions MUTENT une VRAIE VM de production (voir en-tête de fichier : aucun jeu de
// données de démonstration Nutanix). Chacune :
//  - lève une erreur explicite si Nutanix n'a jamais été configuré (même garde que getNutanixVms
//    ci-dessus) — jamais un no-op silencieux sur une action destructive/mutante.
//  - relit l'entité RÉELLE et COMPLÈTE de la VM (GET /vms/{uuid}) juste avant toute mutation —
//    jamais une supposition sur son état courant : le placement/l'alimentation exposés par
//    getNutanixVms() (liste, potentiellement pollée plusieurs secondes plus tôt côté frontend)
//    pourraient avoir changé entre-temps (autre opérateur, tâche déjà en cours...).
//  - PUT l'entité REÇUE, modifiée UNIQUEMENT sur les champs concernés — jamais reconstruite à la
//    main champ par champ : Prism Central v3 attend l'objet complet en retour (voir nutanixRequest
//    ci-dessus), un champ oublié par une reconstruction manuelle pourrait corrompre silencieusement
//    la config réelle de la VM (ex: perdre un disque/NIC en repartant d'un objet vide).
//
// Vérifié EN CONDITIONS RÉELLES le 14/08/2026 sur l'instance 172.20.0.10:9440 (VM réelle
// "HDVAPPLI") : UNIQUEMENT via des appels GET en lecture seule (`GET /api/nutanix/v3/vms/{uuid}`),
// jamais de mutation testée (interdiction absolue de cette mission — voir CLAUDE.md du dépôt).
// Cette vérification confirme la FORME exacte de l'entité (api_version "3.1", metadata.uuid/
// spec_version, spec.resources.power_state/power_state_mechanism.mechanism/host_reference absent
// par défaut, status.resources.power_state/host_reference réels) mais PAS le comportement d'un
// PUT en pratique (accepté/refusé, task créée...) : documenté honnêtement, jamais supposé.
// ============================================================================================

/** Erreur explicite dédiée aux actions de cycle de vie/migration — porte un `httpStatus` suggéré
 * pour que routes/nutanix.ts traduise honnêtement chaque cas (VM introuvable, garde-fou métier
 * violé, Prism Central injoignable/en erreur...) plutôt qu'un 502 générique fourre-tout comme
 * pour les listings en lecture seule ci-dessus (où un échec retombe simplement sur [] silencieux,
 * un choix qui n'a plus de sens pour une action qui doit soit réussir soit échouer clairement). */
export class NutanixActionError extends Error {
  httpStatus: number;
  /** Vrai si Prism a répondu 405 REQUEST_NOT_SUPPORTED ("PE VM Put request not supported", forme
   * réelle observée le 18/08/2026) : la VM est gérée côté Prism Element, où v3 est en lecture
   * seule — les actions basculent alors sur l'API v2.0 (voir nutanixV2Mutation). */
  peV3Unsupported = false;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "NutanixActionError";
    this.httpStatus = httpStatus;
  }
}

/**
 * Entité VM complète (spec+status+metadata), vue individuelle via GET /vms/{uuid} — PAS le même
 * niveau de détail typé que NutanixVmEntity (list, en tête de fichier) qui n'expose qu'un
 * SOUS-ENSEMBLE des champs utilisés par mapVmEntity pour l'AFFICHAGE. Ici, `resources` reste
 * VOLONTAIREMENT un objet libre (jamais retapé champ par champ) : un PUT v3 doit renvoyer l'objet
 * COMPLET reçu au GET précédent (voir JSDoc de section ci-dessus) — le typer exhaustivement
 * risquerait de perdre silencieusement un champ que TypeScript laisserait de côté lors d'une
 * recopie partielle, corrompant potentiellement la config d'une VRAIE VM de production.
 */
interface NutanixVmFullEntity {
  api_version?: string;
  metadata: { uuid: string; [key: string]: unknown };
  spec: {
    name?: string;
    resources: {
      power_state?: string;
      power_state_mechanism?: { mechanism?: string; [key: string]: unknown };
      host_reference?: NutanixReference;
      [key: string]: unknown;
    };
    cluster_reference?: NutanixReference;
    [key: string]: unknown;
  };
  status?: {
    name?: string;
    resources?: { power_state?: string; host_reference?: NutanixReference; [key: string]: unknown };
    cluster_reference?: NutanixReference;
    execution_context?: { task_uuid?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
}

/** Relit l'entité RÉELLE et COMPLÈTE d'une VM (GET /vms/{uuid}) — lève NutanixActionError(404) si
 * introuvable, (400) si Nutanix n'a jamais été configuré, (502) si Prism Central répond une autre
 * erreur. Utilisée par TOUTES les actions ci-dessous juste avant leur PUT/DELETE (voir JSDoc de
 * section ci-dessus : jamais une supposition sur l'état courant de la VM). */
export async function loadNutanixVmFullEntity(uuid: string): Promise<{ effective: SetupNutanixConfig; entity: NutanixVmFullEntity }> {
  const effective = await loadNutanixConfig();
  if (!effective) {
    throw new NutanixActionError("Nutanix is not configured — configure Prism Central before running any VM action", 400);
  }
  const result = await nutanixRequest<NutanixVmFullEntity>(
    effective.prismCentralUrl,
    "GET",
    `/api/nutanix/v3/vms/${uuid}`,
    effective.username,
    effective.password,
  );
  if (result.status === 404) {
    throw new NutanixActionError(`VM "${uuid}" not found on Prism Central`, 404);
  }
  if (result.status < 200 || result.status >= 300 || !result.data) {
    throw new NutanixActionError(`Prism Central returned an error reading VM "${uuid}" (status ${result.status}): ${result.raw.slice(0, 300)}`, 502);
  }
  return { effective, entity: result.data };
}

/** PUT l'entité COMPLÈTE (metadata inchangée — nécessaire pour la concurrence optimiste v3 côté
 * Prism Central — et `newSpec`, une COPIE de `entity.spec` modifiée UNIQUEMENT sur les champs
 * voulus par l'appelant, jamais reconstruite à la main, voir JSDoc de section). `raison` sert
 * uniquement au message d'erreur en cas d'échec, pour un diagnostic clair sans avoir à deviner
 * quelle action a échoué depuis une pile d'appels génériques. */
async function putNutanixVmEntity(
  effective: SetupNutanixConfig,
  uuid: string,
  entity: NutanixVmFullEntity,
  newSpec: NutanixVmFullEntity["spec"],
  raison: string,
): Promise<NutanixVmFullEntity> {
  const body = { api_version: entity.api_version ?? "3.1", metadata: entity.metadata, spec: newSpec };
  const result = await nutanixRequest<NutanixVmFullEntity>(
    effective.prismCentralUrl,
    "PUT",
    `/api/nutanix/v3/vms/${uuid}`,
    effective.username,
    effective.password,
    body,
  );
  if (result.status < 200 || result.status >= 300 || !result.data) {
    const err = new NutanixActionError(`Prism Central refused ${raison} for VM "${uuid}" (status ${result.status}): ${result.raw.slice(0, 300)}`, 502);
    if (result.status === 405 && result.raw.includes("REQUEST_NOT_SUPPORTED")) err.peV3Unsupported = true;
    throw err;
  }
  return result.data;
}

const NUTANIX_V2_BASE = "/PrismGateway/services/rest/v2.0";

/** Vrai si l'échec v3 vient d'une VM gérée côté Prism Element — l'appelant doit rejouer l'action
 * via l'API v2.0 plutôt que de remonter l'erreur telle quelle. */
function needsPeV2Fallback(err: unknown): err is NutanixActionError {
  return err instanceof NutanixActionError && err.peV3Unsupported;
}

/** Mutation via l'API v2.0 de Prism (celle que Prism Element supporte pleinement) — repli utilisé
 * UNIQUEMENT après un 405 REQUEST_NOT_SUPPORTED du PUT v3 (needsPeV2Fallback), jamais en premier
 * choix. Un refus v2.0 remonte tel quel (502 + message réel), jamais masqué. */
async function nutanixV2Mutation<T>(
  effective: SetupNutanixConfig,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  raison: string,
  vmName: string,
  body?: unknown,
): Promise<T | null> {
  const result = await nutanixRequest<T>(effective.prismCentralUrl, method, `${NUTANIX_V2_BASE}${path}`, effective.username, effective.password, body);
  if (result.status < 200 || result.status >= 300) {
    throw new NutanixActionError(`Prism (API v2.0) refused ${raison} for VM "${vmName}" (status ${result.status}): ${result.raw.slice(0, 300)}`, 502);
  }
  return result.data;
}

/** Interroge à intervalles réguliers l'état d'alimentation RÉEL (status.resources.power_state,
 * jamais spec — un placement/état est un fait constaté, voir en-tête de fichier) jusqu'à ce qu'il
 * corresponde à `want`, ou lève une erreur explicite au bout de `timeoutMs` — utilisée UNIQUEMENT
 * par restartNutanixVm ci-dessous entre l'extinction et le rallumage (voir JSDoc), jamais pour
 * démarrer/arrêter seuls (fire-and-forget, cohérent avec docker.ts#startContainer/stopContainer :
 * le graphe reflète l'état réel au prochain poll, pas besoin d'attendre la convergence ici). */
async function waitForNutanixVmPowerState(
  effective: SetupNutanixConfig,
  uuid: string,
  want: "ON" | "OFF",
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await nutanixRequest<NutanixVmFullEntity>(
      effective.prismCentralUrl,
      "GET",
      `/api/nutanix/v3/vms/${uuid}`,
      effective.username,
      effective.password,
    );
    if (result.status >= 200 && result.status < 300 && result.data?.status?.resources?.power_state === want) return;
    if (Date.now() >= deadline) {
      throw new NutanixActionError(
        `VM "${uuid}" did not reach power state ${want} within ${Math.round(timeoutMs / 1000)}s — refusing to proceed`,
        504,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const RESTART_POWEROFF_TIMEOUT_MS = 60_000;
const RESTART_POWEROFF_POLL_INTERVAL_MS = 2_000;

/**
 * Démarre une VM éteinte — PUT spec.resources.power_state="ON". Refuse (409) si la VM est déjà
 * allumée (état RÉEL, status.resources.power_state — jamais l'intention spec) : un no-op explicite
 * plutôt qu'un succès trompeur qui laisserait croire qu'une action a eu lieu.
 */
export async function startNutanixVm(uuid: string): Promise<{ ok: true; vmName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const current = entity.status?.resources?.power_state;
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  if (current === "ON") {
    throw new NutanixActionError(`VM "${vmName}" is already powered on`, 409);
  }
  const newSpec = { ...entity.spec, resources: { ...entity.spec.resources, power_state: "ON" } };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "power on");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/set_power_state`, "power on", vmName, { transition: "ON" });
  }
  return { ok: true, vmName };
}

/**
 * Arrête une VM allumée — GRACIEUSEMENT par défaut (mission : "pas un power-off brutal par
 * défaut") via `power_state_mechanism.mechanism = "ACPI"` (signal d'extinction envoyé à l'OS
 * invité, qui gère lui-même son arrêt propre — champ réel confirmé présent sur cette instance,
 * voir en-tête de section) plutôt que "HARD" (coupure immédiate, jamais utilisée ici). Refuse
 * (409) si la VM est déjà éteinte.
 */
export async function stopNutanixVm(uuid: string): Promise<{ ok: true; vmName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const current = entity.status?.resources?.power_state;
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  if (current === "OFF") {
    throw new NutanixActionError(`VM "${vmName}" is already powered off`, 409);
  }
  const newSpec = {
    ...entity.spec,
    resources: {
      ...entity.spec.resources,
      power_state: "OFF",
      power_state_mechanism: { ...(entity.spec.resources.power_state_mechanism ?? {}), mechanism: "ACPI" },
    },
  };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "graceful power off");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    // ACPI_SHUTDOWN = même sémantique gracieuse que mechanism "ACPI" en v3, jamais un OFF brutal.
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/set_power_state`, "graceful power off", vmName, { transition: "ACPI_SHUTDOWN" });
  }
  return { ok: true, vmName };
}

/**
 * Redémarre une VM allumée — GRACIEUSEMENT (extinction ACPI, attente de convergence RÉELLE, puis
 * rallumage). Documentation honnête (voir mission, point (a) "vérifie le format exact... documente
 * ce que tu trouves réellement plutôt que de supposer") : l'API Prism Central v3 n'expose AUCUNE
 * valeur `power_state` de type "REBOOT"/"RESETTING" observée ou documentée de façon fiable pour un
 * PUT côté client (contrairement à v1/v2 qui avait une action dédiée) — le mécanisme réel utilisé
 * par les outils tiers connus (ex: provider Terraform Nutanix) est PRÉCISÉMENT cette séquence
 * "éteindre proprement, ATTENDRE l'état OFF réel, rallumer", jamais un flip direct spéculatif d'un
 * champ non vérifié sur cette instance. Refuse (409) si la VM n'est pas actuellement allumée (on
 * ne "redémarre" pas une VM déjà éteinte — utiliser Démarrer).
 */
export async function restartNutanixVm(uuid: string): Promise<{ ok: true; vmName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const current = entity.status?.resources?.power_state;
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  if (current !== "ON") {
    throw new NutanixActionError(`VM "${vmName}" is not currently powered on — cannot restart, use Start instead`, 409);
  }

  const offSpec = {
    ...entity.spec,
    resources: {
      ...entity.spec.resources,
      power_state: "OFF",
      power_state_mechanism: { ...(entity.spec.resources.power_state_mechanism ?? {}), mechanism: "ACPI" },
    },
  };
  try {
    await putNutanixVmEntity(effective, uuid, entity, offSpec, "graceful power off (restart step 1/2)");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    // v2.0 a une action de redémarrage gracieux DÉDIÉE — un seul appel, pas de séquence off/wait/on.
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/set_power_state`, "graceful reboot", vmName, { transition: "ACPI_REBOOT" });
    return { ok: true, vmName };
  }

  // Attend la CONVERGENCE réelle (status.resources.power_state === "OFF") avant de rallumer —
  // jamais un second PUT immédiat qui pourrait arriver avant que Prism Central n'ait fini de
  // traiter le premier (spec_version potentiellement pas encore avancé), voir JSDoc ci-dessus.
  await waitForNutanixVmPowerState(effective, uuid, "OFF", RESTART_POWEROFF_TIMEOUT_MS, RESTART_POWEROFF_POLL_INTERVAL_MS);

  // Relit l'entité (spec_version a changé après le premier PUT) avant le second PUT — jamais
  // réutiliser `entity`/`offSpec` d'avant la première mutation pour la concurrence optimiste v3.
  const { entity: entityAfterOff } = await loadNutanixVmFullEntity(uuid);
  const onSpec = { ...entityAfterOff.spec, resources: { ...entityAfterOff.spec.resources, power_state: "ON" } };
  await putNutanixVmEntity(effective, uuid, entityAfterOff, onSpec, "power on (restart step 2/2)");

  return { ok: true, vmName };
}

/**
 * Supprime définitivement une VM — garde-fou QUAI (pas une limite Prism Central documentée avec
 * certitude ; choix délibéré et prudent de ce projet vu la sensibilité de l'action, voir mission
 * "PRUDENCE ABSOLUE") : refuse (409) si la VM est actuellement ALLUMÉE, pour ne jamais permettre
 * la suppression en un seul clic d'une VM de production en cours d'exécution — l'opérateur doit
 * l'arrêter explicitement d'abord (action distincte, elle-même confirmée séparément côté
 * frontend). La confirmation "taper le nom de la VM" est portée par le FRONTEND (voir
 * TopologyNodeDetailPanel.tsx) — cette fonction reste l'action réelle, appelée seulement après
 * cette confirmation lourde.
 */
export async function deleteNutanixVm(uuid: string): Promise<{ ok: true; vmName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const current = entity.status?.resources?.power_state;
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  if (current === "ON") {
    throw new NutanixActionError(
      `VM "${vmName}" is currently powered on — stop it before deleting (QUAI safety guard, avoids removing a running VM in one click)`,
      409,
    );
  }
  const result = await nutanixRequest<unknown>(effective.prismCentralUrl, "DELETE", `/api/nutanix/v3/vms/${uuid}`, effective.username, effective.password);
  if (result.status === 405 && result.raw.includes("REQUEST_NOT_SUPPORTED")) {
    await nutanixV2Mutation(effective, "DELETE", `/vms/${uuid}`, "deletion", vmName);
    return { ok: true, vmName };
  }
  if (result.status < 200 || result.status >= 300) {
    throw new NutanixActionError(`Prism Central refused deletion of VM "${vmName}" (status ${result.status}): ${result.raw.slice(0, 300)}`, 502);
  }
  return { ok: true, vmName };
}

/**
 * Migre une VM d'un hôte physique à un autre, DANS LE MÊME CLUSTER — mécanisme RÉEL vérifié le
 * 14/08/2026 (voir en-tête de section) : Prism Central v3 n'a pas d'action dédiée
 * `/vms/{uuid}/migrate` (contrairement à v1/v2) — la migration live AHV est déclenchée en PUTtant
 * `spec.resources.host_reference` vers l'hôte ciblé sur une VM ACTUELLEMENT ALLUMÉE (le scheduler
 * AHV effectue alors une live migration ; sur une VM éteinte, ce même champ ne fait que fixer son
 * prochain hôte de démarrage, pas une VRAIE migration — ce cas est refusé explicitement ci-dessous
 * plutôt que de laisser croire qu'une migration live a eu lieu).
 *
 * Périmètre RÉEL actuel de cet utilisateur (voir mission) : un SEUL cluster existe
 * (CLUSTER_AHV_HDV, 3 hôtes HDVNUTA1/2/3) — deux garde-fous stricts, jamais de tentative
 * silencieuse hors de ce périmètre :
 *  - hôte cible === hôte actuel : refuse (409), rien à faire.
 *  - hôte cible n'appartenant pas au MÊME cluster que la VM : refuse (409) avec un message clair —
 *    prépare honnêtement le terrain pour un jour où plusieurs clusters existeraient réellement,
 *    sans jamais migrer silencieusement entre deux clusters aujourd'hui (n'existe pas encore chez
 *    cet utilisateur, donc jamais exercé en pratique, mais le code ne doit jamais SUPPOSER qu'un
 *    seul cluster existera pour toujours).
 */
export async function migrateNutanixVm(uuid: string, targetHostUuid: string): Promise<{ ok: true; vmName: string; targetHostName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  const currentHostUuid = entity.status?.resources?.host_reference?.uuid;
  const vmClusterUuid = entity.status?.cluster_reference?.uuid ?? entity.spec.cluster_reference?.uuid;

  if (entity.status?.resources?.power_state !== "ON") {
    throw new NutanixActionError(`VM "${vmName}" is not currently powered on — live migration requires a running VM`, 409);
  }
  if (currentHostUuid && currentHostUuid === targetHostUuid) {
    throw new NutanixActionError(`VM "${vmName}" is already running on this host — nothing to do`, 409);
  }

  const hosts = await getNutanixHosts();
  const targetHost = hosts.find((h) => h.id === targetHostUuid);
  if (!targetHost) {
    throw new NutanixActionError(`Target host "${targetHostUuid}" not found on Prism Central`, 404);
  }
  if (vmClusterUuid && targetHost.clusterUuid && targetHost.clusterUuid !== vmClusterUuid) {
    throw new NutanixActionError(
      `Refusing to migrate VM "${vmName}" to host "${targetHost.name}": it belongs to a different cluster (cross-cluster migration is not supported)`,
      409,
    );
  }

  const newSpec = {
    ...entity.spec,
    resources: { ...entity.spec.resources, host_reference: { kind: "host", uuid: targetHostUuid } },
  };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "live migration");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/migrate`, "live migration", vmName, { host_uuid: targetHostUuid });
  }
  return { ok: true, vmName, targetHostName: targetHost.name };
}

// ============================================================================================
// Configuration matérielle d'une VM (ajout de disque, ajout de carte réseau, vCPU/mémoire) —
// mission du 18/08/2026 : mêmes entrées que le menu "Update VM" de Prism (captures de référence),
// via le MÊME mécanisme PUT spec déclaratif que start/stop/migrate ci-dessus (jamais un second
// système). Formes RÉELLES vérifiées EN LECTURE SEULE le 18/08/2026 sur l'instance 172.20.0.10:9440
// (GET /vms/{uuid} sur 2 VMs réelles, POST /subnets/list — AUCUNE mutation testée contre
// l'instance réelle, interdiction absolue de cette mission ; les mutations ne sont exercées que
// contre des réponses mockées reproduisant ces formes, voir test/nutanixVmConfig.test.ts) :
//  - une entrée disk_list DISQUE réelle porte device_properties.{device_type:"DISK",
//    disk_address:{adapter_type:"SCSI", device_index}}, disk_size_mib (+ disk_size_bytes dérivé
//    par Prism, jamais envoyé par nous) et storage_config.storage_container_reference
//    {kind:"storage_container", uuid} — présent sur TOUS les disques réels observés : l'ajout
//    recopie celui d'un disque existant de la VM (même container de stockage), et l'omet si la VM
//    n'a aucun disque (Prism applique alors le container par défaut du cluster).
//  - une entrée nic_list réelle porte nic_type:"NORMAL_NIC", vlan_mode:"ACCESS",
//    subnet_reference{kind:"subnet", uuid}, is_connected:true (mac_address/uuid assignés par Prism).
//  - le compute vit dans num_sockets ("vCPU(s)" de Prism), num_vcpus_per_socket ("cœurs par vCPU")
//    et memory_size_mib. `boot_config` est un champ DISTINCT, jamais touché ici — le message Prism
//    "Boot Configuration cannot be updated while the VM is running" (capture) concerne ce champ-là.
// Contrainte à-chaud (NON vérifiée par mutation sur cette instance — comportement AHV documenté par
// Nutanix, jamais supposé vérifié ici) : l'AJOUT à chaud de vCPU (num_sockets) et de mémoire est
// supporté sur une VM allumée ; la DIMINUTION de l'un ou l'autre et le changement de
// num_vcpus_per_socket exigent en général la VM éteinte. AUCUN garde-fou local ne masque ce cas :
// le PUT est tenté tel quel et un refus Prism remonte TEL QUEL (502 + message réel) à l'UI.
// ============================================================================================

/** Bornes QUAI (garde-fous délibérés, pas des limites Prism documentées) — évite qu'une faute de
 * frappe alloue 300 Tio sur la prod de la mairie. */
export const NUTANIX_DISK_MIN_SIZE_MIB = 1024; // 1 Gio
export const NUTANIX_DISK_MAX_SIZE_MIB = 2 * 1024 * 1024; // 2 Tio
export const NUTANIX_MAX_VCPUS = 64;
export const NUTANIX_MAX_CORES_PER_VCPU = 16;
export const NUTANIX_MIN_MEMORY_MIB = 256;
export const NUTANIX_MAX_MEMORY_MIB = 1024 * 1024; // 1 Tio

/** Forme (partielle) d'une entrée disk_list côté spec — uniquement les champs lus pour calculer le
 * prochain device_index SCSI et recopier le storage container, le reste passe tel quel. */
interface NutanixDiskSpecEntry {
  device_properties?: { device_type?: string; disk_address?: { adapter_type?: string; device_index?: number } };
  storage_config?: unknown;
  [key: string]: unknown;
}

/**
 * Ajoute un disque SCSI à une VM — reproduit EXACTEMENT la forme d'entrée observée en conditions
 * réelles (voir en-tête de section) : device_type DISK, adapter SCSI au prochain device_index
 * libre, disk_size_mib, storage_config recopié d'un disque existant de la MÊME VM (jamais un
 * container inventé). Fonctionne VM allumée ou éteinte (le hot-add de disque SCSI est supporté par
 * AHV) — un refus Prism éventuel remonte tel quel.
 */
export async function addNutanixVmDisk(uuid: string, opts: { sizeMib: number }): Promise<{ ok: true; vmName: string; sizeMib: number }> {
  const { sizeMib } = opts;
  if (!Number.isInteger(sizeMib) || sizeMib < NUTANIX_DISK_MIN_SIZE_MIB || sizeMib > NUTANIX_DISK_MAX_SIZE_MIB) {
    throw new NutanixActionError(
      `Invalid disk size ${sizeMib} MiB — must be an integer between ${NUTANIX_DISK_MIN_SIZE_MIB} and ${NUTANIX_DISK_MAX_SIZE_MIB} MiB (QUAI safety bounds)`,
      400,
    );
  }
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  const diskList: NutanixDiskSpecEntry[] = Array.isArray(entity.spec.resources.disk_list)
    ? (entity.spec.resources.disk_list as NutanixDiskSpecEntry[])
    : [];
  const scsiIndexes = diskList
    .filter((d) => d.device_properties?.disk_address?.adapter_type === "SCSI")
    .map((d) => d.device_properties?.disk_address?.device_index)
    .filter((i): i is number => typeof i === "number");
  const nextIndex = scsiIndexes.length > 0 ? Math.max(...scsiIndexes) + 1 : 0;
  const templateStorage = diskList.find((d) => d.device_properties?.device_type === "DISK" && d.storage_config)?.storage_config;
  const newDisk: NutanixDiskSpecEntry = {
    device_properties: { device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: nextIndex } },
    disk_size_mib: sizeMib,
    ...(templateStorage !== undefined ? { storage_config: templateStorage } : {}),
  };
  const newSpec = { ...entity.spec, resources: { ...entity.spec.resources, disk_list: [...diskList, newDisk] } };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "disk add");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    // v2.0 exige le container de stockage explicitement — recopié d'un disque existant, jamais inventé.
    const containerUuid = (templateStorage as { storage_container_reference?: { uuid?: string } } | undefined)
      ?.storage_container_reference?.uuid;
    if (!containerUuid) {
      throw new NutanixActionError(
        `Cannot add a disk to VM "${vmName}" through the Prism v2.0 API: no storage container could be determined from its existing disks`,
        502,
      );
    }
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/disks/attach`, "disk add", vmName, {
      vm_disks: [
        {
          disk_address: { device_bus: "scsi" },
          vm_disk_create: { size: sizeMib * 1024 * 1024, storage_container_uuid: containerUuid },
        },
      ],
    });
  }
  return { ok: true, vmName, sizeMib };
}

/**
 * Ajoute une carte réseau (NIC) reliée à un subnet RÉEL — le subnet est vérifié via /subnets/list
 * (même résolution que le poll de topologie, jamais un uuid accepté à l'aveugle). Forme d'entrée
 * minimale reproduisant l'observé (voir en-tête de section) : Prism assigne lui-même uuid/mac.
 */
export async function addNutanixVmNic(uuid: string, opts: { subnetUuid: string }): Promise<{ ok: true; vmName: string; subnetName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  const subnets = await fetchNutanixSubnets(effective);
  const subnet = subnets.get(opts.subnetUuid);
  if (!subnet) {
    throw new NutanixActionError(`Subnet "${opts.subnetUuid}" not found on Prism Central (or subnets list temporarily unavailable)`, 404);
  }
  const nicList: unknown[] = Array.isArray(entity.spec.resources.nic_list) ? (entity.spec.resources.nic_list as unknown[]) : [];
  const newNic = {
    nic_type: "NORMAL_NIC",
    vlan_mode: "ACCESS",
    subnet_reference: { kind: "subnet", uuid: opts.subnetUuid },
    is_connected: true,
  };
  const newSpec = { ...entity.spec, resources: { ...entity.spec.resources, nic_list: [...nicList, newNic] } };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "NIC add");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    await nutanixV2Mutation(effective, "POST", `/vms/${uuid}/nics`, "NIC add", vmName, {
      spec_list: [{ network_uuid: opts.subnetUuid, is_connected: true }],
    });
  }
  return { ok: true, vmName, subnetName: subnet.name };
}

/**
 * Met à jour vCPU (num_sockets), cœurs par vCPU (num_vcpus_per_socket) et/ou mémoire
 * (memory_size_mib) — champs fournis uniquement, le reste du spec passe intact (jamais reconstruit).
 * AUCUN refus local selon le power_state : la contrainte à-chaud réelle (voir en-tête de section)
 * est arbitrée par Prism Central lui-même et son erreur remonte TELLE QUELLE — jamais masquée.
 */
export async function updateNutanixVmCompute(
  uuid: string,
  opts: { numVcpus?: number; numCoresPerVcpu?: number; memoryMib?: number },
): Promise<{ ok: true; vmName: string }> {
  const { numVcpus, numCoresPerVcpu, memoryMib } = opts;
  if (numVcpus === undefined && numCoresPerVcpu === undefined && memoryMib === undefined) {
    throw new NutanixActionError("At least one of numVcpus, numCoresPerVcpu, memoryMib is required", 400);
  }
  if (numVcpus !== undefined && (!Number.isInteger(numVcpus) || numVcpus < 1 || numVcpus > NUTANIX_MAX_VCPUS)) {
    throw new NutanixActionError(`Invalid numVcpus ${numVcpus} — must be an integer between 1 and ${NUTANIX_MAX_VCPUS}`, 400);
  }
  if (numCoresPerVcpu !== undefined && (!Number.isInteger(numCoresPerVcpu) || numCoresPerVcpu < 1 || numCoresPerVcpu > NUTANIX_MAX_CORES_PER_VCPU)) {
    throw new NutanixActionError(`Invalid numCoresPerVcpu ${numCoresPerVcpu} — must be an integer between 1 and ${NUTANIX_MAX_CORES_PER_VCPU}`, 400);
  }
  if (memoryMib !== undefined && (!Number.isInteger(memoryMib) || memoryMib < NUTANIX_MIN_MEMORY_MIB || memoryMib > NUTANIX_MAX_MEMORY_MIB)) {
    throw new NutanixActionError(
      `Invalid memoryMib ${memoryMib} — must be an integer between ${NUTANIX_MIN_MEMORY_MIB} and ${NUTANIX_MAX_MEMORY_MIB}`,
      400,
    );
  }
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  const newSpec = {
    ...entity.spec,
    resources: {
      ...entity.spec.resources,
      ...(numVcpus !== undefined ? { num_sockets: numVcpus } : {}),
      ...(numCoresPerVcpu !== undefined ? { num_vcpus_per_socket: numCoresPerVcpu } : {}),
      ...(memoryMib !== undefined ? { memory_size_mib: memoryMib } : {}),
    },
  };
  try {
    await putNutanixVmEntity(effective, uuid, entity, newSpec, "compute update");
  } catch (err) {
    if (!needsPeV2Fallback(err)) throw err;
    // Mapping v3 -> v2 : num_sockets -> num_vcpus, num_vcpus_per_socket -> num_cores_per_vcpu, memory_size_mib -> memory_mb.
    await nutanixV2Mutation(effective, "PUT", `/vms/${uuid}`, "compute update", vmName, {
      ...(numVcpus !== undefined ? { num_vcpus: numVcpus } : {}),
      ...(numCoresPerVcpu !== undefined ? { num_cores_per_vcpu: numCoresPerVcpu } : {}),
      ...(memoryMib !== undefined ? { memory_mb: memoryMib } : {}),
    });
  }
  return { ok: true, vmName };
}

/** uuid + nom + VLAN d'un subnet réel — exposé au frontend (GET /api/nutanix/subnets) pour le
 * sélecteur "Ajouter une carte réseau" ; même source (/subnets/list) que la résolution VLAN du
 * poll de topologie, [] si Nutanix n'a jamais été configuré ou est injoignable. */
export interface NutanixSubnetSummary {
  uuid: string;
  name: string;
  vlanId?: number;
}

export async function getNutanixSubnets(): Promise<NutanixSubnetSummary[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];
  const map = await fetchNutanixSubnets(effective);
  return Array.from(map.entries()).map(([uuid, s]) => ({ uuid, name: s.name, ...(s.vlanId !== undefined ? { vlanId: s.vlanId } : {}) }));
}

// ============================================================================================
// Console VNC réelle d'une VM — mission "je pousse voir interieur des vm comme en bureaux
// distance aussi" : accès clavier/souris RÉEL à l'intérieur d'une VM AHV, PAS un RDP authentifié
// séparé — l'utilisateur tape ses identifiants directement dans l'écran affiché, exactement comme
// s'il était physiquement devant la VM (console matérielle virtuelle).
//
// Mécanisme RÉEL vérifié EN CONDITIONS RÉELLES le 14/08/2026 sur l'instance 172.20.0.10:9440 (VM
// réelle "HDVAPPLI", LECTURE SEULE — poignée de main WebSocket confirmée par un 101 Switching
// Protocols reçu, AUCUNE trame envoyée après connexion, socket fermé immédiatement, voir garde-fou
// de prudence absolue de cette mission) — NE JAMAIS SUPPOSER, inspecté empiriquement :
//  - Prism Central v3 n'expose AUCUNE ressource de console dans son API REST documentée : ni
//    `POST/GET /api/nutanix/v3/vms/{uuid}/console` (404), ni les variantes legacy Prism Element
//    v1/v2 (`/PrismGateway/services/rest/v1|v2.0/vms/{uuid}/console`, 404 également) — cette
//    instance n'a PAS le mécanisme "action dédiée" qu'on pourrait attendre par analogie avec
//    d'autres API Nutanix plus anciennes.
//  - Le SEUL mécanisme réel disponible est `/vnc/vm/{uuid}/proxy` — un endpoint WebSocket qui
//    répond 400 (Bad Request, PAS 404) à un GET simple sans en-têtes d'upgrade (confirmant que la
//    route existe et attend spécifiquement une poignée de main WebSocket), et accepte réellement
//    l'upgrade (101 Switching Protocols) avec authentification Basic (mêmes identifiants Prism
//    Central que le reste de ce fichier). L'en-tête de réponse `x-ntnx-env: pe` prouve que Prism
//    Central PROXIFIE cette requête de façon transparente vers le Prism Element du cluster
//    physique propriétaire de la VM — PC lui-même n'héberge pas le VNC, il relaie vers PE, qui
//    est bien l'ancienne interface "cluster physique" distincte mentionnée dans la mission. C'est
//    exactement le mécanisme qu'utilise l'onglet "Launch Console" de l'UI web Prism elle-même
//    (confirmé par les en-têtes `content-security-policy`/`x-frame-options` orientés navigateur
//    reçus dans la même réponse). Jamais exposé tel quel au frontend QUAI : voir routes/nutanix.ts,
//    qui proxifie lui-même ce WebSocket pour que le navigateur ne parle JAMAIS directement à Prism
//    Central/l'hyperviseur, cohérent avec le reste de cette intégration (mêmes identifiants que
//    /api/nutanix/vms/list etc., jamais transmis au client).
//
// Garde-fou métier délibéré (pas une limite Prism Central documentée, choix QUAI comme pour
// deleteNutanixVm ci-dessus) : refuse une VM éteinte AVANT même de tenter la connexion amont — une
// VM AHV éteinte n'a aucune sortie vidéo à proxifier (le proxy VNC de Prism Element se contente
// sinon d'ouvrir une connexion qui ne montre jamais rien, un état confus pour l'opérateur).
export async function getNutanixVmConsoleTarget(uuid: string): Promise<{ effective: SetupNutanixConfig; wsPath: string; vmName: string }> {
  const { effective, entity } = await loadNutanixVmFullEntity(uuid);
  const vmName = entity.status?.name ?? entity.spec.name ?? uuid;
  const powerState = entity.status?.resources?.power_state;
  if (powerState !== "ON") {
    throw new NutanixActionError(`VM "${vmName}" is powered off — no console video output is available (start the VM first)`, 409);
  }
  return { effective, wsPath: `/vnc/vm/${uuid}/proxy`, vmName };
}

// ============================================================================================
// Étage "déploiement" du pipeline de templates (18/08/2026) : images du catalogue, ingestion d'une
// image cloud depuis une URL, création de VM avec cloud-init, suivi de tâche. Formes vérifiées en
// LECTURE SEULE contre l'instance réelle 172.20.0.10:9440 le 18/08/2026 : POST /images/list (25
// images réelles, entités metadata/spec/status avec image_type "ISO_IMAGE" et size_bytes) et
// GET /tasks/{uuid} (réponse PLATE : uuid/status/percentage_complete, PAS d'enveloppe
// metadata/spec/status). Les MUTATIONS (POST /images, POST /vms) n'ont JAMAIS été exercées contre
// l'instance réelle (interdiction absolue) : formes construites depuis la doc v3 + les entités
// réelles observées, exercées uniquement contre le mock des tests (test/nutanixDeploy.test.ts).
// Repli PE v2.0 : DÉLIBÉRÉMENT ABSENT ici — la création d'image/VM existe en v2.0 sous une forme
// très différente (vm_disks/vm_customization_config) jamais vérifiée sur cette instance : un 405
// REQUEST_NOT_SUPPORTED remonte tel quel avec un message explicite plutôt qu'un repli inventé.
// ============================================================================================

/** Entité image v3 (champs utilisés seulement) — forme réelle vérifiée le 18/08/2026. */
interface NutanixImageEntity {
  metadata?: { uuid?: string };
  spec?: { name?: string; resources?: { image_type?: string } };
  status?: { name?: string; resources?: { image_type?: string; size_bytes?: number } };
}

interface NutanixImagesListResponse {
  entities?: NutanixImageEntity[];
}

/** Liste les images du catalogue — [] si jamais configuré ou injoignable, même garde que getNutanixHosts. */
export async function getNutanixImages(): Promise<NutanixImageSummary[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];
  try {
    const data = await nutanixPost<NutanixImagesListResponse>(
      effective.prismCentralUrl,
      "/api/nutanix/v3/images/list",
      effective.username,
      effective.password,
      { kind: "image", length: 500, offset: 0 },
    );
    return (data.entities ?? [])
      .filter((e): e is NutanixImageEntity & { metadata: { uuid: string } } => Boolean(e.metadata?.uuid))
      .map((e) => {
        const imageType = e.status?.resources?.image_type ?? e.spec?.resources?.image_type;
        const sizeBytes = e.status?.resources?.size_bytes;
        return {
          uuid: e.metadata.uuid,
          name: e.status?.name ?? e.spec?.name ?? e.metadata.uuid,
          ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
          ...(imageType ? { imageType } : {}),
        };
      });
  } catch {
    return [];
  }
}

/** Réponse d'une création v3 (image ou VM) — seuls uuid + task_uuid sont consommés. */
interface NutanixCreateResponse {
  metadata?: { uuid?: string };
  status?: { execution_context?: { task_uuid?: string } };
}

/** Message Prism sans JAMAIS inclure le corps brut (qui peut échoïser la spec envoyée, user_data
 * cloud-init compris — un secret) : seuls message_list[].message/reason sont extraits, puis chaque
 * chaîne de `secrets` est masquée par défense en profondeur. */
function sanitizedPrismErrorMessage(raw: string, secrets: string[]): string {
  let message = "no parseable error detail (response body withheld — it may echo the submitted spec)";
  try {
    const parsed = JSON.parse(raw) as { message_list?: { message?: string; reason?: string }[]; message?: string };
    const parts = (parsed.message_list ?? [])
      .map((m) => [m.reason, m.message].filter(Boolean).join(": "))
      .filter((s) => s.length > 0);
    if (parts.length > 0) message = parts.join("; ");
    else if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
  } catch {
    // corps non-JSON : jamais inclus tel quel.
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message.slice(0, 300);
}

/**
 * Crée une image DISK_IMAGE depuis une URL (POST /api/nutanix/v3/images, asynchrone — Prism
 * télécharge lui-même source_uri ; suivre l'avancement via getNutanixTask). Aucun repli v2.0 : un
 * 405 REQUEST_NOT_SUPPORTED remonte avec un message explicite (voir en-tête de section).
 */
export async function createNutanixImage(opts: { name: string; sourceUri: string }): Promise<{ ok: true; name: string; taskUuid?: string }> {
  const effective = await loadNutanixConfig();
  if (!effective) {
    throw new NutanixActionError("Nutanix is not configured — configure Prism Central before creating an image", 400);
  }
  const body = {
    api_version: "3.1",
    metadata: { kind: "image" },
    spec: { name: opts.name, resources: { image_type: "DISK_IMAGE", source_uri: opts.sourceUri } },
  };
  const result = await nutanixRequest<NutanixCreateResponse>(
    effective.prismCentralUrl,
    "POST",
    "/api/nutanix/v3/images",
    effective.username,
    effective.password,
    body,
  );
  if (result.status === 405 && result.raw.includes("REQUEST_NOT_SUPPORTED")) {
    throw new NutanixActionError(
      `Prism Central refused v3 image creation for "${opts.name}" (405 REQUEST_NOT_SUPPORTED — Prism Element managed). No v2.0 fallback is implemented: the v2.0 image creation form was never verified on this instance, deliberately not guessed.`,
      502,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new NutanixActionError(
      `Prism Central refused image creation for "${opts.name}" (status ${result.status}): ${sanitizedPrismErrorMessage(result.raw, [])}`,
      502,
    );
  }
  const taskUuid = result.data?.status?.execution_context?.task_uuid;
  return { ok: true, name: opts.name, ...(taskUuid ? { taskUuid } : {}) };
}

export interface NutanixGuestCustomizationInput {
  hostname?: string;
  username: string;
  password?: string;
  sshAuthorizedKey?: string;
}

export interface NutanixCreateVmInput {
  name: string;
  /** Variant "image disque" : clone du disque image — exclusif de isoImageUuid. */
  imageUuid?: string;
  /** Variant "ISO" : disque SCSI vide (diskSizeMib REQUIS) + CDROM branché sur l'ISO,
   * boot CDROM puis DISK — l'OS s'installe ensuite via la console VNC. */
  isoImageUuid?: string;
  subnetUuid: string;
  numVcpus: number;
  numCoresPerVcpu?: number;
  memoryMib: number;
  diskSizeMib?: number;
  guestCustomization?: NutanixGuestCustomizationInput;
}

/** Scalaire YAML entre quotes simples — sûr pour tout caractère hors contrôle (validés en amont). */
function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Valide guestCustomization SANS jamais échoïser mot de passe/clé dans un message d'erreur. */
function validateGuestCustomization(gc: NutanixGuestCustomizationInput): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(gc.username)) {
    throw new NutanixActionError("guestCustomization.username must match ^[a-z_][a-z0-9_-]{0,31}$", 400);
  }
  if (!gc.password && !gc.sshAuthorizedKey) {
    throw new NutanixActionError("guestCustomization requires at least one of password or sshAuthorizedKey", 400);
  }
  if (gc.hostname !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(gc.hostname)) {
    throw new NutanixActionError("guestCustomization.hostname must be a valid hostname (letters, digits, dots, dashes, max 63 chars)", 400);
  }
  if (gc.password !== undefined && (gc.password.length === 0 || CONTROL_CHARS.test(gc.password))) {
    throw new NutanixActionError("guestCustomization.password must be non-empty and free of control characters", 400);
  }
  if (gc.sshAuthorizedKey !== undefined && (gc.sshAuthorizedKey.trim().length === 0 || CONTROL_CHARS.test(gc.sshAuthorizedKey))) {
    throw new NutanixActionError("guestCustomization.sshAuthorizedKey must be a single line without control characters", 400);
  }
}

/** #cloud-config complet — SECRET (contient mot de passe/clé) : jamais loggé, jamais dans une
 * erreur/réponse/audit, uniquement base64 dans guest_customization.cloud_init.user_data. */
function buildCloudInitUserData(gc: NutanixGuestCustomizationInput): string {
  const lines = ["#cloud-config"];
  if (gc.hostname) lines.push(`hostname: ${yamlQuote(gc.hostname)}`);
  lines.push("users:", `  - name: ${yamlQuote(gc.username)}`, "    groups: sudo", "    shell: /bin/bash");
  lines.push(`    sudo: ${yamlQuote("ALL=(ALL) NOPASSWD:ALL")}`, "    lock_passwd: false");
  if (gc.sshAuthorizedKey) lines.push("    ssh_authorized_keys:", `      - ${yamlQuote(gc.sshAuthorizedKey.trim())}`);
  if (gc.password) {
    lines.push("ssh_pwauth: true", "chpasswd:", "  expire: false", "  users:");
    lines.push(`    - name: ${yamlQuote(gc.username)}`, `      password: ${yamlQuote(gc.password)}`, "      type: text");
  }
  return lines.join("\n");
}

/**
 * Crée une VM depuis une image disque (clone du disque image via data_source_reference) sur le
 * cluster UNIQUE existant, avec cloud-init optionnel, et la démarre — power_state "ON" est posé
 * directement dans la spec de création (comportement v3 documenté, utilisé par le provider
 * Terraform Nutanix ; PAS vérifié par mutation sur cette instance — un PUT séparé juste après le
 * POST risquerait une course avec la tâche de création, jamais tenté ici). Refuse (409) si
 * PLUSIEURS clusters existent (le choix de cluster n'est pas dans le contrat de cette mission).
 */
export async function createNutanixVm(input: NutanixCreateVmInput): Promise<{ ok: true; name: string; vmUuid?: string; taskUuid?: string }> {
  const { name, imageUuid, isoImageUuid, subnetUuid, numVcpus, memoryMib, diskSizeMib } = input;
  const numCoresPerVcpu = input.numCoresPerVcpu ?? 1;
  if (!name.trim() || name.length > 80 || CONTROL_CHARS.test(name)) {
    throw new NutanixActionError("name must be a non-empty string of at most 80 characters without control characters", 400);
  }
  if ((imageUuid === undefined) === (isoImageUuid === undefined)) {
    throw new NutanixActionError("exactly one of imageUuid (disk image clone) or isoImageUuid (empty disk + CDROM boot) is required", 400);
  }
  if (isoImageUuid !== undefined && diskSizeMib === undefined) {
    throw new NutanixActionError("diskSizeMib is required with isoImageUuid (size of the empty disk the OS will be installed on)", 400);
  }
  if (!Number.isInteger(numVcpus) || numVcpus < 1 || numVcpus > NUTANIX_MAX_VCPUS) {
    throw new NutanixActionError(`Invalid numVcpus ${numVcpus} — must be an integer between 1 and ${NUTANIX_MAX_VCPUS}`, 400);
  }
  if (!Number.isInteger(numCoresPerVcpu) || numCoresPerVcpu < 1 || numCoresPerVcpu > NUTANIX_MAX_CORES_PER_VCPU) {
    throw new NutanixActionError(`Invalid numCoresPerVcpu ${numCoresPerVcpu} — must be an integer between 1 and ${NUTANIX_MAX_CORES_PER_VCPU}`, 400);
  }
  if (!Number.isInteger(memoryMib) || memoryMib < NUTANIX_MIN_MEMORY_MIB || memoryMib > NUTANIX_MAX_MEMORY_MIB) {
    throw new NutanixActionError(
      `Invalid memoryMib ${memoryMib} — must be an integer between ${NUTANIX_MIN_MEMORY_MIB} and ${NUTANIX_MAX_MEMORY_MIB}`,
      400,
    );
  }
  if (diskSizeMib !== undefined && (!Number.isInteger(diskSizeMib) || diskSizeMib < NUTANIX_DISK_MIN_SIZE_MIB || diskSizeMib > NUTANIX_DISK_MAX_SIZE_MIB)) {
    throw new NutanixActionError(
      `Invalid diskSizeMib ${diskSizeMib} — must be an integer between ${NUTANIX_DISK_MIN_SIZE_MIB} and ${NUTANIX_DISK_MAX_SIZE_MIB} MiB (QUAI safety bounds)`,
      400,
    );
  }
  if (input.guestCustomization) validateGuestCustomization(input.guestCustomization);

  const effective = await loadNutanixConfig();
  if (!effective) {
    throw new NutanixActionError("Nutanix is not configured — configure Prism Central before creating a VM", 400);
  }

  const [subnets, images, clusters] = await Promise.all([fetchNutanixSubnets(effective), getNutanixImages(), getNutanixClusters()]);
  if (!subnets.get(subnetUuid)) {
    throw new NutanixActionError(`Subnet "${subnetUuid}" not found on Prism Central (or subnets list temporarily unavailable)`, 404);
  }
  const wantedImageUuid = imageUuid ?? isoImageUuid!;
  const catalogImage = images.find((i) => i.uuid === wantedImageUuid);
  if (!catalogImage) {
    throw new NutanixActionError(`Image "${wantedImageUuid}" not found on Prism Central (or images list temporarily unavailable)`, 404);
  }
  if (isoImageUuid !== undefined && catalogImage.imageType !== undefined && catalogImage.imageType !== "ISO_IMAGE") {
    throw new NutanixActionError(
      `Image "${catalogImage.name}" is ${catalogImage.imageType}, not an ISO_IMAGE — use imageUuid to clone a disk image instead`,
      400,
    );
  }
  if (clusters.length > 1) {
    throw new NutanixActionError(
      `Refusing to create VM "${name}": ${clusters.length} clusters exist on this Prism Central and cluster selection is not supported yet`,
      409,
    );
  }
  const cluster = clusters[0];
  if (!cluster) {
    throw new NutanixActionError("No Nutanix cluster could be listed from Prism Central — cannot pick a cluster_reference for the new VM", 502);
  }

  const userData = input.guestCustomization ? buildCloudInitUserData(input.guestCustomization) : undefined;
  const userDataB64 = userData !== undefined ? Buffer.from(userData, "utf-8").toString("base64") : undefined;
  // Variant ISO : disque SCSI VIDE (l'OS s'y installera) + CDROM sur l'ISO, boot CDROM puis DISK.
  const diskList =
    isoImageUuid !== undefined
      ? [
          {
            device_properties: { device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: 0 } },
            disk_size_mib: diskSizeMib!,
          },
          {
            device_properties: { device_type: "CDROM", disk_address: { adapter_type: "IDE", device_index: 0 } },
            data_source_reference: { kind: "image", uuid: isoImageUuid },
          },
        ]
      : [
          {
            device_properties: { device_type: "DISK", disk_address: { adapter_type: "SCSI", device_index: 0 } },
            data_source_reference: { kind: "image", uuid: imageUuid! },
            ...(diskSizeMib !== undefined ? { disk_size_mib: diskSizeMib } : {}),
          },
        ];
  const body = {
    api_version: "3.1",
    metadata: { kind: "vm" },
    spec: {
      name,
      cluster_reference: { kind: "cluster", uuid: cluster.uuid, name: cluster.name },
      resources: {
        power_state: "ON",
        num_sockets: numVcpus,
        num_vcpus_per_socket: numCoresPerVcpu,
        memory_size_mib: memoryMib,
        disk_list: diskList,
        nic_list: [{ nic_type: "NORMAL_NIC", vlan_mode: "ACCESS", subnet_reference: { kind: "subnet", uuid: subnetUuid }, is_connected: true }],
        ...(isoImageUuid !== undefined ? { boot_config: { boot_device_order_list: ["CDROM", "DISK"] } } : {}),
        ...(userDataB64 !== undefined ? { guest_customization: { cloud_init: { user_data: userDataB64 } } } : {}),
      },
    },
  };

  const result = await nutanixRequest<NutanixCreateResponse>(
    effective.prismCentralUrl,
    "POST",
    "/api/nutanix/v3/vms",
    effective.username,
    effective.password,
    body,
  );
  // Secrets à masquer par défense en profondeur si Prism échoïsait la spec dans son erreur.
  const secrets = [userDataB64, input.guestCustomization?.password, input.guestCustomization?.sshAuthorizedKey].filter(
    (s): s is string => Boolean(s),
  );
  if (result.status === 405 && result.raw.includes("REQUEST_NOT_SUPPORTED")) {
    throw new NutanixActionError(
      `Prism Central refused v3 VM creation for "${name}" (405 REQUEST_NOT_SUPPORTED — Prism Element managed). No v2.0 fallback is implemented: the v2.0 VM creation form (vm_disks/vm_customization_config) was never verified on this instance, deliberately not guessed.`,
      502,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new NutanixActionError(
      `Prism Central refused VM creation for "${name}" (status ${result.status}): ${sanitizedPrismErrorMessage(result.raw, secrets)}`,
      502,
    );
  }
  const vmUuid = result.data?.metadata?.uuid;
  const taskUuid = result.data?.status?.execution_context?.task_uuid;
  return { ok: true, name, ...(vmUuid ? { vmUuid } : {}), ...(taskUuid ? { taskUuid } : {}) };
}

/** Réponse PLATE de GET /tasks/{uuid} — forme réelle vérifiée le 18/08/2026 (voir en-tête de section). */
interface NutanixTaskResponse {
  uuid?: string;
  status?: string;
  percentage_complete?: number;
}

/** État d'une tâche asynchrone (création d'image/VM) — 404 si inconnue, 400 si jamais configuré. */
export async function getNutanixTask(uuid: string): Promise<NutanixTaskStatus> {
  const effective = await loadNutanixConfig();
  if (!effective) {
    throw new NutanixActionError("Nutanix is not configured — configure Prism Central before polling a task", 400);
  }
  const result = await nutanixRequest<NutanixTaskResponse>(
    effective.prismCentralUrl,
    "GET",
    `/api/nutanix/v3/tasks/${uuid}`,
    effective.username,
    effective.password,
  );
  if (result.status === 404) {
    throw new NutanixActionError(`Task "${uuid}" not found on Prism Central`, 404);
  }
  if (result.status < 200 || result.status >= 300 || !result.data) {
    throw new NutanixActionError(`Prism Central returned an error reading task "${uuid}" (status ${result.status}): ${result.raw.slice(0, 300)}`, 502);
  }
  return {
    uuid: result.data.uuid ?? uuid,
    status: result.data.status ?? "UNKNOWN",
    ...(typeof result.data.percentage_complete === "number" ? { percentageComplete: result.data.percentage_complete } : {}),
  };
}

// ============================================================================================
// Upload direct d'un fichier image (ISO/qcow2/img) vers le catalogue — POST /api/nutanix/images/
// upload (routes/nutanix.ts). Mécanisme v3 documenté par Nutanix : POST /images SANS source_uri
// (l'entité est créée vide), puis PUT /images/{uuid}/file avec le binaire en corps (Content-Type
// application/octet-stream). Ces mutations n'ont JAMAIS été exercées contre l'instance réelle
// (interdiction absolue) : formes exercées uniquement contre le mock des tests. Aucun repli v2.0
// (jamais vérifié) : un 405 REQUEST_NOT_SUPPORTED remonte en 502 honnête, comme createNutanixImage.
// ============================================================================================

export type NutanixUploadImageType = "ISO_IMAGE" | "DISK_IMAGE";

/** PUT binaire STREAMÉ (pipe direct multipart -> Prism, backpressure respectée) — jamais le
 * fichier entier en mémoire. Timeout = inactivité socket (se réarme à chaque chunk). */
function nutanixPutBinaryStream(
  effective: SetupNutanixConfig,
  path: string,
  stream: Readable,
): Promise<{ status: number; raw: string }> {
  const target = new URL(path, normalizedBaseUrl(effective.prismCentralUrl));
  const auth = Buffer.from(`${effective.username}:${effective.password}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: "PUT",
        headers: { Accept: "application/json", Authorization: `Basic ${auth}`, "Content-Type": "application/octet-stream" },
        rejectUnauthorized: config.nutanix.tlsRejectUnauthorized,
        timeout: config.nutanix.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Nutanix image upload to ${path} timed out (no socket activity for ${config.nutanix.requestTimeoutMs}ms)`)));
    req.on("error", (err) => reject(err));
    stream.on("error", (err: Error) => req.destroy(err));
    stream.pipe(req);
  });
}

/** Suppression best-effort d'une image (nettoyage d'un upload échoué/tronqué) — jamais d'erreur
 * levée : l'échec d'origine reste le diagnostic principal. */
export async function deleteNutanixImageBestEffort(uuid: string): Promise<void> {
  const effective = await loadNutanixConfig();
  if (!effective) return;
  await nutanixRequest<unknown>(effective.prismCentralUrl, "DELETE", `/api/nutanix/v3/images/${uuid}`, effective.username, effective.password).catch(
    () => undefined,
  );
}

/**
 * Crée l'entité image (POST /images sans source_uri) puis téléverse le binaire en streaming
 * (PUT /images/{uuid}/file). Si le PUT échoue, l'entité vide est supprimée (best-effort) et
 * l'erreur remonte — jamais une image fantôme laissée silencieusement dans le catalogue.
 */
export async function uploadNutanixImage(opts: {
  name: string;
  imageType: NutanixUploadImageType;
  stream: Readable;
}): Promise<{ ok: true; name: string; uuid: string; taskUuid?: string }> {
  const { name, imageType, stream } = opts;
  if (!name.trim() || name.length > 80 || CONTROL_CHARS.test(name)) {
    throw new NutanixActionError("name must be a non-empty string of at most 80 characters without control characters", 400);
  }
  const effective = await loadNutanixConfig();
  if (!effective) {
    throw new NutanixActionError("Nutanix is not configured — configure Prism Central before uploading an image", 400);
  }

  const createBody = { api_version: "3.1", metadata: { kind: "image" }, spec: { name, resources: { image_type: imageType } } };
  const created = await nutanixRequest<NutanixCreateResponse>(
    effective.prismCentralUrl,
    "POST",
    "/api/nutanix/v3/images",
    effective.username,
    effective.password,
    createBody,
  );
  if (created.status === 405 && created.raw.includes("REQUEST_NOT_SUPPORTED")) {
    throw new NutanixActionError(
      `Prism Central refused v3 image creation for "${name}" (405 REQUEST_NOT_SUPPORTED — Prism Element managed). No v2.0 fallback is implemented: the v2.0 image upload form was never verified on this instance, deliberately not guessed.`,
      502,
    );
  }
  const uuid = created.data?.metadata?.uuid;
  if (created.status < 200 || created.status >= 300 || !uuid) {
    throw new NutanixActionError(
      `Prism Central refused image creation for "${name}" (status ${created.status}): ${sanitizedPrismErrorMessage(created.raw, [])}`,
      502,
    );
  }

  let put: { status: number; raw: string };
  try {
    put = await nutanixPutBinaryStream(effective, `/api/nutanix/v3/images/${uuid}/file`, stream);
  } catch (err) {
    await deleteNutanixImageBestEffort(uuid);
    throw new NutanixActionError(
      `Image file upload for "${name}" failed mid-stream: ${err instanceof Error ? err.message : String(err)} (empty image entity removed)`,
      502,
    );
  }
  if (put.status < 200 || put.status >= 300) {
    await deleteNutanixImageBestEffort(uuid);
    throw new NutanixActionError(
      `Prism Central refused the image file upload for "${name}" (status ${put.status}): ${sanitizedPrismErrorMessage(put.raw, [])} (empty image entity removed)`,
      502,
    );
  }
  const taskUuid = created.data?.status?.execution_context?.task_uuid;
  return { ok: true, name, uuid, ...(taskUuid ? { taskUuid } : {}) };
}

// ============================================================================================
// Statistiques temps réel + alertes (API Prism v2.0 `/PrismGateway/services/rest/v2.0`, la même
// base que nutanixV2Mutation ci-dessus) — retour utilisateur du 19/08/2026, capture du dashboard
// Prism à l'appui : "il manque toutes les infos intégrées du dashboard à voir en temps réel"
// (IOPS, latence, CPU/RAM du cluster, stockage utilisé/total, santé et alertes).
//
// POURQUOI PAS v3 : vérifié en conditions réelles le 19/08/2026 sur l'instance 172.20.0.10:9440,
// `POST /api/nutanix/v3/clusters/list` ne renvoie AUCUNE statistique — `status.resources` n'a que
// trois clés (`config`, `nodes`, `network`), que de la configuration statique. Les compteurs du
// dashboard viennent tous de l'API v2.0, en LECTURE SEULE (GET uniquement).
//
// UNITÉS — toutes DÉDUITES ARITHMÉTIQUEMENT du payload réel, jamais supposées depuis la doc :
//  - `*_num_iops` = IO/s : `controller_num_io`/`controller_timespan_usecs` = 15536/30 s = 517,9,
//    et l'instance renvoyait bien `controller_num_iops = "517"`.
//  - `*_avg_*_latency_usecs` = MICROsecondes : `controller_total_io_time_usecs`/`controller_num_io`
//    = 10550552/15536 = 679,1, et l'instance renvoyait `controller_avg_io_latency_usecs = "679"`.
//  - `*_ppm` = parts par million (1 000 000 = 100 %) : `read_io_ppm` + `write_io_ppm`
//    = 690948 + 309051 = 999 999 sur le payload réel.
//  - `*_io_bandwidth_kBps` = kilo-octets/s : `total_io_size_kbytes`/`timespan_usecs`
//    = 103477/20 s = 5173,85, et l'instance renvoyait `io_bandwidth_kBps = "5173"`. Le nombre
//    d'octets dans un « k » (1000 ou 1024) n'est PAS déductible du payload : la valeur est donc
//    exposée telle quelle sous un nom qui porte son unité SOURCE (`...KbytesPerSec`), jamais
//    convertie en octets/s sur une hypothèse.
//  - `*_time_stamp_in_usecs` (alertes) = microsecondes depuis l'epoch Unix : 1786378665233736 µs
//    = 2026-08-08, cohérent avec l'âge réel des alertes de cette instance.
// ============================================================================================

/** Bloc `stats`/`usage_stats` d'une entité v2.0 : toutes les valeurs sont des CHAÎNES, et "-1" est
 * la sentinelle "métrique non disponible" (observée en masse sur l'instance réelle, ex.
 * `avg_read_io_latency_usecs = "-1"` alors que `avg_io_latency_usecs = "403"`). */
type NutanixV2StatsMap = Record<string, string>;

/** Valeur numérique d'une métrique, ou `undefined` si absente/non numérique/sentinelle "-1".
 * N'est appliquée QU'À des métriques dont une valeur négative n'a aucun sens (IOPS, latence,
 * débit, ppm, octets) — jamais à un delta signé façon `content_cache_saved_memory_usage_bytes`. */
function v2Stat(stats: NutanixV2StatsMap | undefined, key: string): number | undefined {
  const raw = stats?.[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Pourcentage réel depuis une métrique en ppm (voir en-tête de section pour la preuve). */
function v2Percent(stats: NutanixV2StatsMap | undefined, key: string): number | undefined {
  const ppm = v2Stat(stats, key);
  return ppm === undefined ? undefined : ppm / 10_000;
}

/** Horodatage ISO depuis un timestamp Prism en microsecondes — `undefined` si absent ou nul (0 est
 * la valeur réelle d'un champ « pas encore arrivé », ex. `resolved_time_stamp_in_usecs` d'une
 * alerte non résolue), jamais une date de 1970 affichée comme si elle était vraie. */
function isoFromUsecs(usecs: number | undefined): string | undefined {
  if (typeof usecs !== "number" || !Number.isFinite(usecs) || usecs <= 0) return undefined;
  const date = new Date(Math.round(usecs / 1000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** GET en LECTURE SEULE sur l'API v2.0 — `null` sur toute erreur (HTTP, réseau, JSON), jamais
 * d'exception : ces routes de statistiques suivent le patron « [] / null honnête » du reste du
 * fichier, jamais une donnée inventée ni un 500 sur un accroc réseau passager. */
async function nutanixV2Get<T>(effective: SetupNutanixConfig, path: string): Promise<T | null> {
  try {
    const result = await nutanixRequest<T>(effective.prismCentralUrl, "GET", `${NUTANIX_V2_BASE}${path}`, effective.username, effective.password);
    if (result.status < 200 || result.status >= 300) return null;
    return result.data;
  } catch {
    return null;
  }
}

/** Compteurs d'entrées/sorties d'une entité (cluster/hôte). Chaque champ porte son unité dans son
 * nom — jamais un nombre nu ambigu (voir en-tête de section pour la preuve de chaque unité). */
export interface NutanixIoStats {
  readIops?: number;
  writeIops?: number;
  totalIops?: number;
  avgLatencyUsec?: number;
  avgReadLatencyUsec?: number;
  avgWriteLatencyUsec?: number;
  readThroughputKbytesPerSec?: number;
  writeThroughputKbytesPerSec?: number;
  totalThroughputKbytesPerSec?: number;
}

/** Occupation de stockage réelle (`usage_stats["storage.*"]`, déjà en octets côté Prism). */
export interface NutanixStorageUsage {
  capacityBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  /** Taille vue par les VMs avant compression/dédup/EC — toujours >= `usedBytes`. */
  logicalUsedBytes?: number;
}

export interface NutanixStorageContainerStats {
  uuid: string;
  name: string;
  storage: NutanixStorageUsage;
}

/** Statistiques d'un hôte physique AHV — `uuid` est le MÊME que celui de `getNutanixHosts()`
 * (v3), vérifié en conditions réelles (HDVNUTA1 = 655ce338-…-0c0d43 des deux côtés) : le frontend
 * peut donc rapprocher ces stats d'un nœud "nutanix-host" du graphe par identité stable. */
export interface NutanixHostStats {
  uuid: string;
  name: string;
  /** État réel rapporté par Prism ("NORMAL" sur les 3 hôtes de l'instance vérifiée). */
  state?: string;
  numVms?: number;
  inMaintenanceMode?: boolean;
  degraded?: boolean;
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  cpuCapacityHz?: number;
  numCpuCores?: number;
  memoryCapacityBytes?: number;
  controllerIo: NutanixIoStats;
  storage: NutanixStorageUsage;
}

/** Santé du cluster — uniquement des faits rapportés par Prism (tolérance aux pannes réelle,
 * nombre d'hôtes à l'état NORMAL), jamais un score maison. */
export interface NutanixClusterHealth {
  currentFaultTolerance?: number;
  desiredFaultTolerance?: number;
  currentRedundancyFactor?: number;
  desiredRedundancyFactor?: number;
  hostsTotal: number;
  hostsNormal: number;
}

export interface NutanixClusterStats {
  uuid: string;
  name: string;
  version?: string;
  numNodes?: number;
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  /** Somme des capacités RÉELLES des hôtes de ce cluster (`cpu_capacity_in_hz` /
   * `memory_capacity_in_bytes` par hôte) — une somme explicite, pas un champ d'API : Prism ne
   * publie pas de capacité agrégée au niveau cluster sur cet endpoint. `undefined` si aucun hôte
   * n'a communiqué sa capacité. */
  cpuCapacityHz?: number;
  memoryCapacityBytes?: number;
  /** IO vues par la couche de stockage Nutanix (CVM/Stargate, préfixe `controller_*`) — c'est
   * cette famille que le dashboard Prism met en avant. */
  controllerIo: NutanixIoStats;
  /** IO vues au niveau cluster agrégé (métriques sans préfixe) — exposée à part plutôt que
   * fusionnée : ce sont deux mesures RÉELLEMENT différentes (517 vs 138 IOPS au même instant sur
   * l'instance vérifiée), les confondre donnerait un chiffre faux. */
  clusterIo: NutanixIoStats;
  storage: NutanixStorageUsage;
  storageContainers: NutanixStorageContainerStats[];
  health: NutanixClusterHealth;
  hosts: NutanixHostStats[];
}

/** Enveloppe honnête : `configured` distingue « Nutanix n'a jamais été configuré » de `reachable`
 * « configuré mais Prism ne répond pas », et `lastPoll` reprend le signal déjà exposé au graphe
 * (voir lastKnownNutanixPoll) — mêmes trois états explicites côté UI, jamais un tableau vide muet. */
export interface NutanixClusterStatsResponse {
  configured: boolean;
  reachable: boolean;
  clusters: NutanixClusterStats[];
  lastPoll: NutanixPollOutcome | null;
}

interface NutanixV2ClusterEntity {
  uuid?: string;
  cluster_uuid?: string;
  name?: string;
  version?: string;
  num_nodes?: number;
  cluster_redundancy_state?: {
    current_redundancy_factor?: number;
    desired_redundancy_factor?: number;
    current_cluster_fault_tolerance?: number;
    desired_cluster_fault_tolerance?: number;
  };
  stats?: NutanixV2StatsMap;
  usage_stats?: NutanixV2StatsMap;
}

interface NutanixV2HostEntity {
  uuid?: string;
  name?: string;
  state?: string;
  cluster_uuid?: string;
  num_vms?: number;
  is_degraded?: boolean;
  host_in_maintenance_mode?: boolean;
  num_cpu_cores?: number;
  cpu_capacity_in_hz?: number;
  memory_capacity_in_bytes?: number;
  stats?: NutanixV2StatsMap;
  usage_stats?: NutanixV2StatsMap;
}

interface NutanixV2StorageContainerEntity {
  storage_container_uuid?: string;
  name?: string;
  cluster_uuid?: string;
  usage_stats?: NutanixV2StatsMap;
}

interface NutanixV2ListResponse<T> {
  metadata?: { grand_total_entities?: number; total_entities?: number; count?: number };
  entities?: T[];
}

/** IO d'une entité, pour une famille de métriques donnée : `""` (cluster agrégé) ou `"controller_"`
 * (couche de stockage Nutanix) — les deux familles portent EXACTEMENT les mêmes suffixes sur
 * l'instance vérifiée, d'où ce mapping unique paramétré par préfixe. */
function mapV2IoStats(stats: NutanixV2StatsMap | undefined, prefix: "" | "controller_"): NutanixIoStats {
  const readIops = v2Stat(stats, `${prefix}num_read_iops`);
  const writeIops = v2Stat(stats, `${prefix}num_write_iops`);
  const totalIops = v2Stat(stats, `${prefix}num_iops`);
  const avgLatencyUsec = v2Stat(stats, `${prefix}avg_io_latency_usecs`);
  const avgReadLatencyUsec = v2Stat(stats, `${prefix}avg_read_io_latency_usecs`);
  const avgWriteLatencyUsec = v2Stat(stats, `${prefix}avg_write_io_latency_usecs`);
  const readThroughputKbytesPerSec = v2Stat(stats, `${prefix}read_io_bandwidth_kBps`);
  const writeThroughputKbytesPerSec = v2Stat(stats, `${prefix}write_io_bandwidth_kBps`);
  const totalThroughputKbytesPerSec = v2Stat(stats, `${prefix}io_bandwidth_kBps`);
  return {
    ...(readIops !== undefined ? { readIops } : {}),
    ...(writeIops !== undefined ? { writeIops } : {}),
    ...(totalIops !== undefined ? { totalIops } : {}),
    ...(avgLatencyUsec !== undefined ? { avgLatencyUsec } : {}),
    ...(avgReadLatencyUsec !== undefined ? { avgReadLatencyUsec } : {}),
    ...(avgWriteLatencyUsec !== undefined ? { avgWriteLatencyUsec } : {}),
    ...(readThroughputKbytesPerSec !== undefined ? { readThroughputKbytesPerSec } : {}),
    ...(writeThroughputKbytesPerSec !== undefined ? { writeThroughputKbytesPerSec } : {}),
    ...(totalThroughputKbytesPerSec !== undefined ? { totalThroughputKbytesPerSec } : {}),
  };
}

function mapV2Storage(usage: NutanixV2StatsMap | undefined): NutanixStorageUsage {
  const capacityBytes = v2Stat(usage, "storage.capacity_bytes");
  const usedBytes = v2Stat(usage, "storage.usage_bytes");
  const freeBytes = v2Stat(usage, "storage.free_bytes");
  const logicalUsedBytes = v2Stat(usage, "storage.logical_usage_bytes");
  return {
    ...(capacityBytes !== undefined ? { capacityBytes } : {}),
    ...(usedBytes !== undefined ? { usedBytes } : {}),
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    ...(logicalUsedBytes !== undefined ? { logicalUsedBytes } : {}),
  };
}

function mapV2HostStats(host: NutanixV2HostEntity & { uuid: string }): NutanixHostStats {
  const cpuUsagePercent = v2Percent(host.stats, "hypervisor_cpu_usage_ppm");
  const memoryUsagePercent = v2Percent(host.stats, "hypervisor_memory_usage_ppm");
  return {
    uuid: host.uuid,
    name: host.name ?? host.uuid,
    ...(host.state ? { state: host.state } : {}),
    ...(typeof host.num_vms === "number" ? { numVms: host.num_vms } : {}),
    ...(typeof host.host_in_maintenance_mode === "boolean" ? { inMaintenanceMode: host.host_in_maintenance_mode } : {}),
    ...(typeof host.is_degraded === "boolean" ? { degraded: host.is_degraded } : {}),
    ...(cpuUsagePercent !== undefined ? { cpuUsagePercent } : {}),
    ...(memoryUsagePercent !== undefined ? { memoryUsagePercent } : {}),
    ...(typeof host.cpu_capacity_in_hz === "number" ? { cpuCapacityHz: host.cpu_capacity_in_hz } : {}),
    ...(typeof host.num_cpu_cores === "number" ? { numCpuCores: host.num_cpu_cores } : {}),
    ...(typeof host.memory_capacity_in_bytes === "number" ? { memoryCapacityBytes: host.memory_capacity_in_bytes } : {}),
    controllerIo: mapV2IoStats(host.stats, "controller_"),
    storage: mapV2Storage(host.usage_stats),
  };
}

/** Somme d'un champ de capacité sur une liste d'hôtes — `undefined` (et non 0) si AUCUN hôte ne
 * l'a communiqué, pour ne jamais afficher « 0 Go de RAM » là où l'info manque simplement. */
function sumHostCapacity(hosts: NutanixHostStats[], pick: (h: NutanixHostStats) => number | undefined): number | undefined {
  let total = 0;
  let found = false;
  for (const host of hosts) {
    const value = pick(host);
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

/**
 * Statistiques RÉELLES du/des clusters Nutanix (GET /api/nutanix/cluster-stats) : CPU/mémoire,
 * IOPS/latence/débit, stockage utilisé/total (cluster + par storage container), santé et stats par
 * hôte physique. Trois GET v2.0 en parallèle (`/clusters/`, `/hosts/`, `/storage_containers/`),
 * jamais un appel par entité.
 *
 * `configured: false` si Nutanix n'a jamais été configuré ; `reachable: false` si configuré mais
 * la liste des clusters n'a pas pu être lue (même patron que getNutanixVms — jamais de chiffre
 * inventé). Un échec des SEULS hôtes/storage containers laisse `reachable: true` avec les listes
 * correspondantes vides : la moitié réelle vaut mieux que rien, et l'absence reste visible.
 *
 * `lastPoll` est LU (jamais écrit) ici : ce compteur est le signal de fraîcheur du poll de
 * TOPOLOGIE affiché dans la légende du graphe (voir lastKnownNutanixPoll) — l'écraser au rythme
 * bien plus rapide du panneau de statistiques fausserait ce signal.
 */
export async function getNutanixClusterStats(): Promise<NutanixClusterStatsResponse> {
  const effective = await loadNutanixConfig();
  if (!effective) return { configured: false, reachable: false, clusters: [], lastPoll: lastKnownNutanixPoll() };

  const [clustersData, hostsData, containersData] = await Promise.all([
    nutanixV2Get<NutanixV2ListResponse<NutanixV2ClusterEntity>>(effective, "/clusters/"),
    nutanixV2Get<NutanixV2ListResponse<NutanixV2HostEntity>>(effective, "/hosts/"),
    nutanixV2Get<NutanixV2ListResponse<NutanixV2StorageContainerEntity>>(effective, "/storage_containers/"),
  ]);

  if (!clustersData) return { configured: true, reachable: false, clusters: [], lastPoll: lastKnownNutanixPoll() };

  const hostEntities = (hostsData?.entities ?? []).filter((h): h is NutanixV2HostEntity & { uuid: string } => Boolean(h.uuid));
  const containerEntities = containersData?.entities ?? [];

  const clusters: NutanixClusterStats[] = [];
  for (const entity of clustersData.entities ?? []) {
    const uuid = entity.cluster_uuid ?? entity.uuid;
    if (!uuid) continue;
    // Hôtes/containers rattachés par `cluster_uuid` réel ; sur une instance mono-cluster Prism
    // omet parfois ce champ — on retombe alors sur « tout appartient à l'unique cluster »,
    // jamais sur une répartition devinée quand plusieurs clusters existent.
    const soleCluster = (clustersData.entities ?? []).length === 1;
    const hosts = hostEntities.filter((h) => h.cluster_uuid === uuid || (soleCluster && !h.cluster_uuid)).map(mapV2HostStats);
    const storageContainers: NutanixStorageContainerStats[] = containerEntities
      .filter((c) => Boolean(c.storage_container_uuid) && (c.cluster_uuid === uuid || (soleCluster && !c.cluster_uuid)))
      .map((c) => ({ uuid: c.storage_container_uuid!, name: c.name ?? c.storage_container_uuid!, storage: mapV2Storage(c.usage_stats) }));

    const cpuUsagePercent = v2Percent(entity.stats, "hypervisor_cpu_usage_ppm");
    const memoryUsagePercent = v2Percent(entity.stats, "hypervisor_memory_usage_ppm");
    const cpuCapacityHz = sumHostCapacity(hosts, (h) => h.cpuCapacityHz);
    const memoryCapacityBytes = sumHostCapacity(hosts, (h) => h.memoryCapacityBytes);
    const redundancy = entity.cluster_redundancy_state ?? {};

    clusters.push({
      uuid,
      name: entity.name ?? uuid,
      ...(entity.version ? { version: entity.version } : {}),
      ...(typeof entity.num_nodes === "number" ? { numNodes: entity.num_nodes } : {}),
      ...(cpuUsagePercent !== undefined ? { cpuUsagePercent } : {}),
      ...(memoryUsagePercent !== undefined ? { memoryUsagePercent } : {}),
      ...(cpuCapacityHz !== undefined ? { cpuCapacityHz } : {}),
      ...(memoryCapacityBytes !== undefined ? { memoryCapacityBytes } : {}),
      controllerIo: mapV2IoStats(entity.stats, "controller_"),
      clusterIo: mapV2IoStats(entity.stats, ""),
      storage: mapV2Storage(entity.usage_stats),
      storageContainers,
      health: {
        ...(typeof redundancy.current_cluster_fault_tolerance === "number" ? { currentFaultTolerance: redundancy.current_cluster_fault_tolerance } : {}),
        ...(typeof redundancy.desired_cluster_fault_tolerance === "number" ? { desiredFaultTolerance: redundancy.desired_cluster_fault_tolerance } : {}),
        ...(typeof redundancy.current_redundancy_factor === "number" ? { currentRedundancyFactor: redundancy.current_redundancy_factor } : {}),
        ...(typeof redundancy.desired_redundancy_factor === "number" ? { desiredRedundancyFactor: redundancy.desired_redundancy_factor } : {}),
        hostsTotal: hosts.length,
        hostsNormal: hosts.filter((h) => h.state === "NORMAL").length,
      },
      hosts,
    });
  }

  return { configured: true, reachable: true, clusters, lastPoll: lastKnownNutanixPoll() };
}

/** Sévérité normalisée d'une alerte — Prism renvoie la forme préfixée `kCritical`/`kWarning`/
 * `kInfo`/`kAudit` (observée : `kWarning`), tandis que son FILTRE d'entrée n'accepte que
 * `CRITICAL/WARNING/INFO/AUDIT` (message d'erreur 422 réel de l'instance). `unknown` pour toute
 * valeur inattendue : jamais rangée d'office en "info", ce qui minimiserait une alerte grave. */
export type NutanixAlertSeverity = "critical" | "warning" | "info" | "audit" | "unknown";

export interface NutanixAlert {
  id: string;
  severity: NutanixAlertSeverity;
  /** Valeur brute Prism (`kWarning`…) — conservée telle quelle, jamais perdue par la normalisation. */
  severityRaw: string;
  title: string;
  /** Message avec ses marqueurs `{…}` résolus depuis context_types/context_values (voir
   * resolveAlertMessage) — un marqueur sans contexte correspondant reste littéral. */
  message: string;
  acknowledged: boolean;
  createdAt?: string;
  lastOccurredAt?: string;
  entityType?: string;
  entityName?: string;
  entityUuid?: string;
  clusterUuid?: string;
}

export interface NutanixAlertsResponse {
  configured: boolean;
  reachable: boolean;
  alerts: NutanixAlert[];
  /** Total RÉEL d'alertes non résolues côté Prism (`metadata.grand_total_entities`), qui peut
   * largement dépasser `alerts.length` (borné par `limit`) — 25 sur l'instance vérifiée. */
  totalUnresolved?: number;
  lastPoll: NutanixPollOutcome | null;
}

interface NutanixV2AlertEntity {
  id?: string;
  severity?: string;
  acknowledged?: boolean;
  alert_title?: string;
  message?: string;
  cluster_uuid?: string;
  created_time_stamp_in_usecs?: number;
  last_occurrence_time_stamp_in_usecs?: number;
  context_types?: string[];
  context_values?: string[];
  affected_entities?: { entity_type?: string; entity_name?: string; uuid?: string }[];
}

const NUTANIX_ALERT_SEVERITY: Record<string, NutanixAlertSeverity> = {
  kCritical: "critical",
  kWarning: "warning",
  kInfo: "info",
  kAudit: "audit",
};

/** Remplace les marqueurs `{clé}` du message par la valeur réelle portée par les tableaux
 * PARALLÈLES `context_types`/`context_values` — mécanisme confirmé en conditions réelles :
 * `"…for the VM {vm_name} failed because {reason}."` avec `context_types` contenant bien
 * `vm_name`/`reason` aux index de `context_values` `"HDVAIRSDB"`/`"Quiescing guest VM failed…"`.
 * Un marqueur sans clé correspondante (ou de valeur vide) reste AFFICHÉ TEL QUEL : mieux vaut un
 * `{reason}` visible qu'un texte amputé donnant l'illusion d'un message complet. */
function resolveAlertMessage(message: string, types: string[] | undefined, values: string[] | undefined): string {
  if (!types || !values) return message;
  return message.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) => {
    const index = types.indexOf(key);
    const value = index >= 0 ? values[index] : undefined;
    return value ? value : whole;
  });
}

const NUTANIX_ALERTS_DEFAULT_LIMIT = 25;
const NUTANIX_ALERTS_MAX_LIMIT = 100;

/**
 * Alertes RÉELLES non résolues du/des clusters (GET /api/nutanix/alerts), les `limit` plus
 * récentes — `GET /alerts/?resolved=false&count=N`, en lecture seule (aucun acquittement/
 * résolution : QUAI ne fait qu'AFFICHER, la remédiation reste dans Prism).
 *
 * L'instance réelle renvoie déjà les plus récentes d'abord ; le tri local par date de dernière
 * occurrence ne fait que garantir cet ordre côté affichage, sans jamais réordonner ce que le
 * serveur a sélectionné. Mêmes trois états explicites que getNutanixClusterStats.
 */
export async function getNutanixAlerts(limit = NUTANIX_ALERTS_DEFAULT_LIMIT): Promise<NutanixAlertsResponse> {
  const effective = await loadNutanixConfig();
  if (!effective) return { configured: false, reachable: false, alerts: [], lastPoll: lastKnownNutanixPoll() };

  const count = Math.min(Math.max(Math.trunc(limit) || NUTANIX_ALERTS_DEFAULT_LIMIT, 1), NUTANIX_ALERTS_MAX_LIMIT);
  const data = await nutanixV2Get<NutanixV2ListResponse<NutanixV2AlertEntity>>(effective, `/alerts/?resolved=false&count=${count}`);
  if (!data) return { configured: true, reachable: false, alerts: [], lastPoll: lastKnownNutanixPoll() };

  const alerts: NutanixAlert[] = (data.entities ?? [])
    .filter((a): a is NutanixV2AlertEntity & { id: string } => Boolean(a.id))
    .map((a) => {
      const affected = a.affected_entities?.[0];
      const createdAt = isoFromUsecs(a.created_time_stamp_in_usecs);
      const lastOccurredAt = isoFromUsecs(a.last_occurrence_time_stamp_in_usecs);
      return {
        id: a.id,
        severity: (a.severity ? NUTANIX_ALERT_SEVERITY[a.severity] : undefined) ?? "unknown",
        severityRaw: a.severity ?? "unknown",
        title: a.alert_title ?? "Alerte sans titre",
        message: resolveAlertMessage(a.message ?? "", a.context_types, a.context_values),
        acknowledged: a.acknowledged === true,
        ...(createdAt ? { createdAt } : {}),
        ...(lastOccurredAt ? { lastOccurredAt } : {}),
        ...(affected?.entity_type ? { entityType: affected.entity_type } : {}),
        ...(affected?.entity_name ? { entityName: affected.entity_name } : {}),
        ...(affected?.uuid ? { entityUuid: affected.uuid } : {}),
        ...(a.cluster_uuid ? { clusterUuid: a.cluster_uuid } : {}),
      };
    })
    .sort((a, b) => (b.lastOccurredAt ?? b.createdAt ?? "").localeCompare(a.lastOccurredAt ?? a.createdAt ?? ""));

  const totalUnresolved = data.metadata?.grand_total_entities;
  return {
    configured: true,
    reachable: true,
    alerts,
    ...(typeof totalUnresolved === "number" ? { totalUnresolved } : {}),
    lastPoll: lastKnownNutanixPoll(),
  };
}
