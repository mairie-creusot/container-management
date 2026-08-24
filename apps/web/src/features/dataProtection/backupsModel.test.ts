import { describe, expect, it } from "vitest";
import {
  countCompliance,
  latestJob,
  matchExagridTargets,
  normalizeHost,
  shortLabelOf,
} from "@/features/dataProtection/backupsModel";
import type { HycuJob, HycuTarget, HycuVm } from "@/types";

function target(name: string): HycuTarget {
  return { name };
}

function vm(uuid: string, complianceStatus?: string): HycuVm {
  return { uuid, vmName: uuid, ...(complianceStatus ? { complianceStatus } : {}) };
}

function job(status: string, startTimeInMillis?: number): HycuJob {
  return { status, ...(startTimeInMillis !== undefined ? { startTimeInMillis } : {}) };
}

describe("normalizeHost", () => {
  it("retire schéma, chemin, port et point final", () => {
    expect(normalizeHost("https://ExaGrid.lecreusot.priv:161/")).toBe("exagrid.lecreusot.priv");
    expect(normalizeHost(" 10.20.0.5. ")).toBe("10.20.0.5");
  });
});

describe("shortLabelOf", () => {
  it("aucun nom court pour une IP ni pour un hôte sans domaine", () => {
    expect(shortLabelOf("10.20.0.5")).toBeNull();
    expect(shortLabelOf("exagrid")).toBeNull();
  });

  it("nom court d'un FQDN, seulement s'il est assez distinctif", () => {
    expect(shortLabelOf("exagrid.lecreusot.priv")).toBe("exagrid");
    expect(shortLabelOf("eg.lecreusot.priv")).toBeNull();
  });
});

describe("matchExagridTargets — jamais un lien inventé", () => {
  it("adresse IP citée telle quelle dans le nom de la cible", () => {
    const matches = matchExagridTargets([target("ExaGrid-Landing (\\\\10.20.0.5\\hycu)")], "10.20.0.5");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("address");
    expect(matches[0]?.token).toBe("10.20.0.5");
  });

  it("une IP incluse dans une autre ne compte pas", () => {
    expect(matchExagridTargets([target("nfs 10.20.0.50:/vol1")], "10.20.0.5")).toEqual([]);
  });

  it("FQDN complet cité dans le nom", () => {
    const matches = matchExagridTargets([target("nfs://exagrid.lecreusot.priv/backup")], "exagrid.lecreusot.priv");
    expect(matches[0]?.kind).toBe("address");
  });

  it("nom court seul : correspondance signalée comme probable, pas comme certaine", () => {
    const matches = matchExagridTargets([target("EXAGRID_POOL")], "exagrid.lecreusot.priv");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("hostname");
    expect(matches[0]?.token).toBe("exagrid");
  });

  it("un nom d'hôte configuré sans domaine matche le FQDN de la cible", () => {
    const matches = matchExagridTargets([target("exagrid.lecreusot.priv")], "exagrid");
    expect(matches[0]?.kind).toBe("address");
  });

  it("un suffixe collé ne matche pas : exagrid2 n'est pas exagrid", () => {
    expect(matchExagridTargets([target("exagrid2.lecreusot.priv")], "exagrid.lecreusot.priv")).toEqual([]);
    expect(matchExagridTargets([target("exagrid-02")], "exagrid.lecreusot.priv")).toEqual([]);
  });

  it("aucune appliance configurée : aucun rapprochement", () => {
    expect(matchExagridTargets([target("10.20.0.5")], null)).toEqual([]);
    expect(matchExagridTargets([target("10.20.0.5")], "  ")).toEqual([]);
  });

  it("les correspondances certaines passent devant les probables", () => {
    const matches = matchExagridTargets(
      [target("EXAGRID_POOL"), target("share \\\\exagrid.lecreusot.priv\\hycu")],
      "exagrid.lecreusot.priv",
    );
    expect(matches.map((match) => match.kind)).toEqual(["address", "hostname"]);
  });
});

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
