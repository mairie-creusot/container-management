/**
 * Intégration PBX 3CX (VM "HDV3CX") via son XAPI — service OData exposé sous `/xapi/v1`. Deux voies
 * d'authentification, au choix (SetupThreecxConfig.authMode), pour le MÊME en-tête
 * `Authorization: Bearer` sur `/xapi/v1` :
 *  - "client-credentials" : OAuth2 client credentials sur `{base}/connect/token` (ClientID = DN d'un
 *    point de routage créé dans Admin Console → Integrations > API, + clé API).
 *  - "user" : `POST {base}/webclient/api/Login/GetAccessToken` avec `{ Username, Password,
 *    SecurityCode }` → `{ Status: "AuthSuccess", Token: { token_type, expires_in, access_token,
 *    refresh_token } }`. Forme relevée sur les exemples publics luxzg/3CX-XAPI_examples et le fil
 *    3cx.com/community/threads/help-getting-the-api-token-on-v20-build-1620.125285 — aucun champ
 *    au-delà n'est supposé, et un `access_token` absent/vide est une ERREUR, jamais un jeton vide.
 *
 * LECTURE SEULE STRICTE : ce module n'émet QUE des GET vers /xapi/v1 (+ le POST d'authentification).
 * Le XAPI expose des actions destructrices sur la téléphonie EN SERVICE de
 * la mairie — `POST /ActiveCalls({Id})/Pbx.DropCall` (raccrocher), `POST /Users/Pbx.MakeCall`
 * (décrocher/appeler), `POST /Services/Pbx.Stop` (arrêter le PBX) — AUCUNE n'est implémentée ici
 * et aucune ne doit l'être sans mission explicite.
 *
 * Source d'autorité des chemins et des noms de champs : swagger officiel
 * https://raw.githubusercontent.com/3cx/xapi-tutorial/master/swagger.yaml (analysé le 19/08/2026,
 * openapi 3.0.4, `servers: [{ url: /xapi/v1 }]`). Rien n'est deviné :
 *  - `GET /ActiveCalls` → Pbx.ActiveCallCollectionResponse `{ "@odata.count"?, value: [...] }`,
 *    entité Pbx.ActiveCall = { Id: int32, Caller: string?, Callee: string?, Status: string?,
 *    EstablishedAt: date-time?, LastChangeStatus: date-time?, ServerNow: date-time? }. Il n'existe
 *    NI tableau de participants, NI nom d'interlocuteur, NI durée dans le schéma : les
 *    participants sont dérivés de Caller/Callee, la durée est CALCULÉE (ServerNow - EstablishedAt,
 *    horloge du PBX, jamais celle de QUAI), le nom est résolu par jointure avec /Users.
 *  - `GET /Users` → Pbx.User (hérite Pbx.ClickToCall → Pbx.DN : Id, Number) : Number, DisplayName,
 *    FirstName, LastName, IsRegistered, Enabled, Internal, CurrentProfileName (profil de présence),
 *    QueueStatus (Pbx.QueueStatusType = LoggedOut | LoggedIn).
 *  - `GET /Queues` → Pbx.Queue : Id, Number, Name, IsRegistered, PollingStrategy, MaxCallersInQueue.
 *  - `GET /SystemStatus` (singleton) → Pbx.SystemStatus : Version, FQDN, CallsActive,
 *    ExtensionsRegistered, ExtensionsTotal, TrunksRegistered, TrunksTotal, MaxSimCalls, Activated.
 *  - Erreurs : Pbx.ODataErrors.ODataError `{ error: { code, message, ... } }`.
 *
 * Pbx.User expose AccessPassword/AuthPassword/DeskphonePassword/VMPIN et Pbx.SystemStatus expose
 * LicenseKey : les requêtes utilisent `$select` pour que le PBX ne les envoie MÊME PAS, et le
 * mapping ne recopie qu'une liste blanche de champs.
 *
 * Contrainte réelle du XAPI : UN SEUL jeton actif à la fois par instance. Le jeton est donc mis en
 * cache en mémoire process et réutilisé ; il n'est redemandé qu'à son expiration ou sur un 401.
 * Deux appels concurrents partagent la même demande de jeton en vol (sinon le second invaliderait
 * le premier).
 *
 * Deux échecs qui n'ont RIEN à voir sont distingués et ne doivent jamais être confondus :
 *  - REFUS D'ACCÈS (`accessError`) : 401/403, jeton rejeté, authentification refusée. C'est le seul
 *    cas qui relève d'une licence 3CX Enterprise absente ou de droits insuffisants.
 *  - ERREUR RENVOYÉE PAR LE PBX (`pbxError`) : 400 de validation OData, 404, 5xx, réponse illisible.
 *    Le PBX a traité la requête et l'a rejetée sur son contenu — aucun rapport avec la licence.
 * Dans les deux cas le message du PBX est remonté TEL QUEL, jamais reformulé ni masqué.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { config } from "../config.js";
import { getEffectiveThreecxConfig } from "./setupStore.js";
import type { SetupThreecxConfig, ThreecxAuthMode } from "./setupStore.js";

/** Un interlocuteur d'un appel en cours — dérivé de Pbx.ActiveCall.Caller/Callee (le schéma XAPI
 * n'expose aucun tableau de participants). */
export interface ThreecxCallParticipant {
  /** Chaîne BRUTE renvoyée par le PBX (Caller ou Callee) — le XAPI ne garantit pas un numéro nu. */
  number: string;
  direction: "caller" | "callee";
  /** DisplayName du poste dont le `Number` est EXACTEMENT égal à `number` (jointure /Users) —
   * absent si aucun poste ne correspond : jamais un nom approché. */
  name?: string;
}

export interface ThreecxActiveCall {
  /** Pbx.ActiveCall.Id (int32) rendu en chaîne. */
  id: string;
  /** Pbx.ActiveCall.EstablishedAt — absent tant que l'appel n'est pas établi (sonnerie). */
  startedAt?: string;
  participants: ThreecxCallParticipant[];
  /** CALCULÉ : ServerNow - EstablishedAt (horloge du PBX). Absent si l'un des deux manque. */
  durationSeconds?: number;
  /** Pbx.ActiveCall.Status — chaîne libre côté XAPI (aucune énumération dans le swagger). */
  status?: string;
  /** Pbx.ActiveCall.LastChangeStatus. */
  lastChangeAt?: string;
}

export interface ThreecxExtension {
  /** Pbx.DN.Id. */
  id: number;
  /** Pbx.DN.Number — le numéro de poste. */
  number: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  /** Pbx.User.IsRegistered — un poste enregistré est joignable (téléphone/app connecté). */
  registered?: boolean;
  enabled?: boolean;
  internal?: boolean;
  /** Pbx.User.CurrentProfileName — le profil de présence courant (libellé libre du PBX). */
  currentProfileName?: string;
  /** Pbx.User.QueueStatus — Pbx.QueueStatusType : "LoggedIn" | "LoggedOut". */
  queueStatus?: string;
}

export interface ThreecxQueue {
  id: number;
  number: string;
  name?: string;
  registered?: boolean;
  pollingStrategy?: string;
  maxCallersInQueue?: number;
}

/** Sous-ensemble NON sensible de Pbx.SystemStatus (LicenseKey/ProductCode/ResellerName exclus). */
export interface ThreecxSystemStatus {
  version?: string;
  fqdn?: string;
  activated?: boolean;
  callsActive?: number;
  maxSimCalls?: number;
  extensionsRegistered?: number;
  extensionsTotal?: number;
  trunksRegistered?: number;
  trunksTotal?: number;
}

export interface ThreecxStatusSummary {
  configured: boolean;
  /** Absent si jamais configuré. false = PBX injoignable (réseau/TLS/timeout). */
  reachable?: boolean;
  /** Message BRUT du PBX quand il a REFUSÉ L'ACCÈS (401/403, jeton rejeté, authentification
   * refusée) — le seul cas qui relève de la licence Enterprise ou des droits. Jamais masqué. */
  accessError?: string;
  /** Message BRUT du PBX quand il a répondu une ERREUR sans refuser l'accès (400 de validation
   * OData, 404, 5xx, réponse illisible). N'a AUCUN rapport avec la licence. */
  pbxError?: string;
  /** Résumé pour la carte du nœud — absents si injoignable/refusé/en erreur, jamais des zéros. */
  activeCallCount?: number;
  reachableExtensionCount?: number;
  extensionCount?: number;
  queueCount?: number;
  system?: ThreecxSystemStatus;
}

/** Enveloppe commune des routes de lecture — distingue "jamais configuré", "injoignable",
 * "accès refusé", "erreur renvoyée par le PBX" et "réellement vide". */
export interface ThreecxReadResult<T> {
  configured: boolean;
  reachable?: boolean;
  /** Refus d'accès UNIQUEMENT (401/403, authentification refusée). */
  accessError?: string;
  /** Erreur renvoyée par le PBX qui n'est pas un refus d'accès (400 OData, 404, 5xx, illisible). */
  pbxError?: string;
  items: T[];
}

/** Résultat interne d'un GET XAPI. `denied` est RÉSERVÉ au refus d'accès ; une erreur que le PBX
 * renvoie après avoir accepté la requête est un `pbx-error`, jamais un refus. */
type XapiOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "denied"; message: string }
  | { kind: "pbx-error"; message: string }
  | { kind: "unreachable"; message: string };

interface ODataCollection<E> {
  value?: E[];
  "@odata.count"?: number;
}

interface ODataErrorBody {
  error?: { code?: string; message?: string };
}

interface XapiActiveCall {
  Id?: number;
  Caller?: string | null;
  Callee?: string | null;
  Status?: string | null;
  EstablishedAt?: string | null;
  LastChangeStatus?: string | null;
  ServerNow?: string | null;
}

interface XapiUser {
  Id?: number;
  Number?: string | null;
  DisplayName?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  IsRegistered?: boolean | null;
  Enabled?: boolean | null;
  Internal?: boolean | null;
  CurrentProfileName?: string | null;
  QueueStatus?: string | null;
}

interface XapiQueue {
  Id?: number;
  Number?: string | null;
  Name?: string | null;
  IsRegistered?: boolean | null;
  PollingStrategy?: string | null;
  MaxCallersInQueue?: number | null;
}

interface XapiSystemStatus {
  Version?: string | null;
  FQDN?: string | null;
  Activated?: boolean | null;
  CallsActive?: number | null;
  MaxSimCalls?: number | null;
  ExtensionsRegistered?: number | null;
  ExtensionsTotal?: number | null;
  TrunksRegistered?: number | null;
  TrunksTotal?: number | null;
}

/** Champs demandés à /Users : liste blanche stricte — AccessPassword/AuthPassword/
 * DeskphonePassword/VMPIN existent dans Pbx.User et ne doivent jamais transiter. */
const USER_SELECT = "Id,Number,DisplayName,FirstName,LastName,IsRegistered,Enabled,Internal,CurrentProfileName,QueueStatus";
const QUEUE_SELECT = "Id,Number,Name,IsRegistered,PollingStrategy,MaxCallersInQueue";
/** Pbx.SystemStatus expose LicenseKey/ProductCode/ResellerName : jamais demandés. */
const SYSTEM_STATUS_SELECT = "Version,FQDN,Activated,CallsActive,MaxSimCalls,ExtensionsRegistered,ExtensionsTotal,TrunksRegistered,TrunksTotal";
/** 100 et pas plus : le PBX rejette en 400 tout $top supérieur ("The limit of '100' for Top query
 * has been exceeded" — constaté en conditions réelles le 21/08/2026 sur ville-lecreusot.on3cx.fr). */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** Marge avant expiration : le jeton est renouvelé un peu avant l'heure pour ne jamais l'utiliser
 * pendant qu'il expire côté PBX. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

function normalizedBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function tlsRejectUnauthorized(effective: SetupThreecxConfig): boolean {
  return effective.tlsRejectUnauthorized ?? config.threecx.tlsRejectUnauthorized;
}

/** Les secrets d'une config, quel que soit son mode — clé API ET mot de passe du compte 3CX. */
function configSecrets(cfg: { clientSecret?: string; password?: string }): string[] {
  return [cfg.clientSecret, cfg.password].filter((value): value is string => Boolean(value));
}

/** Retire toute occurrence des secrets d'un message avant qu'il ne parte vers une route ou un log —
 * filet de sécurité : aucun message construit ici n'interpole un secret, mais un message renvoyé
 * PAR le PBX pourrait le répéter. */
function scrubSecrets(message: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("***") : acc), message);
}

function authModeOf(cfg: SetupThreecxConfig): ThreecxAuthMode {
  return cfg.authMode === "user" ? "user" : "client-credentials";
}

interface RawHttpResponse {
  status: number;
  raw: string;
}

/** Requête HTTP brute — `node:http`/`node:https` plutôt que `fetch` pour piloter la vérification
 * TLS pour CETTE connexion uniquement (même mécanisme que nutanix.ts/hycu.ts) et poser un timeout. */
async function rawRequest(
  target: URL,
  options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; rejectUnauthorized: boolean },
): Promise<RawHttpResponse> {
  const isHttps = target.protocol === "https:";
  const send = isHttps ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: options.method,
        headers: options.headers,
        ...(isHttps ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
        timeout: config.threecx.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`3CX ${options.method} ${target.pathname} timed out after ${config.threecx.requestTimeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function parseJson<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Message d'erreur du PBX tel qu'il l'écrit (Pbx.ODataErrors.ODataError), sinon le corps brut
 * tronqué — jamais une reformulation qui masquerait un refus de licence. */
function pbxErrorMessage(status: number, raw: string): string {
  const body = parseJson<ODataErrorBody>(raw);
  const message = body?.error?.message?.trim();
  const code = body?.error?.code?.trim();
  if (message) return code ? `${message} (code ${code}, HTTP ${status})` : `${message} (HTTP ${status})`;
  const trimmed = raw.trim();
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`;
}

interface CachedToken {
  fingerprint: string;
  accessToken: string;
  expiresAtMs: number;
  /** Uniquement en mode "user" et uniquement si le PBX en a renvoyé un — jamais fabriqué. */
  refreshToken?: string;
}

type TokenAttempt =
  | { ok: true; accessToken: string; expiresInSeconds: number; refreshToken?: string }
  | { ok: false; message: string; denied: boolean };

let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<{ ok: true; accessToken: string } | { ok: false; message: string; denied: boolean }> | null = null;
/** Passe à false au PREMIER échec d'un renouvellement par refresh_token : aucun point de
 * renouvellement n'est documenté pour GetAccessToken, inutile d'y revenir à chaque expiration. */
let refreshTokenUsable = true;

/** Identité de la config (URL + mode + identifiants) : changer l'un d'eux invalide le jeton en
 * cache sans jamais comparer les secrets ailleurs. */
function configFingerprint(effective: SetupThreecxConfig): string {
  const parts = [effective.baseUrl, authModeOf(effective), effective.clientId, effective.clientSecret, effective.username, effective.password];
  return parts.map((part) => part ?? "").join(" ");
}

/** Oublie le jeton en cache (401, changement de config) — la prochaine requête en redemandera un. */
function clearToken(): void {
  cachedToken = null;
  tokenInFlight = null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Réponse de /webclient/api/Login/GetAccessToken — seuls les champs RÉELLEMENT observés y figurent. */
interface WebclientLoginResponse {
  Status?: string | null;
  Token?: TokenResponse | null;
}

const AUTH_SUCCESS = "AuthSuccess";

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** POST {base}/connect/token — client credentials. Ne journalise rien et n'interpole jamais le
 * secret dans un message d'erreur. */
async function requestClientCredentialsToken(effective: SetupThreecxConfig): Promise<TokenAttempt> {
  const secrets = configSecrets(effective);
  const target = new URL("connect/token", normalizedBaseUrl(effective.baseUrl));
  const body = new URLSearchParams({
    client_id: effective.clientId ?? "",
    client_secret: effective.clientSecret ?? "",
    grant_type: "client_credentials",
  }).toString();

  let response: RawHttpResponse;
  try {
    response = await rawRequest(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
      rejectUnauthorized: tlsRejectUnauthorized(effective),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    return { ok: false, message: `PBX 3CX injoignable : ${message}`, denied: false };
  }

  const parsed = parseJson<TokenResponse>(response.raw);
  if (response.status < 200 || response.status >= 300 || !parsed?.access_token) {
    const detail = parsed?.error_description?.trim() || parsed?.error?.trim() || response.raw.trim().slice(0, 300);
    const message = detail
      ? `3CX a refusé l'authentification (HTTP ${response.status}) : ${detail}`
      : `3CX a refusé l'authentification (HTTP ${response.status})`;
    return { ok: false, message: scrubSecrets(message, secrets), denied: response.status >= 400 && response.status < 500 };
  }
  return { ok: true, accessToken: parsed.access_token, expiresInSeconds: positiveSeconds(parsed.expires_in, 3600) };
}

/**
 * POST {base}/webclient/api/Login/GetAccessToken — identifiant + mot de passe d'une extension
 * disposant des droits propriétaire système. Le mot de passe n'apparaît QUE dans le corps de cette
 * requête : il n'est ni journalisé, ni interpolé dans un message, et tout message venant du PBX est
 * nettoyé avant de sortir.
 */
async function requestUserToken(effective: SetupThreecxConfig): Promise<TokenAttempt> {
  const secrets = configSecrets(effective);
  const target = new URL("webclient/api/Login/GetAccessToken", normalizedBaseUrl(effective.baseUrl));
  const body = JSON.stringify({ Username: effective.username ?? "", Password: effective.password ?? "", SecurityCode: "" });

  let response: RawHttpResponse;
  try {
    response = await rawRequest(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
      rejectUnauthorized: tlsRejectUnauthorized(effective),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    return { ok: false, message: `PBX 3CX injoignable : ${message}`, denied: false };
  }

  const parsed = parseJson<WebclientLoginResponse>(response.raw);
  const status = typeof parsed?.Status === "string" ? parsed.Status.trim() : "";
  const accessToken = typeof parsed?.Token?.access_token === "string" ? parsed.Token.access_token.trim() : "";
  const httpOk = response.status >= 200 && response.status < 300;

  // Jamais de jeton vide utilisé en silence : HTTP d'échec, Status ≠ AuthSuccess, ou access_token absent = erreur.
  if (!httpOk || !accessToken || (status !== "" && status !== AUTH_SUCCESS)) {
    const detail = response.raw.trim().slice(0, 300) || (status ? `Status ${status}` : "");
    const message = detail
      ? `3CX a refusé l'authentification par identifiant (HTTP ${response.status}) : ${detail}`
      : `3CX a refusé l'authentification par identifiant (HTTP ${response.status})`;
    return { ok: false, message: scrubSecrets(message, secrets), denied: httpOk || (response.status >= 400 && response.status < 500) };
  }

  const refreshToken = typeof parsed?.Token?.refresh_token === "string" ? parsed.Token.refresh_token.trim() : "";
  // `expires_in` vaut 60 sur les exemples publics et 3CX parle de « 60 minutes » : lu en SECONDES (OAuth2), sous-estimer est sans risque.
  return {
    ok: true,
    accessToken,
    expiresInSeconds: positiveSeconds(parsed?.Token?.expires_in, 3600),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/**
 * Renouvellement par refresh_token sur le point de terminaison OAuth2 du PBX. Aucun endpoint de
 * rafraîchissement propre à GetAccessToken n'est documenté : la tentative est faite UNE fois, et
 * tout échec (réseau, refus, réponse inattendue) renvoie `null` → login complet en repli.
 */
async function refreshUserToken(effective: SetupThreecxConfig, refreshToken: string): Promise<TokenAttempt | null> {
  const target = new URL("connect/token", normalizedBaseUrl(effective.baseUrl));
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString();

  let response: RawHttpResponse;
  try {
    response = await rawRequest(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
      rejectUnauthorized: tlsRejectUnauthorized(effective),
    });
  } catch {
    return null;
  }

  const parsed = parseJson<TokenResponse>(response.raw);
  const accessToken = typeof parsed?.access_token === "string" ? parsed.access_token.trim() : "";
  if (response.status < 200 || response.status >= 300 || !accessToken) return null;
  const nextRefresh = typeof parsed?.refresh_token === "string" ? parsed.refresh_token.trim() : "";
  return {
    ok: true,
    accessToken,
    expiresInSeconds: positiveSeconds(parsed?.expires_in, 3600),
    ...(nextRefresh ? { refreshToken: nextRefresh } : { refreshToken }),
  };
}

function requestToken(effective: SetupThreecxConfig): Promise<TokenAttempt> {
  return authModeOf(effective) === "user" ? requestUserToken(effective) : requestClientCredentialsToken(effective);
}

/**
 * Jeton valide, RÉUTILISÉ tant qu'il n'a pas expiré — le XAPI n'accepte qu'un seul jeton actif par
 * instance, en redemander un à chaque appel invaliderait celui déjà en circulation. `forceRenew`
 * n'est utilisé que sur un 401.
 */
async function getAccessToken(
  effective: SetupThreecxConfig,
  forceRenew = false,
): Promise<{ ok: true; accessToken: string } | { ok: false; message: string; denied: boolean }> {
  const fingerprint = configFingerprint(effective);
  if (cachedToken && cachedToken.fingerprint !== fingerprint) clearToken();
  if (forceRenew) clearToken();

  if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
    return { ok: true, accessToken: cachedToken.accessToken };
  }
  if (tokenInFlight) return await tokenInFlight;

  // Jeton périmé conservé le temps du renouvellement : c'est lui qui porte le refresh_token.
  const expired = cachedToken;

  tokenInFlight = (async () => {
    let result: TokenAttempt | null = null;
    if (authModeOf(effective) === "user" && expired?.refreshToken && refreshTokenUsable) {
      result = await refreshUserToken(effective, expired.refreshToken);
      if (result === null) refreshTokenUsable = false;
    }
    if (result === null) result = await requestToken(effective);
    if (!result.ok) return { ok: false as const, message: result.message, denied: result.denied };
    cachedToken = {
      fingerprint,
      accessToken: result.accessToken,
      expiresAtMs: Date.now() + Math.max(result.expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS, 1000),
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    };
    return { ok: true as const, accessToken: result.accessToken };
  })().finally(() => {
    tokenInFlight = null;
  });

  return await tokenInFlight;
}

/** Un refus d'ACCÈS, et rien d'autre : le PBX rejette le porteur du jeton. Tout autre code renvoyé
 * par le PBX (400 de validation, 404, 5xx) est une erreur de requête, pas un problème de droits. */
function isAccessDenialStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** GET /xapi/v1/<resource> avec le jeton en cache ; un 401 déclenche UN renouvellement puis UN
 * seul réessai (jamais de boucle). */
async function xapiGet<T>(effective: SetupThreecxConfig, resource: string): Promise<XapiOutcome<T>> {
  const target = new URL(`xapi/v1/${resource.replace(/^\//, "")}`, normalizedBaseUrl(effective.baseUrl));

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(effective, attempt > 0);
    if (!token.ok) {
      return token.denied ? { kind: "denied", message: token.message } : { kind: "unreachable", message: token.message };
    }

    let response: RawHttpResponse;
    try {
      response = await rawRequest(target, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token.accessToken}` },
        rejectUnauthorized: tlsRejectUnauthorized(effective),
      });
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err), configSecrets(effective));
      return { kind: "unreachable", message: `PBX 3CX injoignable : ${message}` };
    }

    if (response.status === 401 && attempt === 0) {
      clearToken();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      // Message brut du PBX dans les deux cas ; seul 401/403 est un refus d'accès (licence, droits).
      const message = scrubSecrets(pbxErrorMessage(response.status, response.raw), configSecrets(effective));
      return isAccessDenialStatus(response.status) ? { kind: "denied", message } : { kind: "pbx-error", message };
    }
    const data = parseJson<T>(response.raw);
    if (data === null) {
      // Le PBX a accepté la requête et répondu 2xx : illisible n'est pas un refus d'accès.
      return { kind: "pbx-error", message: `3CX a renvoyé une réponse illisible pour GET /xapi/v1/${resource}` };
    }
    return { kind: "ok", data };
  }
  return { kind: "denied", message: "3CX a refusé le jeton (401) même après renouvellement" };
}

/** Collection OData paginée ($top/$skip) — s'arrête sur une page incomplète ou sur @odata.count. */
async function xapiList<E>(effective: SetupThreecxConfig, resource: string, query: string): Promise<XapiOutcome<E[]>> {
  const items: E[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = query ? "&" : "";
    const outcome = await xapiGet<ODataCollection<E>>(effective, `${resource}?${query}${sep}$top=${PAGE_SIZE}&$skip=${page * PAGE_SIZE}`);
    if (outcome.kind !== "ok") return outcome;
    const value = outcome.data.value ?? [];
    items.push(...value);
    if (value.length < PAGE_SIZE) break;
    const total = outcome.data["@odata.count"];
    if (typeof total === "number" && items.length >= total) break;
  }
  return { kind: "ok", data: items };
}

/** Dernier essai RÉEL de poll 3CX — en mémoire process uniquement, même rôle exact que
 * hycu.ts#lastKnownHycuPoll : distinguer côté UI "aucun appel" de "PBX injoignable". */
export interface ThreecxPollOutcome {
  reachable: boolean;
  at: string;
}
let lastPollOutcome: ThreecxPollOutcome | null = null;
export function lastKnownThreecxPoll(): ThreecxPollOutcome | null {
  return lastPollOutcome;
}
function recordPoll(reachable: boolean): void {
  lastPollOutcome = { reachable, at: new Date().toISOString() };
}

/** Une config n'est utilisable que si les identifiants du MODE choisi sont présents. */
function isThreecxConfigComplete(cfg: SetupThreecxConfig): boolean {
  if (!cfg.baseUrl) return false;
  return authModeOf(cfg) === "user" ? Boolean(cfg.username && cfg.password) : Boolean(cfg.clientId && cfg.clientSecret);
}

/** Config 3CX effective si complète, sinon `null` — garde "jamais configuré". */
async function loadThreecxConfig(): Promise<SetupThreecxConfig | null> {
  const effective = await getEffectiveThreecxConfig();
  if (!effective || !isThreecxConfigComplete(effective)) return null;
  return effective;
}

/** true si le PBX 3CX a été explicitement configuré (URL + identifiants du mode choisi). */
export async function isThreecxConfigured(): Promise<boolean> {
  return (await loadThreecxConfig()) !== null;
}

function mapUser(user: XapiUser): ThreecxExtension | null {
  if (typeof user.Id !== "number" || !user.Number) return null;
  const fullName = [user.FirstName, user.LastName].filter((part): part is string => Boolean(part)).join(" ").trim();
  const displayName = user.DisplayName?.trim() || fullName;
  return {
    id: user.Id,
    number: user.Number,
    ...(displayName ? { displayName } : {}),
    ...(user.FirstName ? { firstName: user.FirstName } : {}),
    ...(user.LastName ? { lastName: user.LastName } : {}),
    ...(typeof user.IsRegistered === "boolean" ? { registered: user.IsRegistered } : {}),
    ...(typeof user.Enabled === "boolean" ? { enabled: user.Enabled } : {}),
    ...(typeof user.Internal === "boolean" ? { internal: user.Internal } : {}),
    ...(user.CurrentProfileName ? { currentProfileName: user.CurrentProfileName } : {}),
    ...(user.QueueStatus ? { queueStatus: user.QueueStatus } : {}),
  };
}

function mapQueue(queue: XapiQueue): ThreecxQueue | null {
  if (typeof queue.Id !== "number" || !queue.Number) return null;
  return {
    id: queue.Id,
    number: queue.Number,
    ...(queue.Name ? { name: queue.Name } : {}),
    ...(typeof queue.IsRegistered === "boolean" ? { registered: queue.IsRegistered } : {}),
    ...(queue.PollingStrategy ? { pollingStrategy: queue.PollingStrategy } : {}),
    ...(typeof queue.MaxCallersInQueue === "number" ? { maxCallersInQueue: queue.MaxCallersInQueue } : {}),
  };
}

function mapSystemStatus(status: XapiSystemStatus): ThreecxSystemStatus {
  return {
    ...(status.Version ? { version: status.Version } : {}),
    ...(status.FQDN ? { fqdn: status.FQDN } : {}),
    ...(typeof status.Activated === "boolean" ? { activated: status.Activated } : {}),
    ...(typeof status.CallsActive === "number" ? { callsActive: status.CallsActive } : {}),
    ...(typeof status.MaxSimCalls === "number" ? { maxSimCalls: status.MaxSimCalls } : {}),
    ...(typeof status.ExtensionsRegistered === "number" ? { extensionsRegistered: status.ExtensionsRegistered } : {}),
    ...(typeof status.ExtensionsTotal === "number" ? { extensionsTotal: status.ExtensionsTotal } : {}),
    ...(typeof status.TrunksRegistered === "number" ? { trunksRegistered: status.TrunksRegistered } : {}),
    ...(typeof status.TrunksTotal === "number" ? { trunksTotal: status.TrunksTotal } : {}),
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Un appel en cours normalisé — participants dérivés de Caller/Callee, durée calculée sur
 * l'horloge du PBX (ServerNow), nom résolu par jointure exacte sur le numéro de poste. */
function mapActiveCall(call: XapiActiveCall, nameByNumber: Map<string, string>): ThreecxActiveCall | null {
  if (typeof call.Id !== "number") return null;

  const participants: ThreecxCallParticipant[] = [];
  for (const [raw, direction] of [
    [call.Caller, "caller"],
    [call.Callee, "callee"],
  ] as const) {
    const value = raw?.trim();
    if (!value) continue;
    const name = nameByNumber.get(value);
    participants.push({ number: value, direction, ...(name ? { name } : {}) });
  }

  const establishedAtMs = parseTimestamp(call.EstablishedAt);
  const serverNowMs = parseTimestamp(call.ServerNow);
  const durationSeconds =
    establishedAtMs !== null && serverNowMs !== null ? Math.max(Math.round((serverNowMs - establishedAtMs) / 1000), 0) : undefined;

  return {
    id: String(call.Id),
    ...(call.EstablishedAt ? { startedAt: call.EstablishedAt } : {}),
    participants,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(call.Status ? { status: call.Status } : {}),
    ...(call.LastChangeStatus ? { lastChangeAt: call.LastChangeStatus } : {}),
  };
}

interface CachedDirectory {
  fingerprint: string;
  fetchedAtMs: number;
  nameByNumber: Map<string, string>;
}
let cachedDirectory: CachedDirectory | null = null;

/** Oublie jeton ET annuaire — appelé après un test de connexion (qui a demandé un nouveau jeton et
 * donc invalidé le précédent côté PBX : un seul jeton actif par instance) et quand la config est
 * retirée. */
export function resetThreecxCaches(): void {
  clearToken();
  cachedDirectory = null;
  refreshTokenUsable = true;
}

/**
 * Annuaire numéro → nom pour nommer les interlocuteurs, mis en cache (config.threecx.directoryCacheMs) :
 * /ActiveCalls est interrogé bien plus souvent que la liste des postes, qui ne bouge quasiment
 * jamais. Un échec renvoie un annuaire VIDE (appels sans nom) plutôt que de faire échouer le poll.
 */
async function getDirectory(effective: SetupThreecxConfig): Promise<Map<string, string>> {
  const fingerprint = configFingerprint(effective);
  if (cachedDirectory && cachedDirectory.fingerprint === fingerprint && Date.now() - cachedDirectory.fetchedAtMs < config.threecx.directoryCacheMs) {
    return cachedDirectory.nameByNumber;
  }
  const outcome = await xapiList<XapiUser>(effective, "Users", `$select=${USER_SELECT}`);
  if (outcome.kind !== "ok") return new Map();
  const nameByNumber = new Map<string, string>();
  for (const user of outcome.data) {
    const mapped = mapUser(user);
    if (mapped?.displayName) nameByNumber.set(mapped.number, mapped.displayName);
  }
  cachedDirectory = { fingerprint, fetchedAtMs: Date.now(), nameByNumber };
  return nameByNumber;
}

function notConfigured<T>(): ThreecxReadResult<T> {
  return { configured: false, items: [] };
}

function fromOutcome<E, T>(outcome: XapiOutcome<E>, map: (data: E) => T[]): ThreecxReadResult<T> {
  if (outcome.kind === "unreachable") {
    recordPoll(false);
    return { configured: true, reachable: false, items: [] };
  }
  if (outcome.kind === "denied") {
    // Le PBX a répondu : joignable, mais il refuse l'ACCÈS — message brut (licence, droits).
    recordPoll(true);
    return { configured: true, reachable: true, accessError: outcome.message, items: [] };
  }
  if (outcome.kind === "pbx-error") {
    // Le PBX a traité la requête et l'a rejetée sur son contenu : ce n'est PAS un refus d'accès.
    recordPoll(true);
    return { configured: true, reachable: true, pbxError: outcome.message, items: [] };
  }
  recordPoll(true);
  return { configured: true, reachable: true, items: map(outcome.data) };
}

/**
 * Appels EN COURS — GET /xapi/v1/ActiveCalls (le besoin principal : qui parle à qui). Les noms
 * proviennent de l'annuaire /Users mis en cache ; s'il est indisponible, les appels sortent quand
 * même, sans nom.
 */
export async function getThreecxActiveCalls(): Promise<ThreecxReadResult<ThreecxActiveCall>> {
  const effective = await loadThreecxConfig();
  if (!effective) return notConfigured();
  const outcome = await xapiList<XapiActiveCall>(effective, "ActiveCalls", "");
  if (outcome.kind !== "ok") return fromOutcome<XapiActiveCall[], ThreecxActiveCall>(outcome, () => []);
  const nameByNumber = await getDirectory(effective);
  return fromOutcome(outcome, (calls) => calls.map((c) => mapActiveCall(c, nameByNumber)).filter((c): c is ThreecxActiveCall => c !== null));
}

/** Postes/extensions et leur état (enregistré, profil de présence, statut de file). */
export async function getThreecxExtensions(): Promise<ThreecxReadResult<ThreecxExtension>> {
  const effective = await loadThreecxConfig();
  if (!effective) return notConfigured();
  const outcome = await xapiList<XapiUser>(effective, "Users", `$select=${USER_SELECT}`);
  return fromOutcome(outcome, (users) => users.map(mapUser).filter((u): u is ThreecxExtension => u !== null));
}

/** Files d'attente. */
export async function getThreecxQueues(): Promise<ThreecxReadResult<ThreecxQueue>> {
  const effective = await loadThreecxConfig();
  if (!effective) return notConfigured();
  const outcome = await xapiList<XapiQueue>(effective, "Queues", `$select=${QUEUE_SELECT}`);
  return fromOutcome(outcome, (queues) => queues.map(mapQueue).filter((q): q is ThreecxQueue => q !== null));
}

/**
 * Résumé pour la carte du nœud : appels en cours + postes joignables (IsRegistered), avec les
 * compteurs système du PBX si /SystemStatus est accessible. Un refus d'accès ressort dans
 * `accessError`, une erreur renvoyée par le PBX dans `pbxError` — jamais des compteurs à zéro.
 */
export async function getThreecxStatus(): Promise<ThreecxStatusSummary> {
  const effective = await loadThreecxConfig();
  if (!effective) return { configured: false };

  const [calls, users, queues, system] = await Promise.all([
    xapiList<XapiActiveCall>(effective, "ActiveCalls", ""),
    xapiList<XapiUser>(effective, "Users", `$select=${USER_SELECT}`),
    xapiList<XapiQueue>(effective, "Queues", `$select=${QUEUE_SELECT}`),
    // /SystemStatus est un bonus (droits distincts) : son échec ne rend pas le résumé faux.
    xapiGet<XapiSystemStatus>(effective, `SystemStatus?$select=${SYSTEM_STATUS_SELECT}`),
  ]);

  const outcomes: XapiOutcome<unknown>[] = [calls, users, queues];
  for (const outcome of outcomes) {
    if (outcome.kind === "unreachable") {
      recordPoll(false);
      return { configured: true, reachable: false };
    }
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "denied") {
      recordPoll(true);
      return { configured: true, reachable: true, accessError: outcome.message };
    }
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "pbx-error") {
      recordPoll(true);
      return { configured: true, reachable: true, pbxError: outcome.message };
    }
  }
  if (calls.kind !== "ok" || users.kind !== "ok" || queues.kind !== "ok") {
    recordPoll(false);
    return { configured: true, reachable: false };
  }

  const mappedUsers = users.data.map(mapUser).filter((u): u is ThreecxExtension => u !== null);
  recordPoll(true);
  return {
    configured: true,
    reachable: true,
    activeCallCount: calls.data.filter((c) => typeof c.Id === "number").length,
    extensionCount: mappedUsers.length,
    reachableExtensionCount: mappedUsers.filter((u) => u.registered === true).length,
    queueCount: queues.data.filter((q) => typeof q.Id === "number" && Boolean(q.Number)).length,
    ...(system.kind === "ok" ? { system: mapSystemStatus(system.data) } : {}),
  };
}

/** Config candidate d'un test de connexion — le mode est EXPLICITE, jamais déduit du remplissage. */
export interface ThreecxConnectionCandidate {
  baseUrl: string;
  authMode: ThreecxAuthMode;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  tlsRejectUnauthorized?: boolean;
}

/**
 * Teste une config candidate SANS rien persister ni muter le PBX : obtention d'un jeton DANS LE MODE
 * DEMANDÉ puis GET /xapi/v1/ActiveCalls?$top=1. Ce test demande FORCÉMENT un nouveau jeton (c'est ce
 * qu'il vérifie) et invalide donc celui en cache côté PBX — le cache local est vidé en conséquence.
 * Un échec remonte le message du PBX TEL QUEL (identifiants refusés, droits insuffisants, XAPI non
 * autorisé), seulement débarrassé du secret s'il le répétait.
 */
export async function testThreecxConnection(
  candidate: ThreecxConnectionCandidate,
): Promise<{ ok: boolean; message: string; activeCallCount?: number }> {
  const baseUrl = candidate.baseUrl;
  if (!baseUrl) return { ok: false, message: "L'URL du PBX est requise" };
  if (candidate.authMode === "user") {
    if (!candidate.username || !candidate.password) return { ok: false, message: "baseUrl, identifiant et mot de passe sont requis" };
  } else if (!candidate.clientId || !candidate.clientSecret) {
    return { ok: false, message: "baseUrl, clientId et clientSecret sont requis" };
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, message: "URL du PBX invalide (attendu par exemple https://pbx.exemple.fr:5001)" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "URL du PBX invalide : protocole http(s) attendu" };
  }

  const secrets = configSecrets(candidate);

  try {
    const token = await requestToken(candidate);
    if (!token.ok) return { ok: false, message: token.message };

    const target = new URL("xapi/v1/ActiveCalls?$top=1", normalizedBaseUrl(baseUrl));
    const response = await rawRequest(target, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token.accessToken}` },
      rejectUnauthorized: tlsRejectUnauthorized(candidate),
    });
    if (response.status < 200 || response.status >= 300) {
      // Message BRUT du PBX : un XAPI non licencié (Enterprise) refuse ici, l'utilisateur doit le lire.
      return { ok: false, message: scrubSecrets(pbxErrorMessage(response.status, response.raw), secrets) };
    }
    const data = parseJson<ODataCollection<XapiActiveCall>>(response.raw);
    if (!data) return { ok: false, message: "3CX a renvoyé une réponse illisible sur /xapi/v1/ActiveCalls" };
    return { ok: true, message: "Le PBX 3CX est joignable et le XAPI répond", activeCallCount: data.value?.length ?? 0 };
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    return { ok: false, message: `PBX 3CX injoignable : ${message}` };
  } finally {
    // Un seul jeton actif par instance : le jeton fraîchement obtenu a invalidé celui du cache.
    resetThreecxCaches();
  }
}
