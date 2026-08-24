import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  clearHycuTestResult,
  disableHycu,
  fetchHycuConfig,
  fetchHycuStatus,
  saveHycuConfig,
  testHycuConfig,
  type HycuConfigFormInput,
} from "@/features/hycu/hycuSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconBackup, IconCheck } from "@/components/icons";

const EMPTY_FORM: HycuConfigFormInput = { url: "", username: "", password: "" };

/**
 * Formulaire de connexion au contrôleur de sauvegarde HYCU, destiné à la page Réglages.
 * La connexion est réellement testée par le serveur avant d'être persistée.
 */
export default function HycuConnectionForm({ onSaved }: { onSaved?: () => void }) {
  const dispatch = useAppDispatch();
  const { configured, config, configStatus, configSaving, configError, clearing, testing, testResult } = useAppSelector(
    (s) => s.hycu,
  );
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<HycuConfigFormInput>(EMPTY_FORM);

  useEffect(() => {
    if (configStatus === "idle") dispatch(fetchHycuConfig());
  }, [dispatch, configStatus]);

  useEffect(() => {
    if (config) setForm({ url: config.url, username: config.username, password: "" });
  }, [config]);

  function closeForm() {
    setEditing(false);
    dispatch(clearHycuTestResult());
    setForm(config ? { url: config.url, username: config.username, password: "" } : EMPTY_FORM);
  }

  function currentInput(): HycuConfigFormInput {
    return {
      url: form.url.trim(),
      username: form.username.trim(),
      ...(form.password?.trim() ? { password: form.password.trim() } : {}),
    };
  }

  function isFormValid(): boolean {
    const input = currentInput();
    // password vide autorisé seulement si une config existe déjà (le serveur conserve l'existant).
    const hasPassword = !!input.password || configured;
    return !!(input.url && input.username && hasPassword);
  }

  async function handleTest() {
    if (!isFormValid()) return;
    await dispatch(testHycuConfig(currentInput()));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(saveHycuConfig(currentInput()));
    if (saveHycuConfig.fulfilled.match(result)) {
      setEditing(false);
      dispatch(clearHycuTestResult());
      dispatch(fetchHycuStatus());
      onSaved?.();
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration HYCU ?",
      description:
        "QUAI n'interrogera plus le contrôleur de sauvegarde — les VM protégées, politiques, cibles, jobs et événements disparaîtront de la page Sauvegardes. Aucune donnée n'est modifiée côté HYCU.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableHycu());
    setForm(EMPTY_FORM);
    setEditing(false);
  }

  if (!admin) {
    return <div className="empty-state">Seul un administrateur peut configurer la connexion au contrôleur HYCU.</div>;
  }

  const showForm = editing || !configured;

  return (
    <section className="settings-form">
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Contrôleur de sauvegarde (HYCU)</h3>
          <p>
            Connexion à l'API REST du contrôleur HYCU, en lecture seule. La connexion est réellement testée avant
            l'enregistrement — jamais persistée à l'aveugle.
          </p>
        </div>
        {configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                dispatch(clearHycuTestResult());
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

      {configError && <div className="error-banner" style={{ marginBottom: 16 }}>{configError}</div>}

      {testResult && (
        <div className={testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {testResult.ok && <IconCheck />}
          {testResult.message}
          {testResult.ok && typeof testResult.vmCount === "number" && ` — ${testResult.vmCount} VM visible(s)`}
        </div>
      )}

      {configStatus !== "loading" && configured && !editing && config && (
        <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span style={{ display: "inline-flex" }}>
              <IconBackup />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL du contrôleur", value: config.url },
              { key: "Utilisateur", value: config.username },
            ]}
          />
        </div>
      )}

      {showForm && (
        <form className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
          <div className="field">
            <label htmlFor="hycu-url">URL du contrôleur HYCU</label>
            <input
              id="hycu-url"
              value={form.url}
              onChange={(event) => setForm((f) => ({ ...f, url: event.target.value }))}
              placeholder="https://172.20.0.100:8443"
              disabled={configSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hycu-username">Utilisateur</label>
            <input
              id="hycu-username"
              value={form.username}
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
              disabled={configSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hycu-password">
              Mot de passe{configured ? " (laisser vide pour conserver l'existant)" : ""}
            </label>
            <input
              id="hycu-password"
              type="password"
              value={form.password ?? ""}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              autoComplete="new-password"
              disabled={configSaving}
              {...(configured ? {} : { required: true })}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={configSaving || !isFormValid()}>
              {configSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleTest}
              disabled={configSaving || testing || !isFormValid()}
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
