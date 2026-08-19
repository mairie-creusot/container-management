import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearThreecxTestResult,
  disableThreecx,
  fetchThreecxActiveCalls,
  fetchThreecxConfig,
  fetchThreecxExtensions,
  fetchThreecxQueues,
  fetchThreecxStatus,
  saveThreecxConfig,
  selectThreecx,
  testThreecxConfig,
  type ThreecxConfigFormInput,
} from "@/features/threecx/threecxSlice";
import type {
  ThreecxAccess,
  ThreecxAccessState,
  ThreecxActiveCall,
  ThreecxCallParticipant,
  ThreecxListState,
} from "@/features/threecx/types";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck, IconServer } from "@/components/icons";

/** Valeur que le PBX n'a pas communiquée — jamais remplacée par 0. */
const MISSING = "—";

/** Appels en cours : le PBX est interrogé toutes les 5 s, uniquement pendant que la page est
 * ouverte et l'onglet visible. */
const POLL_MS = 5000;
/** Postes et files ne bougent quasiment jamais : un tour sur douze suffit (≈ 1 min). */
const SLOW_POLL_EVERY = 12;

function formatDateTime(iso?: string): string {
  if (!iso) return MISSING;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString("fr-FR");
}

function formatTime(iso?: string): string {
  if (!iso) return MISSING;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleTimeString("fr-FR");
}

/** Compteur d'appel façon horloge — "02:35", "1:04:07". */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

/** Durée en toutes lettres pour l'infobulle. */
function formatDurationFr(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes} min ${String(rest).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min ${String(rest).padStart(2, "0")} s`;
}

function formatCount(value: number | undefined, singular: string, plural: string): string {
  if (value === undefined) return MISSING;
  return `${value.toLocaleString("fr-FR")} ${value > 1 ? plural : singular}`;
}

/**
 * Les QUATRE états distingués par le backend, jamais confondus : jamais configuré, PBX injoignable,
 * accès refusé par le PBX (`accessError`), et réponse réelle (dont une liste réellement vide).
 */
function accessStateOf(access: ThreecxAccess): ThreecxAccessState {
  if (!access.configured) return "unconfigured";
  if (access.reachable === false) return "unreachable";
  if (access.accessError) return "denied";
  if (access.reachable === true) return "ok";
  return "unknown";
}

/** Refus du PBX — le message est affiché BRUT, tel que le PBX l'écrit. */
function ThreecxDeniedNotice({ message, subject }: { message: string; subject: string }) {
  return (
    <div className="threecx-denied">
      <strong className="threecx-denied__title">Le PBX 3CX a refusé l'accès au XAPI</strong>
      <span className="threecx-denied__text">
        Impossible de lire {subject} : le PBX a répondu, mais il rejette la requête. Le XAPI n'est ouvert qu'avec
        une licence 3CX Enterprise et un point de routage autorisé («&nbsp;XAPI Access Enabled&nbsp;»). Message
        renvoyé par le PBX, tel quel :
      </span>
      <code className="threecx-denied__raw">{message}</code>
    </div>
  );
}

/**
 * Bandeau d'une section de liste — rend le motif exact pour lequel elle n'affiche rien. Une liste
 * vide n'est annoncée comme telle QUE si le PBX a réellement répondu sans refus.
 */
function ThreecxListNotice<T>({ list, subject, emptyLabel }: { list: ThreecxListState<T>; subject: string; emptyLabel: string }) {
  if (list.error) {
    return (
      <div className="error-banner" style={{ marginBottom: 12 }}>
        {list.error}
      </div>
    );
  }
  if (list.load === "loading" && list.items.length === 0) {
    return <div className="empty-state">Lecture du PBX en cours…</div>;
  }
  const state = accessStateOf(list.access);
  if (state === "unconfigured") return null;
  if (state === "unreachable") {
    return <div className="empty-state">Aucune donnée : le PBX 3CX ne répond pas — impossible de lire {subject}.</div>;
  }
  if (state === "denied") {
    const message = list.access.accessError ?? "";
    return <ThreecxDeniedNotice message={message} subject={subject} />;
  }
  if (list.load === "ready" && list.items.length === 0) return <div className="empty-state">{emptyLabel}</div>;
  return null;
}

function participantLabel(participant: ThreecxCallParticipant | undefined, fallback: string) {
  if (!participant) return <span className="threecx-party__unknown">{fallback}</span>;
  return (
    <>
      <span className="threecx-party__name">{participant.name ?? participant.number}</span>
      {participant.name && <span className="threecx-party__number">{participant.number}</span>}
    </>
  );
}

/** Statuts d'appel réellement écrits par le XAPI (chaîne libre) : la valeur BRUTE reste le libellé,
 * seule la couleur est déduite des valeurs connues. */
const TALKING_STATUSES = new Set(["talking", "connected"]);
const PROGRESS_STATUSES = new Set(["dialing", "ringing", "routing", "rerouting", "initiating", "transferring", "holding", "hold"]);

function callStatusProps(status?: string): { status: string; label: string } {
  if (!status) return { status: "unknown", label: "Statut non communiqué" };
  const key = status.trim().toLowerCase();
  if (TALKING_STATUSES.has(key)) return { status: "ok", label: status };
  if (PROGRESS_STATUSES.has(key)) return { status: "warn", label: status };
  return { status: "neutral", label: status };
}

function ThreecxCallCard({ call, elapsedSeconds }: { call: ThreecxActiveCall; elapsedSeconds?: number | undefined }) {
  const caller = call.participants.find((p) => p.direction === "caller");
  const callee = call.participants.find((p) => p.direction === "callee");
  const pill = callStatusProps(call.status);
  return (
    <article className="threecx-call">
      <div className="threecx-call__parties">
        <span className="threecx-party">{participantLabel(caller, "Appelant non communiqué")}</span>
        <span className="threecx-call__arrow" aria-hidden="true">
          →
        </span>
        <span className="threecx-party">{participantLabel(callee, "Appelé non communiqué")}</span>
      </div>
      <div className="threecx-call__meta">
        {elapsedSeconds === undefined ? (
          <span className="threecx-call__timer is-missing" title="Le PBX ne communique pas de durée tant que l'appel n'est pas établi">
            {MISSING}
          </span>
        ) : (
          <span className="threecx-call__timer" title={`Durée : ${formatDurationFr(elapsedSeconds)}`}>
            {formatClock(elapsedSeconds)}
          </span>
        )}
        <StatusPill {...pill} />
        <span className="threecx-call__since">
          {call.startedAt ? `établi à ${formatTime(call.startedAt)}` : "non établi (sonnerie)"}
        </span>
      </div>
    </article>
  );
}

interface ThreecxFormState {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tlsRejectUnauthorized: boolean;
}

/** Vérification TLS active par défaut — c'est aussi le défaut du serveur (config.threecx). */
const EMPTY_FORM: ThreecxFormState = { baseUrl: "", clientId: "", clientSecret: "", tlsRejectUnauthorized: true };

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function ThreecxConfigSection() {
  const dispatch = useAppDispatch();
  const { configured, config, configLoad, configSaving, configError, clearing, testing, testResult, backendUnavailable } =
    useAppSelector(selectThreecx);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ThreecxFormState>(EMPTY_FORM);

  useEffect(() => {
    if (config) {
      setForm({
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        clientSecret: "",
        tlsRejectUnauthorized: config.tlsRejectUnauthorized ?? true,
      });
    }
  }, [config]);

  function currentInput(): ThreecxConfigFormInput | null {
    const baseUrl = form.baseUrl.trim();
    const clientId = form.clientId.trim();
    const clientSecret = form.clientSecret.trim();
    if (!isHttpUrl(baseUrl) || !clientId) return null;
    // Clé vide = conserver l'existante ; impossible s'il n'y a rien à conserver.
    if (!clientSecret && !configured) return null;
    return {
      baseUrl,
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
    setForm(
      config
        ? {
            baseUrl: config.baseUrl,
            clientId: config.clientId,
            clientSecret: "",
            tlsRejectUnauthorized: config.tlsRejectUnauthorized ?? true,
          }
        : EMPTY_FORM,
    );
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
      setForm((f) => ({ ...f, clientSecret: "" }));
      dispatch(clearThreecxTestResult());
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration 3CX ?",
      description:
        "QUAI n'interrogera plus le PBX : appels en cours, postes et files d'attente disparaîtront de cette page. La clé API enregistrée est effacée. Aucun réglage n'est modifié sur le PBX.",
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
          <h3 style={{ marginBottom: 4 }}>Configuration</h3>
          <p>
            Accès en LECTURE SEULE au XAPI du PBX 3CX (OAuth2 client credentials). La connexion est réellement
            testée avant l'enregistrement — jamais persistée à l'aveugle.
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
          L'API 3CX ne répond pas sur ce serveur — l'enregistrement échouera tant que les routes ne sont pas
          déployées.
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
          {testResult.ok && testResult.activeCallCount !== undefined && ` — ${formatCount(testResult.activeCallCount, "appel en cours", "appels en cours")}`}
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
              { key: "ClientID (DN du point de routage)", value: config.clientId },
              {
                key: "Vérification du certificat TLS",
                value:
                  config.tlsRejectUnauthorized === undefined
                    ? "Valeur par défaut du serveur"
                    : config.tlsRejectUnauthorized
                      ? "Activée"
                      : "Désactivée",
              },
              { key: "Clé API", value: "Enregistrée et chiffrée — jamais réaffichée" },
            ]}
          />
        </div>
      )}

      {showForm && (
        <form className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
          <p className="threecx-form-help">
            Ces identifiants se créent dans la console d'administration du PBX : <strong>Admin Console →
            Integrations &gt; API</strong>, sur un point de routage dont l'option «&nbsp;XAPI Access Enabled&nbsp;»
            est activée. Le ClientID est le <strong>DN de ce point de routage</strong> et la clé API n'est affichée
            qu'une seule fois à sa création. Le XAPI n'est disponible qu'avec une <strong>licence 3CX
            Enterprise</strong> : sans elle, le PBX répond mais refuse chaque requête.
          </p>

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
              Adresse du PBX sans le suffixe /xapi/v1 — QUAI l'ajoute lui-même, ainsi que /connect/token.
            </span>
          </div>

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
            <label htmlFor="threecx-client-secret">Clé API{configured ? " (laisser vide pour conserver l'existante)" : ""}</label>
            <input
              id="threecx-client-secret"
              type="password"
              value={form.clientSecret}
              onChange={(event) => setForm((f) => ({ ...f, clientSecret: event.target.value }))}
              autoComplete="new-password"
              disabled={configSaving}
              {...(configured ? {} : { required: true })}
            />
          </div>

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
                À laisser activé : un 3CX publié sous son FQDN présente un certificat valide. Ne le désactivez que
                pour un PBX joint par une adresse interne avec un certificat auto-signé.
              </span>
            </span>
          </label>

          <p className="threecx-form-note">La clé API est stockée chiffrée et n'est jamais renvoyée par l'API, même tronquée.</p>

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
    </>
  );
}

export default function ThreecxPage() {
  const dispatch = useAppDispatch();
  const { status, statusLoad, statusError, backendUnavailable, configured, configLoad, calls, callsReceivedAt, extensions, queues } =
    useAppSelector(selectThreecx);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [extensionQuery, setExtensionQuery] = useState("");
  const [onlyReachable, setOnlyReachable] = useState(false);
  const tickRef = useRef(0);

  useEffect(() => {
    if (statusLoad === "idle") dispatch(fetchThreecxStatus());
    if (configLoad === "idle") dispatch(fetchThreecxConfig());
  }, [dispatch, statusLoad, configLoad]);

  useEffect(() => {
    if (!configured || backendUnavailable) return;
    if (calls.load === "idle") dispatch(fetchThreecxActiveCalls());
    if (extensions.load === "idle") dispatch(fetchThreecxExtensions());
    if (queues.load === "idle") dispatch(fetchThreecxQueues());
  }, [dispatch, configured, backendUnavailable, calls.load, extensions.load, queues.load]);

  // Poll court des appels en cours — vit et meurt avec la page, et se met en pause quand l'onglet
  // passe en arrière-plan : le XAPI n'accepte qu'un seul jeton actif, inutile de le solliciter pour
  // un écran que personne ne regarde.
  useEffect(() => {
    if (!configured || backendUnavailable) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      tickRef.current += 1;
      dispatch(fetchThreecxActiveCalls());
      dispatch(fetchThreecxStatus());
      if (tickRef.current % SLOW_POLL_EVERY === 0) {
        dispatch(fetchThreecxExtensions());
        dispatch(fetchThreecxQueues());
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [dispatch, configured, backendUnavailable]);

  // Horloge des compteurs d'appel — ne tourne que s'il y a un appel à décompter.
  useEffect(() => {
    if (calls.items.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [calls.items.length]);

  function handleRefresh() {
    dispatch(fetchThreecxStatus());
    dispatch(fetchThreecxConfig());
    if (!configured) return;
    dispatch(fetchThreecxActiveCalls());
    dispatch(fetchThreecxExtensions());
    dispatch(fetchThreecxQueues());
  }

  /** Durée affichée = durée calculée par le PBX + temps écoulé depuis la réception de sa réponse. */
  function elapsedFor(call: ThreecxActiveCall): number | undefined {
    if (call.durationSeconds === undefined) return undefined;
    const drift = callsReceivedAt === null ? 0 : Math.max(0, Math.floor((nowMs - callsReceivedAt) / 1000));
    return call.durationSeconds + drift;
  }

  const pageAccess: ThreecxAccess = status ?? { configured };
  const pageState = accessStateOf(pageAccess);

  const filteredExtensions = useMemo(() => {
    const needle = extensionQuery.trim().toLowerCase();
    return extensions.items.filter((extension) => {
      if (onlyReachable && extension.registered !== true) return false;
      if (!needle) return true;
      return (
        extension.number.toLowerCase().includes(needle) ||
        (extension.displayName ?? "").toLowerCase().includes(needle) ||
        (extension.currentProfileName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [extensions.items, extensionQuery, onlyReachable]);

  const connectionPill = backendUnavailable
    ? { status: "unavailable", label: "Indisponible" }
    : statusLoad === "loading" && !status
      ? { status: "checking", label: "Vérification…" }
      : statusError
        ? { status: "error", label: "Erreur de lecture" }
        : pageState === "unconfigured"
        ? { status: "unconfigured" }
        : pageState === "unreachable"
          ? { status: "crit", label: "Injoignable" }
          : pageState === "denied"
            ? { status: "warn", label: "Accès refusé par le PBX" }
            : pageState === "ok"
              ? { status: "connected" }
              : { status: "unknown", label: "État inconnu" };

  const system = status?.system;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Téléphonie</h2>
            <p>
              PBX 3CX de la mairie interrogé en lecture seule via son XAPI — appels en cours, postes et files
              d'attente réels. Aucune action téléphonique n'est possible depuis QUAI.
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
            <IconServer />
            <strong>Intégration 3CX indisponible</strong>
            <span>
              L'API QUAI ne répond pas sur les routes 3CX. Rien n'est affiché tant que le PBX n'est pas réellement
              interrogé.
            </span>
          </div>
        )}

        {!backendUnavailable && statusError && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            {statusError}
          </div>
        )}

        {!backendUnavailable && statusLoad === "loading" && !status && <div className="empty-state">Lecture de l'état du PBX…</div>}

        {!backendUnavailable && status && pageState === "unconfigured" && (
          <div className="empty-state">
            <IconServer />
            <strong>PBX 3CX non configuré</strong>
            {admin ? (
              <span>Renseignez l'accès au XAPI du PBX dans la section Configuration ci-dessous.</span>
            ) : (
              <span>Seul un administrateur peut configurer l'accès au PBX 3CX.</span>
            )}
          </div>
        )}

        {!backendUnavailable && pageState === "unreachable" && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            Le PBX 3CX est configuré mais ne répond pas
            {status?.lastPoll ? ` (dernier essai : ${formatDateTime(status.lastPoll.at)})` : ""}. Aucune valeur n'est
            affichée tant qu'il reste injoignable.
          </div>
        )}

        {!backendUnavailable && pageState === "denied" && status?.accessError && (
          <div style={{ marginBottom: 16 }}>
            <ThreecxDeniedNotice message={status.accessError} subject="les données du PBX" />
          </div>
        )}

        {!backendUnavailable && pageState === "unknown" && configured && (
          <div className="threecx-note" style={{ marginBottom: 16 }}>
            Le PBX n'a pas encore été joint depuis le démarrage de l'API : ni réponse, ni refus. Actualisez pour
            forcer une lecture.
          </div>
        )}

        {!backendUnavailable && pageState === "ok" && (
          <>
            <div className="stat-grid">
              <div className="stat-card stat-card--hero">
                <span className="stat-card__label">Appels en cours</span>
                <span className="stat-card__value">{status?.activeCallCount ?? MISSING}</span>
                <span className="stat-card__hint">
                  {system?.maxSimCalls !== undefined ? `${system.maxSimCalls} appels simultanés au maximum` : "communications établies ou en cours d'établissement"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Postes joignables</span>
                <span className="stat-card__value">
                  {status?.reachableExtensionCount !== undefined && status.extensionCount !== undefined
                    ? `${status.reachableExtensionCount} / ${status.extensionCount}`
                    : MISSING}
                </span>
                <span className="stat-card__hint">téléphones ou applications enregistrés sur le PBX</span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Files d'attente</span>
                <span className="stat-card__value">{status?.queueCount ?? MISSING}</span>
                <span className="stat-card__hint">files déclarées sur le PBX</span>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">Lignes opérateur</span>
                <span className="stat-card__value">
                  {system?.trunksRegistered !== undefined && system.trunksTotal !== undefined
                    ? `${system.trunksRegistered} / ${system.trunksTotal}`
                    : MISSING}
                </span>
                <span className="stat-card__hint">
                  {system?.version ? `3CX ${system.version}${system.fqdn ? ` — ${system.fqdn}` : ""}` : "trunks SIP enregistrés"}
                </span>
              </div>
            </div>

            <h3 className="threecx-section-title">Appels en cours</h3>
            <ThreecxListNotice list={calls} subject="les appels en cours" emptyLabel="Aucun appel en cours sur le PBX." />
            {calls.items.length > 0 && (
              <div className="threecx-calls">
                {calls.items.map((call) => (
                  <ThreecxCallCard key={call.id} call={call} elapsedSeconds={elapsedFor(call)} />
                ))}
              </div>
            )}

            <div className="threecx-section-head">
              <h3 className="threecx-section-title">Postes</h3>
              {extensions.items.length > 0 && (
                <div className="threecx-filters">
                  <input
                    type="search"
                    value={extensionQuery}
                    onChange={(event) => setExtensionQuery(event.target.value)}
                    placeholder="Filtrer par numéro, nom ou présence"
                    aria-label="Filtrer les postes"
                  />
                  <label className="threecx-checkbox threecx-checkbox--inline">
                    <input type="checkbox" checked={onlyReachable} onChange={(event) => setOnlyReachable(event.target.checked)} />
                    <span>Joignables uniquement</span>
                  </label>
                  <span className="threecx-count">
                    {filteredExtensions.length} / {extensions.items.length}
                  </span>
                </div>
              )}
            </div>
            <ThreecxListNotice list={extensions} subject="les postes" emptyLabel="Aucun poste déclaré sur le PBX." />
            {extensions.items.length > 0 && (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Numéro</th>
                      <th>Nom</th>
                      <th>Joignable</th>
                      <th>Présence</th>
                      <th>File d'attente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExtensions.map((extension) => (
                      <tr key={extension.id}>
                        <td className="cell-mono">{extension.number}</td>
                        <td className="cell-primary">{extension.displayName ?? MISSING}</td>
                        <td>
                          {extension.registered === undefined ? (
                            MISSING
                          ) : extension.registered ? (
                            <StatusPill status="ok" label="Enregistré" />
                          ) : (
                            <StatusPill status="crit" label="Non enregistré" />
                          )}
                        </td>
                        <td>{extension.currentProfileName ?? MISSING}</td>
                        <td>{extension.queueStatus ?? MISSING}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredExtensions.length === 0 && <div className="empty-state">Aucun poste ne correspond au filtre.</div>}
              </div>
            )}

            <h3 className="threecx-section-title">Files d'attente</h3>
            <ThreecxListNotice list={queues} subject="les files d'attente" emptyLabel="Aucune file d'attente déclarée sur le PBX." />
            {queues.items.length > 0 && (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Numéro</th>
                      <th>Nom</th>
                      <th>Enregistrée</th>
                      <th>Stratégie de distribution</th>
                      <th>Appelants en attente (max)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queues.items.map((queue) => (
                      <tr key={queue.id}>
                        <td className="cell-mono">{queue.number}</td>
                        <td className="cell-primary">{queue.name ?? MISSING}</td>
                        <td>
                          {queue.registered === undefined ? (
                            MISSING
                          ) : queue.registered ? (
                            <StatusPill status="ok" label="Oui" />
                          ) : (
                            <StatusPill status="warn" label="Non" />
                          )}
                        </td>
                        <td>{queue.pollingStrategy ?? MISSING}</td>
                        <td className="cell-mono">{queue.maxCallersInQueue ?? MISSING}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {status?.lastPoll && (
              <p className="threecx-poll">
                Dernière interrogation du PBX : {formatDateTime(status.lastPoll.at)}
                {status.lastPoll.reachable ? " — réussie" : " — échouée"} · appels rafraîchis toutes les{" "}
                {POLL_MS / 1000} secondes tant que cette page est ouverte.
              </p>
            )}
          </>
        )}

        {admin && (
          <div style={{ marginTop: configured ? 32 : 0 }}>
            <ThreecxConfigSection />
          </div>
        )}
      </div>
    </div>
  );
}
