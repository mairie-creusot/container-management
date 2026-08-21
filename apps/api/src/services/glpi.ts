/**
 * Intégration GLPI (outil de tickets de la Mairie du Creusot) — API REST `apirest.php`, même
 * patron exact que services/hycu.ts : config chiffrée au repos (setupStore.ts#SetupGlpiConfig),
 * test de connexion RÉEL avant persistance, `lastKnownGlpiPoll()` pour distinguer "vide" de
 * "injoignable", et aucun jeu de démonstration.
 *
 * PÉRIMÈTRE D'ÉCRITURE STRICT (autorisé par l'utilisateur, borné ici) : créer un ticket, ajouter
 * un suivi (ITILFollowup), passer un ticket en résolu. Aucune suppression, et la seule mutation
 * d'un ticket existant est `{ status: SOLVED }` — updateTicketStatusSolved n'accepte aucun autre
 * champ, il n'existe donc pas de chemin de code capable de modifier autre chose.
 *
 * Formes d'API — sources explicites (doc officielle glpi-project/glpi/apirest.md, consultée le
 * 19/08/2026), confirmé vs supposé :
 *  - CONFIRMÉ (apirest.md) : `GET /initSession` avec en-tête `App-Token` + `Authorization: Basic
 *    base64(login:password)` OU `Authorization: user_token <jeton>` → `{ "session_token": "..." }` ;
 *    `GET /killSession` avec `Session-Token` → corps vide ; toutes les autres routes exigent
 *    l'en-tête `Session-Token`.
 *  - CONFIRMÉ (apirest.md) : `GET /search/:itemtype` — `criteria[i][field|searchtype|value|link]`,
 *    `forcedisplay[i]`, `range` (défaut "0-49"), searchtype ∈ contains/equals/notequals/lessthan/
 *    morethan/under/notunder ; réponse `{ totalcount, count, range, data }` où `data` est indexé
 *    par id d'item et chaque ligne est indexée par NUMÉRO d'option de recherche.
 *  - CONFIRMÉ (apirest.md) : `GET /:itemtype/:id` → objet aux champs nommés ; `GET /:itemtype/:id/
 *    :sub_itemtype` → tableau ; `POST /:itemtype` avec `{ "input": {...} }` → 201 `{ "id": 15 }` ;
 *    `PUT /:itemtype/:id` avec `{ "input": {...} }` → `[{ "<id>": true, "message": "" }]` ;
 *    `GET /listSearchOptions/:itemtype` → options de recherche réelles (uid/table/field).
 *  - CONFIRMÉ (glpi-project/glpi, src/CommonITILObject.php) : statuts SOLVED = 5, CLOSED = 6.
 *  - CONFIRMÉ (glpi-project/glpi, src/CommonITILActor.php) : REQUESTER = 1, ASSIGN = 2,
 *    OBSERVER = 3.
 *  - CONFIRMÉ en conditions réelles (172.16.8.22, sans jeton) : `http://172.16.8.22/apirest.php`
 *    répond ; `/glpi/apirest.php` renvoie 403 ; `GET /initSession` sans jeton renvoie 400
 *    ERROR_APP_TOKEN_PARAMETERS_MISSING — l'API est vivante et exige un app_token.
 *  - SUPPOSÉ, à confirmer dès qu'un app_token sera saisi (aucune donnée réelle n'a pu être lue) :
 *    les NUMÉROS d'options de recherche de Ticket (TICKET_SEARCH_OPTION ci-dessous) — vérifiables
 *    en une requête via getGlpiTicketSearchOptions() ; l'itemtype `ITILFollowup` (nom depuis
 *    GLPI 9.4, `TicketFollowup` avant) et l'itemtype de liaison `Ticket_User`.
 *
 * SECRETS : app_token / user_token / mot de passe ne transitent QUE par des en-têtes HTTP (jamais
 * un paramètre d'URL, qui ressortirait dans un message d'erreur), ne sont JAMAIS journalisés, et
 * tout texte renvoyé par GLPI passe par redactSecrets() avant de remonter dans un message d'erreur.
 */

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getEffectiveGlpiConfig } from "./setupStore.js";
import type { SetupGlpiConfig } from "./setupStore.js";

// --- Types publics de l'intégration (déclarés ICI, pas dans types.ts) ---

export interface GlpiTicketSummary {
  id: number;
  title: string;
  /** Code de statut GLPI brut (1..6) — jamais réinterprété en taxonomie inventée. */
  status?: number;
  statusLabel?: string;
  openedAt?: string;
  updatedAt?: string;
}

export interface GlpiFollowup {
  id: number;
  content: string;
  date?: string;
  authorId?: number;
  isPrivate?: boolean;
}

export interface GlpiTicketDetail extends GlpiTicketSummary {
  content: string;
  solvedAt?: string;
  closedAt?: string;
  followups: GlpiFollowup[];
}

/** Rapprochement du compte GLPI d'un utilisateur QUAI (authentifié en AD/LDAP) par le champ
 * `name` de /User — jamais approximatif : 0 ou >1 correspondance est signalé tel quel. */
export type GlpiUserMatch =
  | { outcome: "found"; userId: number; login: string }
  | { outcome: "not-found"; login: string }
  | { outcome: "ambiguous"; login: string; candidateIds: number[] };

export interface GlpiConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface GlpiStatusSummary {
  configured: boolean;
  reachable?: boolean;
  apiUrl?: string;
  /** Comment QUAI s'authentifie auprès de GLPI — jamais le jeton/mot de passe lui-même. */
  authMode?: "user-token" | "credentials";
  serviceAccount?: string;
}

export interface GlpiPollOutcome {
  reachable: boolean;
  at: string; // ISO 8601
}

/** Incident identifié de façon STABLE par (ressource, type d'alerte) — base de l'anti-doublon. */
export interface GlpiIncidentKey {
  resource: string;
  alertType: string;
}

export interface GlpiIncidentContext extends GlpiIncidentKey {
  title: string;
  details?: string;
  occurredAt?: string;
  backUrl?: string;
}

export type GlpiIncidentReport =
  | { action: "created"; ticketId: number; fingerprint: string }
  | { action: "followup"; ticketId: number; fingerprint: string }
  | { action: "resolved"; ticketId: number; fingerprint: string }
  | { action: "none"; fingerprint: string };

/** Action d'automatisation GLPI — déclarée ici (et pas dans le type union de types.ts) pour rester
 * dans le périmètre de ce module ; reconnue à l'exécution par asGlpiAutomationAction(). */
export interface GlpiAutomationActionConfig {
  kind: "create-glpi-ticket";
  /** Titre imposé par l'administrateur ; à défaut, un titre construit depuis le contexte réel. */
  title?: string;
}

export class GlpiNotConfiguredError extends Error {
  constructor() {
    super("GLPI n'est pas configuré");
    this.name = "GlpiNotConfiguredError";
  }
}

export class GlpiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GlpiError";
  }
}

// --- Constantes GLPI (voir en-tête pour la source de chacune) ---

const STATUS_SOLVED = 5;
const STATUS_CLOSED = 6;
const ACTOR_REQUESTER = 1;

/** Libellés des statuts GLPI (CommonITILObject) — purement cosmétiques, le code brut reste exposé. */
const STATUS_LABELS: Record<number, string> = {
  1: "Nouveau",
  2: "En cours (attribué)",
  3: "En cours (planifié)",
  4: "En attente",
  5: "Résolu",
  6: "Clos",
};

/**
 * Numéros d'options de recherche de Ticket — SUPPOSÉS (valeurs du cœur GLPI, stables depuis des
 * années mais jamais vérifiées sur l'instance de la mairie faute d'app_token) : à confirmer en
 * une requête via getGlpiTicketSearchOptions(), qui renvoie les options RÉELLES de l'instance.
 */
const TICKET_SEARCH_OPTION = {
  title: 1,
  id: 2,
  requester: 4,
  status: 12,
  openDate: 15,
  lastUpdate: 19,
  content: 21,
} as const;

const USER_SEARCH_OPTION = {
  login: 1,
  id: 2,
} as const;

const MAX_TICKETS_RANGE = 200;

// --- Accès HTTP ---

function loadConfigOrNull(cfg: SetupGlpiConfig | null): SetupGlpiConfig | null {
  if (!cfg?.apiUrl || !cfg.appToken) return null;
  const hasAuth = Boolean(cfg.userToken) || Boolean(cfg.username && cfg.password);
  return hasAuth ? cfg : null;
}

/** Config GLPI effective si complète, sinon `null` — garde "jamais configuré", même rôle exact
 * que hycu.ts#loadHycuConfig. */
async function loadGlpiConfig(): Promise<SetupGlpiConfig | null> {
  return loadConfigOrNull(await getEffectiveGlpiConfig());
}

function normalizedApiUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Remplace toute occurrence d'un secret de la config par `***` — dernier rempart avant qu'un
 * texte renvoyé par GLPI ne remonte dans un message d'erreur, une route ou un log. */
export function redactSecrets(text: string, cfg: Pick<SetupGlpiConfig, "appToken" | "userToken" | "password">): string {
  let out = text;
  for (const secret of [cfg.appToken, cfg.userToken, cfg.password]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

interface GlpiHttpResult {
  status: number;
  raw: string;
  data: unknown;
}

/** Un appel HTTP vers apirest.php — `fetch` + AbortSignal (même patron que services/registries/
 * http.ts). Les jetons ne passent QUE par les en-têtes, jamais par l'URL. */
async function glpiFetch(
  cfg: SetupGlpiConfig,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<GlpiHttpResult> {
  const url = new URL(path.replace(/^\//, ""), normalizedApiUrl(cfg.apiUrl)).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.glpi.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    return { status: response.status, raw, data };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GlpiError(`GLPI n'a pas répondu à ${method} ${path} en moins de ${config.glpi.requestTimeoutMs}ms`);
    }
    throw new GlpiError(`GLPI injoignable sur ${method} ${path} : ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Message d'erreur exploitable à partir d'une réponse GLPI — format documenté `["ERROR_CODE",
 * "message"]`, sinon le corps brut tronqué. Toujours passé par redactSecrets(). */
function describeGlpiError(cfg: SetupGlpiConfig, result: GlpiHttpResult, what: string): string {
  const data = result.data;
  let detail = result.raw.slice(0, 300);
  if (Array.isArray(data) && typeof data[0] === "string") {
    const code = data[0];
    const message = typeof data[1] === "string" ? data[1] : "";
    detail = message ? `${code} — ${message}` : code;
  }
  return redactSecrets(`GLPI a refusé ${what} (HTTP ${result.status}) : ${detail}`, cfg);
}

function glpiErrorCode(result: GlpiHttpResult): string | null {
  return Array.isArray(result.data) && typeof result.data[0] === "string" ? result.data[0] : null;
}

// --- Cycle de vie de la session (init -> appels -> kill) ---

interface CachedSession {
  token: string;
  /** Empreinte de la config ayant produit ce jeton : toute modification l'invalide. */
  configFingerprint: string;
  expiresAt: number;
}

let cachedSession: CachedSession | null = null;
let inFlightInit: Promise<CachedSession> | null = null;

/** GLPI expire une session PHP inactive (souvent 24 min) : on réutilise la nôtre bien en deçà,
 * et un ERROR_SESSION_TOKEN_INVALID déclenche de toute façon une réinitialisation. */
const SESSION_TTL_MS = 10 * 60 * 1000;

function configFingerprint(cfg: SetupGlpiConfig): string {
  return createHash("sha256")
    .update([cfg.apiUrl, cfg.appToken, cfg.userToken ?? "", cfg.username ?? "", cfg.password ?? ""].join(" "))
    .digest("hex");
}

function authHeader(cfg: SetupGlpiConfig): string {
  if (cfg.userToken) return `user_token ${cfg.userToken}`;
  return `Basic ${Buffer.from(`${cfg.username ?? ""}:${cfg.password ?? ""}`).toString("base64")}`;
}

/** `GET /initSession` (apirest.md) — App-Token + Authorization, réponse `{ session_token }`. */
async function initSession(cfg: SetupGlpiConfig): Promise<string> {
  const result = await glpiFetch(cfg, "GET", "initSession", {
    "App-Token": cfg.appToken,
    Authorization: authHeader(cfg),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new GlpiError(describeGlpiError(cfg, result, "l'ouverture de session"), result.status);
  }
  const token = (result.data as { session_token?: unknown } | null)?.session_token;
  if (typeof token !== "string" || !token) {
    throw new GlpiError("GLPI a répondu à /initSession sans session_token exploitable");
  }
  return token;
}

/** `GET /killSession` — best-effort : ne fait jamais échouer l'appelant (la session expirera
 * d'elle-même côté GLPI), mais on la libère toujours plutôt que de la laisser filer. */
async function killSession(cfg: SetupGlpiConfig, sessionToken: string): Promise<void> {
  try {
    await glpiFetch(cfg, "GET", "killSession", { "App-Token": cfg.appToken, "Session-Token": sessionToken });
  } catch {
    // ignoré volontairement
  }
}

async function acquireSession(cfg: SetupGlpiConfig): Promise<string> {
  const fingerprint = configFingerprint(cfg);
  const now = Date.now();
  if (cachedSession && cachedSession.configFingerprint === fingerprint && cachedSession.expiresAt > now) {
    return cachedSession.token;
  }
  if (cachedSession && cachedSession.configFingerprint !== fingerprint) {
    void killSession(cfg, cachedSession.token);
    cachedSession = null;
  }
  // Une seule initialisation en vol : des appels concurrents partagent la même session plutôt
  // que d'en ouvrir une chacun (GLPI compte les sessions ouvertes).
  if (!inFlightInit) {
    inFlightInit = (async () => {
      const token = await initSession(cfg);
      const session: CachedSession = { token, configFingerprint: fingerprint, expiresAt: Date.now() + SESSION_TTL_MS };
      cachedSession = session;
      return session;
    })().finally(() => {
      inFlightInit = null;
    });
  }
  return (await inFlightInit).token;
}

/** Libère explicitement la session en cache (killSession + oubli) — appelée à chaque changement
 * de configuration et exposée pour les tests. */
export async function releaseGlpiSession(): Promise<void> {
  const session = cachedSession;
  cachedSession = null;
  inFlightInit = null;
  if (!session) return;
  const cfg = await getEffectiveGlpiConfig();
  if (cfg?.apiUrl && cfg.appToken) await killSession(cfg, session.token);
}

function isSessionExpired(result: GlpiHttpResult): boolean {
  const code = glpiErrorCode(result);
  return code === "ERROR_SESSION_TOKEN_INVALID" || code === "ERROR_SESSION_TOKEN_MISSING";
}

/**
 * Appel authentifié : réutilise la session en cache, et sur ERROR_SESSION_TOKEN_INVALID (session
 * expirée côté GLPI entre deux appels) la libère et réessaie UNE fois avec une session neuve.
 */
async function glpiCall(cfg: SetupGlpiConfig, method: string, path: string, body?: unknown): Promise<GlpiHttpResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionToken = await acquireSession(cfg);
    const result = await glpiFetch(
      cfg,
      method,
      path,
      { "App-Token": cfg.appToken, "Session-Token": sessionToken },
      body,
    );
    if (attempt === 0 && (result.status === 401 || isSessionExpired(result))) {
      cachedSession = null;
      await killSession(cfg, sessionToken);
      continue;
    }
    return result;
  }
  throw new GlpiError("GLPI a rejeté la session deux fois de suite");
}

async function glpiCallOk(cfg: SetupGlpiConfig, method: string, path: string, what: string, body?: unknown): Promise<unknown> {
  const result = await glpiCall(cfg, method, path, body);
  if (result.status < 200 || result.status >= 300) {
    throw new GlpiError(describeGlpiError(cfg, result, what), result.status);
  }
  return result.data;
}

// --- Sonde / configuration ---

export async function isGlpiConfigured(): Promise<boolean> {
  return (await loadGlpiConfig()) !== null;
}

let lastPollOutcome: GlpiPollOutcome | null = null;

/** Dernier essai RÉEL d'appel GLPI — mémoire process uniquement, même rôle exact que
 * hycu.ts#lastKnownHycuPoll : distinguer côté UI "aucun ticket" de "GLPI injoignable". */
export function lastKnownGlpiPoll(): GlpiPollOutcome | null {
  return lastPollOutcome;
}

function recordPoll(reachable: boolean): void {
  lastPollOutcome = { reachable, at: new Date().toISOString() };
}

/**
 * Teste une config candidate (pas encore persistée) sans jamais modifier l'état applicatif :
 * ouvre une session RÉELLE puis la referme systématiquement (finally) — aucune lecture de données
 * de la mairie, aucune écriture.
 */
export async function testGlpiConnection(candidate: SetupGlpiConfig): Promise<GlpiConnectionTestResult> {
  const cfg = loadConfigOrNull(candidate);
  if (!cfg) {
    return { ok: false, message: "apiUrl, appToken et (userToken OU username+password) sont requis" };
  }
  let sessionToken: string | null = null;
  try {
    sessionToken = await initSession(cfg);
    return { ok: true, message: "Connexion GLPI établie (session ouverte puis refermée)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: redactSecrets(message, cfg) };
  } finally {
    if (sessionToken) await killSession(cfg, sessionToken);
  }
}

export async function getGlpiStatus(): Promise<GlpiStatusSummary> {
  const cfg = await loadGlpiConfig();
  if (!cfg) return { configured: false };
  const authMode = cfg.userToken ? ("user-token" as const) : ("credentials" as const);
  const base: GlpiStatusSummary = {
    configured: true,
    apiUrl: cfg.apiUrl,
    authMode,
    ...(authMode === "credentials" && cfg.username ? { serviceAccount: cfg.username } : {}),
  };
  try {
    await acquireSession(cfg);
    recordPoll(true);
    return { ...base, reachable: true };
  } catch {
    recordPoll(false);
    return { ...base, reachable: false };
  }
}

/**
 * Options de recherche RÉELLES de l'instance (`GET /listSearchOptions/Ticket`) — sert à confirmer
 * les numéros supposés de TICKET_SEARCH_OPTION dès qu'un app_token sera saisi, sans deviner.
 */
export async function getGlpiTicketSearchOptions(): Promise<Record<string, unknown>> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const data = await glpiCallOk(cfg, "GET", "listSearchOptions/Ticket", "la lecture des options de recherche");
  return (data ?? {}) as Record<string, unknown>;
}

// --- Recherche générique ---

interface GlpiSearchResponse {
  totalcount?: number;
  count?: number;
  data?: Record<string, Record<string, unknown>> | Array<Record<string, unknown>>;
}

interface SearchCriterion {
  field: number;
  searchtype: string;
  value: string;
  link?: "AND" | "OR";
}

function buildSearchQuery(criteria: SearchCriterion[], forcedisplay: number[], range: string): string {
  const params = new URLSearchParams();
  criteria.forEach((criterion, index) => {
    if (criterion.link) params.append(`criteria[${index}][link]`, criterion.link);
    params.append(`criteria[${index}][field]`, String(criterion.field));
    params.append(`criteria[${index}][searchtype]`, criterion.searchtype);
    params.append(`criteria[${index}][value]`, criterion.value);
  });
  forcedisplay.forEach((field, index) => params.append(`forcedisplay[${index}]`, String(field)));
  params.append("range", range);
  return params.toString();
}

/**
 * Lignes d'un `/search/:itemtype`. `data` est documenté comme un objet indexé par id d'item
 * (apirest.md), mais certaines versions renvoient un tableau : les deux formes sont acceptées, et
 * la clé de l'objet sert de repli pour l'id quand l'option correspondante n'est pas renvoyée.
 */
function searchRows(data: GlpiSearchResponse | null): Array<{ key: string | null; row: Record<string, unknown> }> {
  const raw = data?.data;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((row) => ({ key: null, row }));
  return Object.entries(raw).map(([key, row]) => ({ key, row }));
}

function rowNumber(row: Record<string, unknown>, option: number, fallback?: string | null): number | undefined {
  const value = row[String(option)];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (fallback !== undefined && fallback !== null && Number.isFinite(Number(fallback))) return Number(fallback);
  return undefined;
}

function rowString(row: Record<string, unknown>, option: number): string | undefined {
  const value = row[String(option)];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

async function searchTickets(cfg: SetupGlpiConfig, criteria: SearchCriterion[], limit: number): Promise<GlpiTicketSummary[]> {
  const query = buildSearchQuery(
    criteria,
    [
      TICKET_SEARCH_OPTION.id,
      TICKET_SEARCH_OPTION.title,
      TICKET_SEARCH_OPTION.status,
      TICKET_SEARCH_OPTION.openDate,
      TICKET_SEARCH_OPTION.lastUpdate,
    ],
    `0-${Math.max(0, limit - 1)}`,
  );
  const result = await glpiCall(cfg, "GET", `search/Ticket?${query}`);
  // Une recherche sans résultat peut répondre ERROR_RANGE_EXCEED_TOTAL (apirest.md) : c'est
  // "aucun ticket", jamais une panne.
  if (glpiErrorCode(result) === "ERROR_RANGE_EXCEED_TOTAL") return [];
  if (result.status < 200 || result.status >= 300) {
    throw new GlpiError(describeGlpiError(cfg, result, "la recherche de tickets"), result.status);
  }
  return searchRows(result.data as GlpiSearchResponse | null)
    .map(({ key, row }) => {
      const id = rowNumber(row, TICKET_SEARCH_OPTION.id, key);
      if (id === undefined) return null;
      const status = rowNumber(row, TICKET_SEARCH_OPTION.status);
      const summary: GlpiTicketSummary = {
        id,
        title: rowString(row, TICKET_SEARCH_OPTION.title) ?? `Ticket ${id}`,
        ...(status !== undefined ? { status } : {}),
        ...(status !== undefined && STATUS_LABELS[status] ? { statusLabel: STATUS_LABELS[status] } : {}),
        ...(rowString(row, TICKET_SEARCH_OPTION.openDate) ? { openedAt: rowString(row, TICKET_SEARCH_OPTION.openDate)! } : {}),
        ...(rowString(row, TICKET_SEARCH_OPTION.lastUpdate) ? { updatedAt: rowString(row, TICKET_SEARCH_OPTION.lastUpdate)! } : {}),
      };
      return summary;
    })
    .filter((t): t is GlpiTicketSummary => t !== null);
}

// --- Rapprochement d'utilisateur (AD/LDAP -> compte GLPI) ---

/**
 * Les utilisateurs QUAI s'authentifient en AD/LDAP ; GLPI stocke le même identifiant de connexion
 * dans le champ `name` de /User (option de recherche 1 « Identifiant », confirmé sur l'instance
 * réelle via /listSearchOptions/User).
 *
 * `searchtype: "contains"` et NON `"equals"` : vérifié en conditions réelles le 21/08/2026 sur
 * l'instance de la mairie — `equals` sur ce champ texte renvoie 0 résultat alors que le compte
 * existe, `contains` le trouve. Le filtrage EXACT est donc fait côté QUAI juste après (comparaison
 * insensible à la casse sur la chaîne ENTIÈRE) : un login qui n'est qu'une sous-chaîne d'un autre
 * compte n'est jamais retenu, et sans correspondance exacte on répond "not-found" plutôt que de
 * choisir un compte approchant.
 */
export async function resolveGlpiUserByLogin(login: string): Promise<GlpiUserMatch> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const normalized = login.trim();
  if (!normalized) return { outcome: "not-found", login };

  const query = buildSearchQuery(
    [{ field: USER_SEARCH_OPTION.login, searchtype: "contains", value: normalized }],
    [USER_SEARCH_OPTION.id, USER_SEARCH_OPTION.login],
    "0-49",
  );
  const result = await glpiCall(cfg, "GET", `search/User?${query}`);
  if (glpiErrorCode(result) === "ERROR_RANGE_EXCEED_TOTAL") {
    recordPoll(true);
    return { outcome: "not-found", login: normalized };
  }
  if (result.status < 200 || result.status >= 300) {
    throw new GlpiError(describeGlpiError(cfg, result, "la recherche du compte utilisateur"), result.status);
  }
  recordPoll(true);

  // `contains` ramène aussi des sur-chaînes (chercher "banas" renvoie aussi "adminbanas") : seule
  // une égalité de la chaîne ENTIÈRE est retenue. Un candidat dont le login n'est pas renvoyé est
  // écarté — impossible de prouver l'égalité, donc on ne l'accepte pas.
  const candidates = searchRows(result.data as GlpiSearchResponse | null)
    .map(({ key, row }) => ({
      id: rowNumber(row, USER_SEARCH_OPTION.id, key),
      name: rowString(row, USER_SEARCH_OPTION.login),
    }))
    .filter((c): c is { id: number; name: string } => c.id !== undefined && c.name !== undefined);

  const target = normalized.toLowerCase();
  const retained = candidates.filter((c) => c.name.toLowerCase() === target);
  if (retained.length === 0) return { outcome: "not-found", login: normalized };
  if (retained.length > 1) return { outcome: "ambiguous", login: normalized, candidateIds: retained.map((c) => c.id) };
  return { outcome: "found", userId: retained[0]!.id, login: normalized };
}

// --- Lecture des tickets ---

function openStatusCriteria(): SearchCriterion[] {
  return [
    { link: "AND", field: TICKET_SEARCH_OPTION.status, searchtype: "notequals", value: String(STATUS_SOLVED) },
    { link: "AND", field: TICKET_SEARCH_OPTION.status, searchtype: "notequals", value: String(STATUS_CLOSED) },
  ];
}

/** Tickets dont `userId` est le DEMANDEUR (option de recherche "Requester"). */
export async function listGlpiTicketsForUser(userId: number, options: { openOnly?: boolean } = {}): Promise<GlpiTicketSummary[]> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const criteria: SearchCriterion[] = [
    { field: TICKET_SEARCH_OPTION.requester, searchtype: "equals", value: String(userId) },
    ...(options.openOnly ? openStatusCriteria() : []),
  ];
  try {
    const tickets = await searchTickets(cfg, criteria, MAX_TICKETS_RANGE);
    recordPoll(true);
    return tickets;
  } catch (err) {
    recordPoll(false);
    throw err;
  }
}

interface GlpiTicketItem {
  id?: number;
  name?: string;
  content?: string;
  status?: number | string;
  date?: string;
  date_mod?: string;
  solvedate?: string | null;
  closedate?: string | null;
}

interface GlpiFollowupItem {
  id?: number;
  content?: string;
  date?: string;
  users_id?: number;
  is_private?: number | boolean;
}

interface GlpiTicketUserItem {
  users_id?: number;
  type?: number;
}

/** Acteurs d'un ticket (`GET /Ticket/:id/Ticket_User`) — sert UNIQUEMENT au contrôle d'accès. */
async function getTicketRequesterIds(cfg: SetupGlpiConfig, ticketId: number): Promise<number[]> {
  const data = await glpiCallOk(cfg, "GET", `Ticket/${ticketId}/Ticket_User`, "la lecture des demandeurs du ticket");
  if (!Array.isArray(data)) return [];
  return (data as GlpiTicketUserItem[])
    .filter((entry) => Number(entry.type) === ACTOR_REQUESTER && typeof entry.users_id === "number")
    .map((entry) => entry.users_id!);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Détail d'un ticket + ses suivis, RÉSERVÉ à un demandeur : `userId` doit figurer parmi les
 * acteurs de type REQUESTER côté GLPI, sinon `null` (l'appelant répond 404 sans révéler
 * l'existence du ticket).
 */
export async function getGlpiTicketForUser(userId: number, ticketId: number): Promise<GlpiTicketDetail | null> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  try {
    const requesterIds = await getTicketRequesterIds(cfg, ticketId);
    if (!requesterIds.includes(userId)) {
      recordPoll(true);
      return null;
    }
    const [ticketData, followupData] = await Promise.all([
      glpiCallOk(cfg, "GET", `Ticket/${ticketId}`, "la lecture du ticket"),
      glpiCallOk(cfg, "GET", `Ticket/${ticketId}/ITILFollowup`, "la lecture des suivis du ticket"),
    ]);
    recordPoll(true);

    const ticket = (ticketData ?? {}) as GlpiTicketItem;
    const status = toNumber(ticket.status);
    const followups: GlpiFollowup[] = (Array.isArray(followupData) ? (followupData as GlpiFollowupItem[]) : [])
      .filter((f) => typeof f.id === "number")
      .map((f) => ({
        id: f.id!,
        content: f.content ?? "",
        ...(f.date ? { date: f.date } : {}),
        ...(typeof f.users_id === "number" ? { authorId: f.users_id } : {}),
        ...(f.is_private !== undefined ? { isPrivate: Boolean(Number(f.is_private)) } : {}),
      }));

    return {
      id: toNumber(ticket.id) ?? ticketId,
      title: ticket.name ?? `Ticket ${ticketId}`,
      content: ticket.content ?? "",
      ...(status !== undefined ? { status } : {}),
      ...(status !== undefined && STATUS_LABELS[status] ? { statusLabel: STATUS_LABELS[status] } : {}),
      ...(ticket.date ? { openedAt: ticket.date } : {}),
      ...(ticket.date_mod ? { updatedAt: ticket.date_mod } : {}),
      ...(ticket.solvedate ? { solvedAt: ticket.solvedate } : {}),
      ...(ticket.closedate ? { closedAt: ticket.closedate } : {}),
      followups,
    };
  } catch (err) {
    if (err instanceof GlpiError && err.status !== undefined && err.status >= 400 && err.status < 500) throw err;
    recordPoll(false);
    throw err;
  }
}

// --- Écriture (périmètre strict : créer / suivre / résoudre) ---

interface AddItemResponse {
  id?: number | false;
  message?: string;
}

/** `POST /:itemtype` → 201 `{ "id": 15 }` (apirest.md). */
async function addItem(cfg: SetupGlpiConfig, itemtype: string, input: Record<string, unknown>, what: string): Promise<number> {
  const data = await glpiCallOk(cfg, "POST", itemtype, what, { input });
  const payload = (Array.isArray(data) ? data[0] : data) as AddItemResponse | null;
  const id = payload?.id;
  if (typeof id !== "number") {
    throw new GlpiError(redactSecrets(`GLPI n'a pas renvoyé d'identifiant après ${what}${payload?.message ? ` : ${payload.message}` : ""}`, cfg));
  }
  return id;
}

/** Ajoute un suivi à un ticket (`POST /ITILFollowup`). */
export async function addGlpiFollowup(ticketId: number, content: string, requesterUserId?: number): Promise<number> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const input: Record<string, unknown> = { itemtype: "Ticket", items_id: ticketId, content };
  if (requesterUserId !== undefined) input.users_id = requesterUserId;
  const id = await addItem(cfg, "ITILFollowup", input, "l'ajout d'un suivi");
  recordPoll(true);
  return id;
}

/** Ajoute un suivi AU NOM de l'utilisateur QUAI connecté, après avoir vérifié qu'il est bien
 * demandeur du ticket (`null` sinon — l'appelant répond 404). */
export async function addGlpiFollowupForUser(userId: number, ticketId: number, content: string): Promise<number | null> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const requesterIds = await getTicketRequesterIds(cfg, ticketId);
  if (!requesterIds.includes(userId)) return null;
  return await addGlpiFollowup(ticketId, content, userId);
}

export interface CreateGlpiTicketInput {
  title: string;
  content: string;
  requesterUserId?: number;
}

/** Crée un ticket (`POST /Ticket`) — seuls name/content/_users_id_requester sont envoyés. */
export async function createGlpiTicket(input: CreateGlpiTicketInput): Promise<number> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const payload: Record<string, unknown> = { name: input.title, content: input.content };
  if (input.requesterUserId !== undefined) payload._users_id_requester = input.requesterUserId;
  const id = await addItem(cfg, "Ticket", payload, "la création d'un ticket");
  recordPoll(true);
  return id;
}

/**
 * SEULE mutation possible d'un ticket existant : `PUT /Ticket/:id` avec `{ input: { id, status: 5 } }`.
 * Aucun autre champ n'est accepté par cette fonction — pas de paramètre "champs libres", donc pas
 * de chemin de code capable de modifier autre chose (voir en-tête de fichier).
 */
export async function markGlpiTicketSolved(ticketId: number): Promise<void> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  await glpiCallOk(cfg, "PUT", `Ticket/${ticketId}`, "le passage du ticket en résolu", {
    input: { id: ticketId, status: STATUS_SOLVED },
  });
  recordPoll(true);
}

// --- Anti-doublon : empreinte stable d'incident ---

const FINGERPRINT_PREFIX = "QUAI-INCIDENT";

/** Empreinte STABLE d'un incident : sha256(ressource + type d'alerte), tronquée. Deux occurrences
 * du même incident produisent toujours la même empreinte, quelle que soit la formulation du titre. */
export function incidentFingerprint(key: GlpiIncidentKey): string {
  return createHash("sha256")
    .update(`${key.resource.trim().toLowerCase()} ${key.alertType.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

/** Ligne technique portée par le contenu du ticket — c'est ELLE qu'on recherche pour l'anti-doublon. */
export function incidentMarker(fingerprint: string): string {
  return `[${FINGERPRINT_PREFIX}:${fingerprint}]`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Contenu d'un ticket créé automatiquement : contexte RÉEL disponible + ligne d'empreinte. */
function buildIncidentContent(context: GlpiIncidentContext, fingerprint: string): string {
  const lines = [
    "Ticket ouvert automatiquement par QUAI (supervision).",
    "",
    `Ressource : ${escapeHtml(context.resource)}`,
    `Type d'alerte : ${escapeHtml(context.alertType)}`,
    `Détecté le : ${escapeHtml(context.occurredAt ?? new Date().toISOString())}`,
  ];
  if (context.details) lines.push(`Détail : ${escapeHtml(context.details)}`);
  // Lien de retour seulement s'il existe RÉELLEMENT une URL publique configurée — jamais fabriqué.
  if (context.backUrl) lines.push(`Voir dans QUAI : ${escapeHtml(context.backUrl)}`);
  lines.push("", `${incidentMarker(fingerprint)} (empreinte technique — ne pas retirer, sert à éviter les doublons)`);
  return lines.join("\n");
}

/** Ticket OUVERT (ni résolu ni clos) portant l'empreinte donnée — `null` si aucun. */
export async function findOpenIncidentTicket(key: GlpiIncidentKey): Promise<GlpiTicketSummary | null> {
  const cfg = await loadGlpiConfig();
  if (!cfg) throw new GlpiNotConfiguredError();
  const marker = incidentMarker(incidentFingerprint(key));
  const criteria: SearchCriterion[] = [
    { field: TICKET_SEARCH_OPTION.content, searchtype: "contains", value: marker },
    ...openStatusCriteria(),
  ];
  const tickets = await searchTickets(cfg, criteria, 50);
  recordPoll(true);
  if (tickets.length === 0) return null;
  // Le plus ancien fait foi : c'est le ticket d'origine de l'incident, les éventuels autres
  // (créés avant la mise en place de l'empreinte, ou en cas de course) reçoivent juste leurs
  // occurrences ailleurs — on n'en crée jamais un de plus.
  return tickets.reduce((oldest, t) => (t.id < oldest.id ? t : oldest), tickets[0]!);
}

/**
 * ANTI-DOUBLON — point d'entrée unique pour signaler un incident :
 *  - un ticket OUVERT portant la même empreinte existe -> suivi "+1 occurrence" ;
 *  - sinon -> création d'un ticket portant l'empreinte.
 */
export async function reportGlpiIncident(
  context: GlpiIncidentContext,
): Promise<Extract<GlpiIncidentReport, { action: "created" | "followup" }>> {
  const fingerprint = incidentFingerprint(context);
  const existing = await findOpenIncidentTicket(context);
  const occurredAt = context.occurredAt ?? new Date().toISOString();
  if (existing) {
    const lines = [
      `+1 occurrence de la même alerte (détectée le ${escapeHtml(occurredAt)}).`,
      `Ressource : ${escapeHtml(context.resource)}`,
      `Type d'alerte : ${escapeHtml(context.alertType)}`,
    ];
    if (context.details) lines.push(`Détail : ${escapeHtml(context.details)}`);
    lines.push(incidentMarker(fingerprint));
    await addGlpiFollowup(existing.id, lines.join("\n"));
    return { action: "followup", ticketId: existing.id, fingerprint };
  }
  const ticketId = await createGlpiTicket({
    title: context.title,
    content: buildIncidentContent({ ...context, occurredAt }, fingerprint),
  });
  return { action: "created", ticketId, fingerprint };
}

/**
 * Résolution automatique symétrique : si un ticket ouvert porte l'empreinte, on ajoute un suivi
 * "l'alerte a disparu" PUIS on le passe en résolu. Aucun ticket correspondant -> "none" (jamais
 * une écriture au hasard).
 */
export async function resolveGlpiIncident(
  key: GlpiIncidentKey,
  resolvedAt?: string,
): Promise<Extract<GlpiIncidentReport, { action: "resolved" | "none" }>> {
  const fingerprint = incidentFingerprint(key);
  const existing = await findOpenIncidentTicket(key);
  if (!existing) return { action: "none", fingerprint };
  const at = resolvedAt ?? new Date().toISOString();
  await addGlpiFollowup(
    existing.id,
    [
      `L'alerte a disparu : QUAI ne détecte plus l'incident (constaté le ${escapeHtml(at)}).`,
      `Ressource : ${escapeHtml(key.resource)}`,
      `Type d'alerte : ${escapeHtml(key.alertType)}`,
      incidentMarker(fingerprint),
    ].join("\n"),
  );
  await markGlpiTicketSolved(existing.id);
  return { action: "resolved", ticketId: existing.id, fingerprint };
}

// --- Action d'automatisation "Créer un ticket GLPI" ---

/** Reconnaît une config d'action GLPI dans un `actionConfig` non typé (l'union de types.ts n'est
 * pas modifiée par cette intégration) — `null` pour toute autre action. */
export function asGlpiAutomationAction(cfg: unknown): GlpiAutomationActionConfig | null {
  if (typeof cfg !== "object" || cfg === null) return null;
  const candidate = cfg as { kind?: unknown; title?: unknown };
  if (candidate.kind !== "create-glpi-ticket") return null;
  return {
    kind: "create-glpi-ticket",
    ...(typeof candidate.title === "string" && candidate.title.trim() ? { title: candidate.title.trim() } : {}),
  };
}

/** Contexte RÉEL fourni par le moteur d'automatisation (services/automationEngine.ts). */
export interface GlpiAutomationContext {
  /** Ressource surveillée, telle que câblée dans le déclencheur (id de nœud de topologie ou de
   * route de reverse proxy) — jamais une valeur inventée. */
  resource: string;
  alertType: string;
  triggerLabel: string;
  occurredAt: string;
}

/** Lien de retour vers QUAI — uniquement si une URL publique est RÉELLEMENT configurée. */
function quaiBackUrl(context: GlpiAutomationContext): string | undefined {
  const base = config.glpi.quaiBaseUrl;
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/automation?resource=${encodeURIComponent(context.resource)}`;
}

/** Exécute l'action d'automatisation GLPI, anti-doublon compris. Ne lève jamais : renvoie le
 * même contrat `{ ok, message }` que les autres actions du moteur. */
export async function runGlpiAutomationAction(
  action: GlpiAutomationActionConfig,
  context: GlpiAutomationContext,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (!(await isGlpiConfigured())) {
      return { ok: false, message: "GLPI n'est pas configuré : aucun ticket créé" };
    }
    const backUrl = quaiBackUrl(context);
    const report = await reportGlpiIncident({
      resource: context.resource,
      alertType: context.alertType,
      title: action.title ?? `[QUAI] ${context.triggerLabel} — ${context.alertType}`,
      details: `Déclencheur QUAI "${context.triggerLabel}" passé en échec.`,
      occurredAt: context.occurredAt,
      ...(backUrl ? { backUrl } : {}),
    });
    if (report.action === "followup") {
      return { ok: true, message: `Ticket GLPI ${report.ticketId} déjà ouvert pour cet incident : suivi "+1 occurrence" ajouté` };
    }
    return { ok: true, message: `Ticket GLPI ${report.ticketId} créé` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
