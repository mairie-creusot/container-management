/**
 * Résout un `environmentId` de querystring (ex: `?environmentId=remote-docker:<uuid>`, forme
 * envoyée par le sélecteur d'environnement du Topbar — voir apps/web/src/components/Topbar.tsx,
 * apps/api/src/services/environments.ts#getRemoteDockerEnvironments) vers l'id brut attendu par
 * services/docker.ts#getClient(remoteEnvironmentId). `undefined` pour tout id qui n'est PAS un
 * environnement Docker distant (environnement local "prod-swarm"/"dev-compose", Kubernetes,
 * Nutanix, LXC, absent...) — dans ce cas l'appelant retombe sur le démon local, comportement
 * inchangé (voir docker.ts#getClient sans argument).
 */
const REMOTE_DOCKER_PREFIX = "remote-docker:";

export function remoteDockerIdFromEnvironmentId(environmentId: string | undefined): string | undefined {
  if (!environmentId || !environmentId.startsWith(REMOTE_DOCKER_PREFIX)) return undefined;
  return environmentId.slice(REMOTE_DOCKER_PREFIX.length) || undefined;
}
