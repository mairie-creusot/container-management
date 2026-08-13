import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearAdDnsTestResult,
  disableAdDns,
  fetchAdDnsStatus,
  saveAdDnsConfig,
  testAdDnsConfig,
  type AdDnsFormInput,
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

/**
 * Configuration de la synchronisation DNS Active Directory (RFC 2136 + GSS-TSIG, voir
 * apps/api/src/services/adDns.ts) — quand elle est activée, chaque route de reverse proxy créée
 * pousse réellement son enregistrement DNS dans l'AD de la mairie : plus besoin d'entrée manuelle
 * de fichier hosts pour que *.lecreusot.priv résolve sur le réseau (voir ReverseProxyPage.tsx pour
 * le statut par route).
 */
export default function AdDnsPage() {
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
  // uniquement — voir AdDnsFormInput#password) — permet de modifier realm/KDC/zone/IP cible sans
  // ressaisir le mot de passe du compte de service à chaque fois.
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
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>DNS Active Directory</h2>
            <p>
              Synchronisation dynamique sécurisée (RFC 2136 + GSS-TSIG) : chaque route du reverse proxy pousse son
              enregistrement DNS dans l'AD de la mairie — plus besoin d'entrée manuelle de fichier hosts.
            </p>
          </div>
          {admin && configured && !editing && (
            <div style={{ display: "flex", gap: 8 }}>
              {/* Teste le compte de service déjà enregistré (kinit uniquement, aucun enregistrement
                  DNS écrit) SANS repasser par "Modifier" — `form` est déjà pré-rempli avec la config
                  effective (voir l'effet ci-dessus) et `isFormValid()` n'exige pas de mot de passe
                  quand `configured` est vrai, donc `handleTest()` réutilise tel quel le mot de passe
                  déjà stocké côté serveur (routes/adDns.ts : password vide = conserver l'existant). */}
              <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing}>
                {testing ? "Test en cours…" : "Tester la connexion"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={openForm}>
                Modifier
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleDisable} disabled={clearing}>
                {clearing ? "Désactivation…" : "Désactiver"}
              </button>
            </div>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {status !== "loading" && !configured && !showForm && (
          <div className="empty-state">Synchronisation DNS AD non configurée.</div>
        )}

        {configured && !editing && config && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="chip-row">
              <span className="topology-detail-panel__icon topology-detail-panel__icon--ad-server" style={{ display: "inline-flex" }}>
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
          <form className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
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
      </div>
    </div>
  );
}
