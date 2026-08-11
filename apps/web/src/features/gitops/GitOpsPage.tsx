import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  fetchGitopsCommits,
  fetchGitopsDiff,
  fetchGitopsFiles,
  selectFile,
  setActiveTab,
  syncGitops,
} from "@/features/gitops/gitopsSlice";
import { canOperate } from "@/features/auth/authSlice";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GitOpsPage() {
  const dispatch = useAppDispatch();
  const {
    files,
    filesStatus,
    commits,
    commitsStatus,
    selectedPath,
    activeTab,
    diff,
    diffStatus,
    syncing,
    error,
  } = useAppSelector((s) => s.gitops);
  const session = useAppSelector((s) => s.auth.session);

  useEffect(() => {
    dispatch(fetchGitopsFiles());
    dispatch(fetchGitopsCommits());
  }, [dispatch]);

  useEffect(() => {
    if (selectedPath && activeTab === "diff") {
      dispatch(fetchGitopsDiff(selectedPath));
    }
  }, [dispatch, selectedPath, activeTab]);

  useEffect(() => {
    if (files.length > 0 && !selectedPath) {
      const first = files[0];
      if (first) dispatch(selectFile(first.path));
    }
  }, [files, selectedPath, dispatch]);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>GitOps</h2>
          <p>Le dépôt Git est la source de vérité — comparaison état désiré / état réel.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canOperate(session) || syncing}
          onClick={() => dispatch(syncGitops())}
        >
          {syncing ? "Resynchronisation…" : "Resynchroniser"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="gitops-layout">
        <div className="card file-tree">
          {filesStatus === "loading" && files.length === 0 && (
            <div className="empty-state">Chargement…</div>
          )}
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`file-tree__item${file.path === selectedPath ? " is-active" : ""}`}
              onClick={() => dispatch(selectFile(file.path))}
            >
              {file.path}
              {file.drift && <span className="file-tree__drift-dot" title="Dérive détectée" />}
            </button>
          ))}
          {filesStatus !== "loading" && files.length === 0 && (
            <div className="empty-state">Aucun manifeste.</div>
          )}
        </div>

        <div className="card diff-panel">
          <div className="diff-tabs">
            <button
              type="button"
              className={`diff-tab${activeTab === "diff" ? " is-active" : ""}`}
              onClick={() => dispatch(setActiveTab("diff"))}
            >
              Diff
            </button>
            <button
              type="button"
              className={`diff-tab${activeTab === "manifest" ? " is-active" : ""}`}
              onClick={() => dispatch(setActiveTab("manifest"))}
            >
              Manifeste
            </button>
          </div>

          {!selectedFile && <div className="empty-state">Sélectionnez un fichier.</div>}

          {selectedFile && activeTab === "diff" && (
            <div className="diff-view">
              {diffStatus === "loading" && <div className="empty-state">Chargement…</div>}
              {diff &&
                diff.lines.map((line, index) => (
                  <div key={index} className={`diff-line diff-line--${line.kind}`}>
                    {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                    {line.text}
                  </div>
                ))}
              {diff && diff.lines.length === 0 && (
                <div className="empty-state">Aucune différence — état synchronisé.</div>
              )}
            </div>
          )}

          {selectedFile && activeTab === "manifest" && (
            <div className="manifest-view">{selectedFile.desiredManifest}</div>
          )}
        </div>

        <div className="card commit-list">
          <div className="panel__title">Historique des commits</div>
          {commitsStatus === "loading" && commits.length === 0 && (
            <div className="empty-state">Chargement…</div>
          )}
          {commits.map((commit) => (
            <div className="commit-item" key={commit.hash}>
              <div className="commit-item__hash">{commit.hash.slice(0, 7)}</div>
              <div className="commit-item__message">{commit.message}</div>
              <div className="commit-item__meta">
                {commit.author} · {formatDate(commit.date)}
              </div>
            </div>
          ))}
          {commitsStatus !== "loading" && commits.length === 0 && (
            <div className="empty-state">Aucun commit.</div>
          )}
        </div>
      </div>
    </div>
  );
}
