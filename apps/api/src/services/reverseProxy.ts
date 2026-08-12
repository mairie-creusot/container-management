/**
 * Reverse proxy interne : chaque route expose un sous-domaine interne (`*.lecreusot.priv`) vers
 * un conteneur géré par QUAI, ou vers un `host:port` arbitraire. QUAI ne réimplémente AUCUN
 * serveur HTTP/proxy — Caddy (https://caddyserver.com, Apache-2.0) fait tout le travail réseau
 * réel, piloté en direct via son API d'administration JSON (`CADDY_ADMIN_URL`, défaut
 * `http://caddy:2019` — voir https://caddyserver.com/docs/api), même philosophie que
 * OpenTofu/Ansible/Packer/Grype/OSV-Scanner déjà intégrés dans ce projet. PAS de génération de
 * Caddyfile ni de `caddy reload` : la configuration complète est reconstruite et poussée en
 * mémoire, atomiquement, à chaque mutation (voir pushConfigToCaddy() ci-dessous), et rechargeable
 * manuellement à tout moment (utile après un redémarrage de Caddy).
 *
 * Persistance JSON sur disque (`REVERSE_PROXY_PATH`, défaut `./data/reverse-proxy.json` en dev),
 * même répertoire et même pattern que `secrets.json` (secretsStore.ts) : cache mémoire process
 * invalidé à chaque écriture, fichier `0600`. Une route ne contient aucune valeur sensible (juste
 * un id de conteneur ou un host/port) : contrairement à secretsStore.ts, aucun chiffrement au
 * repos n'est nécessaire ici — la forme persistée est donc directement `ReverseProxyRoute`, sans
 * variante "Stored" séparée.
 *
 * Résolution de cible : `targetContainerId` n'est JAMAIS résolu en IP au moment de la création
 * puis figé — l'IP réelle du conteneur (docker.ts#getContainerNetworkAddress, dockerode) est
 * relue à CHAQUE push vers Caddy, pour ne jamais casser une route quand le conteneur cible est
 * recréé/redémarré (nouvelle IP à chaque fois côté Docker). Si un conteneur cible est introuvable
 * ou arrêté au moment du push, SA route est simplement omise de la config poussée (les autres
 * routes actives restent fonctionnelles) — elle revient automatiquement au prochain push une fois
 * le conteneur de nouveau joignable (voir pushConfigToCaddy()).
 *
 * RÉSOLUTION DNS : automatisée quand l'intégration AD DNS est configurée (voir services/adDns.ts,
 * types.ts#AdDnsConfig) — createRoute()/deleteRoute() poussent/retirent alors réellement
 * l'enregistrement `A` du sous-domaine dans le DNS intégré à l'AD de la mairie (RFC 2136 +
 * GSS-TSIG), plus besoin d'entrée manuelle de fichier hosts. Best-effort et jamais bloquant : si
 * AD DNS n'a jamais été configuré, ou si la synchronisation échoue (realm injoignable, droits
 * insuffisants...), la route reste malgré tout créée/supprimée côté QUAI/Caddy — voir `dnsSync`
 * sur ReverseProxyRoute pour le statut réel. Sans AD DNS configuré, la résolution reste une
 * responsabilité manuelle de l'infra réseau (DNS interne ou fichier hosts) : cette fonctionnalité
 * route uniquement une requête déjà arrivée sur Caddy avec le bon en-tête Host/SNI.
 *
 * TLS interne (HTTPS, :443) — plus "hors périmètre" comme documenté initialement, ajouté ce jour
 * suite à un vrai `ERR_EMPTY_RESPONSE` constaté par l'utilisateur sur :443 (rien n'y écoutait) :
 * Caddy sert désormais AUSSI en HTTPS, avec des certificats émis par son AUTORITÉ INTERNE
 * (`issuers: [{ module: "internal" }]`, PAS ACME/Let's Encrypt — ces noms ne sont pas résolubles
 * publiquement, tenter une émission publique échouerait de toute façon). Un certificat interne
 * n'est pas reconnu par défaut par un navigateur/OS : l'autorité racine de Caddy est exposée telle
 * quelle via GET /api/reverse-proxy/ca-certificate pour être installée manuellement comme autorité
 * de confiance (une fois, côté poste client) — voir getCaCertificate() plus bas. `auto_https off`
 * dans le Caddyfile de bootstrap (voir deploy/compose/caddy/Caddyfile) reste nécessaire pour la
 * toute première seconde avant le premier /load (empêche Caddy de tenter une émission ACME sur un
 * nom qu'il ne connaît pas encore) ; une fois ce fichier ci poussé au moins une fois, c'est LUI qui
 * fait autorité sur la config TLS réelle (POST /load remplace tout, y compris `apps.tls`).
 *
 * SÉCURITÉ DE L'API D'ADMIN CADDY (`:2019`) — risque de mouvement latéral ACCEPTÉ, documenté ici
 * plutôt que « corrigé » (finding M2, docs/reports/security-audit-2026-08-12.md) : la seule
 * protection de cette API est la liste blanche `admin.origins` (anti-CSRF navigateur, PAS une
 * authentification — voir pushConfigToCaddy() plus bas), donc tout process du réseau `quai-dev`
 * capable d'émettre une requête HTTP avec l'en-tête `Origin` attendu en prend le contrôle total.
 * Vérifié inoffensif depuis l'extérieur : le port `2019` n'est PAS publié à l'hôte
 * (deploy/compose/docker-compose.dev.yml), donc l'exposition réelle se limite à un mouvement
 * latéral DEPUIS un autre conteneur déjà compromis du même réseau Docker — un scénario qui suppose
 * une compromission préalable, hors périmètre d'une simple validation d'input applicative. Ajouter
 * une couche mTLS (certificat client entre `api` et `caddy`) ou un jeton partagé nécessiterait de
 * modifier `deploy/compose/caddy/Caddyfile`/`docker-compose.dev.yml`, hors périmètre de ce lot de
 * correctifs (dépend entièrement de la segmentation réseau du déploiement réel) — à envisager si
 * l'isolation réseau de `quai-dev` ne peut pas être garantie en production.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIPv4 } from "node:net";
import path from "node:path";
import { config } from "../config.js";
import { getContainerNetworkAddress } from "./docker.js";
import { pushDnsRecord, removeDnsRecord } from "./adDns.js";
import { getEffectiveAdDnsConfig } from "./setupStore.js";
import type { AdDnsSyncResult, ReverseProxyRoute, ReverseProxyStatus } from "../types.js";

export class SubdomainConflictError extends Error {}

/** `subdomain` refusé : caractères hors d'un nom DNS valide (voir SUBDOMAIN_PATTERN ci-dessous). */
export class InvalidSubdomainError extends Error {}

/** `targetHost` refusé : cible interne évidemment dangereuse (voir isForbiddenProxyTarget ci-dessous). */
export class ForbiddenProxyTargetError extends Error {}

/**
 * Le push vers l'API d'admin Caddy a échoué (Caddy pas encore démarré, réseau...) : ÉCHEC
 * EXPLICITE, jamais silencieux — mais la mutation locale (création/suppression de la route)
 * a déjà été persistée avant l'appel à pushConfigToCaddy() et reste donc acquise. `route`
 * porte la route créée quand l'erreur survient pendant createRoute() (absent pour deleteRoute()),
 * pour que la route appelante puisse quand même répondre avec la ressource créée + le détail de
 * l'échec plutôt que de faire disparaître silencieusement une mutation qui a pourtant eu lieu.
 */
export class CaddyPushFailedError extends Error {
  constructor(
    message: string,
    public readonly route?: ReverseProxyRoute,
  ) {
    super(message);
    this.name = "CaddyPushFailedError";
  }
}

let cache: ReverseProxyRoute[] | null = null;

function resolvedStorePath(): string {
  return path.resolve(config.reverseProxy.storePath);
}

async function readFromDisk(): Promise<ReverseProxyRoute[]> {
  try {
    const raw = await fs.readFile(resolvedStorePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReverseProxyRoute[]) : [];
  } catch {
    return [];
  }
}

async function writeToDisk(next: ReverseProxyRoute[]): Promise<void> {
  const filePath = resolvedStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // mode 0o600 : même précaution que secrets.json/config.json, bien qu'aucune valeur sensible
  // ne soit persistée ici.
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function getAll(): Promise<ReverseProxyRoute[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

// --- Synchronisation DNS Active Directory (best-effort, voir services/adDns.ts) -----------------
// Un échec ici ne fait JAMAIS échouer createRoute()/deleteRoute() — la route reste créée/supprimée
// côté QUAI/Caddy quoi qu'il arrive, seul dnsSync reflète si la résolution DNS a réellement suivi.

let lastDnsSync: AdDnsSyncResult | null = null;

/** Dernier résultat de synchronisation DNS AD connu (toute route confondue), pour l'indicateur de
 * la page de configuration (routes/adDns.ts) — non persisté (perdu au redémarrage du process),
 * le résultat par route dans reverse-proxy.json reste la source de vérité durable. */
export function lastKnownDnsSync(): AdDnsSyncResult | null {
  return lastDnsSync;
}

async function tryPushDns(subdomain: string): Promise<AdDnsSyncResult | undefined> {
  const adDnsConfig = await getEffectiveAdDnsConfig();
  if (!adDnsConfig) return undefined; // jamais configuré : aucune tentative, pas un échec
  const result = await pushDnsRecord(adDnsConfig, subdomain).catch(
    (err): AdDnsSyncResult => ({ status: "failed", message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }),
  );
  lastDnsSync = result;
  return result;
}

async function tryRemoveDns(subdomain: string): Promise<void> {
  const adDnsConfig = await getEffectiveAdDnsConfig();
  if (!adDnsConfig) return;
  lastDnsSync = await removeDnsRecord(adDnsConfig, subdomain).catch(
    (err): AdDnsSyncResult => ({ status: "failed", message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }),
  );
}

/** GET /api/reverse-proxy/routes */
export async function listRoutes(): Promise<ReverseProxyRoute[]> {
  return getAll();
}

export interface CreateRouteInput {
  subdomain: string;
  targetContainerId?: string;
  targetHost?: string;
  targetPort: number;
}

function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Format DNS strict (labels alphanumériques/tirets, jamais en bordure de label, séparés par des
 * points — au moins deux labels, ex "monapp.lecreusot.priv") — REJETTE tout caractère qui
 * permettrait une injection dans le script `nsupdate` transmis en texte brut ligne par ligne
 * (retour à la ligne, espace, guillemet...) quand l'intégration DNS AD est configurée (voir
 * services/adDns.ts). Sans cette validation, un simple `operator` (seul le rôle "admin" est requis
 * pour configurer AD DNS lui-même, mais "operator" suffit à créer une route) pouvait faire pointer
 * `subdomain` vers un nom contenant `\nupdate add autrehote.lecreusot.fr 300 A 6.6.6.6\n` et
 * réécrire n'importe quel enregistrement de la zone — voir
 * docs/reports/security-audit-2026-08-12.md, finding C3.
 */
const DNS_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const SUBDOMAIN_PATTERN = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})+$`);

export function isValidSubdomain(value: string): boolean {
  return value.length <= 253 && SUBDOMAIN_PATTERN.test(value);
}

/**
 * `targetHost` reste par conception une cible libre (`host:port` arbitraire, « cas générique, hors
 * conteneurs QUAI » — voir ARCHITECTURE.md, chapitre « Reverse proxy interne ») : QUAI est un outil
 * d'administration interne où un `operator` dispose déjà d'un accès large (conteneurs, volumes,
 * GitOps...), router un sous-domaine vers un service interne quelconque est une fonctionnalité
 * assumée, pas une régression à corriger en restreignant tout accès réseau interne — voir
 * docs/reports/security-audit-2026-08-12.md, finding M1 (SSRF interne via Caddy, risque documenté
 * et accepté par conception). Seule restriction concrète retenue ici, la recommandation « au
 * minimum » du rapport : interdire les cibles qui n'ont AUCUNE raison légitime d'être un upstream
 * de reverse proxy — loopback, link-local, et l'autorité de l'API d'admin Caddy elle-même (`:2019`,
 * qui n'a aucune authentification réelle au-delà d'une liste blanche d'Origin, voir finding M2) :
 * un `operator` malveillant ne doit pas pouvoir exposer publiquement (*.lecreusot.priv) l'API qui
 * pilote intégralement le routage HTTP/HTTPS de l'instance.
 */
const FORBIDDEN_TARGET_HOSTS = new Set(["localhost", "0.0.0.0"]);

export function isForbiddenProxyTarget(targetHost: string): boolean {
  const host = targetHost.trim().toLowerCase();
  if (FORBIDDEN_TARGET_HOSTS.has(host)) return true;
  if (host === "::1" || host.startsWith("fe80:")) return true; // loopback/link-local IPv6
  if (isIPv4(host)) {
    const [firstOctet, secondOctet] = host.split(".").map(Number);
    if (firstOctet === 127) return true; // 127.0.0.0/8 (loopback)
    if (firstOctet === 169 && secondOctet === 254) return true; // 169.254.0.0/16 (link-local)
  }
  // Autorité (hostname, sans port) de CADDY_ADMIN_URL, ex. "caddy" — empêche de router un
  // sous-domaine public directement vers l'API d'admin Caddy elle-même.
  const caddyAuthority = new URL(config.reverseProxy.caddyAdminUrl).hostname.toLowerCase();
  return host === caddyAuthority;
}

/**
 * POST /api/reverse-proxy/routes — `subdomain` doit être unique (409 via SubdomainConflictError
 * sinon). Persiste d'abord, pousse ensuite la config complète vers Caddy : si ce push échoue, la
 * route reste malgré tout créée (voir CaddyPushFailedError ci-dessus) — un re-push peut être
 * retenté (pushConfigToCaddy() est réutilisable, voir POST /api/reverse-proxy/push).
 */
export async function createRoute(input: CreateRouteInput): Promise<ReverseProxyRoute> {
  const all = await getAll();
  const subdomain = normalizeSubdomain(input.subdomain);
  if (!subdomain) throw new Error("subdomain is required");
  if (!isValidSubdomain(subdomain)) {
    throw new InvalidSubdomainError(
      `"${input.subdomain}" is not a valid DNS subdomain (letters, digits, hyphens and dots only, e.g. "monapp.lecreusot.priv")`,
    );
  }
  if (!input.targetContainerId && !input.targetHost) {
    throw new Error("targetContainerId or targetHost is required");
  }
  if (input.targetHost && isForbiddenProxyTarget(input.targetHost)) {
    throw new ForbiddenProxyTargetError(
      `"${input.targetHost}" is not allowed as a reverse-proxy target (loopback/link-local addresses and the Caddy admin API itself are blocked, see docs/reports/security-audit-2026-08-12.md, finding M1)`,
    );
  }
  if (all.some((route) => route.subdomain === subdomain)) {
    throw new SubdomainConflictError(`A route for "${subdomain}" already exists`);
  }

  // Avant la persistance : si AD DNS est configuré, tente de pousser l'enregistrement DNS pour
  // que `dnsSync` fasse partie de la route dès sa création (une seule écriture disque, pas deux).
  const dnsSync = await tryPushDns(subdomain);

  const created: ReverseProxyRoute = {
    id: randomUUID(),
    subdomain,
    ...(input.targetContainerId ? { targetContainerId: input.targetContainerId } : {}),
    ...(input.targetHost ? { targetHost: input.targetHost } : {}),
    targetPort: input.targetPort,
    createdAt: new Date().toISOString(),
    ...(dnsSync ? { dnsSync } : {}),
  };
  const next = [...all, created];
  await writeToDisk(next);
  cache = next;

  try {
    await pushConfigToCaddy();
  } catch (err) {
    throw new CaddyPushFailedError(err instanceof Error ? err.message : String(err), created);
  }
  return created;
}

/**
 * DELETE /api/reverse-proxy/routes/:id — `false` si aucune route ne portait cet id (pas de push
 * inutile dans ce cas). Même principe que createRoute() côté échec de push : la suppression reste
 * acquise même si Caddy ne répond pas.
 */
export async function deleteRoute(id: string): Promise<boolean> {
  const all = await getAll();
  const target = all.find((route) => route.id === id);
  const next = all.filter((route) => route.id !== id);
  if (next.length === all.length) return false;
  await writeToDisk(next);
  cache = next;

  // Best-effort, jamais bloquant : la suppression reste acquise même si le retrait DNS échoue
  // (voir tryRemoveDns ci-dessus) — un enregistrement DNS orphelin est gênant, pas dangereux.
  if (target) await tryRemoveDns(target.subdomain);

  try {
    await pushConfigToCaddy();
  } catch (err) {
    throw new CaddyPushFailedError(err instanceof Error ? err.message : String(err));
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Push vers l'API d'administration Caddy (POST /load — remplace toute la config en mémoire,
// atomiquement, sans toucher au disque de Caddy ni redémarrer son process).
// ---------------------------------------------------------------------------------------

interface CaddyProxyRoute {
  match: [{ host: string[] }];
  handle: [{ handler: "reverse_proxy"; upstreams: [{ dial: string }] }];
}

/** Route de secours SANS `match` (donc appliquée à toute requête qui n'a matché aucune route
 * ci-dessus, Caddy évaluant les routes dans l'ordre) — sans elle, un Host inconnu de Caddy
 * reçoit un `200` vide par défaut plutôt qu'une réponse explicite (comportement par défaut de
 * Caddy quand aucune route ne gère la requête), ce qui masquerait un sous-domaine mal orthographié
 * ou pas encore propagé par le DNS interne. Toujours placée en dernier.
 */
interface CaddyFallbackRoute {
  handle: [{ handler: "static_response"; status_code: 404; body: string }];
}

type CaddyRoute = CaddyProxyRoute | CaddyFallbackRoute;

/** Upstream `host:port` réel pour une route — résolution EN DIRECT (jamais mise en cache), voir docstring de tête de fichier. */
async function resolveUpstream(route: ReverseProxyRoute): Promise<string | null> {
  if (route.targetHost) return `${route.targetHost}:${route.targetPort}`;
  if (route.targetContainerId) {
    const ip = await getContainerNetworkAddress(route.targetContainerId);
    return ip ? `${ip}:${route.targetPort}` : null;
  }
  return null;
}

/**
 * Reconstruit la configuration Caddy complète (un serveur HTTP "quai" sur `:80`, une route par
 * sous-domaine dont la cible a pu être résolue) et la pousse en une fois via `POST /load` (voir
 * https://caddyserver.com/docs/api#post-load). Réutilisable manuellement (ex: après un
 * redémarrage de Caddy qui serait reparti du Caddyfile de bootstrap, sans plus aucune route
 * applicative).
 *
 * Le bloc `admin` est explicitement réinclus à chaque appel : `/load` remplace la config
 * ENTIÈRE, y compris `admin` — l'omettre ferait retomber Caddy sur son admin par défaut
 * (`localhost:2019`, injoignable depuis les autres conteneurs du réseau docker-compose),
 * cassant irrémédiablement tout push suivant. `origins` y est également réinclus à chaque fois
 * (l'autorité de `CADDY_ADMIN_URL`, ex: "caddy:2019", + les variantes localhost usuelles) : sans
 * cela, Caddy rejette en 403 toute requête d'admin dont l'en-tête Host ne correspond pas à sa
 * liste blanche par défaut (qui ne connaît que localhost/127.0.0.1/::1, jamais un nom de service
 * docker-compose) — vérifié en conditions réelles lors du développement de cette fonctionnalité.
 *
 * Échoue EXPLICITEMENT (l'erreur, jamais avalée) si Caddy ne répond pas ou répond en erreur —
 * voir createRoute()/deleteRoute() ci-dessus pour ce que l'appelant en fait.
 */
export async function pushConfigToCaddy(): Promise<void> {
  const routes = await getAll();
  const caddyRoutes: CaddyRoute[] = [];
  const tlsSubjects = new Set<string>(["localhost"]); // "localhost" toujours couvert : voir le
  // commentaire sur `apps.tls` ci-dessous — permet de vérifier que le TLS interne fonctionne
  // (https://localhost) même sans aucune route *.lecreusot.priv encore configurée.
  for (const route of routes) {
    const upstream = await resolveUpstream(route);
    if (!upstream) continue; // cible introuvable/injoignable pour l'instant : omise, réessayée au prochain push
    caddyRoutes.push({
      match: [{ host: [route.subdomain] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
    });
    tlsSubjects.add(route.subdomain);
  }
  // Toujours en dernier (voir CaddyFallbackRoute ci-dessus) : un Host qui ne correspond à
  // aucune route active reçoit un 404 explicite plutôt que le 200 vide par défaut de Caddy.
  caddyRoutes.push({
    handle: [
      {
        handler: "static_response",
        status_code: 404,
        body: "QUAI reverse proxy — aucune route configurée pour cet hôte (en-tête Host inconnu).",
      },
    ],
  });

  // Caddy vérifie systématiquement l'en-tête Host des requêtes reçues par son API d'admin
  // contre une liste blanche (`origins`) — par défaut limitée à des variantes de localhost,
  // donc "caddy:2019" (résolution par nom de service docker-compose, ce que fait CE process
  // en tapant caddyAdminUrl) y est absent et se voit rejeté en 403 ("client is not allowed to
  // access from origin"). On ajoute explicitement l'autorité de CADDY_ADMIN_URL (ex:
  // "caddy:2019") à la liste, en plus des localhost habituels, à CHAQUE push (voir même
  // remarque que pour `listen` juste au-dessus : /load remplace tout, origins compris).
  const adminAuthority = new URL(config.reverseProxy.caddyAdminUrl).host;
  const adminOrigins = Array.from(new Set([adminAuthority, "localhost:2019", "127.0.0.1:2019", "[::1]:2019"]));

  const body = {
    admin: { listen: "0.0.0.0:2019", origins: adminOrigins },
    apps: {
      // Émission de certificat par l'AUTORITÉ INTERNE de Caddy (jamais ACME/Let's Encrypt — voir
      // le commentaire de tête de fichier) pour chaque sous-domaine réellement configuré + une
      // entrée fixe "localhost" (utile pour vérifier que le TLS marche même sans route). `subjects`
      // reconstruit à chaque push comme le reste : une route supprimée n'a plus de certificat émis
      // pour elle au push suivant (Caddy garde le certificat déjà émis en cache jusqu'à expiration,
      // mais n'en émet plus de nouveau pour ce nom une fois retiré des subjects).
      tls: {
        automation: {
          policies: [{ subjects: Array.from(tlsSubjects), issuers: [{ module: "internal" }] }],
        },
      },
      http: {
        servers: {
          // :443 en plus de :80 (existant, inchangé) — les DEUX servent les mêmes routes, aucune
          // redirection HTTP -> HTTPS forcée pour ne rien casser de ce qui dépend déjà du HTTP
          // (ex: tests/scripts déjà écrits en http:// dans les lots précédents).
          quai: { listen: [":80", ":443"], routes: caddyRoutes },
        },
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.reverseProxy.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.reverseProxy.caddyAdminUrl}/load`, {
      method: "POST",
      // Origin explicite : c'est CE header (pas Host, peu fiable server-to-server — voir
      // commentaire ci-dessus) que Caddy compare à sa liste blanche `admin.origins`.
      headers: { "Content-Type": "application/json", Origin: `http://${adminAuthority}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${config.reverseProxy.requestTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`Caddy admin API unreachable (${config.reverseProxy.caddyAdminUrl}): ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Caddy admin API responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

/** GET /api/reverse-proxy/status — Caddy joignable ou non, même pattern que GET /api/scanners/status. */
export async function getReverseProxyStatus(): Promise<ReverseProxyStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.reverseProxy.requestTimeoutMs);
  try {
    const adminAuthority = new URL(config.reverseProxy.caddyAdminUrl).host;
    const response = await fetch(`${config.reverseProxy.caddyAdminUrl}/config/`, {
      headers: { Origin: `http://${adminAuthority}` },
      signal: controller.signal,
    });
    // httpsEnabled : "on sait que Caddy est joignable" != "on sait que le TLS interne est
    // effectivement configuré" (un Caddy tout juste redémarré, reparti du Caddyfile de bootstrap,
    // n'a plus que :80 tant qu'aucun /load n'a encore été repoussé) — mais push_ConfigToCaddy()
    // est appelé à chaque mutation de route ET peut être redéclenché manuellement (POST
    // /api/reverse-proxy/push, déjà existant), donc "joignable" est une approximation honnête
    // suffisante pour ce premier lot plutôt qu'un vrai GET /config/apps/tls coûteux à interpréter.
    return { reachable: response.ok, adminUrl: config.reverseProxy.caddyAdminUrl, httpsEnabled: response.ok };
  } catch {
    return { reachable: false, adminUrl: config.reverseProxy.caddyAdminUrl, httpsEnabled: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /api/reverse-proxy/ca-certificate — certificat racine (PEM) de l'autorité interne de Caddy
 * qui émet les certificats HTTPS de ce reverse proxy (voir pushConfigToCaddy() ci-dessus). Un
 * certificat émis par cette autorité n'est reconnu par AUCUN navigateur/OS tant que CE certificat
 * racine n'y a pas été installé manuellement comme autorité de confiance (une fois, par poste) —
 * Caddy l'expose lui-même sur son API d'admin (GET /pki/ca/local, non documenté dans l'API REST
 * officielle mais stable — voir https://caddyserver.com/docs/command-line#caddy-trust pour
 * l'équivalent CLI), on ne fait que le relayer tel quel.
 */
export async function getCaCertificate(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.reverseProxy.requestTimeoutMs);
  try {
    const adminAuthority = new URL(config.reverseProxy.caddyAdminUrl).host;
    const response = await fetch(`${config.reverseProxy.caddyAdminUrl}/pki/ca/local`, {
      headers: { Origin: `http://${adminAuthority}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Caddy admin API responded ${response.status} for /pki/ca/local`);
    }
    const data = (await response.json()) as { root_certificate?: string };
    if (!data.root_certificate) {
      throw new Error("Caddy admin API returned no root_certificate (autorité interne pas encore initialisée — poussez au moins une route ou relancez POST /api/reverse-proxy/push)");
    }
    return data.root_certificate;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Caddy admin API unreachable (${config.reverseProxy.caddyAdminUrl}): timed out after ${config.reverseProxy.requestTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
