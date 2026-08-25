import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearExagridTestResult,
  disableExagrid,
  fetchExagridConfig,
  saveExagridConfig,
  testExagridConfig,
  type ExagridConfigFormInput,
} from "@/features/exagrid/exagridSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { MISSING, versionLabel } from "@/features/exagrid/exagridFormat";
import { IconCheck, IconStorageArray } from "@/components/icons";
import type {
  ExagridAuthProtocol,
  ExagridConfigStatus,
  ExagridPrivProtocol,
  ExagridSecurityLevel,
  ExagridSnmpVersion,
} from "@/types";

interface ExagridFormState {
  host: string;
  port: string;
  version: ExagridSnmpVersion;
  community: string;
  username: string;
  securityLevel: ExagridSecurityLevel;
  authProtocol: ExagridAuthProtocol;
  authKey: string;
  privProtocol: ExagridPrivProtocol;
  privKey: string;
}

/** Port SNMP standard (IANA) — seule valeur préremplie, aucune adresse ni identifiant. */
const DEFAULT_SNMP_PORT = "161";

const EMPTY_FORM: ExagridFormState = {
  host: "",
  port: DEFAULT_SNMP_PORT,
  version: "2c",
  community: "",
  username: "",
  securityLevel: "authPriv",
  authProtocol: "sha",
  authKey: "",
  privProtocol: "aes",
  privKey: "",
};

const SECURITY_LEVELS: { id: ExagridSecurityLevel; label: string }[] = [
  { id: "noAuthNoPriv", label: "Aucune authentification, aucun chiffrement" },
  { id: "authNoPriv", label: "Authentification, sans chiffrement" },
  { id: "authPriv", label: "Authentification et chiffrement" },
];

const AUTH_PROTOCOLS: { id: ExagridAuthProtocol; label: string }[] = [
  { id: "md5", label: "MD5" },
  { id: "sha", label: "SHA-1" },
  { id: "sha224", label: "SHA-224" },
  { id: "sha256", label: "SHA-256" },
  { id: "sha384", label: "SHA-384" },
  { id: "sha512", label: "SHA-512" },
];

const PRIV_PROTOCOLS: { id: ExagridPrivProtocol; label: string }[] = [
  { id: "des", label: "DES" },
  { id: "aes", label: "AES-128" },
  { id: "aes256b", label: "AES-256 (Blumenthal)" },
  { id: "aes256r", label: "AES-256 (Reeder)" },
];

function labelOf<T extends string>(options: { id: T; label: string }[], id?: T): string {
  return options.find((option) => option.id === id)?.label ?? MISSING;
}

/** Formulaire pré-rempli depuis la config enregistrée — jamais un secret (le serveur ne les rend pas). */
function formFromConfig(status: ExagridConfigStatus | null): ExagridFormState {
  const config = status?.config;
  if (!config) return EMPTY_FORM;
  return {
    ...EMPTY_FORM,
    host: config.host,
    port: String(config.port),
    version: config.version,
    username: config.username ?? "",
    securityLevel: config.securityLevel ?? EMPTY_FORM.securityLevel,
    authProtocol: config.authProtocol ?? EMPTY_FORM.authProtocol,
    privProtocol: config.privProtocol ?? EMPTY_FORM.privProtocol,
  };
}

/**
 * Formulaire d'accès SNMP à l'appliance ExaGrid, destiné à la page Réglages.
 * ExaGrid n'expose aucune API REST : la lecture se fait exclusivement en SNMP.
 */
export default function ExagridConnectionForm({ onSaved }: { onSaved?: () => void }) {
  const dispatch = useAppDispatch();
  const { configured, config, configLoad, configSaving, configError, clearing, testing, testResult, backendUnavailable } =
    useAppSelector((s) => s.exagrid);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ExagridFormState>(EMPTY_FORM);

  useEffect(() => {
    if (configLoad === "idle") dispatch(fetchExagridConfig());
  }, [dispatch, configLoad]);

  useEffect(() => {
    if (config?.config) setForm(formFromConfig(config));
  }, [config]);

  // Un secret vide ne vaut "conserver l'existant" que si la version SNMP enregistrée est celle du
  // formulaire — sinon il n'existe aucun secret à conserver.
  const canKeepSecrets = configured && config?.config?.version === form.version;
  const needsAuth = form.version === "3" && form.securityLevel !== "noAuthNoPriv";
  const needsPriv = form.version === "3" && form.securityLevel === "authPriv";

  function currentInput(): ExagridConfigFormInput | null {
    const host = form.host.trim();
    if (!host) return null;
    const portText = form.port.trim();
    let port: number | undefined;
    if (portText) {
      const parsed = Number(portText);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
      port = parsed;
    }
    const input: ExagridConfigFormInput = { host, version: form.version, ...(port !== undefined ? { port } : {}) };
    if (form.version === "2c") {
      const community = form.community.trim();
      if (!community && !canKeepSecrets) return null;
      return community ? { ...input, community } : input;
    }
    const username = form.username.trim();
    if (!username) return null;
    const authKey = form.authKey.trim();
    const privKey = form.privKey.trim();
    if (needsAuth && !authKey && !canKeepSecrets) return null;
    if (needsPriv && !privKey && !canKeepSecrets) return null;
    return {
      ...input,
      username,
      securityLevel: form.securityLevel,
      ...(needsAuth ? { authProtocol: form.authProtocol } : {}),
      ...(needsAuth && authKey ? { authKey } : {}),
      ...(needsPriv ? { privProtocol: form.privProtocol } : {}),
      ...(needsPriv && privKey ? { privKey } : {}),
    };
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearExagridTestResult());
    setForm(formFromConfig(config));
  }

  async function handleTest() {
    const input = currentInput();
    if (!input) return;
    await dispatch(testExagridConfig(input));
  }

  async function handleSave(event: FormEvent, trapsOnly = false) {
    event.preventDefault();
    const input = currentInput();
    if (!input) return;
    const result = await dispatch(saveExagridConfig(trapsOnly ? { ...input, trapsOnly: true } : input));
    if (saveExagridConfig.fulfilled.match(result)) {
      setEditing(false);
      dispatch(clearExagridTestResult());
      onSaved?.();
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration ExaGrid ?",
      description:
        "QUAI n'interrogera plus l'appliance de stockage en SNMP — occupation, files d'attente et alarme disparaîtront de la page Sauvegardes. Aucune donnée n'est modifiée sur l'appliance.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableExagrid());
    setForm(EMPTY_FORM);
    setEditing(false);
  }

  if (!admin) {
    return <div className="empty-state">Seul un administrateur peut configurer l'accès SNMP à l'appliance ExaGrid.</div>;
  }

  const showForm = editing || !configured;
  const valid = currentInput() !== null;
  const endpoint = config?.config;

  return (
    <section className="settings-form">
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Appliance de stockage (ExaGrid)</h3>
          <p>
            Interrogation SNMP de l'appliance ExaGrid, en lecture seule (ExaGrid n'expose pas d'API REST). La session
            SNMP est réellement testée avant l'enregistrement.
          </p>
        </div>
        {configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing || !valid}>
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                dispatch(clearExagridTestResult());
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

      {backendUnavailable && (
        <div className="exagrid-note" style={{ marginBottom: 16 }}>
          L'API ExaGrid ne répond pas encore sur ce serveur — l'enregistrement échouera tant que la route n'est pas
          déployée.
        </div>
      )}

      {configError && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {configError}
          {/* Cas réel : certaines versions d'ExaGrid n'exposent aucun agent interrogeable et ne
              font qu'émettre des traps — l'échec du test ne doit alors pas empêcher de déclarer
              l'appliance, sinon ses alarmes restent inexploitables. */}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={(event) => void handleSave(event, true)}>
              Enregistrer quand même, pour recevoir ses alarmes
            </button>
            <p className="create-container-hint" style={{ marginTop: 6 }}>
              À utiliser si l'appliance n'expose pas d'agent SNMP interrogeable : QUAI affichera les traps qu'elle
              envoie, mais aucune donnée de capacité, de déduplication ni de réplication.
            </p>
          </div>
        </div>
      )}

      {testResult && (
        <div className={testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {testResult.ok && <IconCheck />}
          {testResult.message}
        </div>
      )}

      {configLoad !== "loading" && configured && !editing && endpoint && (
        <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconStorageArray />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "Hôte", value: endpoint.host },
              { key: "Port", value: String(endpoint.port) },
              { key: "Version SNMP", value: versionLabel(endpoint.version) },
              ...(endpoint.version === "3"
                ? [
                    { key: "Utilisateur", value: endpoint.username ?? MISSING },
                    { key: "Niveau de sécurité", value: labelOf(SECURITY_LEVELS, endpoint.securityLevel) },
                    ...(endpoint.securityLevel !== "noAuthNoPriv"
                      ? [{ key: "Authentification", value: labelOf(AUTH_PROTOCOLS, endpoint.authProtocol) }]
                      : []),
                    ...(endpoint.securityLevel === "authPriv"
                      ? [{ key: "Chiffrement", value: labelOf(PRIV_PROTOCOLS, endpoint.privProtocol) }]
                      : []),
                  ]
                : []),
            ]}
          />
        </div>
      )}

      {showForm && (
        <form className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
          <div className="field">
            <label htmlFor="exagrid-host">Hôte de l'appliance</label>
            <input
              id="exagrid-host"
              value={form.host}
              onChange={(event) => setForm((f) => ({ ...f, host: event.target.value }))}
              placeholder="adresse IP ou nom DNS de l'appliance"
              disabled={configSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="exagrid-port">Port SNMP</label>
            <input
              id="exagrid-port"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => setForm((f) => ({ ...f, port: event.target.value }))}
              disabled={configSaving}
            />
          </div>
          <div className="field">
            <label htmlFor="exagrid-version">Version SNMP</label>
            <select
              id="exagrid-version"
              value={form.version}
              onChange={(event) => setForm((f) => ({ ...f, version: event.target.value as ExagridSnmpVersion }))}
              disabled={configSaving}
            >
              <option value="2c">v2c — community</option>
              <option value="3">v3 — utilisateur, authentification et chiffrement</option>
            </select>
          </div>

          {form.version === "2c" && (
            <div className="field">
              <label htmlFor="exagrid-community">
                Community{canKeepSecrets ? " (laisser vide pour conserver l'existante)" : ""}
              </label>
              <input
                id="exagrid-community"
                type="password"
                value={form.community}
                onChange={(event) => setForm((f) => ({ ...f, community: event.target.value }))}
                autoComplete="new-password"
                disabled={configSaving}
                {...(canKeepSecrets ? {} : { required: true })}
              />
            </div>
          )}

          {form.version === "3" && (
            <>
              <div className="field">
                <label htmlFor="exagrid-username">Utilisateur SNMPv3</label>
                <input
                  id="exagrid-username"
                  value={form.username}
                  onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
                  disabled={configSaving}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="exagrid-security-level">Niveau de sécurité</label>
                <select
                  id="exagrid-security-level"
                  value={form.securityLevel}
                  onChange={(event) =>
                    setForm((f) => ({ ...f, securityLevel: event.target.value as ExagridSecurityLevel }))
                  }
                  disabled={configSaving}
                >
                  {SECURITY_LEVELS.map((level) => (
                    <option key={level.id} value={level.id}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </div>
              {needsAuth && (
                <>
                  <div className="field">
                    <label htmlFor="exagrid-auth-protocol">Protocole d'authentification</label>
                    <select
                      id="exagrid-auth-protocol"
                      value={form.authProtocol}
                      onChange={(event) =>
                        setForm((f) => ({ ...f, authProtocol: event.target.value as ExagridAuthProtocol }))
                      }
                      disabled={configSaving}
                    >
                      {AUTH_PROTOCOLS.map((protocol) => (
                        <option key={protocol.id} value={protocol.id}>
                          {protocol.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="exagrid-auth-key">
                      Clé d'authentification{canKeepSecrets ? " (laisser vide pour conserver l'existante)" : ""}
                    </label>
                    <input
                      id="exagrid-auth-key"
                      type="password"
                      value={form.authKey}
                      onChange={(event) => setForm((f) => ({ ...f, authKey: event.target.value }))}
                      autoComplete="new-password"
                      disabled={configSaving}
                      {...(canKeepSecrets ? {} : { required: true })}
                    />
                  </div>
                </>
              )}
              {needsPriv && (
                <>
                  <div className="field">
                    <label htmlFor="exagrid-priv-protocol">Protocole de chiffrement</label>
                    <select
                      id="exagrid-priv-protocol"
                      value={form.privProtocol}
                      onChange={(event) =>
                        setForm((f) => ({ ...f, privProtocol: event.target.value as ExagridPrivProtocol }))
                      }
                      disabled={configSaving}
                    >
                      {PRIV_PROTOCOLS.map((protocol) => (
                        <option key={protocol.id} value={protocol.id}>
                          {protocol.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="exagrid-priv-key">
                      Clé de chiffrement{canKeepSecrets ? " (laisser vide pour conserver l'existante)" : ""}
                    </label>
                    <input
                      id="exagrid-priv-key"
                      type="password"
                      value={form.privKey}
                      onChange={(event) => setForm((f) => ({ ...f, privKey: event.target.value }))}
                      autoComplete="new-password"
                      disabled={configSaving}
                      {...(canKeepSecrets ? {} : { required: true })}
                    />
                  </div>
                </>
              )}
            </>
          )}

          <p className="exagrid-form-note">
            Community et clés SNMPv3 sont stockées chiffrées et ne sont jamais réaffichées.
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
    </section>
  );
}
