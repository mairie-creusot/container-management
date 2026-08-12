import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJobRuns,
  fetchCronJobs,
  triggerCronJob,
  updateCronJob,
  type CronJobFormInput,
} from "@/features/cronJobs/cronJobsSlice";
import { fetchContainers } from "@/features/containers/containersSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { IconHistory, IconPlay, IconPlus, IconTrash } from "@/components/icons";
import type { CronJobDefinition, CronJobRun } from "@/types";

/** Rafraîchissement de l'historique d'un job consulté tant qu'un run y est "running" — même ordre
 * de grandeur que IacPage.tsx#RUN_POLL_MS (pas de flux WebSocket pour ce premier lot). */
const RUN_POLL_MS = 2000;

const RUN_STATUS_LABEL: Record<CronJobRun["status"], string> = {
  running: "En cours…",
  success: "Réussi",
  failed: "Échoué",
};

const RUN_TRIGGER_LABEL: Record<CronJobRun["trigger"], string> = {
  scheduled: "Planifié",
  manual: "Manuel",
};

interface FormState {
  name: string;
  containerId: string;
  command: string;
  schedule: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { name: "", containerId: "", command: "", schedule: "*/5 * * * *", enabled: true };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Cron Jobs comme type de service natif (cf. ARCHITECTURE.md, priorité #6 du rapport concurrentiel)
 * — façon Railway (docs.railway.com/cron-jobs) : une expression cron 5 champs associée à une
 * commande shell exécutée via un VRAI `docker exec` dans un conteneur déjà existant. CRUD réservé
 * admin (routes/cronJobs.ts) — même garde que ReverseProxyPage/AdDnsPage/NotificationChannelsPage
 * — le déclenchement manuel suit lui le standard operator/admin (canOperate), car il n'introduit
 * aucune commande nouvelle par rapport à une définition déjà revue par un admin à sa création.
 */
export default function CronJobsPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, creating, updatingId, deletingId, triggeringId, triggerError, runs, runsJobId, runsStatus } =
    useAppSelector((s) => s.cronJobs);
  const containers = useAppSelector((s) => s.containers.items);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();
  const admin = canAdminister(session);
  const operate = canOperate(session);

  const runningContainers = containers.filter((c) => c.state === "running");
  const containerNameById = new Map(containers.map((c) => [c.id, c.name]));

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const isDirty = formOpen && (form.name.trim() !== "" || form.command.trim() !== "");

  useEffect(() => {
    dispatch(fetchCronJobs());
    // Même périmètre que ReverseProxyPage.tsx : le démon local uniquement (docker exec ne cible
    // pas encore les environnements Docker distants dans ce premier lot).
    dispatch(fetchContainers(null));
  }, [dispatch]);

  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, isDirty]);

  // Poll l'historique du job consulté tant qu'un run y est encore "running" — se met à jour tout
  // seul si un cycle planifié se déclenche pendant que la page est ouverte.
  useEffect(() => {
    if (!historyJobId || runsJobId !== historyJobId) return;
    if (!runs.some((r) => r.status === "running")) return;
    const interval = setInterval(() => dispatch(fetchCronJobRuns(historyJobId)), RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, historyJobId, runsJobId, runs]);

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEditForm(job: CronJobDefinition) {
    setEditingId(job.id);
    setForm({ name: job.name, containerId: job.containerId, command: job.command, schedule: job.schedule, enabled: job.enabled });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function isFormValid(): boolean {
    return !!(form.name.trim() && form.containerId && form.command.trim() && form.schedule.trim());
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const containerName = containerNameById.get(form.containerId) ?? form.containerId;
    const input: CronJobFormInput = {
      name: form.name.trim(),
      containerId: form.containerId,
      containerName,
      command: form.command.trim(),
      schedule: form.schedule.trim(),
      enabled: form.enabled,
    };
    const result = editingId
      ? await dispatch(updateCronJob({ id: editingId, patch: input }))
      : await dispatch(createCronJob(input));
    if (createCronJob.fulfilled.match(result) || updateCronJob.fulfilled.match(result)) {
      closeForm();
    }
  }

  async function handleCancelForm() {
    if (isDirty) {
      const ok = await confirm({
        title: "Abandonner ce cron job ?",
        description: "Les informations saisies n'ont pas été enregistrées.",
        confirmLabel: "Abandonner les modifications",
        variant: "danger",
      });
      if (!ok) return;
    }
    closeForm();
  }

  async function handleDelete(job: CronJobDefinition) {
    const ok = await confirm({
      title: "Supprimer ce cron job",
      description: `Confirmer la suppression de "${job.name}" ? Son historique d'exécution restera consultable via l'API mais ne sera plus déclenché.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteCronJob(job.id));
    if (historyJobId === job.id) setHistoryJobId(null);
  }

  function handleToggleEnabled(job: CronJobDefinition) {
    dispatch(updateCronJob({ id: job.id, patch: { enabled: !job.enabled } }));
  }

  function handleTrigger(job: CronJobDefinition) {
    dispatch(triggerCronJob(job.id));
  }

  function openHistory(job: CronJobDefinition) {
    setHistoryJobId(job.id);
    setSelectedRunId(null);
    dispatch(fetchCronJobRuns(job.id));
  }

  const historyJob = items.find((j) => j.id === historyJobId) ?? null;
  const historyRuns = historyJobId && runsJobId === historyJobId ? runs : [];
  const selectedRun = historyRuns.find((r) => r.id === selectedRunId) ?? historyRuns[0] ?? null;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Cron Jobs</h2>
            <p>
              Exécute une commande shell selon une expression cron standard, directement dans un conteneur déjà en
              cours d'exécution (vrai <code>docker exec</code>, aucun conteneur éphémère créé).
            </p>
          </div>
          {admin && (
            <button type="button" className="btn btn-primary btn-sm" onClick={formOpen ? handleCancelForm : openCreateForm}>
              <IconPlus /> {formOpen ? "Annuler" : "Nouveau cron job"}
            </button>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {triggerError && <div className="error-banner">{triggerError}</div>}

        {formOpen && admin && (
          <form className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="cron-name">Nom</label>
              <input
                id="cron-name"
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="ex : Purge des logs applicatifs"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="cron-container">Conteneur cible</label>
              <select
                id="cron-container"
                value={form.containerId}
                onChange={(event) => setForm((f) => ({ ...f, containerId: event.target.value }))}
                required
              >
                <option value="">— sélectionner —</option>
                {runningContainers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.image})
                  </option>
                ))}
                {/* Le conteneur déjà ciblé par un job en édition reste sélectionnable même s'il
                    n'est plus en cours d'exécution au moment de la modification. */}
                {editingId && form.containerId && !runningContainers.some((c) => c.id === form.containerId) && (
                  <option value={form.containerId}>
                    {containerNameById.get(form.containerId) ?? form.containerId} (arrêté)
                  </option>
                )}
              </select>
              {runningContainers.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  Aucun conteneur en cours d'exécution connu de QUAI.
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="cron-command">Commande</label>
              <textarea
                id="cron-command"
                className="iac-editor"
                style={{ minHeight: 70 }}
                value={form.command}
                onChange={(event) => setForm((f) => ({ ...f, command: event.target.value }))}
                placeholder="ex : find /var/log/app -mtime +7 -delete"
                spellCheck={false}
                required
              />
              <p className="create-container-hint">Exécutée telle quelle via ["/bin/sh", "-c", commande] dans le conteneur cible.</p>
            </div>

            <div className="field">
              <label htmlFor="cron-schedule">Planification (cron, 5 champs)</label>
              <input
                id="cron-schedule"
                className="cell-mono"
                value={form.schedule}
                onChange={(event) => setForm((f) => ({ ...f, schedule: event.target.value }))}
                placeholder="*/5 * * * *"
                required
              />
              <p className="create-container-hint">minute heure jour-du-mois mois jour-de-semaine — ex "0 3 * * *" (tous les jours à 3h).</p>
            </div>

            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((f) => ({ ...f, enabled: event.target.checked }))}
              />
              Actif dès l'enregistrement
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating || !!updatingId || !isFormValid()}>
                {creating || updatingId ? "Enregistrement…" : editingId ? "Enregistrer" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleCancelForm}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {status !== "loading" && items.length === 0 && <div className="empty-state">Aucun cron job configuré.</div>}

        {items.length > 0 && (
          <div className="data-table-wrap" style={{ marginBottom: 16 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Conteneur</th>
                  <th>Planification</th>
                  <th>Commande</th>
                  <th>Actif</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id} className={job.id === historyJobId ? "is-selected" : undefined}>
                    <td className="cell-primary">{job.name}</td>
                    <td className="cell-mono">{job.containerName}</td>
                    <td className="cell-mono">{job.schedule}</td>
                    <td className="cell-mono" title={job.command} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {job.command}
                    </td>
                    <td>
                      <label className="filter-toggle">
                        <input
                          type="checkbox"
                          checked={job.enabled}
                          disabled={!admin || updatingId === job.id}
                          onChange={() => handleToggleEnabled(job)}
                        />
                        {job.enabled ? "Oui" : "Non"}
                      </label>
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        {operate && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Déclencher maintenant"
                            aria-label="Déclencher maintenant"
                            disabled={triggeringId === job.id}
                            onClick={() => handleTrigger(job)}
                          >
                            <IconPlay />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          title="Historique d'exécution"
                          aria-label="Historique d'exécution"
                          onClick={() => openHistory(job)}
                        >
                          <IconHistory />
                        </button>
                        {admin && (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEditForm(job)}>
                              Modifier
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn--danger"
                              title="Supprimer"
                              aria-label="Supprimer"
                              disabled={deletingId === job.id}
                              onClick={() => handleDelete(job)}
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!admin && items.length === 0 && status !== "loading" && (
          <div className="empty-state">Seul un administrateur peut créer un cron job.</div>
        )}

        {historyJob && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="iac-column__head">
              <span>Historique — {historyJob.name}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistoryJobId(null)}>
                Fermer
              </button>
            </div>

            {runsStatus === "loading" && historyRuns.length === 0 && <div className="empty-state">Chargement…</div>}
            {runsStatus !== "loading" && historyRuns.length === 0 && (
              <div className="empty-state">Aucune exécution pour l'instant.</div>
            )}

            {historyRuns.length > 0 && (
              <div style={{ display: "flex", gap: 14, minHeight: 0 }}>
                <div className="iac-run-list" style={{ width: 260, flexShrink: 0 }}>
                  {historyRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`iac-run-item iac-run-item--${run.status}${run.id === selectedRun?.id ? " is-selected" : ""}`}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <span>
                        {RUN_STATUS_LABEL[run.status]} · {RUN_TRIGGER_LABEL[run.trigger]}
                      </span>
                      <span className="iac-run-item__meta">
                        {formatDate(run.startedAt)}
                        {run.exitCode !== null && ` · code ${run.exitCode}`}
                      </span>
                    </button>
                  ))}
                </div>
                <pre className="iac-log" style={{ flex: 1 }}>
                  {selectedRun?.output || "(pas de sortie)"}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
