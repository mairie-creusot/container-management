/**
 * Agrège les environnements pilotés par Docker/Swarm (src/services/docker.ts) et celui
 * piloté par Kubernetes (src/services/kubernetes.ts) en une seule liste, telle
 * qu'exposée par GET /api/environments.
 */

import { getDockerEnvironments } from "./docker.js";
import { getKubernetesEnvironment } from "./kubernetes.js";
import type { Environment } from "../types.js";

export async function getAllEnvironments(): Promise<Environment[]> {
  const [dockerEnvironments, kubernetesEnvironment] = await Promise.all([
    getDockerEnvironments(),
    getKubernetesEnvironment(),
  ]);
  // null si Kubernetes n'a jamais été configuré (voir kubernetes.ts#isKubernetesConfigured) —
  // pas d'environnement "Staging" fictif dans ce cas.
  return kubernetesEnvironment ? [...dockerEnvironments, kubernetesEnvironment] : dockerEnvironments;
}
