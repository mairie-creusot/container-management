import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import Modal from "@/components/Modal";
import { ApiError } from "@/api/client";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import { fetchNutanixImages, uploadNutanixImage } from "@/features/nutanix/nutanixSlice";
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
  ISO_INSTALL_MODE_LABEL,
  ISO_MANUAL_MESSAGE,
  ISO_OS_FAMILIES,
  ISO_OS_FAMILY_LABEL,
  ISO_STEPS_DISABLED_MESSAGE,
  ISO_UNATTENDED_MESSAGE,
  MKOSI_DEFAULT_RELEASE,
  MKOSI_DISTROS,
  MKOSI_RELEASE_SUGGESTIONS,
  STEP_TYPES,
  STEP_TYPE_LABEL,
  TEMPLATE_BASE_TYPE_LABEL,
  baseError,
  baseIsBuildable,
  baseSupportsSteps,
  createStep,
  defaultBase,
  isIsoImage,
  isoInstallMode,
  moveStep,
  parsePackagesInput,
  stepError,
  stepSummary,
  templateBaseLabel,
  type MkosiDistro,
} from "@/features/templates/templateCatalog";
import UserPasswordSecretField from "@/features/templates/UserPasswordSecretField";
import { KIND_ICON } from "@/components/topologyGraphShared";
import CodeEditor, { languageForPath } from "@/components/CodeEditor";
import { LINT_UNAVAILABLE_MESSAGE, lintShell, type ShellLintResult } from "@/features/templates/lintApi";
import { packageSearchDistro, type PackageSearchDistro, type PackageSearchItem } from "@/features/templates/packagesApi";
import PackageSearch from "@/features/templates/PackageSearch";
import DockerImageSearch from "@/features/templates/DockerImageSearch";
import {
  checkCloudImageUrl,
  defaultCatalogVersion,
  fetchCloudImageCatalog,
  formatImageSize,
  type CloudImageCheckOutcome,
  type CloudImageDistro,
  type CloudImageVersion,
} from "@/features/templates/cloudImagesApi";
import RecipeVerification from "@/features/templates/RecipeVerification";
import BuildPlacementSettings from "@/features/templates/BuildPlacementSettings";
import type { ImageTemplate, TemplateArtifactSource, TemplateBase, TemplatePreset, TemplateStep } from "@/types";

interface TemplateStudioModalProps {
  onClose: () => void;
}

type Stage = "start" | "edit" | "created";
type Selection = "base" | number;

interface ShellLintController {
  cache: ReadonlyMap<string, ShellLintResult>;
  available: boolean;
  lintNow: (content: string) => Promise<void>;
}

/** Lint shell serveur (POST /api/iac/lint), débouncé 800 ms et mémoïsé par contenu : le résultat
 * suit l'étape même après réordonnancement/suppression, un contenu inchangé n'est jamais re-linté.
 * 404 serveur -> available=false (contrat pas encore là), l'auto-lint s'arrête mais le bouton
 * "Vérifier" reste cliquable (retente, ré-active si le backend apparaît). */
function useShellLint(steps: TemplateStep[]): ShellLintController {
  const [cache, setCache] = useState<ReadonlyMap<string, ShellLintResult>>(new Map());
  const [available, setAvailable] = useState(true);
  const pendingRef = useRef(new Set<string>());

  const lintNow = useCallback(async (content: string) => {
    if (content.trim() === "" || pendingRef.current.has(content)) return;
    pendingRef.current.add(content);
    const result = await lintShell(content);
    pendingRef.current.delete(content);
    if (result.state === "unavailable") {
      setAvailable(false);
      return;
    }
    setAvailable(true);
    setCache((prev) => new Map(prev).set(content, result));
  }, []);

  useEffect(() => {
    if (!available) return;
    const missing = [
      ...new Set(steps.flatMap((s) => (s.type === "script" && s.content.trim() !== "" ? [s.content] : []))),
    ].filter((c) => !cache.has(c) && !pendingRef.current.has(c));
    if (missing.length === 0) return;
    const timer = setTimeout(() => {
      for (const content of missing) void lintNow(content);
    }, 800);
    return () => clearTimeout(timer);
  }, [steps, cache, available, lintNow]);

  return { cache, available, lintNow };
}

/** Pastille rouge d'une étape script quand le lint serveur a des erreurs — même pastille que la
 * validation locale (unifiées dans la liste de recette). */
function scriptLintIssue(step: TemplateStep, cache: ReadonlyMap<string, ShellLintResult>): string | null {
  if (step.type !== "script") return null;
  const result = cache.get(step.content);
  if (!result || result.state !== "errors") return null;
  return result.errors.length > 1 ? `${result.errors.length} erreurs de script (lint serveur)` : "1 erreur de script (lint serveur)";
}

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

  const shellLint = useShellLint(steps);
  const baseIssue = baseError(base);
  const stepIssues = steps.map((s) => stepError(s));
  // Pastille unifiée dans la liste : validation locale d'abord, sinon lint serveur. Le lint reste
  // consultatif (n'empêche pas la création — le serveur reste juge en dernier ressort).
  const rowIssues = steps.map((s, i) => stepIssues[i] ?? scriptLintIssue(s, shellLint.cache));
  const stepsAllowed = baseSupportsSteps(base);
  const recipeIssue =
    !stepsAllowed && steps.length > 0
      ? "Supprimez les étapes, ou passez la base ISO en installation automatisée : une installation manuelle ne peut pas être provisionnée."
      : null;
  const hasIssues = baseIssue !== null || recipeIssue !== null || stepIssues.some((e) => e !== null);
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
                      {rowIssues[i] && <span className="template-studio__row-error" title={rowIssues[i] ?? ""} />}
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
                {stepsAllowed && steps.length === 0 && (
                  <p className="template-modal__hint">Aucune étape — la base sera construite nue.</p>
                )}

                {stepsAllowed ? (
                  <div className="template-studio__add">
                    {STEP_TYPES.map((t) => (
                      <button key={t} type="button" className="btn btn-secondary btn-sm" onClick={() => addStep(t)} disabled={busy}>
                        + {STEP_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="template-modal__hint">
                    {ISO_STEPS_DISABLED_MESSAGE} Pour un template déjà prêt (paquets, comptes…), passez la base en «{" "}
                    {ISO_INSTALL_MODE_LABEL.unattended} ».
                  </p>
                )}
                {recipeIssue && <p className="template-modal__field-error">{recipeIssue}</p>}
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
                    lint={shellLint}
                    packagesDistro={packageSearchDistro(base)}
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

        {stage === "created" && created && !baseIsBuildable(created.base) && (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              « {created.name} » est créé et directement prêt : un ISO en installation manuelle ne se construit pas. Déployez-le
              en VM depuis le graphe — la VM démarrera sur l'ISO, l'installation de l'OS se fera à la main via la console VNC.
            </p>
            <div className="template-modal__actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
                Fermer
              </button>
            </div>
          </div>
        )}

        {stage === "created" && created && baseIsBuildable(created.base) && (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              « {created.name} » est créé (statut : brouillon). Lancer le build maintenant ? La construction se fait côté serveur —
              vous serez notifié à la fin, la modale peut être refermée.
            </p>
            <RecipeVerification templateId={created.id} />
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
  if (base.type === "iso") {
    const imageUuid = base.imageUuid.trim();
    if (isoInstallMode(base) === "manual") return { type: "iso", imageUuid, install: "manual" };
    return base.osFamily === undefined
      ? { type: "iso", imageUuid, install: "unattended" }
      : { type: "iso", imageUuid, install: "unattended", osFamily: base.osFamily };
  }
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
        {(["cloud-image", "container", "mkosi", "iso"] as const).map((t) => (
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

      {base.type === "cloud-image" && <CloudImageBaseEditor base={base} onChange={onChange} busy={busy} />}

      {base.type === "container" && (
        <>
          <DockerImageSearch busy={busy} onPick={(image) => onChange({ ...base, image })} />
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
        </>
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
            <label htmlFor="studio-mkosi-release">Release (suggestions ou saisie libre)</label>
            <div className="template-studio__tabs">
              {MKOSI_RELEASE_SUGGESTIONS[base.distro].map((release) => (
                <button
                  key={release}
                  type="button"
                  className={`template-studio__tab${base.release === release ? " is-selected" : ""}`}
                  onClick={() => onChange({ ...base, release })}
                  disabled={busy}
                >
                  {release}
                </button>
              ))}
            </div>
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

      {base.type === "iso" && <IsoBaseEditor base={base} onChange={onChange} busy={busy} />}

      {issue && <p className="template-modal__field-error">{issue}</p>}
    </>
  );
}

/** Base cloud-image : catalogue serveur (GET /api/cloud-images, URLs officielles vérifiées) —
 * choix distro puis version (LTS la plus récente par défaut), distro/version/imageUrl remplis
 * d'un clic, HEAD de contrôle automatique ; l'URL personnalisée reste disponible (repliée). */
function CloudImageBaseEditor({
  base,
  onChange,
  busy,
}: {
  base: Extract<TemplateBase, { type: "cloud-image" }>;
  onChange: (next: TemplateBase) => void;
  busy: boolean;
}) {
  const [catalog, setCatalog] = useState<CloudImageDistro[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [customOpen, setCustomOpen] = useState(false);
  const [check, setCheck] = useState<"pending" | CloudImageCheckOutcome | null>(null);
  const checkSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchCloudImageCatalog().then((result) => {
      if (cancelled) return;
      if (result.state === "unavailable") {
        setCatalogStatus("unavailable");
        return;
      }
      setCatalog(result.distros);
      setCatalogStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDistro = catalog.find((d) => d.distro === base.distro) ?? null;
  // URL de catalogue effectivement portée par la base — seule une URL du catalogue est
  // auto-vérifiée (une URL personnalisée prime mais n'est pas revérifiée à chaque frappe).
  const catalogUrl = selectedDistro?.versions.find((v) => v.url === base.imageUrl)?.url ?? null;

  useEffect(() => {
    checkSeqRef.current += 1;
    if (!catalogUrl) {
      setCheck(null);
      return;
    }
    const seq = checkSeqRef.current;
    setCheck("pending");
    void checkCloudImageUrl(catalogUrl).then((result) => {
      if (checkSeqRef.current === seq) setCheck(result);
    });
  }, [catalogUrl]);

  function pickDistro(d: CloudImageDistro) {
    if (d.distro === base.distro && catalogUrl) return;
    const def = defaultCatalogVersion(d.versions);
    onChange(
      def
        ? { type: "cloud-image", distro: d.distro, version: def.version, imageUrl: def.url }
        : { type: "cloud-image", distro: d.distro, version: "" },
    );
  }

  function pickVersion(v: CloudImageVersion) {
    onChange({ ...base, version: v.version, imageUrl: v.url });
  }

  const showFreeFields = customOpen || catalogStatus === "unavailable";

  return (
    <>
      {catalogStatus === "loading" && <p className="template-modal__hint">Chargement du catalogue d'images cloud…</p>}
      {catalogStatus === "unavailable" && (
        <p className="template-modal__hint">Catalogue d'images cloud indisponible — saisie libre ci-dessous.</p>
      )}

      {catalogStatus === "ready" && (
        <>
          <div className="field">
            <label>Distribution</label>
            <div className="template-studio__tabs">
              {catalog.map((d) => (
                <button
                  key={d.distro}
                  type="button"
                  className={`template-studio__tab${d.distro === base.distro ? " is-selected" : ""}`}
                  onClick={() => pickDistro(d)}
                  disabled={busy}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {selectedDistro && (
            <div className="field">
              <label>Version</label>
              <div className="template-studio__tabs">
                {selectedDistro.versions.map((v) => (
                  <button
                    key={v.version}
                    type="button"
                    className={`template-studio__tab${v.version === base.version ? " is-selected" : ""}`}
                    onClick={() => pickVersion(v)}
                    disabled={busy}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!selectedDistro && (
            <p className="template-modal__hint">
              Distribution « {base.distro || "?"} » hors catalogue — choisissez une carte ci-dessus ou utilisez la saisie
              libre.
            </p>
          )}

          {catalogUrl && !customOpen && <p className="cloud-image__url">{catalogUrl}</p>}
          {check === "pending" && <p className="template-modal__hint">Vérification de l'image (HEAD serveur)…</p>}
          {check !== null && check !== "pending" && check.state === "checked" && check.ok && (
            <p className="cloud-image__check cloud-image__check--ok">
              ✓ image vérifiée{check.sizeBytes !== undefined ? ` (${formatImageSize(check.sizeBytes)})` : ""}
            </p>
          )}
          {check !== null && check !== "pending" && check.state === "checked" && !check.ok && (
            <p className="cloud-image__check cloud-image__check--warn">⚠ inaccessible (HTTP {check.status})</p>
          )}
          {check !== null && check !== "pending" && check.state === "failed" && (
            <p className="cloud-image__check cloud-image__check--warn">⚠ vérification impossible — {check.message}</p>
          )}

          <button
            type="button"
            className="cloud-image__advanced-toggle"
            onClick={() => setCustomOpen((o) => !o)}
            disabled={busy}
            aria-expanded={customOpen}
          >
            {customOpen ? "▾" : "▸"} URL personnalisée (avancé)
          </button>
        </>
      )}

      {showFreeFields && (
        <>
          <div className="field">
            <label htmlFor="studio-distro">Distribution (saisie libre — sert aussi à la recherche de paquets)</label>
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
            <label htmlFor="studio-image-url">URL d'image cloud (si remplie, elle prime)</label>
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

      <BuildPlacementSettings busy={busy} />
    </>
  );
}

/** Base ISO : mode d'installation (manuelle via VNC / automatisée scriptée), ISO réels du catalogue
 * Prism (GET /api/nutanix/images) + import d'un ISO local avec progression d'envoi réelle. */
function IsoBaseEditor({
  base,
  onChange,
  busy,
}: {
  base: Extract<TemplateBase, { type: "iso" }>;
  onChange: (next: TemplateBase) => void;
  busy: boolean;
}) {
  const mode = isoInstallMode(base);
  const dispatch = useAppDispatch();
  const images = useAppSelector((s) => s.nutanix.images);
  const imagesStatus = useAppSelector((s) => s.nutanix.imagesStatus);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchNutanixImages());
  }, [dispatch]);

  const isoImages = images.filter(isIsoImage);

  async function handleIsoFile(file: File) {
    setUploadError(null);
    setUpload({ name: file.name, percent: 0 });
    try {
      const result = await uploadNutanixImage(file, file.name, (percent) => setUpload({ name: file.name, percent }));
      const refreshed = await dispatch(fetchNutanixImages());
      let uuid = result.uuid;
      if (!uuid && fetchNutanixImages.fulfilled.match(refreshed) && refreshed.payload.outcome === "ok") {
        uuid = refreshed.payload.items.find((i) => i.name === file.name)?.uuid;
      }
      if (uuid) {
        onChange({ ...base, imageUuid: uuid });
      } else {
        setUploadError("ISO envoyé, mais introuvable dans le catalogue rafraîchi — sélectionnez-le manuellement.");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setUploadError("Le backend d'import d'ISO n'est pas encore disponible.");
      } else {
        setUploadError(err instanceof Error ? err.message : "Échec de l'envoi de l'ISO.");
      }
    } finally {
      setUpload(null);
    }
  }

  return (
    <>
      <div className="field">
        <label>Mode d'installation de l'OS</label>
        <div className="template-studio__tabs" role="radiogroup" aria-label="Mode d'installation de l'OS">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "unattended"}
            className={`template-studio__tab${mode === "unattended" ? " is-selected" : ""}`}
            onClick={() => onChange({ ...base, install: "unattended", osFamily: base.osFamily ?? "debian" })}
            disabled={busy}
          >
            {ISO_INSTALL_MODE_LABEL.unattended} (recommandé)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "manual"}
            className={`template-studio__tab${mode === "manual" ? " is-selected" : ""}`}
            onClick={() => onChange({ type: "iso", imageUuid: base.imageUuid, install: "manual" })}
            disabled={busy}
          >
            {ISO_INSTALL_MODE_LABEL.manual}
          </button>
        </div>
        <span className="template-modal__hint">{mode === "unattended" ? ISO_UNATTENDED_MESSAGE : ISO_MANUAL_MESSAGE}</span>
      </div>

      {mode === "unattended" && (
        <div className="field">
          <label>Famille d'OS de l'ISO</label>
          <div className="template-studio__tabs">
            {ISO_OS_FAMILIES.map((family) => (
              <button
                key={family}
                type="button"
                className={`template-studio__tab${base.osFamily === family ? " is-selected" : ""}`}
                onClick={() => onChange({ ...base, install: "unattended", osFamily: family })}
                disabled={busy}
              >
                {ISO_OS_FAMILY_LABEL[family]}
              </button>
            ))}
          </div>
          <span className="template-modal__hint">
            Détermine le mécanisme d'installation scriptée (preseed Debian/Ubuntu, kickstart RHEL) et la distro utilisée pour
            la recherche de paquets — RHEL/Rocky/Alma cherche dans Fedora, la plus proche réellement indexée.
          </span>
        </div>
      )}

      {(imagesStatus === "idle" || imagesStatus === "loading") && (
        <p className="template-modal__hint">Chargement du catalogue d'images Prism…</p>
      )}
      {imagesStatus === "unavailable" && (
        <p className="template-modal__hint">
          Le catalogue d'images Nutanix n'est pas encore disponible côté API (backend en cours) — aucun ISO à proposer pour
          l'instant.
        </p>
      )}
      {imagesStatus === "error" && <p className="graph-popover__error">Échec du chargement du catalogue d'images.</p>}
      {imagesStatus === "ready" && (
        <div className="field">
          <label htmlFor="studio-iso-image">ISO du catalogue Prism</label>
          {isoImages.length === 0 ? (
            <p className="template-modal__hint">Aucun ISO dans le catalogue Prism Central — importez-en un ci-dessous.</p>
          ) : (
            <select
              id="studio-iso-image"
              value={base.imageUuid}
              onChange={(e) => onChange({ ...base, imageUuid: e.target.value })}
              disabled={busy || upload !== null}
            >
              <option value="">— sélectionner —</option>
              {isoImages.map((i) => (
                <option key={i.uuid} value={i.uuid}>
                  {i.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {upload ? (
        <div className="field">
          <label>Envoi de « {upload.name} »…</label>
          <div
            className="template-deploy-progress"
            role="progressbar"
            aria-valuenow={upload.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="template-deploy-progress__bar" style={{ width: `${upload.percent}%` }} />
          </div>
          <span className="template-modal__hint">{upload.percent}% envoyés vers le catalogue Prism.</span>
        </div>
      ) : (
        <div className="field">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || imagesStatus === "unavailable"}
          >
            Importer un ISO…
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".iso,application/x-iso9660-image"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleIsoFile(file);
          e.target.value = "";
        }}
      />
      {uploadError && <p className="graph-popover__error">{uploadError}</p>}

      {mode === "unattended" ? (
        <>
          <p className="template-modal__hint">
            « Créer » puis « Construire » comme une base cloud-image : l'installation scriptée et la recette tournent côté
            serveur, le template passe en « Prêt » avec une image Nutanix déployable en 2 min.
          </p>
          <BuildPlacementSettings busy={busy} />
        </>
      ) : (
        <p className="template-modal__hint">
          Un template ISO manuel est prêt immédiatement (aucun build) : au déploiement, la VM démarre sur l'ISO avec un disque
          vide — l'installation de l'OS se fait à la main via la console VNC.
        </p>
      )}
    </>
  );
}

function StepEditor({
  step,
  issue,
  busy,
  artifactSources,
  artifactSourcesStatus,
  lint,
  packagesDistro,
  onChange,
}: {
  step: TemplateStep;
  issue: string | null;
  busy: boolean;
  artifactSources: TemplateArtifactSource[];
  artifactSourcesStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  lint: ShellLintController;
  packagesDistro: PackageSearchDistro | null;
  onChange: (next: TemplateStep) => void;
}) {
  return (
    <>
      <div className="inspector-section-title">Étape — {STEP_TYPE_LABEL[step.type]}</div>

      {step.type === "packages" && <PackagesEditor step={step} busy={busy} distro={packagesDistro} onChange={onChange} />}

      {step.type === "script" && <ScriptStepEditor step={step} busy={busy} lint={lint} onChange={onChange} />}

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
            <label>Contenu</label>
            <CodeEditor
              value={step.content}
              onChange={(content) => onChange({ ...step, content })}
              language={languageForPath(step.path)}
              readOnly={busy}
              ariaLabel="Contenu du fichier"
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

      {step.type === "user" && <UserStepEditor step={step} busy={busy} onChange={onChange} />}

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

/** Étape utilisateur : compte créé dans l'image, mot de passe référencé par nom de secret QUAI. */
function UserStepEditor({
  step,
  busy,
  onChange,
}: {
  step: Extract<TemplateStep, { type: "user" }>;
  busy: boolean;
  onChange: (next: TemplateStep) => void;
}) {
  return (
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
        Compte sudo
      </label>
      <UserPasswordSecretField id="studio-user-secret" step={step} busy={busy} onChange={onChange} />
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
  );
}

/** Étape script : éditeur shell colorisé + lint serveur (auto débouncé via useShellLint, bouton
 * "Vérifier" pour forcer) — erreurs ligne/message sous l'éditeur, jamais de fausse réussite. */
function ScriptStepEditor({
  step,
  busy,
  lint,
  onChange,
}: {
  step: Extract<TemplateStep, { type: "script" }>;
  busy: boolean;
  lint: ShellLintController;
  onChange: (next: TemplateStep) => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const result = step.content.trim() === "" ? null : lint.cache.get(step.content) ?? null;

  async function handleVerify() {
    setVerifying(true);
    await lint.lintNow(step.content);
    setVerifying(false);
  }

  return (
    <div className="field">
      <label>Script exécuté dans l'image</label>
      <CodeEditor
        value={step.content}
        onChange={(content) => onChange({ ...step, content })}
        language="shell"
        readOnly={busy}
        placeholder={"#!/bin/sh\napt-get update…"}
        ariaLabel="Script exécuté dans l'image"
      />
      <div className="code-lint__bar">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void handleVerify()}
          disabled={busy || verifying || step.content.trim() === ""}
          title={lint.available ? "Lint shell exécuté côté serveur" : LINT_UNAVAILABLE_MESSAGE}
        >
          {verifying ? "Vérification…" : "Vérifier"}
          {result?.state === "errors" && <span className="code-lint__badge">{result.errors.length}</span>}
        </button>
        {!lint.available && <span className="template-modal__hint">{LINT_UNAVAILABLE_MESSAGE}</span>}
        {result?.state === "ok" && <span className="code-lint__ok">vérifié ✓</span>}
      </div>
      {result?.state === "failed" && <p className="template-modal__field-error">{result.message}</p>}
      {result?.state === "errors" && (
        <ul className="code-lint__list">
          {result.errors.map((e, i) => (
            <li key={i} className="code-lint__item">
              {typeof e.line === "number" && <span className="code-lint__line">ligne {e.line}</span>}
              {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Étape paquets : recherche dans la vraie liste de la distro (déduite de la base) + saisie libre
 * TOUJOURS disponible (Repology peut être down/incomplet — jamais de fausse liste). */
function PackagesEditor({
  step,
  busy,
  distro,
  onChange,
}: {
  step: Extract<TemplateStep, { type: "packages" }>;
  busy: boolean;
  distro: PackageSearchDistro | null;
  onChange: (next: TemplateStep) => void;
}) {
  const [draft, setDraft] = useState("");
  const [versions, setVersions] = useState<Record<string, string>>({});

  function addPackages(names: string[]) {
    if (names.length === 0) return;
    onChange({ ...step, packages: [...new Set([...step.packages, ...names])] });
  }

  function commitDraft() {
    const parsed = parsePackagesInput(draft);
    if (parsed.length === 0) return;
    addPackages(parsed);
    setDraft("");
  }

  function handlePick(item: PackageSearchItem) {
    addPackages([item.name]);
    if (item.version !== undefined) setVersions((prev) => ({ ...prev, [item.name]: item.version ?? "" }));
  }

  return (
    <>
      {distro !== null ? (
        <PackageSearch distro={distro} added={step.packages} busy={busy} onPick={handlePick} />
      ) : (
        <p className="template-modal__hint">
          Recherche de paquets indisponible pour cette base (distribution non reconnue) — saisie libre ci-dessous.
        </p>
      )}

      <div className="field">
        <label htmlFor="studio-packages">Saisie libre (Entrée ou virgule pour ajouter)</label>
        {step.packages.length > 0 && (
          <div className="chip-row">
            {step.packages.map((p) => (
              <span key={p} className="chip" title={versions[p] ? `version ${versions[p]}` : undefined}>
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
    </>
  );
}
