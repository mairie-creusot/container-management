import { describe, expect, it } from "vitest";
import {
  buildPublicationRows,
  countPublications,
  daysRemainingLabel,
  normalizeSubject,
  portDetectionHint,
  targetLabel,
} from "@/features/publication/publicationModel";
import type { CertificateHealth, CertificateSummary } from "@/features/certificates/certificatesSlice";
import type { AdDnsSyncResult, ReverseProxyRoute } from "@/types";

interface RouteInput {
  id: string;
  subdomain: string;
  targetPort?: number;
  targetContainerId?: string;
  targetHost?: string;
  createdAt?: string;
  dnsSync?: AdDnsSyncResult;
  portDetection?: ReverseProxyRoute["portDetection"];
}

function route(input: RouteInput): ReverseProxyRoute {
  return {
    id: input.id,
    subdomain: input.subdomain,
    targetPort: input.targetPort ?? 8080,
    createdAt: input.createdAt ?? "2026-08-01T10:00:00.000Z",
    ...(input.targetContainerId ? { targetContainerId: input.targetContainerId } : {}),
    ...(input.targetHost ? { targetHost: input.targetHost } : {}),
    ...(input.dnsSync ? { dnsSync: input.dnsSync } : {}),
    ...(input.portDetection ? { portDetection: input.portDetection } : {}),
  };
}

interface CertificateInput {
  id: string;
  subject: string;
  health?: CertificateHealth;
  daysRemaining?: number;
  notAfter?: string;
  lastRenewalError?: string;
}

function certificate(input: CertificateInput): CertificateSummary {
  return {
    id: input.id,
    subject: input.subject,
    issuer: "CA Le Creusot",
    serialNumber: "01",
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: input.notAfter ?? "2027-01-01T00:00:00.000Z",
    daysRemaining: input.daysRemaining ?? 130,
    health: input.health ?? "valid",
    issuedAt: "2026-01-01T00:00:00.000Z",
    renewAt: "2026-12-02T00:00:00.000Z",
    ...(input.lastRenewalError ? { lastRenewalError: input.lastRenewalError } : {}),
  };
}

const SYNCED: AdDnsSyncResult = { status: "synced", at: "2026-08-01T10:00:00.000Z" };
const FAILED: AdDnsSyncResult = { status: "failed", at: "2026-08-01T10:00:00.000Z" };

describe("normalizeSubject", () => {
  it("ignore la casse et le point final d'un FQDN", () => {
    expect(normalizeSubject("MonApp.LeCreusot.priv.")).toBe("monapp.lecreusot.priv");
  });
});

describe("buildPublicationRows", () => {
  const containers = new Map([["c1abcdef0123456789", "web-app"]]);

  it("rapproche la route et son certificat par sujet, sans tenir compte de la casse", () => {
    const rows = buildPublicationRows(
      [route({ id: "r1", subdomain: "MonApp.lecreusot.priv", targetContainerId: "c1abcdef0123456789" })],
      [certificate({ id: "k1", subject: "monapp.lecreusot.priv", health: "expiring", daysRemaining: 12 })],
      containers,
      true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cert).toBe("expiring");
    expect(rows[0]?.daysRemaining).toBe(12);
    expect(rows[0]?.target).toBe("web-app : 8080");
  });

  it("garde une ligne pour un certificat dont le sujet n'est plus publié", () => {
    const rows = buildPublicationRows(
      [route({ id: "r1", subdomain: "a.lecreusot.priv", targetHost: "10.0.0.5" })],
      [certificate({ id: "k9", subject: "ancien.lecreusot.priv" })],
      containers,
      true,
    );
    expect(rows).toHaveLength(2);
    const orphan = rows.find((row) => row.subdomain === "ancien.lecreusot.priv");
    expect(orphan?.route).toBeNull();
    expect(orphan?.dns).toBe("none");
    expect(orphan?.target).toBe("—");
  });

  it("distingue « autorité non configurée » de « aucun certificat »", () => {
    const withAuthority = buildPublicationRows([route({ id: "r1", subdomain: "a.priv" })], [], new Map(), true);
    const withoutAuthority = buildPublicationRows([route({ id: "r1", subdomain: "a.priv" })], [], new Map(), false);
    expect(withAuthority[0]?.cert).toBe("missing");
    expect(withoutAuthority[0]?.cert).toBe("unconfigured");
  });

  it("retient le certificat qui protège le plus longtemps quand un sujet en a plusieurs", () => {
    const rows = buildPublicationRows(
      [route({ id: "r1", subdomain: "a.priv" })],
      [
        certificate({ id: "old", subject: "a.priv", notAfter: "2026-09-01T00:00:00.000Z", daysRemaining: 8 }),
        certificate({ id: "new", subject: "a.priv", notAfter: "2027-06-01T00:00:00.000Z", daysRemaining: 280 }),
      ],
      new Map(),
      true,
    );
    // Le certificat écarté reste visible comme ligne sans route : rien n'est masqué.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.certificate?.id).toBe("new");
    expect(rows[1]?.certificate?.id).toBe("old");
  });

  it("dnsSync absent = résolution manuelle, jamais un échec", () => {
    const rows = buildPublicationRows(
      [
        route({ id: "r1", subdomain: "a.priv" }),
        route({ id: "r2", subdomain: "b.priv", dnsSync: FAILED }),
        route({ id: "r3", subdomain: "c.priv", dnsSync: SYNCED }),
      ],
      [],
      new Map(),
      true,
    );
    expect(rows.map((row) => row.dns)).toEqual(["manual", "failed", "synced"]);
  });
});

describe("countPublications", () => {
  it("ne compte « sans certificat » que pour les sous-domaines réellement publiés", () => {
    const rows = buildPublicationRows(
      [route({ id: "r1", subdomain: "a.priv" }), route({ id: "r2", subdomain: "b.priv", dnsSync: FAILED })],
      [certificate({ id: "k1", subject: "ancien.priv", health: "expired", daysRemaining: -3 })],
      new Map(),
      true,
    );
    expect(countPublications(rows)).toEqual({
      published: 2,
      orphanCertificates: 1,
      dnsFailed: 1,
      certExpiring: 0,
      certExpired: 1,
      certMissing: 2,
    });
  });
});

describe("targetLabel / portDetectionHint", () => {
  it("affiche le nom du conteneur, sinon son id tronqué", () => {
    expect(targetLabel(route({ id: "r1", subdomain: "a.priv", targetContainerId: "abcdef0123456789ff" }), new Map())).toBe(
      "abcdef012345 : 8080",
    );
  });

  it("n'invente pas de cible quand ni conteneur ni hôte ne sont connus", () => {
    expect(targetLabel(route({ id: "r1", subdomain: "a.priv" }), new Map())).toBe("— : 8080");
  });

  it("port saisi : aucune explication de détection", () => {
    expect(portDetectionHint(route({ id: "r1", subdomain: "a.priv" }))).toBeNull();
  });

  it("port détecté : la règle réellement appliquée est explicitée", () => {
    const hint = portDetectionHint(
      route({
        id: "r1",
        subdomain: "a.priv",
        portDetection: { rule: "preferred", candidates: [80, 9000], source: "exposed" },
      }),
    );
    expect(hint).toContain("80, 9000");
    expect(hint).toContain("HTTP usuel");
  });
});

describe("daysRemainingLabel", () => {
  it("jamais 0 pour une valeur absente", () => {
    expect(daysRemainingLabel(null)).toBe("—");
    expect(daysRemainingLabel(0)).toBe("0 j");
    expect(daysRemainingLabel(-4)).toBe("expiré depuis 4 j");
  });
});
