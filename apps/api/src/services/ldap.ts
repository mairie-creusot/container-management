/**
 * Authentification LDAP.
 *
 * Bind contre l'annuaire configuré (LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD,
 * LDAP_SEARCH_BASE, LDAP_SEARCH_FILTER — ou la configuration persistée par l'assistant de
 * configuration si elle existe, cf. src/services/setupStore.ts), recherche des groupes de
 * l'utilisateur (attribut memberOf si présent, sinon requête inverse "member=<userDN>"),
 * puis mapping vers les rôles applicatifs via LDAP_GROUP_ROLE_MAP.
 *
 * Aucun mot de passe ni donnée LDAP n'est journalisé ni mis en cache au-delà de la requête
 * de login (ou de test de connexion) en cours.
 *
 * RISQUE CONNU — `ldapjs@3.0.7` (composant critique de l'authentification) est marqué
 * "decommissioned" sur le registre npm, ainsi que TOUS ses sous-paquets `@ldapjs/*` dont il
 * dépend (`@ldapjs/asn1`, `@ldapjs/dn`, `@ldapjs/filter`...) — organisation entière archivée, plus
 * de correctifs de sécurité à attendre (voir docs/reports/security-audit-2026-08-12.md, finding
 * F1). Vérifié à cette date : AUCUN fork officiellement maintenu à l'API compatible n'existe —
 * `@ldapjs/client` n'existe pas sur le registre npm (404), et le README de décommission du dépôt
 * (github.com/ldapjs/node-ldapjs) ne recommande pas de successeur Node.js mais une réécriture de
 * la logique LDAP dans un autre langage ("write a gateway in a language that is more suited...
 * I'd suggest Go"), hors périmètre de ce projet. Les seules alternatives npm trouvées (ex.
 * `ldapjs-promise`) sont de simples wrappers non éprouvés, mono-mainteneur, sans historique de
 * confiance suffisant pour remplacer un composant d'authentification sans risque de régression
 * plus grand que celui qu'on cherche à corriger. Décision : NE PAS migrer maintenant — à
 * réévaluer périodiquement (`pnpm audit`, veille sur une éventuelle reprise de maintenance).
 */

import ldap from "ldapjs";
import { getEffectiveLdapConfig } from "./setupStore.js";
import type { Role } from "../types.js";

/** Cause précise d'un échec d'authentification — journalisée côté serveur, jamais renvoyée à un anonyme. */
export type LdapFailureReason =
  | "user-not-found"
  | "excluded-by-filter"
  | "ambiguous-match"
  | "invalid-password"
  | "account-disabled"
  | "account-locked"
  | "password-expired"
  | "must-change-password"
  | "account-expired"
  | "logon-time-restricted"
  | "logon-workstation-restricted"
  | "dn-rejected-by-directory"
  | "directory-unavailable"
  | "unknown";

export class LdapAuthError extends Error {
  readonly reason: LdapFailureReason;
  /** Explication lisible pour les journaux serveur — jamais transmise au client anonyme. */
  readonly detail: string;
  readonly adCode: string | null;

  constructor(message = "Invalid credentials", reason: LdapFailureReason = "unknown", detail = message, adCode: string | null = null) {
    super(message);
    this.name = "LdapAuthError";
    this.reason = reason;
    this.detail = detail;
    this.adCode = adCode;
  }
}

/**
 * Active Directory renvoie toujours le même code LDAP 49 sur un échec de bind, mais encode la
 * vraie cause dans le message sous la forme `data <hex>` (ex: "... AcceptSecurityContext error,
 * data 52e, v4563"). Sans ce décodage, "mot de passe expiré" et "compte verrouillé" sont
 * indiscernables d'un simple mot de passe erroné.
 */
const AD_BIND_SUB_CODES: Record<string, { reason: LdapFailureReason; detail: string }> = {
  "525": { reason: "user-not-found", detail: "utilisateur inconnu de l'annuaire (le DN transmis n'existe pas)" },
  "52e": { reason: "invalid-password", detail: "mot de passe incorrect" },
  "530": { reason: "logon-time-restricted", detail: "connexion interdite à cette heure (restriction horaire AD)" },
  "531": { reason: "logon-workstation-restricted", detail: "connexion interdite depuis ce poste (restriction de station de travail AD)" },
  "532": { reason: "password-expired", detail: "mot de passe expiré" },
  "533": { reason: "account-disabled", detail: "compte désactivé" },
  "701": { reason: "account-expired", detail: "compte expiré" },
  "773": { reason: "must-change-password", detail: "l'utilisateur doit changer son mot de passe avant de pouvoir se connecter" },
  "775": { reason: "account-locked", detail: "compte verrouillé" },
};

function errorMessageOf(err: unknown): string {
  if (!err) return "";
  const loose = err as { message?: unknown; lde_message?: unknown };
  const parts = [loose.lde_message, loose.message].filter((v): v is string => typeof v === "string");
  return parts.join(" | ") || String(err);
}

/** Décode un échec de bind en cause exploitable (code AD `data <hex>` quand il est présent). */
export function parseBindFailure(err: unknown): { adCode: string | null; reason: LdapFailureReason; detail: string } {
  const message = errorMessageOf(err);
  const match = /\bdata\s+([0-9a-fA-F]{3,4})\b/.exec(message);
  const adCode = match?.[1] ? match[1].toLowerCase() : null;
  if (adCode) {
    const known = AD_BIND_SUB_CODES[adCode];
    if (known) return { adCode, reason: known.reason, detail: known.detail };
    return { adCode, reason: "unknown", detail: `échec de bind Active Directory non répertorié (data ${adCode})` };
  }

  const code = (err as { code?: unknown } | null)?.code;
  if (code === 49) return { adCode: null, reason: "invalid-password", detail: "identifiants refusés par l'annuaire (code LDAP 49)" };
  if (code === 32) return { adCode: null, reason: "user-not-found", detail: "objet introuvable dans l'annuaire (code LDAP 32)" };
  return { adCode: null, reason: "unknown", detail: message || "échec de bind sans détail fourni par l'annuaire" };
}

export interface LdapAuthResult {
  username: string;
  displayName: string;
  roles: Role[];
}

export interface LdapConnectionConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
}

interface LdapUserEntry {
  dn: string;
  displayName: string;
  memberOf: string[];
}

/**
 * Attributs demandés à chaque recherche d'utilisateur. `distinguishedName` (AD) / `entryDN`
 * (OpenLDAP) sont indispensables : ils portent le DN BRUT du serveur, seule forme acceptée en
 * bind par l'AD de la mairie (cf. getEntryDn).
 */
const USER_ENTRY_ATTRIBUTES = [
  "distinguishedName",
  "entryDN",
  "cn",
  "displayName",
  "memberOf",
];

/**
 * ldapjs typings vary across versions in how a SearchEntry exposes its attributes
 * (`.pojo.attributes`, `.attributes`, or the legacy `.object` getter). This helper
 * normalizes access without assuming a single shape.
 */
function getAttributeValues(entry: ldap.SearchEntry, attributeName: string): string[] {
  const candidateAttributes: ReadonlyArray<{ type?: string; values?: string[] }> =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry as any).pojo?.attributes ?? (entry as any).attributes ?? [];

  const values: string[] = [];
  for (const attr of candidateAttributes) {
    if (attr.type?.toLowerCase() === attributeName.toLowerCase() && attr.values) {
      values.push(...attr.values);
    }
  }
  if (values.length > 0) return values;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacyObject = (entry as any).object as Record<string, string | string[]> | undefined;
  const legacyValue = legacyObject?.[attributeName];
  if (typeof legacyValue === "string") return [legacyValue];
  if (Array.isArray(legacyValue)) return legacyValue;
  return [];
}

/**
 * DN de l'entrée, en privilégiant TOUJOURS l'attribut brut renvoyé par le serveur.
 *
 * `entry.objectName` passe par la classe DN de ldapjs, qui ré-encode chaque octet non-ASCII en
 * séquence hexadécimale RFC 4514 (`OU=Médiathèque` devient `OU=M\c3\a9diath\c3\a8que`). L'Active
 * Directory de la mairie REFUSE cette forme : il répond "No Such Object" et le bind utilisateur
 * échoue en 525 — donc tout compte dont le CN ou une OU parente contient un accent ne pouvait
 * pas se connecter (150 comptes sur 407 au moment du diagnostic). `distinguishedName` (AD) et
 * `entryDN` (OpenLDAP) portent le DN tel que le serveur l'écrit, et sont acceptés tels quels.
 */
function getEntryDn(entry: ldap.SearchEntry): string {
  const rawDn = getAttributeValues(entry, "distinguishedName")[0] ?? getAttributeValues(entry, "entryDN")[0];
  if (rawDn) return rawDn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loose = entry as any;
  const dn = loose.objectName ?? loose.dn ?? loose.pojo?.objectName;
  return typeof dn === "string" ? dn : String(dn);
}

/** Échappement RFC 4515 d'une valeur insérée dans un filtre LDAP (injection de filtre). */
function escapeFilterValue(value: string): string {
  return value.replace(/[()\\*\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function createClient(url: string): ldap.Client {
  return ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });
}

function bindAsync(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function unbindAsync(client: ldap.Client): Promise<void> {
  return new Promise((resolve) => {
    client.unbind(() => resolve());
  });
}

function searchAsync(
  client: ldap.Client,
  base: string,
  options: ldap.SearchOptions,
): Promise<ldap.SearchEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ldap.SearchEntry[] = [];
    client.search(base, options, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      res.on("searchEntry", (entry) => entries.push(entry));
      res.on("error", (searchErr) => reject(searchErr));
      res.on("end", () => resolve(entries));
    });
  });
}

function buildUserFilter(searchFilterTemplate: string, username: string): string {
  return searchFilterTemplate.replace(/\{\{username\}\}/g, escapeFilterValue(username));
}

function toUserEntry(entry: ldap.SearchEntry, fallbackDisplayName: string): LdapUserEntry {
  const displayName =
    getAttributeValues(entry, "displayName")[0] ?? getAttributeValues(entry, "cn")[0] ?? fallbackDisplayName;
  return { dn: getEntryDn(entry), displayName, memberOf: getAttributeValues(entry, "memberOf") };
}

/**
 * Recherche l'utilisateur par searchFilter (avec {{username}} substitué), en s'appuyant sur un
 * client déjà bindé avec le compte de service. `matchCount` est remonté tel quel : plusieurs
 * entrées pour un même identifiant est une ambiguïté qu'on refuse d'arbitrer (cf. authenticate).
 */
async function findUserEntries(
  client: ldap.Client,
  searchBase: string,
  searchFilterTemplate: string,
  username: string,
  extraAttributes: string[] = [],
): Promise<{ entries: ldap.SearchEntry[]; matchCount: number }> {
  const entries = await searchAsync(client, searchBase, {
    scope: "sub",
    filter: buildUserFilter(searchFilterTemplate, username),
    attributes: [...USER_ENTRY_ATTRIBUTES, ...extraAttributes],
  });
  return { entries, matchCount: entries.length };
}

async function findUserEntry(
  client: ldap.Client,
  searchBase: string,
  searchFilterTemplate: string,
  username: string,
): Promise<LdapUserEntry | null> {
  const { entries } = await findUserEntries(client, searchBase, searchFilterTemplate, username);
  const entry = entries[0];
  return entry ? toUserEntry(entry, username) : null;
}

/**
 * Requête inverse pour les annuaires qui n'exposent pas memberOf sur l'entrée utilisateur
 * (ex: OpenLDAP avec groupOfNames côté groupe uniquement).
 */
async function findGroupsByMember(client: ldap.Client, searchBase: string, userDn: string): Promise<string[]> {
  const searchRootMatch = /,(dc=.+)$/i.exec(searchBase);
  const searchRoot = searchRootMatch?.[1] ?? searchBase;

  const escapedDn = escapeFilterValue(userDn);
  try {
    const entries = await searchAsync(client, searchRoot, {
      scope: "sub",
      filter: `(|(member=${escapedDn})(uniqueMember=${escapedDn}))`,
      attributes: ["distinguishedName", "entryDN"],
    });
    return entries.map((entry) => getEntryDn(entry));
  } catch {
    return [];
  }
}

/**
 * Résout les rôles d'un utilisateur à partir de son mapping LDAP_GROUP_ROLE_MAP (assistant
 * de configuration → étape LDAP → "Mapping groupe LDAP → rôle"). Chaque clé du mapping peut
 * être :
 *  - le DN exact d'un groupe de sécurité (memberOf) — cas d'usage historique ;
 *  - OU une unité d'organisation (OU) présente dans le DN de l'utilisateur lui-même — utile
 *    en AD quand l'organisation "par service" est déjà portée par la structure d'OUs
 *    (ex: "OU=Informatique,OU=ville-du-Creusot,DC=lecreusot,DC=priv") sans qu'un groupe de
 *    sécurité dédié existe. `userDn` est optionnel pour ne pas casser les appels existants
 *    (tests, code n'ayant que les groupes sous la main).
 */
export function mapGroupsToRoles(
  groupDns: string[],
  groupRoleMap: Record<string, Role>,
  defaultRole: Role,
  userDn?: string,
): Role[] {
  const roles = new Set<Role>();
  for (const groupDn of groupDns) {
    const role = groupRoleMap[groupDn.toLowerCase()];
    if (role) roles.add(role);
  }
  if (userDn) {
    const lowerUserDn = userDn.toLowerCase();
    for (const [key, role] of Object.entries(groupRoleMap)) {
      if (lowerUserDn.endsWith(key.toLowerCase())) roles.add(role);
    }
  }
  if (roles.size === 0) roles.add(defaultRole);
  return Array.from(roles);
}

/** Résout les groupes d'un utilisateur déjà trouvé (memberOf, ou repli par requête inverse). */
async function resolveGroups(client: ldap.Client, searchBase: string, entry: LdapUserEntry): Promise<string[]> {
  if (entry.memberOf.length > 0) return entry.memberOf;
  return findGroupsByMember(client, searchBase, entry.dn);
}

export async function authenticate(username: string, password: string): Promise<LdapAuthResult> {
  if (!username || !password) {
    throw new LdapAuthError("Username and password are required", "unknown", "identifiant ou mot de passe absent de la requête");
  }

  const ldapConfig = await getEffectiveLdapConfig();
  const serviceClient = createClient(ldapConfig.url);
  let matchCount: number;
  let entries: ldap.SearchEntry[];
  try {
    await bindAsync(serviceClient, ldapConfig.bindDn, ldapConfig.bindPassword);
    ({ entries, matchCount } = await findUserEntries(serviceClient, ldapConfig.searchBase, ldapConfig.searchFilter, username));
  } catch (err) {
    await unbindAsync(serviceClient);
    const { detail } = parseBindFailure(err);
    throw new LdapAuthError(
      "LDAP directory unavailable or service bind failed",
      "directory-unavailable",
      `annuaire injoignable ou bind du compte de service en échec : ${detail}`,
    );
  }

  if (matchCount === 0) {
    await unbindAsync(serviceClient);
    throw new LdapAuthError(
      "Invalid credentials",
      "user-not-found",
      `aucune entrée ne correspond au searchFilter configuré sous ${ldapConfig.searchBase} (compte inexistant, hors de la base de recherche, ou exclu par le filtre — ex. clause excluant les comptes désactivés)`,
    );
  }

  // Plusieurs entrées pour un même identifiant : impossible de savoir laquelle authentifier —
  // en prendre une au hasard reviendrait à ouvrir une session sur une identité non déterminée.
  if (matchCount > 1) {
    await unbindAsync(serviceClient);
    throw new LdapAuthError(
      "Invalid credentials",
      "ambiguous-match",
      `${matchCount} entrées correspondent au searchFilter pour cet identifiant : ambiguïté refusée, le filtre doit désigner un compte unique`,
    );
  }

  const userEntry = toUserEntry(entries[0]!, username);
  const groups = await resolveGroups(serviceClient, ldapConfig.searchBase, userEntry);
  await unbindAsync(serviceClient);

  const userClient = createClient(ldapConfig.url);
  try {
    await bindAsync(userClient, userEntry.dn, password);
  } catch (err) {
    const { adCode, reason, detail } = parseBindFailure(err);
    // 525 après une recherche réussie ne peut pas être un compte inexistant : c'est l'annuaire qui
    // refuse la FORME du DN qu'on lui a transmis (cf. getEntryDn).
    const refinedReason: LdapFailureReason = reason === "user-not-found" ? "dn-rejected-by-directory" : reason;
    const refinedDetail =
      reason === "user-not-found"
        ? `${detail} — l'entrée a pourtant été trouvée par la recherche : l'annuaire refuse la forme du DN transmis`
        : detail;
    throw new LdapAuthError("Invalid credentials", refinedReason, refinedDetail, adCode);
  } finally {
    await unbindAsync(userClient);
  }

  const roles = mapGroupsToRoles(groups, ldapConfig.groupRoleMap, ldapConfig.defaultRole, userEntry.dn);

  return { username, displayName: userEntry.displayName, roles };
}

export interface LdapTestInput extends LdapConnectionConfig {
  testUsername?: string;
  testPassword?: string;
}

export interface LdapTestResult {
  ok: boolean;
  message: string;
  userDn?: string;
  groupsResolved?: number;
}

/**
 * Utilisé par l'assistant de configuration (POST /api/setup/test/ldap) : teste une
 * configuration LDAP candidate (pas encore persistée) sans jamais modifier l'état
 * applicatif. Si testUsername/testPassword sont fournis, effectue un cycle complet
 * (recherche + bind utilisateur + résolution des groupes) ; sinon vérifie seulement le
 * bind de service et l'accessibilité de la base de recherche.
 */
export async function testLdapConnection(input: LdapTestInput): Promise<LdapTestResult> {
  const serviceClient = createClient(input.url);
  try {
    await bindAsync(serviceClient, input.bindDn, input.bindPassword);
  } catch (err) {
    await unbindAsync(serviceClient);
    return { ok: false, message: `Service bind failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!input.testUsername) {
    try {
      await searchAsync(serviceClient, input.searchBase, { scope: "base", filter: "(objectClass=*)" });
      await unbindAsync(serviceClient);
      return { ok: true, message: "Service bind succeeded and search base is reachable" };
    } catch (err) {
      await unbindAsync(serviceClient);
      return { ok: false, message: `Search base is not reachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  let userEntry: LdapUserEntry | null;
  try {
    userEntry = await findUserEntry(serviceClient, input.searchBase, input.searchFilter, input.testUsername);
  } catch (err) {
    await unbindAsync(serviceClient);
    return { ok: false, message: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!userEntry) {
    await unbindAsync(serviceClient);
    return { ok: false, message: `No user found for "${input.testUsername}" with the given search base/filter` };
  }

  const groups = await resolveGroups(serviceClient, input.searchBase, userEntry);
  await unbindAsync(serviceClient);

  if (input.testPassword) {
    const userClient = createClient(input.url);
    try {
      await bindAsync(userClient, userEntry.dn, input.testPassword);
    } catch {
      return { ok: false, message: "Test user bind failed: invalid credentials", userDn: userEntry.dn };
    } finally {
      await unbindAsync(userClient);
    }
  }

  return {
    ok: true,
    message: "LDAP connection, search and group resolution succeeded",
    userDn: userEntry.dn,
    groupsResolved: groups.length,
  };
}

/** État du compte tel que l'annuaire le laisse lire ; `null` = attribut non lisible par le compte de service. */
export interface LdapAccountState {
  readable: boolean;
  disabled: boolean | null;
  locked: boolean | null;
  passwordExpired: boolean | null;
  mustChangePassword: boolean | null;
  accountExpired: boolean | null;
}

export interface LdapAccountDiagnosis {
  username: string;
  searchBase: string;
  searchFilter: string;
  found: boolean;
  matchCount: number;
  /** DN(s) trouvé(s) — plusieurs signale une ambiguïté que l'authentification refuse d'arbitrer. */
  matchedDns: string[];
  dn: string | null;
  /** Le DN contient des caractères non-ASCII : forme brute obligatoire au bind (cf. getEntryDn). */
  dnHasNonAscii: boolean;
  displayName: string | null;
  identifiers: { sAMAccountName: string | null; userPrincipalName: string | null; cn: string | null };
  memberOfPresent: boolean;
  groupsResolved: number;
  roles: Role[] | null;
  accountState: LdapAccountState;
  /** Le compte existe mais le searchFilter configuré l'écarte (ex. clause excluant les désactivés). */
  excludedByFilter: boolean;
  verdict: string;
  notes: string[];
}

const UAC_ACCOUNT_DISABLE = 0x0002;
const UAC_COMPUTED_LOCKOUT = 0x0010;
const UAC_COMPUTED_PASSWORD_EXPIRED = 0x800000;
const FILETIME_NEVER = "9223372036854775807";

const DIAGNOSIS_ATTRIBUTES = [
  "sAMAccountName",
  "userPrincipalName",
  "userAccountControl",
  "msDS-User-Account-Control-Computed",
  "lockoutTime",
  "pwdLastSet",
  "accountExpires",
];

function hasBit(value: string | undefined, bit: number): boolean | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed & bit) !== 0 : null;
}

/** FILETIME AD (100 ns depuis 1601) : `0` et la valeur maximale signifient "jamais". */
function isFiletimeInThePast(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value === "0" || value === FILETIME_NEVER) return false;
  try {
    const epochMs = Number(BigInt(value) / 10000n) - 11644473600000;
    return Number.isFinite(epochMs) ? epochMs < Date.now() : null;
  } catch {
    return null;
  }
}

function readAccountState(entry: ldap.SearchEntry): LdapAccountState {
  const uac = getAttributeValues(entry, "userAccountControl")[0];
  const computed = getAttributeValues(entry, "msDS-User-Account-Control-Computed")[0];
  const lockoutTime = getAttributeValues(entry, "lockoutTime")[0];
  const pwdLastSet = getAttributeValues(entry, "pwdLastSet")[0];
  const accountExpires = getAttributeValues(entry, "accountExpires")[0];

  // `msDS-User-Account-Control-Computed` est calculé en direct par l'AD : c'est la seule source
  // fiable pour "verrouillé" et "mot de passe expiré" (`lockoutTime` reste renseigné après un
  // déverrouillage automatique et donnerait un faux positif).
  const lockedFromComputed = hasBit(computed, UAC_COMPUTED_LOCKOUT);
  const locked = lockedFromComputed ?? (lockoutTime === undefined ? null : lockoutTime !== "0");

  return {
    readable: uac !== undefined || computed !== undefined || pwdLastSet !== undefined,
    disabled: hasBit(uac, UAC_ACCOUNT_DISABLE),
    locked,
    passwordExpired: hasBit(computed, UAC_COMPUTED_PASSWORD_EXPIRED),
    mustChangePassword: pwdLastSet === undefined ? null : pwdLastSet === "0",
    accountExpired: isFiletimeInThePast(accountExpires),
  };
}

function emptyDiagnosis(username: string, searchBase: string, searchFilter: string, verdict: string, notes: string[] = []): LdapAccountDiagnosis {
  return {
    username,
    searchBase,
    searchFilter,
    found: false,
    matchCount: 0,
    matchedDns: [],
    dn: null,
    dnHasNonAscii: false,
    displayName: null,
    identifiers: { sAMAccountName: null, userPrincipalName: null, cn: null },
    memberOfPresent: false,
    groupsResolved: 0,
    roles: null,
    accountState: { readable: false, disabled: null, locked: null, passwordExpired: null, mustChangePassword: null, accountExpired: null },
    excludedByFilter: false,
    verdict,
    notes,
  };
}

/**
 * Diagnostic d'un compte, EN LECTURE SEULE et SANS mot de passe : jamais de bind utilisateur,
 * jamais d'écriture. Réservé aux administrateurs (cf. routes/auth.ts) — l'écran de connexion
 * anonyme, lui, doit rester volontairement vague et ne jamais révéler qu'un compte existe.
 */
export async function diagnoseLdapAccount(username: string): Promise<LdapAccountDiagnosis> {
  const ldapConfig = await getEffectiveLdapConfig();
  const base = ldapConfig.searchBase;
  const filter = ldapConfig.searchFilter;

  if (!username.trim()) return emptyDiagnosis(username, base, filter, "Aucun identifiant fourni.");

  const client = createClient(ldapConfig.url);
  try {
    try {
      await bindAsync(client, ldapConfig.bindDn, ldapConfig.bindPassword);
    } catch (err) {
      const { detail } = parseBindFailure(err);
      return emptyDiagnosis(username, base, filter, `Annuaire injoignable ou compte de service refusé : ${detail}`);
    }

    const { entries, matchCount } = await findUserEntries(client, base, filter, username, DIAGNOSIS_ATTRIBUTES);
    const notes: string[] = [];

    if (matchCount === 0) {
      // Le compte est peut-être bien présent mais écarté par le searchFilter (clause excluant les
      // comptes désactivés par exemple) : sans cette seconde recherche, "inexistant" et "exclu"
      // sont indiscernables — et ce sont deux actions correctives radicalement différentes.
      const escaped = escapeFilterValue(username);
      const broadEntries = await searchAsync(client, base, {
        scope: "sub",
        filter: `(&(objectClass=user)(|(sAMAccountName=${escaped})(userPrincipalName=${escaped})(cn=${escaped})))`,
        attributes: [...USER_ENTRY_ATTRIBUTES, ...DIAGNOSIS_ATTRIBUTES],
      });
      const broad = broadEntries[0];
      if (!broad) {
        return emptyDiagnosis(username, base, filter, "Introuvable : aucune entrée avec cet identifiant sous la base de recherche configurée.", [
          "Vérifier l'orthographe de l'identifiant, et que la base de recherche couvre bien l'OU du compte.",
        ]);
      }

      const state = readAccountState(broad);
      const dn = getEntryDn(broad);
      const diagnosis = emptyDiagnosis(username, base, filter, "");
      return {
        ...diagnosis,
        found: false,
        excludedByFilter: true,
        matchedDns: [dn],
        dn,
        dnHasNonAscii: /[^\x20-\x7e]/.test(dn),
        displayName: getAttributeValues(broad, "displayName")[0] ?? getAttributeValues(broad, "cn")[0] ?? null,
        identifiers: {
          sAMAccountName: getAttributeValues(broad, "sAMAccountName")[0] ?? null,
          userPrincipalName: getAttributeValues(broad, "userPrincipalName")[0] ?? null,
          cn: getAttributeValues(broad, "cn")[0] ?? null,
        },
        memberOfPresent: getAttributeValues(broad, "memberOf").length > 0,
        accountState: state,
        verdict:
          state.disabled === true
            ? "Le compte existe mais est DÉSACTIVÉ dans l'Active Directory : le searchFilter configuré l'exclut, la connexion est donc impossible."
            : "Le compte existe mais le searchFilter configuré ne le retient pas.",
        notes:
          state.disabled === true
            ? ["Action côté Active Directory : réactiver le compte (le corriger ici n'aurait aucun sens)."]
            : ["Comparer les attributs du compte avec le searchFilter configuré (sAMAccountName / userPrincipalName / objectClass)."],
      };
    }

    if (matchCount > 1) {
      const dns = entries.map((entry) => getEntryDn(entry));
      return {
        ...emptyDiagnosis(username, base, filter, ""),
        found: true,
        matchCount,
        matchedDns: dns,
        verdict: `${matchCount} entrées correspondent à cet identifiant : l'authentification refuse d'arbitrer et rejette la connexion.`,
        notes: ["Action côté Active Directory : supprimer le doublon, ou restreindre le searchFilter pour qu'il désigne un compte unique."],
      };
    }

    const entry = entries[0]!;
    const userEntry = toUserEntry(entry, username);
    const memberOf = getAttributeValues(entry, "memberOf");
    const groups = await resolveGroups(client, base, userEntry);
    const state = readAccountState(entry);
    const dnHasNonAscii = /[^\x20-\x7e]/.test(userEntry.dn);

    if (memberOf.length === 0) {
      notes.push(
        groups.length > 0
          ? "L'entrée n'expose pas memberOf : les groupes ont été résolus par requête inverse (member=<DN>)."
          : "L'entrée n'expose pas memberOf et la requête inverse ne remonte aucun groupe : seul le mapping par OU s'applique.",
      );
    }
    if (dnHasNonAscii) {
      notes.push("Le DN contient des caractères accentués : il doit être transmis en forme brute au bind (corrigé, voir getEntryDn).");
    }
    if (!state.readable) {
      notes.push("Le compte de service ne peut pas lire l'état du compte (userAccountControl / pwdLastSet) : état indéterminé.");
    }

    const blocking =
      state.disabled === true
        ? "Compte DÉSACTIVÉ dans l'Active Directory."
        : state.locked === true
          ? "Compte VERROUILLÉ dans l'Active Directory."
          : state.mustChangePassword === true
            ? "L'utilisateur DOIT CHANGER SON MOT DE PASSE à la prochaine ouverture de session : l'annuaire refusera tout bind avant."
            : state.passwordExpired === true
              ? "Mot de passe EXPIRÉ."
              : state.accountExpired === true
                ? "Compte EXPIRÉ."
                : null;

    return {
      username,
      searchBase: base,
      searchFilter: filter,
      found: true,
      matchCount,
      matchedDns: [userEntry.dn],
      dn: userEntry.dn,
      dnHasNonAscii,
      displayName: userEntry.displayName,
      identifiers: {
        sAMAccountName: getAttributeValues(entry, "sAMAccountName")[0] ?? null,
        userPrincipalName: getAttributeValues(entry, "userPrincipalName")[0] ?? null,
        cn: getAttributeValues(entry, "cn")[0] ?? null,
      },
      memberOfPresent: memberOf.length > 0,
      groupsResolved: groups.length,
      roles: mapGroupsToRoles(groups, ldapConfig.groupRoleMap, ldapConfig.defaultRole, userEntry.dn),
      accountState: state,
      excludedByFilter: false,
      verdict:
        blocking ??
        "Compte trouvé et actif : rien côté annuaire n'empêche la connexion. Un échec restant ne peut venir que du mot de passe saisi.",
      notes,
    };
  } finally {
    await unbindAsync(client);
  }
}
