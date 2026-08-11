import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { createSecret, deleteSecret, fetchSecrets, updateSecret } from "@/features/secrets/secretsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Modal from "@/components/Modal";
import { SkeletonTable } from "@/components/Skeleton";
import { IconPlus, IconSettings, IconTrash } from "@/components/icons";
import type { SecretRef } from "@/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SecretsPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, creating } = useAppSelector((s) => s.secrets);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();
  const admin = canAdminister(session);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", description: "" });
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState<SecretRef | null>(null);
  const [editForm, setEditForm] = useState({ name: "", value: "", description: "" });
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

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

  const visible = items.filter(
    (secret) => !searchQuery || secret.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function resetForm() {
    setShowForm(false);
    setForm({ name: "", value: "", description: "" });
    setCreateError(null);
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    const value = form.value.trim();
    if (!name || !value) return;
    const description = form.description.trim();
    setCreateError(null);
    dispatch(createSecret({ name, value, ...(description ? { description } : {}) })).then((action) => {
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
    setEditForm({ name: secret.name, value: "", description: secret.description ?? "" });
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
    const ok = await confirm({
      title: "Supprimer ce secret",
      description: `Confirmer la suppression de "${secret.name}" ? Tout conteneur créé ultérieurement ne pourra plus y faire référence. Cette action est irréversible.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteSecret(secret.id));
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Secrets</h2>
            <p>
              Valeurs sensibles (mots de passe, jetons…) définies une seule fois puis référencées par
              nom lors de la création d'un conteneur — jamais retapées, jamais exposées après coup.
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
          <SkeletonTable columns={["Nom", "Description", "Dernière modification", ""]} rows={6} />
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
                  <th>Dernière modification</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((secret) => (
                  <tr key={secret.id}>
                    <td className="cell-primary cell-mono">{secret.name}</td>
                    <td>{secret.description || "—"}</td>
                    <td>{formatDate(secret.updatedAt)}</td>
                    <td className="cell-actions">
                      {admin && (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            title="Modifier"
                            aria-label="Modifier"
                            onClick={() => openEdit(secret)}
                          >
                            <IconSettings />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            title="Supprimer"
                            aria-label="Supprimer"
                            onClick={() => handleDelete(secret)}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
