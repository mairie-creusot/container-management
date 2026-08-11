/**
 * Lecture typée des variables d'environnement, avec valeurs par défaut sûres pour le
 * développement local. Voir .env.example pour la liste documentée de toutes les variables.
 *
 * Aucune valeur secrète n'est codée en dur pour un usage production : les défauts fournis
 * ici (JWT_SECRET, identifiants LDAP de démo, ...) sont volontairement non-sécurisés et
 * doivent être remplacés via l'environnement avant tout déploiement réel.
 */

export type Role = "admin" | "operator" | "viewer";

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function readGroupRoleMap(name: string): Record<string, Role> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, Role> = {};
    for (const [groupDn, role] of Object.entries(parsed as Record<string, unknown>)) {
      if (role === "admin" || role === "operator" || role === "viewer") {
        result[groupDn.toLowerCase()] = role;
      }
    }
    return result;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[config] LDAP_GROUP_ROLE_MAP is not valid JSON, ignoring it`);
    return {};
  }
}

function readDefaultRole(name: string, fallback: Role): Role {
  const raw = process.env[name];
  if (raw === "admin" || raw === "operator" || raw === "viewer") return raw;
  return fallback;
}

export const config = {
  server: {
    port: readNumber("PORT", 3000),
    nodeEnv: readString("NODE_ENV", "development"),
    logLevel: readString("LOG_LEVEL", "info"),
    corsOrigin: readString("CORS_ORIGIN", "http://localhost:5173"),
  },
  session: {
    jwtSecret: readString("JWT_SECRET", "dev-insecure-secret-change-me"),
    jwtExpiresIn: readString("JWT_EXPIRES_IN", "15m"),
    jwtRefreshExpiresIn: readString("JWT_REFRESH_EXPIRES_IN", "7d"),
    cookieName: readString("COOKIE_NAME", "quai_session"),
    cookieSecure: readBoolean("COOKIE_SECURE", false),
  },
  ldap: {
    url: readString("LDAP_URL", "ldap://localhost:389"),
    bindDn: readString("LDAP_BIND_DN", "cn=admin,dc=lecreusot,dc=fr"),
    bindPassword: readString("LDAP_BIND_PASSWORD", "admin"),
    searchBase: readString("LDAP_SEARCH_BASE", "ou=people,dc=lecreusot,dc=fr"),
    searchFilter: readString("LDAP_SEARCH_FILTER", "(uid={{username}})"),
    groupRoleMap: readGroupRoleMap("LDAP_GROUP_ROLE_MAP"),
    defaultRole: readDefaultRole("LDAP_DEFAULT_ROLE", "viewer"),
  },
  docker: {
    host: readOptionalString("DOCKER_HOST"),
  },
  kubernetes: {
    kubeconfig: readOptionalString("KUBECONFIG"),
  },
  nutanix: {
    // Prism Central utilise très souvent un certificat TLS auto-signé en déploiement on-prem
    // (pas d'autorité de certification publique) : par défaut on ne vérifie pas la chaîne de
    // confiance pour CETTE intégration spécifique (aucun impact sur le reste du process,
    // contrairement à NODE_TLS_REJECT_UNAUTHORIZED=0 qui désactiverait la vérification TLS
    // globalement). Mettre à `true` si Prism Central présente un certificat signé par une CA
    // de confiance.
    tlsRejectUnauthorized: readBoolean("NUTANIX_TLS_REJECT_UNAUTHORIZED", false),
    requestTimeoutMs: readNumber("NUTANIX_REQUEST_TIMEOUT_MS", 8000),
  },
  registries: {
    requestTimeoutMs: readNumber("REGISTRY_REQUEST_TIMEOUT_MS", 5000),
    dockerhub: {
      username: readOptionalString("DOCKERHUB_USERNAME"),
      token: readOptionalString("DOCKERHUB_TOKEN"),
    },
    ghcr: {
      token: readOptionalString("GHCR_TOKEN"),
    },
    gitlab: {
      token: readOptionalString("GITLAB_TOKEN"),
    },
  },
  gitops: {
    repoPath: readString("GITOPS_REPO_PATH", "./data/gitops"),
    repoUrl: readOptionalString("GITOPS_REPO_URL"),
    branch: readString("GITOPS_BRANCH", "main"),
    gitUsername: readOptionalString("GITOPS_GIT_USERNAME"),
    gitToken: readOptionalString("GITOPS_GIT_TOKEN"),
  },
  setup: {
    // Persistance de l'assistant de configuration au premier lancement (cf. ARCHITECTURE.md,
    // chapitre "Assistant de configuration au premier lancement"). Défaut dev : fichier local
    // ; en conteneur, pointer vers un volume monté (ex: /data/quai/config.json).
    configPath: readString("CONFIG_PATH", "./data/config.json"),
  },
  secrets: {
    // Persistance du gestionnaire de secrets nommés (cf. ARCHITECTURE.md, chapitre "Gestionnaire
    // de secrets"). Même répertoire que CONFIG_PATH par défaut, fichier séparé — les valeurs
    // sont chiffrées au repos (crypto.ts) avant écriture, comme le reste des secrets persistés.
    storePath: readString("SECRETS_PATH", "./data/secrets.json"),
  },
  remoteDocker: {
    // Persistance des environnements Docker distants (cf. ARCHITECTURE.md, chapitre
    // "Environnements Docker distants"). Même pattern que secrets.json : fichier JSON séparé,
    // identifiants TLS (ca/cert/key) chiffrés au repos (crypto.ts) avant écriture.
    storePath: readString("REMOTE_DOCKER_PATH", "./data/remote-docker.json"),
  },
  lxc: {
    // Persistance de la config LXD (cf. ARCHITECTURE.md, chapitre "Support LXC (via LXD)").
    // Même pattern que remoteDocker ci-dessus : un seul endpoint LXD, certificat client
    // chiffré au repos.
    storePath: readString("LXC_PATH", "./data/lxc.json"),
    // LXD présente très souvent un certificat auto-signé (généré à l'installation) : même
    // principe que nutanix.tlsRejectUnauthorized ci-dessus, limité à cette intégration.
    tlsRejectUnauthorized: readBoolean("LXC_TLS_REJECT_UNAUTHORIZED", false),
    requestTimeoutMs: readNumber("LXC_REQUEST_TIMEOUT_MS", 8000),
  },
  reverseProxy: {
    // Persistance des routes du reverse proxy interne (cf. ARCHITECTURE.md, chapitre "Reverse
    // proxy interne"). Même répertoire/pattern que secrets.json — aucune valeur sensible dans
    // une route, donc pas de chiffrement au repos ici.
    storePath: readString("REVERSE_PROXY_PATH", "./data/reverse-proxy.json"),
    // API d'administration JSON de Caddy (https://caddyserver.com/docs/api), jamais exposée à
    // l'hôte — jointe par son nom de service docker-compose (voir deploy/compose/docker-compose.dev.yml).
    caddyAdminUrl: readString("CADDY_ADMIN_URL", "http://caddy:2019"),
    requestTimeoutMs: readNumber("CADDY_REQUEST_TIMEOUT_MS", 5000),
  },
} as const;

export type Config = typeof config;
