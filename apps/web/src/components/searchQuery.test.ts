import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  matchesSearchQuery,
  normalizeSearchText,
  parseSearchQuery,
  suggestCompletions,
  toComparableNumber,
  type SearchFieldSpec,
  type SearchableRecord,
} from "./searchQuery";

const FIELDS: SearchFieldSpec[] = [
  { key: "numero", label: "Numéro", kind: "number", aliases: ["ext"] },
  { key: "nom", label: "Nom", kind: "text" },
  { key: "presence", label: "Présence", kind: "text", values: ["available", "away", "dnd"] },
  { key: "joignable", label: "Joignable", kind: "boolean" },
  { key: "taille", label: "Taille", kind: "number" },
];

function record(
  fields: Record<string, { text?: string; number?: number | null; boolean?: boolean | null }>,
  text: string,
): SearchableRecord {
  const built: SearchableRecord["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    built[key] = {
      text: normalizeSearchText(value.text ?? ""),
      number: value.number ?? null,
      boolean: value.boolean ?? null,
    };
  }
  return { fields: built, text: normalizeSearchText(text) };
}

const ROW = record(
  {
    numero: { text: "5721", number: 5721 },
    nom: { text: "Jean Dupont", number: null },
    presence: { text: "available" },
    joignable: { text: "oui", number: 1, boolean: true },
    taille: { text: "42", number: 42 },
  },
  "5721 Jean Dupont available oui 42",
);

describe("parseSearchQuery — texte libre", () => {
  it("découpe les mots et normalise accents et casse", () => {
    const parsed = parseSearchQuery("Jean  DUPONT", FIELDS);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes.map((n) => n.kind === "text" && n.value)).toEqual(["jean", "dupont"]);
    expect(parsed.isEmpty).toBe(false);
  });

  it("traite une requête vide ou uniquement blanche comme sans filtre", () => {
    expect(parseSearchQuery("", FIELDS).isEmpty).toBe(true);
    expect(parseSearchQuery("   \t ", FIELDS).isEmpty).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("", FIELDS), ROW)).toBe(true);
  });

  it("ignore les accents des deux côtés de la comparaison", () => {
    const row = record({ nom: { text: "Réseau" } }, "Réseau");
    expect(matchesSearchQuery(parseSearchQuery("reseau", FIELDS), row)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("RÉSEAU", FIELDS), row)).toBe(true);
  });
});

describe("parseSearchQuery — champ:valeur", () => {
  it("reconnaît un filtre par champ", () => {
    const parsed = parseSearchQuery("presence:available", FIELDS);
    expect(parsed.nodes[0]).toMatchObject({
      kind: "field",
      field: "presence",
      operator: ":",
      value: "available",
      negated: false,
    });
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
  });

  it("accepte les alias et le libellé de colonne comme nom de champ", () => {
    expect(parseSearchQuery("ext:57", FIELDS).nodes[0]).toMatchObject({ field: "numero" });
    expect(parseSearchQuery("numéro:57", FIELDS).nodes[0]).toMatchObject({ field: "numero" });
  });

  it("combine plusieurs filtres en ET", () => {
    const parsed = parseSearchQuery("numero:57 presence:available joignable:oui", FIELDS);
    expect(parsed.nodes).toHaveLength(3);
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("numero:99 presence:available", FIELDS), ROW)).toBe(false);
  });

  it("interprète les valeurs booléennes en français comme en anglais", () => {
    for (const query of ["joignable:oui", "joignable:true", "joignable:1"]) {
      expect(matchesSearchQuery(parseSearchQuery(query, FIELDS), ROW)).toBe(true);
    }
    for (const query of ["joignable:non", "joignable:false", "joignable:0"]) {
      expect(matchesSearchQuery(parseSearchQuery(query, FIELDS), ROW)).toBe(false);
    }
  });

  it("ignore un filtre dont la valeur n'est pas encore saisie", () => {
    const parsed = parseSearchQuery("presence:", FIELDS);
    expect(parsed.nodes).toHaveLength(0);
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
  });

  it("signale un champ inconnu et retombe sur la recherche libre", () => {
    const parsed = parseSearchQuery("inconnu:dupont", FIELDS);
    expect(parsed.unknownFields).toEqual(["inconnu"]);
    expect(parsed.nodes[0]).toMatchObject({ kind: "text", value: "dupont" });
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
  });
});

describe("parseSearchQuery — exclusion", () => {
  it("exclut un terme libre préfixé de -", () => {
    const parsed = parseSearchQuery("-dupont", FIELDS);
    expect(parsed.nodes[0]).toMatchObject({ kind: "text", negated: true, value: "dupont" });
    expect(matchesSearchQuery(parsed, ROW)).toBe(false);
    expect(matchesSearchQuery(parseSearchQuery("-martin", FIELDS), ROW)).toBe(true);
  });

  it("exclut un filtre par champ", () => {
    expect(matchesSearchQuery(parseSearchQuery("-presence:available", FIELDS), ROW)).toBe(false);
    expect(matchesSearchQuery(parseSearchQuery("-presence:dnd", FIELDS), ROW)).toBe(true);
  });

  it("ne confond pas un tiret interne ou isolé avec une exclusion", () => {
    expect(parseSearchQuery("bureau-1", FIELDS).nodes[0]).toMatchObject({
      negated: false,
      value: "bureau-1",
    });
    expect(parseSearchQuery("-", FIELDS).nodes[0]).toMatchObject({ negated: false, value: "-" });
  });
});

describe("parseSearchQuery — guillemets", () => {
  it("garde une expression entre guillemets en un seul terme", () => {
    const parsed = parseSearchQuery('"jean dupont"', FIELDS);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toMatchObject({ kind: "text", value: "jean dupont", phrase: true });
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery('"dupont jean"', FIELDS), ROW)).toBe(false);
  });

  it("rend un filtre par champ strictement égal quand la valeur est entre guillemets", () => {
    expect(matchesSearchQuery(parseSearchQuery('presence:"available"', FIELDS), ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery('presence:"avail"', FIELDS), ROW)).toBe(false);
    expect(matchesSearchQuery(parseSearchQuery("presence:avail", FIELDS), ROW)).toBe(true);
  });

  it("accepte les espaces dans une valeur de champ entre guillemets", () => {
    const parsed = parseSearchQuery('nom:"jean dupont"', FIELDS);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toMatchObject({ field: "nom", value: "jean dupont", exact: true });
    expect(matchesSearchQuery(parsed, ROW)).toBe(true);
  });

  it("combine exclusion et guillemets", () => {
    expect(matchesSearchQuery(parseSearchQuery('-"jean dupont"', FIELDS), ROW)).toBe(false);
  });
});

describe("parseSearchQuery — comparaisons numériques", () => {
  it("gère >, <, >= et <= sur une colonne numérique", () => {
    expect(matchesSearchQuery(parseSearchQuery("taille:>40", FIELDS), ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("taille:>42", FIELDS), ROW)).toBe(false);
    expect(matchesSearchQuery(parseSearchQuery("taille:>=42", FIELDS), ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("taille:<50", FIELDS), ROW)).toBe(true);
    expect(matchesSearchQuery(parseSearchQuery("taille:<=41", FIELDS), ROW)).toBe(false);
  });

  it("n'applique jamais une comparaison sur une colonne non numérique", () => {
    expect(matchesSearchQuery(parseSearchQuery("nom:>5", FIELDS), ROW)).toBe(false);
  });

  it("accepte la virgule décimale et les dates ISO", () => {
    expect(toComparableNumber("12,5")).toBe(12.5);
    expect(toComparableNumber("2026-08-17")).toBe(Date.parse("2026-08-17"));
    expect(toComparableNumber("1.2.3")).toBeNull();
    expect(toComparableNumber("42 Go")).toBeNull();
  });
});

describe("parseSearchQuery — requêtes invalides", () => {
  it("ne plante sur aucune entrée dégénérée", () => {
    const inputs = [
      '"',
      '""',
      '"non fermé',
      ":",
      "::",
      ":valeur",
      "-:",
      "-",
      "--",
      "champ:>",
      "taille:>abc",
      "presence::available",
      '  "  ',
      "\\",
      "()[]{}*?+",
      "a".repeat(500),
    ];
    for (const input of inputs) {
      expect(() => {
        const parsed = parseSearchQuery(input, FIELDS);
        matchesSearchQuery(parsed, ROW);
      }, input).not.toThrow();
    }
  });

  it("traite un deux-points en tête comme du texte libre", () => {
    expect(parseSearchQuery(":dupont", FIELDS).nodes[0]).toMatchObject({
      kind: "text",
      value: ":dupont",
    });
  });

  it("ferme implicitement un guillemet non refermé", () => {
    const parsed = parseSearchQuery('nom:"jean dup', FIELDS);
    expect(parsed.nodes[0]).toMatchObject({ field: "nom", value: "jean dup" });
  });

  it("ignore un opérateur sans opérande", () => {
    expect(parseSearchQuery("taille:>", FIELDS).nodes).toHaveLength(0);
    expect(matchesSearchQuery(parseSearchQuery("taille:>abc", FIELDS), ROW)).toBe(false);
  });
});

describe("suggestCompletions", () => {
  it("propose les champs filtrables du tableau courant", () => {
    const suggestions = suggestCompletions("pre", FIELDS);
    expect(suggestions.map((s) => s.insert)).toEqual(["presence:"]);
    expect(suggestions[0]?.hint).toBe("Présence");
  });

  it("propose les valeurs connues après champ:", () => {
    expect(suggestCompletions("presence:a", FIELDS).map((s) => s.insert)).toEqual([
      "presence:available",
      "presence:away",
    ]);
  });

  it("propose oui/non sur une colonne booléenne sans valeurs déclarées", () => {
    expect(suggestCompletions("joignable:", FIELDS).map((s) => s.insert)).toEqual([
      "joignable:oui",
      "joignable:non",
    ]);
  });

  it("ne propose rien quand le jeton courant est terminé par un espace", () => {
    expect(suggestCompletions("presence:available ", FIELDS)).toEqual([]);
  });

  it("remplace uniquement le jeton en cours de frappe", () => {
    expect(applySuggestion("numero:57 pre", { insert: "presence:", label: "", hint: "", appendSpace: false })).toBe(
      "numero:57 presence:",
    );
    expect(
      applySuggestion("presence:a", { insert: "presence:available", label: "", hint: "", appendSpace: true }),
    ).toBe("presence:available ");
  });
});
