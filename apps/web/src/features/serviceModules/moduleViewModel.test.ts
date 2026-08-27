import { describe, expect, it } from "vitest";
import {
  activeEntityIds,
  activeRelations,
  formatAge,
  groupEntities,
  matchesQuery,
  newlyAppeared,
  relationsOf,
  resolveRelations,
} from "./moduleViewModel";
import type { ServiceModuleEntity, ServiceModuleSnapshot } from "./types";

// Ces dérivations doivent rester GÉNÉRIQUES : elles sont exercées ici sur un autocommutateur
// (postes + appels en cours) — si un module exigeait un cas particulier, il apparaîtrait ici.

function entity(id: string, kind: string, label: string, details?: Record<string, string | number>): ServiceModuleEntity {
  return { id, kind, label, ...(details ? { details } : {}) };
}

function snapshot(partial: Partial<ServiceModuleSnapshot>): ServiceModuleSnapshot {
  return {
    moduleId: "3cx",
    generatedAt: "2026-08-27T08:00:00Z",
    status: "ready",
    summary: [],
    entities: [],
    relations: [],
    ...partial,
  };
}

const ACCUEIL = entity("ext:201", "extension", "201 — Accueil", { Numéro: "201", Terminal: "Yealink T54W" });
const TECHNIQUE = entity("ext:305", "extension", "305 — Technique", { Numéro: "305" });
const FILE = entity("queue:800", "queue", "800 — File Standard");

describe("resolveRelations — une relation pendante n'est jamais rendue", () => {
  it("garde celles dont les deux extrémités existent, écarte les autres", () => {
    const resolved = resolveRelations(
      snapshot({
        entities: [ACCUEIL, TECHNIQUE],
        relations: [
          { id: "call:1", source: "ext:201", target: "ext:305", kind: "call", state: "active" },
          // Cible inconnue : jamais une ligne « 201 → ? » fabriquée pour sauver la donnée.
          { id: "call:2", source: "ext:201", target: "ext:999", kind: "call", state: "active" },
        ],
      }),
    );

    expect(resolved.map((entry) => entry.relation.id)).toEqual(["call:1"]);
    expect(resolved[0]?.source.label).toBe("201 — Accueil");
    expect(resolved[0]?.target.label).toBe("305 — Technique");
  });
});

describe("ce qui est vivant à cet instant", () => {
  const resolved = resolveRelations(
    snapshot({
      entities: [ACCUEIL, TECHNIQUE, FILE],
      relations: [
        { id: "call:1", source: "ext:201", target: "ext:305", kind: "call", state: "active" },
        { id: "member:1", source: "queue:800", target: "ext:305", kind: "contains", state: "idle" },
      ],
    }),
  );

  it("seules les relations actives comptent comme en cours", () => {
    expect(activeRelations(resolved).map((entry) => entry.relation.id)).toEqual(["call:1"]);
  });

  it("les deux extrémités d'un échange en cours sont signalées, jamais les autres", () => {
    const ids = activeEntityIds(resolved);
    expect([...ids].sort()).toEqual(["ext:201", "ext:305"]);
    expect(ids.has("queue:800")).toBe(false);
  });
});

describe("recherche — jusque dans les valeurs de détail", () => {
  it("trouve par libellé, par type et par valeur de détail", () => {
    expect(matchesQuery(ACCUEIL, "accueil")).toBe(true);
    expect(matchesQuery(ACCUEIL, "extension")).toBe(true);
    // Le terminal n'apparaît pas dans le libellé : sans les détails, ce poste serait introuvable.
    expect(matchesQuery(ACCUEIL, "yealink")).toBe(true);
    expect(matchesQuery(ACCUEIL, "305")).toBe(false);
  });

  it("une recherche vide ne masque rien", () => {
    expect(matchesQuery(FILE, "")).toBe(true);
    expect(matchesQuery(FILE, "   ")).toBe(true);
  });
});

describe("groupEntities — l'ordre du module, jamais un classement inventé", () => {
  it("groupe par type en conservant l'ordre d'apparition", () => {
    const groups = groupEntities([ACCUEIL, FILE, TECHNIQUE]);
    expect(groups.map((group) => group.kind)).toEqual(["extension", "queue"]);
    expect(groups[0]?.entities.map((e) => e.id)).toEqual(["ext:201", "ext:305"]);
  });
});

describe("relationsOf — le sens de lecture est conservé", () => {
  const resolved = resolveRelations(
    snapshot({
      entities: [ACCUEIL, TECHNIQUE],
      relations: [{ id: "call:1", source: "ext:201", target: "ext:305", kind: "call", state: "active" }],
    }),
  );

  it("distingue ce qui part de l'entité de ce qui y arrive", () => {
    expect(relationsOf("ext:201", resolved).outgoing.map((e) => e.relation.id)).toEqual(["call:1"]);
    expect(relationsOf("ext:201", resolved).incoming).toEqual([]);
    expect(relationsOf("ext:305", resolved).incoming.map((e) => e.relation.id)).toEqual(["call:1"]);
  });
});

describe("newlyAppeared — un appel qui DÉMARRE se distingue de ceux déjà en cours", () => {
  const resolved = resolveRelations(
    snapshot({
      entities: [ACCUEIL, TECHNIQUE],
      relations: [
        { id: "call:1", source: "ext:201", target: "ext:305", kind: "call", state: "active" },
        { id: "call:2", source: "ext:305", target: "ext:201", kind: "call", state: "active" },
      ],
    }),
  );

  it("premier instantané : rien n'est signalé comme nouveau", () => {
    // Tout signaler à l'ouverture ferait clignoter l'écran entier sans rien apprendre.
    expect(newlyAppeared(new Set(), resolved).size).toBe(0);
  });

  it("signale exactement ce qui n'était pas là au relevé précédent", () => {
    expect([...newlyAppeared(new Set(["call:1"]), resolved)]).toEqual(["call:2"]);
  });

  it("un appel toujours en cours n'est pas re-signalé", () => {
    expect(newlyAppeared(new Set(["call:1", "call:2"]), resolved).size).toBe(0);
  });
});

describe("formatAge", () => {
  const at = "2026-08-27T08:00:00Z";
  const base = new Date(at).getTime();

  it("dit la fraîcheur réelle de l'instantané affiché", () => {
    expect(formatAge(at, base + 3000)).toBe("il y a 3 s");
    expect(formatAge(at, base + 90_000)).toBe("il y a 1 min");
    expect(formatAge(at, base + 7_200_000)).toBe("il y a 2 h");
  });

  it("une horloge en avance ne produit jamais un âge négatif", () => {
    expect(formatAge(at, base - 5000)).toBe("il y a 0 s");
  });

  it("une date illisible est dite telle quelle, jamais remplacée par une valeur plausible", () => {
    expect(formatAge("pas une date", base)).toBe("date inconnue");
  });
});
