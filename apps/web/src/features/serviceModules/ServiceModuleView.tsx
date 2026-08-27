import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, MiniMap } from "@xyflow/react";
import { ApiError } from "@/api/client";
import { edgeTypes } from "@/components/topologyGraphShared";
import { fetchServiceModuleSnapshot } from "./api";
import { buildServiceModuleGraph, serviceModuleNodeTypes } from "./serviceModuleGraph";
import {
  activeEntityIds,
  activeRelations,
  formatAge,
  groupEntities,
  matchesQuery,
  newlyAppeared,
  relationsOf,
  resolveRelations,
} from "./moduleViewModel";
import type { ServiceModuleSnapshot } from "./types";

/** Intervalle (ms) de rafraîchissement de l'instantané — court, parce qu'un module montre des
 * états VIVANTS (un appel 3CX en cours dure quelques dizaines de secondes). Démarré/arrêté avec le
 * MONTAGE de ce composant : il n'existe que tant que le panneau de sous-graphe affiche ce module,
 * jamais un sondage de fond — même règle exacte que le sondage de processus de
 * TopologySubGraphPanel.tsx (PROCESS_POLL_INTERVAL_MS). */
export const MODULE_SNAPSHOT_POLL_INTERVAL_MS = 5000;

/** Durée pendant laquelle une relation NOUVELLE reste signalée comme telle. */
const FRESH_HIGHLIGHT_MS = 6000;

export interface ServiceModuleViewProps {
  moduleId: string;
  moduleLabel: string;
  /** Nom du nœud porteur — l'utilisateur doit voir de QUELLE machine ce service est la vue. */
  nodeLabel: string;
  /** Liaison automatique : afficher la preuve de correspondance plutôt qu'une liaison opaque. */
  origin: "manual" | "automatic";
  matchedOn?: string;
  reducedMotion: boolean;
}

/** Repli quand l'intégration n'a pas fourni son propre message — jamais un état inventé. */
const DEFAULT_STATUS_NOTE: Record<ServiceModuleSnapshot["status"], string> = {
  ready: "",
  "not-configured": "Intégration non configurée — aucune donnée réelle à afficher.",
  unreachable: "Intégration configurée mais injoignable — aucune donnée réelle à afficher.",
  denied: "Accès refusé par le service — les identifiants sont acceptés mais les droits manquent.",
  failed: "Le service a répondu par une erreur — aucune donnée réelle à afficher.",
};

/**
 * Vue d'un module métier dans le sous-graphe : bandeau de synthèse, ce qui est VIVANT à cet instant,
 * la liste complète et cherchable de ce que le module rapporte, le détail de l'élément choisi, et le
 * canevas des relations.
 *
 * Aucune connaissance du module affiché (pas un seul `if (moduleId === "3cx")`) : tout vient de
 * `summary`/`entities`/`relations`. C'est ce qui fait qu'un annuaire DNS et un autocommutateur
 * téléphonique se rendent avec le même code — et qu'un module tiers en profitera sans une ligne de
 * plus. Un module non configuré ou injoignable affiche l'état explicite renvoyé par le serveur,
 * jamais un canevas vide muet ni des données de démonstration.
 */
export default function ServiceModuleView({
  moduleId,
  moduleLabel,
  nodeLabel,
  origin,
  matchedOn,
  reducedMotion,
}: ServiceModuleViewProps) {
  const [snapshot, setSnapshot] = useState<ServiceModuleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  /** Re-rendu périodique pour que l'âge de l'instantané avance visiblement entre deux sondages. */
  const [tick, setTick] = useState(0);
  // Le sondage ne doit jamais vider la vue le temps d'un aller-retour : on garde le dernier
  // instantané valide affiché (même bug réel que la liste de processus, corrigé le 14/08/2026).
  const currentModuleRef = useRef(moduleId);
  const knownRelationIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    currentModuleRef.current = moduleId;
    setSnapshot(null);
    setError(null);
    setLoading(true);
    setSelectedId(null);
    setQuery("");
    setFreshIds(new Set());
    knownRelationIdsRef.current = new Set();
    let cancelled = false;

    async function load() {
      try {
        const next = await fetchServiceModuleSnapshot(moduleId);
        if (cancelled || currentModuleRef.current !== moduleId) return;
        setSnapshot(next);
        setError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Impossible de récupérer l'état de ce module.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(() => void load(), MODULE_SNAPSHOT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [moduleId]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const relations = useMemo(() => (snapshot ? resolveRelations(snapshot) : []), [snapshot]);
  const live = useMemo(() => activeRelations(relations), [relations]);
  const liveEntityIds = useMemo(() => activeEntityIds(relations), [relations]);

  // Ce qui vient d'apparaître, calculé À CHAQUE instantané puis effacé — c'est la différence entre
  // « une liste qui a changé » et « un appel qui vient de démarrer ».
  useEffect(() => {
    if (!snapshot) return;
    const fresh = newlyAppeared(knownRelationIdsRef.current, live);
    knownRelationIdsRef.current = new Set(live.map((entry) => entry.relation.id));
    if (fresh.size === 0) return;
    setFreshIds(fresh);
    const timer = setTimeout(() => setFreshIds(new Set()), FRESH_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [snapshot, live]);

  const visibleEntities = useMemo(
    () => (snapshot ? snapshot.entities.filter((entity) => matchesQuery(entity, query)) : []),
    [snapshot, query],
  );
  const groups = useMemo(() => groupEntities(visibleEntities), [visibleEntities]);

  const selected = useMemo(
    () => snapshot?.entities.find((entity) => entity.id === selectedId) ?? null,
    [snapshot, selectedId],
  );
  const selectedRelations = useMemo(
    () => (selected ? relationsOf(selected.id, relations) : { outgoing: [], incoming: [] }),
    [selected, relations],
  );

  const graph = useMemo(
    () => (snapshot ? buildServiceModuleGraph(snapshot, { reducedMotion }) : { nodes: [], edges: [] }),
    [snapshot, reducedMotion],
  );
  // La sélection est appliquée APRÈS la construction : le graphe reste une fonction pure de
  // l'instantané, la sélection n'est qu'une vue par-dessus.
  const nodes = useMemo(
    () => graph.nodes.map((node) => ({ ...node, selected: node.id === selectedId })),
    [graph.nodes, selectedId],
  );

  const age = snapshot ? formatAge(snapshot.generatedAt, Date.now()) : "";
  void tick; // l'âge ci-dessus dépend de l'horloge, pas de l'instantané.

  return (
    <div className="topology-module">
      <div className="topology-module__caption">
        Module <strong>{moduleLabel}</strong> — vue métier réelle du service porté par « {nodeLabel} », en{" "}
        <strong>lecture seule</strong>, rafraîchie toutes les {MODULE_SNAPSHOT_POLL_INTERVAL_MS / 1000}s tant que ce
        panneau est ouvert.{" "}
        {origin === "automatic"
          ? `Liaison automatique : l'hôte configuré de l'intégration correspond réellement à ce nœud${matchedOn ? ` (${matchedOn})` : ""}.`
          : "Liaison posée manuellement."}
      </div>

      {loading && !snapshot && !error && <div className="empty-state">Chargement du module…</div>}
      {error && <div className="error-banner">{error}</div>}

      {snapshot && snapshot.status !== "ready" && (
        <div className="topology-subgraph-panel__note">{snapshot.message ?? DEFAULT_STATUS_NOTE[snapshot.status]}</div>
      )}
      {snapshot && snapshot.status === "ready" && snapshot.message && (
        <div className="topology-subgraph-panel__note">{snapshot.message}</div>
      )}

      {snapshot && snapshot.summary.length > 0 && (
        <div className="topology-module__summary">
          {snapshot.summary.map((item) => (
            <div
              key={item.label}
              className={`topology-module__summary-item topology-module__summary-item--${item.tone ?? "neutral"}`}
            >
              <span className="topology-module__summary-label">{item.label}</span>
              <span className="topology-module__summary-value">{item.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Ce qui se passe MAINTENANT. Pour un PBX c'est la liste des appels en cours ; le mot
          « relation » reste générique parce que ce composant ne connaît aucun module. */}
      {snapshot && snapshot.status === "ready" && (
        <div className="topology-module__live">
          <div className="topology-module__live-head">
            <span className={`topology-module__pulse${live.length > 0 ? " is-live" : ""}`} aria-hidden="true" />
            <strong>En direct</strong>
            <span className="topology-module__live-count">
              {live.length === 0 ? "aucun échange en cours" : `${live.length} en cours`}
            </span>
            <span className="topology-module__age">Instantané {age}</span>
          </div>
          {live.length > 0 && (
            <ul className="topology-module__live-list">
              {live.map(({ relation, source, target }) => (
                <li
                  key={relation.id}
                  className={`topology-module__live-row${freshIds.has(relation.id) ? " is-fresh" : ""}`}
                >
                  <button type="button" onClick={() => setSelectedId(source.id)}>
                    {source.label}
                  </button>
                  <span className="topology-module__live-arrow" aria-hidden="true">
                    →
                  </span>
                  <button type="button" onClick={() => setSelectedId(target.id)}>
                    {target.label}
                  </button>
                  {relation.label && <span className="topology-module__live-state">{relation.label}</span>}
                  {freshIds.has(relation.id) && <span className="topology-module__live-new">nouveau</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {snapshot && snapshot.status === "ready" && snapshot.entities.length === 0 && (
        <div className="topology-subgraph-panel__note">
          Ce module est configuré et joignable, mais ne rapporte actuellement aucun élément — état réel, jamais
          un contenu fabriqué pour remplir la vue.
        </div>
      )}

      {snapshot && snapshot.entities.length > 0 && (
        <div className="topology-module__body">
          <aside className="topology-module__aside">
            <input
              type="search"
              className="topology-module__search"
              placeholder="Rechercher…"
              aria-label="Rechercher dans les éléments du module"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {visibleEntities.length === 0 ? (
              <p className="topology-module__aside-empty">Aucun élément ne correspond à « {query} ».</p>
            ) : (
              <div className="topology-module__groups">
                {groups.map((group) => (
                  <section key={group.kind} className="topology-module__group">
                    <h5 className="topology-module__group-title">
                      {group.kind}
                      <span>{group.entities.length}</span>
                    </h5>
                    <ul>
                      {group.entities.map((entity) => (
                        <li key={entity.id}>
                          <button
                            type="button"
                            className={`topology-module__entity${entity.id === selectedId ? " is-selected" : ""}${
                              liveEntityIds.has(entity.id) ? " is-live" : ""
                            }`}
                            onClick={() => setSelectedId(entity.id)}
                          >
                            <span
                              className={`topology-module__entity-status topology-module__entity-status--${entity.status ?? "unknown"}`}
                              aria-hidden="true"
                            />
                            <span className="topology-module__entity-label">{entity.label}</span>
                            {entity.subtitle && <span className="topology-module__entity-subtitle">{entity.subtitle}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </aside>

          <div className="topology-module__main">
            <div className="topology-module__graph">
              <ReactFlow
                key={moduleId}
                nodes={nodes}
                edges={graph.edges}
                nodeTypes={serviceModuleNodeTypes}
                edgeTypes={edgeTypes}
                nodesConnectable={false}
                nodesDraggable={false}
                deleteKeyCode={null}
                onNodeClick={(_event, node) => setSelectedId(node.id)}
                fitView
                proOptions={{ hideAttribution: true }}
                minZoom={0.2}
              >
                <Background gap={20} size={1.6} color="var(--color-text-faint)" />
                <MiniMap
                  position="top-left"
                  nodeColor="#a78bfa"
                  nodeStrokeWidth={0}
                  nodeBorderRadius={4}
                  maskColor="rgba(11, 12, 16, 0.75)"
                  pannable
                  zoomable
                />
              </ReactFlow>
            </div>

            {/* Le détail COMPLET de l'élément choisi : toutes ses paires clé/valeur réelles, et ce
                à quoi il est relié — la carte du graphe n'en montre que les premières. */}
            {selected && (
              <div className="topology-module__detail">
                <div className="topology-module__detail-head">
                  <div>
                    <strong>{selected.label}</strong>
                    <span className="topology-module__detail-kind">{selected.kind}</span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedId(null)}>
                    Fermer
                  </button>
                </div>
                {selected.subtitle && <p className="topology-module__detail-subtitle">{selected.subtitle}</p>}
                {Object.entries(selected.details ?? {}).length > 0 && (
                  <dl className="topology-module__detail-list">
                    {Object.entries(selected.details ?? {}).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {(selectedRelations.outgoing.length > 0 || selectedRelations.incoming.length > 0) && (
                  <ul className="topology-module__detail-relations">
                    {selectedRelations.outgoing.map(({ relation, target }) => (
                      <li key={`out-${relation.id}`}>
                        <span className="topology-module__detail-direction">vers</span>
                        <button type="button" onClick={() => setSelectedId(target.id)}>
                          {target.label}
                        </button>
                        <span>{relation.label ?? relation.kind}</span>
                      </li>
                    ))}
                    {selectedRelations.incoming.map(({ relation, source }) => (
                      <li key={`in-${relation.id}`}>
                        <span className="topology-module__detail-direction">depuis</span>
                        <button type="button" onClick={() => setSelectedId(source.id)}>
                          {source.label}
                        </button>
                        <span>{relation.label ?? relation.kind}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {snapshot && (
        <div className="topology-module__footer">
          Instantané du {new Date(snapshot.generatedAt).toLocaleTimeString("fr-FR")} · {snapshot.entities.length} élément
          {snapshot.entities.length > 1 ? "s" : ""} · {snapshot.relations.length} relation
          {snapshot.relations.length > 1 ? "s" : ""}
          {query.trim().length > 0 && ` · ${visibleEntities.length} affiché${visibleEntities.length > 1 ? "s" : ""}`}
        </div>
      )}
    </div>
  );
}
