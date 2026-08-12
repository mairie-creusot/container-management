import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  deployGithubRepo,
  fetchGithubDeploymentDetail,
  fetchGithubDeployments,
  fetchGithubDetection,
  fetchGithubRepos,
  fetchGithubStatus,
  saveGithubToken,
  selectDeployment,
  selectRepo,
} from "@/features/github/githubSlice";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import Skeleton from "@/components/Skeleton";
import { IconGithub } from "@/components/icons";
import type { GithubDeploymentStatus } from "@/types";

const DEPLOYMENT_POLL_MS = 2000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusLabel(status: GithubDeploymentStatus): string {
  if (status === "running") return "en cours…";
  if (status === "success") return "succès";
  return "échec";
}

export default function GitHubDeployPage() {
  const dispatch = useAppDispatch();
  const {
    status,
    statusStatus,
    tokenSaving,
    repos,
    reposStatus,
    reposError,
    selectedRepo,
    detection,
    detectionStatus,
    detectionError,
    deployments,
    selectedDeployment,
    deploying,
  } = useAppSelector((s) => s.github);
  const environments = useAppSelector((s) => s.clusters.environments);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const operator = canOperate(session);

  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [refInput, setRefInput] = useState("");
  const [targetEnvironmentId, setTargetEnvironmentId] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const isDirty = tokenInput.trim() !== "";

  useEffect(() => {
    dispatch(fetchGithubStatus());
    dispatch(fetchGithubDeployments());
    dispatch(fetchEnvironments());
  }, [dispatch]);

  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, isDirty]);

  useEffect(() => {
    if (status?.configured || status?.usingGhcrFallback) {
      dispatch(fetchGithubRepos());
    }
  }, [dispatch, status?.configured, status?.usingGhcrFallback]);

  useEffect(() => {
    if (selectedRepo) {
      dispatch(fetchGithubDetection({ owner: selectedRepo.owner, repo: selectedRepo.repo }));
      setRefInput("");
    }
  }, [dispatch, selectedRepo]);

  // Poll le déploiement sélectionné pendant qu'il tourne — même principe que IacPage.tsx.
  useEffect(() => {
    if (!selectedDeployment || selectedDeployment.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchGithubDeploymentDetail(selectedDeployment.id));
    }, DEPLOYMENT_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, selectedDeployment]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [selectedDeployment?.log]);

  function handleSaveToken(event: FormEvent) {
    event.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setTokenError(null);
    dispatch(saveGithubToken(trimmed)).then((result) => {
      if (saveGithubToken.fulfilled.match(result)) {
        setTokenInput("");
      } else {
        setTokenError(result.payload ?? "Impossible d'enregistrer le jeton.");
      }
    });
  }

  function handleDeploy() {
    if (!selectedRepo) return;
    dispatch(
      deployGithubRepo({
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        ...(refInput.trim() ? { ref: refInput.trim() } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      }),
    ).then((result) => {
      if (deployGithubRepo.fulfilled.match(result)) {
        dispatch(selectDeployment({ ...result.payload, log: "" }));
      }
    });
  }

  const canBrowseRepos = Boolean(status?.configured || status?.usingGhcrFallback);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>
            <IconGithub className="inline-icon" /> GitHub
          </h2>
          <p>
            Parcourez vos vrais dépôts GitHub, détectez Dockerfile/docker-compose/Terraform, puis buildez et
            déployez réellement (Docker local ou distant). Terraform seul : un workspace Infra-as-code est créé,
            sans "apply" automatique.
          </p>
        </div>
      </div>

      {statusStatus !== "loading" && !status?.configured && (
        <div className="card" style={{ marginBottom: 16 }}>
          {status?.usingGhcrFallback ? (
            <p>
              Aucun jeton GitHub dédié configuré — le jeton GHCR déjà configuré (Registries) est utilisé en repli
              pour lister les repos. Configurez un jeton GitHub dédié ci-dessous pour un accès complet (repos
              privés, meilleure limite de débit).
            </p>
          ) : (
            <p>Aucun jeton GitHub configuré — configurez un Personal Access Token (scope "repo") pour parcourir vos dépôts.</p>
          )}
          {admin ? (
            <form onSubmit={handleSaveToken} style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                type="password"
                placeholder="ghp_… (Personal Access Token)"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={tokenSaving}
                autoComplete="off"
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={tokenSaving || !tokenInput.trim()}>
                {tokenSaving ? "Enregistrement…" : "Enregistrer"}
              </button>
            </form>
          ) : (
            <p className="muted">Seul un administrateur peut configurer le jeton GitHub.</p>
          )}
          {tokenError && <p className="graph-popover__error">{tokenError}</p>}
        </div>
      )}

      {statusStatus !== "loading" && status?.configured && admin && (
        <details className="card" style={{ marginBottom: 16 }}>
          <summary>Jeton GitHub configuré — remplacer</summary>
          <form onSubmit={handleSaveToken} style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              type="password"
              placeholder="Nouveau jeton (ghp_…)"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              disabled={tokenSaving}
              autoComplete="off"
              style={{ flex: 1 }}
              required
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={tokenSaving || !tokenInput.trim()}>
              {tokenSaving ? "Enregistrement…" : "Remplacer"}
            </button>
          </form>
          {tokenError && <p className="graph-popover__error">{tokenError}</p>}
        </details>
      )}

      {canBrowseRepos && (
        <div className="iac-layout">
          <div className="iac-column iac-column--workspaces">
            <div className="iac-column__head">
              <span>Dépôts</span>
            </div>
            {reposError && <div className="error-banner">{reposError}</div>}
            {reposStatus === "loading" && repos.length === 0 ? (
              <div className="iac-workspace-list">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div className="iac-workspace-item" style={{ cursor: "default" }} key={index}>
                    <Skeleton variant="text" height={12} width="70%" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {repos.length === 0 && !reposError && <div className="empty-state">Aucun dépôt accessible.</div>}
                <div className="iac-workspace-list">
                  {repos.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`iac-workspace-item${
                        selectedRepo?.owner === r.owner && selectedRepo?.repo === r.name ? " is-selected" : ""
                      }`}
                      onClick={() => dispatch(selectRepo({ owner: r.owner, repo: r.name }))}
                    >
                      <span className="iac-workspace-item__name">{r.fullName}</span>
                      <span className="iac-workspace-item__engine">{r.private ? "privé" : "public"}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {selectedRepo ? (
            <div className="iac-column iac-column--files">
              <div className="iac-column__head">
                <span>{selectedRepo.owner}/{selectedRepo.repo}</span>
              </div>

              {detectionStatus === "loading" && <div className="empty-state">Détection en cours…</div>}
              {detectionError && <div className="error-banner">{detectionError}</div>}

              {detection && (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                    <span className={`chip ${detection.hasDockerfile ? "chip--accent" : ""}`}>
                      {detection.hasDockerfile ? "●" : "✗"} Dockerfile
                    </span>
                    <span className={`chip ${detection.hasCompose ? "chip--accent" : ""}`}>
                      {detection.hasCompose ? "●" : "✗"} docker-compose
                    </span>
                    <span className={`chip ${detection.hasTerraform ? "chip--accent" : ""}`}>
                      {detection.hasTerraform ? "●" : "✗"} Terraform
                      {detection.hasTerraform ? ` (${detection.terraformFiles.join(", ")})` : ""}
                    </span>
                  </div>
                  <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                    Détection limitée à la racine du dépôt (pas de parcours récursif dans ce premier lot), branche{" "}
                    <code>{detection.ref}</code>.
                  </p>

                  {!detection.hasDockerfile && !detection.hasTerraform && (
                    <p className="graph-popover__error">
                      Aucun Dockerfile ni fichier Terraform à la racine — rien à déployer automatiquement (compose
                      seul non géré dans ce premier lot).
                    </p>
                  )}

                  {operator && (detection.hasDockerfile || detection.hasTerraform) && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
                      <div className="field">
                        <label htmlFor="gh-ref">Branche / commit (optionnel)</label>
                        <input
                          id="gh-ref"
                          value={refInput}
                          onChange={(e) => setRefInput(e.target.value)}
                          placeholder={detection.ref}
                        />
                      </div>
                      {detection.hasDockerfile && (
                        <div className="field">
                          <label htmlFor="gh-target">Cible de déploiement</label>
                          <select
                            id="gh-target"
                            value={targetEnvironmentId}
                            onChange={(e) => setTargetEnvironmentId(e.target.value)}
                          >
                            <option value="">Docker local</option>
                            {environments
                              .filter((e) => e.orchestrator === "docker-remote" || e.orchestrator === "compose" || e.orchestrator === "swarm")
                              .map((e) => (
                                <option key={e.id} value={e.id}>
                                  {e.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                      {detection.hasTerraform && !detection.hasDockerfile && (
                        <p className="muted" style={{ fontSize: 12 }}>
                          Un workspace Infra-as-code sera créé à partir des fichiers Terraform de la racine — aucun
                          "apply" automatique, à lancer ensuite depuis la page Infra-as-code.
                        </p>
                      )}
                      <button type="button" className="btn btn-primary btn-sm" onClick={handleDeploy} disabled={deploying}>
                        {deploying ? "Démarrage…" : "Déployer"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="iac-column iac-column--placeholder">
              <div className="empty-state">Sélectionnez un dépôt.</div>
            </div>
          )}

          <div className="iac-column iac-column--runs">
            <div className="iac-column__head">
              <span>Déploiements</span>
            </div>
            <div className="iac-run-list">
              {deployments.length === 0 && <div className="empty-state">Aucun déploiement pour l'instant.</div>}
              {deployments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`iac-run-item iac-run-item--${d.status}${d.id === selectedDeployment?.id ? " is-selected" : ""}`}
                  onClick={() => dispatch(fetchGithubDeploymentDetail(d.id))}
                >
                  <span>
                    {d.owner}/{d.repo}@{d.ref}
                  </span>
                  <span className="iac-run-item__meta">
                    {statusLabel(d.status)} · {formatDate(d.startedAt)}
                  </span>
                </button>
              ))}
            </div>

            {selectedDeployment && (
              <pre ref={logRef} className="iac-log">
                {selectedDeployment.log || "(pas de sortie)"}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
