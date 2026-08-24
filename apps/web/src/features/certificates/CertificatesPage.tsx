import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearCertificatesIssueError,
  clearCertificatesTestResult,
  disableCertificates,
  fetchCertificates,
  fetchCertificatesConfig,
  forgetCertificate,
  issueCertificate,
  saveCertificatesConfig,
  testCertificatesConfig,
  type CertificateSummary,
  type CertificatesFormInput,
  type CertificatesState,
} from "@/features/certificates/certificatesSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck } from "@/components/icons";

const EMPTY_FORM: CertificatesFormInput = { caUrl: "", template: "WebServer", username: "", password: "" };
const MISSING = "—";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR");
}

/** Correspondance santé -> pastille : "expire bientôt" est un avertissement, pas une erreur. */
function healthPill(certificate: CertificateSummary) {
  if (certificate.health === "expired") return <StatusPill status="crit" label="Expiré" />;
  if (certificate.health === "expiring") return <StatusPill status="warn" label="Expire bientôt" />;
  return <StatusPill status="ok" label="Valide" />;
}

export default function CertificatesPage() {
  const dispatch = useAppDispatch();
  // Sélecteur typé localement (pas useAppSelector) : le reducer `certificates` n'est pas encore
  // déclaré dans store.ts — cette page compile donc indépendamment de son câblage.
  const { overview, status, error, configured, config, saving, clearing, testing, testResult, issuing, issueError } =
    useAppSelector((s) => s.certificates);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const operator = canOperate(session);
  const confirm = useConfirm();

  const [form, setForm] = useState<CertificatesFormInput>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [newSubject, setNewSubject] = useState("");

  useEffect(() => {
    dispatch(fetchCertificates());
    dispatch(fetchCertificatesConfig());
  }, [dispatch]);

  // Pré-remplit dès que la config effective arrive — jamais le mot de passe (écrit uniquement).
  useEffect(() => {
    if (config) {
      setForm({
        caUrl: config.caUrl,
        template: config.template,
        username: config.username,
        password: "",
        ...(config.renewBeforeDays !== undefined ? { renewBeforeDays: config.renewBeforeDays } : {}),
        autoEnroll: config.autoEnroll,
      });
    }
  }, [config]);

  const certificates = overview?.certificates ?? [];

  const columns = useMemo<DataTableColumn<CertificateSummary>[]>(
    () => [
      {
        key: "sujet",
        label: "Sujet",
        accessor: (row) => row.subject,
        className: "cell-primary",
        aliases: ["nom", "domaine"],
      },
      {
        key: "etat",
        label: "État",
        accessor: (row) => row.health,
        render: healthPill,
        values: ["valid", "expiring", "expired"],
        aliases: ["sante", "statut"],
      },
      {
        key: "jours",
        label: "Jours restants",
        accessor: (row) => row.daysRemaining,
        kind: "number",
        align: "right",
        render: (row) => (row.daysRemaining < 0 ? `expiré depuis ${Math.abs(row.daysRemaining)} j` : `${row.daysRemaining} j`),
      },
      {
        key: "expiration",
        label: "Expire le",
        accessor: (row) => row.notAfter,
        kind: "date",
        render: (row) => formatDate(row.notAfter),
      },
      {
        key: "renouvellement",
        label: "Renouvellement prévu",
        accessor: (row) => row.renewAt,
        kind: "date",
        render: (row) => formatDate(row.renewAt),
      },
      {
        key: "emetteur",
        label: "Autorité émettrice",
        accessor: (row) => row.issuer,
        className: "cell-mono",
        aliases: ["ca", "issuer"],
      },
      {
        key: "erreur",
        label: "Dernier échec",
        accessor: (row) => row.lastRenewalError ?? "",
        render: (row) =>
          row.lastRenewalError ? (
            <span className="certificates-error" title={row.lastRenewalError}>
              {row.lastRenewalError}
            </span>
          ) : (
            MISSING
          ),
      },
    ],
    [],
  );

  function currentInput(): CertificatesFormInput {
    return {
      caUrl: form.caUrl.trim(),
      template: form.template.trim(),
      username: form.username.trim(),
      ...(form.password?.trim() ? { password: form.password.trim() } : {}),
      ...(form.renewBeforeDays !== undefined ? { renewBeforeDays: Number(form.renewBeforeDays) } : {}),
      ...(form.autoEnroll !== undefined ? { autoEnroll: form.autoEnroll } : {}),
    };
  }

  function isFormValid(): boolean {
    const input = currentInput();
    const hasPassword = !!input.password || configured;
    return !!(input.caUrl && input.template && input.username && hasPassword);
  }

  function openForm() {
    dispatch(clearCertificatesTestResult());
    setEditing(true);
  }

  async function handleTest() {
    if (!isFormValid()) return;
    await dispatch(testCertificatesConfig(currentInput()));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(saveCertificatesConfig(currentInput()));
    if (saveCertificatesConfig.fulfilled.match(result)) {
      setEditing(false);
      dispatch(fetchCertificates());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer l'autorité de certification ?",
      description:
        "Les certificats déjà émis restent servis jusqu'à leur expiration — seuls l'émission et le renouvellement automatiques s'arrêtent. À l'expiration, les sous-domaines concernés repasseront sur l'autorité interne de Caddy (cadenas rouge).",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableCertificates());
    setForm(EMPTY_FORM);
    dispatch(fetchCertificates());
  }

  async function handleIssue(event: FormEvent) {
    event.preventDefault();
    const subject = newSubject.trim();
    if (!subject) return;
    const result = await dispatch(issueCertificate(subject));
    if (issueCertificate.fulfilled.match(result)) setNewSubject("");
  }

  async function handleRenew(subject: string) {
    dispatch(clearCertificatesIssueError());
    await dispatch(issueCertificate(subject));
  }

  async function handleForget(subject: string) {
    const ok = await confirm({
      title: `Oublier le certificat de ${subject} ?`,
      description:
        "Le sous-domaine repassera sur l'autorité interne de Caddy à la prochaine republication (cadenas rouge), sans coupure de service.",
      confirmLabel: "Oublier",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(forgetCertificate(subject));
    dispatch(fetchCertificates());
  }

  const showForm = editing || (admin && !configured);
  const reconciliation = overview?.reconciliation;
  const expiringCount = certificates.filter((certificate) => certificate.health === "expiring").length;
  const expiredCount = certificates.filter((certificate) => certificate.health === "expired").length;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Certificats</h2>
            <p>
              Certificats TLS obtenus automatiquement auprès de l'autorité interne AD CS de la mairie, dont la racine est
              déjà approuvée par les postes — c'est ce qui supprime le cadenas rouge. Les sous-domaines sans certificat AD
              CS restent servis par l'autorité interne de Caddy.
            </p>
          </div>
          {admin && configured && !editing && (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing}>
                {testing ? "Test en cours…" : "Tester l'autorité"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={openForm}>
                Modifier
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleDisable} disabled={clearing}>
                {clearing ? "Retrait…" : "Retirer"}
              </button>
            </div>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {issueError && <div className="error-banner">{issueError}</div>}
        {testResult && (
          <div className={testResult.ok ? "success-banner" : "error-banner"}>
            {testResult.ok ? <IconCheck /> : null} {testResult.message}
          </div>
        )}

        {!configured && status === "ready" && (
          <div className="empty-state">
            Autorité de certification AD CS non configurée : tous les sous-domaines sont servis par l'autorité interne de
            Caddy, non reconnue par les navigateurs.
          </div>
        )}

        {configured && (
          <div className="certificates-summary">
            <div className="stat-card">
              <span className="stat-card__label">Certificats gérés</span>
              <span className="stat-card__value">{certificates.length}</span>
            </div>
            <div className={`stat-card${expiringCount > 0 ? " certificates-stat--warn" : ""}`}>
              <span className="stat-card__label">Expirent bientôt</span>
              <span className="stat-card__value">{expiringCount}</span>
              <span className="stat-card__hint">marge de {overview?.renewBeforeDays ?? 30} jours</span>
            </div>
            <div className={`stat-card${expiredCount > 0 ? " certificates-stat--crit" : ""}`}>
              <span className="stat-card__label">Expirés</span>
              <span className="stat-card__value">{expiredCount}</span>
            </div>
          </div>
        )}

        {configured && reconciliation && (
          <div className="certificates-reconciliation">
            <StatusPill
              status={reconciliation.lastFailedSubjects.length > 0 ? "crit" : reconciliation.lastCheckAt ? "ok" : "warn"}
              label={
                reconciliation.lastCheckAt
                  ? `Dernière vérification le ${formatDateTime(reconciliation.lastCheckAt)}`
                  : "Aucune vérification depuis le démarrage"
              }
            />
            {reconciliation.lastRenewalAt && (
              <span className="certificates-reconciliation__hint">
                dernier renouvellement le {formatDateTime(reconciliation.lastRenewalAt)}
              </span>
            )}
            {reconciliation.lastError && <div className="error-banner">{reconciliation.lastError}</div>}
          </div>
        )}

        {configured && operator && (
          <form className="certificates-issue" onSubmit={handleIssue}>
            <input
              value={newSubject}
              onChange={(event) => setNewSubject(event.target.value)}
              placeholder="monapp.lecreusot.priv"
              aria-label="Sous-domaine pour lequel demander un certificat"
            />
            <button type="submit" className="btn btn-primary" disabled={issuing || !newSubject.trim()}>
              {issuing ? "Demande en cours…" : "Demander un certificat"}
            </button>
          </form>
        )}

        <DataTable
          rows={certificates}
          columns={columns}
          rowKey={(row) => row.id}
          loading={status === "loading"}
          storageKey="certificates"
          itemsLabel="certificats"
          defaultSort={{ key: "jours", direction: "asc" }}
          emptyLabel="Aucun certificat émis pour l'instant."
          noResultsLabel="Aucun certificat ne correspond à la recherche."
          searchPlaceholder="Rechercher…  (ex : etat:expiring sujet:monapp jours:<15)"
          rowClassName={(row) => (row.health === "expired" ? "certificates-row--expired" : undefined)}
          {...(operator
            ? {
                toolbarExtra: (
                  <span className="certificates-toolbar-hint">
                    Renouvellement automatique {overview?.renewBeforeDays ?? 30} jours avant expiration
                  </span>
                ),
              }
            : {})}
        />

        {operator && certificates.length > 0 && (
          <div className="certificates-actions">
            {certificates.map((certificate) => (
              <div key={certificate.id} className="certificates-actions__row">
                <span className="cell-mono">{certificate.subject}</span>
                <span className="certificates-actions__buttons">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleRenew(certificate.subject)} disabled={issuing}>
                    Renouveler
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleForget(certificate.subject)}>
                    Oublier
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {configured && !editing && config && (
          <div className="card certificates-config">
            <h3>Autorité de certification</h3>
            <KeyValueList
              rows={[
                { key: "Site d'inscription (certsrv)", value: config.caUrl },
                { key: "Voie d'inscription", value: "Inscription web certsrv (HTTPS + authentification de base)" },
                { key: "Modèle de certificat", value: config.template },
                { key: "Compte de service", value: config.username },
                { key: "Marge de renouvellement", value: `${config.renewBeforeDays ?? overview?.renewBeforeDays ?? 30} jours` },
                { key: "Émission automatique des sous-domaines", value: config.autoEnroll ? "activée" : "désactivée" },
              ]}
            />
          </div>
        )}

        {admin && showForm && (
          <form className="card certificates-config" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
            <h3>{configured ? "Modifier l'autorité" : "Configurer l'autorité AD CS"}</h3>
            <div className="field">
              <label htmlFor="certs-url">URL du site d'inscription web (certsrv)</label>
              <input
                id="certs-url"
                value={form.caUrl}
                onChange={(event) => setForm((f) => ({ ...f, caUrl: event.target.value }))}
                placeholder="https://ca.lecreusot.priv/certsrv"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="certs-template">Modèle de certificat</label>
              <input
                id="certs-template"
                value={form.template}
                onChange={(event) => setForm((f) => ({ ...f, template: event.target.value }))}
                placeholder="WebServer"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="certs-username">Compte de service (droit "Inscrire" sur le modèle)</label>
              <input
                id="certs-username"
                value={form.username}
                onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                placeholder="LECREUSOT\svc-quai-pki"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="certs-password">Mot de passe{configured ? " (laisser vide pour conserver l'existant)" : ""}</label>
              <input
                id="certs-password"
                type="password"
                value={form.password ?? ""}
                onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
                autoComplete="new-password"
                {...(configured ? {} : { required: true })}
              />
            </div>
            <div className="field">
              <label htmlFor="certs-renew">Renouveler combien de jours avant expiration</label>
              <input
                id="certs-renew"
                type="number"
                min={1}
                value={form.renewBeforeDays ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  // exactOptionalPropertyTypes : on OMET la clé plutôt que de l'assigner à undefined.
                  setForm((f) => {
                    const { renewBeforeDays: _cleared, ...rest } = f;
                    return raw ? { ...rest, renewBeforeDays: Number(raw) } : rest;
                  });
                }}
                placeholder="30"
              />
            </div>
            <label className="certificates-checkbox">
              <input
                type="checkbox"
                checked={form.autoEnroll ?? true}
                onChange={(event) => setForm((f) => ({ ...f, autoEnroll: event.target.checked }))}
              />
              Demander automatiquement un certificat pour chaque nouveau sous-domaine du reverse proxy
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving || !isFormValid()}>
                {saving ? "Enregistrement…" : "Enregistrer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing || !isFormValid()}>
                {testing ? "Test en cours…" : "Tester l'autorité"}
              </button>
              {configured && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setEditing(false);
                    dispatch(clearCertificatesTestResult());
                  }}
                >
                  Annuler
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
