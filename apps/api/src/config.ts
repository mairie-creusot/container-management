/**
 * Lecture typée des variables d'environnement, avec valeurs par défaut sûres pour le
 * développement local. Voir .env.example pour la liste documentée de toutes les variables.
 *
 * Aucune valeur secrète n'est codée en dur pour un usage production : les défauts fournis
 * ici (JWT_SECRET, identifiants LDAP de démo, ...) sont volontairement non-sécurisés et
 * doivent être remplacés via l'environnement avant tout déploiement réel.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Clés PUBLIQUES de confiance pour la signature des modules distribuables — JSON
 * `{ "<identifiant de clé>": "<clé publique>" }`. Une clé PRIVÉE n'a rien à faire ici : le serveur
 * ne signe jamais, il ne fait que vérifier (voir plugins/package.ts et scripts/sign-plugin.mjs).
 * Aucune valeur n'est journalisée, seulement l'identifiant de l'entrée fautive.
 */
function readTrustedPluginKeys(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[config] ${name} n'est pas du JSON valide : aucune clé de confiance retenue`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ${name} doit être un objet { "identifiant": "clé publique" } : aucune clé de confiance retenue`);
    return {};
  }
  const keys: Record<string, string> = {};
  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (value.includes("PRIVATE KEY")) {
      // eslint-disable-next-line no-console
      console.warn(`[config] ${name} : l'entrée "${keyId}" ressemble à une clé privée — ignorée, seule la clé publique se configure ici`);
      continue;
    }
    keys[keyId] = value.trim();
  }
  return keys;
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+?-----END CERTIFICATE-----/g;

/**
 * ANCRES DE CONFIANCE X.509 pour la signature des modules : le certificat RACINE de l'autorité
 * autorisée à habiliter un signataire — l'AD CS de la collectivité. Un module signé par un
 * certificat que cette autorité a émis, portant l'usage « signature de code », est alors accepté
 * sans qu'aucune clé publique de signataire soit connue du serveur : c'est l'autorité qui répond de
 * ses porteurs, et qui peut leur retirer ce droit.
 *
 * Fournies en PEM, directement (PLUGIN_TRUSTED_CA, base64 accepté pour traverser sans dommage une
 * variable de CI) ou par fichier (PLUGIN_TRUSTED_CA_FILE).
 *
 * Volontairement DISTINCT de NODE_EXTRA_CA_CERTS : faire confiance à une autorité pour valider le
 * certificat d'un serveur HTTPS n'est pas lui donner le droit d'habiliter du code qui s'exécutera
 * dans ce processus, avec le socket Docker et la clé de chiffrement. Les deux peuvent désigner la
 * même autorité, mais ce doit être une décision écrite.
 */
function readTrustedCertificateAnchors(): string[] {
  const inline = readOptionalString("PLUGIN_TRUSTED_CA");
  const file = readOptionalString("PLUGIN_TRUSTED_CA_FILE");

  let material = "";
  if (inline !== undefined) {
    material = inline.includes("BEGIN CERTIFICATE") ? inline : Buffer.from(inline, "base64").toString("utf-8");
  } else if (file !== undefined) {
    try {
      material = readFileSync(path.resolve(file), "utf-8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[config] PLUGIN_TRUSTED_CA_FILE illisible (${file}) : ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  if (material.includes("PRIVATE KEY")) {
    // eslint-disable-next-line no-console
    console.warn("[config] PLUGIN_TRUSTED_CA contient une clé privée — ignorée, seuls des certificats se configurent ici");
    return [];
  }
  return material.match(PEM_CERTIFICATE) ?? [];
}

/**
 * Certificats de signature RÉVOQUÉS, par empreinte SHA-256 (celle qu'affiche `certutil` ou la
 * console AD CS), séparées par des virgules, des espaces ou des retours à la ligne.
 *
 * QUAI ne consulte NI liste de révocation NI OCSP : ce serait un appel réseau au moment même où il
 * décide de charger du code, et un échec de cet appel n'aurait aucune réponse honnête. Retirer un
 * signataire se fait donc ici, explicitement — un module signé par un certificat listé cesse d'être
 * chargé au cycle suivant, sans reconstruction d'image.
 */
function readRevokedCertificates(): string[] {
  const raw = readOptionalString("PLUGIN_REVOKED_CERTS");
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const normalized = token.replace(/:/g, "").trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(normalized)) out.push(normalized);
    else if (normalized.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[config] PLUGIN_REVOKED_CERTS : "${token}" n'est pas une empreinte SHA-256 — ignorée`);
    }
  }
  return out;
}

/**
 * Ce qu'on fait d'un certificat de signature qu'aucune liste de révocation à jour ne couvre.
 *  - "off"    : les listes ne sont pas consultées du tout.
 *  - "soft"   : un certificat listé comme révoqué est refusé ; une liste absente ou périmée ne
 *               bloque rien (l'écran le dit). C'est le défaut : sans liste déposée, rien ne change.
 *  - "strict" : un certificat qu'aucune liste à jour ne couvre est refusé lui aussi. À choisir quand
 *               la PKI publie réellement ses listes — la publication devient alors indispensable.
 */
function readCrlPolicy(): "off" | "soft" | "strict" {
  const raw = readOptionalString("PLUGIN_CRL_POLICY")?.toLowerCase();
  if (raw === "off" || raw === "soft" || raw === "strict") return raw;
  if (raw !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[config] PLUGIN_CRL_POLICY inconnue (${raw}) — "soft" appliquée`);
  }
  return "soft";
}

/** URLs des listes de révocation à rapatrier périodiquement. Vide = QUAI ne va rien chercher : les
 * fichiers déposés à la main dans PLUGIN_CRL_PATH restent la seule source. */
function readCrlUrls(): string[] {
  const raw = readOptionalString("PLUGIN_CRL_URLS");
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const url = token.trim();
    if (url.length === 0) continue;
    if (/^https?:\/\//i.test(url)) out.push(url);
    else {
      // eslint-disable-next-line no-console
      console.warn(`[config] PLUGIN_CRL_URLS : "${url}" n'est pas une URL http(s) — ignorée`);
    }
  }
  return out;
}

/** Identifiant réservé de la clé d'ORIGINE : celle qu'un build grave dans l'image pour signer les
 * intégrations livrées avec QUAI. PLUGIN_TRUSTED_KEYS ne peut pas la remplacer. */
export const PLUGIN_ORIGIN_KEY_ID = "quai-origin";

/** Nom du fichier de clé publique d'origine, posé à côté des paquets par scripts/build-origin-plugins.mjs. */
export const PLUGIN_ORIGIN_KEY_FILE = "origin-key.pub";

/**
 * Clé PUBLIQUE d'origine : valeur directe (PLUGIN_ORIGIN_KEY) ou fichier `origin-key.pub` du
 * répertoire des paquets d'origine. Absente hors image : QUAI retombe alors sur son catalogue
 * interne (voir plugins/origin.ts). La clé privée correspondante n'existe plus après le build.
 */
function readOriginPublicKey(originPath: string | undefined): string | undefined {
  const inline = readOptionalString("PLUGIN_ORIGIN_KEY");
  if (inline !== undefined) {
    if (inline.includes("PRIVATE KEY")) {
      // eslint-disable-next-line no-console
      console.warn("[config] PLUGIN_ORIGIN_KEY ressemble à une clé privée — ignorée, seule la clé publique se configure ici");
      return undefined;
    }
    return inline.trim();
  }
  if (originPath === undefined) return undefined;
  try {
    const material = readFileSync(path.join(path.resolve(originPath), PLUGIN_ORIGIN_KEY_FILE), "utf-8").trim();
    return material.length > 0 && !material.includes("PRIVATE KEY") ? material : undefined;
  } catch {
    return undefined;
  }
}

const pluginOriginPath = readOptionalString("PLUGIN_ORIGIN_PATH");
const pluginOriginKey = readOriginPublicKey(pluginOriginPath);

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
  hycu: {
    // L'appliance HYCU (contrôleur de sauvegarde, VM sur le cluster Nutanix) présente un
    // certificat TLS auto-signé en déploiement on-prem — même principe et même périmètre limité
    // que nutanix.tlsRejectUnauthorized ci-dessus, jamais NODE_TLS_REJECT_UNAUTHORIZED global.
    tlsRejectUnauthorized: readBoolean("HYCU_TLS_REJECT_UNAUTHORIZED", false),
    requestTimeoutMs: readNumber("HYCU_REQUEST_TIMEOUT_MS", 8000),
  },
  glpi: {
    // GLPI (apirest.php) — même principe que hycu.requestTimeoutMs : un serveur muet ne doit
    // jamais bloquer indéfiniment une route ou un cycle du moteur d'automatisation.
    requestTimeoutMs: readNumber("GLPI_REQUEST_TIMEOUT_MS", 8000),
    // URL publique de QUAI, utilisée UNIQUEMENT pour le lien de retour ajouté dans un ticket créé
    // automatiquement — non définie = aucune ligne de lien dans le ticket, jamais une URL fabriquée.
    quaiBaseUrl: readOptionalString("QUAI_PUBLIC_URL"),
  },
  threecx: {
    // PBX 3CX (XAPI OData /xapi/v1) — DÉFAUT true, contrairement à Nutanix/HYCU : un 3CX on-prem
    // est publié sous son FQDN 3CX avec un certificat Let's Encrypt valide. Le drapeau réellement
    // utilisé est celui de la config chiffrée (setupStore#SetupThreecxConfig.tlsRejectUnauthorized) ;
    // cette valeur n'est que le défaut quand l'admin ne l'a pas choisi.
    tlsRejectUnauthorized: readBoolean("THREECX_TLS_REJECT_UNAUTHORIZED", true),
    requestTimeoutMs: readNumber("THREECX_REQUEST_TIMEOUT_MS", 8000),
    // Le XAPI n'accepte QU'UN SEUL jeton actif par instance : l'annuaire des postes est mis en
    // cache pour résoudre les noms des interlocuteurs sans réinterroger /Users à chaque poll.
    directoryCacheMs: readNumber("THREECX_DIRECTORY_CACHE_MS", 60_000),
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
  windows: {
    // Agir sur Windows SOUS L'IDENTITÉ de la personne connectée : un ticket Kerberos est obtenu à
    // sa connexion (services/kerberosSession.ts), jamais son mot de passe conservé. Le realm et le
    // KDC viennent de la configuration DNS Active Directory — c'est le même domaine.
    kinitTimeoutMs: readNumber("WINDOWS_KINIT_TIMEOUT_MS", 10_000),
    // Borne que QUAI s'impose : la durée RÉELLE est décidée par le KDC, elle n'est pas devinée ici.
    // Au-delà, le ticket est détruit et la personne doit se reconnecter pour agir sur Windows.
    ticketTtlMs: readNumber("WINDOWS_TICKET_TTL_MS", 8 * 60 * 60 * 1000),
    // WinRM en HTTPS (5986) : en HTTP simple, WinRM exige un chiffrement AU NIVEAU DU MESSAGE que
    // `curl --negotiate` ne sait pas produire — le service refuse alors « unencrypted traffic ».
    winrmPort: readNumber("WINDOWS_WINRM_PORT", 5986),
    winrmTimeoutMs: readNumber("WINDOWS_WINRM_TIMEOUT_MS", 20_000),
    // Autorité interne présentée par les listeners WinRM (la même que le reste du parc).
    caBundlePath: readString("NODE_EXTRA_CA_CERTS", ""),
  },
  setup: {
    // Persistance de l'assistant de configuration au premier lancement (cf. ARCHITECTURE.md,
    // chapitre "Assistant de configuration au premier lancement"). Défaut dev : fichier local
    // ; en conteneur, pointer vers un volume monté (ex: /data/quai/config.json).
    configPath: readString("CONFIG_PATH", "./data/config.json"),
  },
  plugins: {
    // Répertoire d'installation des modules DISTRIBUABLES (cf. ARCHITECTURE.md, chapitre "Modules
    // distribuables"). Non défini = sous-dossier `plugins/` du répertoire de CONFIG_PATH, comme
    // audit-log.jsonl : les modules installés vivent avec les DONNÉES, jamais dans le code livré,
    // pour survivre à une reconstruction d'image et disparaître réellement à la désinstallation.
    installPath: readOptionalString("PLUGINS_PATH"),
    // Répertoire des paquets d'ORIGINE gravés dans l'image (deploy/docker/Dockerfile.api) : les
    // intégrations livrées avec QUAI, empaquetées et signées au build, installées au premier
    // démarrage puis pleinement désinstallables. Non défini = repli sur le catalogue interne
    // importé statiquement (développement, tests) — voir plugins/origin.ts.
    originPath: pluginOriginPath,
    // Renseigné UNIQUEMENT quand une clé d'origine est réellement configurée : c'est ce qui
    // distingue un paquet d'origine d'un module tiers portant le même identifiant.
    originKeyId: pluginOriginKey === undefined ? undefined : PLUGIN_ORIGIN_KEY_ID,
    // Clés publiques autorisées à signer un module. AUCUNE clé configurée = l'installation de
    // modules externes est indisponible ; les greffons livrés avec l'image continuent de tourner.
    // La signature est la SEULE frontière de sécurité : un module installé s'exécute dans ce
    // process, qui a accès au socket Docker, à l'annuaire et à la clé de chiffrement.
    // La clé d'origine est ajoutée EN DERNIER : PLUGIN_TRUSTED_KEYS ne peut pas la détourner.
    trustedKeys:
      pluginOriginKey === undefined
        ? readTrustedPluginKeys("PLUGIN_TRUSTED_KEYS")
        : { ...readTrustedPluginKeys("PLUGIN_TRUSTED_KEYS"), [PLUGIN_ORIGIN_KEY_ID]: pluginOriginKey },
    // Autorités habilitées à DÉLIVRER un certificat de signature de module (AD CS interne). Elles
    // s'ajoutent aux clés ci-dessus sans les remplacer : une clé Ed25519 reste la voie simple, un
    // certificat apporte en plus une identité de signataire et un retrait sans reconstruction.
    trustedCertificates: readTrustedCertificateAnchors(),
    revokedCertificates: readRevokedCertificates(),
    // Listes de révocation lues sur DISQUE (jamais par le réseau au moment de charger du code, voir
    // plugins/crl.ts). Non défini = sous-dossier `crl/` du répertoire de CONFIG_PATH.
    crlPath: readOptionalString("PLUGIN_CRL_PATH"),
    crlPolicy: readCrlPolicy(),
    crlUrls: readCrlUrls(),
    crlRefreshIntervalMs: readNumber("PLUGIN_CRL_REFRESH_MS", 6 * 60 * 60 * 1000),
    // Taille maximale d'un paquet accepté à l'installation, décodé (somme de ses fichiers).
    maxPackageBytes: readNumber("PLUGIN_MAX_PACKAGE_BYTES", 2 * 1024 * 1024),
    // Délais d'expiration des appels AUX GREFFONS (plugins/guard.ts). Sans isolation hors processus,
    // un greffon qui ne répond pas fige l'appelant : un appel dépassé est abandonné et tracé, le
    // greffon traité comme non contributif — jamais une attente infinie.
    // `test` est déclenché par un admin qui attend devant son écran, mais peut enchaîner une
    // authentification puis un appel (deux fois les 8 s de timeout réseau des intégrations).
    testTimeoutMs: readNumber("PLUGIN_TEST_TIMEOUT_MS", 15_000),
    // `graph`/`snapshot` sont rejoués à CHAQUE construction du graphe, greffon après greffon : à
    // peine plus que le timeout réseau unitaire (8 s) des intégrations, sinon un seul greffon muet
    // rallongerait tout l'affichage.
    graphTimeoutMs: readNumber("PLUGIN_GRAPH_TIMEOUT_MS", 10_000),
    snapshotTimeoutMs: readNumber("PLUGIN_SNAPSHOT_TIMEOUT_MS", 10_000),
    // Une action est une MUTATION réelle (créer une VM, ouvrir un ticket) : plus généreux que la
    // lecture, sans jamais devenir une attente infinie.
    actionTimeoutMs: readNumber("PLUGIN_ACTION_TIMEOUT_MS", 30_000),
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
    // Intervalle de la boucle qui compare ce que Caddy sert réellement à ce que QUAI attend et
    // republie en cas de dérive seulement (voir services/reverseProxyReconciler.ts).
    reconcileIntervalMs: readNumber("REVERSE_PROXY_RECONCILE_INTERVAL_MS", 60_000),
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
  certificates: {
    // Certificats TLS émis par l'autorité AD CS interne de la mairie (voir services/certificates.ts).
    // Clés privées chiffrées au repos comme secrets.json, même répertoire/pattern.
    storePath: readString("CERTIFICATES_PATH", "./data/certificates.json"),
    requestTimeoutMs: readNumber("CERTIFICATES_REQUEST_TIMEOUT_MS", 15000),
    // Marge de renouvellement par défaut (surchargeable par la config d'intégration).
    renewBeforeDays: readNumber("CERTIFICATES_RENEW_BEFORE_DAYS", 30),
    // Intervalle de la boucle de renouvellement (voir services/certificatesReconciler.ts) : un
    // certificat AD CS vit des mois, inutile de sonder plus souvent que quelques heures.
    reconcileIntervalMs: readNumber("CERTIFICATES_RECONCILE_INTERVAL_MS", 6 * 60 * 60 * 1000),
    // L'autorité AD CS présente son propre certificat, émis par elle-même : le conteneur API ne
    // la connaît pas tant que sa racine n'y est pas installée — même périmètre limité et même
    // principe que hycu/nutanix.tlsRejectUnauthorized, jamais NODE_TLS_REJECT_UNAUTHORIZED global.
    tlsRejectUnauthorized: readBoolean("CERTIFICATES_TLS_REJECT_UNAUTHORIZED", false),
  },
  github: {
    // Intégration GitOps GitHub (cf. ARCHITECTURE.md, chapitre "Intégration GitHub") : jeton
    // (PAT) persisté chiffré au repos, même pattern/répertoire que secrets.json.
    storePath: readString("GITHUB_STORE_PATH", "./data/github.json"),
    // Surcharges de fichiers (Dockerfile/docker-compose.yml/*.tf/playbook Ansible) appliquées au
    // clone juste avant build/déploiement (voir services/githubFileOverridesStore.ts) — NON
    // chiffré (contrairement au jeton ci-dessus) : le contenu d'un Dockerfile/compose n'a pas
    // vocation à être un secret (il est normalement committé en clair dans le dépôt d'origine),
    // simple JSON en clair sur disque avec permissions restrictives (0600, comme le reste),
    // décision documentée dans l'en-tête de ce module de stockage.
    fileOverridesPath: readString("GITHUB_FILE_OVERRIDES_PATH", "./data/github-file-overrides.json"),
    apiBaseUrl: readString("GITHUB_API_BASE_URL", "https://api.github.com"),
    // Racine du clone/workspace de chaque déploiement GitHub (voir services/github.ts#runDeployment)
    // — JAMAIS os.tmpdir() : ce process exécute `docker compose`/`docker build` en sous-processus,
    // qui communiquent avec le VRAI démon Docker de l'hôte via le socket monté (docker.sock
    // passthrough, voir docker-compose.dev.yml) — un démon qui tourne HORS de ce conteneur (dans la
    // VM de Docker Desktop en dev, ou potentiellement un autre process en prod). Le build fonctionne
    // avec n'importe quel chemin (le contexte est transféré en streaming, jamais par chemin
    // partagé) — mais un docker-compose.yml déployé qui déclare un bind mount (`volumes: -
    // ./fichier:/chemin`, très courant : configs nginx/prometheus...) échoue si ce chemin n'est pas
    // RÉELLEMENT visible du vrai démon (`os.tmpdir()` du conteneur API n'est JAMAIS partagé avec
    // lui — bug racine documenté en tête de services/github.ts). Défaut : sous-dossier de CONFIG_PATH
    // (même répertoire `data/` que le reste de la persistance QUAI) — en dev, ce dossier est déjà
    // couvert par le bind-mount `../../:/workspace` du repo entier (docker-compose.dev.yml), donc
    // RÉELLEMENT visible sur le disque hôte sans mount supplémentaire à ajouter. En production, si
    // cette API tourne elle-même en conteneur avec le même genre de socket passthrough, monter un
    // VRAI répertoire hôte à ce chemin (ou pointer cette variable dessus) est OBLIGATOIRE pour que
    // les déploiements avec bind mounts fonctionnent.
    deployWorkspaceRoot: readString("GITHUB_DEPLOY_WORKSPACE_ROOT", "./data/github-deploy-workspaces"),
    // Chemin RÉEL de ce même dossier tel que vu par le vrai démon Docker (PAS par ce conteneur) —
    // nécessaire UNIQUEMENT quand le démon tourne dans un espace de noms de fichiers séparé de ce
    // conteneur (ex: Docker Desktop, dont le démon vit dans une VM distincte — vérifié en conditions
    // réelles : un chemin "tel que vu par CE conteneur" ne suffit PAS, le VRAI démon a besoin du
    // chemin hôte natif, ex: "C:\Users\...\apps\api\data\github-deploy-workspaces" avec ses
    // backslashes sur Docker Desktop Windows). Optionnel : si absent, services/github.ts tente de
    // l'AUTO-DÉTECTER en inspectant les mounts de ce conteneur lui-même (voir
    // resolveHostWorkspaceRoot) ; si cette auto-détection échoue aussi (pas dans un conteneur,
    // aucun mount ne couvre ce chemin), retombe sur `deployWorkspaceRoot` tel quel — comportement
    // correct en production Linux SANS VM intermédiaire (conteneur et démon partagent alors
    // RÉELLEMENT le même chemin, si ce répertoire est monté au même endroit des deux côtés).
    deployWorkspaceHostPath: readOptionalString("GITHUB_DEPLOY_WORKSPACE_HOST_PATH"),
    // Clone réel (git clone --depth 1) puis build/run réel — timeouts distincts : un clone est
    // rapide (shallow), un build d'image peut prendre plusieurs minutes selon le Dockerfile.
    cloneTimeoutMs: readNumber("GITHUB_CLONE_TIMEOUT_MS", 30_000),
    buildTimeoutMs: readNumber("GITHUB_BUILD_TIMEOUT_MS", 300_000),
    // Déploiement automatique sur push (webhook GitHub réel, cf. routes/githubWebhook.ts) :
    // URL PUBLIQUE (joignable depuis github.com) de cette API, utilisée pour enregistrer le
    // webhook via l'API GitHub (POST /repos/:owner/:repo/hooks#config.url). Undefined en dev par
    // défaut (aucun hôte de dev local n'est joignable depuis GitHub) — activer le déploiement
    // automatique répond alors 400 avec un message explicite plutôt que de créer un webhook
    // inutilisable.
    webhookBaseUrl: readOptionalString("GITHUB_WEBHOOK_BASE_URL"),
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
  backups: {
    // Persistance des définitions de sauvegarde (cf. ARCHITECTURE.md, chapitre "Sauvegardes
    // automatiques") — même pattern que remoteDocker/lxc ci-dessus : fichier JSON séparé,
    // identifiants S3 (access key/secret key) chiffrés au repos (crypto.ts) avant écriture.
    storePath: readString("BACKUPS_PATH", "./data/backups.json"),
    // Délai max accordé à chaque étape réseau/sous-processus d'une sauvegarde ou d'une
    // restauration (tar d'un volume, dump/restore dans un conteneur via docker exec, upload/
    // download S3) — même raison que scan.timeoutMs/iac.runTimeoutMs : un stockage S3 injoignable
    // ou un dump qui ne se termine jamais ne doit jamais bloquer indéfiniment le scheduler.
    // Généreux par défaut : un tar de gros volume ou un dump de grosse base peut prendre du temps.
    runTimeoutMs: readNumber("BACKUP_RUN_TIMEOUT_MS", 900_000), // 15 min
  },
  notificationChannels: {
    // Délai max accordé à chaque envoi vers un canal de notification sortant (webhook générique/
    // Slack/Discord : fetch ; email : connexion SMTP + envoi, services/notificationDispatch.ts) —
    // même principe que adDns.requestTimeoutMs/reverseProxy.requestTimeoutMs : un canal externe
    // injoignable ne doit jamais faire traîner ni bloquer l'émission d'un événement système.
    requestTimeoutMs: readNumber("NOTIFICATION_CHANNELS_TIMEOUT_MS", 8000),
  },
  metrics: {
    // Persistance de la série temporelle CPU/mémoire par conteneur (cf. ARCHITECTURE.md,
    // priorité #5 du rapport concurrentiel — services/metricsCollector.ts). Chemin dédié plutôt
    // que le dossier de CONFIG_PATH (contrairement à notifications-log.jsonl/scans.jsonl) : ce
    // fichier grossit ET se purge en continu (fenêtre glissante), un chemin explicitement
    // configurable a plus de sens ici que pour un simple journal d'événements rares.
    storePath: readString("METRICS_PATH", "./data/metrics.jsonl"),
    // Cadence du scrape (docker.ts#readContainerUsage pour tous les conteneurs `running`) — 30s
    // par défaut : assez fin pour un graphique lisible sans interroger `docker stats` en boucle
    // serrée sur potentiellement des dizaines de conteneurs.
    intervalMs: readNumber("METRICS_INTERVAL_MS", 30_000),
    // Fenêtre glissante : tout point plus vieux que cette rétention est purgé au fil des cycles
    // (contrairement à notifications-log.jsonl/scans.jsonl, qui restent rares et ne sont jamais
    // purgés) — sinon le fichier grossirait indéfiniment vu la cadence bien plus élevée de ce
    // scrape. 7 jours par défaut, cohérent avec un usage de diagnostic récent plutôt qu'un
    // entrepôt de données longue durée (pas l'ambition de ce premier lot).
    retentionMs: readNumber("METRICS_RETENTION_MS", 7 * 24 * 60 * 60 * 1000),
  },
  cronJobs: {
    // Persistance des définitions de cron jobs (cf. ARCHITECTURE.md, priorité #6 du rapport
    // concurrentiel — services/cronJobsStore.ts) — même pattern que reverse-proxy.json : JSON
    // simple sur disque, aucune valeur sensible à chiffrer au repos (une commande shell n'est pas
    // un secret au sens de secretsStore.ts, même si elle peut en référencer un via l'environnement
    // déjà présent dans le conteneur cible).
    storePath: readString("CRON_JOBS_PATH", "./data/cron-jobs.json"),
    // Historique d'exécution — JSON Lines append-only, même pattern que scans.jsonl (plusieurs
    // lignes par run : "running" puis l'état final, la plus récente par id de run fait foi).
    historyPath: readString("CRON_JOBS_HISTORY_PATH", "./data/cron-jobs-history.jsonl"),
    // Cadence du tick du scheduler (services/cronJobsScheduler.ts) — volontairement plus fin que
    // watchdog.ts (75s) : une expression cron se raisonne à la minute, un tick plus large que 60s
    // risquerait de sauter une minute qui matche brièvement (aucun repli de rattrapage n'est
    // implémenté dans ce premier lot, cf. cronJobsScheduler.ts en-tête de fichier).
    tickIntervalMs: readNumber("CRON_JOBS_TICK_INTERVAL_MS", 20_000),
    // Délai max accordé à une commande de cron job exécutée via `docker exec` (même raison que
    // scan.timeoutMs/iac.runTimeoutMs : une commande qui ne termine jamais ne doit jamais bloquer
    // indéfiniment le run, ni bloquer le slot d'anti-chevauchement du job pour toujours).
    execTimeoutMs: readNumber("CRON_JOBS_EXEC_TIMEOUT_MS", 300_000),
  },
  automation: {
    // Persistance des nœuds/arêtes du moteur d'automatisation (trigger -> condition -> action,
    // cf. services/automationStore.ts) — même pattern que cron-jobs.json : JSON simple sur
    // disque, aucune valeur sensible à chiffrer au repos (une config de trigger/action ne fait
    // que référencer des ids de ressources déjà existantes, jamais un secret en clair).
    storePath: readString("AUTOMATION_STORE_PATH", "./data/automation.json"),
    // Historique d'exécution — JSON Lines append-only, même pattern que cron-jobs-history.jsonl/
    // audit-log.jsonl (une ligne par exécution réelle de chaîne, jamais réécrit).
    historyPath: readString("AUTOMATION_HISTORY_PATH", "./data/automation-runs.jsonl"),
    // Cadence du cycle du moteur (services/automationEngine.ts) — même ordre de grandeur que
    // watchdog.ts (75s) mais volontairement plus réactif par défaut : un trigger câblé sur un
    // conteneur/route déjà surveillé ailleurs doit réagir raisonnablement vite à une vraie panne,
    // sans pour autant interroger Docker/le reverse proxy en boucle serrée.
    pollIntervalMs: readNumber("AUTOMATION_POLL_INTERVAL_MS", 30_000),
    // Délai max accordé à la sonde TCP réelle vers l'upstream d'une route de reverse proxy
    // surveillée par un trigger "reverse-proxy-route" (net.Socket) — même principe que
    // reverseProxy.requestTimeoutMs/nutanix.requestTimeoutMs : un upstream qui ne répond jamais
    // ne doit jamais bloquer indéfiniment un cycle du moteur.
    probeTimeoutMs: readNumber("AUTOMATION_PROBE_TIMEOUT_MS", 3000),
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
