/**
 * Forme générique d'un module métier — DÉFINITION DE RÉFÉRENCE.
 *
 * Ces types existent déjà à l'identique dans apps/api/src/services/serviceModules.ts (registre
 * historique des modules par nœud). Ils vivent désormais ICI parce que `Plugin#snapshot()` les
 * renvoie : le contrat ne peut pas compiler sans eux, et il ne doit dépendre d'aucune application.
 * apps/api/src/plugins/snapshotCompat.ts vérifie à la compilation que les deux définitions restent
 * strictement interchangeables tant que serviceModules.ts n'a pas basculé sur celle-ci.
 */

/** Teinte d'une ligne de synthèse — mêmes variantes que .topology-badge côté web. */
export type ServiceModuleTone = "ok" | "warning" | "critical" | "neutral";

/** État d'une entité, projeté côté web sur la MÊME palette que les nœuds du graphe. */
export type ServiceModuleEntityStatus = "ok" | "warning" | "critical" | "unknown";

/** État d'une relation — "active" est ce qui rend une arête ANIMÉE (appel en cours, flux vivant). */
export type ServiceModuleRelationState = "active" | "idle" | "failed" | "unknown";

export interface ServiceModuleSummaryItem {
  label: string;
  value: string;
  tone?: ServiceModuleTone;
}

export interface ServiceModuleEntity {
  /** Unique DANS le module (jamais un id de TopologyNode) — cible des relations. */
  id: string;
  /** Catégorie propre au module ("dns-zone", "dns-record", "extension", "call-queue"…). */
  kind: string;
  label: string;
  subtitle?: string;
  status?: ServiceModuleEntityStatus;
  /** Paires clé/valeur RÉELLES, affichées telles quelles et directement exploitables par un LLM. */
  details?: Record<string, string | number>;
}

export interface ServiceModuleRelation {
  id: string;
  /** ServiceModuleEntity#id — une relation dont un bout est inconnu est ignorée côté rendu. */
  source: string;
  target: string;
  /** Catégorie propre au module ("contains", "call", "forwards-to"…). */
  kind: string;
  label?: string;
  state?: ServiceModuleRelationState;
}

/** "ready" = données réelles ; "not-configured" = intégration jamais configurée ; "unreachable" =
 * configurée mais la source n'a pas répondu — jamais un repli silencieux sur des données vides. */
/**
 * Vocabulaire d'état d'une intégration. « denied » et « failed » ont été ajoutés le 25/08/2026 :
 * 3CX distinguait un accès refusé (licence, droits) d'une erreur renvoyée par le service, et les
 * écraser tous deux en « injoignable » avait déjà coûté un diagnostic erroné.
 */
export type ServiceModuleStatus = "ready" | "not-configured" | "unreachable" | "denied" | "failed";

export interface ServiceModuleSnapshot {
  moduleId: string;
  generatedAt: string;
  status: ServiceModuleStatus;
  /** Explication honnête quand `status` n'est pas "ready" (ou avertissement partiel sinon). */
  message?: string;
  summary: ServiceModuleSummaryItem[];
  entities: ServiceModuleEntity[];
  relations: ServiceModuleRelation[];
}
