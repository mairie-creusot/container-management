import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContainerMetricPoint } from "../src/types.js";

// CONFIG_PATH isolé (même pattern que scanScheduler.test.ts) — purgeOldMetricPoints est pure et
// ne touche jamais le disque, mais on s'isole quand même préventivement.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { purgeOldMetricPoints } = await import("../src/services/metricsCollector.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

function point(overrides: Partial<ContainerMetricPoint> = {}): ContainerMetricPoint {
  return {
    containerId: "abc123",
    timestamp: "2026-08-12T10:00:00.000Z",
    cpuPercent: 12.3,
    memBytes: 1024,
    ...overrides,
  };
}

const NOW = new Date("2026-08-12T12:00:00.000Z").getTime();
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours, défaut du projet

describe("purgeOldMetricPoints — fenêtre glissante", () => {
  it("keeps a point that is within the retention window", () => {
    const recent = point({ timestamp: new Date(NOW - 60_000).toISOString() });
    expect(purgeOldMetricPoints([recent], RETENTION_MS, NOW)).toEqual([recent]);
  });

  it("drops a point older than the retention window", () => {
    const old = point({ timestamp: new Date(NOW - RETENTION_MS - 60_000).toISOString() });
    expect(purgeOldMetricPoints([old], RETENTION_MS, NOW)).toEqual([]);
  });

  it("keeps a point exactly at the retention boundary excluded (strictly older is dropped)", () => {
    const atBoundary = point({ timestamp: new Date(NOW - RETENTION_MS).toISOString() });
    expect(purgeOldMetricPoints([atBoundary], RETENTION_MS, NOW)).toEqual([]);
  });

  it("filters a mixed set, keeping only recent points, regardless of container", () => {
    const recentA = point({ containerId: "a", timestamp: new Date(NOW - 1_000).toISOString() });
    const recentB = point({ containerId: "b", timestamp: new Date(NOW - 2_000).toISOString() });
    const oldA = point({ containerId: "a", timestamp: new Date(NOW - RETENTION_MS - 1_000).toISOString() });
    expect(purgeOldMetricPoints([recentA, oldA, recentB], RETENTION_MS, NOW)).toEqual([recentA, recentB]);
  });

  it("returns an empty array unchanged", () => {
    expect(purgeOldMetricPoints([], RETENTION_MS, NOW)).toEqual([]);
  });
});
