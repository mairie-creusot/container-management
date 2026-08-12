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
    // Pas de jwtRefreshExpiresIn : aucun flux de refresh token n'existe (code mort supprimé, voir
    // services/session.ts et docs/reports/security-audit-2026-08-12.md, finding I3) — une session
    // expirée force simplement une reconnexion LDAP.
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
    // Délai max accordé à chaque opération Git réseau (clone/fetch/pull) du réconciliateur GitOps
    // (services/gitops.ts#ensureRepoReady, cycle 90s) — même principe que adDns.requestTimeoutMs/
    // nutanix.requestTimeoutMs : `simple-git`/`git` n'a aucun timeout par défaut, un dépôt distant
    // qui ne répond jamais (pare-feu qui droppe les paquets, proxy muet) bloquerait sinon
    // indéfiniment (voir finding É4, docs/reports/optimization-audit-2026-08-12.md).
    requestTimeoutMs: readNumber("GITOPS_GIT_TIMEOUT_MS", 15_000),
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
  adDns: {
    // Mise à jour dynamique sécurisée du DNS Active Directory (RFC 2136 + GSS-TSIG, cf.
    // ARCHITECTURE.md chapitre "DNS Active Directory") — délai max accordé à `kinit` PUIS à
    // `nsupdate -g` (deux appels séquentiels, voir services/adDns.ts), et TTL posé sur chaque
    // enregistrement A créé (court : une route peut changer de cible IP si la machine hôte du
    // reverse proxy change, pas de valeur à faire propager longtemps).
    requestTimeoutMs: readNumber("AD_DNS_TIMEOUT_MS", 10000),
    recordTtlSeconds: readNumber("AD_DNS_RECORD_TTL_SECONDS", 300),
  },
  github: {
    // Intégration GitOps GitHub (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") : jeton
    // (PAT) persisté chiffré au repos, même pattern/répertoire que secrets.json.
    storePath: readString("GITHUB_STORE_PATH", "./data/github.json"),
    apiBaseUrl: readString("GITHUB_API_BASE_URL", "https://api.github.com"),
    // Clone réel (git clone --depth 1) puis build/run réel — timeouts distincts : un clone est
    // rapide (shallow), un build d'image peut prendre plusieurs minutes selon le Dockerfile.
    cloneTimeoutMs: readNumber("GITHUB_CLONE_TIMEOUT_MS", 30_000),
    buildTimeoutMs: readNumber("GITHUB_BUILD_TIMEOUT_MS", 300_000),
  },
  iac: {
    // Délai max accordé à une commande OpenTofu/Ansible/Packer lancée par services/iac/runner.ts
    // (spawn) avant d'être tuée (SIGTERM puis SIGKILL de secours) et le run marqué "failed" —
    // sans ça, un `tofu apply`/`ansible-playbook` qui bloque (attente réseau, provisioner qui
    // hang) tourne indéfiniment, sans aucune route d'annulation pour le rattraper (voir finding
    // M3, docs/reports/security-audit-2026-08-12.md). Généreux par défaut (les scaffolds de
    // démo prennent quelques secondes, un vrai plan/apply peut prendre plusieurs minutes).
    runTimeoutMs: readNumber("IAC_RUN_TIMEOUT_MS", 900_000),
  },
  scan: {
    // Délai max accordé à un scan Grype/OSV-Scanner (services/scan.ts, execFile) — même raison
    // que iac.runTimeoutMs : le téléchargement de la base de vulnérabilités à la première
    // exécution peut être lent, mais doit rester borné plutôt que de tourner indéfiniment (voir
    // finding M3, docs/reports/security-audit-2026-08-12.md). Aligné sur MAX_WAIT_MS déjà utilisé
    // par scanScheduler.ts pour attendre la fin d'un scan automatique (10 min).
    timeoutMs: readNumber("SCAN_TIMEOUT_MS", 600_000),
  },
} as const;

export type Config = typeof config;

/**
 * Échec net au démarrage en production si JWT_SECRET n'a pas été positionné (valeur toujours
 * égale au défaut de développement, committé dans ce dépôt) — même principe que
 * CONFIG_ENCRYPTION_KEY (crypto.ts#requireKey) : sans cette vérification, n'importe qui connaissant
 * ce défaut public peut forger un JWT de session avec le rôle "admin" et prendre le contrôle total
 * d'une instance déployée sans jamais s'authentifier (voir docs/reports/security-audit-2026-08-12.md,
 * finding C2). Volontairement placé ici (chargement du module), pas dans session.ts : la vérification
 * doit bloquer le démarrage du process avant même qu'une route ne puisse être servie.
 */
const INSECURE_DEFAULT_JWT_SECRET = "dev-insecure-secret-change-me";
if (config.server.nodeEnv === "production" && config.session.jwtSecret === INSECURE_DEFAULT_JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is required in production (refusing to start with the default development secret, which is " +
      "committed in this repository and would let anyone forge an admin session token). Generate one with: " +
      "openssl rand -hex 32",
  );
}
