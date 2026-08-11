import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// CONFIG_PATH isolé (même pattern que watchdog.test.ts) — gitopsReconciler.ts importe
// transitivement config.js ; la fonction testée ici ne touche pas le disque, mais on s'isole
// quand même préventivement.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { detectDriftTransitions } = await import("../src/services/gitopsReconciler.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

describe("detectDriftTransitions", () => {
  it("reports newly-drifting paths absent from the previously known set", () => {
    const result = detectDriftTransitions(["a.yaml"], ["a.yaml", "b.yaml"]);
    expect(result.newlyDrifting).toEqual(["b.yaml"]);
    expect(result.resolved).toEqual([]);
  });

  it("reports resolved paths present before but absent now", () => {
    const result = detectDriftTransitions(["a.yaml", "b.yaml"], ["a.yaml"]);
    expect(result.newlyDrifting).toEqual([]);
    expect(result.resolved).toEqual(["b.yaml"]);
  });

  it("reports nothing when the drifting set is unchanged", () => {
    const result = detectDriftTransitions(["a.yaml"], ["a.yaml"]);
    expect(result.newlyDrifting).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("reports everything as newly-drifting when nothing was previously known (first observation)", () => {
    const result = detectDriftTransitions([], ["a.yaml", "b.yaml"]);
    expect(result.newlyDrifting).toEqual(["a.yaml", "b.yaml"]);
    expect(result.resolved).toEqual([]);
  });

  it("handles both new drift and resolved drift in the same cycle", () => {
    const result = detectDriftTransitions(["a.yaml", "b.yaml"], ["b.yaml", "c.yaml"]);
    expect(result.newlyDrifting).toEqual(["c.yaml"]);
    expect(result.resolved).toEqual(["a.yaml"]);
  });
});
