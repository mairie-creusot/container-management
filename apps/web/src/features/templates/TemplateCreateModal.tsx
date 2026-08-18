import { useState, type FormEvent } from "react";
import { useAppDispatch } from "@/hooks";
import Modal from "@/components/Modal";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import { buildTemplate, createTemplate, fetchTemplates } from "@/features/templates/templatesSlice";
import {
  TEMPLATE_BASE_OPTIONS,
  TEMPLATE_COMPONENTS,
  defaultComponents,
  normalizeComponents,
  templateBaseOption,
} from "@/features/templates/templateCatalog";
import { KIND_ICON } from "@/components/topologyGraphShared";
import type { ImageTemplate, ImageTemplateKind } from "@/types";

interface TemplateCreateModalProps {
  onClose: () => void;
}

/**
 * Assistant "Créer un template" (spotlight du graphe / clic droit sur le canevas) : choix VISUEL
 * de la base (Ubuntu Server via Packer, Alpine, scratch), composants à cocher, nom — POST réel
 * /api/templates puis proposition immédiate de lancer le build (POST .../build). Le suivi du build
 * (poll jusqu'à ready/error + toast final) est porté par TopologyGraph.tsx/templatesSlice.ts, la
 * modale peut donc être refermée sans rien perdre.
 */
export default function TemplateCreateModal({ onClose }: TemplateCreateModalProps) {
  const dispatch = useAppDispatch();
  const TemplateIcon = KIND_ICON["image-template"];
  const [kind, setKind] = useState<ImageTemplateKind>("vm-ubuntu");
  const [baseVersion, setBaseVersion] = useState(templateBaseOption("vm-ubuntu").defaultBaseVersion);
  const [components, setComponents] = useState<string[]>(defaultComponents("vm-ubuntu"));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Étape 2 : template créé, proposition immédiate de lancer le build.
  const [created, setCreated] = useState<ImageTemplate | null>(null);

  const option = templateBaseOption(kind);

  function pickKind(next: ImageTemplateKind) {
    setKind(next);
    setBaseVersion(templateBaseOption(next).defaultBaseVersion);
    setComponents(defaultComponents(next));
  }

  function toggleComponent(id: string, required: boolean) {
    if (required) return;
    setComponents((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedVersion = baseVersion.trim();
    if (!trimmedName || !trimmedVersion) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(
      createTemplate({ name: trimmedName, kind, baseVersion: trimmedVersion, components: normalizeComponents(kind, components) }),
    );
    setBusy(false);
    if (createTemplate.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "success", message: `Template « ${trimmedName} » créé.` }));
      dispatch(fetchTopology());
      setCreated(result.payload);
    } else {
      setError(result.payload ?? "Échec de la création du template.");
    }
  }

  async function handleLaunchBuild() {
    if (!created) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(buildTemplate({ id: created.id }));
    setBusy(false);
    if (buildTemplate.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "info", message: `Build de « ${created.name} » lancé — suivi automatique jusqu'à la fin.` }));
      // Relance le fetch : statut "building" attendu -> TopologyGraph démarre le poll de suivi.
      dispatch(fetchTemplates());
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec du lancement du build.");
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy="template-create-title">
      <div className="template-modal">
        <div className="template-modal__head">
          <h3 id="template-create-title">
            <TemplateIcon className="inline-icon" /> {created ? "Template créé" : "Créer un template"}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Fermer
          </button>
        </div>

        {created ? (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              « {created.name} » est créé (statut : brouillon). Lancer le build maintenant ? La construction se fait côté
              serveur ({created.kind === "vm-ubuntu" ? "Packer sur le cluster Nutanix" : "build d'image Docker"}) — vous serez
              notifié à la fin, la modale peut être refermée.
            </p>
            {error && <p className="graph-popover__error">{error}</p>}
            <div className="template-modal__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
                Plus tard
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleLaunchBuild()} disabled={busy}>
                {busy ? "…" : "Lancer le build"}
              </button>
            </div>
          </div>
        ) : (
          <form className="template-modal__body" onSubmit={handleSubmit}>
            <div className="field">
              <label>Base</label>
              <div className="template-base-grid" role="radiogroup" aria-label="Base du template">
                {TEMPLATE_BASE_OPTIONS.map((o) => (
                  <button
                    key={o.kind}
                    type="button"
                    role="radio"
                    aria-checked={kind === o.kind}
                    className={`template-base-card${kind === o.kind ? " is-selected" : ""}`}
                    onClick={() => pickKind(o.kind)}
                    disabled={busy}
                  >
                    <span className="template-base-card__title">{o.title}</span>
                    <span className="template-base-card__target">{o.target === "vm" ? "VM Nutanix" : "Conteneur"}</span>
                    <span className="template-base-card__desc">{o.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {option.baseVersions.length > 0 && (
              <div className="field">
                <label htmlFor="template-base-version">Version</label>
                <select id="template-base-version" value={baseVersion} onChange={(e) => setBaseVersion(e.target.value)} disabled={busy}>
                  {option.baseVersions.map((v) => (
                    <option key={v} value={v}>
                      {option.title} {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {option.baseVersions.length === 0 && option.baseVersionEditable && (
              <div className="field">
                <label htmlFor="template-base-tag">Tag de l'image de base</label>
                <input
                  id="template-base-tag"
                  type="text"
                  className="cell-mono"
                  value={baseVersion}
                  onChange={(e) => setBaseVersion(e.target.value)}
                  placeholder="ex : 3.20"
                  disabled={busy}
                  required
                />
              </div>
            )}

            <div className="field">
              <label>Composants</label>
              <div className="template-components">
                {TEMPLATE_COMPONENTS[kind].map((c) => (
                  <label key={c.id} className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={c.required || components.includes(c.id)}
                      disabled={busy || c.required}
                      onChange={() => toggleComponent(c.id, c.required)}
                    />
                    {c.label}
                    {c.required && <span className="template-components__required">requis</span>}
                  </label>
                ))}
                {TEMPLATE_COMPONENTS[kind].length === 0 && (
                  <span className="template-modal__hint">Aucun composant proposé pour cette base.</span>
                )}
              </div>
            </div>

            <div className="field">
              <label htmlFor="template-name">Nom du template</label>
              <input
                id="template-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex : ubuntu-docker-standard"
                disabled={busy}
                required
              />
            </div>

            {error && <p className="graph-popover__error">{error}</p>}

            <div className="template-modal__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim() || !baseVersion.trim()}>
                {busy ? "…" : "Créer le template"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
