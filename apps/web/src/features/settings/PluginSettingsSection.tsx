import { useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { useConfirm } from "@/components/ConfirmProvider";
import KeyValueList, { type KeyValueRow } from "@/components/KeyValueList";
import StatusPill from "@/components/StatusPill";
import { IconCheck, IconInfo } from "@/components/icons";
import SchemaForm, {
  isSecretField,
  type FormSchema,
  type SchemaField,
  type SchemaValues,
} from "@/components/SchemaForm";
import { formSchemaFromManifest } from "@/components/formSchemaFromManifest";
import {
  initialValuesFrom,
  storedSecretsFrom,
  visibleInStoredConfig,
} from "@/features/plugins/pluginConfigModel";
import {
  clearPluginConfigError,
  clearPluginTestResult,
  fetchPlugins,
  pluginConfigOf,
  removePluginConfig,
  savePluginConfig,
  testPluginConfig,
} from "@/features/plugins/pluginsSlice";
import PluginEnableCard from "@/features/settings/PluginEnableCard";
import { refreshDedicatedViews } from "@/features/settings/pluginConfigRefresh";

/** Valeur que le serveur n'a pas communiquée — jamais remplacée par une valeur plausible. */
const MISSING = "—";
const NO_FIELDS: readonly SchemaField[] = [];
const NO_SECRETS: readonly string[] = [];

/** Récapitulatif de la configuration enregistrée, lu dans la vue SÛRE : un secret n'y est qu'un
 * booléen de présence, il n'est donc jamais réaffiché, même tronqué. */
function summaryRows(
  fields: readonly SchemaField[],
  config: Readonly<Record<string, unknown>>,
  storedSecrets: readonly string[],
): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  for (const field of fields) {
    if (!visibleInStoredConfig(field, config)) continue;
    if (isSecretField(field)) {
      rows.push({
        key: field.label,
        value: storedSecrets.includes(field.name) ? "Enregistré et chiffré — jamais réaffiché" : "Non enregistré",
      });
      continue;
    }
    const raw = config[field.name];
    if (field.type === "boolean") {
      rows.push({ key: field.label, value: raw === true ? "Activée" : raw === false ? "Désactivée" : MISSING });
      continue;
    }
    if (field.type === "enum") {
      const option = field.options.find((entry) => entry.value === raw);
      rows.push({ key: field.label, value: option?.label ?? (typeof raw === "string" ? raw : MISSING) });
      continue;
    }
    rows.push({ key: field.label, value: typeof raw === "string" || typeof raw === "number" ? String(raw) : MISSING });
  }
  return rows;
}

/**
 * Section de réglages GÉNÉRÉE : champs, libellés, aides et bascules viennent du manifeste renvoyé
 * par GET /api/plugins, les valeurs de la vue sûre de GET /api/plugins/:id/config. Rien n'est écrit
 * ici par intégration — un greffon inconnu obtient le même écran sans une ligne de code de plus.
 */
export default function PluginSettingsSection({ pluginId }: { pluginId: string }) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const summary = useAppSelector((state) => state.plugins.items.find((entry) => entry.manifest.id === pluginId));
  const entry = useAppSelector((state) => pluginConfigOf(state.plugins, pluginId));
  const [editing, setEditing] = useState(false);

  const conversion = useMemo(
    () => (summary ? formSchemaFromManifest(summary.manifest.configSchema, summary.manifest.secretFields) : null),
    [summary],
  );
  const fields = useMemo<readonly SchemaField[]>(
    () => (conversion !== null && conversion.ok ? conversion.schema.fields : NO_FIELDS),
    [conversion],
  );
  const schema = useMemo<FormSchema>(() => ({ fields: [...fields] }), [fields]);
  const secretFields = useMemo<readonly string[]>(() => {
    const raw: unknown = summary?.manifest.secretFields;
    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : NO_SECRETS;
  }, [summary]);

  const storedSecrets = useMemo(() => storedSecretsFrom(secretFields, entry.config), [secretFields, entry.config]);
  const initialValues = useMemo(() => initialValuesFrom(fields, entry.config), [fields, entry.config]);
  const rows = useMemo(() => summaryRows(fields, entry.config, storedSecrets), [fields, entry.config, storedSecrets]);

  if (!summary) {
    return (
      <>
        <div className="page-header" style={{ marginTop: 0 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Greffon « {pluginId} »</h3>
            <p>Section apportée par un greffon : son formulaire est déduit du manifeste renvoyé par le serveur.</p>
          </div>
        </div>
        <div className="empty-state">
          <IconInfo />
          <strong>Manifeste indisponible</strong>
          <span>
            GET /api/plugins n'a pas renvoyé ce greffon : aucun formulaire ne peut en être déduit, et rien n'est
            deviné à sa place.
          </span>
        </div>
      </>
    );
  }

  const manifest = summary.manifest;
  const name = typeof manifest.name === "string" && manifest.name.trim().length > 0 ? manifest.name : manifest.id;
  const loading = entry.status === "idle" || entry.status === "loading";
  const showForm = editing || (!loading && !entry.configured);

  function openForm() {
    dispatch(clearPluginTestResult(pluginId));
    dispatch(clearPluginConfigError(pluginId));
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    dispatch(clearPluginTestResult(pluginId));
    dispatch(clearPluginConfigError(pluginId));
  }

  async function handleSave(values: SchemaValues) {
    const action = await dispatch(savePluginConfig({ pluginId, config: values }));
    const saved = savePluginConfig.fulfilled.match(action) && action.payload.ok;
    // Échec : on LÈVE pour que SchemaForm conserve la saisie, secrets compris, et montre `error`.
    if (!saved) throw new Error("Enregistrement refusé par le serveur.");
    setEditing(false);
    void dispatch(fetchPlugins());
    refreshDedicatedViews(pluginId, dispatch);
  }

  async function handleTest(values: SchemaValues) {
    await dispatch(testPluginConfig({ pluginId, config: values }));
  }

  /** Corps vide : le serveur complète avec la configuration enregistrée, secrets compris. */
  async function handleTestStored() {
    await dispatch(testPluginConfig({ pluginId, config: {} }));
  }

  async function handleRemove() {
    const ok = await confirm({
      title: `Retirer la configuration ${name} ?`,
      description:
        "QUAI n'interrogera plus cette intégration : les données qu'elle apporte disparaîtront des pages qui les affichent. Les identifiants enregistrés sont effacés. Rien n'est modifié du côté de l'intégration.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    const action = await dispatch(removePluginConfig(pluginId));
    if (removePluginConfig.fulfilled.match(action) && action.payload.ok) {
      setEditing(false);
      void dispatch(fetchPlugins());
      refreshDedicatedViews(pluginId, dispatch);
    }
  }

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>{name}</h3>
          <p>
            Formulaire déduit du manifeste du greffon « {manifest.id} ». La connexion est réellement testée par le
            serveur avant tout enregistrement — une configuration qui ne fonctionne pas n'est jamais persistée.
          </p>
        </div>
        {entry.configured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleTestStored()}
              disabled={entry.testing}
            >
              {entry.testing ? "Test en cours…" : "Tester la connexion"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openForm}>
              Modifier
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleRemove()}
              disabled={entry.clearing}
            >
              {entry.clearing ? "Retrait…" : "Retirer"}
            </button>
          </div>
        )}
      </div>

      <PluginEnableCard pluginId={pluginId} />

      {conversion !== null && !conversion.ok && (
        <div className="error-banner schema-form__rejected" role="alert" style={{ marginBottom: 16 }}>
          <p>Ce formulaire ne peut pas être affiché : le manifeste de ce greffon n'est pas convertible.</p>
          <ul>
            {conversion.problems.map((problem, index) => (
              <li key={`${index}-${problem}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Le formulaire porte lui-même `error` quand il est ouvert : sinon la bannière prend le relais. */}
      {entry.error && !showForm && (
        <div className="error-banner" role="alert" style={{ marginBottom: 16 }}>
          {entry.error}
        </div>
      )}

      {entry.testResult && (
        <div className={entry.testResult.ok ? "success-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {entry.testResult.ok && <IconCheck />}
          {entry.testResult.message}
        </div>
      )}

      {loading && <div className="empty-state">Lecture de la configuration enregistrée…</div>}

      {!loading && entry.configured && !editing && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList rows={rows} />
        </div>
      )}

      {showForm && fields.length > 0 && (
        <SchemaForm
          schema={schema}
          onSubmit={handleSave}
          onTest={handleTest}
          initialValues={initialValues}
          storedSecrets={storedSecrets}
          error={entry.error}
          submitting={entry.saving}
          testing={entry.testing}
          submitLabel="Enregistrer"
          submittingLabel="Test et enregistrement…"
          idPrefix={`plugin-${pluginId}`}
          resetKey={`${entry.revision}:${editing ? "edit" : "view"}`}
          {...(entry.configured ? { onCancel: closeForm } : {})}
        />
      )}
    </>
  );
}
