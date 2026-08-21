import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";

/**
 * Régression du bug « plusieurs comptes AD n'arrivent pas à se connecter » (OU Informatique,
 * Mairie du Creusot) : ldapjs ré-encode tout DN non-ASCII en séquences hexadécimales RFC 4514
 * (`OU=Médiathèque` -> `OU=M\c3\a9diath\c3\a8que`), forme que l'Active Directory refuse ("No Such
 * Object"), ce qui faisait échouer le bind utilisateur en 525 pour tout compte accentué. Le DN
 * brut du serveur (`distinguishedName` / `entryDN`) doit être utilisé tel quel.
 *
 * Couvre aussi : décodage des codes AD `data <hex>`, résultat de recherche multiple, repli par
 * requête inverse sans memberOf, et l'étanchéité de la route de diagnostic (admins seulement).
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-ldapdiag-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

interface FakeAttribute {
  type: string;
  values: string[];
}

interface FakeEntry {
  /** DN tel que ldapjs le ré-encode (échappé) — ce qu'il ne faut PLUS utiliser au bind. */
  objectName: string;
  attributes: FakeAttribute[];
}

function entryOf(objectName: string, attrs: Record<string, string | string[]>): FakeEntry {
  return {
    objectName,
    attributes: Object.entries(attrs).map(([type, value]) => ({
      type,
      values: Array.isArray(value) ? value : [value],
    })),
  };
}

interface Scenario {
  searchResults: FakeEntry[][];
  bindErrors: Record<string, unknown>;
}

const scenario: Scenario = { searchResults: [], bindErrors: {} };
const bindAttempts: string[] = [];
const searchCalls: Array<{ base: string; filter: string }> = [];

vi.mock("ldapjs", () => {
  return {
    default: {
      createClient() {
        return {
          bind(dn: string, _password: string, cb: (err?: unknown) => void) {
            bindAttempts.push(dn);
            const err = scenario.bindErrors[dn];
            cb(err ?? undefined);
          },
          search(base: string, options: { filter: string }, cb: (err: unknown, res: EventEmitter) => void) {
            searchCalls.push({ base, filter: options.filter });
            const res = new EventEmitter();
            const entries = scenario.searchResults.shift() ?? [];
            cb(null, res);
            queueMicrotask(() => {
              for (const entry of entries) res.emit("searchEntry", entry);
              res.emit("end");
            });
          },
          unbind(cb: () => void) {
            cb();
          },
          on() {},
        };
      },
    },
  };
});

const LDAP_CONFIG = {
  url: "ldap://dc.test:389",
  bindDn: "CN=svc,DC=test",
  bindPassword: "service-secret",
  searchBase: "OU=ville,DC=lecreusot,DC=priv",
  searchFilter: "(&(objectClass=user)(sAMAccountName={{username}}))",
  groupRoleMap: { "ou=informatique,ou=ville,dc=lecreusot,dc=priv": "admin" as const },
  defaultRole: "viewer" as const,
};

vi.mock("../src/services/setupStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/setupStore.js")>();
  return { ...actual, getEffectiveLdapConfig: async () => LDAP_CONFIG };
});

const { authenticate, diagnoseLdapAccount, parseBindFailure, LdapAuthError } = await import("../src/services/ldap.js");
const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");

const ACCENTED_RAW_DN = "CN=GROSJEAN Loïc,OU=Informatique,OU=ville,DC=lecreusot,DC=priv";
const ACCENTED_ESCAPED_DN = "CN=GROSJEAN Lo\\c3\\afc,OU=Informatique,OU=ville,DC=lecreusot,DC=priv";

function adError(dataCode: string): Error & { code: number } {
  const err = new Error(
    `80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data ${dataCode}, v4563`,
  ) as Error & { code: number };
  err.code = 49;
  return err;
}

beforeEach(() => {
  scenario.searchResults = [];
  scenario.bindErrors = {};
  bindAttempts.length = 0;
  searchCalls.length = 0;
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await fs.rm(tmpConfigPath, { force: true });
});

describe("parseBindFailure — décodage des codes Active Directory `data <hex>`", () => {
  const cases: Array<[string, string]> = [
    ["525", "user-not-found"],
    ["52e", "invalid-password"],
    ["530", "logon-time-restricted"],
    ["531", "logon-workstation-restricted"],
    ["532", "password-expired"],
    ["533", "account-disabled"],
    ["701", "account-expired"],
    ["773", "must-change-password"],
    ["775", "account-locked"],
  ];

  for (const [code, expectedReason] of cases) {
    it(`décode data ${code} en "${expectedReason}"`, () => {
      const parsed = parseBindFailure(adError(code));
      expect(parsed.adCode).toBe(code);
      expect(parsed.reason).toBe(expectedReason);
      expect(parsed.detail.length).toBeGreaterThan(0);
    });
  }

  it("est insensible à la casse du code hexadécimal", () => {
    expect(parseBindFailure(adError("52E")).reason).toBe("invalid-password");
    expect(parseBindFailure(adError("52E")).adCode).toBe("52e");
  });

  it("signale un code AD inconnu sans prétendre le comprendre", () => {
    const parsed = parseBindFailure(adError("abc"));
    expect(parsed.adCode).toBe("abc");
    expect(parsed.reason).toBe("unknown");
  });

  it("retombe sur le code LDAP 49 quand l'annuaire n'envoie aucun `data <hex>` (OpenLDAP)", () => {
    const err = Object.assign(new Error("Invalid Credentials"), { code: 49 });
    const parsed = parseBindFailure(err);
    expect(parsed.adCode).toBeNull();
    expect(parsed.reason).toBe("invalid-password");
  });

  it("lit aussi le message dans lde_message (forme ldapjs)", () => {
    const err = Object.assign(new Error("InvalidCredentialsError"), {
      lde_message: "80090308: LdapErr: ..., data 775, v4563",
      code: 49,
    });
    expect(parseBindFailure(err).reason).toBe("account-locked");
  });
});

describe("authenticate — DN transmis au bind utilisateur", () => {
  it("utilise le DN BRUT du serveur (distinguishedName) et non la forme ré-encodée par ldapjs", async () => {
    scenario.searchResults = [
      [
        entryOf(ACCENTED_ESCAPED_DN, {
          distinguishedName: ACCENTED_RAW_DN,
          cn: "GROSJEAN Loïc",
          memberOf: ["CN=DSI,OU=Groupes,DC=lecreusot,DC=priv"],
        }),
      ],
    ];

    const result = await authenticate("lgrosjean", "mot-de-passe");

    expect(bindAttempts).toEqual([LDAP_CONFIG.bindDn, ACCENTED_RAW_DN]);
    expect(bindAttempts).not.toContain(ACCENTED_ESCAPED_DN);
    expect(result.displayName).toBe("GROSJEAN Loïc");
  });

  it("accepte entryDN (OpenLDAP) comme source de DN brut", async () => {
    scenario.searchResults = [
      [entryOf("cn=Ren\\c3\\a9,ou=people,dc=test", { entryDN: "cn=René,ou=people,dc=test", cn: "René" })],
    ];

    await authenticate("rene", "mot-de-passe");

    expect(bindAttempts[1]).toBe("cn=René,ou=people,dc=test");
  });

  it("retombe sur objectName quand le serveur n'expose aucun attribut de DN brut", async () => {
    scenario.searchResults = [[entryOf("cn=ascii,ou=people,dc=test", { cn: "ascii" })]];

    await authenticate("ascii", "mot-de-passe");

    expect(bindAttempts[1]).toBe("cn=ascii,ou=people,dc=test");
  });

  it("qualifie un 525 après recherche réussie comme un DN refusé par l'annuaire, pas comme un compte inexistant", async () => {
    scenario.searchResults = [
      [entryOf(ACCENTED_ESCAPED_DN, { distinguishedName: ACCENTED_RAW_DN, cn: "GROSJEAN Loïc" })],
    ];
    scenario.bindErrors[ACCENTED_RAW_DN] = adError("525");

    await expect(authenticate("lgrosjean", "mot-de-passe")).rejects.toMatchObject({
      message: "Invalid credentials",
      reason: "dn-rejected-by-directory",
      adCode: "525",
    });
  });
});

describe("authenticate — résultat de recherche multiple", () => {
  it("refuse d'arbitrer entre plusieurs entrées et ne tente AUCUN bind utilisateur", async () => {
    scenario.searchResults = [
      [
        entryOf("CN=Dupont A,OU=A,DC=test", { distinguishedName: "CN=Dupont A,OU=A,DC=test", cn: "Dupont A" }),
        entryOf("CN=Dupont B,OU=B,DC=test", { distinguishedName: "CN=Dupont B,OU=B,DC=test", cn: "Dupont B" }),
      ],
    ];

    const error = await authenticate("jdupont", "mot-de-passe").catch((err) => err);

    expect(error).toBeInstanceOf(LdapAuthError);
    expect(error.reason).toBe("ambiguous-match");
    expect(error.message).toBe("Invalid credentials");
    expect(error.detail).toContain("2 entrées");
    // Un seul bind : celui du compte de service. Aucun bind utilisateur sur une identité incertaine.
    expect(bindAttempts).toEqual([LDAP_CONFIG.bindDn]);
  });

  it("garde un message client vague quand le compte est introuvable", async () => {
    scenario.searchResults = [[]];

    const error = await authenticate("inconnu", "mot-de-passe").catch((err) => err);

    expect(error.message).toBe("Invalid credentials");
    expect(error.reason).toBe("user-not-found");
  });
});

describe("résolution des groupes sans memberOf", () => {
  it("bascule sur la requête inverse (member=<DN brut>) et en tire les rôles", async () => {
    scenario.searchResults = [
      [entryOf("CN=Sans MemberOf,OU=Informatique,OU=ville,DC=lecreusot,DC=priv", {
        distinguishedName: "CN=Sans MemberOf,OU=Informatique,OU=ville,DC=lecreusot,DC=priv",
        cn: "Sans MemberOf",
      })],
      [entryOf("CN=DSI,OU=Groupes,DC=lecreusot,DC=priv", { distinguishedName: "CN=DSI,OU=Groupes,DC=lecreusot,DC=priv" })],
    ];

    const result = await authenticate("nomemberof", "mot-de-passe");

    const reverseQuery = searchCalls[1]!;
    expect(reverseQuery.filter).toContain("member=CN=Sans MemberOf,OU=Informatique,OU=ville,DC=lecreusot,DC=priv");
    expect(reverseQuery.filter).toContain("uniqueMember=");
    // Le compte est dans l'OU Informatique, mappée sur admin dans LDAP_CONFIG.
    expect(result.roles).toEqual(["admin"]);
  });

  it("échappe le DN injecté dans le filtre de la requête inverse", async () => {
    scenario.searchResults = [
      [entryOf("x", { distinguishedName: "CN=Weird)(objectClass=*,OU=ville,DC=lecreusot,DC=priv", cn: "Weird" })],
      [],
    ];

    await authenticate("weird", "mot-de-passe");

    expect(searchCalls[1]!.filter).toContain("\\29\\28");
    expect(searchCalls[1]!.filter).not.toContain("Weird)(objectClass");
  });
});

describe("diagnoseLdapAccount — lecture seule", () => {
  it("ne tente jamais de bind utilisateur et rend un verdict exploitable", async () => {
    scenario.searchResults = [
      [
        entryOf(ACCENTED_ESCAPED_DN, {
          distinguishedName: ACCENTED_RAW_DN,
          cn: "GROSJEAN Loïc",
          sAMAccountName: "lgrosjean",
          userPrincipalName: "lgrosjean@lecreusot.priv",
          memberOf: ["CN=DSI,OU=Groupes,DC=lecreusot,DC=priv"],
          userAccountControl: "66048",
          "msDS-User-Account-Control-Computed": "0",
          pwdLastSet: "133509857830607440",
          accountExpires: "9223372036854775807",
        }),
      ],
    ];

    const diagnosis = await diagnoseLdapAccount("lgrosjean");

    expect(bindAttempts).toEqual([LDAP_CONFIG.bindDn]);
    expect(diagnosis.found).toBe(true);
    expect(diagnosis.matchCount).toBe(1);
    expect(diagnosis.dn).toBe(ACCENTED_RAW_DN);
    expect(diagnosis.dnHasNonAscii).toBe(true);
    expect(diagnosis.memberOfPresent).toBe(true);
    expect(diagnosis.roles).toEqual(["admin"]);
    expect(diagnosis.accountState).toMatchObject({ disabled: false, locked: false, mustChangePassword: false });
  });

  it("distingue un compte désactivé (exclu par le searchFilter) d'un compte inexistant", async () => {
    scenario.searchResults = [
      [],
      [
        entryOf("CN=ogo,OU=Informatique,OU=ville,DC=lecreusot,DC=priv", {
          distinguishedName: "CN=ogo,OU=Informatique,OU=ville,DC=lecreusot,DC=priv",
          cn: "ogo",
          userAccountControl: "66050",
          pwdLastSet: "132917485233755525",
        }),
      ],
    ];

    const diagnosis = await diagnoseLdapAccount("ogo");

    expect(diagnosis.found).toBe(false);
    expect(diagnosis.excludedByFilter).toBe(true);
    expect(diagnosis.accountState.disabled).toBe(true);
    expect(diagnosis.verdict).toContain("DÉSACTIVÉ");
  });

  it("signale un compte réellement inexistant", async () => {
    scenario.searchResults = [[], []];

    const diagnosis = await diagnoseLdapAccount("personne");

    expect(diagnosis.found).toBe(false);
    expect(diagnosis.excludedByFilter).toBe(false);
    expect(diagnosis.dn).toBeNull();
    expect(diagnosis.verdict).toContain("Introuvable");
  });

  it("détecte un mot de passe à changer (pwdLastSet = 0)", async () => {
    scenario.searchResults = [
      [
        entryOf("CN=Nouveau,OU=ville,DC=lecreusot,DC=priv", {
          distinguishedName: "CN=Nouveau,OU=ville,DC=lecreusot,DC=priv",
          cn: "Nouveau",
          userAccountControl: "512",
          "msDS-User-Account-Control-Computed": "0",
          pwdLastSet: "0",
        }),
      ],
      [],
    ];

    const diagnosis = await diagnoseLdapAccount("nouveau");

    expect(diagnosis.accountState.mustChangePassword).toBe(true);
    expect(diagnosis.verdict).toContain("CHANGER SON MOT DE PASSE");
  });

  it("détecte un compte verrouillé via msDS-User-Account-Control-Computed", async () => {
    scenario.searchResults = [
      [
        entryOf("CN=Bloque,OU=ville,DC=lecreusot,DC=priv", {
          distinguishedName: "CN=Bloque,OU=ville,DC=lecreusot,DC=priv",
          cn: "Bloque",
          userAccountControl: "512",
          "msDS-User-Account-Control-Computed": String(0x10),
          pwdLastSet: "133509857830607440",
        }),
      ],
      [],
    ];

    const diagnosis = await diagnoseLdapAccount("bloque");

    expect(diagnosis.accountState.locked).toBe(true);
    expect(diagnosis.verdict).toContain("VERROUILLÉ");
  });

  it("ne prétend pas connaître l'état quand le compte de service ne peut pas lire les attributs", async () => {
    scenario.searchResults = [
      [entryOf("CN=Opaque,OU=ville,DC=lecreusot,DC=priv", { distinguishedName: "CN=Opaque,OU=ville,DC=lecreusot,DC=priv", cn: "Opaque" })],
      [],
    ];

    const diagnosis = await diagnoseLdapAccount("opaque");

    expect(diagnosis.accountState.readable).toBe(false);
    expect(diagnosis.accountState.disabled).toBeNull();
    expect(diagnosis.notes.join(" ")).toContain("ne peut pas lire l'état du compte");
  });

  it("remonte l'ambiguïté quand plusieurs entrées correspondent", async () => {
    scenario.searchResults = [
      [
        entryOf("a", { distinguishedName: "CN=A,OU=ville,DC=lecreusot,DC=priv" }),
        entryOf("b", { distinguishedName: "CN=B,OU=ville,DC=lecreusot,DC=priv" }),
      ],
    ];

    const diagnosis = await diagnoseLdapAccount("doublon");

    expect(diagnosis.matchCount).toBe(2);
    expect(diagnosis.matchedDns).toEqual(["CN=A,OU=ville,DC=lecreusot,DC=priv", "CN=B,OU=ville,DC=lecreusot,DC=priv"]);
    expect(diagnosis.verdict).toContain("2 entrées");
  });
});

describe("POST /api/auth/ldap-diagnose — étanchéité", () => {
  /**
   * /api/auth/* est exclu du hook d'authentification global (plugins/auth.ts) : sans le contrôle
   * explicite dans le handler, cette route livrerait à n'importe quel anonyme l'existence des
   * comptes, leurs DN et leur état — exactement ce que l'écran de connexion refuse de révéler.
   */
  function diagnosisFieldsIn(body: unknown): string[] {
    const keys = typeof body === "object" && body !== null ? Object.keys(body) : [];
    return keys.filter((key) => ["found", "dn", "matchedDns", "accountState", "roles", "verdict", "searchBase"].includes(key));
  }

  it("refuse un appel anonyme (401) sans divulguer la moindre information", async () => {
    app = buildServer();
    scenario.searchResults = [[entryOf("x", { distinguishedName: "CN=Yann,OU=ville,DC=lecreusot,DC=priv" })]];

    const response = await app.inject({ method: "POST", url: "/api/auth/ldap-diagnose", payload: { username: "ybanas" } });

    expect(response.statusCode).toBe(401);
    expect(diagnosisFieldsIn(response.json())).toEqual([]);
    expect(response.body).not.toContain("OU=ville");
    // Aucune requête à l'annuaire ne doit même avoir été lancée.
    expect(bindAttempts).toEqual([]);
    expect(searchCalls).toEqual([]);
  });

  it("refuse un utilisateur authentifié non admin (403)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/ldap-diagnose",
      cookies: { [config.session.cookieName]: token },
      payload: { username: "ybanas" },
    });

    expect(response.statusCode).toBe(403);
    expect(diagnosisFieldsIn(response.json())).toEqual([]);
    expect(searchCalls).toEqual([]);
  });

  it("refuse un operator (403) : le diagnostic reste réservé aux admins", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "op", displayName: "Op", roles: ["operator"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/ldap-diagnose",
      cookies: { [config.session.cookieName]: token },
      payload: { username: "ybanas" },
    });

    expect(response.statusCode).toBe(403);
    expect(searchCalls).toEqual([]);
  });

  it("répond à un admin avec le verdict complet", async () => {
    app = buildServer();
    scenario.searchResults = [
      [
        entryOf(ACCENTED_ESCAPED_DN, {
          distinguishedName: ACCENTED_RAW_DN,
          cn: "GROSJEAN Loïc",
          sAMAccountName: "lgrosjean",
          memberOf: ["CN=DSI,OU=Groupes,DC=lecreusot,DC=priv"],
          userAccountControl: "66048",
          "msDS-User-Account-Control-Computed": "0",
          pwdLastSet: "133509857830607440",
        }),
      ],
    ];
    const token = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/ldap-diagnose",
      cookies: { [config.session.cookieName]: token },
      payload: { username: "lgrosjean" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ found: true, matchCount: 1, dn: ACCENTED_RAW_DN, dnHasNonAscii: true });
  });

  it("n'accepte aucun mot de passe : le champ est ignoré et aucun bind utilisateur n'est tenté", async () => {
    app = buildServer();
    scenario.searchResults = [[entryOf("x", { distinguishedName: "CN=Yann,OU=ville,DC=lecreusot,DC=priv", cn: "Yann" })], []];
    const token = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/ldap-diagnose",
      cookies: { [config.session.cookieName]: token },
      payload: { username: "ybanas", password: "jamais-utilise" },
    });

    expect(response.statusCode).toBe(200);
    expect(bindAttempts).toEqual([LDAP_CONFIG.bindDn]);
    expect(JSON.stringify(response.json())).not.toContain("jamais-utilise");
  });

  it("exige un identifiant (400)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/ldap-diagnose",
      cookies: { [config.session.cookieName]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/auth/login — la réponse anonyme reste vague", () => {
  it("renvoie le même message pour un compte inexistant et pour un mot de passe faux", async () => {
    app = buildServer();

    scenario.searchResults = [[]];
    const unknownUser = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "inconnu", password: "x" } });

    scenario.searchResults = [[entryOf("x", { distinguishedName: "CN=Yann,OU=ville,DC=lecreusot,DC=priv", cn: "Yann" })]];
    scenario.bindErrors["CN=Yann,OU=ville,DC=lecreusot,DC=priv"] = adError("52e");
    const wrongPassword = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ybanas", password: "x" } });

    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.body).toBe(wrongPassword.body);
    expect(unknownUser.json()).toEqual({ error: "Invalid credentials" });
  });

  it("ne divulgue jamais qu'un compte est désactivé, verrouillé ou à mot de passe expiré", async () => {
    app = buildServer();

    for (const code of ["533", "775", "532", "773"]) {
      scenario.searchResults = [[entryOf("x", { distinguishedName: "CN=Cible,OU=ville,DC=lecreusot,DC=priv", cn: "Cible" })]];
      scenario.bindErrors["CN=Cible,OU=ville,DC=lecreusot,DC=priv"] = adError(code);

      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "cible", password: "x" } });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid credentials" });
      expect(response.body).not.toContain("OU=ville");
      expect(response.body).not.toContain(code);
    }
  });
});
