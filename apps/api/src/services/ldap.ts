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
 */

import ldap from "ldapjs";
import { getEffectiveLdapConfig } from "./setupStore.js";
import type { Role } from "../types.js";

export class LdapAuthError extends Error {
  constructor(message = "Invalid credentials") {
    super(message);
    this.name = "LdapAuthError";
  }
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
 * ldapjs SearchEntry exposes the entry DN as either `.objectName` (v3) or the legacy
 * `.dn` getter depending on the installed version's typings; extracted defensively.
 */
function getEntryDn(entry: ldap.SearchEntry): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loose = entry as any;
  const dn = loose.objectName ?? loose.dn ?? loose.pojo?.objectName;
  return typeof dn === "string" ? dn : String(dn);
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

/**
 * Recherche l'utilisateur par searchFilter (avec {{username}} substitué), en s'appuyant sur
 * un client déjà bindé avec le compte de service.
 */
async function findUserEntry(
  client: ldap.Client,
  searchBase: string,
  searchFilterTemplate: string,
  username: string,
): Promise<LdapUserEntry | null> {
  const escapedUsername = username.replace(/[()\\*\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
  const filter = searchFilterTemplate.replace(/\{\{username\}\}/g, escapedUsername);

  const entries = await searchAsync(client, searchBase, {
    scope: "sub",
    filter,
    attributes: ["dn", "cn", "displayName", "memberOf"],
  });

  const entry = entries[0];
  if (!entry) return null;

  const displayName = getAttributeValues(entry, "displayName")[0] ?? getAttributeValues(entry, "cn")[0] ?? username;
  const memberOf = getAttributeValues(entry, "memberOf");

  return { dn: getEntryDn(entry), displayName, memberOf };
}

/**
 * Requête inverse pour les annuaires qui n'exposent pas memberOf sur l'entrée utilisateur
 * (ex: OpenLDAP avec groupOfNames côté groupe uniquement).
 */
async function findGroupsByMember(client: ldap.Client, searchBase: string, userDn: string): Promise<string[]> {
  const searchRootMatch = /,(dc=.+)$/i.exec(searchBase);
  const searchRoot = searchRootMatch?.[1] ?? searchBase;

  try {
    const entries = await searchAsync(client, searchRoot, {
      scope: "sub",
      filter: `(|(member=${userDn})(uniqueMember=${userDn}))`,
      attributes: ["dn"],
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
    throw new LdapAuthError("Username and password are required");
  }

  const ldapConfig = await getEffectiveLdapConfig();
  const serviceClient = createClient(ldapConfig.url);
  let userEntry: LdapUserEntry | null;
  try {
    await bindAsync(serviceClient, ldapConfig.bindDn, ldapConfig.bindPassword);
    userEntry = await findUserEntry(serviceClient, ldapConfig.searchBase, ldapConfig.searchFilter, username);
  } catch {
    await unbindAsync(serviceClient);
    throw new LdapAuthError("LDAP directory unavailable or service bind failed");
  }

  if (!userEntry) {
    await unbindAsync(serviceClient);
    throw new LdapAuthError("Invalid credentials");
  }

  const groups = await resolveGroups(serviceClient, ldapConfig.searchBase, userEntry);
  await unbindAsync(serviceClient);

  const userClient = createClient(ldapConfig.url);
  try {
    await bindAsync(userClient, userEntry.dn, password);
  } catch {
    throw new LdapAuthError("Invalid credentials");
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
