/**
 * Assistant de configuration au premier lancement (cf. ARCHITECTURE.md).
 *
 * GET  /api/setup/status         — état courant (completed + ce qui est déjà configuré).
 * POST /api/setup/test/ldap      — teste une config LDAP candidate (body, pas persisté).
 * PUT  /api/setup/ldap           — corrige l'annuaire APRÈS l'assistant, sans toucher au reste.
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
import { completeSetup, getCurrent, getEffectiveLdapConfig, resetSetup, setLdapConfig } from "../services/setupStore.js";
import type { SetupLdapConfig } from "../services/setupStore.js";
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
    // Ouvert à TOUTE session authentifiée (voir plugins/auth.ts) — le commentaire d'origine
    // promettait « aucun secret », mais `registries: current.registries ?? []` renvoyait bel et
    // bien le tableau complet (username en clair, password/token chiffrés mais présents), alors
    // que ce endpoint ne sert qu'à savoir quoi afficher dans l'UI (booléens, comme les autres
    // champs `xConfigured` ci-dessous). Remplacé par un simple booléen, cohérent avec le reste de
    // cette réponse — le frontend (apps/web/src/features/setup/setupSlice.ts) ne consommait de
    // toute façon que `completed` — voir docs/reports/security-audit-2026-08-12.md, finding M5.
    return reply.send({
      completed: current.completed,
      ldapConfigured: current.ldap !== undefined,
      dockerConfigured: current.docker?.host !== undefined,
      kubernetesConfigured: current.kubernetes?.kubeconfigYaml !== undefined,
      nutanixConfigured: current.nutanix !== undefined,
      registriesConfigured: (current.registries?.length ?? 0) > 0,
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

  /**
   * Corrige l'annuaire APRÈS l'assistant sans toucher au reste — indispensable pour changer un
   * mapping de rôle : `POST /api/setup/complete` REMPLACE toute la configuration et effacerait les
   * intégrations déjà en place (Nutanix, registries…). La connexion est réellement testée avant
   * d'être persistée, comme pour toutes les autres intégrations. Mot de passe vide = on garde
   * l'existant.
   */
  fastify.put<{ Body: Partial<SetupLdapConfig> }>("/api/setup/ldap", async (request, reply) => {
    const body = request.body ?? {};
    const missing = (["url", "bindDn", "searchBase", "searchFilter"] as const).filter((k) => !body[k]?.trim());
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Champs requis manquants : ${missing.join(", ")}` });
    }
    const current = await getCurrent();
    if (!body.bindPassword?.trim() && !current.ldap?.bindPassword) {
      return reply.code(400).send({ error: "bindPassword is required (aucun mot de passe déjà enregistré)" });
    }
    const candidate: SetupLdapConfig = {
      url: body.url!.trim(),
      bindDn: body.bindDn!.trim(),
      bindPassword: body.bindPassword?.trim() ? body.bindPassword : "",
      searchBase: body.searchBase!.trim(),
      searchFilter: body.searchFilter!.trim(),
      groupRoleMap: body.groupRoleMap ?? {},
      defaultRole: body.defaultRole ?? "viewer",
    };
    // Test réel avec le mot de passe effectif (celui fourni, sinon celui déjà enregistré).
    const effective = await getEffectiveLdapConfig();
    const test = await testLdapConnection({ ...candidate, bindPassword: candidate.bindPassword || effective.bindPassword });
    if (!test.ok) {
      return reply.code(400).send({ error: `Connexion LDAP refusée, rien n'a été enregistré : ${test.message}` });
    }
    await setLdapConfig(candidate);
    return reply.send({ ok: true, message: test.message });
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
