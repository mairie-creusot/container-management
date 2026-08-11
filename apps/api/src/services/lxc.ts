/**
 * Intégration LXC via LXD (démon de gestion LXC de Canonical, largement utilisé — notamment par
 * Proxmox indirectement), sa VRAIE API REST (https://documentation.ubuntu.com/lxd/en/latest/rest-api/)
 * — PAS une réimplémentation de `lxc-*` en sous-processus distant : LXC seul n'a pas d'API réseau
 * standard (techno de conteneurisation bas niveau, pilotée localement via `lxc-*`), LXD EST la
 * façon standard de la piloter à distance. Authentification par certificat client (mTLS), comme
 * documenté pour tout accès distant à l'API LXD.
 *
 * Même principe que nutanix.ts : PAS de repli sur le jeu de données de démonstration. Si LXD n'a
 * jamais été configuré via services/lxcStore.ts, on retourne `null`/`[]` — jamais de conteneur
 * LXC fabriqué. Si configuré mais injoignable (LXD down, certificat révoqué, réseau...), le
 * repli est simplement "vide", pas un jeu de conteneurs fictifs, faute de dataset de démo LXC.
 */

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { config } from "../config.js";
import { getEffectiveLxcConfig } from "./lxcStore.js";
import type { EffectiveLxcConfig } from "./lxcStore.js";
import type { ClusterNode, Environment, LxcContainer } from "../types.js";

function normalizedBaseUrl(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

/**
 * GET générique vers l'API REST de LXD, authentifié par certificat client (mTLS) — `rejectUnauthorized`
 * est désactivé par défaut (config.lxc.tlsRejectUnauthorized) car LXD présente très souvent un
 * certificat auto-signé généré à l'installation, jamais signé par une CA publique.
 */
async function lxdGet<T>(endpoint: string, path: string, clientCert: string, clientKey: string): Promise<T> {
  const target = new URL(path, normalizedBaseUrl(endpoint));

  return await new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cert: clientCert,
        key: clientKey,
        rejectUnauthorized: config.lxc.tlsRejectUnauthorized,
        timeout: config.lxc.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`LXD API request to ${path} failed with status ${status}: ${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
          } catch (err) {
            reject(new Error(`LXD API returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`LXD API request to ${path} timed out after ${config.lxc.requestTimeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

// --- Formes (partielles) des réponses REST LXD — seuls les champs utilisés ici. ---

interface LxdInstance {
  name?: string;
  status?: string;
  architecture?: string;
  created_at?: string;
  type?: string;
}

interface LxdSyncResponse<T> {
  type?: string;
  status?: string;
  status_code?: number;
  metadata?: T;
  error?: string;
}

function mapInstance(entity: LxdInstance): LxcContainer {
  return {
    name: entity.name ?? "unknown",
    status: entity.status ?? "Unknown",
    architecture: entity.architecture ?? "unknown",
    createdAt: entity.created_at ?? "",
    type: entity.type ?? "container",
  };
}

/**
 * true si LXD a été explicitement configuré (endpoint + certificat client complets) — même
 * principe que nutanix.ts#isNutanixConfigured, utilisé par le watchdog pour ne jamais
 * surveiller/notifier une intégration qui n'a jamais été configurée.
 */
export async function isLxcConfigured(): Promise<boolean> {
  return (await getEffectiveLxcConfig()) !== null;
}

/**
 * Sonde de joignabilité : true si LXD répond (et authentifie le certificat client) avec la
 * config effective persistée. Ne jamais appeler sans avoir vérifié isLxcConfigured() d'abord
 * (sinon false serait renvoyé pour "jamais configuré", pas pour "injoignable").
 */
export async function isLxcReachable(): Promise<boolean> {
  const effective = await getEffectiveLxcConfig();
  if (!effective) return false;
  const result = await testLxcConnection(effective.endpoint, effective.clientCert, effective.clientKey);
  return result.ok;
}

/**
 * Utilisé par la route de test de config (GET /api/lxc/config/test) : teste une config LXD
 * candidate (déjà persistée ou non) sans jamais modifier l'état applicatif. Interroge
 * /1.0/instances (pas seulement /1.0, accessible aux clients non authentifiés) pour vérifier que
 * le certificat client est réellement accepté par LXD, pas seulement que le serveur répond.
 */
export async function testLxcConnection(
  endpoint: string,
  clientCert: string,
  clientKey: string,
): Promise<{ ok: boolean; message: string; instanceCount?: number }> {
  if (!endpoint || !clientCert || !clientKey) {
    return { ok: false, message: "endpoint, clientCert et clientKey sont requis" };
  }
  try {
    const data = await lxdGet<LxdSyncResponse<LxdInstance[]>>(endpoint, "/1.0/instances?recursion=1", clientCert, clientKey);
    const instanceCount = data.metadata?.length ?? 0;
    return { ok: true, message: "LXD est joignable et le certificat client est accepté", instanceCount };
  } catch (err) {
    return { ok: false, message: `LXD injoignable : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Liste les instances (conteneurs + VMs) pilotées par LXD — [] si LXD n'a jamais été configuré,
 * également [] si configuré mais injoignable : il n'existe pas de jeu d'instances de démonstration
 * LXC, donc "repli vide" plutôt que "repli démo" dans ce second cas — jamais de fausses données.
 */
export async function getLxcContainers(): Promise<LxcContainer[]> {
  const effective = await getEffectiveLxcConfig();
  if (!effective) return [];

  try {
    const data = await lxdGet<LxdSyncResponse<LxdInstance[]>>(
      effective.endpoint,
      "/1.0/instances?recursion=1",
      effective.clientCert,
      effective.clientKey,
    );
    return (data.metadata ?? []).map(mapInstance);
  } catch {
    return [];
  }
}

/**
 * Récupère l'environnement LXD — un seul nœud "agrégat" (LXD n'expose pas de notion de cluster
 * physique multi-hôtes dans ce premier lot, contrairement à Nutanix) portant le compteur
 * d'instances. `null` si LXD n'a jamais été configuré (pas d'environnement "LXC" fictif mélangé
 * aux vrais environnements Docker/Kubernetes/Nutanix dans ce cas) ; repli "vide" (nodes: [])
 * si configuré mais injoignable — même principe que getNutanixEnvironment.
 */
export async function getLxcEnvironment(): Promise<Environment | null> {
  const effective = await getEffectiveLxcConfig();
  if (!effective) return null;

  try {
    const instances = await getLxcContainers();
    const node: ClusterNode = {
      id: "lxd",
      environmentId: "lxc",
      role: "standalone",
      // Pas d'API de métriques agrégées interrogée dans ce premier lot (même limite que
      // Kubernetes/Nutanix pour cpuPercent/memPercent) : LXD expose bien des métriques par
      // instance (/1.0/instances/<name>/state) mais pas d'agrégat hôte en un seul appel.
      cpuPercent: 0,
      memPercent: 0,
      status: "ok",
      containerCount: instances.length,
    };
    return {
      id: "lxc",
      name: "LXC (LXD)",
      orchestrator: "lxc",
      status: "ok",
      nodes: [node],
    };
  } catch {
    return {
      id: "lxc",
      name: "LXC (LXD)",
      orchestrator: "lxc",
      status: "warn",
      nodes: [],
    };
  }
}
