// Filtrage et recherche du journal de traçabilité — dérivations PURES, aucun React, aucun réseau.

import type { AuditEvent } from "@/types";
import { describeAction, resourceLabelOf, resourceOf, type PluginAuditLabels } from "./auditMessage";

/** Une ligne du journal, telle qu'elle est LUE : qui, quoi, et sur quel domaine. */
export interface AuditRow {
  event: AuditEvent;
  /** Nom d'affichage retenu (celui de l'annuaire quand il est connu). */
  who: string;
  /** La phrase française de l'action — c'est elle que la recherche doit fouiller. */
  what: string;
  /** Famille de ressource ("nutanix", "3cx", "containers"…) — vide si le chemin n'en porte pas. */
  domain: string;
  domainLabel: string;
}

export type AuditOutcome = "all" | "ok" | "failed";
export type AuditPeriod = "all" | "24h" | "7d" | "30d";

export interface AuditFilters {
  query: string;
  /** Identifiant de connexion de l'acteur ; "" = tous. */
  actor: string;
  outcome: AuditOutcome;
  /** Famille de ressource ; "" = toutes. */
  domain: string;
  period: AuditPeriod;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { query: "", actor: "", outcome: "all", domain: "", period: "all" };

const PERIOD_MS: Record<Exclude<AuditPeriod, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Lignes affichables. Le nom retenu est celui de l'annuaire quand on le connaît (voir
 * directoryDisplayNames) : un même compte ne doit pas apparaître sous deux libellés selon la façon
 * dont sa session a été ouverte.
 */
export function buildAuditRows(
  events: readonly AuditEvent[],
  displayNames: ReadonlyMap<string, string>,
  pluginLabels?: ReadonlyMap<string, PluginAuditLabels>,
): AuditRow[] {
  return events.map((event) => {
    const domain = resourceOf(event.path);
    return {
      event,
      who: displayNames.get(event.actor) ?? event.actorDisplayName,
      what: describeAction(event, pluginLabels),
      domain,
      domainLabel: resourceLabelOf(domain),
    };
  });
}

/** La recherche porte sur ce que l'utilisateur LIT — la phrase et le nom —, jamais sur le chemin
 * technique qu'on a justement cessé d'afficher. */
function matchesQuery(row: AuditRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${row.who} ${row.what} ${row.domainLabel}`.toLowerCase().includes(needle);
}

export function filterAuditRows(rows: readonly AuditRow[], filters: AuditFilters, now: number): AuditRow[] {
  const cutoff = filters.period === "all" ? null : now - PERIOD_MS[filters.period];
  return rows.filter((row) => {
    if (filters.actor && row.event.actor !== filters.actor) return false;
    if (filters.domain && row.domain !== filters.domain) return false;
    if (filters.outcome === "ok" && !row.event.ok) return false;
    if (filters.outcome === "failed" && row.event.ok) return false;
    if (cutoff !== null) {
      const at = new Date(row.event.timestamp).getTime();
      // Un horodatage illisible n'est jamais écarté en silence par un filtre de période : il reste
      // visible, à charge pour l'utilisateur de le voir.
      if (!Number.isNaN(at) && at < cutoff) return false;
    }
    return matchesQuery(row, filters.query);
  });
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

/** Acteurs réellement présents dans le journal, par activité décroissante. */
export function auditActorOptions(rows: readonly AuditRow[]): FilterOption[] {
  const byActor = new Map<string, FilterOption>();
  for (const row of rows) {
    const existing = byActor.get(row.event.actor);
    if (existing) existing.count += 1;
    else byActor.set(row.event.actor, { value: row.event.actor, label: row.who, count: 1 });
  }
  return [...byActor.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Domaines réellement présents, par ordre alphabétique de libellé — jamais la liste théorique de
 * tout ce que QUAI sait faire, seulement ce qui s'est réellement produit. */
export function auditDomainOptions(rows: readonly AuditRow[]): FilterOption[] {
  const byDomain = new Map<string, FilterOption>();
  for (const row of rows) {
    if (!row.domain) continue;
    const existing = byDomain.get(row.domain);
    if (existing) existing.count += 1;
    else byDomain.set(row.domain, { value: row.domain, label: row.domainLabel, count: 1 });
  }
  return [...byDomain.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function hasActiveFilter(filters: AuditFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.actor !== "" ||
    filters.domain !== "" ||
    filters.outcome !== "all" ||
    filters.period !== "all"
  );
}
