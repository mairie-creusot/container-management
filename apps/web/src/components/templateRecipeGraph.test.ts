import { describe, expect, it } from "vitest";
import {
  RECIPE_COLUMN_SPACING,
  RECIPE_SOURCE_OFFSET_Y,
  buildTemplateRecipeGraph,
  templateRecipeNodeId,
} from "./topologyGraphShared";
import type { ImageTemplate, TemplateStep } from "@/types";

// Sous-graphe "recette" (18/08/2026) : l'ordre VISUEL gauche -> droite des nœuds synthétiques doit
// être exactement l'ordre réel d'exécution de steps[], la chaîne base -> étape1 -> ... câblée sans
// trou, et chaque étape "artifact" recevoir une arête cyan depuis son template source (dédupliqué).

function makeTemplate(steps: TemplateStep[], overrides: Partial<ImageTemplate> = {}): ImageTemplate {
  return {
    id: "tpl-1",
    name: "custom-appliance",
    base: { type: "container", image: "debian:bookworm" },
    steps,
    status: "draft",
    workspaceId: "ws-1",
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
    ...overrides,
  };
}

const NO_NAMES = new Map<string, string>();

describe("buildTemplateRecipeGraph", () => {
  it("base seule à gauche pour une recette vide — aucun nœud d'étape, aucune arête", () => {
    const { nodes, edges } = buildTemplateRecipeGraph(makeTemplate([]), { reducedMotion: false, templateNameById: NO_NAMES });
    expect(nodes.map((n) => n.id)).toEqual([templateRecipeNodeId("base", "root")]);
    expect(nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(edges).toEqual([]);
  });

  it("un nœud par étape, x croissant = ordre réel d'exécution, chaîne câblée sans trou", () => {
    const steps: TemplateStep[] = [
      { type: "packages", packages: ["nginx"] },
      { type: "script", content: "echo ok" },
      { type: "service", name: "nginx", enable: true },
    ];
    const { nodes, edges } = buildTemplateRecipeGraph(makeTemplate(steps), { reducedMotion: false, templateNameById: NO_NAMES });

    const stepNodes = nodes.filter((n) => (n.data as { role?: string }).role === "step");
    expect(stepNodes).toHaveLength(3);
    stepNodes.forEach((n, index) => {
      expect(n.id).toBe(templateRecipeNodeId("step", index));
      expect(n.position.x).toBe((index + 1) * RECIPE_COLUMN_SPACING);
      expect(n.position.y).toBe(0);
    });

    const chain = edges.filter((e) => e.id.startsWith("recipe-chain:"));
    expect(chain.map((e) => [e.source, e.target])).toEqual([
      [templateRecipeNodeId("base", "root"), templateRecipeNodeId("step", 0)],
      [templateRecipeNodeId("step", 0), templateRecipeNodeId("step", 1)],
      [templateRecipeNodeId("step", 1), templateRecipeNodeId("step", 2)],
    ]);
  });

  it("étape artifact : arête cyan entrante depuis le template source, nom réel si connu", () => {
    const steps: TemplateStep[] = [{ type: "artifact", templateId: "tpl-src", destPath: "/opt/app.tar" }];
    const names = new Map([["tpl-src", "base-runtime"]]);
    const { nodes, edges } = buildTemplateRecipeGraph(makeTemplate(steps), { reducedMotion: true, templateNameById: names });

    const source = nodes.find((n) => n.id === templateRecipeNodeId("artifact-source", "tpl-src"));
    expect(source).toBeDefined();
    expect((source!.data as { title?: string }).title).toBe("base-runtime");
    expect((source!.data as { sourceTemplateId?: string }).sourceTemplateId).toBe("tpl-src");
    // Au-dessus de l'étape consommatrice, jamais dans la chaîne.
    expect(source!.position).toEqual({ x: RECIPE_COLUMN_SPACING, y: RECIPE_SOURCE_OFFSET_Y });

    const artifactEdge = edges.find((e) => e.id === "recipe-artifact:0");
    expect(artifactEdge).toBeDefined();
    expect(artifactEdge!.source).toBe(templateRecipeNodeId("artifact-source", "tpl-src"));
    expect(artifactEdge!.target).toBe(templateRecipeNodeId("step", 0));
    expect(artifactEdge!.targetHandle).toBe("artifact-in");
    expect(artifactEdge!.className).toContain("topology-edge--uses-artifact");
    // prefers-reduced-motion : jamais de tirets défilants.
    expect(artifactEdge!.animated).toBe(false);
    expect((artifactEdge!.data as { kindLabel?: string }).kindLabel).toBe("artefact base-runtime");
  });

  it("même template source consommé deux fois -> UN seul nœud source, une arête par consommation", () => {
    const steps: TemplateStep[] = [
      { type: "artifact", templateId: "tpl-src", destPath: "/opt/a.tar" },
      { type: "script", content: "echo ok" },
      { type: "artifact", templateId: "tpl-src", destPath: "/opt/b.tar" },
    ];
    const { nodes, edges } = buildTemplateRecipeGraph(makeTemplate(steps), { reducedMotion: false, templateNameById: NO_NAMES });

    const sources = nodes.filter((n) => (n.data as { role?: string }).role === "artifact-source");
    expect(sources).toHaveLength(1);
    // Nom inconnu (liste pas chargée) -> repli honnête sur l'id, jamais un nom inventé.
    expect((sources[0]!.data as { title?: string }).title).toBe("tpl-src");
    const artifactEdges = edges.filter((e) => e.id.startsWith("recipe-artifact:"));
    expect(artifactEdges.map((e) => e.target)).toEqual([templateRecipeNodeId("step", 0), templateRecipeNodeId("step", 2)]);
    expect(artifactEdges.every((e) => e.animated)).toBe(true);
  });
});
