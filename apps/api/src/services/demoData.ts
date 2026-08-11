/**
 * Jeu de données de démonstration en mémoire.
 *
 * IMPORTANT — ceci est un FALLBACK DE DÉVELOPPEMENT, pas un mock permanent :
 * il n'est utilisé que lorsque les intégrations réelles (Docker Engine/Swarm via dockerode,
 * Kubernetes via @kubernetes/client-node, registries publics) sont indisponibles ou non
 * configurées (pas de DOCKER_HOST/socket joignable, pas de KUBECONFIG valide, pas de réseau).
 * Voir src/services/docker.ts et src/services/kubernetes.ts pour la bascule.
 *
 * Les données reprennent exactement le prototype validé (cf. ARCHITECTURE.md) :
 * - Environnements : Prod/Swarm (3 nœuds), Staging/Kubernetes (5 nœuds dont un "crit"),
 *   Dev local/Compose (1 nœud).
 * - Images : nginx, ghcr.io/ville-lecreusot/portail-citoyen, postgres,
 *   registry.gitlab.com/mairie/api-etat-civil, redis, ghcr.io/ville-lecreusot/keycloak-theme.
 */

import type {
  ClusterNode,
  ContainerRef,
  Environment,
  GitCommit,
  GitOpsFile,
  ImageRef,
  Registry,
} from "../types.js";

function buildEnvironments(): Environment[] {
  const prodNodes: ClusterNode[] = [
    { id: "prod-mgr-1", environmentId: "prod-swarm", role: "manager", cpuPercent: 34, memPercent: 52, status: "ok", containerCount: 8 },
    { id: "prod-wrk-1", environmentId: "prod-swarm", role: "worker", cpuPercent: 61, memPercent: 70, status: "ok", containerCount: 11 },
    { id: "prod-wrk-2", environmentId: "prod-swarm", role: "worker", cpuPercent: 45, memPercent: 58, status: "warn", containerCount: 9 },
  ];

  const stagingNodes: ClusterNode[] = [
    { id: "staging-cp-1", environmentId: "staging-k8s", role: "control-plane", cpuPercent: 22, memPercent: 40, status: "ok", containerCount: 6 },
    { id: "staging-wrk-1", environmentId: "staging-k8s", role: "worker", cpuPercent: 55, memPercent: 63, status: "ok", containerCount: 10 },
    { id: "staging-wrk-2", environmentId: "staging-k8s", role: "worker", cpuPercent: 48, memPercent: 71, status: "warn", containerCount: 7 },
    { id: "staging-wrk-3", environmentId: "staging-k8s", role: "worker", cpuPercent: 91, memPercent: 94, status: "crit", containerCount: 14 },
    { id: "staging-wrk-4", environmentId: "staging-k8s", role: "worker", cpuPercent: 37, memPercent: 49, status: "ok", containerCount: 5 },
  ];

  const devNodes: ClusterNode[] = [
    { id: "dev-local-1", environmentId: "dev-compose", role: "standalone", cpuPercent: 18, memPercent: 33, status: "ok", containerCount: 4 },
  ];

  return [
    { id: "prod-swarm", name: "Prod", orchestrator: "swarm", status: "warn", nodes: prodNodes },
    { id: "staging-k8s", name: "Staging", orchestrator: "kubernetes", status: "warn", nodes: stagingNodes },
    { id: "dev-compose", name: "Dev local", orchestrator: "compose", status: "ok", nodes: devNodes },
  ];
}

function buildImages(): ImageRef[] {
  return [
    {
      id: "img-nginx",
      name: "nginx",
      registry: "dockerhub",
      currentTag: "1.25.3",
      latestTag: "1.27.1",
      environment: "Prod",
      status: "update",
      digest: "sha256:8f3a3e6b1e0f3f2c9d4a5b6e7c8d9f0a1b2c3d4e5f60718293a4b5c6d7e8f901",
      sizeBytes: 187_000_000,
      layers: 7,
    },
    {
      id: "img-portail-citoyen",
      name: "ghcr.io/ville-lecreusot/portail-citoyen",
      registry: "ghcr",
      currentTag: "2.4.0",
      latestTag: "2.4.0",
      environment: "Prod",
      status: "uptodate",
      digest: "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      sizeBytes: 412_000_000,
      layers: 14,
    },
    {
      id: "img-postgres",
      name: "postgres",
      registry: "dockerhub",
      currentTag: "15.4",
      latestTag: "16.4",
      environment: "Staging",
      status: "update",
      digest: "sha256:2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
      sizeBytes: 379_000_000,
      layers: 11,
    },
    {
      id: "img-api-etat-civil",
      name: "registry.gitlab.com/mairie/api-etat-civil",
      registry: "gitlab",
      currentTag: "0.9.2",
      latestTag: "0.10.0",
      environment: "Staging",
      status: "update",
      digest: "sha256:3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2",
      sizeBytes: 96_000_000,
      layers: 9,
    },
    {
      id: "img-redis",
      name: "redis",
      registry: "dockerhub",
      currentTag: "7.2.5",
      latestTag: "7.2.5",
      environment: "Dev local",
      status: "uptodate",
      digest: "sha256:4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3",
      sizeBytes: 45_000_000,
      layers: 5,
    },
    {
      id: "img-keycloak-theme",
      name: "ghcr.io/ville-lecreusot/keycloak-theme",
      registry: "ghcr",
      currentTag: "1.2.1",
      latestTag: "1.3.0",
      environment: "Staging",
      status: "update",
      digest: "sha256:5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4",
      sizeBytes: 210_000_000,
      layers: 8,
    },
  ];
}

function buildRegistries(): Registry[] {
  return [
    {
      id: "reg-dockerhub",
      kind: "dockerhub",
      name: "Docker Hub",
      url: "https://hub.docker.com",
      status: "connected",
      trackedImages: 3,
      lastSyncAt: "2026-08-10T07:12:00.000Z",
    },
    {
      id: "reg-ghcr",
      kind: "ghcr",
      name: "GitHub Container Registry",
      url: "https://ghcr.io",
      status: "connected",
      trackedImages: 2,
      lastSyncAt: "2026-08-10T07:10:00.000Z",
    },
    {
      id: "reg-gitlab",
      kind: "gitlab",
      name: "GitLab Registry — Mairie",
      url: "https://registry.gitlab.com",
      status: "connected",
      trackedImages: 1,
      lastSyncAt: "2026-08-10T07:08:00.000Z",
    },
    {
      id: "reg-harbor",
      kind: "harbor",
      name: "Harbor interne",
      url: "https://harbor.lecreusot.fr",
      status: "unconfigured",
      trackedImages: 0,
      lastSyncAt: null,
    },
  ];
}

function buildContainers(): ContainerRef[] {
  return [
    { id: "cnt-nginx-1", name: "nginx_front_1", image: "nginx:1.25.3", environment: "Prod", node: "prod-mgr-1", state: "running", cpuPercent: 12.4, memBytes: 96_000_000 },
    { id: "cnt-portail-1", name: "portail-citoyen_web_1", image: "ghcr.io/ville-lecreusot/portail-citoyen:2.4.0", environment: "Prod", node: "prod-wrk-1", state: "running", cpuPercent: 28.7, memBytes: 340_000_000 },
    { id: "cnt-portail-2", name: "portail-citoyen_web_2", image: "ghcr.io/ville-lecreusot/portail-citoyen:2.4.0", environment: "Prod", node: "prod-wrk-2", state: "restarting", cpuPercent: 4.1, memBytes: 128_000_000 },
    { id: "cnt-postgres-staging", name: "postgres_db_1", image: "postgres:15.4", environment: "Staging", node: "staging-wrk-1", state: "running", cpuPercent: 33.9, memBytes: 512_000_000 },
    { id: "cnt-api-etat-civil", name: "api-etat-civil_1", image: "registry.gitlab.com/mairie/api-etat-civil:0.9.2", environment: "Staging", node: "staging-wrk-3", state: "running", cpuPercent: 71.2, memBytes: 640_000_000 },
    { id: "cnt-keycloak-theme", name: "keycloak-theme_1", image: "ghcr.io/ville-lecreusot/keycloak-theme:1.2.1", environment: "Staging", node: "staging-wrk-2", state: "stopped", cpuPercent: 0, memBytes: 0 },
    { id: "cnt-redis-dev", name: "redis_cache_1", image: "redis:7.2.5", environment: "Dev local", node: "dev-local-1", state: "running", cpuPercent: 2.3, memBytes: 32_000_000 },
  ];
}

function buildGitOpsFiles(): GitOpsFile[] {
  const nginxDesired = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nginx-front\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: nginx\n          image: nginx:1.27.1\n`;
  const nginxActual = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nginx-front\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: nginx\n          image: nginx:1.25.3\n`;

  const apiEtatCivilDesired = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-etat-civil\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: api-etat-civil\n          image: registry.gitlab.com/mairie/api-etat-civil:0.10.0\n`;
  const apiEtatCivilActual = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-etat-civil\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: api-etat-civil\n          image: registry.gitlab.com/mairie/api-etat-civil:0.9.2\n`;

  const redisDesired = `version: "3.8"\nservices:\n  redis:\n    image: redis:7.2.5\n    ports:\n      - "6379:6379"\n`;
  const redisActual = redisDesired;

  return [
    { path: "prod/nginx.yaml", desiredManifest: nginxDesired, actualManifest: nginxActual, drift: true },
    { path: "staging/api-etat-civil.yaml", desiredManifest: apiEtatCivilDesired, actualManifest: apiEtatCivilActual, drift: true },
    { path: "dev/redis.yaml", desiredManifest: redisDesired, actualManifest: redisActual, drift: false },
  ];
}

function buildCommits(): GitCommit[] {
  return [
    { hash: "a1b2c3d", message: "bump nginx to 1.27.1 in prod", author: "y.banas", date: "2026-08-09T16:20:00.000Z" },
    { hash: "e4f5a6b", message: "bump api-etat-civil to 0.10.0 in staging", author: "s.martin", date: "2026-08-08T09:05:00.000Z" },
    { hash: "c7d8e9f", message: "pin redis 7.2.5 in dev", author: "y.banas", date: "2026-08-01T11:42:00.000Z" },
    { hash: "0a1b2c3", message: "initial GitOps manifests", author: "s.martin", date: "2026-07-20T08:00:00.000Z" },
  ];
}

/**
 * Store en mémoire, réinitialisé à chaque démarrage du process. Les routes de mutation
 * (ex: POST /api/images/:id/update) opèrent sur ce store quand aucune intégration réelle
 * n'est disponible, pour que la démo reste cohérente entre deux appels.
 */
class DemoStore {
  environments: Environment[] = buildEnvironments();
  images: ImageRef[] = buildImages();
  registries: Registry[] = buildRegistries();
  containers: ContainerRef[] = buildContainers();
  gitopsFiles: GitOpsFile[] = buildGitOpsFiles();
  commits: GitCommit[] = buildCommits();

  reset(): void {
    this.environments = buildEnvironments();
    this.images = buildImages();
    this.registries = buildRegistries();
    this.containers = buildContainers();
    this.gitopsFiles = buildGitOpsFiles();
    this.commits = buildCommits();
  }
}

export const demoStore = new DemoStore();
