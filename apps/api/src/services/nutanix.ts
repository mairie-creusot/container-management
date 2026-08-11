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
import type { ClusterNode, Environment, NutanixVm } from "../types.js";

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

// --- Formes (partielles) des réponses Prism Central v3 — seuls les champs utilisés ici. ---

interface NutanixEntityResources {
  power_state?: string;
  num_sockets?: number;
  num_vcpus_per_socket?: number;
  memory_size_mib?: number;
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

function mapPowerState(raw: string | undefined): NutanixVm["powerState"] {
  if (raw === "ON") return "on";
  if (raw === "OFF") return "off";
  return "unknown";
}

function mapVmEntity(entity: NutanixVmEntity): NutanixVm {
  const resources = entity.status?.resources ?? entity.spec?.resources ?? {};
  const numSockets = resources.num_sockets ?? 0;
  const numVcpusPerSocket = resources.num_vcpus_per_socket ?? 0;
  return {
    id: entity.metadata?.uuid ?? entity.status?.name ?? entity.spec?.name ?? "unknown-vm",
    name: entity.status?.name ?? entity.spec?.name ?? "VM sans nom",
    powerState: mapPowerState(resources.power_state),
    numVcpus: numSockets * numVcpusPerSocket,
    memoryMib: resources.memory_size_mib ?? 0,
    cluster: entity.status?.cluster_reference?.name ?? entity.spec?.cluster_reference?.name ?? "unknown-cluster",
  };
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
 */
export async function getNutanixVms(): Promise<NutanixVm[]> {
  const effective = await loadNutanixConfig();
  if (!effective) return [];

  try {
    const data = await nutanixPost<NutanixVmsListResponse>(
      effective.prismCentralUrl,
      "/api/nutanix/v3/vms/list",
      effective.username,
      effective.password,
      { kind: "vm", length: 500, offset: 0 },
    );
    return (data.entities ?? []).map(mapVmEntity);
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
