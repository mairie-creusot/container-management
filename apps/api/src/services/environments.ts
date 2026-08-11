/**
 * Agrège les environnements pilotés par Docker/Swarm (src/services/docker.ts), celui piloté
 * par Kubernetes (src/services/kubernetes.ts), celui piloté par Nutanix
 * (src/services/nutanix.ts), les environnements Docker distants persistés
 * (src/services/remoteDockerStore.ts) et celui piloté par LXD (src/services/lxc.ts) en une
 * seule liste, telle qu'exposée par GET /api/environments.
 */

import { getDockerEnvironments, getDockerHostInfo } from "./docker.js";
import { getKubernetesEnvironment } from "./kubernetes.js";
import { getNutanixEnvironment } from "./nutanix.js";
import { getLxcEnvironment } from "./lxc.js";
import { listRemoteDockerEnvironments } from "./remoteDockerStore.js";
import type { Environment } from "../types.js";

/**
 * Un nœud "environnement" par hôte Docker distant persisté (cf. ARCHITECTURE.md § "Environnements
 * Docker distants") — `status: "warn"` (pas d'erreur bloquante) si l'hôte est injoignable ou pas
 * encore testé, `hostInfo` présent seulement s'il a effectivement répondu (jamais de valeurs
 * inventées). `nodes: []` : contrairement à Swarm/Kubernetes, un hôte Docker distant standalone
 * n'a pas de notion de "nœud" propre — le compteur de conteneurs est déjà dans `hostInfo`.
 */
async function getRemoteDockerEnvironments(): Promise<Environment[]> {
  const refs = await listRemoteDockerEnvironments();
  return Promise.all(
    refs.map(async (ref): Promise<Environment> => {
      const hostInfo = await getDockerHostInfo(ref.id);
      return {
        id: `remote-docker:${ref.id}`,
        name: ref.name,
        orchestrator: "docker-remote",
        status: hostInfo ? "ok" : "warn",
        nodes: [],
        ...(hostInfo ? { hostInfo } : {}),
      };
    }),
  );
}

export async function getAllEnvironments(): Promise<Environment[]> {
  const [dockerEnvironments, kubernetesEnvironment, nutanixEnvironment, remoteDockerEnvironments, lxcEnvironment] =
    await Promise.all([
      getDockerEnvironments(),
      getKubernetesEnvironment(),
      getNutanixEnvironment(),
      getRemoteDockerEnvironments(),
      getLxcEnvironment(),
    ]);
  // null si Kubernetes/Nutanix/LXC n'a jamais été configuré (voir
  // kubernetes.ts#isKubernetesConfigured / nutanix.ts#isNutanixConfigured / lxc.ts#isLxcConfigured)
  // — pas d'environnement fictif dans ce cas, jamais mélangé aux vraies données.
  const withKubernetes = kubernetesEnvironment ? [...dockerEnvironments, kubernetesEnvironment] : dockerEnvironments;
  const withNutanix = nutanixEnvironment ? [...withKubernetes, nutanixEnvironment] : withKubernetes;
  const withRemoteDocker = [...withNutanix, ...remoteDockerEnvironments];
  return lxcEnvironment ? [...withRemoteDocker, lxcEnvironment] : withRemoteDocker;
}
