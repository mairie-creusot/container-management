/**
 * Surcharge du CONTENU d'un fichier détecté (Dockerfile/docker-compose.yml/*.tf/playbook Ansible)
 * au moment du build/déploiement — retour utilisateur réel (14/08/2026) : "fait en sorte qu'ont
 * puisse overide le dockerfile et les autre fichier de conf au moment du build" (corriger un
 * problème ponctuel — ex: un Dockerfile réellement buggé sur formulaire_hotline — SANS forker le
 * dépôt ni y faire un vrai commit).
 *
 * Parcours ≤3 clics (cohérent avec la règle du projet) : "Fichiers" (1, déjà compté au niveau du
 * bouton qui ouvre cette modale) -> choisir le fichier dans la liste (2) -> "Enregistrer la
 * surcharge" (3). Le fichier ORIGINAL du dépôt reste consultable en lecture seule (repli
 * <details>, jamais l'interaction principale) juste au-dessus de l'éditeur — un seul contrôle
 * (textarea) pour LE fichier choisi, cohérent avec "≤5 champs" (ce n'en est qu'un).
 *
 * Appels API en direct (apiGet/apiPut/apiDelete), pas de thunk dédié dans githubSlice.ts — même
 * pattern que TopologyNodeDetailPanel.tsx pour un besoin de données ponctuel et local à ce
 * composant, sans alourdir l'état global Redux pour un flux aussi contenu.
 */
import { useEffect, useState } from "react";
import Modal from "@/components/Modal";
import { apiDelete, apiGet, apiPut, ApiError } from "@/api/client";
import type { GithubFileContent, OverridableFileKind, OverridableFileRef } from "@/types";

const KIND_LABEL: Record<OverridableFileKind, string> = {
  dockerfile: "Dockerfile",
  compose: "docker-compose",
  terraform: "Terraform",
  "ansible-playbook": "playbook Ansible",
  "ansible-inventory": "inventaire Ansible",
};

interface FileOverrideModalProps {
  open: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  ref: string;
  configPath?: string;
}

export default function FileOverrideModal({ open, onClose, owner, repo, ref: gitRef, configPath }: FileOverrideModalProps) {
  const [files, setFiles] = useState<OverridableFileRef[]>([]);
  const [filesStatus, setFilesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [filesError, setFilesError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string>("");
  const [editedContent, setEditedContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedPath(null);
    setSaveError(null);
    setFilesStatus("loading");
    setFilesError(null);
    const params = new URLSearchParams({ ref: gitRef });
    if (configPath) params.set("path", configPath);
    apiGet<OverridableFileRef[]>(`/github/repos/${owner}/${repo}/overridable-files?${params.toString()}`)
      .then((data) => {
        setFiles(data);
        setFilesStatus("ready");
      })
      .catch((err) => {
        setFilesStatus("error");
        setFilesError(err instanceof ApiError ? err.message : "Échec du chargement des fichiers.");
      });
  }, [open, owner, repo, gitRef, configPath]);

  const selectedFile = files.find((f) => f.path === selectedPath);

  function openFile(filePath: string, hasOverride: boolean) {
    setSelectedPath(filePath);
    setContentLoading(true);
    setContentError(null);
    setSaveError(null);
    const originalParams = new URLSearchParams({ ref: gitRef, source: "original" });
    Promise.all([
      apiGet<GithubFileContent>(`/github/repos/${owner}/${repo}/file-content?path=${encodeURIComponent(filePath)}&${originalParams.toString()}`),
      hasOverride
        ? apiGet<GithubFileContent>(
            `/github/repos/${owner}/${repo}/file-content?path=${encodeURIComponent(filePath)}&source=override`,
          )
        : Promise.resolve(null),
    ])
      .then(([original, override]) => {
        setOriginalContent(original.content);
        setEditedContent(override ? override.content : original.content);
        setContentLoading(false);
      })
      .catch((err) => {
        setContentLoading(false);
        setContentError(err instanceof ApiError ? err.message : "Échec du chargement du contenu.");
      });
  }

  function handleSave() {
    if (!selectedPath) return;
    setSaving(true);
    setSaveError(null);
    apiPut(`/github/repos/${owner}/${repo}/file-overrides`, { path: selectedPath, content: editedContent })
      .then(() => {
        setSaving(false);
        setFiles((prev) => prev.map((f) => (f.path === selectedPath ? { ...f, hasOverride: true } : f)));
      })
      .catch((err) => {
        setSaving(false);
        setSaveError(err instanceof ApiError ? err.message : "Échec de l'enregistrement de la surcharge.");
      });
  }

  function handleRevert() {
    if (!selectedPath) return;
    setSaving(true);
    setSaveError(null);
    apiDelete(`/github/repos/${owner}/${repo}/file-overrides?path=${encodeURIComponent(selectedPath)}`)
      .then(() => {
        setSaving(false);
        setFiles((prev) => prev.map((f) => (f.path === selectedPath ? { ...f, hasOverride: false } : f)));
        setEditedContent(originalContent);
      })
      .catch((err) => {
        setSaving(false);
        setSaveError(err instanceof ApiError ? err.message : "Échec du retour au fichier original.");
      });
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="file-override-title">
      <div className="confirm-dialog" style={{ minWidth: 460, maxWidth: 640 }}>
        <h2 id="file-override-title" className="confirm-dialog__title">
          Fichiers — {owner}/{repo}
        </h2>

        {!selectedPath && (
          <>
            <p className="muted" style={{ fontSize: 12.5 }}>
              Remplace entièrement le contenu d'un fichier détecté au prochain déploiement — utile pour corriger un
              problème ponctuel (ex: un Dockerfile buggé) sans forker le dépôt ni y faire de vrai commit.
            </p>
            {filesStatus === "loading" && <div className="empty-state">Chargement…</div>}
            {filesError && <div className="graph-popover__error">{filesError}</div>}
            {filesStatus === "ready" && files.length === 0 && (
              <p className="muted">Aucun fichier détecté à surcharger pour ce dépôt.</p>
            )}
            {files.length > 0 && (
              <div className="iac-workspace-list">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className="iac-workspace-item"
                    onClick={() => openFile(f.path, f.hasOverride)}
                  >
                    <span className="iac-workspace-item__name">
                      <code>{f.path}</code>
                    </span>
                    <span className="iac-workspace-item__engine">
                      {f.hasOverride && (
                        <span className="chip chip--accent" style={{ marginRight: 6 }}>
                          surchargé
                        </span>
                      )}
                      {KIND_LABEL[f.kind]}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="confirm-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Fermer
              </button>
            </div>
          </>
        )}

        {selectedPath && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setSelectedPath(null)}>
              ← Fichiers
            </button>
            <p className="muted" style={{ fontSize: 12 }}>
              <code>{selectedPath}</code>
              {selectedFile?.hasOverride && (
                <span className="chip chip--accent" style={{ marginLeft: 6 }}>
                  surcharge active
                </span>
              )}
            </p>

            {contentLoading && <div className="empty-state">Chargement du contenu…</div>}
            {contentError && <div className="graph-popover__error">{contentError}</div>}

            {!contentLoading && !contentError && (
              <>
                {/* Fichier original du dépôt : consultable en lecture seule, jamais l'interaction
                    principale (voir mission) — utile pour comparer avant de corriger. */}
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                    Voir le fichier original du dépôt (lecture seule)
                  </summary>
                  <pre className="iac-log" style={{ maxHeight: 220, marginTop: 8 }}>
                    {originalContent}
                  </pre>
                </details>

                <div className="field">
                  <label htmlFor="file-override-editor">
                    Contenu — remplace ENTIÈREMENT ce fichier au prochain déploiement de ce dépôt
                  </label>
                  <textarea
                    id="file-override-editor"
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    disabled={saving}
                    rows={16}
                    spellCheck={false}
                    style={{ fontFamily: "monospace", fontSize: 12.5, width: "100%", resize: "vertical" }}
                  />
                </div>

                {saveError && <div className="graph-popover__error">{saveError}</div>}

                <div className="confirm-dialog__actions">
                  {selectedFile?.hasOverride && (
                    <button type="button" className="btn btn-ghost" onClick={handleRevert} disabled={saving}>
                      Revenir au fichier original
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving || !editedContent.trim()}
                  >
                    {saving ? "Enregistrement…" : "Enregistrer la surcharge"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
