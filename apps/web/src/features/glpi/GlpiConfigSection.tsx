import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck, IconKey } from "@/components/icons";
import {
  clearGlpiTestResult,
  disableGlpi,
  fetchGlpiConfig,
  fetchGlpiSearchOptions,
  saveGlpiConfig,
  selectGlpiState,
  testGlpiConfig,
} from "@/features/glpi/glpiSlice";
import { MISSING } from "@/features/glpi/format";
import type { GlpiAuthMode, GlpiConfigFormInput, GlpiConfigStatus } from "@/features/glpi/types";

interface GlpiFormState {
  apiUrl: string;
  appToken: string;
  authMode: GlpiAuthMode;
  userToken: string;
  username: string;
  password: string;
}

const EMPTY_FORM: GlpiFormState = {
  apiUrl: "",
  appToken: "",
  authMode: "user-token",
  userToken: "",
  username: "",
  password: "",
};

/** Numéros d'options de recherche de Ticket interrogés par apps/api/src/services/glpi.ts
 * (TICKET_SEARCH_OPTION) — supposés du cœur GLPI, à confirmer sur CETTE instance. */
const EXPECTED_TICKET_OPTIONS: { option: string; role: string }[] = [
  { option: "1", role: "Titre du ticket" },
  { option: "2", role: "Identifiant du ticket" },
  { option: "4", role: "Demandeur" },
  { option: "12", role: "Statut" },
  { option: "15", role: "Date d'ouverture" },
  { option: "19", role: "Dernière mise à jour" },
  { option: "21", role: "Contenu" },
];

function formFromConfig(status: GlpiConfigStatus | null): GlpiFormState {
  const config = status?.config;
  if (!config) return EMPTY_FORM;
  return {
    ...EMPTY_FORM,
    apiUrl: config.apiUrl,
    authMode: config.authMode,
    username: config.username ?? "",
  };
}

function SearchOptionsPanel() {
  const dispatch = useAppDispatch();
  const { searchOptions, searchOptionsLoading, searchOptionsError, configured } = useAppSelector(selectGlpiState);

  return (
    <div className="glpi-search-options">
      <div className="glpi-search-options__head">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void dispatch(fetchGlpiSearchOptions())}
          disabled={searchOptionsLoading || !configured}
        >
          {searchOptionsLoading ? "Lecture…" : "Vérifier les options de recherche"}
        </button>
        <span className="glpi-note">
          QUAI interroge les tickets par NUMÉRO d'option de recherche. Ces numéros sont ceux du cœur GLPI : ce bouton
          lit les options réelles de cette instance pour confirmer qu'ils y désignent bien les mêmes champs.
        </span>
      </div>

      {searchOptionsError && <div className="error-banner">{searchOptionsError}</div>}

      {searchOptions && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Rôle attendu par QUAI</th>
                <th>N° d'option</th>
                <th>Champ déclaré par cette instance</th>
              </tr>
            </thead>
            <tbody>
              {EXPECTED_TICKET_OPTIONS.map((expected) => {
                const actual = searchOptions.find((option) => option.option === expected.option);
                return (
                  <tr key={expected.option}>
                    <td>{expected.role}</td>
                    <td className="cell-mono">{expected.option}</td>
                    <td>
                      {actual ? (
                        <>
                          {actual.name ?? MISSING}
                          {actual.uid ? ` (${actual.uid})` : ""}
                          {!actual.uid && actual.table && actual.field ? ` (${actual.table}.${actual.field})` : ""}
                        </>
                      ) : (
                        <span className="glpi-item__denied">
                          Cette instance ne déclare aucune option n° {expected.option} pour Ticket.
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {searchOptions && (
        <p className="glpi-note">
          {searchOptions.length} options de recherche déclarées au total par cette instance pour l'objet Ticket.
        </p>
      )}
    </div>
  );
}

export default function GlpiConfigSection() {
  const { configured, config, configLoad, configSaving, configError, clearing, testing, testResult, backendUnavailable } =
    useAppSelector(selectGlpiState);
  const dispatch = useAppDispatch();
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<GlpiFormState>(EMPTY_FORM);

  useEffect(() => {
    if (configLoad === "idle") dispatch(fetchGlpiConfig());
  }, [dispatch, configLoad]);

  useEffect(() => {
    if (config?.config) setForm(formFromConfig(config));
  }, [config]);

  const saved = config?.config;
  const canKeepAppToken = saved?.hasAppToken === true;
  const canKeepUserToken = saved?.hasUserToken === true;
  const canKeepPassword = saved?.hasPassword === true;
  // mergeCandidate côté API donne la priorité au user_token enregistré : tant qu'il existe, un
  // couple login/mot de passe envoyé ne changera pas le mode d'authentification.
  const blockedByStoredUserToken = form.authMode === "credentials" && canKeepUserToken;

  function currentInput(): GlpiConfigFormInput | null {
    const apiUrl = form.apiUrl.trim();
    if (!apiUrl) return null;
    const appToken = form.appToken.trim();
    if (!appToken && !canKeepAppToken) return null;

    const base: GlpiConfigFormInput = { apiUrl, ...(appToken ? { appToken } : {}) };
    if (form.authMode === "user-token") {
      const userToken = form.userToken.trim();
      if (!userToken && !canKeepUserToken) return null;
      return userToken ? { ...base, userToken } : base;
    }
    const username = form.username.trim();
    const password = form.password.trim();
    if (!username) return null;
    if (!password && !canKeepPassword) return null;
    return { ...base, username, ...(password ? { password } : {}) };
  }

  function openForm() {
    dispatch(clearGlpiTestResult());
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearGlpiTestResult());
    setForm(formFromConfig(config));
  }

  async function handleTest() {
    const input = currentInput();
    if (!input) return;
    await dispatch(testGlpiConfig(input));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const input = currentInput();
    if (!input) return;
    const result = await dispatch(saveGlpiConfig(input));
    if (saveGlpiConfig.fulfilled.match(result)) {
      setEditing(false);
      setForm((previous) => ({ ...previous, appToken: "", userToken: "", password: "" }));
      dispatch(clearGlpiTestResult());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration GLPI ?",
      description:
        "QUAI n'interrogera plus GLPI : ni vos tickets, ni la réconciliation d'inventaire ne seront disponibles. Aucune donnée n'est modifiée dans GLPI.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableGlpi());
    setForm(EMPTY_FORM);
    setEditing(false);
  }

  const showForm = editing || !configured;
  const valid = currentInput() !== null;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Configuration</h3>
          <p>
            Accès à l'API REST de GLPI (apirest.php). La connexion est réellement ouverte puis refermée avant tout
            enregistrement : une configuration qui ne fonctionne pas n'est jamais persistée.
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
        <div className="glpi-note" style={{ marginBottom: 16 }}>
          L'API GLPI ne répond pas sur ce serveur — l'enregistrement échouera tant que la route n'est pas déployée.
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
        </div>
      )}

      {configLoad !== "loading" && configured && !editing && saved && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconKey />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL de l'API", value: saved.apiUrl },
              {
                key: "Authentification",
                value: saved.authMode === "user-token" ? "Jeton utilisateur (user_token)" : "Compte de service (login/mot de passe)",
              },
              ...(saved.authMode === "credentials" ? [{ key: "Compte de service", value: saved.username ?? MISSING }] : []),
              { key: "app_token enregistré", value: saved.hasAppToken ? "oui" : "non" },
              { key: "user_token enregistré", value: saved.hasUserToken ? "oui" : "non" },
              { key: "Mot de passe enregistré", value: saved.hasPassword ? "oui" : "non" },
            ]}
          />
          <p className="glpi-note">
            Les jetons et mots de passe sont stockés chiffrés et ne sont jamais réaffichés, même tronqués.
          </p>
        </div>
      )}

      {showForm && (
        <form
          className="card"
          style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={handleSave}
        >
          <div className="field">
            <label htmlFor="glpi-api-url">URL de l'API GLPI</label>
            <input
              id="glpi-api-url"
              value={form.apiUrl}
              onChange={(event) => setForm((f) => ({ ...f, apiUrl: event.target.value }))}
              placeholder="http://serveur-glpi/apirest.php"
              disabled={configSaving}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="glpi-app-token">
              app_token{canKeepAppToken ? " (laisser vide pour conserver l'existant)" : ""}
            </label>
            <input
              id="glpi-app-token"
              type="password"
              value={form.appToken}
              onChange={(event) => setForm((f) => ({ ...f, appToken: event.target.value }))}
              autoComplete="new-password"
              disabled={configSaving}
              {...(canKeepAppToken ? {} : { required: true })}
            />
          </div>

          <div className="field">
            <label htmlFor="glpi-auth-mode">Mode d'authentification</label>
            <select
              id="glpi-auth-mode"
              value={form.authMode}
              onChange={(event) => setForm((f) => ({ ...f, authMode: event.target.value as GlpiAuthMode }))}
              disabled={configSaving}
            >
              <option value="user-token">Jeton utilisateur (user_token)</option>
              <option value="credentials">Compte de service (login et mot de passe)</option>
            </select>
          </div>

          {form.authMode === "user-token" && (
            <div className="field">
              <label htmlFor="glpi-user-token">
                user_token{canKeepUserToken ? " (laisser vide pour conserver l'existant)" : ""}
              </label>
              <input
                id="glpi-user-token"
                type="password"
                value={form.userToken}
                onChange={(event) => setForm((f) => ({ ...f, userToken: event.target.value }))}
                autoComplete="new-password"
                disabled={configSaving}
                {...(canKeepUserToken ? {} : { required: true })}
              />
            </div>
          )}

          {form.authMode === "credentials" && (
            <>
              <div className="field">
                <label htmlFor="glpi-username">Compte de service GLPI</label>
                <input
                  id="glpi-username"
                  value={form.username}
                  onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                  autoComplete="off"
                  disabled={configSaving}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="glpi-password">
                  Mot de passe{canKeepPassword ? " (laisser vide pour conserver l'existant)" : ""}
                </label>
                <input
                  id="glpi-password"
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
                  autoComplete="new-password"
                  disabled={configSaving}
                  {...(canKeepPassword ? {} : { required: true })}
                />
              </div>
              {blockedByStoredUserToken && (
                <p className="glpi-note">
                  Un user_token est déjà enregistré et l'API lui donne la priorité : le compte de service ne prendra
                  effet qu'après avoir retiré la configuration actuelle.
                </p>
              )}
            </>
          )}

          <p className="glpi-note">
            QUAI n'invente aucun identifiant : l'app_token et le jeton (ou le compte de service) doivent provenir de
            l'administration GLPI. Ils sont stockés chiffrés et ne sont jamais réaffichés.
          </p>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={configSaving || !valid}>
              {configSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={configSaving || testing || !valid}>
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

      <SearchOptionsPanel />
    </>
  );
}
