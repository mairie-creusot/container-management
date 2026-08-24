import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  disableNutanix,
  fetchNutanixConfig,
  saveNutanixConfig,
  type NutanixConfigFormInput,
} from "@/features/clusters/clustersSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconVm } from "@/components/icons";

const EMPTY_NUTANIX_FORM: NutanixConfigFormInput = { prismCentralUrl: "", username: "", password: "" };

/**
 * Configuration Prism Central (routes/nutanix.ts) — EN DEHORS de l'assistant de premier lancement,
 * qui reste inaccessible une fois terminé sans repasser par POST /api/setup/reset.
 *
 * Vivait dans la page Environnements ; extrait le 24/08/2026 pour la page Réglages, SEULE source de
 * vérité de ce formulaire. La page Environnements n'affiche plus que les VMs/clusters réels et un
 * renvoi ici quand rien n'est configuré.
 */
export default function NutanixConfigSection() {
  const dispatch = useAppDispatch();
  const { nutanixConfigured, nutanixConfig, nutanixConfigStatus, nutanixConfigSaving, nutanixConfigError } =
    useAppSelector((s) => s.clusters);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<NutanixConfigFormInput>(EMPTY_NUTANIX_FORM);

  useEffect(() => {
    if (nutanixConfigStatus === "idle") dispatch(fetchNutanixConfig());
  }, [dispatch, nutanixConfigStatus]);

  useEffect(() => {
    if (nutanixConfig) setForm({ ...nutanixConfig, password: "" });
  }, [nutanixConfig]);

  function openForm() {
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    setForm(nutanixConfig ? { ...nutanixConfig, password: "" } : EMPTY_NUTANIX_FORM);
  }

  function isFormValid(): boolean {
    const hasPassword = !!form.password?.trim() || nutanixConfigured;
    return !!(form.prismCentralUrl.trim() && form.username.trim() && hasPassword);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(
      saveNutanixConfig({
        prismCentralUrl: form.prismCentralUrl.trim(),
        username: form.username.trim(),
        ...(form.password?.trim() ? { password: form.password.trim() } : {}),
      }),
    );
    if (saveNutanixConfig.fulfilled.match(result)) setEditing(false);
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration Nutanix ?",
      description: "Les VMs/clusters Nutanix disparaîtront du graphe de topologie et de la page Environnements.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableNutanix());
    setForm(EMPTY_NUTANIX_FORM);
  }

  const showForm = editing || !nutanixConfigured;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Nutanix</h3>
          <p>
            Prism Central (API v3) — VMs et clusters physiques réels, visibles dans la page Environnements et dans le
            graphe de topologie une fois configuré. Jamais de VM/cluster fabriqué si injoignable ou non configuré.
          </p>
        </div>
        {admin && nutanixConfigured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openForm}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable}>
              Retirer
            </button>
          </div>
        )}
      </div>

      {nutanixConfigError && <div className="error-banner" style={{ marginBottom: 16 }}>{nutanixConfigError}</div>}

      {nutanixConfigStatus !== "loading" && nutanixConfigured && !editing && nutanixConfig && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconVm />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL Prism Central", value: nutanixConfig.prismCentralUrl },
              { key: "Utilisateur", value: nutanixConfig.username },
            ]}
          />
        </div>
      )}

      {nutanixConfigStatus !== "loading" && !nutanixConfigured && !showForm && (
        <div className="empty-state" style={{ marginBottom: 16 }}>Nutanix non configuré.</div>
      )}

      {admin && showForm && (
        <form
          className="card"
          style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={handleSave}
        >
          <div className="field">
            <label htmlFor="nutanix-url">URL Prism Central</label>
            <input
              id="nutanix-url"
              value={form.prismCentralUrl}
              onChange={(event) => setForm((f) => ({ ...f, prismCentralUrl: event.target.value }))}
              placeholder="https://prism.lecreusot.fr:9440"
              disabled={nutanixConfigSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="nutanix-username">Utilisateur</label>
            <input
              id="nutanix-username"
              value={form.username}
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
              disabled={nutanixConfigSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="nutanix-password">
              Mot de passe{nutanixConfigured ? " (laisser vide pour conserver l'existant)" : ""}
            </label>
            <input
              id="nutanix-password"
              type="password"
              value={form.password ?? ""}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              autoComplete="new-password"
              disabled={nutanixConfigSaving}
              {...(nutanixConfigured ? {} : { required: true })}
            />
          </div>
          <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
            La connexion à Prism Central est réellement testée avant l'enregistrement — jamais persisté à l'aveugle.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={nutanixConfigSaving || !isFormValid()}>
              {nutanixConfigSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            {nutanixConfigured && (
              <button type="button" className="btn btn-ghost" onClick={closeForm}>
                Annuler
              </button>
            )}
          </div>
        </form>
      )}

      {!admin && !nutanixConfigured && (
        <div className="empty-state" style={{ marginBottom: 24 }}>
          Seul un administrateur peut configurer Nutanix.
        </div>
      )}
    </>
  );
}
