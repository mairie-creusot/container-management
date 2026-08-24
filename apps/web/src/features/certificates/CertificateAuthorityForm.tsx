import { useEffect, useState, type FormEvent } from "react";

import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearCertificatesTestResult,
  disableCertificates,
  fetchCertificates,
  fetchCertificatesConfig,
  saveCertificatesConfig,
  testCertificatesConfig,
  type CertificateAccountSource,
  type CertificatesFormInput,
  type EnrollmentAccountView,
} from "@/features/certificates/certificatesSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck } from "@/components/icons";

// Par défaut on essaie le compte déjà enregistré dans l'annuaire : aucun compte dédié à saisir.
const EMPTY_FORM: CertificatesFormInput = { caUrl: "", template: "WebServer", accountSource: "directory" };
const MISSING = "—";

/** Rappel du compte réellement présenté à l'autorité — jamais un mot de passe. */
export function accountRecap(account: EnrollmentAccountView | undefined): string {
  if (!account) return MISSING;
  if (account.problem) return account.problem;
  const origin = account.source === "dedicated" ? "compte dédié" : "compte de l'annuaire";
  return `${account.username ?? MISSING} (${origin} — ${account.how})`;
}

/**
 * Formulaire de connexion à l'autorité de certification AD CS, destiné à la page Réglages.
 * Aucune page métier ne le monte : la page Publication n'affiche que l'état et les données.
 */
export default function CertificateAuthorityForm({ onSaved }: { onSaved?: () => void }) {
  const dispatch = useAppDispatch();
  const { overview, configured, config, configStatus, accountHint, saving, clearing, testing, testResult, error } =
    useAppSelector((s) => s.certificates);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [form, setForm] = useState<CertificatesFormInput>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (configStatus === "idle") dispatch(fetchCertificatesConfig());
  }, [dispatch, configStatus]);

  // Pré-remplit dès que la config effective arrive — jamais le mot de passe (écrit uniquement).
  useEffect(() => {
    if (config) {
      setForm({
        caUrl: config.caUrl,
        template: config.template,
        accountSource: config.accountSource,
        ...(config.username ? { username: config.username } : {}),
        password: "",
        ...(config.renewBeforeDays !== undefined ? { renewBeforeDays: config.renewBeforeDays } : {}),
        autoEnroll: config.autoEnroll,
      });
    }
  }, [config]);

  function currentInput(): CertificatesFormInput {
    const dedicated = form.accountSource === "dedicated";
    return {
      caUrl: form.caUrl.trim(),
      template: form.template.trim(),
      accountSource: form.accountSource,
      ...(form.username?.trim() ? { username: form.username.trim() } : {}),
      // Aucun mot de passe n'est envoyé pour le compte de l'annuaire : c'est celui du bind LDAP.
      ...(dedicated && form.password?.trim() ? { password: form.password.trim() } : {}),
      ...(form.renewBeforeDays !== undefined ? { renewBeforeDays: Number(form.renewBeforeDays) } : {}),
      ...(form.autoEnroll !== undefined ? { autoEnroll: form.autoEnroll } : {}),
    };
  }

  function isFormValid(): boolean {
    const input = currentInput();
    if (!input.caUrl || !input.template) return false;
    if (input.accountSource !== "dedicated") return true;
    const keepsExistingPassword = configured && config?.accountSource === "dedicated";
    return !!(input.username && (input.password || keepsExistingPassword));
  }

  function setAccountSource(accountSource: CertificateAccountSource) {
    dispatch(clearCertificatesTestResult());
    // Changer de mode ne traîne jamais l'identifiant ni le mot de passe de l'autre mode.
    setForm((f) => ({ ...f, accountSource, username: "", password: "" }));
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
      onSaved?.();
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
    setEditing(false);
    dispatch(fetchCertificates());
  }

  if (!admin) {
    return (
      <div className="empty-state">Seul un administrateur peut configurer l'autorité de certification AD CS.</div>
    );
  }

  const showForm = editing || !configured;
  const resolvedAccount = accountHint ?? config?.account ?? overview?.account;
  // Le champ identifiant n'apparaît que lorsqu'il est réellement nécessaire : quand le backend a
  // dit ne pas pouvoir déduire l'identifiant Windows du compte de l'annuaire.
  const needsDirectoryUsername = !!resolvedAccount?.problem;
  const keepsDedicatedPassword = configured && config?.accountSource === "dedicated";

  return (
    <section className="settings-form">
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Autorité de certification (AD CS)</h3>
          <p>
            Inscription web <code>certsrv</code> de l'autorité interne de la mairie, dont la racine est déjà approuvée
            par les postes — c'est elle qui supprime le cadenas rouge sur les sous-domaines publiés.
          </p>
        </div>
        {configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? "Test en cours…" : "Tester l'autorité"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                dispatch(clearCertificatesTestResult());
                setEditing(true);
              }}
            >
              Modifier
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable} disabled={clearing}>
              {clearing ? "Retrait…" : "Retirer"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {testResult && (
        <div className={testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {testResult.ok ? <IconCheck /> : null} {testResult.message}
        </div>
      )}

      {configured && !editing && config && (
        <div className="card" style={{ marginBottom: 16 }}>
          <KeyValueList
            rows={[
              { key: "Site d'inscription (certsrv)", value: config.caUrl },
              { key: "Voie d'inscription", value: "Inscription web certsrv (HTTPS + authentification de base)" },
              { key: "Modèle de certificat", value: config.template },
              {
                key: "Compte utilisé",
                value: config.accountSource === "dedicated" ? "Compte dédié" : "Compte de l'annuaire (par défaut)",
              },
              { key: "Identifiant présenté à l'autorité", value: accountRecap(resolvedAccount) },
              {
                key: "Marge de renouvellement",
                value: `${config.renewBeforeDays ?? overview?.renewBeforeDays ?? 30} jours`,
              },
              { key: "Émission automatique des sous-domaines", value: config.autoEnroll ? "activée" : "désactivée" },
            ]}
          />
          {resolvedAccount?.problem && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              {resolvedAccount.problem}
            </div>
          )}
        </div>
      )}

      {showForm && (
        <form className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
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
          <fieldset className="certificates-account">
            <legend>Compte présenté à l'autorité</legend>
            <label className="certificates-account__choice">
              <input
                type="radio"
                name="certs-account-source"
                checked={form.accountSource === "directory"}
                onChange={() => setAccountSource("directory")}
              />
              <span>
                Utiliser le compte de l'annuaire (par défaut)
                <small>
                  Le compte de connexion LDAP déjà enregistré. Rien à saisir : son mot de passe est réutilisé tel quel.
                </small>
              </span>
            </label>
            <label className="certificates-account__choice">
              <input
                type="radio"
                name="certs-account-source"
                checked={form.accountSource === "dedicated"}
                onChange={() => setAccountSource("dedicated")}
              />
              <span>
                Utiliser un compte dédié
                <small>À réserver au cas où l'autorité refuse le compte de l'annuaire faute de droit « Inscrire ».</small>
              </span>
            </label>

            {form.accountSource === "directory" && resolvedAccount && (
              <p
                className={`certificates-account__recap${resolvedAccount.problem ? " certificates-account__recap--problem" : ""}`}
              >
                Identifiant qui sera présenté : {accountRecap(resolvedAccount)}
              </p>
            )}

            {/* Le CN de l'annuaire n'est pas toujours un identifiant Windows : on le dit et on le
                laisse saisir plutôt que de le deviner. */}
            {form.accountSource === "directory" && (needsDirectoryUsername || !!form.username?.trim()) && (
              <div className="field">
                <label htmlFor="certs-directory-username">Identifiant Windows du compte de l'annuaire</label>
                <input
                  id="certs-directory-username"
                  value={form.username ?? ""}
                  onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                  placeholder="LECREUSOT\copieurnt"
                  autoComplete="off"
                />
              </div>
            )}

            {form.accountSource === "dedicated" && (
              <>
                <div className="field">
                  <label htmlFor="certs-username">Compte dédié (droit « Inscrire » sur le modèle)</label>
                  <input
                    id="certs-username"
                    value={form.username ?? ""}
                    onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                    placeholder="LECREUSOT\svc-quai-pki"
                    autoComplete="off"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="certs-password">
                    Mot de passe{keepsDedicatedPassword ? " (laisser vide pour conserver l'existant)" : ""}
                  </label>
                  <input
                    id="certs-password"
                    type="password"
                    value={form.password ?? ""}
                    onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
                    autoComplete="new-password"
                    {...(keepsDedicatedPassword ? {} : { required: true })}
                  />
                </div>
              </>
            )}
          </fieldset>
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
            Demander automatiquement un certificat pour chaque nouveau sous-domaine publié
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
    </section>
  );
}
