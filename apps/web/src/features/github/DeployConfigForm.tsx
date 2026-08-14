/**
 * Formulaire dynamique de configuration de déploiement — GÉNÉRIQUE, piloté par le schéma renvoyé
 * par GET /api/github/repos/:owner/:repo/config-schema (DeployConfigSchema, voir types.ts), jamais
 * codé en dur par type de projet. Corrige le bug réel du 14/08/2026 (mairie-creusot/formulaire_hotline) :
 * un docker-compose.yml référençant un .env absent du clone frais faisait échouer platement
 * `docker compose up` ("env file ... not found") au lieu d'une étape claire "configuration requise".
 *
 * Trois mécanismes génériques de résolution automatique (voir services/github.ts) réduisent ce qui
 * reste réellement à saisir manuellement — jamais un cas spécifique à un dépôt précis :
 *  - "db-provisioned" (EnvVarRequirement#autoResolution) : QUAI a prouvé, dans CE MÊME compose,
 *    qu'une clé alimente le mot de passe d'un service base de données qu'il crée lui-même — un mot
 *    de passe fort est généré et appliqué automatiquement ; `hasValue` vaut alors true, rien à
 *    afficher/saisir ici (visible dans "Modifier une valeur déjà configurée" comme les autres).
 *  - "admin-seed" : compte admin par défaut d'une app déployée par QUAI (ADMIN_DEFAULT_EMAIL/PASS...)
 *    — `suggestedValue` PRÉ-REMPLIT le champ mais reste visible/éditable, JAMAIS appliqué en
 *    silence ; si la valeur retenue à l'enregistrement est celle générée par QUAI (mot de passe),
 *    un panneau de révélation UNIQUE s'affiche juste après l'enregistrement (voir handleSubmit) —
 *    sinon l'utilisateur ne pourrait plus jamais se connecter à sa propre application.
 *  - référence à un secret DÉJÀ existant (secretRefs) : pour toute clé, un sélecteur optionnel
 *    permet de pointer vers un secret déjà enregistré (ex: SMTP partagé entre plusieurs dépôts) au
 *    lieu de retaper une valeur — n'apparaît que s'il existe au moins un secret à référencer.
 *
 * Contrainte UX non négociable de ce projet : jamais plus de 5 champs visibles simultanément,
 * jamais plus de 3 clics pour accomplir une action. Ici :
 *  - les variables d'environnement REQUISES sans valeur sont le seul groupe ouvert par défaut,
 *    paginé à 5 champs maximum à la fois (voir MAX_VISIBLE_FIELDS) ;
 *  - les valeurs déjà configurées (modifiables plus tard, jamais figées) et les ports/volumes sont
 *    repliés derrière des <details> distincts — jamais un mur de champs ;
 *  - un champ dont la clé "ressemble" à un secret (EnvVarRequirement#looksSensitive) est un input
 *    masqué (type="password"), jamais affiché en clair une fois enregistré — même pattern que le
 *    champ "Valeur" de SecretsPage.tsx ;
 *  - le fichier brut (docker-compose.yml/Dockerfile) n'est jamais affiché comme interaction
 *    principale : seul ce formulaire généré l'est (voir mission).
 *  - "Ouvrir" (déjà 1 clic) -> remplir les champs manquants -> "Enregistrer et déployer" (1 clic) :
 *    3 clics au total depuis "Déployer" initial, cohérent avec la règle du projet.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Modal from "@/components/Modal";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchSecrets } from "@/features/secrets/secretsSlice";
import type { DeployConfigSchema, EnvVarRequirement } from "@/types";

const MAX_VISIBLE_FIELDS = 5;

const SOURCE_LABEL: Record<EnvVarRequirement["source"], string> = {
  env_file: "fichier d'environnement",
  environment: "docker-compose",
  dockerfile_arg: "ARG Dockerfile",
};

export interface DeployConfigFormSubmitInput {
  values: Record<string, string>;
  secretRefs?: Record<string, string>;
  composePortOverrides?: Record<string, number>;
}

interface DeployConfigFormProps {
  open: boolean;
  onClose: () => void;
  schema: DeployConfigSchema | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Libellé du bouton principal — "Enregistrer et déployer" quand des clés requises manquent
   * encore, "Enregistrer" pour une simple modification ultérieure (rien de bloquant). */
  submitLabel: string;
  onSubmit: (input: DeployConfigFormSubmitInput) => void;
}

export default function DeployConfigForm({ open, onClose, schema, loading, saving, error, submitLabel, onSubmit }: DeployConfigFormProps) {
  const dispatch = useAppDispatch();
  const existingSecrets = useAppSelector((s) => s.secrets.items);

  const [values, setValues] = useState<Record<string, string>>({});
  const [secretRefSelections, setSecretRefSelections] = useState<Record<string, string>>({});
  const [portOverrides, setPortOverrides] = useState<Record<string, string>>({});
  const [missingPage, setMissingPage] = useState(0);
  const [showConfigured, setShowConfigured] = useState(false);
  // Panneau de révélation UNIQUE d'un compte admin généré par QUAI (voir mission "point critique
  // de sécurité/UX") — rempli juste avant l'appel onSubmit, affiché une fois l'enregistrement
  // confirmé (voir l'effet ci-dessous qui observe la transition saving:true -> false sans erreur).
  const [adminReveal, setAdminReveal] = useState<Record<string, string> | null>(null);
  const pendingAdminReveal = useRef<Record<string, string> | null>(null);
  const wasSaving = useRef(saving);

  // Réinitialise le formulaire à chaque ouverture sur un NOUVEAU schéma (pas à chaque rendu — une
  // frappe ne doit jamais réinitialiser ce qui est déjà tapé, même bug de principe que Modal.tsx).
  // Pré-remplit les clés "admin-seed" avec leur suggestion (email/mot de passe) — reste éditable,
  // jamais appliqué en silence (voir mission).
  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const v of schema?.envVars ?? []) {
      if (v.suggestedValue) initial[v.key] = v.suggestedValue;
    }
    setValues(initial);
    setSecretRefSelections({});
    setPortOverrides({});
    setMissingPage(0);
    setShowConfigured(false);
    setAdminReveal(null);
    pendingAdminReveal.current = null;
    dispatch(fetchSecrets());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schema?.owner, schema?.repo, schema?.configPath]);

  // Enregistrement confirmé (saving retombe à false SANS erreur) : si des identifiants admin
  // générés par QUAI venaient d'être soumis, affiche le panneau de révélation UNIQUE avant de
  // fermer — sinon ferme directement comme avant (rien à révéler).
  useEffect(() => {
    if (wasSaving.current && !saving && !error) {
      if (pendingAdminReveal.current) {
        setAdminReveal(pendingAdminReveal.current);
        pendingAdminReveal.current = null;
      } else {
        onClose();
      }
    }
    wasSaving.current = saving;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, error]);

  const missingVars = useMemo(() => (schema?.envVars ?? []).filter((v) => v.required && !v.hasValue), [schema]);
  const configuredVars = useMemo(() => (schema?.envVars ?? []).filter((v) => v.hasValue), [schema]);
  const overridablePorts = useMemo(() => (schema?.ports ?? []).filter((p) => p.overridable && p.service), [schema]);

  const pageCount = Math.max(1, Math.ceil(missingVars.length / MAX_VISIBLE_FIELDS));
  const pagedMissingVars = missingVars.slice(missingPage * MAX_VISIBLE_FIELDS, missingPage * MAX_VISIBLE_FIELDS + MAX_VISIBLE_FIELDS);

  // Une clé requise est satisfaite soit par une valeur tapée/suggérée, soit par la référence à un
  // secret déjà existant (voir secretRefSelections) — les deux sont mutuellement exclusifs pour
  // une même clé (le sélecteur désactive alors le champ texte, voir renderEnvField).
  const readyToSubmit = missingVars.every((v) => Boolean(secretRefSelections[v.key]) || (values[v.key] ?? "").trim().length > 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!readyToSubmit) return;
    const cleanedValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (secretRefSelections[key]) continue; // résolu via un secret existant, jamais une valeur littérale en double
      if (value.trim()) cleanedValues[key] = value.trim();
    }
    const cleanedPorts: Record<string, number> = {};
    for (const [service, raw] of Object.entries(portOverrides)) {
      const port = Number(raw);
      if (raw.trim() && Number.isInteger(port) && port > 0 && port <= 65535) cleanedPorts[service] = port;
    }

    // Prépare le panneau de révélation UNIQUE (voir mission) : uniquement les clés "admin-seed"
    // RÉELLEMENT soumises dans CET envoi — jamais pour un champ resté vide/référencé par secret.
    const adminPairs: Record<string, string> = {};
    for (const v of schema?.envVars ?? []) {
      const submittedValue = cleanedValues[v.key];
      if (v.autoResolution === "admin-seed" && submittedValue) adminPairs[v.key] = submittedValue;
    }
    pendingAdminReveal.current = Object.keys(adminPairs).length > 0 ? adminPairs : null;

    onSubmit({
      values: cleanedValues,
      ...(Object.keys(secretRefSelections).length > 0 ? { secretRefs: secretRefSelections } : {}),
      ...(Object.keys(cleanedPorts).length > 0 ? { composePortOverrides: cleanedPorts } : {}),
    });
  }

  function renderEnvField(v: EnvVarRequirement) {
    const inputId = `deploy-config-${v.source}-${v.service ?? ""}-${v.key}`;
    const usingSecretRef = Boolean(secretRefSelections[v.key]);
    return (
      <div className="field" key={inputId}>
        <label htmlFor={inputId}>
          <code>{v.key}</code>
          {v.service && <span className="muted" style={{ fontWeight: 400 }}> — service {v.service}</span>}
          {v.autoResolution === "admin-seed" && (
            <span className="chip chip--accent" style={{ marginLeft: 6, fontSize: 10 }}>
              suggestion pré-remplie
            </span>
          )}
        </label>
        <input
          id={inputId}
          type={v.looksSensitive ? "password" : "text"}
          autoComplete="new-password"
          value={values[v.key] ?? ""}
          onChange={(e) => setValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
          disabled={saving || usingSecretRef}
          placeholder={v.hasValue ? "•••••••• (déjà configuré — laisser vide pour conserver)" : "valeur requise"}
        />
        <p className="create-container-hint">
          Source : {SOURCE_LABEL[v.source]}
          {v.envFilePath ? ` (${v.envFilePath})` : ""}
          {v.autoResolution === "admin-seed" && " — compte admin par défaut de cette application, suggestion modifiable."}
          {!v.hasValue && !v.autoResolution && " — aucune valeur connue, ni secret stocké ni défaut légitime trouvé."}
        </p>
        {existingSecrets.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <select
              aria-label={`Référencer un secret existant pour ${v.key}`}
              value={secretRefSelections[v.key] ?? ""}
              disabled={saving}
              onChange={(e) => {
                const id = e.target.value;
                setSecretRefSelections((prev) => {
                  const next = { ...prev };
                  if (id) next[v.key] = id;
                  else delete next[v.key];
                  return next;
                });
              }}
              style={{ fontSize: 11, padding: "3px 6px" }}
            >
              <option value="">— saisir une valeur —</option>
              {existingSecrets.map((s) => (
                <option key={s.id} value={s.id}>
                  Référencer le secret « {s.name} »
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  }

  // Panneau de révélation UNIQUE — voir le commentaire d'en-tête ("point critique de sécurité/UX").
  if (adminReveal) {
    return (
      <Modal open={open} onClose={() => { setAdminReveal(null); onClose(); }} dismissible={false} labelledBy="deploy-config-reveal-title">
        <div className="confirm-dialog" style={{ minWidth: 380, maxWidth: 480 }}>
          <h2 id="deploy-config-reveal-title" className="confirm-dialog__title">
            Compte admin créé — notez ces identifiants
          </h2>
          <p className="muted" style={{ fontSize: 12.5 }}>
            QUAI a généré ces valeurs pour le compte admin par défaut de cette application. Elles sont désormais stockées
            de manière chiffrée et ne seront plus jamais affichées en clair ici — copiez-les maintenant.
          </p>
          {Object.entries(adminReveal).map(([key, value]) => (
            <div className="field" key={key}>
              <label htmlFor={`reveal-${key}`}>
                <code>{key}</code>
              </label>
              <input id={`reveal-${key}`} readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
            </div>
          ))}
          <div className="confirm-dialog__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setAdminReveal(null);
                onClose();
              }}
            >
              J'ai noté ces informations — fermer
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="deploy-config-title">
      <form className="confirm-dialog" onSubmit={handleSubmit} style={{ minWidth: 380, maxWidth: 480 }}>
        <h2 id="deploy-config-title" className="confirm-dialog__title">
          Configuration du déploiement{schema ? ` — ${schema.owner}/${schema.repo}` : ""}
        </h2>

        {loading && <div className="empty-state">Analyse du dépôt en cours…</div>}

        {!loading && schema && (
          <>
            {schema.unresolvableEnvFile && (
              <p className="graph-popover__error">
                Le fichier d'environnement "{schema.unresolvableEnvFile}" est référencé par le déploiement mais absent du
                dépôt, et aucun .env.example/.env.sample n'a été trouvé pour en déduire les clés attendues — aucun champ
                ne peut être proposé automatiquement pour ce fichier précis.
              </p>
            )}

            {missingVars.length === 0 && configuredVars.length === 0 && overridablePorts.length === 0 && (
              <p className="muted">Rien à configurer pour ce dépôt — toutes les valeurs nécessaires sont déjà résolues.</p>
            )}

            {missingVars.length > 0 && (
              <>
                <p className="muted" style={{ fontSize: 12.5 }}>
                  {missingVars.length} variable{missingVars.length > 1 ? "s" : ""} d'environnement requise
                  {missingVars.length > 1 ? "s" : ""}, sans valeur connue — stockées de manière chiffrée une fois
                  saisies, réutilisées automatiquement aux prochains déploiements.
                </p>
                {pagedMissingVars.map(renderEnvField)}
                {pageCount > 1 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setMissingPage((p) => Math.max(0, p - 1))}
                      disabled={missingPage === 0}
                    >
                      ← Précédent
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Page {missingPage + 1}/{pageCount}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setMissingPage((p) => Math.min(pageCount - 1, p + 1))}
                      disabled={missingPage >= pageCount - 1}
                    >
                      Suivant →
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Valeurs déjà configurées : jamais affichées en clair, mais modifiables explicitement
                (voir mission "les secrets ne sont pas figés à vie") — repliées par défaut pour ne
                jamais dépasser 5 champs visibles en même temps avec les champs manquants ci-dessus.
                Inclut les clés "db-provisioned" (mot de passe généré et appliqué automatiquement,
                jamais montré — voir services/github.ts#applyAutoResolutions). */}
            {configuredVars.length > 0 && (
              <details open={showConfigured} onToggle={(e) => setShowConfigured((e.target as HTMLDetailsElement).open)}>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                  Modifier une valeur déjà configurée ({configuredVars.length})
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {configuredVars.slice(0, MAX_VISIBLE_FIELDS).map((v) =>
                    v.autoResolution === "db-provisioned" ? (
                      <div className="field" key={v.key}>
                        <label>
                          <code>{v.key}</code>
                          <span className="chip chip--accent" style={{ marginLeft: 6, fontSize: 10 }}>
                            généré automatiquement
                          </span>
                        </label>
                        <input readOnly disabled value="•••••••• (mot de passe base de données auto-provisionné)" />
                        <p className="create-container-hint">
                          Appliqué automatiquement au service base de données de ce même docker-compose (référence
                          directe prouvée) — jamais montré, jamais modifiable ici.
                        </p>
                      </div>
                    ) : (
                      renderEnvField(v)
                    ),
                  )}
                  {configuredVars.length > MAX_VISIBLE_FIELDS && (
                    <p className="muted" style={{ fontSize: 11 }}>
                      +{configuredVars.length - MAX_VISIBLE_FIELDS} autre(s) — modifiables individuellement depuis le
                      Gestionnaire de secrets (secret "github-env:{schema.owner}/{schema.repo}").
                    </p>
                  )}
                </div>
              </details>
            )}

            {overridablePorts.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                  Ports ({overridablePorts.length}) — surcharger le port hôte
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {overridablePorts.slice(0, MAX_VISIBLE_FIELDS).map((p) => (
                    <div className="field" key={`${p.service}-${p.containerPort}`}>
                      <label htmlFor={`deploy-port-${p.service}`}>
                        {p.service} <span className="muted" style={{ fontWeight: 400 }}>(conteneur : {p.containerPort})</span>
                      </label>
                      <input
                        id={`deploy-port-${p.service}`}
                        type="number"
                        min={1}
                        max={65535}
                        value={portOverrides[p.service!] ?? ""}
                        onChange={(e) => setPortOverrides((prev) => ({ ...prev, [p.service!]: e.target.value }))}
                        disabled={saving}
                        placeholder={p.hostPort ? String(p.hostPort) : "port hôte choisi automatiquement"}
                      />
                    </div>
                  ))}
                </div>
              </details>
            )}

            {schema.volumes.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                  Volumes ({schema.volumes.length}) — lecture seule
                </summary>
                <div className="iac-workspace-list" style={{ marginTop: 8 }}>
                  {schema.volumes.map((v, i) => (
                    <div className="iac-workspace-item" style={{ cursor: "default" }} key={`${v.service}-${v.target}-${i}`}>
                      <span className="iac-workspace-item__name">
                        {v.service ? `${v.service} : ` : ""}
                        {v.source} → {v.target}
                      </span>
                      <span className="iac-workspace-item__engine">{v.readOnly ? "lecture seule" : "lecture/écriture"}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        {error && <div className="graph-popover__error">{error}</div>}

        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || loading || !schema || !readyToSubmit}
            title={!readyToSubmit ? "Renseignez toutes les variables requises avant de continuer" : undefined}
          >
            {saving ? "Enregistrement…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
