// Dérivations PURES de la vue d'un module métier — aucun réseau, aucun React, aucune connaissance
// d'un module en particulier (pas un seul `if (moduleId === "3cx")`).

import type { ServiceModuleEntity, ServiceModuleRelation, ServiceModuleSnapshot } from "./types";

/** Une relation résolue : ses deux extrémités portent enfin un nom lisible. */
export interface ResolvedRelation {
  relation: ServiceModuleRelation;
  source: ServiceModuleEntity;
  target: ServiceModuleEntity;
}

/** Entités d'un même `kind`, comptées — c'est le regroupement qu'attend la liste latérale. */
export interface EntityGroup {
  kind: string;
  entities: ServiceModuleEntity[];
}

function entityIndex(entities: readonly ServiceModuleEntity[]): Map<string, ServiceModuleEntity> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

/**
 * Relations dont les DEUX extrémités existent. Une relation pendante est ignorée — jamais une
 * ligne « ? → 205 » fabriquée pour sauver une donnée incohérente (même règle que le graphe).
 */
export function resolveRelations(snapshot: ServiceModuleSnapshot): ResolvedRelation[] {
  const byId = entityIndex(snapshot.entities);
  const out: ResolvedRelation[] = [];
  for (const relation of snapshot.relations) {
    const source = byId.get(relation.source);
    const target = byId.get(relation.target);
    if (source && target) out.push({ relation, source, target });
  }
  return out;
}

/** Ce qui est VIVANT à cet instant : pour un PBX, les appels en cours. */
export function activeRelations(relations: readonly ResolvedRelation[]): ResolvedRelation[] {
  return relations.filter((entry) => entry.relation.state === "active");
}

/** Identifiants des entités touchées par au moins une relation vivante. */
export function activeEntityIds(relations: readonly ResolvedRelation[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of activeRelations(relations)) {
    ids.add(entry.source.id);
    ids.add(entry.target.id);
  }
  return ids;
}

/** Texte cherchable d'une entité : son libellé, son sous-titre, et TOUTES ses valeurs de détail —
 * chercher « Yealink » doit trouver le poste, même si le terminal n'est pas dans le libellé. */
function searchableText(entity: ServiceModuleEntity): string {
  const details = Object.entries(entity.details ?? {})
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" ");
  return `${entity.label} ${entity.subtitle ?? ""} ${entity.kind} ${details}`.toLowerCase();
}

export function matchesQuery(entity: ServiceModuleEntity, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  return searchableText(entity).includes(trimmed);
}

/**
 * Entités groupées par `kind`, dans l'ordre où les `kind` apparaissent — le module décide de son
 * vocabulaire et de son ordre, la vue ne les réordonne pas selon un classement inventé.
 */
export function groupEntities(entities: readonly ServiceModuleEntity[]): EntityGroup[] {
  const groups: EntityGroup[] = [];
  const byKind = new Map<string, EntityGroup>();
  for (const entity of entities) {
    const existing = byKind.get(entity.kind);
    if (existing) {
      existing.entities.push(entity);
      continue;
    }
    const group: EntityGroup = { kind: entity.kind, entities: [entity] };
    byKind.set(entity.kind, group);
    groups.push(group);
  }
  return groups;
}

/** Relations touchant une entité, avec le sens de lecture — « appelle » vs « appelé par ». */
export function relationsOf(entityId: string, relations: readonly ResolvedRelation[]): {
  outgoing: ResolvedRelation[];
  incoming: ResolvedRelation[];
} {
  return {
    outgoing: relations.filter((entry) => entry.source.id === entityId),
    incoming: relations.filter((entry) => entry.target.id === entityId),
  };
}

/**
 * Relations APPARUES depuis l'instantané précédent. C'est ce qui rend la vue réellement « en
 * direct » : un appel qui démarre se distingue de ceux déjà en cours, au lieu de se fondre dans une
 * liste qui change silencieusement. `previous` vide (premier instantané) = rien de nouveau : tout
 * signaler à l'ouverture ferait clignoter l'écran entier sans rien apprendre.
 */
export function newlyAppeared(previous: ReadonlySet<string>, current: readonly ResolvedRelation[]): Set<string> {
  if (previous.size === 0) return new Set();
  const fresh = new Set<string>();
  for (const entry of current) {
    if (!previous.has(entry.relation.id)) fresh.add(entry.relation.id);
  }
  return fresh;
}

/** « il y a 3 s » — âge d'un instantané, arrondi à la seconde. */
export function formatAge(generatedAt: string, now: number): string {
  const at = new Date(generatedAt).getTime();
  if (Number.isNaN(at)) return "date inconnue";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.floor(minutes / 60)} h`;
}
