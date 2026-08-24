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
import { fetchExagridConfig, fetchExagridStatus } from "@/features/exagrid/exagridSlice";
import { canAdminister } from "@/features/auth/authSlice";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import StatusPill from "@/components/StatusPill";
import IntegrationSettingsHint, { OpenSettingsButton } from "@/components/IntegrationSettingsHint";
import { IconBackup, IconStorageArray } from "@/components/icons";
import ExagridReadingsPanel from "@/features/exagrid/ExagridReadingsPanel";
import {
  MISSING,
  ageSeverityClass,
  formatAge,
  formatBytes,
  formatPercent,
  usageSeverityClass,
  versionLabel,
} from "@/features/exagrid/exagridFormat";
import {
  complianceProps,
  countCompliance,
  eventSeverityProps,
  formatDateMs,
  jobStatusProps,
  latestJob,
  matchExagridTargets,
  type ExagridMatchKind,
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
  const {
    status: exagridStatus,
    statusLoad: exagridLoad,
    statusError: exagridError,
    backendUnavailable,
    configured: exagridConfigured,
    config: exagridConfig,
    configLoad: exagridConfigLoad,
  } = useAppSelector((s) => s.exagrid);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [activeTab, setActiveTab] = useState<HycuTab>("vms");
  const integrationsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (summaryStatus === "idle") dispatch(fetchHycuStatus());
    if (hycuConfigStatus === "idle") dispatch(fetchHycuConfig());
    if (exagridLoad === "idle") dispatch(fetchExagridStatus());
    if (exagridConfigLoad === "idle") dispatch(fetchExagridConfig());
  }, [dispatch, summaryStatus, hycuConfigStatus, exagridLoad, exagridConfigLoad]);

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
    dispatch(fetchExagridStatus());
    if (!hycuConfigured) return;
    dispatch(fetchHycuJobs());
    dispatch(fetchHycuVms());
    dispatch(fetchHycuTargets());
    if (activeTab === "policies") dispatch(fetchHycuPolicies());
    if (activeTab === "events") dispatch(fetchHycuEvents());
  }

  const hycuReachable = summary?.reachable === true;
  const hycuUnreachable = hycuConfigured && summary?.reachable === false;
  const exagridUnreachable = exagridConfigured && exagridStatus?.reachable === false;
  // `reachable` absent : on n'invente pas de verdict, mais on affiche les valeurs réellement lues.
  const exagridShowData = exagridConfigured && !!exagridStatus && exagridStatus.reachable !== false;
  const readings = exagridStatus?.readings;
  const retentionPct = readings?.retention.usedPct;

  const compliance = useMemo(() => countCompliance(vms), [vms]);
  const lastJob = useMemo(() => latestJob(jobs), [jobs]);

  const exagridHost = exagridStatus?.endpoint?.host ?? exagridConfig?.config?.host ?? null;
  const matches = useMemo(() => matchExagridTargets(targets, exagridHost), [targets, exagridHost]);
  const matchByTarget = useMemo(() => {
    const map = new Map<HycuTarget, ExagridMatchKind>();
    for (const match of matches) map.set(match.target, match.kind);
    return map;
  }, [matches]);
  const confirmedMatches = matches.filter((match) => match.kind === "address");
  const probableMatches = matches.filter((match) => match.kind === "hostname");

  const hycuPill = !hycuConfigured
    ? { status: "unconfigured" }
    : hycuUnreachable
      ? { status: "crit", label: "Injoignable" }
      : hycuReachable
        ? { status: "connected" }
        : { status: "checking", label: "Vérification…" };

  const exagridPill = backendUnavailable
    ? { status: "unavailable", label: "Indisponible" }
    : exagridLoad === "loading" && !exagridStatus
      ? { status: "checking", label: "Vérification…" }
      : !exagridConfigured
        ? { status: "unconfigured" }
        : exagridUnreachable
          ? { status: "crit", label: "Injoignable" }
          : exagridStatus?.reachable === true
            ? { status: "connected" }
            : { status: "unknown", label: "État inconnu" };

  /** Ancienneté de la file de réplication — le signal qui se dégrade avant tous les autres. */
  function replicationTile(): SummaryTile {
    const label = "Réplication en attente";
    if (backendUnavailable) return { label, value: MISSING, hint: "intégration ExaGrid indisponible" };
    if (!exagridConfigured) return { label, value: MISSING, hint: "ExaGrid non configuré" };
    if (exagridUnreachable) return { label, value: MISSING, hint: "appliance injoignable" };
    const age = readings?.pendingReplication.ageSeconds;
    if (age === undefined) return { label, value: MISSING, hint: "ancienneté non communiquée par la MIB" };
    const bytes = readings?.pendingReplication.bytes;
    return {
      label,
      value: formatAge(age),
      hint: bytes === undefined ? "volume non communiqué" : `${formatBytes(bytes)} en attente de copie hors site`,
      hintClass: ageSeverityClass(age),
    };
  }

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

  function occupancyTile(): SummaryTile {
    const label = "Occupation de l'appliance";
    if (backendUnavailable) return { label, value: MISSING, hint: "intégration ExaGrid indisponible" };
    if (!exagridConfigured) return { label, value: MISSING, hint: "ExaGrid non configuré" };
    if (exagridUnreachable) return { label, value: MISSING, hint: "appliance injoignable" };
    const retention = readings?.retention.usedPct;
    if (retention === undefined) return { label, value: MISSING, hint: "occupation non communiquée par la MIB" };
    const landing = readings?.landing.usedPct;
    return {
      label,
      value: formatPercent(retention),
      hint: landing === undefined ? "zone de rétention" : `rétention · atterrissage à ${formatPercent(landing)}`,
      hintClass: usageSeverityClass(retention),
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
        render: (row) => {
          const kind = matchByTarget.get(row.item);
          return (
            <span className="bkp-cell-inline">
              {row.item.name}
              {kind === "address" && (
                <span className="bkp-badge is-confirmed" title="Cette cible désigne l'appliance ExaGrid configurée">
                  ExaGrid
                </span>
              )}
              {kind === "hostname" && (
                <span className="bkp-badge" title="Nom d'hôte de l'appliance ExaGrid — rapprochement probable">
                  ExaGrid ?
                </span>
              )}
            </span>
          );
        },
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
    [matchByTarget],
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
              Protection des VM par le contrôleur HYCU et occupation réelle de l'appliance ExaGrid où atterrissent les
              sauvegardes — en lecture seule, aucune valeur n'est modifiée par QUAI.
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
          <span className="bkp-integration">
            <IconStorageArray />
            <span className="bkp-integration__name">Appliance ExaGrid</span>
            <StatusPill {...exagridPill} />
            {exagridConfigured && exagridConfig?.config && (
              <span className="bkp-integration__hint">
                {exagridConfig.config.host} · {versionLabel(exagridConfig.config.version)}
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
        {backendUnavailable && (
          <div className="exagrid-note">
            L'API QUAI ne répond pas sur les routes ExaGrid : l'intégration n'est pas encore déployée sur ce serveur.
            Aucune valeur d'appliance n'est affichée tant qu'elle n'est pas réellement interrogée.
          </div>
        )}
        {!backendUnavailable && exagridError && <div className="error-banner">ExaGrid : {exagridError}</div>}
        {exagridUnreachable && (
          <div className="error-banner">
            L'appliance ExaGrid est configurée mais ne répond pas en SNMP
            {exagridStatus?.lastPoll
              ? ` (dernier essai : ${new Date(exagridStatus.lastPoll.at).toLocaleString("fr-FR")})`
              : ""}
            . Aucune valeur n'est affichée tant qu'elle reste injoignable.
          </div>
        )}

        <div className="bkp-summary">
          <Tile tile={replicationTile()} hero />
          <Tile tile={protectedTile()} />
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
          <Tile tile={occupancyTile()} />
        </div>

        {hycuConfigured && exagridConfigured && targetsStatus === "ready" && targets.length > 0 && (
          <div
            className={`bkp-link${confirmedMatches.length > 0 ? " is-confirmed" : probableMatches.length > 0 ? " is-probable" : ""}`}
          >
            {confirmedMatches.length > 0 ? (
              <p>
                <strong>Ces sauvegardes atterrissent sur cette appliance.</strong> La cible HYCU{" "}
                {confirmedMatches.map((match, index) => (
                  <span key={match.target.uuid ?? match.target.name}>
                    {index > 0 && ", "}
                    <code>{match.target.name}</code>
                  </span>
                ))}{" "}
                désigne l'adresse <code>{confirmedMatches[0]?.token}</code> de l'appliance ExaGrid configurée
                {retentionPct === undefined
                  ? ", dont l'occupation n'est pas communiquée par la MIB."
                  : `, occupée à ${formatPercent(retentionPct)} en zone de rétention.`}
              </p>
            ) : probableMatches.length > 0 ? (
              <p>
                <strong>Rapprochement probable, non confirmé.</strong> La cible HYCU{" "}
                <code>{probableMatches[0]?.target.name}</code> contient le nom d'hôte{" "}
                <code>{probableMatches[0]?.token}</code> de l'appliance ExaGrid configurée, sans citer son adresse
                complète (<code>{exagridHost}</code>) — QUAI n'affirme pas que ces sauvegardes y atterrissent.
              </p>
            ) : (
              <p>
                Aucune cible HYCU ne désigne l'adresse de l'appliance ExaGrid configurée (<code>{exagridHost}</code>) —
                QUAI n'affirme aucun lien entre ces sauvegardes et cette appliance. HYCU n'expose que le nom de ses
                cibles, jamais leur adresse : le rapprochement ne peut se faire que sur ce nom.
              </p>
            )}
          </div>
        )}

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

            <h3 className="bkp-section-title">Appliance de stockage ExaGrid</h3>
            {!exagridConfigured && !backendUnavailable && exagridLoad !== "loading" && (
              <IntegrationSettingsHint
                title="ExaGrid non configuré"
                description="Sans accès SNMP à l'appliance, ni l'occupation des zones, ni les files d'attente de déduplication et de réplication ne peuvent être relevées."
                icon={<IconStorageArray />}
                admin={admin}
              />
            )}
            {exagridLoad === "loading" && !exagridStatus && (
              <div className="empty-state">Chargement de l'état de l'appliance…</div>
            )}
            {exagridShowData && exagridStatus && <ExagridReadingsPanel status={exagridStatus} />}
          </>
        )}
      </div>
    </div>
  );
}
