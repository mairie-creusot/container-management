import { describe, expect, it } from "vitest";
import { formatCpuTime, formatProcessAge, hexdumpRows } from "./containerInternalsFormat";

describe("formatCpuTime", () => {
  it("formate des secondes pures en HH:MM:SS", () => {
    expect(formatCpuTime(41_000)).toBe("00:00:41");
  });

  it("formate heures/minutes/secondes combinées (exemple de la maquette validée)", () => {
    expect(formatCpuTime((2 * 3600 + 14 * 60 + 9) * 1000)).toBe("02:14:09");
  });

  it("tronque les millisecondes (pas d'arrondi à la seconde supérieure)", () => {
    expect(formatCpuTime(1_999)).toBe("00:00:01");
  });

  it("repli honnête sur 00:00:00 pour une valeur invalide plutôt qu'un NaN affiché", () => {
    expect(formatCpuTime(Number.NaN)).toBe("00:00:00");
    expect(formatCpuTime(-5)).toBe("00:00:00");
  });
});

describe("formatProcessAge", () => {
  it("affiche les secondes sous la minute", () => {
    expect(formatProcessAge(2)).toBe("2s");
  });

  it("affiche les minutes sous l'heure", () => {
    expect(formatProcessAge(31 * 60)).toBe("31m");
  });

  it("affiche heures + minutes zéro-paddées au-delà d'une heure (exemple de la maquette)", () => {
    expect(formatProcessAge(4 * 3600 + 12 * 60)).toBe("4h12");
  });

  it("repli honnête sur un tiret pour une valeur invalide", () => {
    expect(formatProcessAge(Number.NaN)).toBe("—");
    expect(formatProcessAge(-1)).toBe("—");
  });
});

describe("hexdumpRows", () => {
  it("découpe en lignes de 16 octets, groupées par paires, avec ASCII imprimable (en-tête ELF réel)", () => {
    // Mêmes 16 premiers octets que le mockup validé (magic number ELF64) : 7f 45 4c 46 02 01 01
    // puis des zéros jusqu'à 16 octets.
    const firstSixteenBytes = ["7f", "45", "4c", "46", "02", "01", "01", "00", "00", "00", "00", "00", "00", "00", "00", "00"];
    const bytes = firstSixteenBytes.join("");
    const rows = hexdumpRows(bytes, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offsetLabel).toBe("00000000");
    expect(rows[0]!.groups[0]).toBe("7f45");
    expect(rows[0]!.groups[1]).toBe("4c46");
    expect(rows[0]!.ascii.startsWith(".ELF")).toBe(true);
  });

  it("reporte startOffset sur l'étiquette de ligne (navigation au-delà du premier octet)", () => {
    const bytes = "00".repeat(16);
    const rows = hexdumpRows(bytes, 512);
    expect(rows[0]!.offsetLabel).toBe("00000200");
  });

  it("gère une dernière ligne partielle (< 16 octets) sans planter", () => {
    const bytes = "aabbcc";
    const rows = hexdumpRows(bytes, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groups).toEqual(["aabb", "cc"]);
    expect(rows[0]!.ascii).toHaveLength(3);
  });

  it("renvoie un tableau vide pour une chaîne vide (fichier vide, jamais une ligne fabriquée)", () => {
    expect(hexdumpRows("", 0)).toEqual([]);
  });

  it("remplace les octets non imprimables par un point (convention xxd)", () => {
    const rows = hexdumpRows("00ff41", 0);
    expect(rows[0]!.ascii).toBe("..A");
  });
});
