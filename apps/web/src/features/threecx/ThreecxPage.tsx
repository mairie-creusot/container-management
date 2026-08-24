import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  fetchThreecxActiveCalls,
  fetchThreecxConfig,
  fetchThreecxExtensions,
  fetchThreecxQueues,
  fetchThreecxStatus,
  selectThreecx,
} from "@/features/threecx/threecxSlice";
import type {
  ThreecxAccess,
  ThreecxActiveCall,
  ThreecxCallParticipant,
  ThreecxExtension,
  ThreecxListState,
} from "@/features/threecx/types";
import { accessStateOf, pbxErrorHint } from "@/features/threecx/access";
import { canAdminister } from "@/features/auth/authSlice";
import { openSettingsSection } from "@/features/ui/uiSlice";
import StatusPill from "@/components/StatusPill";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import { IconServer } from "@/components/icons";

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

/** Refus d'ACCÈS (401/403, authentification rejetée) — le seul cas où la licence est en cause. */
function ThreecxDeniedNotice({ message, subject }: { message: string; subject: string }) {
  return (
    <div className="threecx-denied">
      <strong className="threecx-denied__title">Le PBX 3CX a refusé l'accès au XAPI</strong>
      <span className="threecx-denied__text">
        Impossible de lire {subject} : le PBX a répondu, mais il rejette l'accès. Le XAPI n'est ouvert qu'avec
        une licence 3CX Enterprise et un point de routage autorisé («&nbsp;XAPI Access Enabled&nbsp;»). Message
        renvoyé par le PBX, tel quel :
      </span>
      <code className="threecx-denied__raw">{message}</code>
    </div>
  );
}

/** Erreur renvoyée par le PBX qui n'est PAS un refus d'accès : cadre neutre, message brut, aucune
 * mention de licence ni de droits. */
function ThreecxPbxErrorNotice({ message, subject }: { message: string; subject: string }) {
  const hint = pbxErrorHint(message);
  return (
    <div className="threecx-pbx-error">
      <strong className="threecx-pbx-error__title">Le PBX a rejeté la requête</strong>
      <span className="threecx-pbx-error__text">
        L'accès au XAPI fonctionne, mais le PBX a répondu par une erreur en tentant de lire {subject}. Message
        renvoyé par le PBX, tel quel :
      </span>
      <code className="threecx-pbx-error__raw">{message}</code>
      {hint && <span className="threecx-pbx-error__hint">{hint}</span>}
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
  if (state === "pbx-error") {
    const message = list.access.pbxError ?? "";
    return <ThreecxPbxErrorNotice message={message} subject={subject} />;
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

// Configuration du PBX : extraite le 24/08/2026 dans ThreecxConfigSection.tsx et montée
// UNIQUEMENT par la page Réglages — cette page n'affiche plus que les données réelles du PBX.

export default function ThreecxPage() {
  const dispatch = useAppDispatch();
  const { status, statusLoad, statusError, backendUnavailable, configured, configLoad, calls, callsReceivedAt, extensions, queues } =
    useAppSelector(selectThreecx);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
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

  // Colonnes du tableau générique (tri, pagination, recherche par champ) — `values` alimente la
  // complétion de `presence:` avec les profils réellement présents sur le PBX.
  const extensionColumns = useMemo<DataTableColumn<ThreecxExtension>[]>(
    () => [
      {
        key: "numero",
        label: "Numéro",
        accessor: (e) => e.number,
        kind: "number",
        aliases: ["num", "ext"],
        className: "cell-mono",
      },
      {
        key: "nom",
        label: "Nom",
        accessor: (e) => e.displayName ?? "",
        className: "cell-primary",
        render: (e) => e.displayName ?? MISSING,
      },
      {
        key: "joignable",
        label: "Joignable",
        accessor: (e) => e.registered ?? null,
        kind: "boolean",
        render: (e) =>
          e.registered === undefined ? (
            MISSING
          ) : e.registered ? (
            <StatusPill status="ok" label="Enregistré" />
          ) : (
            <StatusPill status="crit" label="Non enregistré" />
          ),
      },
      {
        key: "presence",
        label: "Présence",
        accessor: (e) => e.currentProfileName ?? "",
        render: (e) => e.currentProfileName ?? MISSING,
        values: [...new Set(extensions.items.map((e) => e.currentProfileName).filter(Boolean))] as string[],
      },
      {
        key: "file",
        label: "File d'attente",
        accessor: (e) => e.queueStatus ?? "",
        aliases: ["queue"],
        render: (e) => e.queueStatus ?? MISSING,
      },
    ],
    [extensions.items],
  );

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
            : pageState === "pbx-error"
              ? { status: "warn", label: "Requête rejetée par le PBX" }
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
              <>
                <span>L'accès au XAPI du PBX se renseigne dans les Réglages.</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 12 }}
                  onClick={() => dispatch(openSettingsSection("threecx"))}
                >
                  Ouvrir le réglage 3CX
                </button>
              </>
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

        {!backendUnavailable && pageState === "pbx-error" && status?.pbxError && (
          <div style={{ marginBottom: 16 }}>
            <ThreecxPbxErrorNotice message={status.pbxError} subject="les données du PBX" />
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

            <h3 className="threecx-section-title">Postes</h3>
            <ThreecxListNotice list={extensions} subject="les postes" emptyLabel="Aucun poste déclaré sur le PBX." />
            {extensions.items.length > 0 && (
              <DataTable
                rows={extensions.items}
                columns={extensionColumns}
                rowKey={(extension) => String(extension.id)}
                storageKey="threecx-extensions"
                itemsLabel="postes"
                defaultSort={{ key: "numero", direction: "asc" }}
                emptyLabel="Aucun poste déclaré sur le PBX."
                noResultsLabel="Aucun poste ne correspond à la recherche."
                searchPlaceholder="Rechercher…  (ex : numero:57 presence:available joignable:oui)"
              />
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

        {/* Le formulaire d'accès au PBX (ThreecxConfigSection.tsx) n'est plus monté ici : il vit
            désormais dans la page Réglages, seule source de vérité. */}
      </div>
    </div>
  );
}
