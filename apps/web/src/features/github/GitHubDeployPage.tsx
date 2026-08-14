import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  deployGithubRepo,
  fetchGithubAutoDeploy,
  fetchGithubConfigSchema,
  fetchGithubDeploymentDetail,
  fetchGithubDeployments,
  fetchGithubDetection,
  fetchGithubRepos,
  fetchGithubStatus,
  saveGithubAutoDeploy,
  saveGithubConfigValues,
  saveGithubToken,
  selectDeployment,
  selectRepo,
} from "@/features/github/githubSlice";
import DeployConfigForm, { type DeployConfigFormSubmitInput } from "@/features/github/DeployConfigForm";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import Skeleton from "@/components/Skeleton";
import { IconCheck, IconChevron, IconGithub, IconGlobe } from "@/components/icons";
import type { GithubDeploymentStatus } from "@/types";

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

/** Étapes de l'assistant — 1 "Dépôt" -> 2 "Configuration" -> 3 "Déploiement". Navigable en arrière
 * vers une étape déjà atteinte (maxStepReached) uniquement, jamais en avant sans franchir les
 * conditions réelles de chaque étape (repo sélectionné + détection arrivée, puis déploiement
 * effectivement démarré). */
type WizardStep = 1 | 2 | 3;
const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: 1, label: "Dépôt" },
  { id: 2, label: "Configuration" },
  { id: 3, label: "Déploiement" },
];

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

/** Horodatage absolu complet — affiché en title (tooltip) des entrées d'historique, la ligne
 * elle-même reste au format relatif (plus lisible dans une liste courte). */
function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusLabel(status: GithubDeploymentStatus): string {
  if (status === "running") return "en cours…";
  if (status === "success") return "succès";
  if (status === "needs-config") return "configuration requise";
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

const domainUrl = (subdomain: string) => `https://${subdomain}`;

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
    configSchema,
    configSchemaStatus,
    savingConfigValues,
    saveConfigValuesError,
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
  // Service docker-compose choisi pour recevoir la route de sous-domaine — pertinent uniquement
  // quand detection.composeServices compte PLUSIEURS candidats (aucun choix silencieux possible
  // dans ce cas, voir services/github.ts#deployViaDockerCompose) ; auto-rempli quand un seul.
  const [serviceForSubdomainInput, setServiceForSubdomainInput] = useState("");
  const [autoDeployBranchInput, setAutoDeployBranchInput] = useState("");
  const [autoDeployOpen, setAutoDeployOpen] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  // Formulaire dynamique de configuration (variables d'environnement manquantes, ports, volumes —
  // voir DeployConfigForm.tsx) : `configModalTarget` porte le dépôt/emplacement ciblé par la
  // modale ouverte, indépendamment de `selectedRepo` (peut différer en consultant l'historique
  // d'un AUTRE dépôt à l'étape 3, voir handleOpenConfigModal). `composePortOverrides` mémorise les
  // ports hôte choisis explicitement dans la modale, appliqués au PROCHAIN clic "Déployer".
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configModalTarget, setConfigModalTarget] = useState<{ owner: string; repo: string } | null>(null);
  const [composePortOverrides, setComposePortOverrides] = useState<Record<string, number>>({});
  const logRef = useRef<HTMLPreElement>(null);

  // État initial de l'assistant calculé UNE SEULE FOIS au montage à partir du state déjà en
  // mémoire (ex: modal refermée puis rouverte pendant qu'un déploiement tournait encore) — ne
  // force jamais l'utilisateur à repartir de l'étape 1 s'il y a déjà quelque chose à montrer.
  const [step, setStep] = useState<WizardStep>(() => {
    if (selectedDeployment && (selectedDeployment.status === "running" || selectedDeployment.status === "needs-config")) return 3;
    if (selectedRepo && detection) return 2;
    return 1;
  });
  const [maxStepReached, setMaxStepReached] = useState<WizardStep>(step);

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
    setServiceForSubdomainInput("");
    setAutoDeployOpen(false);
    setDeployError(null);
    setComposePortOverrides({});
    // Cible par défaut = l'environnement actuellement sélectionné dans le Topbar, s'il est
    // pertinent pour un déploiement Docker ; repli sur "Docker local" sinon.
    const topbarTarget = topbarEnvironmentId
      ? environments.find((e) => e.id === topbarEnvironmentId && DEPLOY_TARGET_ORCHESTRATORS.has(e.orchestrator))
      : undefined;
    setTargetEnvironmentId(topbarTarget?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, selectedRepo]);

  // Avance automatiquement à l'étape 2 dès que la détection du repo sélectionné arrive — jamais
  // en avant au-delà (ne touche pas `step` si l'utilisateur est déjà revenu voir l'étape 3, par
  // exemple pour consulter un déploiement de l'historique sans changer de repo).
  useEffect(() => {
    if (!selectedRepo || !detection) return;
    setStep((s) => (s === 1 ? 2 : s));
    setMaxStepReached((m) => (m < 2 ? 2 : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection]);

  // Port pré-rempli dès que la détection distante trouve un EXPOSE — n'écrase jamais une valeur
  // déjà tapée par l'utilisateur (dépendance uniquement sur l'arrivée de la détection).
  useEffect(() => {
    if (detection?.exposedPort && !portInput) {
      setPortInput(String(detection.exposedPort));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection?.exposedPort]);

  // Schéma de configuration dynamique (variables d'environnement manquantes, ports, volumes) —
  // récupéré dès que la détection arrive pour un dépôt réellement déployable via Docker (compose ou
  // Dockerfile isolé ; Terraform/Ansible seuls n'ont rien à configurer ici, voir buildDeployConfigSchema
  // côté API). Alimente le bandeau "Configuration requise" ci-dessous AVANT même de cliquer
  // "Déployer" — évite un aller-retour inutile sur le bug réel du 14/08/2026 (.env manquant).
  useEffect(() => {
    if (!selectedRepo || !detection || detection.candidates) return;
    if (!detection.hasCompose && !detection.hasDockerfile) return;
    dispatch(
      fetchGithubConfigSchema({
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        ref: detection.ref,
        ...(detection.detectedPath ? { path: detection.detectedPath } : {}),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, selectedRepo, detection]);

  // Service compose pré-rempli quand il n'y a qu'UN SEUL candidat (aucune saisie requise) — quand
  // il y en a plusieurs, laissé vide : l'utilisateur DOIT choisir explicitement (voir le sélecteur
  // "Service à exposer" plus bas), jamais un choix silencieux d'un des deux.
  useEffect(() => {
    if (detection?.composeServices?.length === 1) {
      setServiceForSubdomainInput(detection.composeServices[0]!.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection?.composeServices]);

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
    setDeployError(null);
    const port = portInput.trim() ? Number(portInput.trim()) : undefined;
    dispatch(
      deployGithubRepo({
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        ...(refInput.trim() ? { ref: refInput.trim() } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
        ...(subdomainInput.trim() ? { subdomain: subdomainInput.trim() } : {}),
        ...(port ? { port } : {}),
        // Même emplacement que celui inspecté à l'étape "Configuration" (racine si absent) — voir
        // GithubRepoDetection#detectedPath.
        ...(detection?.detectedPath ? { configPath: detection.detectedPath } : {}),
        ...(serviceForSubdomainInput.trim() ? { serviceForSubdomain: serviceForSubdomainInput.trim() } : {}),
        // Port(s) hôte choisis explicitement dans le formulaire de configuration dynamique (voir
        // DeployConfigForm.tsx) — {} par défaut, comportement historique inchangé.
        ...(Object.keys(composePortOverrides).length > 0 ? { composePortOverrides } : {}),
      }),
    ).then((result) => {
      if (deployGithubRepo.fulfilled.match(result)) {
        dispatch(selectDeployment({ ...result.payload, log: "" }));
        setStep(3);
        setMaxStepReached((m) => (m < 3 ? 3 : m));
      } else {
        setDeployError(result.payload ?? "Échec du démarrage du déploiement.");
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

  /** Navigation en arrière UNIQUEMENT vers une étape déjà atteinte — jamais en avant (les steps
   * suivantes ne sont accessibles qu'en franchissant réellement leurs conditions : repo + détection
   * pour l'étape 2, déploiement démarré pour l'étape 3). */
  function goToStep(target: WizardStep) {
    if (target <= maxStepReached) setStep(target);
  }

  /** Ouvre un déploiement de l'historique en mode consultation à l'étape 3 — logs de CE déploiement
   * précis, qu'il soit en cours ou déjà terminé (le useEffect de poll ci-dessus ne réagit de toute
   * façon qu'à un statut "running"). Ne touche jamais au repo sélectionné/à la détection : c'est une
   * simple consultation, pas une reprise du flux de déploiement pour ce repo-là. */
  function handleOpenHistoryDeployment(id: string) {
    dispatch(fetchGithubDeploymentDetail(id));
    setStep(3);
    setMaxStepReached((m) => (m < 3 ? 3 : m));
    setHistoryOpen(false);
  }

  /** "Nouveau déploiement" (étape 3) : repart de zéro sur l'étape 1 pour choisir un AUTRE repo —
   * `selectRepo(null)` réinitialise déjà `detection`/`autoDeploy` côté slice (voir githubSlice.ts). */
  function handleNewDeployment() {
    dispatch(selectRepo(null));
    setRefInput("");
    setPortInput("");
    setSubdomainInput("");
    setServiceForSubdomainInput("");
    setTargetEnvironmentId("");
    setAutoDeployBranchInput("");
    setAutoDeployOpen(false);
    setDeployError(null);
    setRepoSearch("");
    setStep(1);
    setMaxStepReached(1);
  }

  /** Choix explicite d'un emplacement candidat (voir GithubRepoDetection#candidates, racine vide +
   * plusieurs sous-dossiers trouvés) — relance la détection SUR ce chemin précis, jamais un choix
   * deviné à l'aveugle. Un seul clic (liste cliquable), conforme à la règle "≤3 clics". */
  function handleSelectCandidate(candidatePath: string) {
    if (!selectedRepo) return;
    dispatch(fetchGithubDetection({ owner: selectedRepo.owner, repo: selectedRepo.repo, path: candidatePath }));
  }

  /** Ouvre le formulaire dynamique de configuration (voir DeployConfigForm.tsx) pour `owner/repo` —
   * indépendant de `selectedRepo` : peut cibler un AUTRE dépôt que celui actuellement sélectionné
   * en consultant l'historique à l'étape 3 (voir le bandeau "needs-config" plus bas). Un seul clic
   * (bouton "Configurer"), cohérent avec la règle "≤3 clics". */
  function handleOpenConfigModal(owner: string, repo: string, ref?: string, path?: string) {
    setConfigModalTarget({ owner, repo });
    dispatch(fetchGithubConfigSchema({ owner, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) }));
    setConfigModalOpen(true);
  }

  /** Enregistre les valeurs saisies (secret nommé "github-env:<owner>/<repo>", voir
   * services/github.ts#saveGithubEnvValues côté API) — réutilisées automatiquement au prochain
   * "Déployer"/"Redéployer", sans re-demander. Les ports hôte éventuellement choisis sont mémorisés
   * pour être appliqués au déploiement suivant (voir composePortOverrides ci-dessus). */
  function handleSubmitConfig(input: DeployConfigFormSubmitInput) {
    if (!configModalTarget) return;
    dispatch(
      saveGithubConfigValues({
        owner: configModalTarget.owner,
        repo: configModalTarget.repo,
        values: input.values,
        ...(input.secretRefs ? { secretRefs: input.secretRefs } : {}),
      }),
    ).then((result) => {
      if (saveGithubConfigValues.fulfilled.match(result)) {
        if (input.composePortOverrides) setComposePortOverrides((prev) => ({ ...prev, ...input.composePortOverrides }));
        // La fermeture de la modale (immédiate, ou après le panneau de révélation d'un compte
        // admin généré) est gérée PAR DeployConfigForm lui-même (voir son effet sur `saving`) —
        // jamais fermée ici, sinon le panneau de révélation n'aurait jamais le temps de s'afficher.
        dispatch(fetchGithubConfigSchema({ owner: configModalTarget.owner, repo: configModalTarget.repo }));
      }
    });
  }

  const canBrowseRepos = Boolean(status?.configured || status?.usingGhcrFallback);
  const canDeployDockerfile = Boolean(detection?.hasDockerfile);
  const canDeployCompose = Boolean(detection?.hasCompose);
  // Sous-domaine + cible de déploiement sont pertinents pour les DEUX (Dockerfile seul ET compose,
  // tous deux pilotés via services/docker.ts#getClient) — le port manuel, lui, reste spécifique au
  // flux Dockerfile seul (compose résout ses ports depuis le YAML + le sélecteur de service).
  const canDeployToDocker = canDeployDockerfile || canDeployCompose;
  const canDeployAny = canDeployToDocker || Boolean(detection?.hasTerraform) || Boolean(detection?.hasAnsible);
  const composeServiceCandidates = detection?.composeServices ?? [];
  // Un sous-domaine ne peut être routé qu'après un choix explicite du service quand il y en a
  // plusieurs (voir le useEffect d'auto-remplissage ci-dessus) — bloque le déploiement plutôt que
  // de laisser le backend deviner silencieusement (il ne devine jamais non plus, mais autant le
  // signaler ici, avant même de lancer le déploiement).
  const composeServiceChoicePending =
    canDeployCompose && composeServiceCandidates.length > 1 && Boolean(subdomainInput.trim()) && !serviceForSubdomainInput;
  // Configuration dynamique (variables d'environnement manquantes, voir DeployConfigForm.tsx) :
  // bloque le déploiement tant que des clés REQUISES restent sans valeur connue — jamais un
  // `docker compose up`/`docker build` lancé à l'aveugle sur le bug réel du 14/08/2026 (.env
  // manquant). `configSchema` peut porter le schéma d'un AUTRE dépôt en transition (fetch encore en
  // vol après un changement de sélection) : ne bloque que quand il correspond au dépôt courant.
  const configSchemaMatchesSelectedRepo =
    Boolean(configSchema) && configSchema!.owner === selectedRepo?.owner && configSchema!.repo === selectedRepo?.repo;
  const configBlocksDeploy = configSchemaMatchesSelectedRepo && configSchema!.missingRequiredKeys.length > 0;
  // Déploiement automatique sur push : la config actuelle (routes/githubWebhook.ts) ne connaît ni
  // sous-dossier ni choix de service compose — n'exposer le bouton "Configurer" que dans le cas
  // NON ambigu (racine, ou un seul service compose) pour ne jamais activer un déploiement
  // automatique qui se tromperait d'emplacement/service silencieusement à chaque push.
  const canConfigureAutoDeploy = canDeployToDocker && !detection?.detectedPath && composeServiceCandidates.length <= 1;

  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, repoSearch]);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>
            <IconGithub className="inline-icon" /> GitHub
          </h2>
          <p>
            Parcourez vos vrais dépôts GitHub, détectez Dockerfile/docker-compose/Terraform/Ansible (racine ou
            sous-dossier), puis buildez et déployez réellement (Docker local ou distant) en 2 clics — sous-domaine,
            environnement et port sont pré-remplis automatiquement. Terraform/Ansible seuls : un workspace
            Infra-as-code est créé, sans "apply"/"ansible-playbook" automatique.
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
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Enregistré UNE SEULE FOIS comme secret réutilisable ("github-token", Gestionnaire de secrets) — plus jamais
            redemandé ensuite, réutilisé automatiquement partout où QUAI a besoin d'un jeton GitHub (cette page,
            détection de dépôts, déploiement automatique sur push).
          </p>
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
        <div className="gh-wizard">
          <div className="gh-wizard__head">
            <div className="gh-steps" role="tablist" aria-label="Étapes du déploiement">
              {WIZARD_STEPS.map((s, i) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                  {i > 0 && <span className="gh-steps__sep" />}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={step === s.id}
                    className={`gh-steps__step${step === s.id ? " is-active" : ""}${s.id <= maxStepReached ? " is-reachable" : ""}`}
                    onClick={() => goToStep(s.id)}
                    disabled={s.id > maxStepReached}
                  >
                    <span className="gh-steps__num">{s.id}</span>
                    {s.label}
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistoryOpen((o) => !o)}>
              <IconChevron className={`gh-history-toggle-icon${historyOpen ? " is-open" : ""}`} />
              Historique ({deployments.length})
            </button>
          </div>

          {historyOpen && (
            <div className="gh-wizard-history-panel">
              <div className="gh-wizard-history-panel__head">
                <strong style={{ fontSize: 12.5 }}>Historique des déploiements</strong>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistoryOpen(false)}>
                  Fermer
                </button>
              </div>
              {deployments.length === 0 && <div className="empty-state">Aucun déploiement pour l'instant.</div>}
              {deployments.length > 0 && (
                <div className="iac-run-list gh-wizard-history-panel__list">
                  {deployments.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`iac-run-item iac-run-item--${d.status}${d.id === selectedDeployment?.id ? " is-selected" : ""}`}
                      onClick={() => handleOpenHistoryDeployment(d.id)}
                    >
                      <span>
                        {d.owner}/{d.repo}@{d.ref}
                        {d.commit ? ` — ${d.commit.message}` : ""}
                      </span>
                      <span className="iac-run-item__meta" title={formatAbsolute(d.startedAt)}>
                        {statusLabel(d.status)} · {d.commit ? d.commit.author : d.startedBy} · {formatRelative(d.startedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="gh-step gh-step--repo">
              <div className="gh-step__toolbar">
                <input
                  type="search"
                  className="gh-step__search"
                  placeholder="Rechercher un dépôt (nom complet)…"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                />
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
                  {filteredRepos.length === 0 && (
                    <div className="empty-state">
                      {repos.length === 0 ? "Aucun dépôt accessible." : "Aucun dépôt ne correspond à la recherche."}
                    </div>
                  )}
                  <div className="iac-workspace-list gh-step__repo-list">
                    {filteredRepos.map((r) => (
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
          )}

          {step === 2 && (
            <div className="gh-step gh-step--config">
              {!selectedRepo && (
                <div className="empty-state">
                  Sélectionnez un dépôt à l'étape précédente.
                  <div style={{ marginTop: 10 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToStep(1)}>
                      ← Retour au dépôt
                    </button>
                  </div>
                </div>
              )}

              {selectedRepo && (
                <>
                  <div className="inspector-section-title" style={{ marginBottom: 0 }}>
                    {selectedRepo.owner}/{selectedRepo.repo}
                  </div>

                  {detectionStatus === "loading" && <div className="empty-state">Détection en cours…</div>}
                  {detectionError && <div className="error-banner">{detectionError}</div>}

                  {/* Racine vide + plusieurs emplacements candidats trouvés en sous-dossier (voir
                      GithubRepoDetection#candidates) — jamais deviné à l'aveugle : un simple choix
                      dans une liste, ≤3 clics au total pour arriver au déploiement. */}
                  {detection?.candidates && detection.candidates.length > 0 && (
                    <>
                      <p className="muted" style={{ fontSize: 12.5 }}>
                        Rien à la racine, mais {detection.candidates.length} emplacements possibles trouvés dans des
                        sous-dossiers — choisissez lequel déployer :
                      </p>
                      <div className="iac-workspace-list">
                        {detection.candidates.map((c) => (
                          <button key={c.path} type="button" className="iac-workspace-item" onClick={() => handleSelectCandidate(c.path)}>
                            <span className="iac-workspace-item__name">{c.path}/</span>
                            <span className="iac-workspace-item__engine">
                              {[
                                c.hasCompose && "docker-compose",
                                c.hasDockerfile && "Dockerfile",
                                c.hasTerraform && "Terraform",
                                c.hasAnsible && "Ansible",
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {detection && !detection.candidates && (
                    <>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <span className={`chip ${detection.hasCompose ? "chip--accent" : ""}`}>
                          {detection.hasCompose ? "●" : "✗"} docker-compose
                        </span>
                        <span className={`chip ${detection.hasDockerfile ? "chip--accent" : ""}`}>
                          {detection.hasDockerfile ? "●" : "✗"} Dockerfile
                          {detection.exposedPort ? ` (port ${detection.exposedPort})` : ""}
                        </span>
                        <span className={`chip ${detection.hasTerraform ? "chip--accent" : ""}`}>
                          {detection.hasTerraform ? "●" : "✗"} Terraform
                          {detection.hasTerraform ? ` (${detection.terraformFiles.join(", ")})` : ""}
                        </span>
                        <span className={`chip ${detection.hasAnsible ? "chip--accent" : ""}`}>
                          {detection.hasAnsible ? "●" : "✗"} Ansible
                          {detection.ansiblePlaybook ? ` (${detection.ansiblePlaybook})` : ""}
                        </span>
                      </div>
                      <p className="muted" style={{ fontSize: 12 }}>
                        {detection.detectedPath ? (
                          <>
                            Détecté dans le sous-dossier <code>{detection.detectedPath}/</code>
                          </>
                        ) : (
                          "Détecté à la racine du dépôt"
                        )}
                        , branche <code>{detection.ref}</code>.
                      </p>

                      {!canDeployAny && (
                        <p className="graph-popover__error">
                          Aucun Dockerfile, docker-compose, fichier Terraform ni playbook Ansible détecté — rien à
                          déployer automatiquement.
                        </p>
                      )}

                      {operator && canDeployAny && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {/* Chemin principal : SEUL champ visible par défaut est le sous-domaine
                              (pré-rempli, jamais obligatoire à modifier) — 0 saisie requise pour
                              déployer, tout le reste est replié derrière "Options avancées". */}
                          {canDeployToDocker && (
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

                          {/* Ambiguïté RÉELLE (plusieurs services compose exposent un port) : jamais
                              devinée côté serveur non plus (voir deployViaDockerCompose) — un choix
                              explicite ici évite l'aller-retour d'un déploiement dont la route
                              n'aurait finalement pas été créée. */}
                          {canDeployCompose && composeServiceCandidates.length > 1 && (
                            <div className="field">
                              <label htmlFor="gh-compose-service">Service à exposer (plusieurs services déclarent un port)</label>
                              <select
                                id="gh-compose-service"
                                value={serviceForSubdomainInput}
                                onChange={(e) => setServiceForSubdomainInput(e.target.value)}
                              >
                                <option value="">— choisir —</option>
                                {composeServiceCandidates.map((s) => (
                                  <option key={s.name} value={s.name}>
                                    {s.name}
                                    {s.port ? ` (port ${s.port})` : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <details>
                            <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--color-text-muted)" }}>
                              Options avancées (branche{canDeployToDocker ? ", environnement cible" : ""}
                              {canDeployDockerfile && !canDeployCompose ? ", port" : ""})
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
                              {canDeployToDocker && (
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
                              )}
                              {canDeployDockerfile && !canDeployCompose && (
                                <div className="field">
                                  <label htmlFor="gh-port">Port du conteneur (pour le sous-domaine)</label>
                                  <input
                                    id="gh-port"
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={portInput}
                                    onChange={(e) => setPortInput(e.target.value)}
                                    placeholder={
                                      detection.exposedPort ? String(detection.exposedPort) : "détecté automatiquement (EXPOSE)"
                                    }
                                  />
                                </div>
                              )}
                            </div>
                          </details>

                          {canDeployCompose && (
                            <p className="muted" style={{ fontSize: 12 }}>
                              Déploiement via <code>docker compose</code> dans un projet isolé (build + up des services
                              définis dans le fichier compose) — port hôte déjà utilisé par un autre conteneur :
                              remplacé automatiquement par un port libre, journalisé dans le déploiement.
                            </p>
                          )}

                          {!canDeployCompose && !canDeployDockerfile && (detection.hasTerraform || detection.hasAnsible) && (
                            <p className="muted" style={{ fontSize: 12 }}>
                              Un workspace Infra-as-code sera créé à partir des fichiers{" "}
                              {detection.hasTerraform ? "Terraform" : "Ansible"} détectés — aucun "apply"/"ansible-playbook"
                              automatique, à lancer ensuite depuis le nœud du workspace dans le graphe.
                            </p>
                          )}

                          {/* Configuration requise (variables d'environnement manquantes, voir
                              DeployConfigForm.tsx) — corrige le bug réel du 14/08/2026 (.env
                              manquant) : jamais un `docker compose up` lancé à l'aveugle, l'utilisateur
                              renseigne les clés manquantes AVANT de cliquer "Déployer". */}
                          {configBlocksDeploy && (
                            <div className="error-banner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <span>
                                Configuration requise avant de pouvoir déployer : {configSchema!.missingRequiredKeys.join(", ")}.
                              </span>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                style={{ alignSelf: "flex-start" }}
                                onClick={() => handleOpenConfigModal(selectedRepo.owner, selectedRepo.repo, detection.ref, detection.detectedPath)}
                              >
                                Configurer
                              </button>
                            </div>
                          )}
                          {/* Action explicite pour modifier des valeurs déjà configurées PLUS TARD
                              (jamais figées à vie, voir mission) — discrète, toujours disponible dès
                              qu'il y a quelque chose à configurer/consulter (variables, ports, volumes). */}
                          {!configBlocksDeploy &&
                            configSchemaMatchesSelectedRepo &&
                            (configSchema!.envVars.length > 0 || configSchema!.ports.some((p) => p.overridable) || configSchema!.volumes.length > 0) && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ alignSelf: "flex-start" }}
                                onClick={() => handleOpenConfigModal(selectedRepo.owner, selectedRepo.repo, detection.ref, detection.detectedPath)}
                              >
                                Configuration ({configSchema!.envVars.length} variable{configSchema!.envVars.length > 1 ? "s" : ""})
                              </button>
                            )}

                          {deployError && <div className="error-banner">{deployError}</div>}

                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleDeploy}
                            disabled={deploying || composeServiceChoicePending || configBlocksDeploy}
                            title={
                              composeServiceChoicePending
                                ? "Choisissez le service à exposer avant de déployer"
                                : configBlocksDeploy
                                  ? "Renseignez la configuration requise avant de déployer"
                                  : undefined
                            }
                            style={{ padding: "12px 16px", fontSize: 14, fontWeight: 600 }}
                          >
                            {deploying ? "Démarrage…" : "Déployer"}
                          </button>

                          {/* Déploiement automatique sur push — option annexe de CETTE étape (pas une
                              4e étape), repliée par défaut pour garder le focus sur le déploiement
                              manuel ci-dessus. Non proposé pour un emplacement/service ambigu (voir
                              canConfigureAutoDeploy) : le webhook (routes/githubWebhook.ts) ne connaît
                              ni sous-dossier ni choix de service, jamais un déploiement automatique
                              qui se tromperait d'emplacement silencieusement à chaque push. */}
                          {canConfigureAutoDeploy && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{ alignSelf: "flex-start" }}
                              onClick={() => setAutoDeployOpen((o) => !o)}
                            >
                              {autoDeployOpen ? "Masquer le déploiement automatique" : "Configurer le déploiement automatique"}
                              {autoDeploy?.enabled && (
                                <span className="chip chip--accent" style={{ marginLeft: 6 }}>
                                  Actif
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                      )}

                      {operator && canConfigureAutoDeploy && autoDeployOpen && (
                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="gh-step gh-step--deploy">
              {!selectedDeployment && <div className="empty-state">Aucun déploiement sélectionné.</div>}

              {selectedDeployment && (
                <>
                  <div className="gh-deploy-status">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {selectedDeployment.owner}/{selectedDeployment.repo}@{selectedDeployment.ref}
                      </div>
                      {selectedDeployment.commit && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                          {selectedDeployment.commit.authorAvatarUrl && (
                            <img
                              src={selectedDeployment.commit.authorAvatarUrl}
                              alt={selectedDeployment.commit.author}
                              width={20}
                              height={20}
                              style={{ borderRadius: "50%" }}
                            />
                          )}
                          <span className="muted" style={{ fontSize: 12 }}>
                            {selectedDeployment.commit.message || "(pas de message de commit)"} —{" "}
                            {selectedDeployment.commit.author}
                          </span>
                        </div>
                      )}
                      {!selectedDeployment.commit && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {selectedDeployment.triggeredBy === "webhook"
                            ? "push automatique"
                            : `démarré par ${selectedDeployment.startedBy}`}
                        </div>
                      )}
                    </div>
                    <span
                      className={`chip ${
                        selectedDeployment.status === "success"
                          ? "chip--accent"
                          : selectedDeployment.status === "failed"
                            ? "chip--danger"
                            : selectedDeployment.status === "needs-config"
                              ? "chip--muted"
                              : ""
                      }`}
                    >
                      {statusLabel(selectedDeployment.status).toUpperCase()}
                    </span>
                  </div>

                  {selectedDeployment.status === "success" && (
                    <div className="success-banner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <IconCheck /> Déploiement réussi.
                      </div>
                      {selectedDeployment.subdomain && selectedDeployment.reverseProxyRouteId && (
                        <a
                          href={domainUrl(selectedDeployment.subdomain)}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-primary btn-sm"
                          style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <IconGlobe /> Ouvrir {selectedDeployment.subdomain}
                        </a>
                      )}
                      {selectedDeployment.subdomain && !selectedDeployment.reverseProxyRouteId && (
                        <p className="muted" style={{ fontSize: 11 }}>
                          Sous-domaine "{selectedDeployment.subdomain}" demandé mais route non créée — voir les logs.
                        </p>
                      )}
                    </div>
                  )}

                  {selectedDeployment.status === "failed" && (
                    <div className="error-banner">Le déploiement a échoué — voir le journal ci-dessous pour le détail.</div>
                  )}

                  {/* "needs-config" (14/08/2026) : le clone a détecté des variables d'environnement
                      requises sans valeur connue — arrêté PROPREMENT avant tout `docker build`/
                      `docker compose up`, jamais l'échec docker brut d'origine ("env file ... not
                      found"). Le bouton ouvre le MÊME formulaire dynamique qu'à l'étape 2. */}
                  {selectedDeployment.status === "needs-config" && (
                    <div className="error-banner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span>
                        Configuration requise — variable{(selectedDeployment.missingConfigKeys ?? []).length > 1 ? "s" : ""}{" "}
                        manquante{(selectedDeployment.missingConfigKeys ?? []).length > 1 ? "s" : ""} :{" "}
                        {(selectedDeployment.missingConfigKeys ?? []).join(", ") || "voir le journal ci-dessous"}.
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        style={{ alignSelf: "flex-start" }}
                        onClick={() =>
                          handleOpenConfigModal(
                            selectedDeployment.owner,
                            selectedDeployment.repo,
                            selectedDeployment.ref,
                            selectedDeployment.configPath,
                          )
                        }
                      >
                        Configurer
                      </button>
                      <p className="muted" style={{ fontSize: 11 }}>
                        Une fois enregistrées, revenez à "Revoir la configuration" puis "Déployer" pour relancer — les
                        valeurs saisies sont réutilisées automatiquement, sans re-demander.
                      </p>
                    </div>
                  )}

                  {selectedDeployment.status === "running" && (
                    <div className="empty-state" style={{ textAlign: "left" }}>
                      Déploiement en cours…
                    </div>
                  )}

                  <pre ref={logRef} className="iac-log">
                    {selectedDeployment.log || "(pas de sortie)"}
                  </pre>

                  <div className="gh-deploy-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToStep(2)} disabled={!selectedRepo}>
                      ← Revoir la configuration
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleNewDeployment}>
                      Nouveau déploiement
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <DeployConfigForm
        open={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        schema={configSchema}
        loading={configSchemaStatus === "loading"}
        saving={savingConfigValues}
        error={saveConfigValuesError}
        submitLabel={configSchema && configSchema.missingRequiredKeys.length > 0 ? "Enregistrer et déployer" : "Enregistrer"}
        onSubmit={handleSubmitConfig}
      />
    </div>
  );
}
