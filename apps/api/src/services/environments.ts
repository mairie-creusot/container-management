/**
 * Agrège les environnements pilotés par Docker/Swarm (src/services/docker.ts), celui piloté
 * par Kubernetes (src/services/kubernetes.ts) et celui piloté par Nutanix
 * (src/services/nutanix.ts) en une seule liste, telle qu'exposée par GET /api/environments.
 */

import { getDockerEnvironments } from "./docker.js";
import { getKubernetesEnvironment } from "./kubernetes.js";
import { getNutanixEnvironment } from "./nutanix.js";
import type { Environment } from "../types.js";

export async function getAllEnvironments(): Promise<Environment[]> {
  const [dockerEnvironments, kubernetesEnvironment, nutanixEnvironment] = await Promise.all([
    getDockerEnvironments(),
    getKubernetesEnvironment(),
    getNutanixEnvironment(),
  ]);
  // null si Kubernetes/Nutanix n'a jamais été configuré (voir
  // kubernetes.ts#isKubernetesConfigured / nutanix.ts#isNutanixConfigured) — pas
  // d'environnement fictif dans ce cas, jamais mélangé aux vraies données.
  const withKubernetes = kubernetesEnvironment ? [...dockerEnvironments, kubernetesEnvironment] : dockerEnvironments;
  return nutanixEnvironment ? [...withKubernetes, nutanixEnvironment] : withKubernetes;
}
