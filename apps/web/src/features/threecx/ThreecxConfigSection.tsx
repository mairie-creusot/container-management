import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearThreecxTestResult,
  disableThreecx,
  fetchThreecxConfig,
  saveThreecxConfig,
  selectThreecx,
  testThreecxConfig,
  type ThreecxConfigFormInput,
} from "@/features/threecx/threecxSlice";
import type { ThreecxAuthMode, ThreecxPublicConfig } from "@/features/threecx/types";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck, IconServer } from "@/components/icons";

/** Valeur que le PBX n'a pas communiquée — jamais remplacée par 0. */
const MISSING = "—";

interface ThreecxFormState {
  baseUrl: string;
  authMode: ThreecxAuthMode;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  tlsRejectUnauthorized: boolean;
}

/** Vérification TLS active par défaut — c'est aussi le défaut du serveur (config.threecx). */
const EMPTY_FORM: ThreecxFormState = {
  baseUrl: "",
  authMode: "client-credentials",
  clientId: "",
  clientSecret: "",
  username: "",
  password: "",
  tlsRejectUnauthorized: true,
};

/** Formulaire pré-rempli depuis la config enregistrée — les secrets restent TOUJOURS vides,
 * l'API ne les renvoie jamais et un champ vide signifie « conserver l'existant ». */
function formFromConfig(config: ThreecxPublicConfig): ThreecxFormState {
  return {
    baseUrl: config.baseUrl,
    authMode: config.authMode,
    clientId: config.clientId ?? "",
    clientSecret: "",
    username: config.username ?? "",
    password: "",
    tlsRejectUnauthorized: config.tlsRejectUnauthorized ?? true,
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function formatCount(value: number | undefined, singular: string, plural: string): string {
  if (value === undefined) return MISSING;
  return `${value} ${value > 1 ? plural : singular}`;
}

/**
 * Accès en LECTURE SEULE au XAPI du PBX 3CX. Vivait dans la page Téléphonie ; extrait le
 * 24/08/2026 pour la page Réglages, SEULE source de vérité de ce formulaire.
 */
export default function ThreecxConfigSection() {
  const dispatch = useAppDispatch();
  const {
    configured,
    config,
    configLoad,
    configSaving,
    configError,
    clearing,
    testing,
    testResult,
    backendUnavailable,
  } = useAppSelector(selectThreecx);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ThreecxFormState>(EMPTY_FORM);

  useEffect(() => {
    if (configLoad === "idle") dispatch(fetchThreecxConfig());
  }, [dispatch, configLoad]);

  useEffect(() => {
    if (config) setForm(formFromConfig(config));
  }, [config]);

  // Un secret vide = conserver l'existant ; impossible s'il n'y a rien à conserver, ou si le mode
  // enregistré n'est pas celui qu'on soumet (l'autre mode n'a jamais eu de secret enregistré).
  const keepsSecret = configured && config?.authMode === form.authMode;

  function currentInput(): ThreecxConfigFormInput | null {
    const baseUrl = form.baseUrl.trim();
    if (!isHttpUrl(baseUrl)) return null;

    if (form.authMode === "user") {
      const username = form.username.trim();
      const password = form.password.trim();
      if (!username) return null;
      if (!password && !keepsSecret) return null;
      return {
        baseUrl,
        authMode: "user",
        username,
        tlsRejectUnauthorized: form.tlsRejectUnauthorized,
        ...(password ? { password } : {}),
      };
    }

    const clientId = form.clientId.trim();
    const clientSecret = form.clientSecret.trim();
    if (!clientId) return null;
    if (!clientSecret && !keepsSecret) return null;
    return {
      baseUrl,
      authMode: "client-credentials",
      clientId,
      tlsRejectUnauthorized: form.tlsRejectUnauthorized,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  function openForm() {
    dispatch(clearThreecxTestResult());
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearThreecxTestResult());
    setForm(config ? formFromConfig(config) : EMPTY_FORM);
  }

  async function handleTest() {
    const input = currentInput();
    if (!input) return;
    await dispatch(testThreecxConfig(input));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const input = currentInput();
    if (!input) return;
    const result = await dispatch(saveThreecxConfig(input));
    if (saveThreecxConfig.fulfilled.match(result)) {
      setEditing(false);
      setForm((f) => ({ ...f, clientSecret: "", password: "" }));
      dispatch(clearThreecxTestResult());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration 3CX ?",
      description:
        "QUAI n'interrogera plus le PBX : appels en cours, postes et files d'attente disparaîtront de la page Téléphonie. Les identifiants enregistrés (clé API ou mot de passe) sont effacés. Aucun réglage n'est modifié sur le PBX.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableThreecx());
    setForm(EMPTY_FORM);
    setEditing(false);
  }

  const showForm = editing || !configured;
  const valid = currentInput() !== null;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Téléphonie 3CX</h3>
          <p>
            Accès en LECTURE SEULE au XAPI du PBX 3CX, au choix par ClientID + clé API ou par identifiant et mot de
            passe. La connexion est réellement testée dans le mode choisi avant l'enregistrement — jamais persistée à
            l'aveugle.
          </p>
        </div>
        {configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing || !valid}>
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

      {backendUnavailable && (
        <div className="threecx-note" style={{ marginBottom: 16 }}>
          L'API 3CX ne répond pas sur ce serveur — l'enregistrement échouera tant que les routes ne sont pas déployées.
        </div>
      )}

      {configError && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {configError}
        </div>
      )}

      {testResult && (
        <div className={testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {testResult.ok && <IconCheck />}
          {testResult.message}
          {testResult.ok &&
            testResult.activeCallCount !== undefined &&
            ` — ${formatCount(testResult.activeCallCount, "appel en cours", "appels en cours")}`}
        </div>
      )}

      {configLoad !== "loading" && configured && !editing && config && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconServer />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL du PBX", value: config.baseUrl },
              {
                key: "Mode d'authentification",
                value:
                  config.authMode === "user"
                    ? "Identifiant et mot de passe (extension propriétaire système)"
                    : "ClientID et clé API (point de routage)",
              },
              ...(config.authMode === "user"
                ? [
                    { key: "Identifiant", value: config.username ?? MISSING },
                    { key: "Mot de passe", value: "Enregistré et chiffré — jamais réaffiché" },
                  ]
                : [
                    { key: "ClientID (DN du point de routage)", value: config.clientId ?? MISSING },
                    { key: "Clé API", value: "Enregistrée et chiffrée — jamais réaffichée" },
                  ]),
              {
                key: "Vérification du certificat TLS",
                value:
                  config.tlsRejectUnauthorized === undefined
                    ? "Valeur par défaut du serveur"
                    : config.tlsRejectUnauthorized
                      ? "Activée"
                      : "Désactivée",
              },
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
            <label htmlFor="threecx-base-url">URL de base du PBX</label>
            <input
              id="threecx-base-url"
              value={form.baseUrl}
              onChange={(event) => setForm((f) => ({ ...f, baseUrl: event.target.value }))}
              placeholder="https://pbx.exemple.fr:5001"
              disabled={configSaving}
              required
            />
            <span className="threecx-field-hint">
              Adresse du PBX sans le suffixe /xapi/v1 — QUAI l'ajoute lui-même, ainsi que le chemin
              d'authentification.
            </span>
          </div>

          <fieldset className="threecx-authmode" disabled={configSaving}>
            <legend>Comment QUAI s'authentifie auprès du PBX</legend>
            <label className="threecx-authmode__choice">
              <input
                type="radio"
                name="threecx-auth-mode"
                value="client-credentials"
                checked={form.authMode === "client-credentials"}
                onChange={() => setForm((f) => ({ ...f, authMode: "client-credentials" }))}
              />
              <span>
                ClientID et clé API
                <span className="threecx-field-hint">
                  Point de routage créé dans Admin Console → Integrations &gt; API.
                </span>
              </span>
            </label>
            <label className="threecx-authmode__choice">
              <input
                type="radio"
                name="threecx-auth-mode"
                value="user"
                checked={form.authMode === "user"}
                onChange={() => setForm((f) => ({ ...f, authMode: "user" }))}
              />
              <span>
                Identifiant et mot de passe
                <span className="threecx-field-hint">
                  Extension du PBX disposant des droits d'administration système.
                </span>
              </span>
            </label>
          </fieldset>

          {form.authMode === "user" ? (
            <>
              <p className="threecx-form-help">
                Ce mode existe parce que l'entrée <strong>Intégrations → API</strong> n'est pas disponible sur tous les
                builds et toutes les licences 3CX : sans elle, aucun ClientID ni aucune clé API ne peut être créé. QUAI
                s'authentifie alors comme le fait le client web du PBX, avec l'identifiant et le mot de passe d'une{" "}
                <strong>extension disposant des droits propriétaire système</strong> — un compte sans ces droits
                obtiendra peut-être un jeton, mais le PBX refusera les requêtes XAPI. Le XAPI reste soumis à une{" "}
                <strong>licence 3CX Enterprise</strong>.
              </p>

              <div className="field">
                <label htmlFor="threecx-username">Identifiant (extension avec droits propriétaire système)</label>
                <input
                  id="threecx-username"
                  value={form.username}
                  onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                  disabled={configSaving}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="threecx-password">
                  Mot de passe{keepsSecret ? " (laisser vide pour conserver l'existant)" : ""}
                </label>
                <input
                  id="threecx-password"
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
                  autoComplete="new-password"
                  disabled={configSaving}
                  {...(keepsSecret ? {} : { required: true })}
                />
              </div>
            </>
          ) : (
            <>
              <p className="threecx-form-help">
                Ces identifiants se créent dans la console d'administration du PBX : <strong>Admin Console →
                Integrations &gt; API</strong>, sur un point de routage dont l'option «&nbsp;XAPI Access
                Enabled&nbsp;» est activée. Le ClientID est le <strong>DN de ce point de routage</strong> et la clé API
                n'est affichée qu'une seule fois à sa création. Le XAPI n'est disponible qu'avec une{" "}
                <strong>licence 3CX Enterprise</strong> : sans elle, le PBX répond mais refuse chaque requête.
              </p>

              <div className="field">
                <label htmlFor="threecx-client-id">ClientID — DN du point de routage</label>
                <input
                  id="threecx-client-id"
                  value={form.clientId}
                  onChange={(event) => setForm((f) => ({ ...f, clientId: event.target.value }))}
                  disabled={configSaving}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="threecx-client-secret">
                  Clé API{keepsSecret ? " (laisser vide pour conserver l'existante)" : ""}
                </label>
                <input
                  id="threecx-client-secret"
                  type="password"
                  value={form.clientSecret}
                  onChange={(event) => setForm((f) => ({ ...f, clientSecret: event.target.value }))}
                  autoComplete="new-password"
                  disabled={configSaving}
                  {...(keepsSecret ? {} : { required: true })}
                />
              </div>
            </>
          )}

          <label className="threecx-checkbox" htmlFor="threecx-tls">
            <input
              id="threecx-tls"
              type="checkbox"
              checked={form.tlsRejectUnauthorized}
              onChange={(event) => setForm((f) => ({ ...f, tlsRejectUnauthorized: event.target.checked }))}
              disabled={configSaving}
            />
            <span>
              Vérifier le certificat TLS du PBX
              <span className="threecx-field-hint">
                À laisser activé : un 3CX publié sous son FQDN présente un certificat valide. Ne le désactivez que pour
                un PBX joint par une adresse interne avec un certificat auto-signé.
              </span>
            </span>
          </label>

          <p className="threecx-form-note">
            {form.authMode === "user"
              ? "Le mot de passe est stocké chiffré et n'est jamais renvoyé par l'API, même tronqué — ni journalisé, ni repris dans un message d'erreur."
              : "La clé API est stockée chiffrée et n'est jamais renvoyée par l'API, même tronquée."}
          </p>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={configSaving || !valid}>
              {configSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleTest}
              disabled={configSaving || testing || !valid}
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
