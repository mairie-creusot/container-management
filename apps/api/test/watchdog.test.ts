import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ImageRef } from "../src/types.js";

// CONFIG_PATH isolé (même pattern que les autres suites) — watchdog.ts importe transitivement
// setupStore.js/config.js ; aucune des fonctions testées ici ne touche le disque, mais on
// s'isole quand même préventivement (voir containers.test.ts pour la même remarque).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { detectNewlyUpdatedImages, detectReachabilityTransition } = await import("../src/services/watchdog.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

function image(overrides: Partial<ImageRef> = {}): ImageRef {
  return {
    id: "local:nginx:1.25",
    name: "nginx",
    registry: "dockerhub",
    currentTag: "1.25",
    latestTag: "1.27",
    environment: "Dev local",
    status: "update",
    digest: "sha256:abc",
    sizeBytes: 1000,
    layers: 3,
    ...overrides,
  };
}

describe("detectNewlyUpdatedImages", () => {
  it("returns only images absent from the previously known ids", () => {
    const current = [image({ id: "a" }), image({ id: "b" }), image({ id: "c" })];
    const result = detectNewlyUpdatedImages(["a", "c"], current);
    expect(result.map((i) => i.id)).toEqual(["b"]);
  });

  it("returns nothing when every currently-updatable image was already known", () => {
    const current = [image({ id: "a" }), image({ id: "b" })];
    const result = detectNewlyUpdatedImages(["a", "b"], current);
    expect(result).toEqual([]);
  });

  it("returns everything when nothing was previously known (first observation)", () => {
    const current = [image({ id: "a" })];
    const result = detectNewlyUpdatedImages([], current);
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("detectReachabilityTransition", () => {
  it("reports no transition when the integration was never observed before", () => {
    expect(detectReachabilityTransition(undefined, true)).toBe("none");
    expect(detectReachabilityTransition(undefined, false)).toBe("none");
  });

  it("reports no transition when the state did not change", () => {
    expect(detectReachabilityTransition(true, true)).toBe("none");
    expect(detectReachabilityTransition(false, false)).toBe("none");
  });

  it("reports became-unreachable when a reachable integration stops responding", () => {
    expect(detectReachabilityTransition(true, false)).toBe("became-unreachable");
  });

  it("reports became-reachable when an unreachable integration responds again", () => {
    expect(detectReachabilityTransition(false, true)).toBe("became-reachable");
  });
});
