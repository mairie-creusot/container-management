/**
 * Intégration Kubernetes via @kubernetes/client-node.
 *
 * IMPORTANT — repli de développement : si aucun kubeconfig valide n'est disponible
 * (KUBECONFIG non défini, fichier absent, cluster injoignable, timeout...), ce module
 * retombe proprement sur le jeu de données de démonstration en mémoire
 * (src/services/demoData.ts) pour l'environnement Staging/Kubernetes. Ce n'est PAS un
 * mock permanent : dès qu'un cluster répond, les données réelles sont utilisées.
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { config } from "../config.js";
import { demoStore } from "./demoData.js";
import { getEffectiveKubernetesConfig } from "./setupStore.js";
import { withTimeout } from "../utils/async.js";
import type { ClusterNode, ContainerRef, Environment } from "../types.js";

const API_TIMEOUT_MS = 3000;

/**
 * true si Kubernetes a été explicitement configuré (assistant ou KUBECONFIG) — PAS juste "un
 * contexte par défaut existe sur la machine". Distinction importante : `loadFromDefault()`
 * réussit souvent même sans intention réelle d'utiliser Kubernetes ici (ex: contexte Docker
 * Desktop local présent), ce qui déclenchait un repli sur les données de démonstration
 * (environnement "Staging" fictif) mélangé aux vraies données Docker dans /api/environments
 * et /api/containers — alors même que l'assistant de configuration marque
 * `kubernetesConfigured: false`. Voir getKubernetesEnvironment/getKubernetesContainers.
 */
export async function isKubernetesConfigured(): Promise<boolean> {
  const effective = await getEffectiveKubernetesConfig();
  return Boolean(effective.kubeconfigYaml) || Boolean(config.kubernetes.kubeconfig);
}

/**
 * Charge la config effective : le kubeconfig YAML collé dans l'assistant si persisté
 * (voir setupStore.ts#getEffectiveKubernetesConfig — sans ça, un kubeconfig candidat validé
 * dans l'assistant serait sauvegardé mais jamais réellement utilisé), sinon KUBECONFIG
 * (chemin de fichier, mécanisme de bootstrap). N'utilise PLUS la découverte par défaut du SDK
 * (voir isKubernetesConfigured ci-dessus) : appelant censé avoir déjà vérifié
 * isKubernetesConfigured() avant d'appeler cette fonction.
 */
async function loadKubeConfig(): Promise<KubeConfig | null> {
  const kc = new KubeConfig();
  try {
    const effective = await getEffectiveKubernetesConfig();
    if (effective.kubeconfigYaml) {
      kc.loadFromString(effective.kubeconfigYaml);
    } else if (config.kubernetes.kubeconfig) {
      kc.loadFromFile(config.kubernetes.kubeconfig);
    } else {
      return null;
    }
    return kc;
  } catch {
    return null;
  }
}

/**
 * Utilisé par l'assistant de configuration (POST /api/setup/test/kubernetes) : teste un
 * kubeconfig candidat (contenu YAML collé dans l'assistant, pas encore persisté) sans
 * jamais modifier l'état applicatif.
 */
export async function testKubernetesConnection(kubeconfigYaml: string): Promise<{ ok: boolean; message: string; nodeCount?: number }> {
  const kc = new KubeConfig();
  try {
    kc.loadFromString(kubeconfigYaml);
  } catch (err) {
    return { ok: false, message: `Invalid kubeconfig: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const api = kc.makeApiClient(CoreV1Api);
    const nodeList = await withTimeout(api.listNode(), API_TIMEOUT_MS, "kubernetes listNode");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeItems: any[] = (nodeList as any).items ?? (nodeList as any).body?.items ?? [];
    return { ok: true, message: "Kubernetes cluster is reachable", nodeCount: nodeItems.length };
  } catch (err) {
    return { ok: false, message: `Cluster is not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Sonde de joignabilité légère utilisée par le watchdog (services/watchdog.ts) : true si le
 * cluster configuré via l'assistant (ou KUBECONFIG) répond, false sinon — jamais appelée sans
 * avoir d'abord vérifié isKubernetesConfigured(), sans quoi loadKubeConfig() renverrait `null`
 * et cette fonction retournerait toujours false pour un cluster qui n'a simplement jamais été
 * configuré (pas une vraie coupure à notifier).
 */
export async function isKubernetesReachable(): Promise<boolean> {
  const kc = await loadKubeConfig();
  if (!kc) return false;
  try {
    const api = kc.makeApiClient(CoreV1Api);
    await withTimeout(api.listNode(), API_TIMEOUT_MS, "kubernetes listNode");
    return true;
  } catch {
    return false;
  }
}

function nodeStatusFromConditions(conditions: Array<{ type?: string; status?: string }> | undefined): ClusterNode["status"] {
  const ready = conditions?.find((c) => c.type === "Ready");
  if (!ready || ready.status !== "True") return "crit";
  const pressureConditions = conditions?.filter(
    (c) => c.type && ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type),
  );
  const underPressure = pressureConditions?.some((c) => c.status === "True");
  return underPressure ? "warn" : "ok";
}

function parseKubeQuantityToCores(quantity: string | undefined): number {
  if (!quantity) return 0;
  if (quantity.endsWith("m")) return Number.parseFloat(quantity) / 1000;
  return Number.parseFloat(quantity);
}

/**
 * Récupère l'environnement Kubernetes (Staging) avec ses nœuds réels. `null` si Kubernetes
 * n'a jamais été configuré (pas de "Staging" fictif mélangé aux vrais environnements Docker
 * dans ce cas — voir isKubernetesConfigured) ; repli sur le jeu de données de démonstration
 * uniquement si Kubernetes EST configuré mais transitoirement injoignable.
 */
export async function getKubernetesEnvironment(): Promise<Environment | null> {
  if (!(await isKubernetesConfigured())) return null;

  const demoFallback = demoStore.environments.find((e) => e.orchestrator === "kubernetes");
  if (!demoFallback) {
    throw new Error("demo dataset is missing a kubernetes environment");
  }

  const kc = await loadKubeConfig();
  if (!kc) return demoFallback;

  try {
    const api = kc.makeApiClient(CoreV1Api);
    const [nodeList, podList] = await Promise.all([
      withTimeout(api.listNode(), API_TIMEOUT_MS, "kubernetes listNode"),
      withTimeout(api.listPodForAllNamespaces(), API_TIMEOUT_MS, "kubernetes listPodForAllNamespaces"),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeItems: any[] = (nodeList as any).items ?? (nodeList as any).body?.items ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const podItems: any[] = (podList as any).items ?? (podList as any).body?.items ?? [];

    const nodes: ClusterNode[] = nodeItems.map((n) => {
      const nodeName: string = n.metadata?.name ?? "unknown-node";
      const isControlPlane =
        "node-role.kubernetes.io/control-plane" in (n.metadata?.labels ?? {}) ||
        "node-role.kubernetes.io/master" in (n.metadata?.labels ?? {});
      const allocatableCpu = parseKubeQuantityToCores(n.status?.allocatable?.cpu);
      const podsOnNode = podItems.filter((p) => p.spec?.nodeName === nodeName);

      return {
        id: nodeName,
        environmentId: "staging-k8s",
        role: isControlPlane ? "control-plane" : "worker",
        // dockerode-like %CPU/mem par nœud nécessite l'API metrics-server (non garantie
        // disponible) : on expose ici une estimation basée sur le nombre de pods planifiés
        // vs la capacité allocable, à défaut de métriques temps réel.
        cpuPercent: allocatableCpu > 0 ? Math.min(100, Math.round((podsOnNode.length / (allocatableCpu * 10)) * 100)) : 0,
        memPercent: 0,
        status: nodeStatusFromConditions(n.status?.conditions),
        containerCount: podsOnNode.reduce((sum, p) => sum + (p.spec?.containers?.length ?? 0), 0),
      };
    });

    return {
      id: "staging-k8s",
      name: "Staging",
      orchestrator: "kubernetes",
      status: nodes.every((n) => n.status === "ok") ? "ok" : "warn",
      nodes,
    };
  } catch {
    return demoFallback;
  }
}

/**
 * Mappe les pods du cluster Staging en ContainerRef — [] si Kubernetes n'a jamais été
 * configuré (pas de faux pods "Staging" mélangés aux vrais conteneurs Docker dans les totaux,
 * voir isKubernetesConfigured) ; repli démo seulement si configuré mais injoignable.
 */
export async function getKubernetesContainers(): Promise<ContainerRef[]> {
  if (!(await isKubernetesConfigured())) return [];

  const demoFallback = demoStore.containers.filter((c) => c.environment === "Staging");

  const kc = await loadKubeConfig();
  if (!kc) return demoFallback;

  try {
    const api = kc.makeApiClient(CoreV1Api);
    const podList = await withTimeout(api.listPodForAllNamespaces(), API_TIMEOUT_MS, "kubernetes listPodForAllNamespaces");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const podItems: any[] = (podList as any).items ?? (podList as any).body?.items ?? [];

    return podItems.map((p): ContainerRef => {
      const phase: string = p.status?.phase ?? "Unknown";
      const state: ContainerRef["state"] = phase === "Running" ? "running" : phase === "Pending" ? "restarting" : "stopped";
      return {
        id: p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`,
        name: p.metadata?.name ?? "unknown-pod",
        image: p.spec?.containers?.[0]?.image ?? "unknown",
        environment: "Staging",
        node: p.spec?.nodeName ?? "unknown-node",
        state,
        cpuPercent: 0, // nécessiterait metrics-server ; non garanti disponible
        memBytes: 0,
      };
    });
  } catch {
    return demoFallback;
  }
}
