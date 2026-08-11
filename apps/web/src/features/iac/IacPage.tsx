import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createWorkspace,
  deleteWorkspace,
  fetchEngines,
  fetchFiles,
  fetchRunDetail,
  fetchRuns,
  fetchWorkspaces,
  openFile,
  runAction,
  saveFile,
  selectWorkspace,
  setOpenFileContent,
} from "@/features/iac/iacSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import type { IacEngine } from "@/types";

const ENGINE_LABEL: Record<IacEngine, string> = { tofu: "OpenTofu", ansible: "Ansible", packer: "Packer" };
const ENGINE_ACTIONS: Record<IacEngine, string[]> = {
  tofu: ["init", "plan", "apply", "destroy"],
  ansible: ["run"],
  packer: ["init", "build"],
};
const RUN_POLL_MS = 2000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function IacPage() {
  const dispatch = useAppDispatch();
  const { engines, workspaces, selectedWorkspaceId, files, openFilePath, openFileContent, runs, selectedRun } =
    useAppSelector((s) => s.iac);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [engine, setEngine] = useState<IacEngine>("tofu");
  const logRef = useRef<HTMLPreElement>(null);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  useEffect(() => {
    dispatch(fetchEngines());
    dispatch(fetchWorkspaces());
  }, [dispatch]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      dispatch(fetchFiles(selectedWorkspaceId));
      dispatch(fetchRuns(selectedWorkspaceId));
    }
  }, [dispatch, selectedWorkspaceId]);

  // Poll le run sélectionné pendant qu'il tourne — même principe que le rafraîchissement de
  // Vue d'ensemble, plus simple qu'un flux WebSocket pour ce premier lot (voir runner.ts côté API).
  useEffect(() => {
    if (!selectedWorkspaceId || !selectedRun || selectedRun.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchRunDetail({ workspaceId: selectedWorkspaceId, runId: selectedRun.id }));
    }, RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, selectedWorkspaceId, selectedRun]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [selectedRun?.log]);

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch(createWorkspace({ name: trimmed, engine })).then((result) => {
      if (createWorkspace.fulfilled.match(result)) {
        setFormOpen(false);
        setName("");
      }
    });
  }

  async function handleDeleteWorkspace(id: string, workspaceName: string) {
    const ok = await confirm({
      title: "Supprimer le workspace",
      description: `Confirmer la suppression de "${workspaceName}" ? Les fichiers et l'historique des runs seront perdus.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (ok) dispatch(deleteWorkspace(id));
  }

  function handleRun(action: string) {
    if (!selectedWorkspace) return;
    dispatch(runAction({ workspaceId: selectedWorkspace.id, engine: selectedWorkspace.engine, action })).then(
      (result) => {
        if (runAction.fulfilled.match(result) && selectedWorkspaceId) {
          dispatch(fetchRunDetail({ workspaceId: selectedWorkspaceId, runId: result.payload.id }));
        }
      },
    );
  }

  function handleSave() {
    if (!selectedWorkspaceId || !openFilePath) return;
    dispatch(saveFile({ workspaceId: selectedWorkspaceId, path: openFilePath, content: openFileContent }));
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Infra-as-code</h2>
          <p>OpenTofu, Ansible et Packer réels, pilotés directement — aucune réimplémentation.</p>
        </div>
        <div className="iac-engine-badges">
          {engines.map((e) => (
            <span
              key={e.engine}
              className={`chip ${e.available ? "chip--accent" : "chip--danger"}`}
              title={e.available ? `${ENGINE_LABEL[e.engine]} — vérifié en lançant le binaire réel` : "binaire introuvable dans le PATH du conteneur API"}
            >
              {e.available ? "●" : "✗"} {ENGINE_LABEL[e.engine]}
              {e.available && e.version && <span className="iac-engine-badges__version">{e.version}</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="iac-layout">
        <div className="iac-column iac-column--workspaces">
          <div className="iac-column__head">
            <span>Workspaces</span>
            {canOperate(session) && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFormOpen((o) => !o)}>
                {formOpen ? "Annuler" : "+ Nouveau"}
              </button>
            )}
          </div>

          {formOpen && (
            <form className="iac-create-form" onSubmit={handleCreate}>
              <input
                type="text"
                placeholder="Nom du workspace"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <select value={engine} onChange={(e) => setEngine(e.target.value as IacEngine)}>
                <option value="tofu">OpenTofu</option>
                <option value="ansible">Ansible</option>
                <option value="packer">Packer</option>
              </select>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
                Créer
              </button>
            </form>
          )}

          {workspaces.length === 0 && <div className="empty-state">Aucun workspace.</div>}
          <div className="iac-workspace-list">
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`iac-workspace-item${w.id === selectedWorkspaceId ? " is-selected" : ""}`}
                onClick={() => dispatch(selectWorkspace(w.id))}
              >
                <span className="iac-workspace-item__name">{w.name}</span>
                <span className="iac-workspace-item__engine">{ENGINE_LABEL[w.engine]}</span>
              </button>
            ))}
          </div>
        </div>

        {selectedWorkspace ? (
          <>
            <div className="iac-column iac-column--files">
              <div className="iac-column__head">
                <span>Fichiers — {selectedWorkspace.name}</span>
                {canOperate(session) && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleDeleteWorkspace(selectedWorkspace.id, selectedWorkspace.name)}
                  >
                    Supprimer
                  </button>
                )}
              </div>
              <div className="iac-file-list">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`iac-file-item${f.path === openFilePath ? " is-selected" : ""}`}
                    onClick={() => dispatch(openFile({ workspaceId: selectedWorkspace.id, path: f.path }))}
                  >
                    {f.path}
                  </button>
                ))}
              </div>

              {openFilePath && (
                <>
                  <textarea
                    className="iac-editor"
                    value={openFileContent}
                    onChange={(e) => dispatch(setOpenFileContent(e.target.value))}
                    spellCheck={false}
                    disabled={!canOperate(session)}
                  />
                  {canOperate(session) && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
                      Enregistrer {openFilePath}
                    </button>
                  )}
                </>
              )}

              {canOperate(session) && (
                <div className="iac-actions">
                  {ENGINE_ACTIONS[selectedWorkspace.engine].map((action) => (
                    <button key={action} type="button" className="btn btn-secondary btn-sm" onClick={() => handleRun(action)}>
                      {action}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="iac-column iac-column--runs">
              <div className="iac-column__head">
                <span>Runs</span>
              </div>
              <div className="iac-run-list">
                {runs.length === 0 && <div className="empty-state">Aucun run pour l'instant.</div>}
                {runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`iac-run-item iac-run-item--${r.status}${r.id === selectedRun?.id ? " is-selected" : ""}`}
                    onClick={() => dispatch(fetchRunDetail({ workspaceId: selectedWorkspace.id, runId: r.id }))}
                  >
                    <span>{r.action}</span>
                    <span className="iac-run-item__meta">
                      {r.status === "running" ? "en cours…" : r.status} · {formatDate(r.startedAt)}
                    </span>
                  </button>
                ))}
              </div>

              {selectedRun && (
                <pre ref={logRef} className="iac-log">
                  {selectedRun.log || "(pas de sortie)"}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="iac-column iac-column--placeholder">
            <div className="empty-state">Sélectionnez ou créez un workspace.</div>
          </div>
        )}
      </div>
    </div>
  );
}
