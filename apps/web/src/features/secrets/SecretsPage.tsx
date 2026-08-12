import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createSecret,
  deleteSecret,
  fetchSecrets,
  fetchSecretVersions,
  revealSecret,
  updateSecret,
} from "@/features/secrets/secretsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { setCurrentView, setSearchQuery, setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Modal from "@/components/Modal";
import { SkeletonTable } from "@/components/Skeleton";
import {
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHistory,
  IconPlus,
  IconSettings,
  IconTrash,
} from "@/components/icons";
import type { SecretRef, SecretVersionMeta } from "@/types";

// Une valeur révélée est ré-masquée automatiquement après ce délai, même si l'utilisateur ne
// fait rien — au-delà d'une "révélation à la demande" explicite, elle ne doit pas rester
// affichée indéfiniment à l'écran (poste partagé, projection, etc.).
const REVEAL_AUTO_HIDE_MS = 20_000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "YYYY-MM-DD" (valeur native d'un <input type="date">) — vide si `iso` est absent. */
function toDateInputValue(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function isExpired(secret: SecretRef): boolean {
  return Boolean(secret.expiresAt) && new Date(secret.expiresAt!).getTime() < Date.now();
}

export default function SecretsPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, creating } = useAppSelector((s) => s.secrets);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();
  const admin = canAdminister(session);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", description: "", expiresAt: "" });
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState<SecretRef | null>(null);
  const [editForm, setEditForm] = useState({ name: "", value: "", description: "", expiresAt: "" });
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Révélation à la demande — JAMAIS dans le state Redux global (voir secretsSlice.ts#revealSecret) :
  // seulement ici, dans un state local React, effacée au démontage/à la fermeture/après délai.
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Historique des versions (façon Vault KV v2) — même state local éphémère pour toute valeur
  // passée révélée depuis ce panneau.
  const [historyFor, setHistoryFor] = useState<SecretRef | null>(null);
  const [historyVersions, setHistoryVersions] = useState<SecretVersionMeta[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRevealed, setHistoryRevealed] = useState<{ version: number; value: string } | null>(null);

  const isDirty = showForm && (form.name.trim() !== "" || form.value.trim() !== "");

  useEffect(() => {
    dispatch(fetchSecrets());
  }, [dispatch]);

  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
  }, [dispatch, isDirty]);
  useEffect(() => {
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
  }, [dispatch]);

  // Une valeur révélée ne doit jamais survivre à un démontage de la page (changement de vue).
  useEffect(() => {
    return () => {
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    };
  }, []);

  const visible = items.filter(
    (secret) => !searchQuery || secret.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function resetForm() {
    setShowForm(false);
    setForm({ name: "", value: "", description: "", expiresAt: "" });
    setCreateError(null);
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    const value = form.value.trim();
    if (!name || !value) return;
    const description = form.description.trim();
    setCreateError(null);
    dispatch(
      createSecret({
        name,
        value,
        ...(description ? { description } : {}),
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      }),
    ).then((action) => {
      if (createSecret.fulfilled.match(action)) {
        resetForm();
      } else {
        setCreateError(action.payload ?? "Impossible de créer ce secret.");
      }
    });
  }

  async function handleCancelForm() {
    if (isDirty) {
      const ok = await confirm({
        title: "Abandonner ce secret ?",
        description: "Les informations saisies pour ce secret n'ont pas été enregistrées.",
        confirmLabel: "Abandonner les modifications",
        variant: "danger",
      });
      if (!ok) return;
    }
    resetForm();
  }

  function openEdit(secret: SecretRef) {
    setEditing(secret);
    setEditForm({
      name: secret.name,
      value: "",
      description: secret.description ?? "",
      expiresAt: toDateInputValue(secret.expiresAt),
    });
    setUpdateError(null);
  }

  function closeEdit() {
    setEditing(null);
    setUpdateError(null);
  }

  async function handleUpdate(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const name = editForm.name.trim();
    if (!name) return;
    const value = editForm.value.trim();
    const description = editForm.description.trim();

    // undefined = expiration inchangée ; null = effacée explicitement ; chaîne = nouvelle date —
    // voir secretsSlice.ts#UpdateSecretInput/secretsStore.ts.
    const originalExpiresAt = toDateInputValue(editing.expiresAt);
    const expiresAtPatch: string | null | undefined =
      editForm.expiresAt === originalExpiresAt
        ? undefined
        : editForm.expiresAt === ""
          ? null
          : new Date(editForm.expiresAt).toISOString();

    setUpdating(true);
    setUpdateError(null);
    const result = await dispatch(
      updateSecret({
        id: editing.id,
        name,
        // value vide = valeur conservée côté API (voir secretsSlice.ts#UpdateSecretInput) — omis
        // tant qu'une nouvelle valeur n'est pas explicitement saisie.
        ...(value ? { value } : {}),
        description,
        ...(expiresAtPatch !== undefined ? { expiresAt: expiresAtPatch } : {}),
      }),
    );
    setUpdating(false);
    if (updateSecret.fulfilled.match(result)) {
      closeEdit();
    } else {
      setUpdateError(result.payload ?? "Impossible de modifier ce secret.");
    }
  }

  async function handleDelete(secret: SecretRef) {
    const usageCount = secret.usedBy.length;
    const ok = await confirm({
      title: "Supprimer ce secret",
      description:
        usageCount > 0
          ? `${usageCount} conteneur${usageCount > 1 ? "s" : ""} référence${usageCount > 1 ? "nt" : ""} actuellement "${secret.name}" (${secret.usedBy.map((u) => u.containerName).join(", ")}). Les conteneurs déjà créés ne sont pas modifiés (leur environnement reste tel quel), mais ce secret ne pourra plus être ni consulté ni référencé par un nouveau conteneur ensuite. Cette action est irréversible.`
          : `Confirmer la suppression de "${secret.name}" ? Tout conteneur créé ultérieurement ne pourra plus y faire référence. Cette action est irréversible.`,
      confirmLabel: usageCount > 0 ? `Supprimer malgré tout (${usageCount} conteneur${usageCount > 1 ? "s" : ""})` : "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteSecret(secret.id));
  }

  function goToContainer(containerName: string) {
    dispatch(setCurrentView("containers"));
    dispatch(setSearchQuery(containerName));
  }

  async function handleCopy(value: string, feedbackId: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(feedbackId);
      setTimeout(() => setCopiedId((current) => (current === feedbackId ? null : current)), 1500);
    } catch {
      // Clipboard API indisponible (contexte non sécurisé, permission refusée…) — la valeur reste
      // affichée à l'écran, sélectionnable manuellement ; pas d'erreur bruyante pour un cas rare.
    }
  }

  async function handleReveal(secret: SecretRef) {
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
    if (revealed?.id === secret.id) {
      setRevealed(null); // toggle : re-cliquer sur l'œil masque immédiatement
      return;
    }
    setRevealingId(secret.id);
    const result = await dispatch(revealSecret({ id: secret.id }));
    setRevealingId(null);
    if (revealSecret.fulfilled.match(result)) {
      setRevealed({ id: secret.id, value: result.payload });
      revealTimeoutRef.current = setTimeout(() => setRevealed(null), REVEAL_AUTO_HIDE_MS);
    }
    // Échec (droits, secret supprimé entre-temps…) déjà notifié par le toast générique
    // (errorNotificationMiddleware.ts) — rien de plus à faire ici.
  }

  async function openHistory(secret: SecretRef) {
    setHistoryFor(secret);
    setHistoryVersions(null);
    setHistoryError(null);
    setHistoryRevealed(null);
    setHistoryLoading(true);
    const result = await dispatch(fetchSecretVersions(secret.id));
    setHistoryLoading(false);
    if (fetchSecretVersions.fulfilled.match(result)) {
      setHistoryVersions(result.payload);
    } else {
      setHistoryError(result.payload ?? "Impossible de charger l'historique de ce secret.");
    }
  }

  function closeHistory() {
    setHistoryFor(null);
    setHistoryVersions(null);
    setHistoryError(null);
    setHistoryRevealed(null);
  }

  async function handleRevealVersion(version: number) {
    if (!historyFor) return;
    if (historyRevealed?.version === version) {
      setHistoryRevealed(null);
      return;
    }
    const result = await dispatch(revealSecret({ id: historyFor.id, version }));
    if (revealSecret.fulfilled.match(result)) {
      setHistoryRevealed({ version, value: result.payload });
    }
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Secrets</h2>
            <p>
              Valeurs sensibles (mots de passe, jetons…) définies une seule fois puis référencées par
              nom lors de la création d'un conteneur — jamais retapées, révélées en clair uniquement
              à la demande d'un admin.
            </p>
          </div>
          {admin && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => (showForm ? handleCancelForm() : setShowForm(true))}
            >
              <IconPlus /> {showForm ? "Annuler" : "Nouveau secret"}
            </button>
          )}
        </div>

        {showForm && admin && (
          <form className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="secret-name">Nom</label>
              <input
                id="secret-name"
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="ex : DB_PASSWORD"
                disabled={creating}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="secret-value">Valeur</label>
              <input
                id="secret-value"
                type="password"
                value={form.value}
                onChange={(event) => setForm((f) => ({ ...f, value: event.target.value }))}
                disabled={creating}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="secret-description">Description (optionnel)</label>
              <input
                id="secret-description"
                value={form.description}
                onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
                placeholder="ex : Mot de passe PostgreSQL de production"
                disabled={creating}
              />
            </div>
            <div className="field">
              <label htmlFor="secret-expires">Expiration (optionnel)</label>
              <input
                id="secret-expires"
                type="date"
                value={form.expiresAt}
                onChange={(event) => setForm((f) => ({ ...f, expiresAt: event.target.value }))}
                disabled={creating}
              />
            </div>
            {createError && <p className="graph-popover__error">{createError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating || !form.name.trim() || !form.value.trim()}>
                {creating ? "Création…" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleCancelForm}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable columns={["Nom", "Description", "Utilisé par", "Valeur", "Expiration", "Dernière modification", ""]} rows={6} />
        )}
        {status !== "loading" && items.length === 0 && !error && (
          <div className="empty-state">Aucun secret configuré.</div>
        )}
        {status !== "loading" && items.length > 0 && visible.length === 0 && !error && (
          <div className="empty-state">Aucun secret ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Description</th>
                  <th>Utilisé par</th>
                  <th>Valeur</th>
                  <th>Expiration</th>
                  <th>Dernière modification</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((secret) => {
                  const expiresAt = secret.expiresAt;
                  return (
                  <tr key={secret.id}>
                    <td className="cell-primary cell-mono">{secret.name}</td>
                    <td>{secret.description || "—"}</td>
                    <td>
                      {secret.usedBy.length === 0 ? (
                        <span style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                          Aucun conteneur ne l'utilise
                        </span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {secret.usedBy.map((usage) => (
                            <button
                              key={`${usage.containerId}-${usage.key}`}
                              type="button"
                              className="chip chip--accent"
                              title={`Injecté sous la variable d'environnement ${usage.key}`}
                              onClick={() => goToContainer(usage.containerName)}
                            >
                              {usage.containerName}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="cell-mono">
                      {!admin ? (
                        "—"
                      ) : revealed?.id === secret.id ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span className="cell-mono">{revealed.value}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Copier la valeur"
                            aria-label="Copier la valeur"
                            onClick={() => handleCopy(revealed.value, secret.id)}
                          >
                            {copiedId === secret.id ? <IconCheck /> : <IconCopy />}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Masquer la valeur"
                            aria-label="Masquer la valeur"
                            onClick={() => handleReveal(secret)}
                          >
                            <IconEyeOff />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Révéler la valeur"
                          aria-label="Révéler la valeur"
                          onClick={() => handleReveal(secret)}
                          disabled={revealingId === secret.id}
                        >
                          <IconEye />
                        </button>
                      )}
                    </td>
                    <td>
                      {expiresAt ? (
                        isExpired(secret) ? (
                          <span className="chip chip--danger" title={formatDate(expiresAt)}>
                            Expiré
                          </span>
                        ) : (
                          new Date(expiresAt).toLocaleDateString("fr-FR")
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{formatDate(secret.updatedAt)}</td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        {admin && (
                          <button
                            type="button"
                            className="icon-btn"
                            title={`Historique (v${secret.version}${secret.versionCount > 1 ? `, ${secret.versionCount} versions` : ""})`}
                            aria-label="Historique des versions"
                            onClick={() => openHistory(secret)}
                          >
                            <IconHistory />
                          </button>
                        )}
                        {admin && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Modifier"
                            aria-label="Modifier"
                            onClick={() => openEdit(secret)}
                          >
                            <IconSettings />
                          </button>
                        )}
                        {admin && (
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            title="Supprimer"
                            aria-label="Supprimer"
                            onClick={() => handleDelete(secret)}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={editing !== null} onClose={closeEdit} labelledBy="secret-edit-title">
        {editing && (
          <form className="confirm-dialog" onSubmit={handleUpdate}>
            <h2 id="secret-edit-title" className="confirm-dialog__title">
              Modifier {editing.name}
            </h2>
            <div className="field">
              <label htmlFor="secret-edit-name">Nom</label>
              <input
                id="secret-edit-name"
                value={editForm.name}
                onChange={(event) => setEditForm((f) => ({ ...f, name: event.target.value }))}
                disabled={updating}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="secret-edit-value">Valeur</label>
              <input
                id="secret-edit-value"
                type="password"
                value={editForm.value}
                onChange={(event) => setEditForm((f) => ({ ...f, value: event.target.value }))}
                placeholder="laisser vide pour conserver la valeur actuelle"
                disabled={updating}
                autoComplete="new-password"
              />
              <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: "4px 0 0" }}>
                Saisir une nouvelle valeur ici la fait tourner (rotation) : l'ancienne valeur reste
                consultable via le bouton "Historique" de la liste.
              </p>
            </div>
            <div className="field">
              <label htmlFor="secret-edit-description">Description</label>
              <input
                id="secret-edit-description"
                value={editForm.description}
                onChange={(event) => setEditForm((f) => ({ ...f, description: event.target.value }))}
                disabled={updating}
              />
            </div>
            <div className="field">
              <label htmlFor="secret-edit-expires">Expiration</label>
              <input
                id="secret-edit-expires"
                type="date"
                value={editForm.expiresAt}
                onChange={(event) => setEditForm((f) => ({ ...f, expiresAt: event.target.value }))}
                disabled={updating}
              />
            </div>
            {updateError && <p className="graph-popover__error">{updateError}</p>}
            <div className="confirm-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={closeEdit} disabled={updating}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={updating || !editForm.name.trim()}>
                {updating ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={historyFor !== null} onClose={closeHistory} labelledBy="secret-history-title">
        {historyFor && (
          <div className="confirm-dialog">
            <h2 id="secret-history-title" className="confirm-dialog__title">
              Historique de {historyFor.name}
            </h2>
            <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: -4 }}>
              {historyFor.versionCount} version{historyFor.versionCount > 1 ? "s" : ""} conservée
              {historyFor.versionCount > 1 ? "s" : ""} (les 5 précédentes au maximum). Révéler une
              version passée reste réservé aux admins et journalisé comme toute révélation.
            </p>
            {historyLoading && <div className="spinner" />}
            {historyError && <p className="graph-popover__error">{historyError}</p>}
            {historyVersions && (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {historyVersions.map((entry, index) => (
                  <li
                    key={entry.version}
                    className="card"
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px" }}
                  >
                    <div>
                      <strong>v{entry.version}</strong>
                      {index === 0 ? " (courante)" : ""}
                      <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{formatDate(entry.updatedAt)}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {historyRevealed?.version === entry.version && (
                        <>
                          <span className="cell-mono">{historyRevealed.value}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Copier"
                            aria-label="Copier"
                            onClick={() => handleCopy(historyRevealed.value, `history-${entry.version}`)}
                          >
                            {copiedId === `history-${entry.version}` ? <IconCheck /> : <IconCopy />}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        title={historyRevealed?.version === entry.version ? "Masquer" : "Révéler cette version"}
                        aria-label={historyRevealed?.version === entry.version ? "Masquer" : "Révéler cette version"}
                        onClick={() => handleRevealVersion(entry.version)}
                      >
                        {historyRevealed?.version === entry.version ? <IconEyeOff /> : <IconEye />}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="confirm-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={closeHistory}>
                Fermer
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
