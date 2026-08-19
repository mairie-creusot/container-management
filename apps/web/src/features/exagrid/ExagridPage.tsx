import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearExagridTestResult,
  disableExagrid,
  fetchExagridConfig,
  fetchExagridStatus,
  saveExagridConfig,
  testExagridConfig,
  type ExagridConfigFormInput,
} from "@/features/exagrid/exagridSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck, IconStorageArray } from "@/components/icons";
import type {
  ExagridAlarm,
  ExagridAuthProtocol,
  ExagridCapacityZone,
  ExagridConfigStatus,
  ExagridPrivProtocol,
  ExagridSecurityLevel,
  ExagridSnmpVersion,
} from "@/types";

/** Valeur absente de la réponse SNMP — affichée telle quelle, JAMAIS remplacée par 0. */
const MISSING = "—";

const BYTE_UNITS = ["o", "Kio", "Mio", "Gio", "Tio", "Pio"];

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return MISSING;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 2;
  return `${value.toFixed(decimals).replace(".", ",")} ${BYTE_UNITS[unit] ?? "o"}`;
}

function formatPercent(percent?: number): string {
  return percent === undefined || !Number.isFinite(percent) ? MISSING : `${percent.toFixed(1).replace(".", ",")} %`;
}

function formatAge(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return MISSING;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

// Seuils d'ALERTE VISUELLE QUAI sur l'ancienneté d'une file d'attente (la MIB ne publie aucun
// seuil) — la valeur exacte reste affichée à côté.
const AGE_WARNING_SECONDS = 24 * 3600;
const AGE_CRITICAL_SECONDS = 72 * 3600;

function ageSeverityClass(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds >= AGE_CRITICAL_SECONDS) return " is-critical";
  if (seconds >= AGE_WARNING_SECONDS) return " is-warning";
  return "";
}

function usageSeverityClass(percent?: number): string {
  if (percent === undefined || !Number.isFinite(percent)) return "";
  if (percent >= 90) return " is-critical";
  if (percent >= 75) return " is-warning";
  return "";
}

function ExagridMeter({ label, zone }: { label: string; zone?: ExagridCapacityZone | undefined }) {
  const percent = zone?.usedPct;
  const known = percent !== undefined && Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;
  const foot =
    zone?.configuredBytes === undefined && zone?.availableBytes === undefined
      ? "Volumes non communiqués par la MIB"
      : `${formatBytes(zone?.availableBytes)} disponibles sur ${formatBytes(zone?.configuredBytes)}`;
  return (
    <div className="exagrid-meter">
      <div className="exagrid-meter__head">
        <span className="exagrid-meter__label">{label}</span>
        <span className={`exagrid-meter__value${known ? "" : " is-missing"}`}>{formatPercent(percent)}</span>
      </div>
      {known && (
        <div className="exagrid-meter__track">
          <div className={`exagrid-meter__fill${usageSeverityClass(percent)}`} style={{ width: `${clamped}%` }} />
        </div>
      )}
      <span className="exagrid-meter__foot">{foot}</span>
      {zone?.usedBytes !== undefined && (
        <span className="exagrid-meter__foot">{formatBytes(zone.usedBytes)} occupés</span>
      )}
    </div>
  );
}

function ExagridTile({
  label,
  value,
  hint,
  hintClass,
  title,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  hintClass?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <div className="exagrid-tile" {...(title ? { title } : {})}>
      <span className="exagrid-tile__label">{label}</span>
      <span className={`exagrid-tile__value${value === MISSING ? " is-missing" : ""}`}>{value}</span>
      {hint && <span className={`exagrid-tile__hint${hintClass ?? ""}`}>{hint}</span>}
    </div>
  );
}

const ALARM_TEXT = {
  ok: { className: "is-ok", title: "Aucune alarme", text: "L'appliance signale un fonctionnement normal." },
  warning: {
    className: "is-warning",
    title: "Avertissement",
    text: "L'appliance signale une alarme d'avertissement — consultez son interface d'administration.",
  },
  error: {
    className: "is-error",
    title: "Alarme critique",
    text: "L'appliance signale une alarme en erreur — intervention requise sur l'appliance.",
  },
} as const;

function ExagridAlarmBanner({ alarm }: { alarm?: ExagridAlarm | undefined }) {
  if (!alarm) return null;
  // `state` absent = valeur d'alarme hors des trois codes de la MIB : annoncée comme non
  // interprétée plutôt que rattachée arbitrairement à un niveau.
  const meta = alarm.state
    ? ALARM_TEXT[alarm.state]
    : {
        className: "is-unknown",
        title: "État d'alarme non interprété",
        text: "L'appliance a renvoyé une valeur d'alarme hors des codes prévus par la MIB.",
      };
  const rawLabel = alarm.raw !== undefined ? `Valeur brute SNMP : ${alarm.raw}` : undefined;
  return (
    <div className={`exagrid-alarm ${meta.className}`} {...(rawLabel ? { title: rawLabel } : {})}>
      <span className="exagrid-alarm__dot" />
      <div className="exagrid-alarm__body">
        <strong className="exagrid-alarm__title">{meta.title}</strong>
        <span className="exagrid-alarm__text">{meta.text}</span>
      </div>
      {!alarm.state && alarm.raw !== undefined && <span className="exagrid-alarm__raw">{alarm.raw}</span>}
    </div>
  );
}

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

function versionLabel(version?: ExagridSnmpVersion): string {
  if (version === "2c") return "SNMP v2c";
  if (version === "3") return "SNMP v3";
  return MISSING;
}

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

function ExagridConfigSection() {
  const { configured, config, configLoad, configSaving, configError, clearing, testing, testResult, backendUnavailable } =
    useAppSelector((s) => s.exagrid);
  const dispatch = useAppDispatch();
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ExagridFormState>(EMPTY_FORM);

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

  function openForm() {
    dispatch(clearExagridTestResult());
    setEditing(true);
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

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const input = currentInput();
    if (!input) return;
    const result = await dispatch(saveExagridConfig(input));
    // L'état est rechargé par l'effet de la page (le reducer a remis statusLoad à "idle").
    if (saveExagridConfig.fulfilled.match(result)) {
      setEditing(false);
      dispatch(clearExagridTestResult());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration ExaGrid ?",
      description:
        "QUAI n'interrogera plus l'appliance de stockage en SNMP — occupation, files d'attente et alarme disparaîtront de cette page. Aucune donnée n'est modifiée sur l'appliance.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableExagrid());
    setForm(EMPTY_FORM);
    setEditing(false);
  }

  const showForm = editing || !configured;
  const valid = currentInput() !== null;
  const endpoint = config?.config;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Configuration</h3>
          <p>
            Interrogation SNMP de l'appliance ExaGrid, en lecture seule (ExaGrid n'expose pas d'API REST). La
            session SNMP est réellement testée avant l'enregistrement.
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
        <div className="exagrid-note" style={{ marginBottom: 16 }}>
          L'API ExaGrid ne répond pas encore sur ce serveur — l'enregistrement échouera tant que la route n'est
          pas déployée.
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

      {configLoad !== "loading" && configured && !editing && endpoint && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
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
        <form
          className="card"
          style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={handleSave}
        >
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
    </>
  );
}

export default function ExagridPage() {
  const dispatch = useAppDispatch();
  const { status, statusLoad, statusError, backendUnavailable, configured, configLoad } = useAppSelector(
    (s) => s.exagrid,
  );
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  useEffect(() => {
    if (statusLoad === "idle") dispatch(fetchExagridStatus());
    if (configLoad === "idle") dispatch(fetchExagridConfig());
  }, [dispatch, statusLoad, configLoad]);

  function handleRefresh() {
    dispatch(fetchExagridStatus());
    dispatch(fetchExagridConfig());
  }

  const unreachable = configured && status?.reachable === false;
  // `reachable` absent : on n'invente pas de verdict, mais on affiche les valeurs réellement
  // renvoyées plutôt que de masquer la page.
  const showData = configured && !!status && status.reachable !== false;
  const readings = status?.readings;

  const connectionPill = backendUnavailable
    ? { status: "unavailable", label: "Indisponible" }
    : statusLoad === "loading" && !status
      ? { status: "checking", label: "Vérification…" }
      : !configured
        ? { status: "unconfigured" }
        : unreachable
          ? { status: "crit", label: "Injoignable" }
          : status?.reachable === true
            ? { status: "connected" }
            : { status: "unknown", label: "État inconnu" };

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Stockage de sauvegarde</h2>
            <p>
              Appliance ExaGrid interrogée en SNMP, en lecture seule — occupation des zones d'atterrissage et de
              rétention, files d'attente de déduplication et de réplication, état d'alarme.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusPill {...connectionPill} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh}>
              Actualiser
            </button>
          </div>
        </div>

        {backendUnavailable && (
          <div className="empty-state">
            <IconStorageArray />
            <strong>Intégration ExaGrid indisponible</strong>
            <span>
              L'API QUAI ne répond pas sur les routes ExaGrid. Aucune donnée n'est affichée tant que l'appliance
              n'est pas réellement interrogée.
            </span>
          </div>
        )}

        {!backendUnavailable && statusError && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            {statusError}
          </div>
        )}

        {!backendUnavailable && statusLoad === "loading" && !status && (
          <div className="empty-state">Chargement de l'état de l'appliance…</div>
        )}

        {!backendUnavailable && status && !configured && (
          <div className="empty-state">
            <IconStorageArray />
            <strong>ExaGrid non configuré</strong>
            {admin ? (
              <span>Renseignez l'accès SNMP à l'appliance dans la section Configuration ci-dessous.</span>
            ) : (
              <span>Seul un administrateur peut configurer l'accès SNMP à l'appliance ExaGrid.</span>
            )}
          </div>
        )}

        {unreachable && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            L'appliance ExaGrid est configurée mais ne répond pas en SNMP
            {status?.lastPoll ? ` (dernier essai : ${new Date(status.lastPoll.at).toLocaleString("fr-FR")})` : ""}.
            Aucune valeur n'est affichée tant qu'elle reste injoignable.
          </div>
        )}

        {showData && status && (
          <>
            <ExagridAlarmBanner {...(readings?.alarm ? { alarm: readings.alarm } : {})} />

            {!readings && (
              <div className="exagrid-note" style={{ marginTop: 12 }}>
                L'appliance répond mais aucune valeur de la MIB n'a été relevée lors du dernier poll.
              </div>
            )}

            <h3 className="exagrid-section-title">Occupation</h3>
            <div className="exagrid-meters">
              <ExagridMeter label="Zone d'atterrissage (landing)" zone={readings?.landing} />
              <ExagridMeter label="Zone de rétention" zone={readings?.retention} />
            </div>

            <h3 className="exagrid-section-title">Données de sauvegarde</h3>
            <div className="exagrid-tiles">
              <ExagridTile
                label="Disponibles pour restauration"
                value={formatBytes(readings?.backupData.availableForRestoreBytes)}
                hint="volume de sauvegardes restaurables"
              />
              <ExagridTile
                label="Consommées en rétention"
                value={formatBytes(readings?.backupData.retentionConsumedBytes)}
                hint="après déduplication et compression"
              />
            </div>

            <h3 className="exagrid-section-title">Files d'attente</h3>
            <div className="exagrid-tiles">
              <ExagridTile
                label="En attente de déduplication"
                value={formatBytes(readings?.pendingDeduplication.bytes)}
                hint={`Ancienneté : ${formatAge(readings?.pendingDeduplication.ageSeconds)}`}
                hintClass={ageSeverityClass(readings?.pendingDeduplication.ageSeconds)}
              />
              <ExagridTile
                label="En attente de réplication"
                value={formatBytes(readings?.pendingReplication.bytes)}
                hint={`Ancienneté : ${formatAge(readings?.pendingReplication.ageSeconds)}`}
                hintClass={ageSeverityClass(readings?.pendingReplication.ageSeconds)}
                title="Une ancienneté de réplication qui grandit signale un retard de copie hors site."
              />
            </div>

            {status.lastPoll && (
              <p className="exagrid-poll">
                Dernier relevé SNMP : {new Date(status.lastPoll.at).toLocaleString("fr-FR")}
                {status.lastPoll.reachable ? " — réussi" : " — échoué"}
              </p>
            )}
          </>
        )}

        {admin && (
          <div style={{ marginTop: configured ? 32 : 0 }}>
            <ExagridConfigSection />
          </div>
        )}
      </div>
    </div>
  );
}
