import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScanResult } from "../src/types.js";

// CONFIG_PATH isolé (même pattern que watchdog.test.ts) — scanScheduler.ts importe
// transitivement scan.js/config.js ; isScanDue lui-même ne touche jamais le disque, mais on
// s'isole quand même préventivement.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { isScanDue } = await import("../src/services/scanScheduler.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    id: "scan-1",
    scanner: "grype",
    image: "nginx:1.27",
    status: "success",
    startedAt: "2026-08-10T12:00:00.000Z",
    finishedAt: "2026-08-10T12:01:00.000Z",
    vulnerabilities: [],
    summary: { Critical: 0, High: 0, Medium: 0, Low: 0, Negligible: 0, Unknown: 0 },
    trigger: "automatic",
    ...overrides,
  };
}

const NOW = new Date("2026-08-12T12:00:00.000Z").getTime();
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

describe("isScanDue", () => {
  it("is due when the image was never scanned by this scanner", () => {
    expect(isScanDue([], "grype", STALE_AFTER_MS, NOW)).toBe(true);
  });

  it("is not due when the last successful scan by this scanner is recent", () => {
    const recent = scan({ startedAt: new Date(NOW - 60_000).toISOString() });
    expect(isScanDue([recent], "grype", STALE_AFTER_MS, NOW)).toBe(false);
  });

  it("is due when the last successful scan by this scanner is older than the threshold", () => {
    const old = scan({ startedAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString() });
    expect(isScanDue([old], "grype", STALE_AFTER_MS, NOW)).toBe(true);
  });

  it("is never due while a scan by this scanner is already running, even if stale otherwise", () => {
    const running = scan({ status: "running", startedAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString() });
    expect(isScanDue([running], "grype", STALE_AFTER_MS, NOW)).toBe(false);
  });

  it("only considers scans from the requested scanner (grype vs osv-scanner are independent)", () => {
    const recentOsv = scan({ scanner: "osv-scanner", startedAt: new Date(NOW - 60_000).toISOString() });
    // aucun scan grype connu -> due pour grype, même si osv-scanner est frais
    expect(isScanDue([recentOsv], "grype", STALE_AFTER_MS, NOW)).toBe(true);
    expect(isScanDue([recentOsv], "osv-scanner", STALE_AFTER_MS, NOW)).toBe(false);
  });

  it("ignores failed scans when looking for the last success, but a running one still blocks", () => {
    const failed = scan({ status: "failed", startedAt: new Date(NOW - 60_000).toISOString(), finishedAt: new Date(NOW - 30_000).toISOString() });
    // seul un échec connu, pas de succès -> toujours due
    expect(isScanDue([failed], "grype", STALE_AFTER_MS, NOW)).toBe(true);
  });

  it("picks the most recent success when several exist", () => {
    const older = scan({ startedAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString() });
    const newer = scan({ startedAt: new Date(NOW - 60_000).toISOString() });
    expect(isScanDue([older, newer], "grype", STALE_AFTER_MS, NOW)).toBe(false);
  });
});
