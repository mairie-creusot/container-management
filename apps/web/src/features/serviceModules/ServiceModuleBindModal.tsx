import { useState } from "react";
import Modal from "@/components/Modal";
import { deleteServiceModuleBinding, putServiceModuleBinding } from "./api";
import type { ResolvedServiceModuleBinding, ServiceModuleDescriptor } from "./types";

interface ServiceModuleBindModalProps {
  open: boolean;
  nodeId: string;
  nodeLabel: string;
  modules: ServiceModuleDescriptor[];
  /** Liaison actuelle de ce nœud, automatique comprise — c'est elle qui décide de ce qu'on propose. */
  current: ResolvedServiceModuleBinding | undefined;
  onClose: () => void;
  /** Appelé après une écriture réussie : l'appelant relit les liaisons. */
  onChanged: () => void;
}

/**
 * « Ce nœud PORTE ce service » — la liaison manuelle d'un nœud du graphe à un module métier.
 *
 * Elle existe parce que le rapprochement automatique ne peut se faire que sur une preuve : l'hôte
 * configuré d'une intégration qui correspond réellement au nom ou à une IP du nœud. Quand cette
 * preuve n'existe pas (VM dont le nom ne dit rien du service qu'elle porte, module dont le socle
 * ignore la forme de configuration), c'est l'administrateur qui l'affirme — et c'est tracé.
 *
 * Une liaison AUTOMATIQUE ne se supprime pas ici : elle disparaît d'elle-même quand la
 * correspondance cesse d'être vraie. La remplacer à la main, en revanche, est permis.
 */
export default function ServiceModuleBindModal({
  open,
  nodeId,
  nodeLabel,
  modules,
  current,
  onClose,
  onChanged,
}: ServiceModuleBindModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le serveur a refusé cette liaison.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="bind-module-title">
      <div className="bind-module">
        <div className="bind-module__head">
          <h3 id="bind-module-title">Lier « {nodeLabel} » à un module</h3>
        </div>

        <div className="bind-module__body">
          <p className="create-container-hint" style={{ marginTop: 0 }}>
            Le module lié devient un onglet du nœud : ses données réelles s'ouvrent depuis la machine
            qui le porte, sans quitter le graphe.
          </p>

          {current?.origin === "automatic" && (
            <div className="card module-notice" style={{ marginBottom: 12 }}>
              <strong>Liaison automatique en place</strong>
              <p style={{ margin: 0 }}>
                Ce nœud est déjà rattaché à « {current.moduleLabel} » parce que l'hôte configuré de cette intégration
                correspond réellement à {current.matchedOn ?? "ce nœud"}. La remplacer ici est possible ; elle
                reviendra d'elle-même si vous retirez la liaison manuelle.
              </p>
            </div>
          )}

          {error && (
            <div className="error-banner" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}

          {modules.length === 0 ? (
            <div className="empty-state">Aucun module disponible : activez une intégration dans Réglages › Modules.</div>
          ) : (
            <div className="modules-grid">
              {modules.map((module) => {
                const isCurrent = current?.moduleId === module.id;
                return (
                  <article key={module.id} className="card module-card">
                    <div className="module-card__head">
                      <div className="module-card__identity">
                        <h4 className="module-card__name">{module.label}</h4>
                        <span className="module-card__id">{module.id}</span>
                      </div>
                    </div>
                    <p className="module-card__description">{module.description}</p>
                    {!module.configured && (
                      <p className="create-container-hint" style={{ margin: 0 }}>
                        Ce module n'est pas configuré : lié maintenant, son onglet s'ouvrira vide jusqu'à ce que sa
                        connexion soit renseignée.
                      </p>
                    )}
                    <div className="module-card__actions">
                      <button
                        type="button"
                        className={`btn btn-sm ${isCurrent ? "btn-ghost" : "btn-primary"}`}
                        disabled={busy || isCurrent}
                        onClick={() => void run(() => putServiceModuleBinding(nodeId, module.id))}
                      >
                        {isCurrent ? "Déjà lié" : "Lier ce module"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="bind-module__footer">
          {/* Seule une liaison MANUELLE se retire : une automatique n'est pas une décision qu'on annule. */}
          {current?.origin === "manual" && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void run(() => deleteServiceModuleBinding(nodeId))}
            >
              Délier ce nœud
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Annuler
          </button>
        </div>
      </div>
    </Modal>
  );
}
