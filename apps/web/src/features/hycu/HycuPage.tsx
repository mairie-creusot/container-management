import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearHycuTestResult,
  disableHycu,
  fetchHycuConfig,
  fetchHycuEvents,
  fetchHycuJobs,
  fetchHycuPolicies,
  fetchHycuStatus,
  fetchHycuTargets,
  fetchHycuVms,
  saveHycuConfig,
  testHycuConfig,
  type HycuConfigFormInput,
} from "@/features/hycu/hycuSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconBackup, IconCheck } from "@/components/icons";
import type { HycuJob, HycuVm } from "@/types";

const EMPTY_FORM: HycuConfigFormInput = { url: "", username: "", password: "" };

type HycuTab = "vms" | "policies" | "targets" | "jobs" | "events";

const TABS: { id: HycuTab; label: string }[] = [
  { id: "vms", label: "VMs protégées" },
  { id: "policies", label: "Politiques" },
  { id: "targets", label: "Cibles" },
  { id: "jobs", label: "Jobs" },
  { id: "events", label: "Événements" },
];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Mo";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} To`;
  if (gb < 1) return `${(bytes / (1024 * 1024)).toFixed(0)} Mo`;
  return `${gb.toFixed(1)} Go`;
}

function formatDateMs(ms?: number): string {
  return typeof ms === "number" ? new Date(ms).toLocaleString("fr-FR") : "—";
}

/** Statut de job HYCU réel (EXECUTING/OK/WARNING/ERROR) -> props StatusPill ; toute valeur
 * inattendue est affichée brute en neutre, jamais masquée. */
function jobStatusProps(status: string): { status: string; label?: string } {
  switch (status.toUpperCase()) {
    case "OK":
      return { status: "ok", label: "OK" };
    case "EXECUTING":
      return { status: "executing", label: "En cours" };
    case "WARNING":
      return { status: "warn", label: "Avertissement" };
    case "ERROR":
      return { status: "crit", label: "Erreur" };
    default:
      return { status };
  }
}

function eventSeverityProps(severity: string): { status: string; label?: string } {
  switch (severity.toUpperCase()) {
    case "ERROR":
      return { status: "crit", label: "Erreur" };
    case "WARNING":
      return { status: "warn", label: "Avertissement" };
    case "INFO":
      return { status: "info", label: "Info" };
    default:
      return { status: severity };
  }
}

/** complianceStatus est un champ supposé (voir apps/api/src/services/hycu.ts) — n'est compté
 * "non conforme" qu'une valeur PRÉSENTE et hors des libellés conformes usuels. */
const COMPLIANT_VALUES = new Set(["COMPLIANT", "OK", "GREEN", "PROTECTED"]);

function countNonCompliant(vms: HycuVm[]): { withCompliance: number; nonCompliant: number } {
  const withCompliance = vms.filter((v) => v.complianceStatus);
  const nonCompliant = withCompliance.filter((v) => !COMPLIANT_VALUES.has(v.complianceStatus!.toUpperCase())).length;
  return { withCompliance: withCompliance.length, nonCompliant };
}

/** Job le plus récent — par startTimeInMillis si exposé, sinon le premier renvoyé par HYCU. */
function latestJob(jobs: HycuJob[]): HycuJob | null {
  if (jobs.length === 0) return null;
  const withStart = jobs.filter((j) => typeof j.startTimeInMillis === "number");
  if (withStart.length === 0) return jobs[0] ?? null;
  return withStart.reduce((latest, j) => (j.startTimeInMillis! > latest.startTimeInMillis! ? j : latest));
}

/**
 * Section "Configuration" (admin uniquement) — même pattern exact que
 * EnvironmentsPage.tsx#NutanixConfigSection (formulaire pré-rempli sans mot de passe, PUT qui
 * teste réellement avant de persister) + bouton "Tester la connexion" façon AdDnsPage.tsx.
 */
function HycuConfigSection() {
  const dispatch = useAppDispatch();
  const { configured, config, configStatus, configSaving, configError, clearing, testing, testResult } =
    useAppSelector((s) => s.hycu);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<HycuConfigFormInput>(EMPTY_FORM);

  useEffect(() => {
    if (config) setForm({ url: config.url, username: config.username, password: "" });
  }, [config]);

  function openForm() {
    dispatch(clearHycuTestResult());
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearHycuTestResult());
    setForm(config ? { url: config.url, username: config.username, password: "" } : EMPTY_FORM);
  }

  function currentInput(): HycuConfigFormInput {
    return {
      url: form.url.trim(),
      username: form.username.trim(),
      ...(form.password?.trim() ? { password: form.password.trim() } : {}),
    };
  }

  function isFormValid(): boolean {
    const input = currentInput();
    // password vide autorisé seulement si une config existe déjà (le serveur conserve l'existant).
    const hasPassword = !!input.password || configured;
    return !!(input.url && input.username && hasPassword);
  }

  async function handleTest() {
    if (!isFormValid()) return;
    await dispatch(testHycuConfig(currentInput()));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(saveHycuConfig(currentInput()));
    if (saveHycuConfig.fulfilled.match(result)) {
      setEditing(false);
      dispatch(clearHycuTestResult());
      dispatch(fetchHycuStatus());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration HYCU ?",
      description:
        "QUAI n'interrogera plus le contrôleur de sauvegarde — les VMs protégées, politiques, cibles, jobs et événements disparaîtront de cette page. Aucune donnée n'est modifiée côté HYCU.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableHycu());
    setForm(EMPTY_FORM);
  }

  const showForm = editing || !configured;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Configuration</h3>
          <p>
            Connexion à l'API REST du contrôleur HYCU (lecture seule). La connexion est réellement testée
            avant l'enregistrement — jamais persisté à l'aveugle.
          </p>
        </div>
        {configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openForm}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable} disabled={clearing}>
              {clearing ? "Retrait…" : "Retirer"}
            </button>
          </div>
        )}
      </div>

      {configError && <div className="error-banner" style={{ marginBottom: 16 }}>{configError}</div>}

      {testResult && (
        <div className={testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {testResult.ok && <IconCheck />}
          {testResult.message}
          {testResult.ok && typeof testResult.vmCount === "number" && ` — ${testResult.vmCount} VM(s) visibles`}
        </div>
      )}

      {configStatus !== "loading" && configured && !editing && config && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconBackup />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL du contrôleur", value: config.url },
              { key: "Utilisateur", value: config.username },
            ]}
          />
        </div>
      )}

      {showForm && (
        <form
          className="card"
          style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={handleSave}
        >
          <div className="field">
            <label htmlFor="hycu-url">URL du contrôleur HYCU</label>
            <input
              id="hycu-url"
              value={form.url}
              onChange={(event) => setForm((f) => ({ ...f, url: event.target.value }))}
              placeholder="https://172.20.0.100:8443"
              disabled={configSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hycu-username">Utilisateur</label>
            <input
              id="hycu-username"
              value={form.username}
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
              disabled={configSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hycu-password">
              Mot de passe{configured ? " (laisser vide pour conserver l'existant)" : ""}
            </label>
            <input
              id="hycu-password"
              type="password"
              value={form.password ?? ""}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              autoComplete="new-password"
              disabled={configSaving}
              {...(configured ? {} : { required: true })}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={configSaving || !isFormValid()}>
              {configSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleTest}
              disabled={configSaving || testing || !isFormValid()}
            >
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            {configured && (
              <button type="button" className="btn btn-ghost" onClick={closeForm} disabled={configSaving}>
                Annuler
              </button>
            )}
          </div>
        </form>
      )}
    </>
  );
}

export default function HycuPage() {
  const dispatch = useAppDispatch();
  const {
    summary,
    summaryStatus,
    vms,
    vmsStatus,
    policies,
    policiesStatus,
    targets,
    targetsStatus,
    jobs,
    jobsStatus,
    events,
    eventsStatus,
    configured,
    configStatus,
  } = useAppSelector((s) => s.hycu);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [activeTab, setActiveTab] = useState<HycuTab>("vms");

  useEffect(() => {
    if (summaryStatus === "idle") dispatch(fetchHycuStatus());
    if (configStatus === "idle") dispatch(fetchHycuConfig());
  }, [dispatch, summaryStatus, configStatus]);

  // Chargement à la demande : l'onglet actif + les jobs (carte "Dernier job" de la synthèse).
  useEffect(() => {
    if (!configured) return;
    if (jobsStatus === "idle") dispatch(fetchHycuJobs());
    if (activeTab === "vms" && vmsStatus === "idle") dispatch(fetchHycuVms());
    if (activeTab === "policies" && policiesStatus === "idle") dispatch(fetchHycuPolicies());
    if (activeTab === "targets" && targetsStatus === "idle") dispatch(fetchHycuTargets());
    if (activeTab === "events" && eventsStatus === "idle") dispatch(fetchHycuEvents());
  }, [dispatch, configured, activeTab, vmsStatus, policiesStatus, targetsStatus, jobsStatus, eventsStatus]);

  function handleRefresh() {
    dispatch(fetchHycuStatus());
    if (!configured) return;
    dispatch(fetchHycuJobs());
    if (activeTab === "vms") dispatch(fetchHycuVms());
    if (activeTab === "policies") dispatch(fetchHycuPolicies());
    if (activeTab === "targets") dispatch(fetchHycuTargets());
    if (activeTab === "events") dispatch(fetchHycuEvents());
  }

  const reachable = summary?.reachable === true;
  const unreachable = configured && summary?.reachable === false;
  const compliance = useMemo(() => countNonCompliant(vms), [vms]);
  const lastJob = useMemo(() => latestJob(jobs), [jobs]);

  const connectionPill = !configured
    ? { status: "unconfigured" }
    : unreachable
      ? { status: "crit", label: "Injoignable" }
      : reachable
        ? { status: "connected" }
        : { status: "checking", label: "Vérification…" };

  const emptyListLabel = unreachable ? "Aucune donnée — contrôleur HYCU injoignable." : null;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Sauvegardes</h2>
            <p>
              Contrôleur de sauvegarde HYCU protégeant le cluster Nutanix — VMs protégées, politiques,
              cibles, jobs et événements réels, en lecture seule.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusPill {...connectionPill} />
            {configured && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh}>
                Actualiser
              </button>
            )}
          </div>
        </div>

        {summaryStatus === "error" && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            Impossible de charger le statut HYCU.
          </div>
        )}

        {unreachable && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            HYCU est configuré mais injoignable
            {summary?.lastPoll ? ` (dernier essai : ${new Date(summary.lastPoll.at).toLocaleString("fr-FR")})` : ""}.
            Les listes ci-dessous peuvent être vides tant que le contrôleur ne répond pas.
          </div>
        )}

        {summaryStatus === "loading" && !summary && <div className="empty-state">Chargement du statut HYCU…</div>}

        {summaryStatus !== "loading" && summary && !configured && (
          <div className="empty-state">
            <IconBackup />
            <strong>HYCU non configuré</strong>
            {admin ? (
              <span>Renseignez la connexion au contrôleur dans la section Configuration ci-dessous.</span>
            ) : (
              <span>Seul un administrateur peut configurer la connexion au contrôleur HYCU.</span>
            )}
          </div>
        )}

        {configured && reachable && summary && (
          <>
            <div className="stat-grid">
              <div className="stat-card stat-card--hero">
                <span className="stat-card__label">VMs protégées</span>
                <span className="stat-card__value">
                  {summary.vms ? `${summary.vms.protectedCount} / ${summary.vms.total}` : "—"}
                </span>
                <span className="stat-card__hint">
                  {compliance.withCompliance > 0
                    ? `${compliance.nonCompliant} non conforme(s)`
                    : "VMs vues par HYCU"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Politiques</span>
                <span className="stat-card__value">{summary.policies ? summary.policies.count : "—"}</span>
                <span className="stat-card__hint">politiques de sauvegarde</span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Cibles</span>
                <span className="stat-card__value">{summary.targets ? summary.targets.count : "—"}</span>
                <span className="stat-card__hint">
                  {summary.targets
                    ? `${formatBytes(summary.targets.usedSizeInBytes)} / ${formatBytes(summary.targets.totalSizeInBytes)} utilisés`
                    : "capacité inconnue"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Jobs récents</span>
                <span className="stat-card__value">{summary.jobs ? summary.jobs.total : "—"}</span>
                <span
                  className={`stat-card__hint${
                    summary.jobs && (summary.jobs.byStatus.ERROR ?? 0) > 0
                      ? " is-critical"
                      : summary.jobs && (summary.jobs.byStatus.WARNING ?? 0) > 0
                        ? " is-warning"
                        : ""
                  }`}
                >
                  {summary.jobs
                    ? `${summary.jobs.byStatus.ERROR ?? 0} erreur(s) · ${summary.jobs.byStatus.WARNING ?? 0} avertissement(s)`
                    : "aucune donnée"}
                </span>
              </div>
            </div>

            {lastJob && (
              <div className="card hycu-last-job">
                <span className="stat-card__label">Dernier job</span>
                <strong>{lastJob.name ?? lastJob.type ?? "Job HYCU"}</strong>
                <StatusPill {...jobStatusProps(lastJob.status)} />
                <span className="cell-mono">{formatDateMs(lastJob.startTimeInMillis)}</span>
              </div>
            )}
          </>
        )}

        {configured && (
          <>
            <div className="hycu-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`hycu-tab${activeTab === tab.id ? " is-active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "vms" && (
              <>
                {vmsStatus === "loading" && vms.length === 0 && <div className="empty-state">Chargement des VMs…</div>}
                {vmsStatus === "ready" && vms.length === 0 && (
                  <div className="empty-state">{emptyListLabel ?? "Aucune VM vue par HYCU."}</div>
                )}
                {vms.length > 0 && (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Nom</th>
                          <th>Politique</th>
                          <th>Protection</th>
                          <th>Conformité</th>
                          <th>Dernière sauvegarde</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vms.map((vm) => (
                          <tr key={vm.uuid}>
                            <td className="cell-primary">{vm.vmName}</td>
                            <td>
                              {vm.policyName ??
                                vm.protectionGroupUuid ??
                                <span style={{ color: "var(--color-text-faint)" }}>Non protégée</span>}
                            </td>
                            <td>{vm.protectionStatus ?? "—"}</td>
                            <td>{vm.complianceStatus ?? "—"}</td>
                            <td className="cell-mono">{formatDateMs(vm.lastBackupInMillis)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {activeTab === "policies" && (
              <>
                {policiesStatus === "loading" && policies.length === 0 && (
                  <div className="empty-state">Chargement des politiques…</div>
                )}
                {policiesStatus === "ready" && policies.length === 0 && (
                  <div className="empty-state">{emptyListLabel ?? "Aucune politique de sauvegarde."}</div>
                )}
                {policies.length > 0 && (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Nom</th>
                          <th>VMs assignées</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policies.map((policy) => (
                          <tr key={policy.uuid}>
                            <td className="cell-primary">{policy.name}</td>
                            <td className="cell-mono">{policy.vmCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {activeTab === "targets" && (
              <>
                {targetsStatus === "loading" && targets.length === 0 && (
                  <div className="empty-state">Chargement des cibles…</div>
                )}
                {targetsStatus === "ready" && targets.length === 0 && (
                  <div className="empty-state">{emptyListLabel ?? "Aucune cible de sauvegarde."}</div>
                )}
                {targets.length > 0 && (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Nom</th>
                          <th>Type</th>
                          <th>Capacité</th>
                          <th>Utilisé</th>
                          <th>Libre</th>
                          <th>Utilisation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targets.map((target, index) => (
                          <tr key={target.uuid ?? `${target.name}-${index}`}>
                            <td className="cell-primary">{target.name}</td>
                            <td>{target.type ?? "—"}</td>
                            <td className="cell-mono">
                              {target.totalSizeInBytes !== undefined ? formatBytes(target.totalSizeInBytes) : "—"}
                            </td>
                            <td className="cell-mono">
                              {target.usedSizeInBytes !== undefined ? formatBytes(target.usedSizeInBytes) : "—"}
                            </td>
                            <td className="cell-mono">
                              {target.freeSizeInBytes !== undefined ? formatBytes(target.freeSizeInBytes) : "—"}
                            </td>
                            <td className="cell-mono">
                              {target.utilizationPct !== undefined ? `${target.utilizationPct.toFixed(1)} %` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {activeTab === "jobs" && (
              <>
                {jobsStatus === "loading" && jobs.length === 0 && <div className="empty-state">Chargement des jobs…</div>}
                {jobsStatus === "ready" && jobs.length === 0 && (
                  <div className="empty-state">{emptyListLabel ?? "Aucun job récent."}</div>
                )}
                {jobs.length > 0 && (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Nom</th>
                          <th>Type</th>
                          <th>Statut</th>
                          <th>Début</th>
                          <th>Fin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((job, index) => (
                          <tr key={job.uuid ?? index}>
                            <td className="cell-primary">{job.name ?? "—"}</td>
                            <td>{job.type ?? "—"}</td>
                            <td>
                              <StatusPill {...jobStatusProps(job.status)} />
                            </td>
                            <td className="cell-mono">{formatDateMs(job.startTimeInMillis)}</td>
                            <td className="cell-mono">{formatDateMs(job.endTimeInMillis)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {activeTab === "events" && (
              <>
                {eventsStatus === "loading" && events.length === 0 && (
                  <div className="empty-state">Chargement des événements…</div>
                )}
                {eventsStatus === "ready" && events.length === 0 && (
                  <div className="empty-state">{emptyListLabel ?? "Aucun événement récent."}</div>
                )}
                {events.length > 0 && (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Sévérité</th>
                          <th>Message</th>
                          <th>Catégorie</th>
                          <th>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.map((event, index) => (
                          <tr key={event.uuid ?? index}>
                            <td>
                              <StatusPill {...eventSeverityProps(event.severity)} />
                            </td>
                            <td>{event.message ?? "—"}</td>
                            <td>{event.category ?? "—"}</td>
                            <td className="cell-mono">{formatDateMs(event.createdInMillis)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {admin && (
          <div style={{ marginTop: configured ? 32 : 0 }}>
            <HycuConfigSection />
          </div>
        )}
      </div>
    </div>
  );
}
