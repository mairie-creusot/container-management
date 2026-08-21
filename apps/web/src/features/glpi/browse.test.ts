import { describe, expect, it } from "vitest";
import { accountLabel, canBrowseOtherAccounts, glpiPagerState } from "@/features/glpi/browse";
import type { Session } from "@/types";

function session(...roles: Session["roles"]): Session {
  return { username: "ybanas", displayName: "Yann Banas", roles };
}

describe("canBrowseOtherAccounts — même frontière que la garde /api/glpi/browse/*", () => {
  it("operator et admin peuvent consulter les tickets d'autrui", () => {
    expect(canBrowseOtherAccounts(session("operator"))).toBe(true);
    expect(canBrowseOtherAccounts(session("admin"))).toBe(true);
    expect(canBrowseOtherAccounts(session("viewer", "operator"))).toBe(true);
  });

  it("un viewer ne le peut pas — le sélecteur de compte ne doit même pas s'afficher", () => {
    expect(canBrowseOtherAccounts(session("viewer"))).toBe(false);
    expect(canBrowseOtherAccounts(null)).toBe(false);
  });
});

describe("accountLabel — le nom réel de GLPI, jamais un nom fabriqué", () => {
  it("nom réel connu : affiché avec l'identifiant entre parenthèses", () => {
    expect(accountLabel({ id: 9, login: "mdupont", displayName: "Marie Dupont" })).toBe("Marie Dupont (mdupont)");
  });

  it("aucun nom réel : l'identifiant seul, jamais dupliqué ni enjolivé", () => {
    expect(accountLabel({ id: 7, login: "ybanas", displayName: "ybanas" })).toBe("ybanas");
  });
});

describe("glpiPagerState — pagination réelle, jamais un total estimé", () => {
  it("première page d'un gros volume", () => {
    const pager = glpiPagerState({ offset: 0, limit: 50, count: 50, total: 3412 });
    expect(pager).toMatchObject({ first: 1, last: 50, hasPrevious: false, hasNext: true, nextOffset: 50 });
    expect(pager.label).toContain("sur 3");
  });

  it("page intermédiaire : retour possible sur la page précédente", () => {
    expect(glpiPagerState({ offset: 100, limit: 50, count: 50, total: 3412 })).toMatchObject({
      first: 101,
      last: 150,
      hasPrevious: true,
      previousOffset: 50,
      hasNext: true,
    });
  });

  it("dernière page : plus de suivant même si la page est pleine", () => {
    expect(glpiPagerState({ offset: 100, limit: 50, count: 50, total: 150 })).toMatchObject({
      last: 150,
      hasNext: false,
    });
  });

  it("page vide : les rangs valent 0, jamais 1", () => {
    expect(glpiPagerState({ offset: 0, limit: 50, count: 0, total: 0 })).toMatchObject({
      first: 0,
      last: 0,
      hasNext: false,
      hasPrevious: false,
    });
  });

  it("total non communiqué : aucune estimation, seule une page pleine laisse supposer une suite", () => {
    const full = glpiPagerState({ offset: 0, limit: 50, count: 50 });
    expect(full.hasNext).toBe(true);
    expect(full.label).toContain("total non communiqué");
    expect(full.label).not.toContain("sur ");

    expect(glpiPagerState({ offset: 0, limit: 50, count: 12 }).hasNext).toBe(false);
  });

  it("un offset aberrant ne produit jamais de rang négatif", () => {
    expect(glpiPagerState({ offset: -10, limit: 50, count: 3, total: 3 })).toMatchObject({
      first: 1,
      last: 3,
      hasPrevious: false,
      previousOffset: 0,
    });
  });
});
