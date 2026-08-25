import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearHycuFocus,
  fetchHycuConfig,
  fetchHycuEvents,
  fetchHycuJobs,
  fetchHycuPolicies,
  fetchHycuStatus,
  fetchHycuTargets,
  fetchHycuVms,
  type HycuTab,
} from "@/features/hycu/hycuSlice";
import { canAdminister } from "@/features/auth/authSlice";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import StatusPill from "@/components/StatusPill";
import IntegrationSettingsHint, { OpenSettingsButton } from "@/components/IntegrationSettingsHint";
import { IconBackup } from "@/components/icons";
import {
  MISSING,
  complianceProps,
  countCompliance,
  eventSeverityProps,
  formatBytes,
  formatDateMs,
  formatPercent,
  jobStatusProps,
  latestJob,
} from "@/features/dataProtection/backupsModel";
import type { HycuEvent, HycuJob, HycuPolicy, HycuTarget, HycuVm } from "@/types";

// Les identifiants d'onglet restent ceux de HycuTab : le menu contextuel du nœud HYCU du graphe
// demande déjà "jobs" (voir TopologyGraph.tsx) et doit continuer d'ouvrir le bon onglet.
const TABS: { id: HycuTab; label: string }[] = [
  { id: "vms", label: "VM protégées" },
  { id: "policies", label: "Politiques" },
  { id: "targets", label: "Stockage" },
  { id: "jobs", label: "Jobs" },
  { id: "events", label: "Événements" },
];

interface Keyed<T> {
  id: string;
  item: T;
}

function keyed<T>(items: T[], id: (item: T, index: number) => string): Keyed<T>[] {
  return items.map((item, index) => ({ id: id(item, index), item }));
}

interface SummaryTile {
  label: string;
  value: string;
  hint: string;
  hintClass?: string;
}

function Tile({ tile, hero }: { tile: SummaryTile; hero?: boolean }) {
  return (
    <div className={`bkp-tile${hero ? " bkp-tile--hero" : ""}`}>
      <span className="bkp-tile__label">{tile.label}</span>
      <span className={`bkp-tile__value${tile.value === MISSING ? " is-missing" : ""}`}>{tile.value}</span>
      <span className={`bkp-tile__hint${tile.hintClass ?? ""}`}>{tile.hint}</span>
    </div>
  );
}

export default function BackupsPage() {
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
    configured: hycuConfigured,
    configStatus: hycuConfigStatus,
    focus,
  } = useAppSelector((s) => s.hycu);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [activeTab, setActiveTab] = useState<HycuTab>("vms");
  const integrationsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (summaryStatus === "idle") dispatch(fetchHycuStatus());
    if (hycuConfigStatus === "idle") dispatch(fetchHycuConfig());
  }, [dispatch, summaryStatus, hycuConfigStatus]);

  // VM, jobs et cibles alimentent le résumé de tête (conformité, dernier job, rapprochement avec
  // l'appliance) : chargés dès que HYCU répond, pas seulement à l'ouverture de leur onglet.
  useEffect(() => {
    if (!hycuConfigured) return;
    if (jobsStatus === "idle") dispatch(fetchHycuJobs());
    if (vmsStatus === "idle") dispatch(fetchHycuVms());
    if (targetsStatus === "idle") dispatch(fetchHycuTargets());
    if (activeTab === "policies" && policiesStatus === "idle") dispatch(fetchHycuPolicies());
    if (activeTab === "events" && eventsStatus === "idle") dispatch(fetchHycuEvents());
  }, [dispatch, hycuConfigured, activeTab, vmsStatus, policiesStatus, targetsStatus, jobsStatus, eventsStatus]);

  // Ouverture ciblée demandée par le menu contextuel du nœud HYCU du graphe — consommée une seule
  // fois. `config` renvoie désormais vers le bandeau d'intégrations (les formulaires sont ailleurs).
  useEffect(() => {
    if (!focus) return;
    if (focus.tab) setActiveTab(focus.tab);
    if (focus.config) integrationsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    dispatch(clearHycuFocus());
  }, [dispatch, focus]);

  function handleRefresh() {
    dispatch(fetchHycuStatus());
    if (!hycuConfigured) return;
    dispatch(fetchHycuJobs());
    dispatch(fetchHycuVms());
    dispatch(fetchHycuTargets());
    if (activeTab === "policies") dispatch(fetchHycuPolicies());
    if (activeTab === "events") dispatch(fetchHycuEvents());
  }

  const hycuReachable = summary?.reachable === true;
  const hycuUnreachable = hycuConfigured && summary?.reachable === false;
  const compliance = useMemo(() => countCompliance(vms), [vms]);
  const lastJob = useMemo(() => latestJob(jobs), [jobs]);

  const hycuPill = !hycuConfigured
    ? { status: "unconfigured" }
    : hycuUnreachable
      ? { status: "crit", label: "Injoignable" }
      : hycuReachable
        ? { status: "connected" }
        : { status: "checking", label: "Vérification…" };

  function protectedTile(): SummaryTile {
    const label = "VM protégées";
    if (!hycuConfigured) return { label, value: MISSING, hint: "HYCU non configuré" };
    if (hycuUnreachable) return { label, value: MISSING, hint: "contrôleur injoignable" };
    if (!summary?.vms) return { label, value: MISSING, hint: "inventaire non communiqué par HYCU" };
    return {
      label,
      value: `${summary.vms.protectedCount} / ${summary.vms.total}`,
      hint: `${summary.vms.total} VM vues par HYCU`,
    };
  }

  function complianceTile(): SummaryTile {
    const label = "Non conformes";
    if (!hycuConfigured) return { label, value: MISSING, hint: "HYCU non configuré" };
    if (hycuUnreachable) return { label, value: MISSING, hint: "contrôleur injoignable" };
    if (vmsStatus === "loading" && vms.length === 0) return { label, value: MISSING, hint: "chargement…" };
    if (compliance.withCompliance === 0) {
      return { label, value: MISSING, hint: "conformité non communiquée par HYCU" };
    }
    return {
      label,
      value: String(compliance.nonCompliant),
      hint: `sur ${compliance.withCompliance} VM avec un état de conformité`,
      ...(compliance.nonCompliant > 0 ? { hintClass: " is-warning" } : {}),
    };
  }

  const vmColumns = useMemo<DataTableColumn<HycuVm>[]>(
    () => [
      { key: "nom", label: "Nom", accessor: (row) => row.vmName, className: "cell-primary", aliases: ["vm"] },
      {
        key: "politique",
        label: "Politique",
        accessor: (row) => row.policyName ?? row.protectionGroupUuid ?? "",
        render: (row) =>
          row.policyName ??
          row.protectionGroupUuid ?? <span className="bkp-missing">Non protégée</span>,
      },
      { key: "protection", label: "Protection", accessor: (row) => row.protectionStatus ?? "" },
      {
        key: "conformite",
        label: "Conformité",
        accessor: (row) => row.complianceStatus ?? "",
        render: (row) => {
          const props = complianceProps(row.complianceStatus);
          return props ? <StatusPill {...props} /> : <span className="bkp-missing">{MISSING}</span>;
        },
      },
      {
        key: "sauvegarde",
        label: "Dernière sauvegarde",
        accessor: (row) => row.lastBackupInMillis ?? null,
        filterable: false,
        searchable: false,
        className: "cell-mono",
        render: (row) =>
          row.lastBackupInMillis === undefined ? (
            <span className="bkp-missing">{MISSING}</span>
          ) : (
            formatDateMs(row.lastBackupInMillis)
          ),
      },
    ],
    [],
  );

  const policyColumns = useMemo<DataTableColumn<HycuPolicy>[]>(
    () => [
      { key: "nom", label: "Nom", accessor: (row) => row.name, className: "cell-primary" },
      {
        key: "vms",
        label: "VM assignées",
        accessor: (row) => row.vmCount,
        kind: "number",
        align: "right",
        className: "cell-mono",
      },
    ],
    [],
  );

  const targetColumns = useMemo<DataTableColumn<Keyed<HycuTarget>>[]>(
    () => [
      {
        key: "nom",
        label: "Nom",
        accessor: (row) => row.item.name,
        className: "cell-primary",
      },
      { key: "type", label: "Type", accessor: (row) => row.item.type ?? "" },
      {
        key: "capacite",
        label: "Capacité",
        accessor: (row) => row.item.totalSizeInBytes ?? null,
        kind: "number",
        align: "right",
        className: "cell-mono",
        render: (row) => formatBytes(row.item.totalSizeInBytes),
      },
      {
        key: "utilise",
        label: "Utilisé",
        accessor: (row) => row.item.usedSizeInBytes ?? null,
        kind: "number",
        align: "right",
        className: "cell-mono",
        render: (row) => formatBytes(row.item.usedSizeInBytes),
      },
      {
        key: "libre",
        label: "Libre",
        accessor: (row) => row.item.freeSizeInBytes ?? null,
        kind: "number",
        align: "right",
        className: "cell-mono",
        render: (row) => formatBytes(row.item.freeSizeInBytes),
      },
      {
        key: "utilisation",
        label: "Utilisation",
        accessor: (row) => row.item.utilizationPct ?? null,
        kind: "number",
        align: "right",
        className: "cell-mono",
        render: (row) => formatPercent(row.item.utilizationPct),
      },
    ],
    [],
  );

  const jobColumns = useMemo<DataTableColumn<Keyed<HycuJob>>[]>(
    () => [
      { key: "nom", label: "Nom", accessor: (row) => row.item.name ?? "", className: "cell-primary" },
      { key: "type", label: "Type", accessor: (row) => row.item.type ?? "" },
      {
        key: "statut",
        label: "Statut",
        accessor: (row) => row.item.status,
        values: ["OK", "EXECUTING", "WARNING", "ERROR"],
        render: (row) => <StatusPill {...jobStatusProps(row.item.status)} />,
      },
      {
        key: "debut",
        label: "Début",
        accessor: (row) => row.item.startTimeInMillis ?? null,
        filterable: false,
        searchable: false,
        className: "cell-mono",
        render: (row) => formatDateMs(row.item.startTimeInMillis),
      },
      {
        key: "fin",
        label: "Fin",
        accessor: (row) => row.item.endTimeInMillis ?? null,
        filterable: false,
        searchable: false,
        className: "cell-mono",
        render: (row) => formatDateMs(row.item.endTimeInMillis),
      },
    ],
    [],
  );

  const eventColumns = useMemo<DataTableColumn<Keyed<HycuEvent>>[]>(
    () => [
      {
        key: "severite",
        label: "Sévérité",
        accessor: (row) => row.item.severity,
        values: ["INFO", "WARNING", "ERROR"],
        render: (row) => <StatusPill {...eventSeverityProps(row.item.severity)} />,
      },
      { key: "message", label: "Message", accessor: (row) => row.item.message ?? "", className: "cell-primary" },
      { key: "categorie", label: "Catégorie", accessor: (row) => row.item.category ?? "" },
      {
        key: "date",
        label: "Date",
        accessor: (row) => row.item.createdInMillis ?? null,
        filterable: false,
        searchable: false,
        className: "cell-mono",
        render: (row) => formatDateMs(row.item.createdInMillis),
      },
    ],
    [],
  );

  const targetRows = useMemo(() => keyed(targets, (target, index) => target.uuid ?? `target-${index}`), [targets]);
  const jobRows = useMemo(() => keyed(jobs, (job, index) => job.uuid ?? `job-${index}`), [jobs]);
  const eventRows = useMemo(() => keyed(events, (event, index) => event.uuid ?? `event-${index}`), [events]);

  function hycuEmpty(label: string): string {
    return hycuUnreachable ? "Aucune donnée — contrôleur HYCU injoignable." : label;
  }

  /** Un appel en échec n'est jamais présenté comme une liste vide. */
  function hycuLoadError(status: string, what: string): string | null {
    return status === "error" ? `Impossible de charger ${what} depuis HYCU.` : null;
  }

  const hycuMissing = (
    <IntegrationSettingsHint
      title="HYCU non configuré"
      description="Sans connexion au contrôleur de sauvegarde, QUAI n'affiche aucune VM protégée, politique, job ni événement."
      icon={<IconBackup />}
      admin={admin}
    />
  );

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Sauvegardes</h2>
            <p>
              Protection des VM par le contrôleur HYCU — en lecture seule, aucune valeur n'est modifiée par QUAI.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh}>
              Actualiser
            </button>
          </div>
        </div>

        <div className="bkp-integrations" ref={integrationsRef}>
          <span className="bkp-integration">
            <IconBackup />
            <span className="bkp-integration__name">Contrôleur HYCU</span>
            <StatusPill {...hycuPill} />
          </span>
            )}
          </span>
          {admin && (
            <span className="bkp-integrations__action">
              <OpenSettingsButton label="Réglages des intégrations" />
            </span>
          )}
        </div>

        {summaryStatus === "error" && <div className="error-banner">Impossible de charger le statut HYCU.</div>}
        {hycuUnreachable && (
          <div className="error-banner">
            HYCU est configuré mais injoignable
            {summary?.lastPoll ? ` (dernier essai : ${new Date(summary.lastPoll.at).toLocaleString("fr-FR")})` : ""}. Les
            listes ci-dessous peuvent rester vides tant que le contrôleur ne répond pas.
          </div>
        )}

        <div className="bkp-summary">
          <Tile tile={protectedTile()} hero />
          <Tile tile={complianceTile()} />
          <div className="bkp-tile">
            <span className="bkp-tile__label">Dernier job</span>
            {lastJob ? (
              <>
                <span className="bkp-tile__job">
                  <StatusPill {...jobStatusProps(lastJob.status)} />
                  <span className="bkp-tile__job-name" title={lastJob.name ?? lastJob.type ?? "Job HYCU"}>
                    {lastJob.name ?? lastJob.type ?? "Job HYCU"}
                  </span>
                </span>
                <span className="bkp-tile__hint">{formatDateMs(lastJob.startTimeInMillis)}</span>
              </>
            ) : (
              <>
                <span className="bkp-tile__value is-missing">{MISSING}</span>
                <span className="bkp-tile__hint">
                  {!hycuConfigured
                    ? "HYCU non configuré"
                    : hycuUnreachable
                      ? "contrôleur injoignable"
                      : jobsStatus === "loading"
                        ? "chargement…"
                        : "aucun job récent"}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="bkp-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`bkp-tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "vms" &&
          (hycuConfigured ? (
            <DataTable
              rows={vms}
              columns={vmColumns}
              rowKey={(row) => row.uuid}
              loading={vmsStatus === "loading" && vms.length === 0}
              error={hycuLoadError(vmsStatus, "les VM")}
              onRetry={handleRefresh}
              storageKey="backups-vms"
              itemsLabel="VM"
              emptyLabel={hycuEmpty("Aucune VM vue par HYCU.")}
              searchPlaceholder="Rechercher…  (ex : conformite:compliant  politique:quotidien)"
            />
          ) : (
            hycuMissing
          ))}

        {activeTab === "policies" &&
          (hycuConfigured ? (
            <DataTable
              rows={policies}
              columns={policyColumns}
              rowKey={(row) => row.uuid}
              loading={policiesStatus === "loading" && policies.length === 0}
              error={hycuLoadError(policiesStatus, "les politiques")}
              onRetry={handleRefresh}
              storageKey="backups-policies"
              itemsLabel="politiques"
              emptyLabel={hycuEmpty("Aucune politique de sauvegarde.")}
            />
          ) : (
            hycuMissing
          ))}

        {activeTab === "jobs" &&
          (hycuConfigured ? (
            <DataTable
              rows={jobRows}
              columns={jobColumns}
              rowKey={(row) => row.id}
              loading={jobsStatus === "loading" && jobs.length === 0}
              error={hycuLoadError(jobsStatus, "les jobs")}
              onRetry={handleRefresh}
              storageKey="backups-jobs"
              itemsLabel="jobs"
              emptyLabel={hycuEmpty("Aucun job récent.")}
              searchPlaceholder="Rechercher…  (ex : statut:ERROR)"
            />
          ) : (
            hycuMissing
          ))}

        {activeTab === "events" &&
          (hycuConfigured ? (
            <DataTable
              rows={eventRows}
              columns={eventColumns}
              rowKey={(row) => row.id}
              loading={eventsStatus === "loading" && events.length === 0}
              error={hycuLoadError(eventsStatus, "les événements")}
              onRetry={handleRefresh}
              storageKey="backups-events"
              itemsLabel="événements"
              emptyLabel={hycuEmpty("Aucun événement récent.")}
              searchPlaceholder="Rechercher…  (ex : severite:ERROR)"
            />
          ) : (
            hycuMissing
          ))}

        {activeTab === "targets" && (
          <>
            <h3 className="bkp-section-title">Cibles de sauvegarde déclarées dans HYCU</h3>
            {hycuConfigured ? (
              <DataTable
                rows={targetRows}
                columns={targetColumns}
                rowKey={(row) => row.id}
                loading={targetsStatus === "loading" && targets.length === 0}
                error={hycuLoadError(targetsStatus, "les cibles")}
                onRetry={handleRefresh}
                storageKey="backups-targets"
                itemsLabel="cibles"
                emptyLabel={hycuEmpty("Aucune cible de sauvegarde.")}
                searchable={false}
              />
            ) : (
              hycuMissing
            )}

          </>
        )}
      </div>
    </div>
  );
}
