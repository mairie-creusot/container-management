import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useAppDispatch, useAppSelector } from "@/hooks";
import { apiUrl } from "@/api/client";
import {
  createRoute,
  deleteRoute,
  fetchCaddyStatus,
  fetchRoutes,
  resyncRouteDns,
  type CreatedRoute,
} from "@/features/reverseProxy/reverseProxySlice";
import {
  clearCertificatesIssueError,
  fetchCertificates,
  fetchCertificatesConfig,
  forgetCertificate,
  issueCertificate,
} from "@/features/certificates/certificatesSlice";
import { fetchContainers } from "@/features/containers/containersSlice";
import { canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import StatusPill from "@/components/StatusPill";
import { OpenSettingsButton } from "@/components/IntegrationSettingsHint";
import { IconGlobe, IconPlus, IconRestart, IconTrash } from "@/components/icons";
import {
  buildPublicationRows,
  countPublications,
  CERT_LABEL,
  CERT_TOKEN,
  daysRemainingLabel,
  DNS_LABEL,
  DNS_TOKEN,
  formatAgo,
  formatDate,
  formatDateTime,
  MISSING,
  portDetectionHint,
  type PublicationCertState,
  type PublicationDnsState,
  type PublicationRow,
} from "@/features/publication/publicationModel";
import type { ReverseProxyRoute } from "@/types";

type TargetMode = "container" | "manual";

const DNS_PILL: Record<PublicationDnsState, string> = {
  synced: "ok",
  failed: "crit",
  manual: "unconfigured",
  none: "unconfigured",
};

const CERT_PILL: Record<PublicationCertState, string> = {
  valid: "ok",
  expiring: "warn",
  expired: "crit",
  missing: "warn",
  unconfigured: "unconfigured",
};

/** Message affiché après création : le port RÉELLEMENT retenu, et l'état du certificat AD CS. */
function createdRouteSummary(route: CreatedRoute): string {
  const detail = portDetectionHint(route);
  const port = detail ?? `Port ${route.targetPort} (saisi).`;
  const certificate =
    route.certificate?.status === "issued"
      ? " Certificat AD CS émis pour ce sous-domaine."
      : route.certificate?.status === "already-valid"
        ? " Certificat AD CS déjà valide pour ce sous-domaine."
        : route.certificate?.status === "failed"
          ? ` Émission du certificat AD CS échouée (${route.certificate.message ?? "raison inconnue"}) — la route reste active avec le certificat interne de Caddy, un nouvel essai aura lieu automatiquement.`
          : "";
  return `Service « ${route.subdomain} » publié. ${port}${certificate}`;
}

export default function PublicationPage() {
  const dispatch = useAppDispatch();
  const {
    items: routes,
    status: routesStatus,
    error: routesError,
    creating,
    caddyStatus,
    caddyStatusLoading,
    resyncingId,
  } = useAppSelector((s) => s.reverseProxy);
  const {
    overview,
    status: certificatesStatus,
    configStatus,
    configured: authorityConfigured,
    config: authorityConfig,
    error: certificatesError,
    issuing,
    issueError,
  } = useAppSelector((s) => s.certificates);
  const containers = useAppSelector((s) => s.containers.items);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();
  const operator = canOperate(session);

  const [showForm, setShowForm] = useState(false);
  const [targetMode, setTargetMode] = useState<TargetMode>("container");
  const [form, setForm] = useState({ subdomain: "", targetContainerId: "", targetHost: "", targetPort: "" });
  const [createError, setCreateError] = useState<string | null>(null);
  /** Résultat de la DERNIÈRE création réussie — construit à partir de la route renvoyée par l'API. */
  const [createdSummary, setCreatedSummary] = useState<string | null>(null);
  const [newSubject, setNewSubject] = useState("");

  const isDirty = showForm && form.subdomain.trim() !== "";

  useEffect(() => {
    dispatch(fetchRoutes());
    dispatch(fetchCaddyStatus());
    dispatch(fetchCertificates());
    dispatch(fetchCertificatesConfig());
    // Toujours le démon local ici (le reverse proxy interne ne cible que des conteneurs gérés
    // localement par QUAI, voir ARCHITECTURE.md § "Reverse proxy interne").
    dispatch(fetchContainers(null));
  }, [dispatch]);

  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
  }, [dispatch, isDirty]);
  useEffect(() => {
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
  }, [dispatch]);

  const runningContainers = containers.filter((c) => c.state === "running");
  const containerNameById = useMemo(() => new Map(containers.map((c) => [c.id, c.name])), [containers]);
  const certificates = useMemo(() => overview?.certificates ?? [], [overview]);
  const rows = useMemo(
    () => buildPublicationRows(routes, certificates, containerNameById, authorityConfigured),
    [routes, certificates, containerNameById, authorityConfigured],
  );
  const counters = useMemo(() => countPublications(rows), [rows]);

  const scheme = caddyStatus?.httpsEnabled ? "https" : "http";
  const reconciliation = overview?.reconciliation;
  const lastOnDemand = reconciliation?.lastOnDemandIssuance ?? null;
  const renewBeforeDays = overview?.renewBeforeDays ?? authorityConfig?.renewBeforeDays ?? 30;

  function resetForm(clearFeedback = true) {
    setShowForm(false);
    setTargetMode("container");
    setForm({ subdomain: "", targetContainerId: "", targetHost: "", targetPort: "" });
    if (clearFeedback) {
      setCreateError(null);
      setCreatedSummary(null);
    }
  }

  function handleRefresh() {
    dispatch(fetchRoutes());
    dispatch(fetchCaddyStatus());
    dispatch(fetchCertificates());
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const subdomain = form.subdomain.trim();
    // Port facultatif pour un conteneur (déduit du conteneur réel côté API) ; toujours requis pour
    // une cible host:port arbitraire, qui n'est pas inspectable.
    const rawPort = form.targetPort.trim();
    const targetPort = rawPort ? Number(rawPort) : undefined;
    if (!subdomain) return;
    if (targetPort !== undefined && (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535)) return;
    if (targetMode === "container" && !form.targetContainerId) return;
    if (targetMode === "manual" && (!form.targetHost.trim() || targetPort === undefined)) return;

    setCreateError(null);
    setCreatedSummary(null);
    dispatch(
      createRoute({
        subdomain,
        ...(targetPort !== undefined ? { targetPort } : {}),
        ...(targetMode === "container"
          ? { targetContainerId: form.targetContainerId }
          : { targetHost: form.targetHost.trim() }),
      }),
    ).then((action) => {
      if (createRoute.fulfilled.match(action)) {
        if (action.payload.caddyPushError) {
          setCreateError(
            `Route créée mais pas encore active sur Caddy : ${action.payload.caddyPushError}. Réessayez une fois Caddy joignable.`,
          );
        }
        setCreatedSummary(createdRouteSummary(action.payload));
        resetForm(false);
        dispatch(fetchCaddyStatus());
        dispatch(fetchCertificates());
      } else {
        setCreateError(action.payload ?? "Impossible de publier ce service.");
      }
    });
  }

  async function handleCancelForm() {
    if (isDirty) {
      const ok = await confirm({
        title: "Abandonner cette publication ?",
        description: "Les informations saisies pour ce sous-domaine n'ont pas été enregistrées.",
        confirmLabel: "Abandonner les modifications",
        variant: "danger",
      });
      if (!ok) return;
    }
    resetForm();
  }

  async function handleDelete(route: ReverseProxyRoute) {
    const ok = await confirm({
      title: "Retirer cette publication",
      description: `Confirmer la suppression de la route « ${route.subdomain} » ? Le sous-domaine ne sera plus servi. Un certificat déjà émis pour ce sujet reste visible dans cette liste jusqu'à ce qu'il soit oublié.`,
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteRoute(route.id));
  }

  async function handleRenew(subject: string) {
    dispatch(clearCertificatesIssueError());
    await dispatch(issueCertificate(subject));
  }

  async function handleForget(subject: string) {
    const ok = await confirm({
      title: `Oublier le certificat de ${subject} ?`,
      description:
        "QUAI cesse de suivre et de renouveler ce certificat. Si le sujet est republié plus tard, il repassera sur l'autorité interne de Caddy (cadenas rouge) tant qu'un nouveau certificat n'a pas été demandé.",
      confirmLabel: "Oublier",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(forgetCertificate(subject));
    dispatch(fetchCertificates());
  }

  async function handleIssueStandalone() {
    const subject = newSubject.trim();
    if (!subject) return;
    const result = await dispatch(issueCertificate(subject));
    if (issueCertificate.fulfilled.match(result)) setNewSubject("");
  }

  const columns = useMemo<DataTableColumn<PublicationRow>[]>(
    () => [
      {
        key: "sousdomaine",
        label: "Sous-domaine",
        accessor: (row) => row.subdomain,
        className: "cell-primary",
        aliases: ["nom", "domaine", "sujet"],
        render: (row) => (
          <span
            className="pub-subdomain"
            {...(row.publishedAt ? { title: `Publié le ${formatDateTime(row.publishedAt)}` } : {})}
          >
            <span className="cell-mono">{row.subdomain}</span>
            {!row.route && (
              <span className="pub-badge pub-badge--muted" title="Certificat émis pour un sujet qui n'est plus publié">
                sans route
              </span>
            )}
          </span>
        ),
      },
      {
        key: "cible",
        label: "Cible",
        accessor: (row) => row.target,
        className: "cell-mono",
        aliases: ["conteneur", "port"],
        render: (row) => (
          <span className="pub-cell-inline" {...(row.targetHint ? { title: row.targetHint } : {})}>
            {row.target === MISSING ? <span className="pub-missing">{MISSING}</span> : row.target}
            {row.autoPort && <span className="pub-badge">port auto</span>}
          </span>
        ),
      },
      {
        key: "dns",
        label: "DNS",
        accessor: (row) => DNS_TOKEN[row.dns],
        values: ["synchronisé", "échec", "manuel", "aucun"],
        hint: "État de la mise à jour DNS Active Directory de ce sous-domaine",
        render: (row) => (
          <span className="pub-cell-inline" {...(row.dnsMessage ? { title: row.dnsMessage } : {})}>
            {row.route ? (
              <StatusPill status={DNS_PILL[row.dns]} label={DNS_LABEL[row.dns]} />
            ) : (
              <span className="pub-missing">{MISSING}</span>
            )}
            {operator && row.route && (
              <button
                type="button"
                className="icon-btn"
                title="Retester la synchronisation DNS (nsupdate, sans recréer la route)"
                aria-label="Retester la synchronisation DNS"
                disabled={resyncingId === row.route.id}
                onClick={() => dispatch(resyncRouteDns(row.route!.id))}
              >
                <IconRestart {...(resyncingId === row.route.id ? { className: "icon-spin" } : {})} />
              </button>
            )}
          </span>
        ),
      },
      {
        key: "certificat",
        label: "Certificat",
        accessor: (row) => CERT_TOKEN[row.cert],
        values: ["valide", "expirant", "expiré", "aucun", "non-configurée"],
        aliases: ["cert", "tls"],
        render: (row) => (
          <span className="pub-cert">
            <StatusPill status={CERT_PILL[row.cert]} label={CERT_LABEL[row.cert]} />
            {row.renewalError && (
              <span className="certificates-error" title={row.renewalError}>
                {row.renewalError}
              </span>
            )}
          </span>
        ),
      },
      {
        key: "jours",
        label: "Jours restants",
        accessor: (row) => row.daysRemaining,
        kind: "number",
        align: "right",
        render: (row) =>
          row.daysRemaining === null ? (
            <span className="pub-missing">{MISSING}</span>
          ) : (
            daysRemainingLabel(row.daysRemaining)
          ),
      },
      {
        key: "expiration",
        label: "Expire le",
        accessor: (row) => row.notAfter,
        kind: "date",
        aliases: ["echeance"],
        render: (row) =>
          row.notAfter ? formatDate(row.notAfter) : <span className="pub-missing">{MISSING}</span>,
      },
      {
        key: "actions",
        label: "",
        accessor: () => "",
        sortable: false,
        filterable: false,
        searchable: false,
        align: "right",
        className: "cell-actions",
        render: (row) => (
          <div className="row-actions">
            {row.route && (
              <a
                className="icon-btn"
                href={`${scheme}://${row.subdomain}`}
                target="_blank"
                rel="noreferrer"
                title={`Ouvrir ${scheme}://${row.subdomain} dans un nouvel onglet`}
                aria-label="Ouvrir le service"
              >
                <IconGlobe />
              </a>
            )}
            {operator && authorityConfigured && (
              <button
                type="button"
                className="icon-btn"
                title={row.certificate ? "Renouveler le certificat maintenant" : "Demander un certificat maintenant"}
                aria-label="Renouveler le certificat"
                disabled={issuing}
                onClick={() => void handleRenew(row.subdomain)}
              >
                <IconRestart {...(issuing ? { className: "icon-spin" } : {})} />
              </button>
            )}
            {operator && row.route && (
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="Retirer la route"
                aria-label="Retirer la route"
                onClick={() => void handleDelete(row.route!)}
              >
                <IconTrash />
              </button>
            )}
            {operator && !row.route && (
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="Oublier ce certificat"
                aria-label="Oublier ce certificat"
                onClick={() => void handleForget(row.subdomain)}
              >
                <IconTrash />
              </button>
            )}
          </div>
        ),
      },
    ],
    // Les gestionnaires référencés ne ferment que sur `dispatch` et `confirm`, stables.
    [operator, authorityConfigured, issuing, resyncingId, scheme],
  );

  const proxyPill = caddyStatusLoading && !caddyStatus
    ? { status: "checking", label: "Vérification…" }
    : caddyStatus?.reachable
      ? { status: "ok", label: "Joignable" }
      : { status: "crit", label: "Injoignable" };

  const httpsPill = !caddyStatus
    ? { status: "checking", label: "Vérification…" }
    : caddyStatus.httpsEnabled
      ? { status: "ok", label: "Servi (:443)" }
      : { status: "warn", label: "HTTP seul" };

  const authorityPill = configStatus === "loading" && !authorityConfig
    ? { status: "checking", label: "Vérification…" }
    : authorityConfigured
      ? { status: "ok", label: "AD CS configurée" }
      : { status: "unconfigured", label: "Non configurée" };

  const reconciliationPill = !authorityConfigured
    ? { status: "unconfigured", label: MISSING }
    : !reconciliation || !reconciliation.lastCheckAt
      ? { status: "warn", label: "Jamais" }
      : reconciliation.lastFailedSubjects.length > 0
        ? { status: "crit", label: formatAgo(reconciliation.lastCheckAt) ?? "Inconnue" }
        : { status: "ok", label: formatAgo(reconciliation.lastCheckAt) ?? "Inconnue" };

  const tableLoading =
    (routesStatus === "loading" && routes.length === 0) || (certificatesStatus === "loading" && !overview);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Publication</h2>
            <p>
              Sous-domaines internes servis par Caddy : leur cible réelle, la synchronisation DNS et le certificat TLS
              qui les protège, au même endroit.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh}>
              Actualiser
            </button>
            {operator && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => (showForm ? void handleCancelForm() : setShowForm(true))}
              >
                <IconPlus /> {showForm ? "Annuler" : "Publier un service"}
              </button>
            )}
          </div>
        </div>

        <section className="pub-band">
          <div className="pub-band__grid">
            <div className="pub-band__item">
              <span className="pub-band__label">Reverse proxy</span>
              <StatusPill {...proxyPill} />
              <span className="pub-band__hint" title="API d'administration JSON, jamais exposée hors du réseau Docker">
                {caddyStatus?.adminUrl ?? "http://caddy:2019"}
              </span>
            </div>
            <div className="pub-band__item">
              <span className="pub-band__label">HTTPS</span>
              <StatusPill {...httpsPill} />
              <span className="pub-band__hint">
                {caddyStatus?.httpsEnabled
                  ? "port 80 servi en parallèle, sans redirection forcée"
                  : "les sous-domaines ne sont servis qu'en HTTP"}
              </span>
            </div>
            <div className="pub-band__item">
              <span className="pub-band__label">Autorité de certification</span>
              <StatusPill {...authorityPill} />
              <span className="pub-band__hint" {...(authorityConfig?.caUrl ? { title: authorityConfig.caUrl } : {})}>
                {authorityConfigured
                  ? (authorityConfig?.caUrl ?? "autorité interne de la mairie")
                  : "certificats servis par l'autorité interne de Caddy"}
              </span>
            </div>
            <div className="pub-band__item">
              <span className="pub-band__label">Dernière réconciliation</span>
              <StatusPill {...reconciliationPill} />
              <span
                className="pub-band__hint"
                {...(reconciliation?.lastCheckAt ? { title: formatDateTime(reconciliation.lastCheckAt) } : {})}
              >
                {authorityConfigured
                  ? `renouvellement automatique ${renewBeforeDays} j avant expiration`
                  : "aucun renouvellement automatique"}
              </span>
            </div>
          </div>

          <div className="pub-band__footer">
            <span className="pub-counters">
              <strong>{counters.published}</strong> service(s) publié(s)
              {counters.certMissing > 0 && (
                <span className="pub-counter is-warning">{counters.certMissing} sans certificat</span>
              )}
              {counters.certExpiring > 0 && (
                <span className="pub-counter is-warning">{counters.certExpiring} certificat(s) à renouveler</span>
              )}
              {counters.certExpired > 0 && (
                <span className="pub-counter is-critical">{counters.certExpired} certificat(s) expiré(s)</span>
              )}
              {counters.dnsFailed > 0 && (
                <span className="pub-counter is-critical">{counters.dnsFailed} échec(s) DNS</span>
              )}
              {counters.orphanCertificates > 0 && (
                <span className="pub-counter">{counters.orphanCertificates} certificat(s) sans route</span>
              )}
            </span>
            {caddyStatus?.httpsEnabled && (
              <a href={apiUrl("/reverse-proxy/ca-certificate")} className="btn btn-ghost btn-sm" download>
                Certificat racine (.pem)
              </a>
            )}
          </div>
        </section>

        {!authorityConfigured && configStatus === "ready" && (
          <div className="pub-note">
            <span>
              Autorité de certification AD CS non configurée : tous les sous-domaines sont servis par l'autorité interne
              de Caddy, non reconnue par les navigateurs (cadenas rouge).
            </span>
            <OpenSettingsButton />
          </div>
        )}

        <details className="pub-help">
          <summary>Ce que cette page fait — et ce qu'elle ne fait pas</summary>
          <p>
            <strong>La résolution DNS n'est pas garantie ici :</strong> un sous-domaine (ex :{" "}
            <code>monapp.lecreusot.priv</code>) doit être résolu vers l'hôte Docker qui exécute Caddy par le DNS interne
            de la mairie ou une entrée de fichier hosts. La colonne DNS reflète la mise à jour dynamique Active
            Directory quand elle est configurée ; « Manuel » signifie que cette résolution reste à votre charge.
          </p>
          <p>
            <strong>HTTPS :</strong> Caddy sert en HTTPS avec des certificats de sa propre autorité interne (jamais
            ACME/Let's Encrypt — ces noms ne sont pas résolubles publiquement). Le navigateur avertit tant que le
            certificat racine ci-dessus n'a pas été installé comme autorité de confiance sur le poste. Un certificat
            AD CS émis pour le sous-domaine remplace cet avertissement par un cadenas valide.
          </p>
        </details>

        {routesError && <div className="error-banner">{routesError}</div>}
        {certificatesError && <div className="error-banner">Certificats : {certificatesError}</div>}
        {issueError && <div className="error-banner">{issueError}</div>}
        {reconciliation?.lastError && <div className="error-banner">Réconciliation : {reconciliation.lastError}</div>}
        {lastOnDemand?.status === "failed" && (
          <div className="error-banner">
            Émission déclenchée par une publication ÉCHOUÉE : {lastOnDemand.subject}, le{" "}
            {formatDateTime(lastOnDemand.at)} — {lastOnDemand.message ?? "raison inconnue"}
          </div>
        )}
        {createError && <div className="error-banner">{createError}</div>}
        {createdSummary && !showForm && <div className="success-banner">{createdSummary}</div>}

        {showForm && operator && (
          <form className="card pub-form" onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="route-subdomain">Sous-domaine</label>
              <input
                id="route-subdomain"
                value={form.subdomain}
                onChange={(event) => setForm((f) => ({ ...f, subdomain: event.target.value }))}
                placeholder="ex : monapp.lecreusot.priv"
                disabled={creating}
                autoFocus
                required
              />
            </div>

            <div className="field">
              <label>Cible</label>
              <div style={{ display: "flex", gap: 16, fontSize: 13.5 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input
                    type="radio"
                    name="target-mode"
                    checked={targetMode === "container"}
                    onChange={() => setTargetMode("container")}
                    disabled={creating}
                  />
                  Conteneur en cours d'exécution
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input
                    type="radio"
                    name="target-mode"
                    checked={targetMode === "manual"}
                    onChange={() => setTargetMode("manual")}
                    disabled={creating}
                  />
                  Host:port manuel
                </label>
              </div>
            </div>

            {targetMode === "container" ? (
              <div className="field">
                <label htmlFor="route-container">Conteneur</label>
                <select
                  id="route-container"
                  value={form.targetContainerId}
                  onChange={(event) => setForm((f) => ({ ...f, targetContainerId: event.target.value }))}
                  disabled={creating}
                  required
                >
                  <option value="">— sélectionner —</option>
                  {runningContainers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.image})
                    </option>
                  ))}
                </select>
                {runningContainers.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    Aucun conteneur en cours d'exécution connu de QUAI.
                  </span>
                )}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="route-host">Host</label>
                <input
                  id="route-host"
                  value={form.targetHost}
                  onChange={(event) => setForm((f) => ({ ...f, targetHost: event.target.value }))}
                  placeholder="ex : 10.20.0.15 ou service.interne"
                  disabled={creating}
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="route-port">
                {targetMode === "container" ? "Port cible (laisser vide pour détecter automatiquement)" : "Port cible"}
              </label>
              <input
                id="route-port"
                type="number"
                min={1}
                max={65535}
                value={form.targetPort}
                onChange={(event) => setForm((f) => ({ ...f, targetPort: event.target.value }))}
                placeholder={targetMode === "container" ? "laisser vide : détecté sur le conteneur" : "ex : 8080"}
                disabled={creating}
                required={targetMode === "manual"}
              />
              {targetMode === "container" && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  Vide : QUAI inspecte le conteneur et retient son seul port TCP exposé, ou — s'il y en a plusieurs — le
                  premier des ports HTTP usuels (80, 8080, 8000, 3000, 5000), sinon le plus petit. Aucun port exposé :
                  la création échoue explicitement, jamais un port inventé.
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  creating ||
                  !form.subdomain.trim() ||
                  (targetMode === "container"
                    ? !form.targetContainerId
                    : !form.targetHost.trim() || !form.targetPort.trim())
                }
              >
                {creating ? "Publication…" : "Publier"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void handleCancelForm()}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {showForm && operator && authorityConfigured && (
          <div className="card pub-aside">
            <label htmlFor="cert-subject">Certificat seul, pour un sujet qui n'est pas publié ici</label>
            <div className="pub-aside__row">
              <input
                id="cert-subject"
                value={newSubject}
                onChange={(event) => setNewSubject(event.target.value)}
                placeholder="serveur.lecreusot.priv"
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={issuing || !newSubject.trim()}
                onClick={() => void handleIssueStandalone()}
              >
                {issuing ? "Demande…" : "Demander"}
              </button>
            </div>
          </div>
        )}

        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          loading={tableLoading}
          error={routesError}
          onRetry={handleRefresh}
          storageKey="publication"
          itemsLabel="services"
          defaultSort={{ key: "jours", direction: "asc" }}
          minWidth={980}
          emptyLabel="Aucun service publié, aucun certificat émis."
          noResultsLabel="Aucun service ne correspond à la recherche."
          searchPlaceholder="Rechercher…  (ex : certificat:expirant  dns:échec  jours:<15)"
          rowClassName={(row) => (row.cert === "expired" ? "certificates-row--expired" : undefined)}
        />
      </div>
    </div>
  );
}
