import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createNotificationChannel,
  deleteNotificationChannel,
  fetchNotificationChannels,
  testNotificationChannel,
  updateNotificationChannel,
  type NotificationChannelFormInput,
} from "@/features/notificationChannels/notificationChannelsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { IconBell, IconPlus, IconTrash } from "@/components/icons";
import type { NotificationChannelKind, NotificationChannelRef, SystemNotificationKind } from "@/types";

const KIND_LABEL: Record<NotificationChannelKind, string> = {
  webhook: "Webhook générique",
  slack: "Slack",
  discord: "Discord",
  email: "Email (SMTP)",
};

const LEVEL_OPTIONS: { value: "error" | "success" | "info"; label: string }[] = [
  { value: "error", label: "Erreur" },
  { value: "success", label: "Succès" },
  { value: "info", label: "Info" },
];

const EVENT_KIND_OPTIONS: { value: SystemNotificationKind; label: string }[] = [
  { value: "image_update_available", label: "Nouvelle version d'image" },
  { value: "integration_unreachable", label: "Intégration injoignable" },
  { value: "integration_reachable", label: "Intégration de nouveau joignable" },
  { value: "gitops_drift_detected", label: "Dérive GitOps" },
  { value: "vulnerability_detected", label: "Vulnérabilité détectée" },
];

interface FormState {
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  levels: string[];
  kinds: string[];
  webhookUrl: string;
  slackWebhookUrl: string;
  discordWebhookUrl: string;
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpSecure: boolean;
  fromAddress: string;
  toAddress: string;
}

const EMPTY_FORM: FormState = {
  kind: "webhook",
  name: "",
  enabled: true,
  levels: [],
  kinds: [],
  webhookUrl: "",
  slackWebhookUrl: "",
  discordWebhookUrl: "",
  smtpHost: "",
  smtpPort: "587",
  smtpUsername: "",
  smtpPassword: "",
  smtpSecure: false,
  fromAddress: "",
  toAddress: "",
};

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function filterSummary(channel: NotificationChannelRef): string {
  if (!channel.filter || (!channel.filter.levels?.length && !channel.filter.kinds?.length)) {
    return "Tous les événements";
  }
  const parts: string[] = [];
  if (channel.filter.levels?.length) {
    parts.push(channel.filter.levels.map((l) => LEVEL_OPTIONS.find((o) => o.value === l)?.label ?? l).join("/"));
  }
  if (channel.filter.kinds?.length) {
    parts.push(`${channel.filter.kinds.length} type(s) d'événement`);
  }
  return parts.join(" · ");
}

/**
 * Gestion des canaux de notification sortants (webhook générique/Slack/Discord/email SMTP) — cf.
 * ARCHITECTURE.md, chapitre "Notifications sortantes vers canaux externes". Chaque événement
 * système (watchdog, réconciliateur GitOps, scan automatique — voir GET /api/notifications) est
 * routé, en tâche de fond, vers chaque canal actif dont le filtre matche — jamais bloquant côté
 * serveur. Accès réservé aux admins, même pattern que AdDnsPage.tsx (formulaire, bouton "Tester",
 * statut, canAdminister(session)).
 */
export default function NotificationChannelsPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, creating, updatingId, deletingId, testingId, testResultById } = useAppSelector(
    (s) => s.notificationChannels,
  );
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    dispatch(fetchNotificationChannels());
  }, [dispatch]);

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEditForm(channel: NotificationChannelRef) {
    setEditingId(channel.id);
    setForm({
      ...EMPTY_FORM,
      kind: channel.kind,
      name: channel.name,
      enabled: channel.enabled,
      levels: channel.filter?.levels ?? [],
      kinds: channel.filter?.kinds ?? [],
      ...(channel.email
        ? {
            smtpHost: channel.email.smtpHost,
            smtpPort: String(channel.email.smtpPort),
            smtpUsername: channel.email.smtpUsername ?? "",
            smtpSecure: channel.email.smtpSecure,
            fromAddress: channel.email.fromAddress,
            toAddress: channel.email.toAddress,
          }
        : {}),
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function buildInput(): NotificationChannelFormInput {
    const filter =
      form.levels.length > 0 || form.kinds.length > 0
        ? {
            ...(form.levels.length > 0 ? { levels: form.levels as ("error" | "success" | "info")[] } : {}),
            ...(form.kinds.length > 0 ? { kinds: form.kinds as SystemNotificationKind[] } : {}),
          }
        : undefined;

    return {
      kind: form.kind,
      name: form.name.trim(),
      enabled: form.enabled,
      ...(filter ? { filter } : { clearFilter: true }),
      ...(form.kind === "webhook" ? { webhook: { url: form.webhookUrl.trim() } } : {}),
      ...(form.kind === "slack" ? { slack: { webhookUrl: form.slackWebhookUrl.trim() } } : {}),
      ...(form.kind === "discord" ? { discord: { webhookUrl: form.discordWebhookUrl.trim() } } : {}),
      ...(form.kind === "email"
        ? {
            email: {
              smtpHost: form.smtpHost.trim(),
              smtpPort: Number(form.smtpPort) || 587,
              smtpSecure: form.smtpSecure,
              fromAddress: form.fromAddress.trim(),
              toAddress: form.toAddress.trim(),
              ...(form.smtpUsername.trim() ? { smtpUsername: form.smtpUsername.trim() } : {}),
              ...(form.smtpPassword ? { smtpPassword: form.smtpPassword } : {}),
            },
          }
        : {}),
    };
  }

  function isFormValid(): boolean {
    if (!form.name.trim()) return false;
    if (form.kind === "webhook") return editingId ? true : !!form.webhookUrl.trim();
    if (form.kind === "slack") return editingId ? true : !!form.slackWebhookUrl.trim();
    if (form.kind === "discord") return editingId ? true : !!form.discordWebhookUrl.trim();
    if (form.kind === "email") {
      return editingId
        ? !!(form.smtpHost.trim() && form.fromAddress.trim() && form.toAddress.trim())
        : !!(form.smtpHost.trim() && form.fromAddress.trim() && form.toAddress.trim());
    }
    return false;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const input = buildInput();
    const result = editingId
      ? await dispatch(updateNotificationChannel({ id: editingId, patch: input }))
      : await dispatch(createNotificationChannel(input));
    if (createNotificationChannel.fulfilled.match(result) || updateNotificationChannel.fulfilled.match(result)) {
      closeForm();
    }
  }

  async function handleDelete(channel: NotificationChannelRef) {
    const ok = await confirm({
      title: "Supprimer ce canal de notification",
      description: `Confirmer la suppression de "${channel.name}" ? Les futurs événements système ne lui seront plus envoyés.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteNotificationChannel(channel.id));
  }

  function handleToggleEnabled(channel: NotificationChannelRef) {
    dispatch(updateNotificationChannel({ id: channel.id, patch: { enabled: !channel.enabled } }));
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Canaux de notification</h2>
            <p>
              Route les événements système (nouvelle version d'image, intégration injoignable, dérive GitOps,
              vulnérabilité critique — voir Notifications) vers des canaux externes : webhook générique, Slack,
              Discord ou email SMTP.
            </p>
          </div>
          {admin && (
            <button type="button" className="btn btn-primary btn-sm" onClick={formOpen ? closeForm : openCreateForm}>
              <IconPlus /> {formOpen ? "Annuler" : "Nouveau canal"}
            </button>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {formOpen && admin && (
          <form className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="channel-kind">Type de canal</label>
              <select
                id="channel-kind"
                value={form.kind}
                onChange={(event) => setForm((f) => ({ ...f, kind: event.target.value as NotificationChannelKind }))}
                disabled={!!editingId}
              >
                {(Object.keys(KIND_LABEL) as NotificationChannelKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="channel-name">Nom</label>
              <input
                id="channel-name"
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="ex : Astreinte IT mairie"
                required
              />
            </div>

            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((f) => ({ ...f, enabled: event.target.checked }))}
              />
              Canal actif
            </label>

            {form.kind === "webhook" && (
              <div className="field">
                <label htmlFor="channel-webhook-url">URL du webhook</label>
                <input
                  id="channel-webhook-url"
                  value={form.webhookUrl}
                  onChange={(event) => setForm((f) => ({ ...f, webhookUrl: event.target.value }))}
                  placeholder="https://…"
                  {...(editingId ? {} : { required: true })}
                />
                {editingId && <p className="create-container-hint">Laisser vide pour conserver l'URL déjà enregistrée.</p>}
                <p className="create-container-hint">
                  Envoi d'un POST JSON brut (le `SystemNotificationEvent` tel quel) à chaque événement matché.
                </p>
              </div>
            )}

            {form.kind === "slack" && (
              <div className="field">
                <label htmlFor="channel-slack-url">URL du webhook Slack</label>
                <input
                  id="channel-slack-url"
                  value={form.slackWebhookUrl}
                  onChange={(event) => setForm((f) => ({ ...f, slackWebhookUrl: event.target.value }))}
                  placeholder="https://hooks.slack.com/services/…"
                  {...(editingId ? {} : { required: true })}
                />
                {editingId && <p className="create-container-hint">Laisser vide pour conserver l'URL déjà enregistrée.</p>}
              </div>
            )}

            {form.kind === "discord" && (
              <div className="field">
                <label htmlFor="channel-discord-url">URL du webhook Discord</label>
                <input
                  id="channel-discord-url"
                  value={form.discordWebhookUrl}
                  onChange={(event) => setForm((f) => ({ ...f, discordWebhookUrl: event.target.value }))}
                  placeholder="https://discord.com/api/webhooks/…"
                  {...(editingId ? {} : { required: true })}
                />
                {editingId && <p className="create-container-hint">Laisser vide pour conserver l'URL déjà enregistrée.</p>}
              </div>
            )}

            {form.kind === "email" && (
              <>
                <div className="field">
                  <label htmlFor="channel-smtp-host">Hôte SMTP</label>
                  <input
                    id="channel-smtp-host"
                    value={form.smtpHost}
                    onChange={(event) => setForm((f) => ({ ...f, smtpHost: event.target.value }))}
                    placeholder="smtp.lecreusot.fr"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-smtp-port">Port SMTP</label>
                  <input
                    id="channel-smtp-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.smtpPort}
                    onChange={(event) => setForm((f) => ({ ...f, smtpPort: event.target.value }))}
                    required
                  />
                </div>
                <label className="filter-toggle">
                  <input
                    type="checkbox"
                    checked={form.smtpSecure}
                    onChange={(event) => setForm((f) => ({ ...f, smtpSecure: event.target.checked }))}
                  />
                  TLS implicite (port 465 typiquement)
                </label>
                <div className="field">
                  <label htmlFor="channel-smtp-username">Utilisateur SMTP (optionnel)</label>
                  <input
                    id="channel-smtp-username"
                    value={form.smtpUsername}
                    onChange={(event) => setForm((f) => ({ ...f, smtpUsername: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-smtp-password">
                    Mot de passe SMTP{editingId ? " (laisser vide pour conserver l'existant)" : " (optionnel)"}
                  </label>
                  <input
                    id="channel-smtp-password"
                    type="password"
                    value={form.smtpPassword}
                    onChange={(event) => setForm((f) => ({ ...f, smtpPassword: event.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-from">Adresse expéditrice</label>
                  <input
                    id="channel-from"
                    value={form.fromAddress}
                    onChange={(event) => setForm((f) => ({ ...f, fromAddress: event.target.value }))}
                    placeholder="quai@lecreusot.fr"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-to">Adresse destinataire</label>
                  <input
                    id="channel-to"
                    value={form.toAddress}
                    onChange={(event) => setForm((f) => ({ ...f, toAddress: event.target.value }))}
                    placeholder="astreinte-it@lecreusot.fr"
                    required
                  />
                </div>
              </>
            )}

            <div className="field">
              <label>Filtre par niveau (aucune case cochée = tous les niveaux)</label>
              <div className="chip-row">
                {LEVEL_OPTIONS.map((option) => (
                  <label key={option.value} className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={form.levels.includes(option.value)}
                      onChange={() => setForm((f) => ({ ...f, levels: toggleInList(f.levels, option.value) }))}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Filtre par type d'événement (aucune case cochée = tous les types)</label>
              <div className="chip-row" style={{ flexWrap: "wrap" }}>
                {EVENT_KIND_OPTIONS.map((option) => (
                  <label key={option.value} className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={form.kinds.includes(option.value)}
                      onChange={() => setForm((f) => ({ ...f, kinds: toggleInList(f.kinds, option.value) }))}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating || !!updatingId || !isFormValid()}>
                {creating || updatingId ? "Enregistrement…" : editingId ? "Enregistrer" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={closeForm}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {status !== "loading" && items.length === 0 && (
          <div className="empty-state">Aucun canal de notification configuré.</div>
        )}

        {items.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Type</th>
                  <th>Filtre</th>
                  <th>Actif</th>
                  <th>Test</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((channel) => {
                  const testResult = testResultById[channel.id];
                  return (
                    <tr key={channel.id}>
                      <td className="cell-primary">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <IconBell /> {channel.name}
                        </span>
                      </td>
                      <td>{KIND_LABEL[channel.kind]}</td>
                      <td>{filterSummary(channel)}</td>
                      <td>
                        <label className="filter-toggle">
                          <input
                            type="checkbox"
                            checked={channel.enabled}
                            disabled={!admin || updatingId === channel.id}
                            onChange={() => handleToggleEnabled(channel)}
                          />
                          {channel.enabled ? "Oui" : "Non"}
                        </label>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={testingId === channel.id}
                          onClick={() => dispatch(testNotificationChannel(channel.id))}
                        >
                          {testingId === channel.id ? "Test…" : "Tester"}
                        </button>
                        {testResult && (
                          <span
                            style={{
                              marginLeft: 8,
                              color: testResult.ok ? "var(--color-success, #2e7d32)" : "var(--color-critical, #c62828)",
                            }}
                          >
                            {testResult.ok ? "OK" : testResult.message}
                          </span>
                        )}
                      </td>
                      <td className="cell-actions">
                        {admin && (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEditForm(channel)}>
                              Modifier
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn--danger"
                              title="Supprimer"
                              aria-label="Supprimer"
                              disabled={deletingId === channel.id}
                              onClick={() => handleDelete(channel)}
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!admin && items.length === 0 && (
          <div className="empty-state">Seul un administrateur peut configurer les canaux de notification.</div>
        )}
      </div>
    </div>
  );
}
