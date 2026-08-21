import { describe, expect, it } from "vitest";
import {
  compareCellValues,
  computePageWindow,
  nextSort,
  parsePageSize,
  searchFieldsFromColumns,
  slicePage,
  sortRows,
  toSearchableRecord,
  type DataTableColumn,
} from "./dataTableModel";
import { matchesSearchQuery, parseSearchQuery } from "./searchQuery";

interface Poste {
  numero: number;
  nom: string;
  presence: string;
  joignable: boolean;
  dernierAppel: string | null;
}

const COLUMNS: DataTableColumn<Poste>[] = [
  { key: "numero", label: "Numéro", accessor: (r) => r.numero, kind: "number", aliases: ["ext"] },
  { key: "nom", label: "Nom", accessor: (r) => r.nom },
  { key: "presence", label: "Présence", accessor: (r) => r.presence, values: ["available", "away"] },
  { key: "joignable", label: "Joignable", accessor: (r) => r.joignable, kind: "boolean" },
  { key: "dernierAppel", label: "Dernier appel", accessor: (r) => r.dernierAppel, kind: "date" },
  { key: "actions", label: "Actions", accessor: () => null, filterable: false, searchable: false },
];

const POSTES: Poste[] = [
  { numero: 5721, nom: "Jean Dupont", presence: "available", joignable: true, dernierAppel: "2026-08-17" },
  { numero: 5702, nom: "Émile Zola", presence: "away", joignable: false, dernierAppel: "2026-01-04" },
  { numero: 5710, nom: "alice Martin", presence: "available", joignable: true, dernierAppel: null },
];

const accessor = (row: Poste, key: string) => COLUMNS.find((c) => c.key === key)?.accessor(row);

describe("nextSort", () => {
  it("cycle aucun -> ascendant -> descendant -> aucun", () => {
    const asc = nextSort(null, "nom");
    expect(asc).toEqual({ key: "nom", direction: "asc" });
    const desc = nextSort(asc, "nom");
    expect(desc).toEqual({ key: "nom", direction: "desc" });
    expect(nextSort(desc, "nom")).toBeNull();
  });

  it("repart en ascendant quand on change de colonne", () => {
    expect(nextSort({ key: "nom", direction: "desc" }, "numero")).toEqual({
      key: "numero",
      direction: "asc",
    });
  });
});

describe("sortRows", () => {
  it("trie les nombres numériquement et non alphabétiquement", () => {
    const sorted = sortRows(POSTES, { key: "numero", direction: "asc" }, accessor);
    expect(sorted.map((p) => p.numero)).toEqual([5702, 5710, 5721]);
  });

  it("inverse l'ordre en descendant", () => {
    const sorted = sortRows(POSTES, { key: "numero", direction: "desc" }, accessor);
    expect(sorted.map((p) => p.numero)).toEqual([5721, 5710, 5702]);
  });

  it("trie le texte sans tenir compte de la casse ni des accents", () => {
    const sorted = sortRows(POSTES, { key: "nom", direction: "asc" }, accessor);
    expect(sorted.map((p) => p.nom)).toEqual(["alice Martin", "Émile Zola", "Jean Dupont"]);
  });

  it("garde les valeurs vides en fin de liste dans les deux sens", () => {
    const asc = sortRows(POSTES, { key: "dernierAppel", direction: "asc" }, accessor);
    const desc = sortRows(POSTES, { key: "dernierAppel", direction: "desc" }, accessor);
    expect(asc[asc.length - 1]?.dernierAppel).toBeNull();
    expect(desc[desc.length - 1]?.dernierAppel).toBeNull();
  });

  it("ne modifie pas le tableau source et le renvoie tel quel sans tri", () => {
    const source = [...POSTES];
    sortRows(source, { key: "numero", direction: "desc" }, accessor);
    expect(source.map((p) => p.numero)).toEqual([5721, 5702, 5710]);
    expect(sortRows(source, null, accessor)).toBe(source);
  });

  it("est stable sur des valeurs égales", () => {
    const sorted = sortRows(POSTES, { key: "presence", direction: "asc" }, accessor);
    expect(sorted.map((p) => p.numero)).toEqual([5721, 5710, 5702]);
  });

  it("compare les dates ISO chronologiquement", () => {
    expect(compareCellValues("2026-01-04", "2026-08-17")).toBeLessThan(0);
    expect(compareCellValues(false, true)).toBeLessThan(0);
  });
});

describe("computePageWindow", () => {
  it("décrit la première page", () => {
    const win = computePageWindow(120, 25, 1);
    expect(win).toMatchObject({ page: 1, totalPages: 5, startIndex: 0, endIndex: 25, firstItem: 1, lastItem: 25 });
  });

  it("décrit une page intermédiaire puis la dernière page incomplète", () => {
    expect(computePageWindow(120, 50, 2)).toMatchObject({ startIndex: 50, endIndex: 100, firstItem: 51 });
    expect(computePageWindow(120, 50, 3)).toMatchObject({ page: 3, startIndex: 100, endIndex: 120, lastItem: 120 });
  });

  it("ramène une page hors limites sur la dernière page existante", () => {
    expect(computePageWindow(12, 25, 7)).toMatchObject({ page: 1, totalPages: 1, endIndex: 12 });
    expect(computePageWindow(120, 25, 99)).toMatchObject({ page: 5, startIndex: 100, endIndex: 120 });
    expect(computePageWindow(120, 25, 0)).toMatchObject({ page: 1 });
    expect(computePageWindow(120, 25, Number.NaN)).toMatchObject({ page: 1 });
  });

  it("gère une liste vide sans page fantôme", () => {
    expect(computePageWindow(0, 25, 3)).toMatchObject({
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      firstItem: 0,
      lastItem: 0,
    });
  });

  it("« Tout » ramène une page unique couvrant l'ensemble", () => {
    const win = computePageWindow(347, "all", 4);
    expect(win).toMatchObject({ page: 1, totalPages: 1, startIndex: 0, endIndex: 347, firstItem: 1, lastItem: 347 });
    expect(slicePage(Array.from({ length: 347 }, (_, i) => i), win)).toHaveLength(347);
  });

  it("traite une taille de page absurde comme « Tout »", () => {
    expect(computePageWindow(30, 0, 2)).toMatchObject({ pageSize: "all", totalPages: 1, endIndex: 30 });
    expect(computePageWindow(30, -5, 2)).toMatchObject({ pageSize: "all", endIndex: 30 });
  });

  it("découpe la page correspondante", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(slicePage(rows, computePageWindow(7, 3, 2))).toEqual([3, 4, 5]);
    expect(slicePage(rows, computePageWindow(7, 3, 3))).toEqual([6]);
  });
});

describe("parsePageSize", () => {
  it("relit une taille mémorisée et rejette les valeurs invalides", () => {
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("all")).toBe("all");
    expect(parsePageSize(100)).toBe(100);
    expect(parsePageSize("abc")).toBeNull();
    expect(parsePageSize("-1")).toBeNull();
    expect(parsePageSize(null)).toBeNull();
    expect(parsePageSize(undefined)).toBeNull();
  });
});

describe("searchFieldsFromColumns", () => {
  it("dérive les champs filtrables des colonnes déclarées", () => {
    const fields = searchFieldsFromColumns(COLUMNS);
    expect(fields.map((f) => f.key)).toEqual(["numero", "nom", "presence", "joignable", "dernierAppel"]);
    expect(fields[0]).toMatchObject({ label: "Numéro", kind: "number", aliases: ["ext"] });
    expect(fields[1]?.kind).toBe("text");
  });
});

describe("toSearchableRecord + recherche de bout en bout", () => {
  const fields = searchFieldsFromColumns(COLUMNS);
  const search = (query: string) =>
    POSTES.filter((poste) =>
      matchesSearchQuery(parseSearchQuery(query, fields), toSearchableRecord(poste, COLUMNS)),
    ).map((p) => p.numero);

  it("exclut les colonnes non cherchables du texte libre", () => {
    const record = toSearchableRecord(POSTES[0] as Poste, COLUMNS);
    expect(record.fields.actions).toBeUndefined();
    expect(record.text).toContain("jean dupont");
  });

  it("filtre sur du texte libre, un champ, une exclusion et une comparaison", () => {
    expect(search("dupont")).toEqual([5721]);
    expect(search("presence:available")).toEqual([5721, 5710]);
    expect(search("presence:available -martin")).toEqual([5721]);
    expect(search("numero:>5705")).toEqual([5721, 5710]);
    expect(search("joignable:non")).toEqual([5702]);
    expect(search('nom:"emile zola"')).toEqual([5702]);
    expect(search("ext:5702")).toEqual([5702]);
    expect(search("")).toEqual([5721, 5702, 5710]);
  });

  it("ne compare jamais numériquement une colonne texte", () => {
    expect(search("nom:>1")).toEqual([]);
  });
});
