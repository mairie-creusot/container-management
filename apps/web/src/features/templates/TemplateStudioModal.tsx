import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import Modal from "@/components/Modal";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import {
  buildTemplate,
  createTemplate,
  fetchArtifactSources,
  fetchTemplatePresets,
  fetchTemplates,
} from "@/features/templates/templatesSlice";
import {
  ARTIFACT_TYPE_LABEL,
  CLOUD_IMAGE_DISTRO_SUGGESTIONS,
  CONTAINER_IMAGE_SUGGESTIONS,
  MKOSI_DEFAULT_RELEASE,
  MKOSI_DISTROS,
  STEP_TYPES,
  STEP_TYPE_LABEL,
  TEMPLATE_BASE_TYPE_LABEL,
  baseError,
  createStep,
  defaultBase,
  moveStep,
  parsePackagesInput,
  stepError,
  stepSummary,
  templateBaseLabel,
  type MkosiDistro,
} from "@/features/templates/templateCatalog";
import { KIND_ICON } from "@/components/topologyGraphShared";
import type { ImageTemplate, TemplateArtifactSource, TemplateBase, TemplatePreset, TemplateStep } from "@/types";

interface TemplateStudioModalProps {
  onClose: () => void;
}

type Stage = "start" | "edit" | "created";
type Selection = "base" | number;

/** Studio de recettes (spotlight du graphe / clic droit) — remplace l'assistant figé v1 : preset
 * de départ OU recette vierge, base librement choisie, étapes ordonnées toutes modifiables, POST
 * réel /api/templates puis proposition de build (suivi par TopologyGraph, mécanique v1 conservée). */
export default function TemplateStudioModal({ onClose }: TemplateStudioModalProps) {
  const dispatch = useAppDispatch();
  const TemplateIcon = KIND_ICON["image-template"];
  const presets = useAppSelector((s) => s.templates.presets);
  const presetsStatus = useAppSelector((s) => s.templates.presetsStatus);
  const artifactSources = useAppSelector((s) => s.templates.artifactSources);
  const artifactSourcesStatus = useAppSelector((s) => s.templates.artifactSourcesStatus);

  const [stage, setStage] = useState<Stage>("start");
  const [name, setName] = useState("");
  const [base, setBase] = useState<TemplateBase>(defaultBase("cloud-image"));
  const [steps, setSteps] = useState<TemplateStep[]>([]);
  const [selection, setSelection] = useState<Selection>("base");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ImageTemplate | null>(null);

  useEffect(() => {
    dispatch(fetchTemplatePresets());
    dispatch(fetchArtifactSources());
  }, [dispatch]);

  function startFromPreset(preset: TemplatePreset) {
    setBase(preset.base);
    setSteps(preset.steps);
    setSelection("base");
    setStage("edit");
  }

  function startBlank() {
    setBase(defaultBase("cloud-image"));
    setSteps([]);
    setSelection("base");
    setStage("edit");
  }

  function updateStep(index: number, next: TemplateStep) {
    setSteps((prev) => prev.map((s, i) => (i === index ? next : s)));
  }

  function addStep(type: TemplateStep["type"]) {
    setSteps((prev) => [...prev, createStep(type)]);
    setSelection(steps.length);
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    setSelection((prev) => {
      if (prev === "base") return prev;
      if (prev === index) return "base";
      return prev > index ? prev - 1 : prev;
    });
  }

  function reorderStep(index: number, delta: -1 | 1) {
    setSteps((prev) => moveStep(prev, index, delta));
    setSelection((prev) => {
      if (prev === index) return index + delta >= 0 && index + delta < steps.length ? index + delta : prev;
      if (prev === index + delta) return index;
      return prev;
    });
  }

  const baseIssue = baseError(base);
  const stepIssues = steps.map((s) => stepError(s));
  const hasIssues = baseIssue !== null || stepIssues.some((e) => e !== null);
  const canSubmit = !busy && name.trim() !== "" && !hasIssues;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(createTemplate({ name: name.trim(), base: normalizeBase(base), steps }));
    setBusy(false);
    if (createTemplate.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "success", message: `Template « ${name.trim()} » créé.` }));
      dispatch(fetchTopology());
      setCreated(result.payload);
      setStage("created");
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
      dispatch(fetchTemplates());
      dispatch(fetchTopology());
      onClose();
    } else {
      // Réponse honnête du serveur affichée telle quelle (ex : 409 si mkosi indisponible).
      setError(result.payload ?? "Échec du lancement du build.");
    }
  }

  const title = stage === "created" ? "Template créé" : stage === "edit" ? "Studio de template" : "Nouveau template";

  return (
    <Modal open onClose={onClose} labelledBy="template-studio-title">
      <div className={stage === "edit" ? "template-modal template-studio" : "template-modal"}>
        <div className="template-modal__head">
          <h3 id="template-studio-title">
            <TemplateIcon className="inline-icon" /> {title}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Fermer
          </button>
        </div>

        {stage === "start" && (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              Partez d'un preset (tout reste modifiable et supprimable ensuite) ou d'une recette vierge.
            </p>
            {presetsStatus === "loading" && <p className="template-modal__hint">Chargement des presets…</p>}
            {presetsStatus === "unavailable" && (
              <p className="template-modal__hint">Le backend des presets n'est pas encore disponible — recette vierge seulement.</p>
            )}
            {presetsStatus === "error" && <p className="graph-popover__error">Échec du chargement des presets.</p>}
            {presetsStatus === "ready" && presets.length === 0 && (
              <p className="template-modal__hint">Aucun preset proposé par le serveur.</p>
            )}
            <div className="template-base-grid template-studio__presets">
              {presets.map((p) => (
                <button key={p.id} type="button" className="template-base-card" onClick={() => startFromPreset(p)}>
                  <span className="template-base-card__title">{p.label}</span>
                  <span className="template-base-card__target">{templateBaseLabel(p.base)}</span>
                  <span className="template-base-card__desc">{p.description}</span>
                </button>
              ))}
              <button type="button" className="template-base-card" onClick={startBlank}>
                <span className="template-base-card__title">Recette vierge</span>
                <span className="template-base-card__target">contrôle total</span>
                <span className="template-base-card__desc">Base au choix, aucune étape imposée — tout se construit à la main.</span>
              </button>
            </div>
          </div>
        )}

        {stage === "edit" && (
          <form className="template-modal__body" onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="template-studio-name">Nom du template</label>
              <input
                id="template-studio-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex : debian-python3-minimal"
                disabled={busy}
                required
              />
            </div>

            <div className="template-studio__columns">
              <div className="template-studio__recipe">
                <div className="inspector-section-title">Recette</div>
                <button
                  type="button"
                  className={`template-studio__row${selection === "base" ? " is-selected" : ""}`}
                  onClick={() => setSelection("base")}
                >
                  <span className="template-studio__row-type">Base</span>
                  <span className="template-studio__row-summary">{templateBaseLabel(base)}</span>
                  {baseIssue && <span className="template-studio__row-error" title={baseIssue} />}
                </button>

                {steps.map((step, i) => (
                  <div key={i} className={`template-studio__row${selection === i ? " is-selected" : ""}`}>
                    <button type="button" className="template-studio__row-main" onClick={() => setSelection(i)}>
                      <span className="template-studio__row-type">{STEP_TYPE_LABEL[step.type]}</span>
                      <span className="template-studio__row-summary">{stepSummary(step)}</span>
                      {stepIssues[i] && <span className="template-studio__row-error" title={stepIssues[i] ?? ""} />}
                    </button>
                    <span className="template-studio__row-tools">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => reorderStep(i, -1)} disabled={i === 0} aria-label="Monter">
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => reorderStep(i, 1)}
                        disabled={i === steps.length - 1}
                        aria-label="Descendre"
                      >
                        ↓
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeStep(i)} aria-label="Supprimer l'étape">
                        ×
                      </button>
                    </span>
                  </div>
                ))}
                {steps.length === 0 && <p className="template-modal__hint">Aucune étape — la base sera construite nue.</p>}

                <div className="template-studio__add">
                  {STEP_TYPES.map((t) => (
                    <button key={t} type="button" className="btn btn-secondary btn-sm" onClick={() => addStep(t)} disabled={busy}>
                      + {STEP_TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="template-studio__editor">
                {selection === "base" ? (
                  <BaseEditor base={base} onChange={setBase} issue={baseIssue} busy={busy} />
                ) : steps[selection] ? (
                  <StepEditor
                    step={steps[selection]}
                    issue={stepIssues[selection] ?? null}
                    busy={busy}
                    artifactSources={artifactSources}
                    artifactSourcesStatus={artifactSourcesStatus}
                    onChange={(next) => updateStep(selection, next)}
                  />
                ) : null}
              </div>
            </div>

            {error && <p className="graph-popover__error">{error}</p>}

            <div className="template-modal__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStage("start")} disabled={busy}>
                Retour aux presets
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!canSubmit}>
                {busy ? "…" : "Créer le template"}
              </button>
            </div>
          </form>
        )}

        {stage === "created" && created && (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              « {created.name} » est créé (statut : brouillon). Lancer le build maintenant ? La construction se fait côté serveur —
              vous serez notifié à la fin, la modale peut être refermée.
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
        )}
      </div>
    </Modal>
  );
}

/** Champs optionnels vides retirés avant POST (exactOptionalPropertyTypes + contrat propre). */
function normalizeBase(base: TemplateBase): TemplateBase {
  if (base.type === "cloud-image") {
    const distro = base.distro.trim();
    const version = base.version.trim();
    const imageUrl = base.imageUrl?.trim() ?? "";
    return imageUrl === "" ? { type: "cloud-image", distro, version } : { type: "cloud-image", distro, version, imageUrl };
  }
  if (base.type === "container") return { type: "container", image: base.image.trim() };
  return { type: "mkosi", distro: base.distro, release: base.release.trim() };
}

function BaseEditor({
  base,
  onChange,
  issue,
  busy,
}: {
  base: TemplateBase;
  onChange: (next: TemplateBase) => void;
  issue: string | null;
  busy: boolean;
}) {
  function switchType(type: TemplateBase["type"]) {
    if (type !== base.type) onChange(defaultBase(type));
  }

  return (
    <>
      <div className="inspector-section-title">Base de l'image</div>
      <div className="template-studio__tabs" role="tablist" aria-label="Type de base">
        {(["cloud-image", "container", "mkosi"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={base.type === t}
            className={`template-studio__tab${base.type === t ? " is-selected" : ""}`}
            onClick={() => switchType(t)}
            disabled={busy}
          >
            {TEMPLATE_BASE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {base.type === "cloud-image" && (
        <>
          <div className="field">
            <label htmlFor="studio-distro">Distribution (saisie libre)</label>
            <input
              id="studio-distro"
              type="text"
              list="studio-distro-suggestions"
              value={base.distro}
              onChange={(e) => onChange({ ...base, distro: e.target.value })}
              placeholder="ex : ubuntu, debian"
              disabled={busy}
            />
            <datalist id="studio-distro-suggestions">
              {CLOUD_IMAGE_DISTRO_SUGGESTIONS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="studio-version">Version</label>
            <input
              id="studio-version"
              type="text"
              value={base.version}
              onChange={(e) => onChange({ ...base, version: e.target.value })}
              placeholder="ex : 24.04, 12"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="studio-image-url">URL d'image cloud (avancé, optionnel)</label>
            <input
              id="studio-image-url"
              type="text"
              className="cell-mono"
              value={base.imageUrl ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                const { imageUrl: _omit, ...rest } = base;
                onChange(v === "" ? rest : { ...rest, imageUrl: v });
              }}
              placeholder="https://… (sinon résolue par le serveur depuis distro/version)"
              disabled={busy}
            />
          </div>
        </>
      )}

      {base.type === "container" && (
        <div className="field">
          <label htmlFor="studio-image">Image de base (saisie libre)</label>
          <input
            id="studio-image"
            type="text"
            className="cell-mono"
            list="studio-image-suggestions"
            value={base.image}
            onChange={(e) => onChange({ ...base, image: e.target.value })}
            placeholder="ex : scratch, debian:bookworm, alpine:3.20"
            disabled={busy}
          />
          <datalist id="studio-image-suggestions">
            {CONTAINER_IMAGE_SUGGESTIONS.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </div>
      )}

      {base.type === "mkosi" && (
        <>
          <div className="field">
            <label htmlFor="studio-mkosi-distro">Distribution</label>
            <select
              id="studio-mkosi-distro"
              value={base.distro}
              onChange={(e) => {
                const distro = e.target.value as MkosiDistro;
                onChange({ type: "mkosi", distro, release: MKOSI_DEFAULT_RELEASE[distro] });
              }}
              disabled={busy}
            >
              {MKOSI_DISTROS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="studio-mkosi-release">Release</label>
            <input
              id="studio-mkosi-release"
              type="text"
              value={base.release}
              onChange={(e) => onChange({ ...base, release: e.target.value })}
              placeholder="ex : bookworm, noble"
              disabled={busy}
            />
          </div>
          <p className="template-modal__hint">
            Nécessite l'outil mkosi côté serveur — s'il est indisponible, le build échouera avec un message explicite (409),
            affiché tel quel.
          </p>
        </>
      )}

      {issue && <p className="template-modal__field-error">{issue}</p>}
    </>
  );
}

function StepEditor({
  step,
  issue,
  busy,
  artifactSources,
  artifactSourcesStatus,
  onChange,
}: {
  step: TemplateStep;
  issue: string | null;
  busy: boolean;
  artifactSources: TemplateArtifactSource[];
  artifactSourcesStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  onChange: (next: TemplateStep) => void;
}) {
  return (
    <>
      <div className="inspector-section-title">Étape — {STEP_TYPE_LABEL[step.type]}</div>

      {step.type === "packages" && <PackagesEditor step={step} busy={busy} onChange={onChange} />}

      {step.type === "script" && (
        <div className="field">
          <label htmlFor="studio-script">Script exécuté dans l'image</label>
          <textarea
            id="studio-script"
            className="cell-mono template-studio__textarea"
            value={step.content}
            onChange={(e) => onChange({ ...step, content: e.target.value })}
            placeholder={"#!/bin/sh\napt-get update…"}
            rows={12}
            disabled={busy}
          />
        </div>
      )}

      {step.type === "file" && (
        <>
          <div className="field">
            <label htmlFor="studio-file-path">Chemin absolu dans l'image</label>
            <input
              id="studio-file-path"
              type="text"
              className="cell-mono"
              value={step.path}
              onChange={(e) => onChange({ ...step, path: e.target.value })}
              placeholder="ex : /etc/motd"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="studio-file-mode">Mode (optionnel)</label>
            <input
              id="studio-file-mode"
              type="text"
              className="cell-mono"
              value={step.mode ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                const { mode: _omit, ...rest } = step;
                onChange(v === "" ? rest : { ...rest, mode: v });
              }}
              placeholder="ex : 644, 0755"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="studio-file-content">Contenu</label>
            <textarea
              id="studio-file-content"
              className="cell-mono template-studio__textarea"
              value={step.content}
              onChange={(e) => onChange({ ...step, content: e.target.value })}
              rows={8}
              disabled={busy}
            />
          </div>
        </>
      )}

      {step.type === "artifact" && (
        <>
          {artifactSourcesStatus === "loading" && <p className="template-modal__hint">Chargement des artefacts disponibles…</p>}
          {artifactSourcesStatus === "unavailable" && (
            <p className="template-modal__hint">Le backend des artefacts n'est pas encore disponible — aucune source à proposer.</p>
          )}
          {artifactSourcesStatus === "error" && <p className="graph-popover__error">Échec du chargement des artefacts.</p>}
          {artifactSourcesStatus === "ready" && artifactSources.length === 0 && (
            <p className="template-modal__hint">Aucun autre template de la plateforme n'a d'artefact prêt à injecter.</p>
          )}
          {artifactSources.length > 0 && (
            <div className="field">
              <label>Artefact source (autre template de la plateforme)</label>
              <div className="template-studio__sources">
                {artifactSources.map((src) => {
                  const selected = step.templateId === src.templateId;
                  return (
                    <button
                      key={src.templateId}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`template-studio__source${selected ? " is-selected" : ""}`}
                      onClick={() => {
                        const { dockerLoad: _omit, ...rest } = step;
                        onChange({ ...rest, templateId: src.templateId });
                      }}
                      disabled={busy}
                    >
                      <span className="template-studio__source-name">{src.name}</span>
                      <span className="template-studio__source-meta">
                        {ARTIFACT_TYPE_LABEL[src.artifactType]} · <span className="cell-mono">{src.reference}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="studio-dest-path">Chemin de destination absolu</label>
            <input
              id="studio-dest-path"
              type="text"
              className="cell-mono"
              value={step.destPath}
              onChange={(e) => onChange({ ...step, destPath: e.target.value })}
              placeholder="ex : /opt/app/image.tar"
              disabled={busy}
            />
          </div>
          {artifactSources.find((s) => s.templateId === step.templateId)?.artifactType === "docker-image" && (
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={step.dockerLoad ?? false}
                onChange={(e) => {
                  const { dockerLoad: _omit, ...rest } = step;
                  onChange(e.target.checked ? { ...rest, dockerLoad: true } : rest);
                }}
                disabled={busy}
              />
              Charger comme image docker au premier démarrage (docker load)
            </label>
          )}
        </>
      )}

      {step.type === "user" && (
        <>
          <div className="field">
            <label htmlFor="studio-username">Nom d'utilisateur</label>
            <input
              id="studio-username"
              type="text"
              className="cell-mono"
              value={step.username}
              onChange={(e) => onChange({ ...step, username: e.target.value })}
              placeholder="ex : deploy"
              disabled={busy}
            />
          </div>
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={step.sudo ?? false}
              onChange={(e) => {
                const { sudo: _omit, ...rest } = step;
                onChange(e.target.checked ? { ...rest, sudo: true } : rest);
              }}
              disabled={busy}
            />
            Droits sudo
          </label>
          <div className="field">
            <label htmlFor="studio-ssh-key">Clé SSH autorisée (optionnel)</label>
            <input
              id="studio-ssh-key"
              type="text"
              className="cell-mono"
              value={step.sshAuthorizedKey ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                const { sshAuthorizedKey: _omit, ...rest } = step;
                onChange(v === "" ? rest : { ...rest, sshAuthorizedKey: v });
              }}
              placeholder="ssh-ed25519 AAAA…"
              disabled={busy}
            />
          </div>
        </>
      )}

      {step.type === "service" && (
        <>
          <div className="field">
            <label htmlFor="studio-service-name">Nom du service (systemd)</label>
            <input
              id="studio-service-name"
              type="text"
              className="cell-mono"
              value={step.name}
              onChange={(e) => onChange({ ...step, name: e.target.value })}
              placeholder="ex : nginx"
              disabled={busy}
            />
          </div>
          <label className="filter-toggle">
            <input type="checkbox" checked={step.enable} onChange={(e) => onChange({ ...step, enable: e.target.checked })} disabled={busy} />
            Activer au démarrage
          </label>
        </>
      )}

      {issue && <p className="template-modal__field-error">{issue}</p>}
    </>
  );
}

function PackagesEditor({
  step,
  busy,
  onChange,
}: {
  step: Extract<TemplateStep, { type: "packages" }>;
  busy: boolean;
  onChange: (next: TemplateStep) => void;
}) {
  const [draft, setDraft] = useState("");

  function commitDraft() {
    const parsed = parsePackagesInput(draft);
    if (parsed.length === 0) return;
    onChange({ ...step, packages: [...new Set([...step.packages, ...parsed])] });
    setDraft("");
  }

  return (
    <div className="field">
      <label htmlFor="studio-packages">Paquets (Entrée ou virgule pour ajouter)</label>
      {step.packages.length > 0 && (
        <div className="chip-row">
          {step.packages.map((p) => (
            <span key={p} className="chip">
              {p}
              <button
                type="button"
                className="template-studio__chip-remove"
                onClick={() => onChange({ ...step, packages: step.packages.filter((x) => x !== p) })}
                aria-label={`Retirer ${p}`}
                disabled={busy}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id="studio-packages"
        type="text"
        className="cell-mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitDraft();
          }
        }}
        onBlur={commitDraft}
        placeholder="ex : python3, ca-certificates"
        disabled={busy}
      />
    </div>
  );
}
