import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  deployGithubRepo,
  fetchGithubAutoDeploy,
  fetchGithubDeploymentDetail,
  fetchGithubDeployments,
  fetchGithubDetection,
  fetchGithubRepos,
  fetchGithubStatus,
  saveGithubAutoDeploy,
  saveGithubToken,
  selectDeployment,
  selectRepo,
} from "@/features/github/githubSlice";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import Skeleton from "@/components/Skeleton";
import { IconCheck, IconChevron, IconGithub, IconGlobe } from "@/components/icons";
import type { GithubDeployment, GithubDeploymentStatus } from "@/types";

const DEPLOYMENT_POLL_MS = 2000;

// Cibles de déploiement RÉELLEMENT supportées par ce flux (services/github.ts#deployViaDockerBuild
// -> services/docker.ts#getClient) : UNIQUEMENT les hôtes Docker distants persistés
// ("docker-remote", GET /api/environments — Environnements Docker distants). "Docker local" est
// déjà l'option par défaut ci-dessous (targetEnvironmentId vide -> démon local, TOUJOURS
// fonctionnel) : "compose"/"swarm" désignent CE MÊME démon local (un seul environnement Docker
// local existe jamais à la fois, cf. services/docker.ts#getDockerEnvironments) — les lister comme
// options supplémentaires serait un doublon pur, retiré. Kubernetes/Nutanix/LXC sont des plans de
// contrôle entièrement différents que ce flux ne sait pas piloter (dockerode ne leur parle pas) :
// jamais listés ici, quelle que soit leur configuration — une option qui échouerait à coup sûr.
const DEPLOY_TARGET_ORCHESTRATORS = new Set(["docker-remote"]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Horodatage relatif façon "il y a 2 minutes" — même esprit que le panneau "Deployments" de
 * référence (Railway), sans dépendance externe. */
function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

function statusLabel(status: GithubDeploymentStatus): string {
  if (status === "running") return "en cours…";
  if (status === "success") return "succès";
  return "échec";
}

/** Sous-domaine par défaut dérivé du nom du repo (label DNS valide) — toujours éditable, jamais
 * obligatoire à taper : voir services/reverseProxy.ts#isValidSubdomain pour le format exact. */
function defaultSubdomainFor(repoName: string): string {
  const label =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app";
  return `${label}.lecreusot.priv`;
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
    autoDeploy,
    autoDeploySaving,
    autoDeployError,
    deployments,
    selectedDeployment,
    deploying,
  } = useAppSelector((s) => s.github);
  const environments = useAppSelector((s) => s.clusters.environments);
  const topbarEnvironmentId = useAppSelector((s) => s.ui.selectedEnvironmentId);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const operator = canOperate(session);

  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [refInput, setRefInput] = useState("");
  const [targetEnvironmentId, setTargetEnvironmentId] = useState("");
  const [subdomainInput, setSubdomainInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const [autoDeployBranchInput, setAutoDeployBranchInput] = useState("");
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

  // Étape 1/2 du chemin principal : sélectionner un repo déclenche la détection ET pré-remplit
  // TOUS les champs du formulaire de déploiement — rien à taper pour un cas standard.
  useEffect(() => {
    if (!selectedRepo) return;
    dispatch(fetchGithubDetection({ owner: selectedRepo.owner, repo: selectedRepo.repo }));
    dispatch(fetchGithubAutoDeploy({ owner: selectedRepo.owner, repo: selectedRepo.repo }));
    setRefInput("");
    setPortInput("");
    setSubdomainInput(defaultSubdomainFor(selectedRepo.repo));
    // Cible par défaut = l'environnement actuellement sélectionné dans le Topbar, s'il est
    // pertinent pour un déploiement Docker ; repli sur "Docker local" sinon.
    const topbarTarget = topbarEnvironmentId
      ? environments.find((e) => e.id === topbarEnvironmentId && DEPLOY_TARGET_ORCHESTRATORS.has(e.orchestrator))
      : undefined;
    setTargetEnvironmentId(topbarTarget?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, selectedRepo]);

  // Port pré-rempli dès que la détection distante trouve un EXPOSE — n'écrase jamais une valeur
  // déjà tapée par l'utilisateur (dépendance uniquement sur l'arrivée de la détection).
  useEffect(() => {
    if (detection?.exposedPort && !portInput) {
      setPortInput(String(detection.exposedPort));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection?.exposedPort]);

  useEffect(() => {
    if (autoDeploy) setAutoDeployBranchInput(autoDeploy.branch);
  }, [autoDeploy]);

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
    const port = portInput.trim() ? Number(portInput.trim()) : undefined;
    dispatch(
      deployGithubRepo({
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        ...(refInput.trim() ? { ref: refInput.trim() } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
        ...(subdomainInput.trim() ? { subdomain: subdomainInput.trim() } : {}),
        ...(port ? { port } : {}),
      }),
    ).then((result) => {
      if (deployGithubRepo.fulfilled.match(result)) {
        dispatch(selectDeployment({ ...result.payload, log: "" }));
      }
    });
  }

  function handleToggleAutoDeploy(nextEnabled: boolean) {
    if (!selectedRepo) return;
    const port = portInput.trim() ? Number(portInput.trim()) : undefined;
    dispatch(
      saveGithubAutoDeploy({
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        enabled: nextEnabled,
        branch: autoDeployBranchInput.trim() || detection?.ref || "main",
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
        ...(subdomainInput.trim() ? { subdomain: subdomainInput.trim() } : {}),
        ...(port ? { port } : {}),
      }),
    );
  }

  const canBrowseRepos = Boolean(status?.configured || status?.usingGhcrFallback);
  const canDeployDockerfile = Boolean(detection?.hasDockerfile);
  const latestDeployment: GithubDeployment | undefined = deployments[0];
  const historyDeployments = deployments.slice(1);
  const domainUrl = (subdomain: string) => `https://${subdomain}`;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>
            <IconGithub className="inline-icon" /> GitHub
          </h2>
          <p>
            Parcourez vos vrais dépôts GitHub, détectez Dockerfile/docker-compose/Terraform, puis buildez et
            déployez réellement (Docker local ou distant) en 2 clics — sous-domaine, environnement et port sont
            pré-remplis automatiquement. Terraform seul : un workspace Infra-as-code est créé, sans "apply"
            automatique.
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
                      {detection.exposedPort ? ` (port ${detection.exposedPort})` : ""}
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
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
                      {/* Chemin principal : SEUL champ visible par défaut est le sous-domaine
                          (pré-rempli, jamais obligatoire à modifier) — 0 saisie requise pour
                          déployer, tout le reste est replié derrière "Options avancées". */}
                      {canDeployDockerfile && (
                        <div className="field">
                          <label htmlFor="gh-subdomain">Sous-domaine (reverse proxy interne)</label>
                          <input
                            id="gh-subdomain"
                            value={subdomainInput}
                            onChange={(e) => setSubdomainInput(e.target.value)}
                            placeholder={defaultSubdomainFor(selectedRepo.repo)}
                          />
                          <p className="create-container-hint">
                            Laisser vide pour déployer sans route de domaine dédiée. Pré-rempli à partir du nom du
                            dépôt, toujours modifiable.
                          </p>
                        </div>
                      )}

                      <details>
                        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                          Options avancées (branche, environnement cible, port)
                        </summary>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                          <div className="field">
                            <label htmlFor="gh-ref">Branche / commit</label>
                            <input
                              id="gh-ref"
                              value={refInput}
                              onChange={(e) => setRefInput(e.target.value)}
                              placeholder={detection.ref}
                            />
                          </div>
                          {detection.hasDockerfile && (
                            <>
                              <div className="field">
                                <label htmlFor="gh-target">Cible de déploiement</label>
                                <select
                                  id="gh-target"
                                  value={targetEnvironmentId}
                                  onChange={(e) => setTargetEnvironmentId(e.target.value)}
                                >
                                  <option value="">🖥️ Docker local</option>
                                  {environments
                                    .filter((e) => DEPLOY_TARGET_ORCHESTRATORS.has(e.orchestrator))
                                    .map((e) => (
                                      <option key={e.id} value={e.id}>
                                        🌐 {e.name} (hôte Docker distant)
                                      </option>
                                    ))}
                                </select>
                                <p className="create-container-hint">
                                  Seuls les hôtes Docker réellement pilotables par ce flux sont proposés (Docker
                                  local, ou un hôte Docker distant configuré dans Environnements). Kubernetes/
                                  Nutanix/LXC ne sont pas des cibles Docker et n'apparaissent jamais ici.
                                </p>
                              </div>
                              <div className="field">
                                <label htmlFor="gh-port">Port du conteneur (pour le sous-domaine)</label>
                                <input
                                  id="gh-port"
                                  type="number"
                                  min={1}
                                  max={65535}
                                  value={portInput}
                                  onChange={(e) => setPortInput(e.target.value)}
                                  placeholder={detection.exposedPort ? String(detection.exposedPort) : "détecté automatiquement (EXPOSE)"}
                                />
                              </div>
                            </>
                          )}
                        </div>
                      </details>

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

                  {/* Déploiement automatique sur push — indépendant du chemin de déploiement
                      manuel ci-dessus, ne compte pas dans son nombre de clics. */}
                  {operator && canDeployDockerfile && (
                    <div className="card" style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <strong style={{ fontSize: 13 }}>Déploiement automatique sur push</strong>
                        {autoDeploy && (
                          <span className={`chip ${autoDeploy.enabled ? "chip--accent" : "chip--muted"}`}>
                            {autoDeploy.enabled ? "● Actif" : "Inactif"}
                          </span>
                        )}
                      </div>
                      <p className="muted" style={{ fontSize: 12 }}>
                        Un webhook GitHub réel est enregistré sur ce dépôt : chaque push vers la branche surveillée
                        déclenche automatiquement un nouveau déploiement, avec le même sous-domaine/environnement/port
                        que ci-dessus.
                      </p>
                      <div className="field">
                        <label htmlFor="gh-autodeploy-branch">Branche surveillée</label>
                        <input
                          id="gh-autodeploy-branch"
                          value={autoDeployBranchInput}
                          onChange={(e) => setAutoDeployBranchInput(e.target.value)}
                          placeholder={detection.ref}
                          disabled={Boolean(autoDeploy?.enabled)}
                        />
                      </div>
                      {autoDeployError && <div className="error-banner">{autoDeployError}</div>}
                      <div>
                        {autoDeploy?.enabled ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleToggleAutoDeploy(false)}
                            disabled={autoDeploySaving}
                          >
                            {autoDeploySaving ? "…" : "Désactiver"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => handleToggleAutoDeploy(true)}
                            disabled={autoDeploySaving}
                          >
                            {autoDeploySaving ? "…" : "Activer"}
                          </button>
                        )}
                      </div>
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

            {deployments.length === 0 && <div className="empty-state">Aucun déploiement pour l'instant.</div>}

            {latestDeployment && (
              <div
                className={`card github-deploy-card github-deploy-card--${latestDeployment.status}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  borderColor:
                    latestDeployment.status === "success"
                      ? "var(--color-success)"
                      : latestDeployment.status === "failed"
                        ? "var(--color-critical)"
                        : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className={`chip ${latestDeployment.status === "success" ? "chip--accent" : latestDeployment.status === "failed" ? "chip--danger" : ""}`}>
                    {statusLabel(latestDeployment.status).toUpperCase()}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>{formatRelative(latestDeployment.startedAt)}</span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {latestDeployment.owner}/{latestDeployment.repo}@{latestDeployment.ref}
                </div>
                {latestDeployment.commit && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {latestDeployment.commit.authorAvatarUrl && (
                      <img
                        src={latestDeployment.commit.authorAvatarUrl}
                        alt={latestDeployment.commit.author}
                        width={22}
                        height={22}
                        style={{ borderRadius: "50%" }}
                      />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {latestDeployment.commit.message || "(pas de message de commit)"}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {latestDeployment.commit.author} · {latestDeployment.triggeredBy === "webhook" ? "push automatique" : `par ${latestDeployment.startedBy}`}
                      </div>
                    </div>
                  </div>
                )}
                {!latestDeployment.commit && (
                  <div className="muted" style={{ fontSize: 11 }}>
                    {latestDeployment.triggeredBy === "webhook" ? "push automatique" : `démarré par ${latestDeployment.startedBy}`}
                  </div>
                )}

                {latestDeployment.status === "success" && (
                  <div
                    className="success-banner"
                    style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <IconCheck /> Déploiement réussi.
                    </div>
                    {latestDeployment.subdomain && latestDeployment.reverseProxyRouteId && (
                      <a
                        href={domainUrl(latestDeployment.subdomain)}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-primary btn-sm"
                        style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6 }}
                      >
                        <IconGlobe /> Ouvrir {latestDeployment.subdomain}
                      </a>
                    )}
                    {latestDeployment.subdomain && !latestDeployment.reverseProxyRouteId && (
                      <p className="muted" style={{ fontSize: 11 }}>
                        Sous-domaine "{latestDeployment.subdomain}" demandé mais route non créée — voir les logs.
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => dispatch(fetchGithubDeploymentDetail(latestDeployment.id))}
                >
                  Voir les logs
                </button>
              </div>
            )}

            {historyDeployments.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  <IconChevron /> Historique ({historyDeployments.length})
                </summary>
                <div className="iac-run-list" style={{ marginTop: 8 }}>
                  {historyDeployments.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`iac-run-item iac-run-item--${d.status}${d.id === selectedDeployment?.id ? " is-selected" : ""}`}
                      onClick={() => dispatch(fetchGithubDeploymentDetail(d.id))}
                    >
                      <span>
                        {d.owner}/{d.repo}@{d.ref}
                        {d.commit ? ` — ${d.commit.message}` : ""}
                      </span>
                      <span className="iac-run-item__meta">
                        {statusLabel(d.status)} · {d.commit ? d.commit.author : d.startedBy} · {formatDate(d.startedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            )}

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
