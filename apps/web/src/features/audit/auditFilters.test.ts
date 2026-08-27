import { describe, expect, it } from "vitest";
import {
  auditActorOptions,
  auditDomainOptions,
  buildAuditRows,
  EMPTY_AUDIT_FILTERS,
  filterAuditRows,
  hasActiveFilter,
} from "./auditFilters";
import type { AuditEvent } from "@/types";

const NOW = new Date("2026-08-27T12:00:00.000Z").getTime();

function event(partial: Partial<AuditEvent> & { id: string }): AuditEvent {
  return {
    timestamp: "2026-08-27T11:00:00.000Z",
    actor: "ybanas",
    actorDisplayName: "BANAS Yann",
    method: "POST",
    path: "/api/containers/abc123/start",
    statusCode: 200,
    ok: true,
    ...partial,
  };
}

const EVENTS: AuditEvent[] = [
  event({ id: "1", path: "/api/containers/abc123/start" }),
  event({ id: "2", path: "/api/nutanix/vms/uuid-1/stop", actor: "mdupont", actorDisplayName: "DUPONT Marie" }),
  event({
    id: "3",
    path: "/api/nutanix/vms/uuid-1",
    method: "DELETE",
    actor: "mdupont",
    actorDisplayName: "DUPONT Marie",
    ok: false,
    statusCode: 409,
  }),
  // Hors des 24 dernières heures.
  event({ id: "4", path: "/api/volumes/donnees", method: "DELETE", timestamp: "2026-08-20T09:00:00.000Z" }),
];

const rows = buildAuditRows(EVENTS, new Map([["ybanas", "BANAS Yann"]]));

describe("buildAuditRows", () => {
  it("porte la phrase lisible et le domaine de chaque action", () => {
    expect(rows[0]?.what).toBe("a démarré le conteneur abc123");
    expect(rows[0]?.domain).toBe("containers");
    expect(rows[0]?.domainLabel).toBe("Conteneurs");
    expect(rows[1]?.what).toBe("a arrêté la VM Nutanix uuid-1");
    expect(rows[1]?.domainLabel).toBe("Nutanix");
  });

  it("retient le nom de l'annuaire quand il est connu", () => {
    expect(rows[0]?.who).toBe("BANAS Yann");
    // Compte absent de la table de l'annuaire : le libellé de l'événement, jamais un nom inventé.
    expect(rows[1]?.who).toBe("DUPONT Marie");
  });
});

describe("filterAuditRows", () => {
  it("sans filtre, tout est rendu", () => {
    expect(filterAuditRows(rows, EMPTY_AUDIT_FILTERS, NOW)).toHaveLength(4);
  });

  it("cherche dans ce qui est LU : la phrase, le nom, le domaine", () => {
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, query: "arrêté" }, NOW).map((r) => r.event.id)).toEqual(["2"]);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, query: "dupont" }, NOW).map((r) => r.event.id)).toEqual(["2", "3"]);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, query: "nutanix" }, NOW)).toHaveLength(2);
  });

  it("ne cherche JAMAIS dans le chemin technique, qu'on a cessé d'afficher", () => {
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, query: "/api/" }, NOW)).toEqual([]);
  });

  it("filtre par personne, par domaine et par résultat", () => {
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, actor: "mdupont" }, NOW)).toHaveLength(2);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, domain: "nutanix" }, NOW)).toHaveLength(2);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, outcome: "failed" }, NOW).map((r) => r.event.id)).toEqual(["3"]);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, outcome: "ok" }, NOW)).toHaveLength(3);
  });

  it("filtre par période sur l'horodatage réel", () => {
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, period: "24h" }, NOW).map((r) => r.event.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(filterAuditRows(rows, { ...EMPTY_AUDIT_FILTERS, period: "30d" }, NOW)).toHaveLength(4);
  });

  it("un horodatage illisible reste visible : un filtre ne l'escamote pas en silence", () => {
    const broken = buildAuditRows([event({ id: "9", timestamp: "pas une date" })], new Map());
    expect(filterAuditRows(broken, { ...EMPTY_AUDIT_FILTERS, period: "24h" }, NOW)).toHaveLength(1);
  });

  it("les critères se combinent", () => {
    const combined = filterAuditRows(
      rows,
      { ...EMPTY_AUDIT_FILTERS, actor: "mdupont", domain: "nutanix", outcome: "failed" },
      NOW,
    );
    expect(combined.map((r) => r.event.id)).toEqual(["3"]);
  });
});

describe("options de filtre — ce qui s'est réellement produit, jamais un catalogue théorique", () => {
  it("liste les personnes présentes, les plus actives d'abord", () => {
    expect(auditActorOptions(rows).map((o) => [o.label, o.count])).toEqual([
      ["BANAS Yann", 2],
      ["DUPONT Marie", 2],
    ]);
  });

  it("liste les domaines présents, par libellé", () => {
    expect(auditDomainOptions(rows).map((o) => o.value)).toEqual(["containers", "nutanix", "volumes"]);
  });
});

describe("hasActiveFilter", () => {
  it("distingue l'état neutre d'un filtre réellement posé", () => {
    expect(hasActiveFilter(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasActiveFilter({ ...EMPTY_AUDIT_FILTERS, query: "  " })).toBe(false);
    expect(hasActiveFilter({ ...EMPTY_AUDIT_FILTERS, query: "vm" })).toBe(true);
    expect(hasActiveFilter({ ...EMPTY_AUDIT_FILTERS, period: "7d" })).toBe(true);
  });
});
