import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearAdDnsTestResult,
  clearLdapDiagnosis,
  diagnoseLdapAccount,
  disableAdDns,
  fetchAdDnsStatus,
  saveAdDnsConfig,
  testAdDnsConfig,
  type AdDnsFormInput,
  type LdapAccountDiagnosis,
} from "@/features/adDns/adDnsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconCheck, IconServer } from "@/components/icons";

const EMPTY_FORM: AdDnsFormInput = { realm: "", kdcHost: "", zone: "", serviceAccount: "", password: "", targetIp: "" };

function formatSyncDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR");
}

function ternaryLabel(value: boolean | null, whenTrue: string, whenFalse: string): string {
  if (value === null) return "non lisible";
  return value ? whenTrue : whenFalse;
}

/** Le verdict est bloquant dès que l'annuaire empêche le compte de se connecter. */
function isBlocking(diagnosis: LdapAccountDiagnosis): boolean {
  const s = diagnosis.accountState;
  return (
    !diagnosis.found ||
    diagnosis.matchCount > 1 ||
    s.disabled === true ||
    s.locked === true ||
    s.mustChangePassword === true ||
    s.passwordExpired === true ||
    s.accountExpired === true
  );
}

/**
 * Résultat du diagnostic d'un compte annuaire. Volontairement détaillé : cet écran est réservé
 * aux administrateurs (POST /api/auth/ldap-diagnose exige le rôle admin) — l'écran de connexion,
 * lui, reste vague et ne révèle jamais si un compte existe.
 */
function DiagnosisReport({ diagnosis }: { diagnosis: LdapAccountDiagnosis }) {
  const state = diagnosis.accountState;
  const blocking = isBlocking(diagnosis);

  const rows = [
    { key: "Trouvé par le filtre configuré", value: diagnosis.found ? "oui" : "non" },
    { key: "Entrées correspondantes", value: String(diagnosis.matchCount) },
    { key: "DN", value: diagnosis.dn ?? "—" },
    { key: "Nom affiché", value: diagnosis.displayName ?? "—" },
    { key: "sAMAccountName", value: diagnosis.identifiers.sAMAccountName ?? "—" },
    { key: "userPrincipalName", value: diagnosis.identifiers.userPrincipalName ?? "—" },
    { key: "Attribut memberOf", value: diagnosis.memberOfPresent ? "présent" : "absent (repli par requête inverse)" },
    { key: "Groupes résolus", value: String(diagnosis.groupsResolved) },
    { key: "Rôles qui seraient attribués", value: diagnosis.roles?.join(", ") || "—" },
    { key: "Base de recherche", value: diagnosis.searchBase },
    { key: "Filtre de recherche", value: diagnosis.searchFilter },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className={blocking ? "error-banner" : "success-banner"}>
        {blocking ? null : <IconCheck />} {diagnosis.verdict}
      </div>

      <div className="chip-row" style={{ marginBottom: 0 }}>
        <span className={`chip${state.disabled === true ? " chip--danger" : state.disabled === null ? " chip--muted" : ""}`}>
          {ternaryLabel(state.disabled, "Désactivé", "Activé")}
        </span>
        <span className={`chip${state.locked === true ? " chip--danger" : state.locked === null ? " chip--muted" : ""}`}>
          {ternaryLabel(state.locked, "Verrouillé", "Non verrouillé")}
        </span>
        <span className={`chip${state.mustChangePassword === true ? " chip--danger" : state.mustChangePassword === null ? " chip--muted" : ""}`}>
          {ternaryLabel(state.mustChangePassword, "Doit changer son mot de passe", "Mot de passe non forcé")}
        </span>
        <span className={`chip${state.passwordExpired === true ? " chip--danger" : state.passwordExpired === null ? " chip--muted" : ""}`}>
          {ternaryLabel(state.passwordExpired, "Mot de passe expiré", "Mot de passe valide")}
        </span>
        <span className={`chip${state.accountExpired === true ? " chip--danger" : state.accountExpired === null ? " chip--muted" : ""}`}>
          {ternaryLabel(state.accountExpired, "Compte expiré", "Compte non expiré")}
        </span>
      </div>

      <KeyValueList rows={rows} />

      {diagnosis.matchCount > 1 && (
        <div className="error-banner">
          Plusieurs entrées portent cet identifiant : {diagnosis.matchedDns.join(" — ")}
        </div>
      )}

      {diagnosis.notes.length > 0 && (
        <ul className="create-container-hint" style={{ margin: 0, paddingLeft: 18 }}>
          {diagnosis.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Configuration de la synchronisation DNS Active Directory (RFC 2136 + GSS-TSIG, voir
 * apps/api/src/services/adDns.ts) — quand elle est activée, chaque route de reverse proxy créée
 * pousse réellement son enregistrement DNS dans l'AD de la mairie.
 *
 * Extrait de l'ancienne page « DNS Active Directory » (retirée du menu latéral le 24/08/2026) :
 * SEULE source de vérité de ce formulaire, montée uniquement par la page Réglages. Les données
 * métier correspondantes se lisent désormais sur le nœud de la VM contrôleur de domaine dans le
 * graphe (module « ad-dns », voir apps/api/src/services/serviceModules.ts).
 */
export default function AdDnsConfigSection() {
  const dispatch = useAppDispatch();
  const { status, error, configured, config, lastSync, saving, clearing, testing, testResult } = useAppSelector(
    (s) => s.adDns,
  );
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [form, setForm] = useState<AdDnsFormInput>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    dispatch(fetchAdDnsStatus());
  }, [dispatch]);

  // Pré-remplit le formulaire dès que la config effective arrive (jamais le mot de passe, écrit
  // uniquement — voir AdDnsFormInput#password).
  useEffect(() => {
    if (config) setForm({ ...config, password: "" });
  }, [config]);

  function openForm() {
    dispatch(clearAdDnsTestResult());
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearAdDnsTestResult());
    setForm(config ? { ...config, password: "" } : EMPTY_FORM);
  }

  function currentInput(): AdDnsFormInput {
    return {
      realm: form.realm.trim(),
      kdcHost: form.kdcHost.trim(),
      zone: form.zone.trim(),
      serviceAccount: form.serviceAccount.trim(),
      targetIp: form.targetIp.trim(),
      ...(form.password?.trim() ? { password: form.password.trim() } : {}),
    };
  }

  function isFormValid(): boolean {
    const input = currentInput();
    const hasPassword = !!input.password || configured;
    return !!(input.realm && input.kdcHost && input.zone && input.serviceAccount && input.targetIp && hasPassword);
  }

  async function handleTest() {
    if (!isFormValid()) return;
    await dispatch(testAdDnsConfig(currentInput()));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(saveAdDnsConfig(currentInput()));
    if (saveAdDnsConfig.fulfilled.match(result)) {
      setEditing(false);
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Désactiver la synchronisation DNS AD ?",
      description:
        "Les futures routes de reverse proxy ne pousseront plus automatiquement leur enregistrement DNS — retour au mode manuel (fichier hosts / DNS interne). Les enregistrements déjà créés ne sont PAS supprimés.",
      confirmLabel: "Désactiver",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableAdDns());
    setForm(EMPTY_FORM);
  }

  const showForm = editing || !configured;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>DNS Active Directory</h3>
          <p>
            Synchronisation dynamique sécurisée (RFC 2136 + GSS-TSIG) : chaque route du reverse proxy pousse son
            enregistrement DNS dans l'AD de la mairie — plus besoin d'entrée manuelle de fichier hosts.
          </p>
        </div>
        {admin && configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            {/* Teste le compte de service déjà enregistré (kinit uniquement, aucun enregistrement
                DNS écrit) SANS repasser par "Modifier" — `form` est déjà pré-rempli avec la config
                effective et `isFormValid()` n'exige pas de mot de passe quand `configured` est vrai
                (routes/adDns.ts : password vide = conserver l'existant). */}
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openForm}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable} disabled={clearing}>
              {clearing ? "Désactivation…" : "Désactiver"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {status !== "loading" && !configured && !showForm && (
        <div className="empty-state" style={{ marginBottom: 16 }}>Synchronisation DNS AD non configurée.</div>
      )}

      {configured && !editing && config && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconServer />
            </span>
            <StatusPill
              status={lastSync ? (lastSync.status === "synced" ? "ok" : "crit") : "warn"}
              label={
                lastSync
                  ? lastSync.status === "synced"
                    ? `Synchronisé le ${formatSyncDate(lastSync.at)}`
                    : `Échec le ${formatSyncDate(lastSync.at)}`
                  : "Aucune synchronisation depuis le démarrage"
              }
            />
          </div>
          {lastSync?.status === "failed" && lastSync.message && <div className="error-banner">{lastSync.message}</div>}
          {testResult && (
            <div className={testResult.ok ? "success-banner" : "error-banner"}>
              {testResult.ok ? <IconCheck /> : null} {testResult.message}
            </div>
          )}
          <KeyValueList
            rows={[
              { key: "Royaume Kerberos", value: config.realm },
              { key: "Contrôleur de domaine (KDC)", value: config.kdcHost },
              { key: "Zone DNS", value: config.zone },
              { key: "Compte de service", value: config.serviceAccount },
              { key: "IP cible des enregistrements", value: config.targetIp },
            ]}
          />
        </div>
      )}

      {admin && showForm && (
        <form
          className="card"
          style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={handleSave}
        >
          <div className="field">
            <label htmlFor="addns-realm">Royaume Kerberos</label>
            <input
              id="addns-realm"
              value={form.realm}
              onChange={(event) => setForm((f) => ({ ...f, realm: event.target.value }))}
              placeholder="LECREUSOT.FR"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="addns-kdc">Contrôleur de domaine (KDC / serveur DNS)</label>
            <input
              id="addns-kdc"
              value={form.kdcHost}
              onChange={(event) => setForm((f) => ({ ...f, kdcHost: event.target.value }))}
              placeholder="dc01.lecreusot.fr"
              required
            />
            <p className="create-container-hint">
              Ce nom sert aussi à rattacher automatiquement le module métier AD/DNS au nœud de la VM correspondante
              dans le graphe — utilisez le nom réel de la VM contrôleur de domaine.
            </p>
          </div>
          <div className="field">
            <label htmlFor="addns-zone">Zone DNS</label>
            <input
              id="addns-zone"
              value={form.zone}
              onChange={(event) => setForm((f) => ({ ...f, zone: event.target.value }))}
              placeholder="lecreusot.fr"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="addns-account">Compte de service (droit "Dynamic Update" sur la zone)</label>
            <input
              id="addns-account"
              value={form.serviceAccount}
              onChange={(event) => setForm((f) => ({ ...f, serviceAccount: event.target.value }))}
              placeholder="svc-quai-dns"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="addns-password">Mot de passe{configured ? " (laisser vide pour conserver l'existant)" : ""}</label>
            <input
              id="addns-password"
              type="password"
              value={form.password ?? ""}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              autoComplete="new-password"
              {...(configured ? {} : { required: true })}
            />
          </div>
          <div className="field">
            <label htmlFor="addns-target-ip">IP cible des enregistrements A</label>
            <input
              id="addns-target-ip"
              value={form.targetIp}
              onChange={(event) => setForm((f) => ({ ...f, targetIp: event.target.value }))}
              placeholder="10.0.0.5"
              required
            />
            <p className="create-container-hint">
              IP LAN de la machine qui publie les ports 80/443 de Caddy — c'est vers cette IP que pointeront les
              enregistrements DNS créés.
            </p>
          </div>

          {testResult && (
            <div className={testResult.ok ? "success-banner" : "error-banner"}>
              {testResult.ok ? <IconCheck /> : null} {testResult.message}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing || !isFormValid()}>
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !isFormValid()}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            {configured && (
              <button type="button" className="btn btn-ghost" onClick={closeForm}>
                Annuler
              </button>
            )}
          </div>
        </form>
      )}

      {!admin && !configured && (
        <div className="empty-state">Seul un administrateur peut configurer la synchronisation DNS AD.</div>
      )}
    </>
  );
}

/**
 * Diagnostic d'un compte de l'annuaire — lecture seule, réservé aux admins. Vivait sur l'ancienne
 * page « DNS Active Directory » ; rejoint les Réglages avec le formulaire ci-dessus.
 */
export function LdapAccountDiagnosticSection() {
  const dispatch = useAppDispatch();
  const { diagnosing, diagnosis, diagnosisError } = useAppSelector((s) => s.adDns);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);

  const [diagnoseUsername, setDiagnoseUsername] = useState("");

  if (!admin) return null;

  async function handleDiagnose(event: FormEvent) {
    event.preventDefault();
    const username = diagnoseUsername.trim();
    if (!username) return;
    await dispatch(diagnoseLdapAccount(username));
  }

  function handleDiagnoseReset() {
    setDiagnoseUsername("");
    dispatch(clearLdapDiagnosis());
  }

  return (
    <form className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleDiagnose}>
      <div>
        <h3 style={{ margin: 0 }}>Diagnostiquer un compte</h3>
        <p className="create-container-hint" style={{ marginTop: 4 }}>
          Explique pourquoi un compte de l'annuaire n'arrive pas à se connecter : présence dans la base de recherche,
          DN réel, groupes, rôles qui lui seraient attribués et état du compte (désactivé, verrouillé, mot de passe
          expiré ou à changer). Lecture seule, aucun mot de passe demandé — aucune tentative de connexion n'est faite,
          le compteur de verrouillage Active Directory n'est jamais incrémenté.
        </p>
      </div>
      <div className="field">
        <label htmlFor="ldap-diagnose-username">Identifiant (sAMAccountName ou userPrincipalName)</label>
        <input
          id="ldap-diagnose-username"
          value={diagnoseUsername}
          onChange={(event) => setDiagnoseUsername(event.target.value)}
          placeholder="prenom.nom ou pnom@lecreusot.priv"
          autoComplete="off"
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={diagnosing || !diagnoseUsername.trim()}>
          {diagnosing ? "Diagnostic en cours…" : "Diagnostiquer"}
        </button>
        {(diagnosis || diagnosisError) && (
          <button type="button" className="btn btn-ghost" onClick={handleDiagnoseReset}>
            Effacer
          </button>
        )}
      </div>
      {diagnosisError && <div className="error-banner">{diagnosisError}</div>}
      {diagnosis && <DiagnosisReport diagnosis={diagnosis} />}
    </form>
  );
}
