import { describe, expect, it } from "vitest";
import { mapGroupsToRoles } from "../src/services/ldap.js";

const groupRoleMap = {
  "cn=dsi-admins,ou=groupes,dc=lecreusot,dc=fr": "admin",
  "cn=dsi-operateurs,ou=groupes,dc=lecreusot,dc=fr": "operator",
  "cn=dsi-lecture,ou=groupes,dc=lecreusot,dc=fr": "viewer",
} as const;

describe("mapGroupsToRoles", () => {
  it("maps a known group DN to its configured role", () => {
    const roles = mapGroupsToRoles(
      ["cn=dsi-admins,ou=groupes,dc=lecreusot,dc=fr"],
      groupRoleMap,
      "viewer",
    );
    expect(roles).toEqual(["admin"]);
  });

  it("is case-insensitive on the group DN", () => {
    const roles = mapGroupsToRoles(
      ["CN=DSI-Admins,OU=Groupes,DC=Lecreusot,DC=Fr"],
      groupRoleMap,
      "viewer",
    );
    expect(roles).toEqual(["admin"]);
  });

  it("collects multiple roles when the user belongs to several mapped groups", () => {
    const roles = mapGroupsToRoles(
      [
        "cn=dsi-admins,ou=groupes,dc=lecreusot,dc=fr",
        "cn=dsi-operateurs,ou=groupes,dc=lecreusot,dc=fr",
        "cn=some-unrelated-group,ou=groupes,dc=lecreusot,dc=fr",
      ],
      groupRoleMap,
      "viewer",
    );
    expect(roles.sort()).toEqual(["admin", "operator"]);
  });

  it("falls back to the default role when no group matches", () => {
    const roles = mapGroupsToRoles(
      ["cn=unmapped-group,ou=groupes,dc=lecreusot,dc=fr"],
      groupRoleMap,
      "viewer",
    );
    expect(roles).toEqual(["viewer"]);
  });

  it("falls back to the default role when the user has no groups at all", () => {
    const roles = mapGroupsToRoles([], groupRoleMap, "viewer");
    expect(roles).toEqual(["viewer"]);
  });

  it("maps by organizational unit (OU) of the user's own DN, not just memberOf groups", () => {
    const ouRoleMap = { "ou=informatique,ou=ville-du-creusot,dc=lecreusot,dc=priv": "admin" } as const;
    const roles = mapGroupsToRoles(
      [], // aucun groupe memberOf : l'utilisateur n'est mappé que via son OU
      ouRoleMap,
      "viewer",
      "CN=Yann Banas,OU=Informatique,OU=ville-du-Creusot,DC=lecreusot,DC=priv",
    );
    expect(roles).toEqual(["admin"]);
  });

  it("does not apply an OU mapping to a user DN outside that OU", () => {
    const ouRoleMap = { "ou=informatique,ou=ville-du-creusot,dc=lecreusot,dc=priv": "admin" } as const;
    const roles = mapGroupsToRoles(
      [],
      ouRoleMap,
      "viewer",
      "CN=Someone Else,OU=Mairie,OU=ville-du-Creusot,DC=lecreusot,DC=priv",
    );
    expect(roles).toEqual(["viewer"]);
  });
});
