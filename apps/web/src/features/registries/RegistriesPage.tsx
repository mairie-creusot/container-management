import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createRegistry,
  deleteRegistry,
  fetchRegistries,
  fetchRegistryDetail,
  selectRegistry,
  startExploring,
  updateRegistry,
} from "@/features/registries/registriesSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { setCurrentView, setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Inspector from "@/components/Inspector";
import Modal from "@/components/Modal";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { SkeletonCard } from "@/components/Skeleton";
import { registryMeta } from "@/components/RegistryBadge";
import { IconPlus, IconSettings } from "@/components/icons";
import type { Registry, RegistryKind } from "@/types";

const KINDS: { id: RegistryKind; label: string }[] = [
  { id: "dockerhub", label: "Docker Hub" },
  { id: "ghcr", label: "GHCR" },
  { id: "gitlab", label: "GitLab Registry" },
  { id: "harbor", label: "Harbor" },
];

function formatSync(iso: string | null): string {
  if (!iso) return "Jamais synchronisé";
  return `Synchronisé le ${new Date(iso).toLocaleString("fr-FR")}`;
}

export default function RegistriesPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, selectedId, selectedDetail, creating } = useAppSelector(
    (s) => s.registries,
  );
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    kind: "dockerhub" as RegistryKind,
    name: "",
    url: "",
    username: "",
    password: "",
    token: "",
    org: "",
  });
  const [editing, setEditing] = useState<Registry | null>(null);
  const [editForm, setEditForm] = useState({ name: "", url: "", username: "", password: "", token: "", org: "" });
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const confirm = useConfirm();
  // Étendu à tous les champs (pas seulement nom/URL) : un identifiant saisi puis un abandon du
  // formulaire doit lui aussi déclencher la confirmation "modifications non enregistrées",
  // comme n'importe quel autre champ du formulaire de création.
  const isDirty =
    showForm &&
    (form.name.trim() !== "" ||
      form.url.trim() !== "" ||
      form.username.trim() !== "" ||
      form.password.trim() !== "" ||
      form.token.trim() !== "" ||
      form.org.trim() !== "");

  useEffect(() => {
    dispatch(fetchRegistries());
  }, [dispatch]);

  useEffect(() => {
    if (selectedId) dispatch(fetchRegistryDetail(selectedId));
  }, [dispatch, selectedId]);

  // Signale à la Sidebar qu'un formulaire non enregistré est ouvert, pour
  // qu'un changement de vue déclenche une confirmation plutôt qu'un abandon
  // silencieux. Nettoyé au démontage de la page.
  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
  }, [dispatch, isDirty]);
  useEffect(() => {
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
  }, [dispatch]);

  const visible = items.filter(
    (registry) => !searchQuery || registry.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function resetForm() {
    setShowForm(false);
    setForm({ kind: "dockerhub", name: "", url: "", username: "", password: "", token: "", org: "" });
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!form.name || !form.url) return;
    const name = form.name.trim();
    const url = form.url.trim();
    const username = form.username.trim();
    const password = form.password.trim();
    const token = form.token.trim();
    const org = form.org.trim();
    dispatch(
      createRegistry({
        kind: form.kind,
        name,
        url,
        // Identifiants/org omis tant qu'ils sont vides — un registry créé sans reste
        // "unconfigured" (comportement historique), toujours modifiable ensuite via l'icône
        // engrenage (voir registriesStore.ts#createRegistry).
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(token ? { token } : {}),
        ...(org ? { org } : {}),
      }),
    ).then((action) => {
      if (createRegistry.fulfilled.match(action)) {
        resetForm();
      }
    });
  }

  function openEdit(registry: Registry) {
    setEditing(registry);
    // `org` est prérempli (contrairement à username/password/token, jamais réaffichés) : ce
    // n'est pas un secret — voir types.ts#Registry — et le montrer aide concrètement à corriger
    // une déduction erronée (c'est précisément le champ qui résout le bug "connected/3 vs 401").
    setEditForm({ name: registry.name, url: registry.url, username: "", password: "", token: "", org: registry.org ?? "" });
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
    const url = editForm.url.trim();
    if (!name || !url) return;
    setUpdating(true);
    setUpdateError(null);
    const username = editForm.username.trim();
    const password = editForm.password.trim();
    const token = editForm.token.trim();
    const result = await dispatch(
      updateRegistry({
        id: editing.id,
        name,
        url,
        // Champs identifiants omis tant qu'ils sont vides — l'API conserve alors le secret déjà
        // enregistré (voir registriesSlice.ts#UpdateRegistryInput).
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(token ? { token } : {}),
        // org : TOUJOURS envoyé, contrairement aux identifiants ci-dessus — une valeur vide
        // efface explicitement l'org configurée et fait retomber la résolution sur l'ancienne
        // déduction (voir setupStore.ts#RegistryPatch).
        org: editForm.org.trim(),
      }),
    );
    setUpdating(false);
    if (updateRegistry.fulfilled.match(result)) {
      closeEdit();
    } else {
      setUpdateError(result.payload ?? "Impossible de modifier ce registry.");
    }
  }

  /** Retour utilisateur du 14/08/2026 : "manque option pour suprimer" — confirmation nommée
   * (même pattern que le reste de l'app pour une action irréversible), puis refetch complet de la
   * liste plutôt qu'un simple retrait local : les ids "reg-<kind>-<index>" des AUTRES entrées du
   * même kind peuvent avoir changé côté serveur (voir registriesStore.ts#deleteRegistry). */
  async function handleDelete(registry: { id: string; name: string }) {
    const ok = await confirm({
      title: "Supprimer le registry",
      description: `Confirmer la suppression de « ${registry.name} » ? Les identifiants enregistrés seront définitivement perdus.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteRegistry(registry.id));
    if (deleteRegistry.fulfilled.match(result)) {
      dispatch(fetchRegistries());
    }
  }

  async function handleCancelForm() {
    if (isDirty) {
      const ok = await confirm({
        title: "Abandonner ce registry ?",
        description: "Les informations saisies pour ce registry n'ont pas été enregistrées.",
        confirmLabel: "Abandonner les modifications",
        variant: "danger",
      });
      if (!ok) return;
    }
    resetForm();
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Registries</h2>
            <p>Sources d'images configurées (Docker Hub, GHCR, GitLab, Harbor).</p>
          </div>
          {canAdminister(session) && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => (showForm ? handleCancelForm() : setShowForm(true))}
            >
              <IconPlus /> Ajouter un registry
            </button>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <div className="registry-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun registry configuré.</div>
        )}

        {visible.length > 0 && (
          <div className="registry-grid">
            {visible.map((registry) => {
              const meta = registryMeta(registry.kind);
              return (
                <div
                  key={registry.id}
                  className={`card card--interactive${registry.id === selectedId ? " card--selected" : ""}`}
                  onClick={() => dispatch(selectRegistry(registry.id))}
                >
                  <div className="registry-card__head">
                    <div className="registry-card__icon" style={{ background: meta.color }}>
                      {meta.label.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="registry-card__head-actions">
                      <StatusPill status={registry.status} />
                      {canAdminister(session) && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Modifier les paramètres du registry"
                          aria-label="Modifier les paramètres du registry"
                          onClick={(event) => {
                            event.stopPropagation();
                            openEdit(registry);
                          }}
                        >
                          <IconSettings />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="registry-card__name">{registry.name}</div>
                  <div className="registry-card__url">{registry.url}</div>
                  <div className="registry-card__foot">
                    <span>{registry.trackedImages} image(s)</span>
                    <span>{formatSync(registry.lastSyncAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Inspector
        title={selectedDetail?.name}
        subtitle={selectedDetail?.url}
        onClose={() => dispatch(selectRegistry(null))}
      >
        {selectedDetail && (
          <>
            <StatusPill status={selectedDetail.status} />
            <KeyValueList
              rows={[
                { key: "Type", value: registryMeta(selectedDetail.kind).label },
                ...(selectedDetail.org ? [{ key: "Organisation / Namespace", value: selectedDetail.org }] : []),
                { key: "Images suivies", value: String(selectedDetail.trackedImages) },
                { key: "Dernière synchro", value: formatSync(selectedDetail.lastSyncAt) },
              ]}
            />
            {selectedDetail.statusDetail && <div className="error-banner">{selectedDetail.statusDetail}</div>}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                dispatch(startExploring(selectedDetail.id));
                dispatch(setCurrentView("registry-explorer"));
              }}
            >
              Explorer le catalogue
            </button>
            {canAdminister(session) && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void handleDelete(selectedDetail)}
              >
                Supprimer
              </button>
            )}
          </>
        )}
      </Inspector>

      <Modal open={editing !== null} onClose={closeEdit} labelledBy="registry-edit-title">
        {editing && (
          <form className="confirm-dialog" onSubmit={handleUpdate}>
            <h2 id="registry-edit-title" className="confirm-dialog__title">
              Modifier {editing.name}
            </h2>
            <div className="field">
              <label htmlFor="registry-edit-name">Nom</label>
              <input
                id="registry-edit-name"
                value={editForm.name}
                onChange={(event) => setEditForm((f) => ({ ...f, name: event.target.value }))}
                disabled={updating}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="registry-edit-url">URL</label>
              <input
                id="registry-edit-url"
                value={editForm.url}
                onChange={(event) => setEditForm((f) => ({ ...f, url: event.target.value }))}
                disabled={updating}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="registry-edit-org">Organisation / Namespace</label>
              <input
                id="registry-edit-org"
                value={editForm.org}
                onChange={(event) => setEditForm((f) => ({ ...f, org: event.target.value }))}
                placeholder="ex : ville-lecreusot — vide = déduction automatique"
                disabled={updating}
              />
              <p className="create-container-hint">
                Organisation GitHub (GHCR) ou namespace/compte (Docker Hub) à parcourir — distinct du nom
                d'utilisateur de connexion (souvent un e-mail pour GHCR, jamais un org/user GitHub valide).
                Toujours prioritaire sur toute déduction automatique.
              </p>
            </div>
            <div className="field">
              <label htmlFor="registry-edit-username">Nom d'utilisateur</label>
              <input
                id="registry-edit-username"
                value={editForm.username}
                onChange={(event) => setEditForm((f) => ({ ...f, username: event.target.value }))}
                placeholder="laisser vide pour conserver l'actuel"
                disabled={updating}
              />
            </div>
            <div className="field">
              <label htmlFor="registry-edit-password">Mot de passe</label>
              <input
                id="registry-edit-password"
                type="password"
                value={editForm.password}
                onChange={(event) => setEditForm((f) => ({ ...f, password: event.target.value }))}
                placeholder="laisser vide pour conserver l'actuel"
                disabled={updating}
                autoComplete="new-password"
              />
            </div>
            <div className="field">
              <label htmlFor="registry-edit-token">Jeton d'accès</label>
              <input
                id="registry-edit-token"
                type="password"
                value={editForm.token}
                onChange={(event) => setEditForm((f) => ({ ...f, token: event.target.value }))}
                placeholder="laisser vide pour conserver l'actuel"
                disabled={updating}
                autoComplete="new-password"
              />
            </div>
            {updateError && <p className="graph-popover__error">{updateError}</p>}
            <div className="confirm-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={closeEdit} disabled={updating}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={updating || !editForm.name.trim() || !editForm.url.trim()}>
                {updating ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Retour utilisateur du 14/08/2026 ("pas joli") : ce formulaire s'affichait auparavant
          INLINE dans le flux de la page (poussant le contenu en dessous). Il utilise désormais la
          même <Modal> partagée que le formulaire d'édition ci-dessus, par cohérence avec le reste
          de l'app (Console/Logs, assistant GitHub deploy...). */}
      <Modal open={showForm} onClose={handleCancelForm} labelledBy="registry-create-title">
        <form className="confirm-dialog" onSubmit={handleCreate}>
          <h2 id="registry-create-title" className="confirm-dialog__title">
            Ajouter un registry
          </h2>
          <div className="field">
            <label htmlFor="registry-kind">Type</label>
            <select
              id="registry-kind"
              className="topbar__env-select"
              value={form.kind}
              onChange={(event) => setForm((f) => ({ ...f, kind: event.target.value as RegistryKind }))}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="registry-name">Nom</label>
            <input
              id="registry-name"
              value={form.name}
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label htmlFor="registry-url">URL</label>
            <input
              id="registry-url"
              value={form.url}
              onChange={(event) => setForm((f) => ({ ...f, url: event.target.value }))}
              placeholder="https://registry.example.org"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="registry-org">Organisation / Namespace</label>
            <input
              id="registry-org"
              value={form.org}
              onChange={(event) => setForm((f) => ({ ...f, org: event.target.value }))}
              placeholder="ex : ville-lecreusot — vide = déduction automatique"
            />
            <p className="create-container-hint">
              Organisation GitHub (GHCR) ou namespace/compte (Docker Hub) à parcourir — distinct du nom
              d'utilisateur de connexion (souvent un e-mail pour GHCR, jamais un org/user GitHub valide).
            </p>
          </div>
          <div className="field">
            <label htmlFor="registry-username">Nom d'utilisateur</label>
            <input
              id="registry-username"
              value={form.username}
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
              placeholder="optionnel — requis pour un dépôt privé"
            />
          </div>
          <div className="field">
            <label htmlFor="registry-password">Mot de passe</label>
            <input
              id="registry-password"
              type="password"
              value={form.password}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              placeholder="optionnel"
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="registry-token">Jeton d'accès</label>
            <input
              id="registry-token"
              type="password"
              value={form.token}
              onChange={(event) => setForm((f) => ({ ...f, token: event.target.value }))}
              placeholder="optionnel — ex : PAT GitHub pour GHCR"
              autoComplete="new-password"
            />
          </div>
          <div className="confirm-dialog__actions">
            <button type="button" className="btn btn-ghost" onClick={handleCancelForm}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "Ajout…" : "Ajouter"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
