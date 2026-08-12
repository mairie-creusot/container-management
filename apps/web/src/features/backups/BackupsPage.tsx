import { Fragment, useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createBackupDefinition,
  deleteBackupDefinition,
  fetchBackupDefinitions,
  fetchBackupRuns,
  restoreBackup,
  runBackupNow,
  updateBackupDefinition,
  type BackupDefinitionFormInput,
} from "@/features/backups/backupsSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import { IconBackup, IconChevron, IconPlus, IconTrash } from "@/components/icons";
import type { BackupDefinition, BackupRun, BackupTargetKind } from "@/types";

const TARGET_LABEL: Record<BackupTargetKind, string> = {
  volume: "Volume Docker",
  database: "Base de données (conteneur)",
};

const TARGET_REF_PLACEHOLDER: Record<BackupTargetKind, string> = {
  volume: "ex : quai_pgdata",
  database: "ex : id ou nom du conteneur postgres/mysql/mariadb/mongo",
};

/** Poll des runs "running" — même intervalle que IacPage.tsx#RUN_POLL_MS, un tar de volume ou un
 * dump de base peut prendre plusieurs minutes (voir backupScheduler.ts#performBackup). */
const RUN_POLL_MS = 3000;

interface FormState {
  name: string;
  targetKind: BackupTargetKind;
  targetRef: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKey: string;
  secretKey: string;
  clearCredentials: boolean;
  schedule: string;
  retentionCount: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  targetKind: "volume",
  targetRef: "",
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  forcePathStyle: true,
  accessKey: "",
  secretKey: "",
  clearCredentials: false,
  schedule: "0 3 * * *",
  retentionCount: "7",
  enabled: true,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Temps relatif façon "il y a 3 min" (référence Railway inspectée pour cette page, voir mission)
 * — volontairement simple (pas de dépendance date-fns), suffisant pour un historique d'exécutions. */
function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "en cours…";
  const seconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

function runStatusPill(run: BackupRun) {
  if (run.status === "running") return <StatusPill status="warn" label="En cours" />;
  if (run.status === "success") return <StatusPill status="ok" label={run.rotated ? "Réussie (rotée)" : "Réussie"} />;
  return <StatusPill status="crit" label="Échec" />;
}

function targetSummary(def: BackupDefinition): string {
  return `${TARGET_LABEL[def.target.kind]} · ${def.target.ref}`;
}

/**
 * Sauvegardes automatiques de volumes/bases de données vers un stockage S3-compatible — cf.
 * ARCHITECTURE.md, chapitre "Sauvegardes automatiques". Le backend (services/backupsStore.ts +
 * backupScheduler.ts, déjà livré) expose définitions + historique d'exécutions ; cette page
 * reprend l'esprit de l'onglet "Backups" de Railway (planification + bouton de déclenchement
 * manuel en tête, historique détaillé avec restauration juste en dessous) dans le style déjà
 * établi de QUAI (NotificationChannelsPage.tsx/AdDnsPage.tsx). Accès operator/admin — même rôle
 * que toutes les mutations de routes/backups.ts, pas admin uniquement.
 */
export default function BackupsPage() {
  const dispatch = useAppDispatch();
  const {
    items,
    status,
    error,
    creating,
    updatingId,
    deletingId,
    runningId,
    restoringRunId,
    runsByDefinitionId,
    runsStatusByDefinitionId,
    restoreResultByDefinitionId,
  } = useAppSelector((s) => s.backups);
  const session = useAppSelector((s) => s.auth.session);
  const operator = canOperate(session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchBackupDefinitions());
  }, [dispatch]);

  // Poll tant qu'au moins un run connu est "running" (voir backupScheduler.ts#runBackupNow —
  // 202 immédiat, l'exécution réelle continue en arrière-plan côté API).
  useEffect(() => {
    const runningIds = Object.entries(runsByDefinitionId)
      .filter(([, runs]) => runs[0]?.status === "running")
      .map(([id]) => id);
    if (runningIds.length === 0) return;
    const interval = setInterval(() => {
      runningIds.forEach((id) => dispatch(fetchBackupRuns(id)));
    }, RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, runsByDefinitionId]);

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEditForm(def: BackupDefinition) {
    setEditingId(def.id);
    setForm({
      ...EMPTY_FORM,
      name: def.name,
      targetKind: def.target.kind,
      targetRef: def.target.ref,
      endpoint: def.destination.endpoint,
      region: def.destination.region,
      bucket: def.destination.bucket,
      forcePathStyle: def.destination.forcePathStyle,
      schedule: def.schedule,
      retentionCount: String(def.retentionCount),
      enabled: def.enabled,
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function buildInput(): BackupDefinitionFormInput {
    return {
      name: form.name.trim(),
      target: { kind: form.targetKind, ref: form.targetRef.trim() },
      destination: {
        endpoint: form.endpoint.trim(),
        region: form.region.trim() || "us-east-1",
        bucket: form.bucket.trim(),
        forcePathStyle: form.forcePathStyle,
        ...(form.accessKey.trim() ? { accessKey: form.accessKey.trim() } : {}),
        ...(form.secretKey.trim() ? { secretKey: form.secretKey.trim() } : {}),
      },
      ...(editingId && form.clearCredentials ? { clearCredentials: true } : {}),
      schedule: form.schedule.trim(),
      retentionCount: Number(form.retentionCount),
      enabled: form.enabled,
    };
  }

  function isFormValid(): boolean {
    const retention = Number(form.retentionCount);
    return !!(
      form.name.trim() &&
      form.targetRef.trim() &&
      form.endpoint.trim() &&
      form.bucket.trim() &&
      form.schedule.trim() &&
      Number.isInteger(retention) &&
      retention >= 1
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const input = buildInput();
    const result = editingId
      ? await dispatch(updateBackupDefinition({ id: editingId, patch: input }))
      : await dispatch(createBackupDefinition(input));
    if (createBackupDefinition.fulfilled.match(result) || updateBackupDefinition.fulfilled.match(result)) {
      closeForm();
    }
  }

  async function handleDelete(def: BackupDefinition) {
    const ok = await confirm({
      title: "Supprimer cette définition de sauvegarde",
      description: `Confirmer la suppression de "${def.name}" ? La planification est arrêtée immédiatement. L'historique déjà enregistré reste consultable pour audit mais ne sera plus rattaché à aucune définition active.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteBackupDefinition(def.id));
  }

  function handleRunNow(def: BackupDefinition) {
    dispatch(runBackupNow(def.id));
    if (expandedId !== def.id) setExpandedId(def.id);
  }

  function toggleHistory(def: BackupDefinition) {
    const next = expandedId === def.id ? null : def.id;
    setExpandedId(next);
    if (next && runsStatusByDefinitionId[def.id] === undefined) {
      dispatch(fetchBackupRuns(def.id));
    }
  }

  async function handleRestore(def: BackupDefinition, run: BackupRun) {
    const ok = await confirm({
      title: "Restaurer cette sauvegarde ?",
      description: `Cette action va écraser ${targetSummary(def)} avec le contenu de la sauvegarde du ${formatDate(run.startedAt)}. Les données actuellement présentes sur la cible seront définitivement perdues. Cette action est irréversible.`,
      confirmLabel: "Restaurer et écraser",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(restoreBackup({ definitionId: def.id, runId: run.id }));
  }

  useEffect(() => {
    // À chaque nouvelle définition connue, on va chercher sa dernière exécution pour l'afficher
    // dans la colonne "Dernière exécution" du tableau — sans attendre que la ligne soit dépliée.
    items.forEach((def) => {
      if (runsStatusByDefinitionId[def.id] === undefined) dispatch(fetchBackupRuns(def.id));
    });
  }, [dispatch, items, runsStatusByDefinitionId]);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Sauvegardes</h2>
            <p>
              Sauvegarde planifiée (expression cron) de volumes Docker ou de bases de données vers un stockage
              S3-compatible (MinIO/Ceph/AWS…), avec rétention automatique et restauration à la demande.
            </p>
          </div>
          {operator && (
            <button type="button" className="btn btn-primary btn-sm" onClick={formOpen ? closeForm : openCreateForm}>
              <IconPlus /> {formOpen ? "Annuler" : "Nouvelle définition"}
            </button>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {formOpen && operator && (
          <form className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="backup-name">Nom</label>
              <input
                id="backup-name"
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="ex : Base citoyens (nocturne)"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="backup-target-kind">Type de cible</label>
              <select
                id="backup-target-kind"
                value={form.targetKind}
                onChange={(event) => setForm((f) => ({ ...f, targetKind: event.target.value as BackupTargetKind }))}
              >
                {(Object.keys(TARGET_LABEL) as BackupTargetKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {TARGET_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="backup-target-ref">
                {form.targetKind === "volume" ? "Nom du volume" : "Conteneur cible"}
              </label>
              <input
                id="backup-target-ref"
                value={form.targetRef}
                onChange={(event) => setForm((f) => ({ ...f, targetRef: event.target.value }))}
                placeholder={TARGET_REF_PLACEHOLDER[form.targetKind]}
                required
              />
              {form.targetKind === "database" && (
                <p className="create-container-hint">
                  Le moteur (postgres/mysql/mariadb/mongo) est détecté automatiquement depuis l'image du conteneur au
                  moment de l'exécution — identifiants lus depuis ses variables d'environnement, jamais ressaisis ici.
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="backup-endpoint">Endpoint S3</label>
              <input
                id="backup-endpoint"
                value={form.endpoint}
                onChange={(event) => setForm((f) => ({ ...f, endpoint: event.target.value }))}
                placeholder="https://minio.lecreusot.priv:9000"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="backup-region">Région</label>
              <input
                id="backup-region"
                value={form.region}
                onChange={(event) => setForm((f) => ({ ...f, region: event.target.value }))}
                placeholder="us-east-1"
              />
            </div>

            <div className="field">
              <label htmlFor="backup-bucket">Bucket</label>
              <input
                id="backup-bucket"
                value={form.bucket}
                onChange={(event) => setForm((f) => ({ ...f, bucket: event.target.value }))}
                placeholder="quai-backups"
                required
              />
            </div>

            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={(event) => setForm((f) => ({ ...f, forcePathStyle: event.target.checked }))}
              />
              Style de chemin forcé (compatible MinIO/Ceph on-prem)
            </label>

            <div className="field">
              <label htmlFor="backup-access-key">
                Clé d'accès S3{editingId ? " (laisser vide pour conserver l'existante)" : " (optionnelle)"}
              </label>
              <input
                id="backup-access-key"
                value={form.accessKey}
                onChange={(event) => setForm((f) => ({ ...f, accessKey: event.target.value, clearCredentials: false }))}
                disabled={form.clearCredentials}
                autoComplete="off"
              />
            </div>

            <div className="field">
              <label htmlFor="backup-secret-key">
                Secret S3{editingId ? " (laisser vide pour conserver l'existant)" : " (optionnel)"}
              </label>
              <input
                id="backup-secret-key"
                type="password"
                value={form.secretKey}
                onChange={(event) => setForm((f) => ({ ...f, secretKey: event.target.value, clearCredentials: false }))}
                disabled={form.clearCredentials}
                autoComplete="new-password"
              />
            </div>

            {editingId && (
              <label className="filter-toggle">
                <input
                  type="checkbox"
                  checked={form.clearCredentials}
                  onChange={(event) =>
                    setForm((f) => ({
                      ...f,
                      clearCredentials: event.target.checked,
                      accessKey: "",
                      secretKey: "",
                    }))
                  }
                />
                Effacer les identifiants S3 enregistrés (repasse en accès anonyme)
              </label>
            )}

            <div className="field">
              <label htmlFor="backup-schedule">Planification (cron, 5 champs)</label>
              <input
                id="backup-schedule"
                value={form.schedule}
                onChange={(event) => setForm((f) => ({ ...f, schedule: event.target.value }))}
                placeholder="0 3 * * *"
                required
              />
              <p className="create-container-hint">
                minute heure jour-du-mois mois jour-de-semaine — ex : "0 3 * * *" = tous les jours à 3h00.
              </p>
            </div>

            <div className="field">
              <label htmlFor="backup-retention">Rétention (nombre de copies conservées)</label>
              <input
                id="backup-retention"
                type="number"
                min={1}
                value={form.retentionCount}
                onChange={(event) => setForm((f) => ({ ...f, retentionCount: event.target.value }))}
                required
              />
            </div>

            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((f) => ({ ...f, enabled: event.target.checked }))}
              />
              Planification active
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating || !!updatingId || !isFormValid()}>
                {creating || updatingId ? "Enregistrement…" : editingId ? "Enregistrer" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={closeForm}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {status !== "loading" && items.length === 0 && (
          <div className="empty-state">Aucune définition de sauvegarde configurée.</div>
        )}

        {items.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Cible</th>
                  <th>Planification</th>
                  <th>Rétention</th>
                  <th>Actif</th>
                  <th>Dernière exécution</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((def) => {
                  const runs = runsByDefinitionId[def.id] ?? [];
                  const lastRun = runs[0];
                  const runsStatus = runsStatusByDefinitionId[def.id];
                  const restoreResult = restoreResultByDefinitionId[def.id];
                  const isExpanded = expandedId === def.id;
                  return (
                    <Fragment key={def.id}>
                      <tr>
                        <td className="cell-primary">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <IconBackup /> {def.name}
                          </span>
                        </td>
                        <td className="cell-mono">{targetSummary(def)}</td>
                        <td className="cell-mono">{def.schedule}</td>
                        <td>{def.retentionCount}</td>
                        <td>{def.enabled ? "Oui" : "Non"}</td>
                        <td>
                          {lastRun ? (
                            <span title={formatDate(lastRun.startedAt)}>
                              {runStatusPill(lastRun)} <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{formatRelative(lastRun.startedAt)}</span>
                            </span>
                          ) : runsStatus === "loading" ? (
                            "…"
                          ) : (
                            <span style={{ color: "var(--color-text-muted)" }}>Jamais exécutée</span>
                          )}
                        </td>
                        <td className="cell-actions">
                          <div className="row-actions">
                            {operator && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={runningId === def.id || lastRun?.status === "running"}
                                onClick={() => handleRunNow(def)}
                              >
                                {runningId === def.id ? "Déclenchement…" : "Sauvegarder maintenant"}
                              </button>
                            )}
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleHistory(def)}>
                              Historique{" "}
                              <span className={`backups-history__caret${isExpanded ? " is-open" : ""}`}>
                                <IconChevron />
                              </span>
                            </button>
                            {operator && (
                              <>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEditForm(def)}>
                                  Modifier
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn icon-btn--danger"
                                  title="Supprimer"
                                  aria-label="Supprimer"
                                  disabled={deletingId === def.id}
                                  onClick={() => handleDelete(def)}
                                >
                                  <IconTrash />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${def.id}-history`}>
                          <td colSpan={7} style={{ background: "var(--color-surface-alt, #f7f7f8)" }}>
                            {restoreResult && (
                              <div className={restoreResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 10 }}>
                                {restoreResult.message}
                              </div>
                            )}
                            {runsStatus === "loading" && runs.length === 0 && <p>Chargement de l'historique…</p>}
                            {runsStatus !== "loading" && runs.length === 0 && (
                              <p style={{ margin: 0, color: "var(--color-text-muted)" }}>Aucune exécution pour l'instant.</p>
                            )}
                            {runs.length > 0 && (
                              <table className="data-table">
                                <thead>
                                  <tr>
                                    <th>Démarrée le</th>
                                    <th>Déclenchement</th>
                                    <th>Durée</th>
                                    <th>Taille</th>
                                    <th>Statut</th>
                                    <th />
                                  </tr>
                                </thead>
                                <tbody>
                                  {runs.map((run) => {
                                    const restorable = run.status === "success" && !!run.objectKey && !run.rotated;
                                    return (
                                      <tr key={run.id}>
                                        <td>{formatDate(run.startedAt)}</td>
                                        <td>{run.trigger === "manual" ? "Manuel" : "Planifié"}</td>
                                        <td>{formatDuration(run.startedAt, run.finishedAt)}</td>
                                        <td>{formatBytes(run.sizeBytes)}</td>
                                        <td {...(run.error ? { title: run.error } : {})}>{runStatusPill(run)}</td>
                                        <td className="cell-actions">
                                          {operator && restorable && (
                                            <button
                                              type="button"
                                              className="btn btn-danger btn-sm"
                                              disabled={restoringRunId === run.id}
                                              onClick={() => handleRestore(def, run)}
                                            >
                                              {restoringRunId === run.id ? "Restauration…" : "Restaurer"}
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!operator && items.length === 0 && (
          <div className="empty-state">Seul un opérateur ou un administrateur peut configurer les sauvegardes.</div>
        )}
      </div>
    </div>
  );
}
