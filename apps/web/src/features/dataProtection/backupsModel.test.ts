import { describe, expect, it } from "vitest";
import { countCompliance, latestJob } from "@/features/dataProtection/backupsModel";
import type { HycuJob, HycuVm } from "@/types";

function vm(uuid: string, complianceStatus?: string): HycuVm {
  return { uuid, vmName: uuid, ...(complianceStatus ? { complianceStatus } : {}) };
}

function job(status: string, startTimeInMillis?: number): HycuJob {
  return { status, ...(startTimeInMillis !== undefined ? { startTimeInMillis } : {}) };
}

describe("countCompliance", () => {
  it("une conformité absente n'est jamais comptée comme non conforme", () => {
    expect(countCompliance([vm("a"), vm("b", "COMPLIANT"), vm("c", "NON_COMPLIANT")])).toEqual({
      withCompliance: 2,
      nonCompliant: 1,
    });
  });
});

describe("latestJob", () => {
  it("retient le job réellement le plus récent", () => {
    expect(latestJob([job("OK", 100), job("ERROR", 900), job("OK", 500)])?.status).toBe("ERROR");
  });

  it("sans horodatage, garde l'ordre renvoyé par HYCU", () => {
    expect(latestJob([job("WARNING"), job("OK")])?.status).toBe("WARNING");
  });

  it("aucun job : null, jamais un job fabriqué", () => {
    expect(latestJob([])).toBeNull();
  });
});
