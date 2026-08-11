/**
 * Assistant de configuration au premier lancement (cf. ARCHITECTURE.md).
 *
 * GET  /api/setup/status         — état courant (completed + ce qui est déjà configuré).
 * POST /api/setup/test/ldap      — teste une config LDAP candidate (body, pas persisté).
 * POST /api/setup/test/docker    — teste un hôte Docker candidat.
 * POST /api/setup/test/kubernetes— teste un kubeconfig candidat (contenu YAML collé).
 * POST /api/setup/test/nutanix   — teste une config Prism Central candidate (URL + identifiants).
 * POST /api/setup/test/registry  — teste un registry candidat.
 * POST /api/setup/complete       — persiste la config et marque l'assistant terminé.
 * POST /api/setup/reset          — repasse en mode assistant (admin authentifié requis,
 *                                   appliqué par le hook global, cf. src/plugins/auth.ts).
 *
 * Ces routes sont ouvertes tant que `completed=false` ; une fois terminées, elles exigent
 * une session admin (403 sinon) — logique implémentée dans le hook global, pas ici.
 */

import type { FastifyInstance } from "fastify";
import { testDockerConnection } from "../services/docker.js";
import { testKubernetesConnection } from "../services/kubernetes.js";
import { testLdapConnection } from "../services/ldap.js";
import { testNutanixConnection } from "../services/nutanix.js";
import { testRegistryConnection } from "../services/registries/index.js";
import { completeSetup, getCurrent, resetSetup } from "../services/setupStore.js";
import type { SetupCandidate } from "../services/setupStore.js";
import type { RegistryKind } from "../types.js";

const VALID_KINDS: readonly RegistryKind[] = ["dockerhub", "ghcr", "gitlab", "harbor"];

interface LdapTestBody {
  url?: string;
  bindDn?: string;
  bindPassword?: string;
  searchBase?: string;
  searchFilter?: string;
  testUsername?: string;
  testPassword?: string;
}

interface DockerTestBody {
  host?: string;
}

interface KubernetesTestBody {
  kubeconfigYaml?: string;
}

interface NutanixTestBody {
  prismCentralUrl?: string;
  username?: string;
  password?: string;
}

interface RegistryTestBody {
  kind?: string;
  url?: string;
  token?: string;
}

export default async function setupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/setup/status", async (_request, reply) => {
    const current = await getCurrent();
    return reply.send({
      completed: current.completed,
      ldapConfigured: current.ldap !== undefined,
      dockerConfigured: current.docker?.host !== undefined,
      kubernetesConfigured: current.kubernetes?.kubeconfigYaml !== undefined,
      nutanixConfigured: current.nutanix !== undefined,
      registries: current.registries ?? [],
    });
  });

  fastify.post<{ Body: LdapTestBody }>("/api/setup/test/ldap", async (request, reply) => {
    const { url, bindDn, bindPassword, searchBase, searchFilter, testUsername, testPassword } = request.body ?? {};
    if (!url || !bindDn || !bindPassword || !searchBase || !searchFilter) {
      return reply.code(400).send({ error: "url, bindDn, bindPassword, searchBase and searchFilter are required" });
    }
    const result = await testLdapConnection({
      url,
      bindDn,
      bindPassword,
      searchBase,
      searchFilter,
      ...(testUsername !== undefined ? { testUsername } : {}),
      ...(testPassword !== undefined ? { testPassword } : {}),
    });
    return reply.send(result);
  });

  fastify.post<{ Body: DockerTestBody }>("/api/setup/test/docker", async (request, reply) => {
    const result = await testDockerConnection(request.body?.host);
    return reply.send(result);
  });

  fastify.post<{ Body: KubernetesTestBody }>("/api/setup/test/kubernetes", async (request, reply) => {
    const { kubeconfigYaml } = request.body ?? {};
    if (!kubeconfigYaml) {
      return reply.code(400).send({ error: "kubeconfigYaml is required" });
    }
    const result = await testKubernetesConnection(kubeconfigYaml);
    return reply.send(result);
  });

  fastify.post<{ Body: NutanixTestBody }>("/api/setup/test/nutanix", async (request, reply) => {
    const { prismCentralUrl, username, password } = request.body ?? {};
    if (!prismCentralUrl || !username || !password) {
      return reply.code(400).send({ error: "prismCentralUrl, username and password are required" });
    }
    const result = await testNutanixConnection(prismCentralUrl, username, password);
    return reply.send(result);
  });

  fastify.post<{ Body: RegistryTestBody }>("/api/setup/test/registry", async (request, reply) => {
    const { kind, url, token } = request.body ?? {};
    if (!kind || !url) {
      return reply.code(400).send({ error: "kind and url are required" });
    }
    if (!VALID_KINDS.includes(kind as RegistryKind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` });
    }
    const result = await testRegistryConnection(kind as RegistryKind, url, token);
    return reply.send(result);
  });

  fastify.post<{ Body: SetupCandidate }>("/api/setup/complete", async (request, reply) => {
    const candidate = request.body;
    if (!candidate?.ldap) {
      return reply.code(400).send({ error: "ldap configuration is required to complete setup" });
    }
    const saved = await completeSetup(candidate);
    // Les registries envoyés sont déjà persistés par completeSetup() ci-dessus (une seule
    // source de vérité, config.json — voir registriesStore.ts) : pas besoin de les recopier
    // dans un store séparé.
    return reply.send(saved);
  });

  fastify.post("/api/setup/reset", async (_request, reply) => {
    const saved = await resetSetup();
    return reply.send(saved);
  });
}
