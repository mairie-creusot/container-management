import { memo } from "react";
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { EDGE_STATE_COLOR } from "@/components/topologyGraphShared";
import type { EdgeHealthState } from "@/components/topologyNodeContract";
import type { ServiceModuleEntity, ServiceModuleRelation, ServiceModuleRelationState, ServiceModuleSnapshot } from "./types";

/**
 * Rendu React Flow d'un module métier — MÊME moteur, mêmes arêtes, même grammaire visuelle que le
 * reste du graphe (voir topologyGraphShared.tsx#edgeTypes/EDGE_STATE_COLOR) : un module n'est pas
 * une vue à part, c'est le graphe qui descend d'un cran dans le service.
 *
 * Générique par construction : ce fichier ne connaît AUCUN module en particulier (pas un seul
 * `if (moduleId === "ad-dns")`). Il ne lit que `entities`/`relations` — c'est ce qui fait qu'un
 * annuaire DNS et un autocommutateur téléphonique se rendent avec le même code : un poste = une
 * entité, un appel en cours = une relation `state: "active"`, donc une arête ANIMÉE (particules de
 * flux), exactement comme une arête "healthy" du graphe principal.
 */

/** Une carte d'entité fait ~230px de large — espacements adaptés, plus serrés que ceux du graphe
 * principal (cartes de 260px + tiroirs qui dépassent en dessous). */
const COLUMN_SPACING = 300;
const ROW_SPACING = 140;
/** Au-delà, une couche se replie en sous-colonnes plutôt qu'en une colonne interminable — même
 * problème (et même remède) que l'arbre des hôtes : une zone DNS peut porter des dizaines
 * d'enregistrements, une file d'attente des dizaines d'agents. */
const MAX_ROWS_PER_COLUMN = 8;
/** Décalage horizontal d'une sous-colonne de repli — assez pour ne pas chevaucher la précédente. */
const WRAP_COLUMN_SPACING = 250;

/** Projection de l'état d'une relation sur la palette d'arête DÉJÀ utilisée par tout le graphe —
 * jamais un second système de couleurs : "active" hérite du vert vivant (et de ses particules de
 * flux, voir isActiveEdgeState), "failed" du rouge, le reste reste neutre. */
export function relationEdgeState(state: ServiceModuleRelationState | undefined): EdgeHealthState {
  if (state === "active") return "healthy";
  if (state === "failed") return "unhealthy";
  return "none";
}

/**
 * Disposition en couches par plus long chemin (même principe que layeredGroupPositions) : une
 * entité jamais ciblée par une relation est une racine (couche 0), chaque relation pousse sa cible
 * d'une couche vers la droite. Un module sans aucune relation (une simple liste d'entités —
 * parfaitement légitime) retombe sur une unique couche, repliée en sous-colonnes.
 *
 * Fonction PURE, verrouillée par serviceModuleGraph.test.ts.
 */
export function layoutServiceModuleEntities(
  entities: ServiceModuleEntity[],
  relations: ServiceModuleRelation[],
): Record<string, { x: number; y: number }> {
  const layerById = new Map<string, number>();
  for (const entity of entities) layerById.set(entity.id, 0);
  for (let pass = 0; pass < entities.length; pass++) {
    let changed = false;
    for (const relation of relations) {
      if (!layerById.has(relation.source) || !layerById.has(relation.target)) continue;
      const next = layerById.get(relation.source)! + 1;
      if (next > layerById.get(relation.target)!) {
        layerById.set(relation.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const idsByLayer = new Map<number, string[]>();
  for (const entity of entities) {
    const layer = layerById.get(entity.id) ?? 0;
    const bucket = idsByLayer.get(layer);
    if (bucket) bucket.push(entity.id);
    else idsByLayer.set(layer, [entity.id]);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [layer, ids] of idsByLayer) {
    const rows = Math.min(ids.length, MAX_ROWS_PER_COLUMN);
    ids.forEach((id, index) => {
      const wrap = Math.floor(index / MAX_ROWS_PER_COLUMN);
      const row = index % MAX_ROWS_PER_COLUMN;
      positions[id] = {
        x: layer * COLUMN_SPACING + wrap * WRAP_COLUMN_SPACING,
        y: (row - (rows - 1) / 2) * ROW_SPACING,
      };
    });
  }
  return positions;
}

export interface ServiceModuleNodeData {
  entity: ServiceModuleEntity;
  /** true si au moins une relation touche cette entité — sinon aucun Handle n'est posé (une carte
   * isolée n'a rien à relier ; poser un port inutilisé serait le mensonge inverse). */
  hasIncoming: boolean;
  hasOutgoing: boolean;
}

/** Nombre de paires clé/valeur affichées sur la carte — le reste reste dans le title (infobulle)
 * et, surtout, dans le JSON de la route : la carte résume, elle ne remplace pas la donnée. */
const MAX_VISIBLE_DETAILS = 4;

function ServiceModuleNodeImpl({ data, selected }: NodeProps) {
  const { entity, hasIncoming, hasOutgoing } = data as unknown as ServiceModuleNodeData;
  const details = Object.entries(entity.details ?? {});
  const visible = details.slice(0, MAX_VISIBLE_DETAILS);
  const hidden = details.length - visible.length;
  return (
    <div
      className={`topology-module-node topology-module-node--${entity.status ?? "unknown"}${selected ? " is-selected" : ""}`}
      title={details.map(([key, value]) => `${key} : ${value}`).join("\n")}
    >
      {hasIncoming && (
        <Handle id="in" type="target" position={Position.Left} className="topology-handle topology-handle--module" title="Relié depuis" />
      )}
      {hasOutgoing && (
        <Handle id="out" type="source" position={Position.Right} className="topology-handle topology-handle--module" title="Relie vers" />
      )}
      <div className="topology-module-node__head">
        <span className="topology-module-node__kind">{entity.kind}</span>
        <span className="topology-module-node__status" aria-hidden="true" />
      </div>
      <div className="topology-module-node__label">{entity.label}</div>
      {entity.subtitle && <div className="topology-module-node__subtitle">{entity.subtitle}</div>}
      {visible.length > 0 && (
        <dl className="topology-module-node__details">
          {visible.map(([key, value]) => (
            <div key={key} className="topology-module-node__detail">
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
          {hidden > 0 && <div className="topology-module-node__detail-more">+{hidden} autre{hidden > 1 ? "s" : ""}</div>}
        </dl>
      )}
    </div>
  );
}

export const ServiceModuleNode = memo(ServiceModuleNodeImpl);
/** Référence STABLE (React Flow réinitialise son rendu si l'objet change d'identité). */
export const serviceModuleNodeTypes = { serviceModuleNode: ServiceModuleNode };

/**
 * Instantané -> graphe React Flow. Une relation dont une extrémité n'existe pas parmi les entités
 * est ignorée (jamais une arête pendante inventée pour "sauver" une donnée incohérente).
 * Fonction PURE, verrouillée par serviceModuleGraph.test.ts.
 */
export function buildServiceModuleGraph(
  snapshot: ServiceModuleSnapshot,
  options: { reducedMotion: boolean },
): { nodes: Node[]; edges: Edge[] } {
  const entityIds = new Set(snapshot.entities.map((entity) => entity.id));
  const relations = snapshot.relations.filter((relation) => entityIds.has(relation.source) && entityIds.has(relation.target));
  const positions = layoutServiceModuleEntities(snapshot.entities, relations);
  const incoming = new Set(relations.map((relation) => relation.target));
  const outgoing = new Set(relations.map((relation) => relation.source));

  const nodes: Node[] = snapshot.entities.map((entity) => ({
    id: entity.id,
    type: "serviceModuleNode",
    position: positions[entity.id] ?? { x: 0, y: 0 },
    data: {
      entity,
      hasIncoming: incoming.has(entity.id),
      hasOutgoing: outgoing.has(entity.id),
    } satisfies ServiceModuleNodeData as unknown as Record<string, unknown>,
  }));

  const edges: Edge[] = relations.map((relation) => {
    const state = relationEdgeState(relation.state);
    const color = EDGE_STATE_COLOR[state];
    return {
      id: relation.id,
      source: relation.source,
      target: relation.target,
      sourceHandle: "out",
      targetHandle: "in",
      type: "linkEdge",
      // Tirets qui défilent pour un flux VIVANT (appel en cours) — coupés sous prefers-reduced-motion.
      animated: relation.state === "active" && !options.reducedMotion,
      className: "topology-edge topology-edge--module",
      style: { stroke: color },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      data: { kindLabel: relation.label ?? relation.kind, state, color },
    };
  });

  return { nodes, edges };
}
