/**
 * Contrat GÉNÉRIQUE d'un module métier, côté web — copie exacte de la forme renvoyée par
 * apps/api/src/services/serviceModules.ts (déclarée ICI et pas dans src/types.ts : ce contrat
 * appartient à cette fonctionnalité, il n'a aucun consommateur ailleurs dans l'app).
 *
 * Trois primitives suffisent à décrire n'importe quel service du parc : `summary` (ce qu'on lit
 * en premier), `entities` (les objets du service) et `relations` (ce qui les relie). Un poste
 * téléphonique 3CX est une entité, un appel en cours est une relation `state: "active"` — c'est
 * exactement le même rendu qu'une zone DNS et ses enregistrements.
 */

export type ServiceModuleTone = "ok" | "warning" | "critical" | "neutral";
export type ServiceModuleEntityStatus = "ok" | "warning" | "critical" | "unknown";
export type ServiceModuleRelationState = "active" | "idle" | "failed" | "unknown";
/**
 * Vocabulaire d'état d'une intégration. « denied » et « failed » ont été ajoutés le 25/08/2026 :
 * 3CX distinguait un accès refusé (licence, droits) d'une erreur renvoyée par le service, et les
 * écraser tous deux en « injoignable » avait déjà coûté un diagnostic erroné.
 */
export type ServiceModuleStatus = "ready" | "not-configured" | "unreachable" | "denied" | "failed";

export interface ServiceModuleSummaryItem {
  label: string;
  value: string;
  tone?: ServiceModuleTone;
}

export interface ServiceModuleEntity {
  id: string;
  kind: string;
  label: string;
  subtitle?: string;
  status?: ServiceModuleEntityStatus;
  details?: Record<string, string | number>;
}

export interface ServiceModuleRelation {
  id: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
  state?: ServiceModuleRelationState;
}

export interface ServiceModuleSnapshot {
  moduleId: string;
  generatedAt: string;
  status: ServiceModuleStatus;
  message?: string;
  summary: ServiceModuleSummaryItem[];
  entities: ServiceModuleEntity[];
  relations: ServiceModuleRelation[];
}

export interface ServiceModuleDescriptor {
  id: string;
  label: string;
  description: string;
  configured: boolean;
}

/** Liaison effective nœud du graphe -> module (GET /api/service-modules/bindings). */
export interface ServiceModuleBinding {
  nodeId: string;
  moduleId: string;
  /** "automatic" = correspondance VÉRIFIÉE côté serveur (nom/IP réelle), recalculée à chaque
   * lecture ; "manual" = posée par un operator/admin et persistée. */
  origin: "manual" | "automatic";
  matchedOn?: string;
}

/** Ce que l'UI a besoin de connaître d'un nœud lié : la liaison + le libellé humain du module. */
export interface ResolvedServiceModuleBinding extends ServiceModuleBinding {
  moduleLabel: string;
}
