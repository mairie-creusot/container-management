import { describe, expect, it } from "vitest";
import { buildServiceModuleGraph, layoutServiceModuleEntities, relationEdgeState } from "./serviceModuleGraph";
import type { ServiceModuleSnapshot } from "./types";

// Le rendu d'un module doit rester GÉNÉRIQUE : ces tests exercent la MÊME fonction sur deux métiers
// sans aucun rapport (annuaire DNS / autocommutateur téléphonique 3CX) — si l'un des deux exigeait
// un cas particulier dans le code, il apparaîtrait ici.

function snapshot(partial: Partial<ServiceModuleSnapshot>): ServiceModuleSnapshot {
  return {
    moduleId: "test",
    generatedAt: "2026-08-19T08:00:00Z",
    status: "ready",
    summary: [],
    entities: [],
    relations: [],
    ...partial,
  };
}

/** Forme DNS : serveur -> zone -> enregistrements. */
const DNS = snapshot({
  moduleId: "ad-dns",
  entities: [
    { id: "server:dc01", kind: "dns-server", label: "dc01.lecreusot.priv", status: "ok" },
    { id: "zone:lecreusot.priv", kind: "dns-zone", label: "lecreusot.priv", status: "ok" },
    { id: "record:a", kind: "dns-record", label: "monapp.lecreusot.priv", status: "ok" },
    { id: "record:b", kind: "dns-record", label: "autre.lecreusot.priv", status: "critical" },
  ],
  relations: [
    { id: "serves", source: "server:dc01", target: "zone:lecreusot.priv", kind: "serves", state: "idle" },
    { id: "c-a", source: "zone:lecreusot.priv", target: "record:a", kind: "contains", state: "active" },
    { id: "c-b", source: "zone:lecreusot.priv", target: "record:b", kind: "contains", state: "failed" },
  ],
});

/** Forme 3CX : deux postes reliés par un APPEL EN COURS — la même structure décrit les deux. */
const THREECX = snapshot({
  moduleId: "3cx",
  entities: [
    { id: "ext:201", kind: "extension", label: "201 — Accueil", status: "ok", details: { État: "Talking" } },
    { id: "ext:305", kind: "extension", label: "305 — Technique", status: "ok" },
    { id: "queue:800", kind: "queue", label: "File Standard", details: { agents: 4 } },
  ],
  relations: [{ id: "call:8821", source: "ext:201", target: "ext:305", kind: "call", label: "00:42", state: "active" }],
});

describe("relationEdgeState", () => {
  it("projette l'état d'une relation sur la palette d'arête DÉJÀ utilisée par le graphe", () => {
    expect(relationEdgeState("active")).toBe("healthy");
    expect(relationEdgeState("failed")).toBe("unhealthy");
    expect(relationEdgeState("idle")).toBe("none");
    expect(relationEdgeState(undefined)).toBe("none");
  });
});

describe("layoutServiceModuleEntities", () => {
  it("dispose en couches selon les relations (serveur, puis zone, puis enregistrements)", () => {
    const positions = layoutServiceModuleEntities(DNS.entities, DNS.relations);
    expect(positions["server:dc01"]!.x).toBeLessThan(positions["zone:lecreusot.priv"]!.x);
    expect(positions["zone:lecreusot.priv"]!.x).toBeLessThan(positions["record:a"]!.x);
    // Deux enregistrements de la même couche partagent l'abscisse et se répartissent en hauteur.
    expect(positions["record:a"]!.x).toBe(positions["record:b"]!.x);
    expect(positions["record:a"]!.y).not.toBe(positions["record:b"]!.y);
  });

  it("place toute entité sans relation sur une unique couche, jamais hors du canevas", () => {
    const positions = layoutServiceModuleEntities(THREECX.entities, []);
    const xs = new Set(Object.values(positions).map((p) => p.x));
    expect(xs).toEqual(new Set([0]));
    expect(Object.keys(positions)).toHaveLength(3);
  });
});

describe("buildServiceModuleGraph", () => {
  it("rend un module DNS : une entité = un nœud, une relation = une arête", () => {
    const graph = buildServiceModuleGraph(DNS, { reducedMotion: false });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.every((node) => node.type === "serviceModuleNode")).toBe(true);
  });

  it("rend un appel EN COURS comme une arête animée (même code que les autres modules)", () => {
    const graph = buildServiceModuleGraph(THREECX, { reducedMotion: false });
    const call = graph.edges.find((edge) => edge.id === "call:8821");
    expect(call?.animated).toBe(true);
    expect((call?.data as { state?: string } | undefined)?.state).toBe("healthy");
    // Le libellé de la relation (durée d'appel) devient le badge flottant de l'arête.
    expect((call?.data as { kindLabel?: string } | undefined)?.kindLabel).toBe("00:42");
  });

  it("coupe l'animation sous prefers-reduced-motion", () => {
    const graph = buildServiceModuleGraph(THREECX, { reducedMotion: true });
    expect(graph.edges[0]?.animated).toBe(false);
  });

  it("ne pose de Handle que sur les entités RÉELLEMENT reliées", () => {
    const graph = buildServiceModuleGraph(THREECX, { reducedMotion: false });
    const byId = new Map(graph.nodes.map((node) => [node.id, node.data as unknown as { hasIncoming: boolean; hasOutgoing: boolean }]));
    expect(byId.get("ext:201")).toMatchObject({ hasIncoming: false, hasOutgoing: true });
    expect(byId.get("ext:305")).toMatchObject({ hasIncoming: true, hasOutgoing: false });
    expect(byId.get("queue:800")).toMatchObject({ hasIncoming: false, hasOutgoing: false });
  });

  it("ignore une relation dont une extrémité n'existe pas plutôt que de dessiner une arête pendante", () => {
    const graph = buildServiceModuleGraph(
      snapshot({
        entities: [{ id: "a", kind: "x", label: "A" }],
        relations: [{ id: "orpheline", source: "a", target: "fantome", kind: "call" }],
      }),
      { reducedMotion: false },
    );
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes).toHaveLength(1);
  });

  it("rend un module vide sans rien inventer", () => {
    const graph = buildServiceModuleGraph(snapshot({ status: "not-configured" }), { reducedMotion: false });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
