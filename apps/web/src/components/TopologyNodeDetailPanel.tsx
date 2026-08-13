import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchContainerDetail } from "@/features/containers/containersSlice";
import { fetchImages, fetchScanDetail, fetchScans, scanImage } from "@/features/images/imagesSlice";
import { fetchVolumes, openVolumeBrowser, removeVolume } from "@/features/volumes/volumesSlice";
import { fetchNetworks, removeNetwork } from "@/features/networks/networksSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
import { apiGet } from "@/api/client";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import MetricsChart from "@/components/MetricsChart";
import VolumeFilesModal from "@/components/VolumeFilesModal";
import ContainerConsole from "@/components/ContainerConsole";
import ContainerLogs from "@/features/containers/ContainerLogs";
import { IconHistory, IconTerminal } from "@/components/icons";
import { KIND_ICON, formatMem, idWithoutPrefix } from "@/components/topologyGraphShared";
// Panneau "iac-workspace" ci-dessous (mission point 3) : réutilise TEL QUEL le state/les thunks
// déjà exposés par iacSlice.ts (auparavant consommés par la page dédiée IacPage.tsx, retirée —
// voir mission point 5) — aucune route/logique dupliquée, juste une nouvelle UI par-dessus.
import {
  deleteWorkspace,
  fetchEngines,
  fetchFiles,
  fetchRunDetail,
  fetchRuns,
  openFile,
  runAction,
  saveFile,
  selectWorkspace,
  setOpenFileContent,
} from "@/features/iac/iacSlice";
import {
  deleteCronJob,
  fetchCronJobRuns,
  fetchCronJobs,
  triggerCronJob,
  updateCronJob,
} from "@/features/cronJobs/cronJobsSlice";
import {
  deleteBackupDefinition,
  fetchBackupDefinitions,
  fetchBackupRuns,
  restoreBackup,
  runBackupNow,
} from "@/features/backups/backupsSlice";
import {
  fetchGitopsCommits,
  fetchGitopsDiff,
  fetchGitopsFiles,
  selectFile as selectGitopsFile,
  setActiveTab as setGitopsActiveTab,
  syncGitops,
} from "@/features/gitops/gitopsSlice";
// Panneaux "automation-trigger"/"automation-condition"/"automation-action" ci-dessous (câblage
// frontend du moteur d'automatisation, apps/api/src/routes/automation.ts) — réutilise le nouveau
// slice dédié (automationSlice.ts) : DELETE /api/automation/nodes/:id réel pour la suppression,
// GET /api/automation/runs réel pour l'historique d'exécution affiché sur trigger/action.
import { deleteAutomationNode, fetchAutomationRuns } from "@/features/automation/automationSlice";
// Section "Déployé depuis GitHub" (mission point B) ci-dessous, onglet "Aperçu" d'un conteneur —
// réutilise TEL QUEL fetchGithubDeployments (githubSlice.ts, déjà exposé pour GitHubDeployPage.tsx,
// liste TOUT l'historique indépendamment d'un repo sélectionné) pour retrouver le déploiement
// GitHub réel dont `containerId` correspond à ce nœud, et deployGithubRepo pour "Redéployer" avec
// les mêmes paramètres. Aucune nouvelle route backend : GET /api/github/deployments porte déjà
// `containerId` (voir apps/api/src/types.ts#GithubDeployment). Le détail complet (log) est en
// revanche récupéré via un simple apiGet local (comme l'onglet "Métriques" plus bas dans ce même
// fichier) plutôt que via le thunk fetchGithubDeploymentDetail/selectDeployment du slice : ce
// dernier alimente `state.github.selectedDeployment`, également lu par l'assistant 3 étapes de
// GitHubDeployPage.tsx (étape "Déploiement") — le réutiliser ici écraserait silencieusement son
// état si la modal GitHub est rouverte ensuite.
import { deployGithubRepo, fetchGithubDeployments } from "@/features/github/githubSlice";
import type { ContainerMetricPoint, Topology, TopologyHostKind, TopologyNode, TopologyNodeKind, VulnSeverity } from "@/types";
import type { AutomationRunLogEntry, BackupRun, CronJobRun } from "@/types";
import type { GithubDeployment, GithubDeploymentDetail } from "@/types";
import type { IacEngine, IacRunStatus } from "@/types";

/** Les 3 networks internes par défaut de Docker ne sont jamais supprimables — même exclusion que
 * NetworksPage.tsx (retirée) et TopologyGraph.tsx#nodeMenuItems (menu contextuel du nœud). */
const DEFAULT_NETWORK_NAMES = ["bridge", "host", "none"];

/** Rafraîchissement de l'onglet "Métriques" pendant qu'il est affiché — même ordre de grandeur que
 * config.metrics.intervalMs côté API (30s par défaut) : inutile de sonder plus vite qu'un nouveau
 * point n'est réellement écrit par metricsCollector.ts. */
const METRICS_POLL_MS = 30_000;

/** Vérification automatique de la dérive GitOps pendant que le panneau affiche un nœud
 * "gitops-source" — repris tel quel de l'ancienne GitOpsPage.tsx (même intervalle, même garde
 * onglet en arrière-plan) : reflète côté client le rythme de la boucle de réconciliation GitOps
 * côté API (apps/api/src/services/gitopsReconciler.ts), lecture seule (GET /api/gitops/files),
 * ne déclenche jamais de resynchronisation. */
const GITOPS_REFRESH_INTERVAL_MS = 90_000;

interface TopologyNodeDetailPanelProps {
  /** Nœud dont on affiche le détail complet — null referme le panneau. */
  node: TopologyNode | null;
  /**
   * Graphe complet déjà chargé côté client — sert UNIQUEMENT à reconstruire, pour un conteneur, la
   * liste RÉELLE des networks auxquels il est attaché : depuis l'introduction des "briques" (voir
   * services/topology.ts), une partie de ces networks n'a plus d'arête dans `topology.edges`
   * (attachés à ce seul conteneur, voir node.attachments) tandis que l'autre partie (partagés/par
   * défaut) en a toujours une — cette reconstruction recombine les deux pour ne rien perdre.
   * `null` tant que le graphe n'a pas encore chargé (le panneau reste utilisable, juste sans cette
   * liste tant que `topology` n'est pas prêt).
   */
  topology: Topology | null;
  onClose: () => void;
  /** Navigation interne (clic sur un network dans l'onglet "Réseau", ou sur une brique d'un autre
   * nœud) : remplace le nœud affiché SANS fermer/rouvrir le panneau — évite l'aller-retour visuel
   * d'une fermeture suivie d'une réouverture pour simplement changer de ressource inspectée. */
  onNavigate: (node: TopologyNode) => void;
  /** Onglet ouvert à l'affichage d'un NOUVEAU nœud (voir l'effet basé sur `node?.id` plus bas) —
   * absent = "overview" (comportement historique). Sert par ex. à la carte flottante d'alerte "CPU
   * élevé" du graphe (voir topologyGraphShared.tsx#GraphNode/TopologyGraph.tsx#onViewCpuMetrics)
   * pour ouvrir directement sur "metrics" plutôt que de forcer un clic supplémentaire. */
  initialTab?: TabId | undefined;
}

const SEVERITY_ORDER: VulnSeverity[] = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
const SEVERITY_SEMANTIC: Record<VulnSeverity, "critical" | "warning" | "neutral"> = {
  Critical: "critical",
  High: "critical",
  Medium: "warning",
  Low: "neutral",
  Negligible: "neutral",
  Unknown: "neutral",
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthcheck OK",
  unhealthy: "Healthcheck en échec",
  starting: "Healthcheck en cours de démarrage",
  none: "Pas de healthcheck défini",
};
const HEALTH_SEMANTIC: Record<string, "success" | "critical" | "warning" | "neutral"> = {
  healthy: "success",
  unhealthy: "critical",
  starting: "warning",
  none: "neutral",
};

/** Libellé du sous-type d'un nœud "host" (voir TopologyNode#hostKind) — affiché en badge à côté du
 * statut, pour distinguer les trois sources possibles sans dépendre du libellé/sous-titre libre. */
const HOST_KIND_LABEL: Record<TopologyHostKind, string> = {
  "docker-local": "Docker local",
  "nutanix-cluster": "Cluster Nutanix",
  "remote-docker": "Docker distant",
  lxc: "Hôte LXD",
};

/** Libellé humain d'un moteur IaC — même table que services/topology.ts#IAC_ENGINE_LABEL et
 * l'ancienne IacPage.tsx (retirée). */
const IAC_ENGINE_LABEL: Record<IacEngine, string> = { tofu: "OpenTofu", ansible: "Ansible", packer: "Packer" };

/** Actions RÉELLEMENT proposées par moteur — copie frontend de services/iac/runner.ts#ENGINE_ACTIONS
 * (un module apps/api n'est pas importable depuis apps/web, même duplication assumée que
 * l'ancienne IacPage.tsx) : startRun() revalide de toute façon côté serveur qu'une action est
 * permise pour l'engine donné, cette liste ne sert qu'à construire les boutons. */
const IAC_ENGINE_ACTIONS: Record<IacEngine, string[]> = {
  tofu: ["init", "plan", "apply", "destroy"],
  ansible: ["run"],
  packer: ["init", "build"],
};

/** Libellé précis du dernier run connu d'un workspace (voir TopologyNode#iacLastRunStatus) —
 * affiché en overlay du statut générique du nœud (StatusPill status={node.status}), qui ne
 * distingue à lui seul que 4 valeurs génériques (voir apps/api/src/types.ts#TopologyNode). */
const IAC_RUN_STATUS_LABEL: Record<"neutral" | IacRunStatus, string> = {
  neutral: "Jamais exécuté",
  running: "Run en cours",
  success: "Dernier run réussi",
  failed: "Dernier run en échec",
};

/** Poll du run sélectionné pendant qu'il tourne — même intervalle que l'ancienne IacPage.tsx
 * (retirée), plus simple qu'un flux WebSocket pour ce premier lot (voir services/iac/runner.ts). */
const IAC_RUN_POLL_MS = 2000;

/** Heuristique de masquage des variables d'environnement qui RESSEMBLENT à un secret par leur nom
 * de clé — ce composant n'a aucune idée de ce qui est un VRAI secret géré par le gestionnaire de
 * secrets de l'app (SecretRef, écrit-seul côté API) : mieux vaut masquer par prudence une variable
 * qui n'en est pas vraiment un que l'inverse. */
const SECRET_KEY_PATTERN = /PASSWORD|SECRET|TOKEN|KEY/i;

export type TabId = "overview" | "network" | "volumes" | "variables" | "vulnerabilities" | "metrics";

interface TabDef {
  id: TabId;
  label: string;
}

/** Onglets réels (pas de simples sections empilées) — adaptés au kind : un conteneur a les six,
 * les autres kinds (volume/network/nutanix-vm/ad-server/host) n'ont qu'un seul aperçu, rien d'autre
 * à montrer de pertinent (pas de ports/volumes/variables/vulnérabilités/métriques pour une ressource
 * qui n'en a pas). */
const CONTAINER_TABS: TabDef[] = [
  { id: "overview", label: "Aperçu" },
  { id: "network", label: "Réseau" },
  { id: "volumes", label: "Volumes" },
  { id: "variables", label: "Variables" },
  { id: "vulnerabilities", label: "Vulnérabilités" },
  { id: "metrics", label: "Métriques" },
];
const OVERVIEW_ONLY_TABS: TabDef[] = [{ id: "overview", label: "Aperçu" }];

function tabsForKind(kind: TopologyNodeKind): TabDef[] {
  return kind === "container" ? CONTAINER_TABS : OVERVIEW_ONLY_TABS;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Ligne "clé = valeur" d'une variable d'environnement, avec révélation à la demande si la clé
 * ressemble à un secret — même esprit visuel que .kv-row (KeyValueList) mais avec un bouton en
 * plus, donc composant dédié plutôt qu'un détournement de KeyValueList. */
function EnvVarRow({ entry }: { entry: string }) {
  const [revealed, setRevealed] = useState(false);
  const eq = entry.indexOf("=");
  const key = eq >= 0 ? entry.slice(0, eq) : entry;
  const value = eq >= 0 ? entry.slice(eq + 1) : "";
  const looksSecret = SECRET_KEY_PATTERN.test(key);
  const masked = looksSecret && !revealed;
  return (
    <div className="kv-row">
      <span className="kv-row__key" title={key}>
        {key}
      </span>
      <span className="env-var-row__value-wrap">
        <span className="kv-row__value" title={masked ? undefined : value || "—"}>
          {masked ? "••••••••" : value || "—"}
        </span>
        {looksSecret && (
          <button type="button" className="env-var-row__reveal" onClick={() => setRevealed((r) => !r)}>
            {revealed ? "masquer" : "afficher"}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Contenu complet du nœud "iac-workspace" pour CE workspace précis — repris de l'ancienne
 * IacPage.tsx (retirée, voir mission point 5) : fichiers réels du workspace (édition +
 * enregistrement, PUT /api/iac/workspaces/:id/files/:path), actions réelles selon le moteur
 * (IAC_ENGINE_ACTIONS, mêmes valeurs que services/iac/runner.ts#ENGINE_ACTIONS), historique des
 * runs avec statut + log complet d'un run sélectionné, suppression du workspace. Sous-composant
 * dédié (plutôt qu'inline dans le corps du panneau, comme les autres kinds) car lui seul a besoin
 * de piloter `state.iac` (iacSlice.ts) — garde le reste du panneau simple, aucun state.iac.* lu en
 * dehors de ce sous-arbre.
 *
 * Action destructive "destroy" (tofu uniquement) : confirmation explicite `useConfirm`/variant
 * danger AVANT tout lancement réel — jamais relâchée en migrant depuis IacPage.tsx (voir mission
 * point 3), qui ne la demandait déjà que pour la suppression du workspace lui-même ; ce panneau
 * l'étend à "destroy" (détruit réellement l'infrastructure provisionnée, action au moins aussi
 * dangereuse qu'une suppression de workspace).
 */
function IacWorkspacePanel({ node, operate, onClose }: { node: TopologyNode; operate: boolean; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const workspaceId = idWithoutPrefix(node.id);
  const { engines, files, openFilePath, openFileContent, runs, selectedRun } = useAppSelector((s) => s.iac);
  const logRef = useRef<HTMLPreElement>(null);
  // Toujours défini en pratique (voir services/topology.ts#getIacWorkspaceNodes, qui pose
  // systématiquement iacEngine sur un nœud "iac-workspace") — secours "tofu" purement défensif
  // pour satisfaire le typage optionnel du champ, même pattern que HOST_KIND_LABEL[node.hostKind
  // ?? "remote-docker"] pour le kind "host" plus bas dans ce fichier.
  const engine = node.iacEngine ?? "tofu";
  const engineStatus = engines.find((e) => e.engine === engine);

  useEffect(() => {
    dispatch(fetchEngines());
  }, [dispatch]);

  // Nouveau workspace affiché -> réinitialise le state.iac (fichier ouvert/run sélectionné d'un
  // éventuel workspace précédemment inspecté) avant de recharger le sien, même garde que l'ancienne
  // IacPage.tsx#selectWorkspace.
  useEffect(() => {
    dispatch(selectWorkspace(workspaceId));
    dispatch(fetchFiles(workspaceId));
    dispatch(fetchRuns(workspaceId));
  }, [dispatch, workspaceId]);

  // Poll le run sélectionné pendant qu'il tourne — même principe que l'ancienne IacPage.tsx.
  useEffect(() => {
    if (!selectedRun || selectedRun.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchRunDetail({ workspaceId, runId: selectedRun.id }));
    }, IAC_RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [dispatch, workspaceId, selectedRun]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [selectedRun?.log]);

  async function handleRun(action: string) {
    if (action === "destroy") {
      const ok = await confirm({
        title: "Détruire l'infrastructure",
        description: `Confirmer "tofu destroy" pour le workspace "${node.label}" ? Cette action supprime réellement les ressources provisionnées par ce workspace.`,
        confirmLabel: "Détruire",
        variant: "danger",
      });
      if (!ok) return;
    }
    const result = await dispatch(runAction({ workspaceId, engine, action }));
    if (runAction.fulfilled.match(result)) {
      dispatch(fetchRunDetail({ workspaceId, runId: result.payload.id }));
    }
  }

  function handleSave() {
    if (!openFilePath) return;
    dispatch(saveFile({ workspaceId, path: openFilePath, content: openFileContent }));
  }

  async function handleDeleteWorkspace() {
    const ok = await confirm({
      title: "Supprimer le workspace",
      description: `Confirmer la suppression de "${node.label}" ? Les fichiers et l'historique des runs seront perdus.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteWorkspace(workspaceId));
    if (deleteWorkspace.fulfilled.match(result)) {
      // Le nœud n'existe plus : referme le panneau et rafraîchit immédiatement le graphe plutôt que
      // d'attendre le prochain poll de 15s (TopologyGraph.tsx) — même réflexe que
      // handleRemoveVolume/handleRemoveNetwork plus bas dans ce fichier.
      dispatch(fetchTopology());
      onClose();
    }
  }

  return (
    <>
      <div className="chip-row topology-detail-panel__chips">
        <StatusPill status={node.status} label={IAC_RUN_STATUS_LABEL[node.iacLastRunStatus ?? "neutral"]} />
        <span className="status-pill status-pill--neutral">{IAC_ENGINE_LABEL[engine]}</span>
      </div>

      {engineStatus && !engineStatus.available && (
        <div className="error-banner">
          Binaire {IAC_ENGINE_LABEL[engine]} introuvable dans le conteneur API — les actions ci-dessous échoueront tant qu'il n'est
          pas installé (voir deploy/docker/Dockerfile.api.dev).
        </div>
      )}

      {operate && (
        <div className="iac-actions">
          {IAC_ENGINE_ACTIONS[engine].map((action) => (
            <button key={action} type="button" className="btn btn-secondary btn-sm" onClick={() => void handleRun(action)}>
              {action}
            </button>
          ))}
        </div>
      )}

      <div className="inspector-section-title">Fichiers</div>
      {files.length === 0 && <div className="empty-state">Aucun fichier.</div>}
      {files.length > 0 && (
        <div className="iac-file-list">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`iac-file-item${f.path === openFilePath ? " is-selected" : ""}`}
              onClick={() => dispatch(openFile({ workspaceId, path: f.path }))}
            >
              {f.path}
            </button>
          ))}
        </div>
      )}
      {openFilePath && (
        <>
          <textarea
            className="iac-editor"
            value={openFileContent}
            onChange={(e) => dispatch(setOpenFileContent(e.target.value))}
            spellCheck={false}
            disabled={!operate}
          />
          {operate && (
            <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
              Enregistrer {openFilePath}
            </button>
          )}
        </>
      )}

      <div className="inspector-section-title">Runs</div>
      {runs.length === 0 && <div className="empty-state">Aucun run pour l'instant.</div>}
      {runs.length > 0 && (
        <div className="iac-run-list">
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`iac-run-item iac-run-item--${r.status}${r.id === selectedRun?.id ? " is-selected" : ""}`}
              onClick={() => dispatch(fetchRunDetail({ workspaceId, runId: r.id }))}
            >
              <span>{r.action}</span>
              <span className="iac-run-item__meta">
                {r.status === "running" ? "en cours…" : r.status} · {formatDate(r.startedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
      {selectedRun && (
        <pre ref={logRef} className="iac-log">
          {selectedRun.log || "(pas de sortie)"}
        </pre>
      )}

      {operate && (
        <div className="inspector-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleDeleteWorkspace()}>
            Supprimer le workspace
          </button>
        </div>
      )}
    </>
  );
}

const CRON_RUN_STATUS_LABEL: Record<CronJobRun["status"], string> = {
  running: "En cours…",
  success: "Réussi",
  failed: "Échoué",
};
const CRON_RUN_TRIGGER_LABEL: Record<CronJobRun["trigger"], string> = {
  scheduled: "Planifié",
  manual: "Manuel",
};

/**
 * Contenu complet du nœud "cron-job" pour CE job précis (voir services/cronJobsStore.ts/
 * cronJobsScheduler.ts) — repris de l'ancienne CronJobsPage.tsx (retirée, voir mission point 5) :
 * conteneur cible/commande/planification, historique d'exécution complet avec sortie du run
 * sélectionné, déclenchement manuel ("Exécuter maintenant"), activer/désactiver, suppression.
 * Sous-composant dédié (même raison que IacWorkspacePanel ci-dessus) : lui seul pilote
 * `state.cronJobs` (cronJobsSlice.ts), garde le reste du panneau simple.
 *
 * CRUD (activer/désactiver, supprimer) réservé `admin` — même garde que l'ancienne page et
 * routes/cronJobs.ts (un cron job exécute une commande shell arbitraire sans confirmation, de
 * façon récurrente et non supervisée) ; le déclenchement manuel d'un job déjà défini suit lui le
 * standard `operator`/`admin` (POST .../trigger, aucune restriction supplémentaire côté API).
 */
function CronJobDetailPanel({
  node,
  operate,
  admin,
  onClose,
}: {
  node: TopologyNode;
  operate: boolean;
  admin: boolean;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const jobId = idWithoutPrefix(node.id);
  const { items, runs, runsJobId, runsStatus, triggeringId, updatingId, deletingId, triggerError } = useAppSelector(
    (s) => s.cronJobs,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchCronJobs());
    dispatch(fetchCronJobRuns(jobId));
    setSelectedRunId(null);
  }, [dispatch, jobId]);

  // Poll l'historique tant qu'un run de CE job est encore "running" — même principe que l'ancienne
  // CronJobsPage.tsx, pour refléter tout seul un cycle planifié qui se déclenche pendant que le
  // panneau est ouvert.
  useEffect(() => {
    if (runsJobId !== jobId || !runs.some((r) => r.status === "running")) return;
    const interval = setInterval(() => dispatch(fetchCronJobRuns(jobId)), 2000);
    return () => clearInterval(interval);
  }, [dispatch, jobId, runsJobId, runs]);

  const job = items.find((j) => j.id === jobId) ?? null;
  const jobRuns = runsJobId === jobId ? runs : [];
  const selectedRun = jobRuns.find((r) => r.id === selectedRunId) ?? jobRuns[0] ?? null;

  async function handleDelete() {
    if (!job) return;
    const ok = await confirm({
      title: "Supprimer ce cron job",
      description: `Confirmer la suppression de "${job.name}" ? Son historique d'exécution restera consultable via l'API mais ne sera plus déclenché.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteCronJob(job.id));
    if (deleteCronJob.fulfilled.match(result)) onClose();
  }

  if (!job) return <div className="empty-state">Chargement du détail…</div>;

  return (
    <>
      <div className="chip-row topology-detail-panel__chips">
        <StatusPill
          status={node.status}
          label={
            node.status === "running"
              ? "Dernière exécution réussie"
              : node.status === "stopped"
                ? "Dernière exécution en échec"
                : node.status === "restarting"
                  ? "Exécution en cours"
                  : "Jamais exécuté"
          }
        />
        <span className="status-pill status-pill--neutral">{job.enabled ? "Actif" : "Désactivé"}</span>
      </div>

      <KeyValueList
        rows={[
          { key: "Conteneur cible", value: job.containerName },
          { key: "Planification", value: job.schedule },
          { key: "Créé par", value: job.createdBy },
        ]}
      />

      <div className="inspector-section-title">Commande</div>
      <pre className="iac-log" style={{ minHeight: 0, maxHeight: 110 }}>
        {job.command}
      </pre>

      {triggerError && <div className="error-banner">{triggerError}</div>}

      <div className="inspector-actions">
        {operate && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={triggeringId === job.id}
            onClick={() => dispatch(triggerCronJob(job.id))}
          >
            {triggeringId === job.id ? "Déclenchement…" : "Exécuter maintenant"}
          </button>
        )}
        {admin && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={updatingId === job.id}
            onClick={() => dispatch(updateCronJob({ id: job.id, patch: { enabled: !job.enabled } }))}
          >
            {job.enabled ? "Désactiver" : "Activer"}
          </button>
        )}
        {admin && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--color-critical)" }}
            disabled={deletingId === job.id}
            onClick={() => void handleDelete()}
          >
            {deletingId === job.id ? "…" : "Supprimer"}
          </button>
        )}
      </div>

      <div className="inspector-section-title">Historique d'exécution</div>
      {runsStatus === "loading" && jobRuns.length === 0 && <div className="empty-state">Chargement…</div>}
      {runsStatus !== "loading" && jobRuns.length === 0 && <div className="empty-state">Aucune exécution pour l'instant.</div>}
      {jobRuns.length > 0 && (
        <>
          <div className="iac-run-list">
            {jobRuns.slice(0, 15).map((run) => (
              <button
                key={run.id}
                type="button"
                className={`iac-run-item iac-run-item--${run.status}${run.id === selectedRun?.id ? " is-selected" : ""}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span>
                  {CRON_RUN_STATUS_LABEL[run.status]} · {CRON_RUN_TRIGGER_LABEL[run.trigger]}
                </span>
                <span className="iac-run-item__meta">
                  {formatDate(run.startedAt)}
                  {run.exitCode !== null && ` · code ${run.exitCode}`}
                </span>
              </button>
            ))}
          </div>
          <pre className="iac-log">{selectedRun?.output || "(pas de sortie)"}</pre>
        </>
      )}
    </>
  );
}

/**
 * Contenu complet du nœud "backup" pour CETTE définition précise (voir services/backupsStore.ts/
 * backupScheduler.ts) — repris de l'ancienne BackupsPage.tsx (retirée) : cible/planification/
 * rétention/destination S3, historique d'exécution avec restauration RÉELLE et destructive
 * (confirmation `useConfirm` variant danger), déclenchement manuel ("Sauvegarder maintenant"),
 * suppression. Sous-composant dédié, même raison que CronJobDetailPanel ci-dessus.
 *
 * Toutes les mutations (déclenchement/restauration/suppression) suivent le standard
 * `operator`/`admin` du hook global (routes/backups.ts) — pas admin uniquement contrairement aux
 * cron jobs (une sauvegarde n'est pas un point d'accès administratif à un système entier).
 */
function BackupDetailPanel({ node, operate, onClose }: { node: TopologyNode; operate: boolean; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const definitionId = idWithoutPrefix(node.id);
  const { items, runsByDefinitionId, runsStatusByDefinitionId, runningId, restoringRunId, deletingId, restoreResultByDefinitionId } =
    useAppSelector((s) => s.backups);

  useEffect(() => {
    dispatch(fetchBackupDefinitions());
    dispatch(fetchBackupRuns(definitionId));
  }, [dispatch, definitionId]);

  const runs = runsByDefinitionId[definitionId] ?? [];

  // Poll tant qu'un run de CETTE définition est encore "running" — même principe que l'ancienne
  // BackupsPage.tsx (un tar de volume/dump de base peut prendre plusieurs minutes).
  useEffect(() => {
    if (!runs.some((r) => r.status === "running")) return;
    const interval = setInterval(() => dispatch(fetchBackupRuns(definitionId)), 3000);
    return () => clearInterval(interval);
  }, [dispatch, definitionId, runs]);

  const def = items.find((d) => d.id === definitionId) ?? null;
  const runsStatus = runsStatusByDefinitionId[definitionId];
  const restoreResult = restoreResultByDefinitionId[definitionId];

  async function handleDelete() {
    if (!def) return;
    const ok = await confirm({
      title: "Supprimer cette définition de sauvegarde",
      description: `Confirmer la suppression de "${def.name}" ? La planification est arrêtée immédiatement. L'historique déjà enregistré reste consultable pour audit mais ne sera plus rattaché à aucune définition active.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteBackupDefinition(def.id));
    if (deleteBackupDefinition.fulfilled.match(result)) onClose();
  }

  async function handleRestore(run: BackupRun) {
    if (!def) return;
    const ok = await confirm({
      title: "Restaurer cette sauvegarde ?",
      description: `Cette action va écraser ${def.target.kind === "volume" ? "le volume" : "la base de données"} "${def.target.ref}" avec le contenu de la sauvegarde du ${formatDate(run.startedAt)}. Les données actuellement présentes sur la cible seront définitivement perdues. Cette action est irréversible.`,
      confirmLabel: "Restaurer et écraser",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(restoreBackup({ definitionId: def.id, runId: run.id }));
  }

  if (!def) return <div className="empty-state">Chargement du détail…</div>;

  return (
    <>
      <div className="chip-row topology-detail-panel__chips">
        <StatusPill
          status={node.status}
          label={
            node.status === "running"
              ? "Dernière sauvegarde réussie"
              : node.status === "stopped"
                ? "Dernière sauvegarde en échec"
                : node.status === "restarting"
                  ? "Sauvegarde en cours"
                  : "Jamais exécutée"
          }
        />
        <span className="status-pill status-pill--neutral">
          {def.enabled ? "Planification active" : "Planification désactivée"}
        </span>
      </div>

      <KeyValueList
        rows={[
          {
            key: "Cible",
            value: `${def.target.kind === "volume" ? "Volume Docker" : "Base de données (conteneur)"} · ${def.target.ref}`,
          },
          { key: "Planification", value: def.schedule },
          { key: "Rétention", value: `${def.retentionCount} copie(s)` },
          { key: "Destination S3", value: `${def.destination.endpoint} · ${def.destination.bucket}` },
        ]}
      />

      {restoreResult && <div className={restoreResult.ok ? "success-banner" : "error-banner"}>{restoreResult.message}</div>}

      <div className="inspector-actions">
        {operate && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={runningId === def.id || runs[0]?.status === "running"}
            onClick={() => dispatch(runBackupNow(def.id))}
          >
            {runningId === def.id ? "Déclenchement…" : "Sauvegarder maintenant"}
          </button>
        )}
        {operate && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--color-critical)" }}
            disabled={deletingId === def.id}
            onClick={() => void handleDelete()}
          >
            {deletingId === def.id ? "…" : "Supprimer"}
          </button>
        )}
      </div>

      <div className="inspector-section-title">Historique des exécutions</div>
      {runsStatus === "loading" && runs.length === 0 && <div className="empty-state">Chargement…</div>}
      {runsStatus !== "loading" && runs.length === 0 && <div className="empty-state">Aucune exécution pour l'instant.</div>}
      {runs.length > 0 && (
        <div className="iac-run-list">
          {runs.slice(0, 15).map((run) => {
            const restorable = run.status === "success" && !!run.objectKey && !run.rotated;
            return (
              <div key={run.id} className={`iac-run-item iac-run-item--${run.status}`} style={{ cursor: "default" }}>
                <span>
                  {run.status === "running" ? "En cours…" : run.status === "success" ? (run.rotated ? "Réussie (rotée)" : "Réussie") : "Échec"}
                  {" · "}
                  {run.trigger === "manual" ? "Manuel" : "Planifié"}
                </span>
                <span className="iac-run-item__meta">{formatDate(run.startedAt)}</span>
                {restorable && operate && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    style={{ marginTop: 6 }}
                    disabled={restoringRunId === run.id}
                    onClick={() => void handleRestore(run)}
                  >
                    {restoringRunId === run.id ? "Restauration…" : "Restaurer"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** "abcd1234" -> libellé du nœud d'automatisation correspondant, pour afficher le chemin RÉEL
 * (AutomationRunLogEntry#path, voir @/types) d'une exécution en libellés lisibles plutôt qu'en ids
 * bruts — construit depuis `topology.nodes` déjà chargé (aucun appel réseau supplémentaire). Un id
 * de path sans correspondance (nœud supprimé depuis) retombe sur l'id brut lui-même côté appelant,
 * jamais un libellé inventé. */
function automationLabelById(topology: Topology | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!topology) return map;
  for (const n of topology.nodes) {
    if (n.kind === "automation-trigger" || n.kind === "automation-condition" || n.kind === "automation-action") {
      map.set(idWithoutPrefix(n.id), n.label);
    }
  }
  return map;
}

/** Historique d'exécution partagé trigger/action (voir AutomationTriggerPanel/AutomationActionPanel
 * ci-dessous) — même rendu que .iac-run-list ailleurs dans ce fichier, `ok`/`échec` au lieu d'un
 * statut à 3 valeurs (une exécution d'automatisation n'a pas d'état "en cours", voir
 * AutomationRunLogEntry#ok, @/types). `[]` -> "Aucune exécution enregistrée.", jamais un historique
 * inventé (voir mission). */
function AutomationRunHistory({
  runs,
  loading,
  labelById,
}: {
  runs: AutomationRunLogEntry[];
  loading: boolean;
  labelById: Map<string, string>;
}) {
  return (
    <>
      <div className="inspector-section-title">Dernières exécutions</div>
      {loading && runs.length === 0 && <div className="empty-state">Chargement…</div>}
      {!loading && runs.length === 0 && <div className="empty-state">Aucune exécution enregistrée.</div>}
      {runs.length > 0 && (
        <div className="iac-run-list">
          {runs.slice(0, 15).map((run) => (
            <div key={run.id} className={`iac-run-item iac-run-item--${run.ok ? "success" : "failed"}`} style={{ cursor: "default" }}>
              <span>
                {run.ok ? "Réussie" : "Échec"} · {run.path.map((id) => labelById.get(id) ?? id).join(" → ")}
              </span>
              <span className="iac-run-item__meta">
                {formatDate(run.at)}
                {run.message ? ` · ${run.message}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Contenu complet du nœud "automation-trigger" pour CE déclencheur précis (voir
 * services/automationStore.ts/services/automationEngine.ts) — source surveillée déjà lisible dans
 * `node.subtitle` (RÉUTILISÉE telle quelle, jamais recalculée ici), dernier état RÉEL observé par
 * le moteur (`automationLastStatus`/`automationLastFired`, déjà posés sur TopologyNode par
 * services/topology.ts#getAutomationNodes — aucun appel réseau supplémentaire nécessaire pour ça),
 * historique RÉEL des dernières chaînes déclenchées PAR CE trigger précis (GET /api/automation/runs,
 * filtré par `triggerNodeId`). Sous-composant dédié, même raison que CronJobDetailPanel/
 * BackupDetailPanel ci-dessus : lui seul pilote `state.automation` (automationSlice.ts).
 */
function AutomationTriggerPanel({
  node,
  topology,
  operate,
  onClose,
}: {
  node: TopologyNode;
  topology: Topology | null;
  operate: boolean;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const rawId = idWithoutPrefix(node.id);
  const { runs, runsStatus, deletingNodeId } = useAppSelector((s) => s.automation);

  useEffect(() => {
    dispatch(fetchAutomationRuns());
  }, [dispatch]);

  const ownRuns = runs.filter((r) => r.triggerNodeId === rawId);
  const labelById = useMemo(() => automationLabelById(topology), [topology]);

  async function handleDelete() {
    const ok = await confirm({
      title: "Supprimer ce déclencheur",
      description: `Confirmer la suppression de "${node.label}" ? Les connexions qui le touchent seront supprimées avec lui.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteAutomationNode(rawId));
    if (deleteAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    }
  }

  return (
    <>
      <div className="chip-row topology-detail-panel__chips">
        <StatusPill
          status={
            node.automationLastStatus === "ok" ? "running" : node.automationLastStatus === "failing" ? "stopped" : "unconfigured"
          }
          label={
            node.automationLastStatus === "ok"
              ? "Dernier état : sain"
              : node.automationLastStatus === "failing"
                ? "Dernier état : en échec"
                : "Jamais évalué"
          }
        />
      </div>
      <KeyValueList
        rows={[
          { key: "Source surveillée", value: node.subtitle },
          { key: "Dernier déclenchement", value: node.automationLastFired ? formatDate(node.automationLastFired) : "Jamais déclenché" },
        ]}
      />
      <AutomationRunHistory runs={ownRuns} loading={runsStatus === "loading"} labelById={labelById} />
      {operate && (
        <div className="inspector-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--color-critical)" }}
            disabled={deletingNodeId === rawId}
            onClick={() => void handleDelete()}
          >
            {deletingNodeId === rawId ? "…" : "Supprimer"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Contenu complet du nœud "automation-condition" pour CETTE condition précise — condition minimale
 * v1 (voir @/types#AutomationConditionInvert doc), en LECTURE SEULE : routes/automation.ts n'expose
 * QUE POST/DELETE pour un nœud d'automatisation, aucune route PATCH n'existe pour modifier
 * `conditionInvert` après coup (vérifié avant d'écrire ce panneau — hors de la mission frontend de
 * l'inventer côté API) — reflète honnêtement cette limitation v1 plutôt que d'appeler un endpoint
 * qui n'existe pas.
 */
function AutomationConditionPanel({
  node,
  operate,
  onClose,
}: {
  node: TopologyNode;
  operate: boolean;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const rawId = idWithoutPrefix(node.id);
  const deletingNodeId = useAppSelector((s) => s.automation.deletingNodeId);

  async function handleDelete() {
    const ok = await confirm({
      title: "Supprimer cette condition",
      description: `Confirmer la suppression de "${node.label}" ? Les connexions qui la touchent seront supprimées avec elle.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteAutomationNode(rawId));
    if (deleteAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    }
  }

  return (
    <>
      <div className="chip-row topology-detail-panel__chips">
        <span className="status-pill status-pill--neutral">
          {node.automationConditionInvert ? "Condition inversée" : "Condition normale"}
        </span>
      </div>
      <KeyValueList
        rows={[
          { key: "Comportement", value: node.subtitle },
          { key: "Inversée", value: node.automationConditionInvert ? "Oui" : "Non" },
        ]}
      />
      <div className="empty-state">
        Réglage en lecture seule — aucune route de modification n'existe pour l'instant côté API. Pour changer ce
        réglage, supprime et recrée ce nœud.
      </div>
      {operate && (
        <div className="inspector-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--color-critical)" }}
            disabled={deletingNodeId === rawId}
            onClick={() => void handleDelete()}
          >
            {deletingNodeId === rawId ? "…" : "Supprimer"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Contenu complet du nœud "automation-action" pour CETTE action précise — type d'action + cible
 * déjà lisibles dans `node.subtitle` (RÉUTILISÉ tel quel, jamais recalculé ici), même historique
 * d'exécution que AutomationTriggerPanel ci-dessus mais filtré par PRÉSENCE de cet id dans le
 * chemin parcouru (`path`, voir mission — plus simple et tout aussi correct que de retrouver le
 * trigger parent). Sous-composant dédié, même raison que les autres panneaux ci-dessus.
 */
function AutomationActionPanel({
  node,
  topology,
  operate,
  onClose,
}: {
  node: TopologyNode;
  topology: Topology | null;
  operate: boolean;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const rawId = idWithoutPrefix(node.id);
  const { runs, runsStatus, deletingNodeId } = useAppSelector((s) => s.automation);

  useEffect(() => {
    dispatch(fetchAutomationRuns());
  }, [dispatch]);

  const ownRuns = runs.filter((r) => r.path.includes(rawId));
  const labelById = useMemo(() => automationLabelById(topology), [topology]);

  async function handleDelete() {
    const ok = await confirm({
      title: "Supprimer cette action",
      description: `Confirmer la suppression de "${node.label}" ? Les connexions qui la touchent seront supprimées avec elle.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteAutomationNode(rawId));
    if (deleteAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    }
  }

  return (
    <>
      <KeyValueList rows={[{ key: "Action", value: node.subtitle }]} />
      <AutomationRunHistory runs={ownRuns} loading={runsStatus === "loading"} labelById={labelById} />
      {operate && (
        <div className="inspector-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--color-critical)" }}
            disabled={deletingNodeId === rawId}
            onClick={() => void handleDelete()}
          >
            {deletingNodeId === rawId ? "…" : "Supprimer"}
          </button>
        </div>
      )}
    </>
  );
}

interface NetworkAttachmentRow {
  id: string; // "network:<id>"
  label: string;
  subtitle: string; // driver
  shared: boolean; // true = vrai nœud du graphe (partagé ou par défaut), false = brique mono-conteneur
}

/**
 * Panneau de détail complet — ANCRÉ en overlay fixe sur le bord droit du canevas (même pattern
 * d'ancrage que TopologySubGraphPanel.tsx : `position: absolute` à l'intérieur de `.topology-graph`,
 * devenu `position: relative`), à onglets réels, largeur fixe raisonnable, pleine hauteur du
 * canevas, jamais de débordement horizontal — remplace l'ancienne TopologyNodeDetailModal.tsx
 * (modal centrée en grille qui débordait encore horizontalement sur écran étroit). Ouvert depuis
 * "Voir le détail" (menu contextuel d'un nœud OU d'une brique volume/network, voir
 * TopologyGraph.tsx/topologyGraphShared.tsx#GraphNode) ou par navigation interne (`onNavigate`).
 *
 * Rien n'est inventé : `GET /api/containers/:id` pour un conteneur, la vraie liste de
 * vulnérabilités du dernier scan réussi de son image (`GET /api/images/:id/scans`), et les objets
 * complets `DockerVolume`/`DockerNetwork` déjà exposés par `GET /api/volumes`/`GET /api/networks`
 * pour les deux autres kinds Docker — y compris pour une ressource "briquée" (plus un nœud
 * top-level du graphe, mais toujours une vraie ressource Docker avec son propre détail complet).
 */
export default function TopologyNodeDetailPanel({ node, topology, onClose, onNavigate, initialTab }: TopologyNodeDetailPanelProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  // Cron jobs uniquement (voir CronJobDetailPanel plus bas) : CRUD réservé admin, même garde que
  // l'ancienne CronJobsPage.tsx et routes/cronJobs.ts.
  const admin = canAdminister(session);
  const { detail, detailStatus } = useAppSelector((s) => s.containers);
  const images = useAppSelector((s) => s.images.items);
  const scansByImageId = useAppSelector((s) => s.images.scansByImageId);
  const scanStatus = useAppSelector((s) => s.images.scanStatus);
  const scanError = useAppSelector((s) => s.images.scanError);
  const volumes = useAppSelector((s) => s.volumes.items);
  const mutatingVolumeName = useAppSelector((s) => s.volumes.mutatingName);
  // Volume dont l'explorateur de fichiers est ouvert (state.volumes.browser, voir
  // VolumeFilesModal.tsx) — utilisé UNIQUEMENT pour désarmer le raccourci Échap de ce panneau
  // pendant que la modale (portée séparément, document.body) est ouverte par-dessus : sans cette
  // garde, Échap fermerait le panneau ET la modale en même temps au lieu de la seule modale.
  const volumeBrowserOpen = useAppSelector((s) => s.volumes.browser.volumeName !== null);
  const networks = useAppSelector((s) => s.networks.items);
  const mutatingNetworkId = useAppSelector((s) => s.networks.mutatingId);
  // Nœud "gitops-source" (voir services/gitops.ts) — même slice Redux que l'ancienne GitOpsPage.tsx
  // (gitopsSlice.ts, conservée telle quelle, désormais consommée uniquement par ce panneau).
  const gitopsFiles = useAppSelector((s) => s.gitops.files);
  const gitopsFilesStatus = useAppSelector((s) => s.gitops.filesStatus);
  const gitopsCommits = useAppSelector((s) => s.gitops.commits);
  const gitopsCommitsStatus = useAppSelector((s) => s.gitops.commitsStatus);
  const gitopsSelectedPath = useAppSelector((s) => s.gitops.selectedPath);
  const gitopsActiveTab = useAppSelector((s) => s.gitops.activeTab);
  const gitopsDiff = useAppSelector((s) => s.gitops.diff);
  const gitopsDiffStatus = useAppSelector((s) => s.gitops.diffStatus);
  const gitopsSyncing = useAppSelector((s) => s.gitops.syncing);
  const gitopsError = useAppSelector((s) => s.gitops.error);
  const gitopsLastCheckedAt = useAppSelector((s) => s.gitops.lastCheckedAt);
  // Historique complet des déploiements GitHub (state.github.deployments) — voir la section
  // "Déployé depuis GitHub" de l'onglet Aperçu d'un conteneur, plus bas dans ce fichier.
  const githubDeployments = useAppSelector((s) => s.github.deployments);

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  // Console interactive (docker exec) / logs — mêmes composants EXACTS que ContainersPage.tsx
  // (ContainerConsole.tsx/ContainerLogs.tsx, déjà réels/fonctionnels : WebSocket GET /api/console/:id
  // et /api/containers/:id/logs/stream), montés une seule fois ci-dessous et pilotés par ces deux
  // states — comblent un manque signalé plusieurs fois : ces actions n'étaient accessibles que
  // depuis l'ancienne page Conteneurs, jamais depuis le panneau de détail du graphe.
  const [consoleTarget, setConsoleTarget] = useState<{ id: string; name: string } | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);
  const [metricsPoints, setMetricsPoints] = useState<ContainerMetricPoint[]>([]);
  const [metricsStatus, setMetricsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  // Section "Déployé depuis GitHub" (onglet Aperçu, conteneur) — log complet chargé à la demande
  // via un simple apiGet local (même pattern que l'onglet "Métriques" ci-dessus), volontairement
  // PAS via state.github.selectedDeployment (voir la note d'import plus haut).
  const [githubLogsOpen, setGithubLogsOpen] = useState(false);
  const [githubLogsStatus, setGithubLogsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [githubLog, setGithubLog] = useState("");
  const [githubRedeploying, setGithubRedeploying] = useState(false);

  const kind = node?.kind;
  const rawId = node ? idWithoutPrefix(node.id) : "";

  // Nouveau nœud affiché (y compris via navigation interne) -> repart sur `initialTab` si fourni par
  // l'appelant (ex: carte flottante "CPU élevé" du graphe -> "metrics"), sinon sur l'onglet Aperçu
  // comme avant — jamais bloqué sur un onglet qui n'existe pas pour le nouveau kind (ex:
  // "Vulnérabilités" en arrivant sur un volume, `initialTab` n'est de toute façon jamais passé pour
  // un kind non-conteneur).
  useEffect(() => {
    setActiveTab(initialTab ?? "overview");
    // Idem pour les métriques : jamais afficher un vieux point d'un précédent conteneur pendant
    // le chargement du nouveau (voir l'effet de fetch ci-dessous, gardé par `activeTab === "metrics"`).
    setMetricsPoints([]);
    setMetricsStatus("idle");
    // Idem pour le log GitHub de la section "Déployé depuis GitHub" — jamais montrer le log d'un
    // précédent conteneur pendant que le nouveau déploiement correspondant (s'il y en a un) se
    // recalcule.
    setGithubLogsOpen(false);
    setGithubLogsStatus("idle");
    setGithubLog("");
  }, [node?.id, initialTab]);

  // Récupère le détail complet selon le kind à l'ouverture (ou changement de nœud) — les résumés
  // déjà présents sur `node` (TopologyNode) ne suffisent pas pour cette vue.
  useEffect(() => {
    if (!node) return;
    if (node.kind === "container") {
      dispatch(fetchContainerDetail(rawId));
      dispatch(fetchImages());
      // "Déployé depuis GitHub" (mission point B) : liste TOUJOURS tout l'historique, indépendant
      // du repo — le rapprochement avec CE conteneur se fait ensuite côté client sur containerId
      // (voir githubDeployment plus bas).
      dispatch(fetchGithubDeployments());
    } else if (node.kind === "volume") {
      dispatch(fetchVolumes());
    } else if (node.kind === "network") {
      dispatch(fetchNetworks());
    }
    // nutanix-vm/ad-server/host : rien à charger, TopologyNode porte déjà tout le détail disponible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, node?.id, node?.kind]);

  // Escape referme le panneau — pas de piège de focus/backdrop façon <Modal> : ce n'est pas une
  // boîte de dialogue modale bloquante, mais un panneau ancré façon Railway/VSCode, le reste du
  // canevas reste utilisable pendant qu'il est ouvert.
  useEffect(() => {
    if (!node || volumeBrowserOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [node, onClose, volumeBrowserOpen]);

  // Nœud "gitops-source" : charge fichiers + historique de commits à l'ouverture, PUIS revérifie
  // périodiquement la dérive (repris tel quel de l'ancienne GitOpsPage.tsx, voir
  // GITOPS_REFRESH_INTERVAL_MS) — lecture seule (GET /api/gitops/files), coupée quand l'onglet est
  // en arrière-plan (même garde qu'OverviewPage.tsx), jamais de resynchronisation automatique.
  useEffect(() => {
    if (!node || node.kind !== "gitops-source") return;
    dispatch(fetchGitopsFiles());
    dispatch(fetchGitopsCommits());
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchGitopsFiles());
    }, GITOPS_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch, node?.id, node?.kind]);

  // Sélectionne le premier fichier manifeste par défaut dès que la liste est chargée — même
  // comportement que l'ancienne GitOpsPage.tsx.
  useEffect(() => {
    if (node?.kind === "gitops-source" && gitopsFiles.length > 0 && !gitopsSelectedPath) {
      const first = gitopsFiles[0];
      if (first) dispatch(selectGitopsFile(first.path));
    }
  }, [dispatch, node?.kind, gitopsFiles, gitopsSelectedPath]);

  // Diff du fichier manifeste sélectionné — chargé à la demande (onglet "Diff" de la sous-section
  // gitops-source), même principe que l'ancienne GitOpsPage.tsx.
  useEffect(() => {
    if (node?.kind === "gitops-source" && gitopsSelectedPath && gitopsActiveTab === "diff") {
      dispatch(fetchGitopsDiff(gitopsSelectedPath));
    }
  }, [dispatch, node?.kind, gitopsSelectedPath, gitopsActiveTab]);

  // Nœuds "cron-job"/"backup" : voir CronJobDetailPanel/BackupDetailPanel plus bas (sous-composants
  // dédiés, même pattern que IacWorkspacePanel ci-dessus — chacun pilote son propre slice Redux
  // (cronJobsSlice.ts/backupsSlice.ts, auparavant consommés par CronJobsPage.tsx/BackupsPage.tsx,
  // retirées) sans rien lire en dehors de son sous-arbre).

  // Image suivie (ImageRef) correspondant à "name:tag" du conteneur — même rapprochement par nom
  // que services/topology.ts#vulnSummaryForImage côté serveur (node.subtitle = c.Image = "name:tag").
  const imageRef = kind === "container" ? images.find((i) => `${i.name}:${i.currentTag}` === node!.subtitle) ?? null : null;

  useEffect(() => {
    if (imageRef) dispatch(fetchScans(imageRef.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, imageRef?.id]);

  // Déploiement GitHub réel dont `containerId` correspond à CE conteneur, s'il y en a un — jamais
  // affiché pour un conteneur créé autrement (voir la garde `githubDeployment &&` dans le JSX de
  // l'onglet Aperçu). `githubDeployments` est déjà trié du plus récent au plus ancien côté serveur
  // (services/githubDeployments.ts#listDeployments) : le premier match est donc le bon, sans tri
  // supplémentaire côté client.
  const githubDeployment: GithubDeployment | null =
    kind === "container" ? githubDeployments.find((d) => d.containerId === rawId) ?? null : null;

  // Onglet "Métriques" : chargé à la demande (pas à l'ouverture du panneau, contrairement au
  // détail/aux scans) — GET /api/containers/:id/metrics peut porter jusqu'à 7 jours d'historique
  // (config.metrics.retentionMs côté API), inutile de le récupérer si l'utilisateur ne consulte
  // jamais cet onglet. Rafraîchi périodiquement tant que l'onglet reste affiché (voir
  // METRICS_POLL_MS) pour suivre les nouveaux points écrits par metricsCollector.ts.
  useEffect(() => {
    if (!node || node.kind !== "container" || activeTab !== "metrics") return;
    let cancelled = false;
    async function load() {
      setMetricsStatus((s) => (s === "ready" ? s : "loading"));
      try {
        const points = await apiGet<ContainerMetricPoint[]>(`/containers/${rawId}/metrics`);
        if (!cancelled) {
          setMetricsPoints(points);
          setMetricsStatus("ready");
        }
      } catch {
        if (!cancelled) setMetricsStatus("error");
      }
    }
    void load();
    const interval = setInterval(() => void load(), METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [node, activeTab, rawId]);

  const scans = imageRef ? scansByImageId[imageRef.id] ?? [] : [];
  // "Dernier scan réussi" au sens strict — pas juste le plus récent des scans (qui peut être un
  // scan en cours ou échoué alors qu'un scan plus ancien, réussi, a de vraies données à montrer).
  const latestSuccess = scans.find((s) => s.status === "success") ?? null;
  const latestOverall = scans[0] ?? null;

  // Poll pendant qu'un scan tourne — même principe que ImagesPage.tsx, pour que le panneau se
  // mette à jour tout seul si l'utilisateur vient de lancer un scan depuis ici.
  useEffect(() => {
    if (!imageRef || !latestOverall || latestOverall.status !== "running") return;
    const interval = setInterval(() => {
      dispatch(fetchScanDetail({ imageId: imageRef.id, scanId: latestOverall.id }));
    }, 2000);
    return () => clearInterval(interval);
  }, [dispatch, imageRef, latestOverall]);

  // Reconstruction de la liste RÉELLE des networks connectés à ce conteneur : les networks restés
  // "vrais nœuds" (partagés/par défaut) via les arêtes de `topology`, PLUS les networks "briqués"
  // (mono-conteneur) via node.attachments — voir la doc du prop `topology` ci-dessus, les deux
  // ensembles sont complémentaires et exhaustifs, jamais de recoupement.
  const networkAttachments = useMemo<NetworkAttachmentRow[]>(() => {
    if (!node || node.kind !== "container") return [];
    const rows: NetworkAttachmentRow[] = [];
    if (topology) {
      const nodesById = new Map(topology.nodes.map((n) => [n.id, n]));
      for (const edge of topology.edges) {
        if (edge.kind !== "network") continue;
        const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
        if (!otherId) continue;
        const other = nodesById.get(otherId);
        if (other) rows.push({ id: other.id, label: other.label, subtitle: other.subtitle, shared: true });
      }
    }
    for (const attachment of node.attachments ?? []) {
      if (attachment.kind !== "network") continue;
      rows.push({ id: attachment.id, label: attachment.label, subtitle: attachment.subtitle, shared: false });
    }
    return rows;
  }, [node, topology]);

  if (!node) return null;

  const Icon = KIND_ICON[node.kind];
  const isContainerDetailReady = kind === "container" && detailStatus === "ready" && detail?.id === rawId;
  const volume = kind === "volume" ? volumes.find((v) => v.name === rawId) ?? null : null;
  const network = kind === "network" ? networks.find((n) => n.id === rawId) ?? null : null;
  const tabs = tabsForKind(node.kind);

  // Plafonds de référence RÉELS pour l'onglet "Métriques" (façon Railway "Max 8 vCPU"/"Max 8 GB")
  // — uniquement si une limite a effectivement été configurée à la création du conteneur
  // (HostConfig.Memory/NanoCpus, voir ContainerDetail), jamais une valeur inventée. cpuPercent est
  // normalisé par `onlineCpus * 100` côté API (docker.ts#readContainerUsage) : un NanoCpus de
  // 500 000 000 (0,5 cœur) plafonne donc à 50, pas à 100.
  const maxCpuPercent =
    isContainerDetailReady && detail?.nanoCpus ? (detail.nanoCpus / 1_000_000_000) * 100 : undefined;
  const maxMemBytes = isContainerDetailReady ? detail?.memoryLimitBytes : undefined;

  function handleLaunchScan() {
    if (imageRef) dispatch(scanImage({ id: imageRef.id }));
  }

  /** Charge (à la demande, une seule fois) puis bascule l'affichage du log complet du déploiement
   * GitHub trouvé pour ce conteneur — GET /api/github/deployments/:id, même route que
   * GitHubDeployPage.tsx, appelée ici en direct (apiGet) plutôt que via le thunk du slice pour ne
   * jamais toucher state.github.selectedDeployment (voir la note d'import en tête de fichier). */
  async function handleToggleGithubLogs(deploymentId: string) {
    setGithubLogsOpen((open) => !open);
    if (githubLogsStatus !== "idle") return;
    setGithubLogsStatus("loading");
    try {
      const detail = await apiGet<GithubDeploymentDetail>(`/github/deployments/${deploymentId}`);
      setGithubLog(detail.log || "(pas de sortie)");
      setGithubLogsStatus("ready");
    } catch {
      setGithubLogsStatus("error");
    }
  }

  /** Redéploie EXACTEMENT le même repo/ref/environnement/sous-domaine que le déploiement GitHub
   * trouvé pour ce conteneur, via le thunk deployGithubRepo déjà utilisé par GitHubDeployPage.tsx
   * (même route POST /api/github/repos/:owner/:repo/deploy) — confirmation explicite avant action
   * (même pattern que handleRemoveVolume/handleRemoveNetwork ci-dessous). Le port n'est
   * volontairement PAS repassé : GithubDeployment (historique) ne le conserve pas (seul le port
   * effectivement EXPOSE détecté au moment du déploiement original comptait), le POST /deploy
   * réappliquera la même auto-détection que pour un premier déploiement plutôt qu'une valeur
   * inventée ici. */
  async function handleRedeployFromGithub(d: GithubDeployment) {
    const ok = await confirm({
      title: "Redéployer depuis GitHub",
      description: `Confirmer un nouveau déploiement de "${d.owner}/${d.repo}@${d.ref}" avec exactement les mêmes paramètres (même environnement cible${d.subdomain ? `, sous-domaine "${d.subdomain}"` : ""}) ?`,
      confirmLabel: "Redéployer",
    });
    if (!ok) return;
    setGithubRedeploying(true);
    await dispatch(
      deployGithubRepo({
        owner: d.owner,
        repo: d.repo,
        ref: d.ref,
        ...(d.targetEnvironmentId ? { targetEnvironmentId: d.targetEnvironmentId } : {}),
        ...(d.subdomain ? { subdomain: d.subdomain } : {}),
      }),
    );
    setGithubRedeploying(false);
    dispatch(fetchGithubDeployments());
  }

  function openNetworkAttachment(row: NetworkAttachmentRow) {
    onNavigate({ id: row.id, kind: "network", label: row.label, subtitle: row.subtitle, status: "running" });
  }

  /** Suppression réelle (DELETE /api/volumes/:name) — même confirmation/libellé que l'ancienne
   * VolumesPage.tsx#handleRemove (retirée) : la description prévient explicitement si le volume
   * est monté (la suppression échouera côté Docker tant qu'il l'est). Referme le panneau après
   * succès : le nœud affiché n'existe plus, plus rien de pertinent à montrer ici. */
  async function handleRemoveVolume(name: string, inUseBy: number) {
    const ok = await confirm({
      title: "Supprimer le volume",
      description:
        inUseBy > 0
          ? `"${name}" est monté par ${inUseBy} conteneur(s) — la suppression échouera tant qu'il est utilisé.`
          : `Confirmer la suppression du volume "${name}" ? Les données qu'il contient seront perdues.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeVolume({ name }));
    if (removeVolume.fulfilled.match(result)) onClose();
  }

  /** Suppression réelle (DELETE /api/networks/:id) — même confirmation/libellé que l'ancienne
   * NetworksPage.tsx#handleRemove (retirée). Jamais appelée pour un network par défaut
   * (bridge/host/none) : le bouton lui-même est masqué dans le JSX, voir DEFAULT_NETWORK_NAMES. */
  async function handleRemoveNetwork(id: string, name: string) {
    const ok = await confirm({
      title: "Supprimer le network",
      description: `Confirmer la suppression du network "${name}" ?`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeNetwork({ id, name }));
    if (removeNetwork.fulfilled.match(result)) onClose();
  }

  return (
    <div className="topology-detail-panel" role="region" aria-label={`Détail de « ${node.label} »`}>
      <div className="topology-detail-panel__header">
        <span className={`topology-detail-panel__icon topology-detail-panel__icon--${node.kind}`}>
          <Icon />
        </span>
        <div className="topology-detail-panel__heading">
          <div className="topology-detail-panel__title" title={node.label}>
            {node.label}
          </div>
          <div className="topology-detail-panel__subtitle" title={node.subtitle}>
            {node.subtitle}
          </div>
        </div>
        <button type="button" className="topology-detail-panel__close" onClick={onClose} title="Fermer" aria-label="Fermer">
          ✕
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="topology-detail-panel__tabs" role="tablist" aria-label="Sections du détail">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`topology-detail-panel__tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="topology-detail-panel__body">
        {/* --- Conteneur ---------------------------------------------------------------- */}
        {node.kind === "container" && activeTab === "overview" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
              {node.healthStatus && (
                <span className={`status-pill status-pill--${HEALTH_SEMANTIC[node.healthStatus]}`}>
                  {HEALTH_LABEL[node.healthStatus]}
                </span>
              )}
              {node.updateAvailable && <span className="status-pill status-pill--warning">Mise à jour d'image disponible</span>}
              {node.drift && <span className="status-pill status-pill--critical">Dérive GitOps détectée</span>}
            </div>

            {/* "Déployé depuis GitHub" (mission point B) — UNIQUEMENT si un vrai déploiement GitHub
                a réellement produit CE conteneur (containerId réel, voir githubDeployment plus
                haut) : jamais affiché pour un conteneur créé autrement, pas de faux vide. */}
            {githubDeployment && (
              <>
                <div className="inspector-section-title">Déployé depuis GitHub</div>
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {githubDeployment.owner}/{githubDeployment.repo}@{githubDeployment.ref}
                  </div>
                  {githubDeployment.commit ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {githubDeployment.commit.authorAvatarUrl && (
                        <img
                          src={githubDeployment.commit.authorAvatarUrl}
                          alt={githubDeployment.commit.author}
                          width={22}
                          height={22}
                          style={{ borderRadius: "50%" }}
                        />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {githubDeployment.commit.message || "(pas de message de commit)"}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {githubDeployment.commit.author} ·{" "}
                          {githubDeployment.triggeredBy === "webhook" ? "push automatique" : `par ${githubDeployment.startedBy}`}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {githubDeployment.triggeredBy === "webhook" ? "push automatique" : `démarré par ${githubDeployment.startedBy}`}
                    </div>
                  )}

                  {githubLogsOpen && (
                    <pre className="iac-log" style={{ maxHeight: 240, minHeight: 0 }}>
                      {githubLogsStatus === "loading" ? "Chargement…" : githubLogsStatus === "error" ? "Impossible de charger le log." : githubLog}
                    </pre>
                  )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleToggleGithubLogs(githubDeployment.id)}>
                      {githubLogsOpen ? "Masquer les logs" : "Voir les logs de ce déploiement"}
                    </button>
                    {operate && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleRedeployFromGithub(githubDeployment)}
                        disabled={githubRedeploying}
                      >
                        {githubRedeploying ? "Redéploiement…" : "Redéployer"}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Logs : lecture seule, ouvert à tout rôle authentifié (viewer inclus, voir
                routes/containerLogs.ts) — utile même sur un conteneur arrêté (comprendre pourquoi
                il s'est arrêté), jamais conditionné à "running". Console : vrai shell interactif,
                reste réservée operator/admin ET à un conteneur en cours d'exécution — même garde
                que ContainersPage.tsx (retirée du menu du graphe, ce panneau est désormais le seul
                point d'entrée). */}
            <div className="inspector-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLogsTarget({ id: rawId, name: node.label })}>
                <IconHistory /> Logs
              </button>
              {operate && node.status === "running" && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConsoleTarget({ id: rawId, name: node.label })}>
                  <IconTerminal /> Console
                </button>
              )}
            </div>

            {typeof node.cpuPercent === "number" && (
              <>
                <Gauge label="CPU" percent={node.cpuPercent} />
                <KeyValueList rows={[{ key: "Mémoire", value: formatMem(node.memBytes ?? 0) }]} />
              </>
            )}

            {detailStatus === "loading" && <div className="empty-state">Chargement du détail…</div>}
            {detailStatus === "error" && <div className="error-banner">Impossible de charger le détail de ce conteneur.</div>}

            {isContainerDetailReady && detail && (
              <>
                <div className="inspector-section-title">Détail</div>
                <KeyValueList
                  rows={[
                    { key: "ID complet", value: detail.fullId },
                    { key: "Créé le", value: formatDate(detail.createdAt) },
                    { key: "Commande", value: detail.command || "—" },
                    { key: "Politique de redémarrage", value: detail.restartPolicy },
                    { key: "Mode network", value: detail.networkMode },
                  ]}
                />
              </>
            )}

            {isContainerDetailReady && detail && Object.keys(detail.labels).length > 0 && (
              <>
                <div className="inspector-section-title">Labels</div>
                <KeyValueList rows={Object.entries(detail.labels).map(([key, value]) => ({ key, value }))} />
              </>
            )}
          </>
        )}

        {node.kind === "container" && activeTab === "network" && (
          <>
            {isContainerDetailReady && detail && (
              <KeyValueList rows={[{ key: "Mode network", value: detail.networkMode }]} />
            )}

            <div className="inspector-section-title">Ports</div>
            {isContainerDetailReady && detail && detail.ports.length === 0 && (
              <div className="empty-state">Aucun port exposé.</div>
            )}
            {isContainerDetailReady && detail && detail.ports.length > 0 && (
              <KeyValueList
                rows={detail.ports.map((p) => ({
                  key: `${p.containerPort}/${p.proto}`,
                  value: p.hostPort ? `→ ${p.hostPort}` : "non publié",
                }))}
              />
            )}

            <div className="inspector-section-title">Networks connectés</div>
            {networkAttachments.length === 0 && <div className="empty-state">Aucun network connecté.</div>}
            {networkAttachments.length > 0 && (
              <ul className="topology-detail-panel__attachment-list">
                {networkAttachments.map((row) => (
                  <li key={row.id}>
                    <button type="button" className="topology-detail-panel__attachment-btn" onClick={() => openNetworkAttachment(row)}>
                      <span className="topology-detail-panel__attachment-label" title={row.label}>
                        {row.label}
                      </span>
                      <span className="topology-detail-panel__attachment-meta">
                        {row.subtitle}
                        {!row.shared && " · dédié à ce conteneur"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {node.kind === "container" && activeTab === "volumes" && (
          <>
            {isContainerDetailReady && detail && detail.mounts.length === 0 && (
              <div className="empty-state">Aucun volume monté.</div>
            )}
            {isContainerDetailReady && detail && detail.mounts.length > 0 && (
              <KeyValueList
                rows={detail.mounts.map((m) => ({
                  key: m.destination,
                  value: `${m.source}${m.readOnly ? " (ro)" : ""}`,
                }))}
              />
            )}
            {!isContainerDetailReady && detailStatus === "loading" && <div className="empty-state">Chargement…</div>}
          </>
        )}

        {node.kind === "container" && activeTab === "variables" && (
          <>
            {isContainerDetailReady && detail && detail.env.length === 0 && (
              <div className="empty-state">Aucune variable d'environnement.</div>
            )}
            {isContainerDetailReady && detail && detail.env.length > 0 && (
              <>
                <p className="topology-detail-panel__hint">Les clés ressemblant à un secret sont masquées par défaut.</p>
                <div className="kv-list">
                  {detail.env.map((entry, index) => (
                    <EnvVarRow key={`${entry}-${index}`} entry={entry} />
                  ))}
                </div>
              </>
            )}
            {!isContainerDetailReady && detailStatus === "loading" && <div className="empty-state">Chargement…</div>}
          </>
        )}

        {node.kind === "container" && activeTab === "vulnerabilities" && (
          <div className="topology-detail-panel__vulns">
            <div className="inspector-section-title">
              {imageRef ? `Image ${imageRef.name}:${imageRef.currentTag}` : "Vulnérabilités"}
            </div>
            {!imageRef && <div className="empty-state">Image introuvable parmi les images suivies.</div>}
            {imageRef && scans.length === 0 && (
              <div className="empty-state">
                Aucun scan n'a jamais été effectué pour cette image.
                {operate && (
                  <div className="topology-detail-panel__scan-cta">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={scanStatus === "starting"} onClick={handleLaunchScan}>
                      {scanStatus === "starting" ? "Lancement…" : "Lancer un scan (Grype)"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {imageRef && scans.length > 0 && !latestSuccess && (
              <div className="empty-state">
                {latestOverall?.status === "running"
                  ? "Un scan est en cours pour cette image…"
                  : "Le dernier scan de cette image a échoué, aucune vulnérabilité connue à afficher."}
                {operate && latestOverall?.status !== "running" && (
                  <div className="topology-detail-panel__scan-cta">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={scanStatus === "starting"} onClick={handleLaunchScan}>
                      {scanStatus === "starting" ? "Lancement…" : "Relancer un scan (Grype)"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {scanStatus === "error" && scanError && <div className="error-banner">{scanError}</div>}
            {latestSuccess && (
              <>
                <div className="scan-summary">
                  {latestSuccess.vulnerabilities.length === 0 ? (
                    <span className="status-pill status-pill--success">Aucune vulnérabilité connue</span>
                  ) : (
                    SEVERITY_ORDER.filter((sev) => latestSuccess.summary[sev] > 0).map((sev) => (
                      <span key={sev} className={`status-pill status-pill--${SEVERITY_SEMANTIC[sev]}`}>
                        {sev} · {latestSuccess.summary[sev]}
                      </span>
                    ))
                  )}
                </div>
                {latestSuccess.vulnerabilities.length > 0 && (
                  // Scroll INTERNE cantonné à cette table (max-height, voir topology.css) plutôt
                  // que le panneau entier — la seule section qui peut légitimement dépasser sa
                  // hauteur (des dizaines de CVE sur une image mal maintenue).
                  <div className="data-table-wrap scan-vuln-table-wrap topology-detail-panel__vuln-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>CVE</th>
                          <th>Sévérité</th>
                          <th>Paquet</th>
                          <th>Version</th>
                          <th>Corrigé</th>
                        </tr>
                      </thead>
                      <tbody>
                        {latestSuccess.vulnerabilities
                          .slice()
                          .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
                          .map((vuln) => (
                            <tr key={`${vuln.id}-${vuln.packageName}-${vuln.installedVersion}`}>
                              <td className="cell-mono">{vuln.id}</td>
                              <td>
                                <span className={`status-pill status-pill--${SEVERITY_SEMANTIC[vuln.severity]}`}>{vuln.severity}</span>
                              </td>
                              <td>{vuln.packageName}</td>
                              <td className="cell-mono">{vuln.installedVersion}</td>
                              <td className="cell-mono">{vuln.fixedInVersion ?? "—"}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="topology-detail-panel__hint">
                  {latestSuccess.scanner === "grype" ? "Grype" : "OSV-Scanner"} · terminé {formatDate(latestSuccess.finishedAt)}
                </p>
              </>
            )}
          </div>
        )}

        {node.kind === "container" && activeTab === "metrics" && (
          <div className="topology-detail-panel__metrics">
            {metricsStatus === "loading" && metricsPoints.length === 0 && (
              <div className="empty-state">Chargement des métriques…</div>
            )}
            {metricsStatus === "error" && <div className="error-banner">Impossible de charger l'historique de métriques.</div>}
            {metricsStatus !== "loading" && metricsStatus !== "error" && metricsPoints.length === 0 && (
              <div className="empty-state">
                Aucun point de métrique connu pour ce conteneur pour l'instant — le scrape périodique
                (toutes les 30s) n'a peut-être pas encore eu l'occasion de tourner.
              </div>
            )}
            {metricsPoints.length > 0 && (
              <>
                <MetricsChart
                  title="CPU"
                  series={[{ label: "CPU", points: metricsPoints.map((p) => ({ timestamp: p.timestamp, value: p.cpuPercent })), color: "var(--accent-start, #3b6fef)" }]}
                  formatValue={(v) => `${v.toFixed(0)}%`}
                  {...(maxCpuPercent !== undefined ? { maxValue: maxCpuPercent } : {})}
                />
                <MetricsChart
                  title="Mémoire"
                  series={[{ label: "Mémoire", points: metricsPoints.map((p) => ({ timestamp: p.timestamp, value: p.memBytes })), color: "var(--color-warning)" }]}
                  formatValue={formatMem}
                  {...(maxMemBytes !== undefined ? { maxValue: maxMemBytes } : {})}
                />
                {/* Réseau/E·S disque : cumuls RÉELS (services/docker.ts#ContainerUsage), absents
                    pour tout point antérieur au 13/08/2026 ou pour un conteneur qui ne les rapporte
                    pas (network_mode:host, storage driver sans E/S bloc) — jamais un point à 0
                    substitué, le graphique correspondant reste alors simplement absent plutôt que
                    de mentir sur une activité nulle. */}
                {metricsPoints.some((p) => p.netRxBytes !== undefined) && (
                  <MetricsChart
                    title="Réseau"
                    series={[
                      {
                        label: "Réception",
                        points: metricsPoints.filter((p) => p.netRxBytes !== undefined).map((p) => ({ timestamp: p.timestamp, value: p.netRxBytes! })),
                        color: "var(--accent-end, #7c5cfc)",
                      },
                      {
                        label: "Émission",
                        points: metricsPoints.filter((p) => p.netTxBytes !== undefined).map((p) => ({ timestamp: p.timestamp, value: p.netTxBytes! })),
                        color: "#14b8a6",
                      },
                    ]}
                    formatValue={formatMem}
                  />
                )}
                {metricsPoints.some((p) => p.blkReadBytes !== undefined) && (
                  <MetricsChart
                    title="E/S disque"
                    series={[
                      {
                        label: "Lecture",
                        points: metricsPoints.filter((p) => p.blkReadBytes !== undefined).map((p) => ({ timestamp: p.timestamp, value: p.blkReadBytes! })),
                        color: "var(--color-success)",
                      },
                      {
                        label: "Écriture",
                        points: metricsPoints.filter((p) => p.blkWriteBytes !== undefined).map((p) => ({ timestamp: p.timestamp, value: p.blkWriteBytes! })),
                        color: "#f97316",
                      },
                    ]}
                    formatValue={formatMem}
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* --- Volume -------------------------------------------------------------------- */}
        {/* Pas de badge "Orphelin" ici : un volume à 0 conteneur est explicitement exclu du graphe
            par conception (services/topology.ts, voir le commentaire "Volumes/networks ORPHELINS"
            dans TopologyGraph.tsx) — qu'il s'agisse d'un vrai nœud (partagé, ≥2 conteneurs) ou d'une
            "brique" ouverte depuis un conteneur (TopologyNode#attachments, toujours exactement 1
            conteneur), soit un vrai nœud top-level partagé par ≥2 conteneurs, soit — depuis le
            13/08/2026 — un volume orphelin (`node.orphan`, `volume.inUseBy === 0`) : voir
            services/topology.ts § "Volumes/networks ORPHELINS". Le bouton Supprimer ci-dessous
            reste disponible dans les trois cas (l'API DELETE /api/volumes/:name ne dépend pas de
            ce panneau pour refuser un volume encore réellement monté). */}
        {node.kind === "volume" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            {!volume && <div className="empty-state">Chargement du détail du volume…</div>}
            {volume && (
              <>
                <div className="inspector-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => dispatch(openVolumeBrowser(volume.name))}
                  >
                    Parcourir
                  </button>
                  {operate && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={mutatingVolumeName === volume.name}
                      onClick={() => handleRemoveVolume(volume.name, volume.inUseBy)}
                    >
                      {mutatingVolumeName === volume.name ? "…" : "Supprimer"}
                    </button>
                  )}
                </div>
                <KeyValueList
                  rows={[
                    { key: "Nom", value: volume.name },
                    { key: "Driver", value: volume.driver },
                    { key: "Point de montage", value: volume.mountpoint },
                    { key: "Scope", value: volume.scope },
                    { key: "Créé le", value: formatDate(volume.createdAt) },
                    { key: "Utilisé par", value: `${volume.inUseBy} conteneur(s)` },
                  ]}
                />
                {Object.keys(volume.labels).length > 0 && (
                  <>
                    <div className="inspector-section-title">Labels</div>
                    <KeyValueList rows={Object.entries(volume.labels).map(([key, value]) => ({ key, value }))} />
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* --- Network --------------------------------------------------------------------- */}
        {/* Même remarque que pour le volume ci-dessus : un network à 0 conteneur (hors les 3
            networks par défaut, jamais "orphelins" par convention, voir DEFAULT_NETWORK_NAMES) est
            depuis le 13/08/2026 un vrai nœud top-level `node.orphan`/`network.containerCount === 0`
            (services/topology.ts), avec son bouton Supprimer déjà disponible ci-dessous. */}
        {node.kind === "network" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            {!network && <div className="empty-state">Chargement du détail du network…</div>}
            {network && (
              <>
                {operate && !DEFAULT_NETWORK_NAMES.includes(network.name) && (
                  <div className="inspector-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={mutatingNetworkId === network.id}
                      onClick={() => handleRemoveNetwork(network.id, network.name)}
                    >
                      {mutatingNetworkId === network.id ? "…" : "Supprimer"}
                    </button>
                  </div>
                )}
                <KeyValueList
                  rows={[
                    { key: "Nom", value: network.name },
                    { key: "Driver", value: network.driver },
                    { key: "Scope", value: network.scope },
                    { key: "Conteneurs attachés", value: String(network.containerCount) },
                    { key: "Créé le", value: formatDate(network.createdAt) },
                    { key: "Interne", value: network.internal ? "Oui" : "Non" },
                  ]}
                />
              </>
            )}
          </>
        )}

        {/* --- VM Nutanix -------------------------------------------------------------------- */}
        {node.kind === "nutanix-vm" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            <KeyValueList
              rows={[
                { key: "Cluster", value: node.subtitle },
                { key: "vCPUs", value: String(node.numVcpus ?? "—") },
                { key: "Mémoire", value: node.memoryMib ? formatMem(node.memoryMib * 1024 * 1024) : "—" },
                { key: "État d'alimentation", value: node.status === "running" ? "Allumée" : node.status === "stopped" ? "Éteinte" : "Indéterminé" },
              ]}
            />
          </>
        )}

        {/* --- Contrôleur de domaine / DNS AD (services/adDns.ts) ----------------------------- */}
        {node.kind === "ad-server" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
            </div>
            <KeyValueList
              rows={[
                { key: "Contrôleur de domaine", value: node.label },
                { key: "Zone DNS", value: node.subtitle },
                {
                  key: "Dernière synchronisation",
                  value:
                    node.status === "running"
                      ? "Réussie — le sous-domaine des routes reverse proxy résout automatiquement"
                      : node.status === "stopped"
                        ? "Échec — voir Paramètres › DNS Active Directory pour le détail"
                        : "Aucune tentative depuis le démarrage de QUAI",
                },
              ]}
            />
          </>
        )}

        {/* --- Hôte (cluster Nutanix physique / environnement Docker distant / hôte LXD) ---------- */}
        {node.kind === "host" && (
          <>
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} />
              <span className="status-pill status-pill--neutral">{HOST_KIND_LABEL[node.hostKind ?? "docker-local"]}</span>
            </div>
            <KeyValueList
              rows={[
                { key: "Nom", value: node.label },
                { key: "Adresse / description", value: node.subtitle },
                {
                  key: "Joignabilité",
                  value: node.status === "running" ? "Joignable" : node.status === "stopped" ? "Injoignable" : "Indéterminée",
                },
              ]}
            />
            {(node.hostKind === "remote-docker" || node.hostKind === "docker-local") && node.hostInfo && (
              <>
                <div className="inspector-section-title">Démon Docker (infos réelles)</div>
                <KeyValueList
                  rows={[
                    { key: "Endpoint", value: node.hostInfo.endpoint },
                    { key: "Version serveur", value: node.hostInfo.serverVersion },
                    { key: "Version API", value: node.hostInfo.apiVersion },
                    { key: "OS / architecture", value: `${node.hostInfo.os} (${node.hostInfo.architecture})` },
                    { key: "CPUs", value: String(node.hostInfo.cpus) },
                    { key: "Mémoire totale", value: formatMem(node.hostInfo.totalMemBytes) },
                    { key: "Conteneurs actifs / arrêtés", value: `${node.hostInfo.containersRunning} / ${node.hostInfo.containersStopped}` },
                    { key: "Images", value: String(node.hostInfo.imagesCount) },
                    { key: "Volumes", value: String(node.hostInfo.volumesCount) },
                    { key: "Swarm actif", value: node.hostInfo.swarmActive ? "Oui" : "Non" },
                  ]}
                />
              </>
            )}
            {node.hostKind === "remote-docker" && !node.hostInfo && (
              <div className="empty-state">
                Cet hôte Docker distant est configuré mais actuellement injoignable — aucune information en direct
                disponible (voir Paramètres › Environnements Docker distants).
              </div>
            )}
          </>
        )}

        {/* --- Cron job (services/cronJobsStore.ts/cronJobsScheduler.ts) ----------------------- */}
        {node.kind === "cron-job" && <CronJobDetailPanel node={node} operate={operate} admin={admin} onClose={onClose} />}

        {/* --- Sauvegarde (services/backupsStore.ts/backupScheduler.ts) ------------------------ */}
        {node.kind === "backup" && <BackupDetailPanel node={node} operate={operate} onClose={onClose} />}

        {/* --- Workspace Infra-as-code (OpenTofu/Ansible/Packer réels, services/iac/*) ---------- */}
        {node.kind === "iac-workspace" && <IacWorkspacePanel node={node} operate={operate} onClose={onClose} />}

        {/* --- Moteur d'automatisation (trigger -> condition -> action, services/automationStore.ts/
            services/automationEngine.ts) ------------------------------------------------------- */}
        {node.kind === "automation-trigger" && (
          <AutomationTriggerPanel node={node} topology={topology} operate={operate} onClose={onClose} />
        )}
        {node.kind === "automation-condition" && <AutomationConditionPanel node={node} operate={operate} onClose={onClose} />}
        {node.kind === "automation-action" && (
          <AutomationActionPanel node={node} topology={topology} operate={operate} onClose={onClose} />
        )}

        {/* --- Dépôt Git source GitOps (services/gitops.ts) ------------------------------------
            Contenu repris TEL QUEL de l'ancienne GitOpsPage.tsx (retirée, voir mission point 5) :
            liste des manifestes avec statut de dérive par fichier, diff/manifeste du fichier
            sélectionné, historique des commits, resynchronisation EXPLICITE (bouton "Resynchroniser"
            — jamais automatique/groupée par fichier, POST /api/gitops/sync recalcule la dérive de
            TOUS les manifestes en une fois, comportement backend inchangé). Seul l'EMPLACEMENT
            change : gitopsSlice.ts reste la même source de vérité Redux. */}
        {node.kind === "gitops-source" && (
          <div className="topology-detail-panel__gitops">
            <div className="chip-row topology-detail-panel__chips">
              <StatusPill status={node.status} label={node.status === "running" ? "Sain" : "Dérive détectée"} />
            </div>

            <div className="topology-detail-panel__gitops-sync">
              {gitopsLastCheckedAt && (
                <span className="overview-refresh-hint">
                  <span className="overview-refresh-dot" />
                  Vérif. auto : {new Date(gitopsLastCheckedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!operate || gitopsSyncing}
                onClick={() => dispatch(syncGitops())}
              >
                {gitopsSyncing ? "Resynchronisation…" : "Resynchroniser"}
              </button>
            </div>

            {gitopsError && <div className="error-banner">{gitopsError}</div>}

            <div className="inspector-section-title">Manifestes ({gitopsFiles.length})</div>
            <div className="file-tree">
              {gitopsFilesStatus === "loading" && gitopsFiles.length === 0 && <div className="empty-state">Chargement…</div>}
              {gitopsFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`file-tree__item${file.path === gitopsSelectedPath ? " is-active" : ""}`}
                  onClick={() => dispatch(selectGitopsFile(file.path))}
                >
                  {file.path}
                  {file.drift && <span className="file-tree__drift-dot" title="Dérive détectée" />}
                </button>
              ))}
              {gitopsFilesStatus !== "loading" && gitopsFiles.length === 0 && <div className="empty-state">Aucun manifeste.</div>}
            </div>

            <div className="diff-panel">
              <div className="diff-tabs">
                <button
                  type="button"
                  className={`diff-tab${gitopsActiveTab === "diff" ? " is-active" : ""}`}
                  onClick={() => dispatch(setGitopsActiveTab("diff"))}
                >
                  Diff
                </button>
                <button
                  type="button"
                  className={`diff-tab${gitopsActiveTab === "manifest" ? " is-active" : ""}`}
                  onClick={() => dispatch(setGitopsActiveTab("manifest"))}
                >
                  Manifeste
                </button>
              </div>

              {!gitopsSelectedPath && <div className="empty-state">Sélectionnez un fichier.</div>}

              {gitopsSelectedPath && gitopsActiveTab === "diff" && (
                <div className="diff-view">
                  {gitopsDiffStatus === "loading" && <div className="empty-state">Chargement…</div>}
                  {gitopsDiff &&
                    gitopsDiff.lines.map((line, index) => (
                      <div key={index} className={`diff-line diff-line--${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                        {line.text}
                      </div>
                    ))}
                  {gitopsDiff && gitopsDiff.lines.length === 0 && (
                    <div className="empty-state">Aucune différence — état synchronisé.</div>
                  )}
                </div>
              )}

              {gitopsSelectedPath && gitopsActiveTab === "manifest" && (
                <div className="manifest-view">
                  {gitopsFiles.find((f) => f.path === gitopsSelectedPath)?.desiredManifest}
                </div>
              )}
            </div>

            <div className="inspector-section-title">Historique des commits</div>
            <div className="commit-list">
              {gitopsCommitsStatus === "loading" && gitopsCommits.length === 0 && <div className="empty-state">Chargement…</div>}
              {gitopsCommits.map((commit) => (
                <div className="commit-item" key={commit.hash}>
                  <div className="commit-item__hash">{commit.hash.slice(0, 7)}</div>
                  <div className="commit-item__message">{commit.message}</div>
                  <div className="commit-item__meta">
                    {commit.author} · {formatDate(commit.date)}
                  </div>
                </div>
              ))}
              {gitopsCommitsStatus !== "loading" && gitopsCommits.length === 0 && <div className="empty-state">Aucun commit.</div>}
            </div>
          </div>
        )}
      </div>

      {/* Explorateur de fichiers d'un volume (lecture seule, voir ARCHITECTURE.md) — piloté par
          state.volumes.browser, indépendant du `node` affiché ici (déclenché par le bouton
          "Parcourir" ci-dessus). Toujours monté avec ce panneau plutôt que dans TopologyGraph.tsx
          (hors du périmètre de fichiers confié pour cette passe, voir mission). */}
      <VolumeFilesModal />

      {/* Console (docker exec) / logs — mêmes composants EXACTS que ContainersPage.tsx, montés
          une seule fois ici et pilotés par consoleTarget/logsTarget (voir bouton "Logs"/"Console"
          de l'onglet Aperçu ci-dessus). Indépendants du `node` affiché : rester ouverts si
          l'utilisateur change de nœud pendant qu'une session est active serait surprenant, mais
          ContainerConsole/ContainerLogs se referment déjà proprement via `onClose` sans qu'il soit
          nécessaire de les lier davantage au cycle de vie de ce panneau. */}
      <ContainerConsole
        containerId={consoleTarget?.id ?? null}
        containerName={consoleTarget?.name ?? ""}
        onClose={() => setConsoleTarget(null)}
      />
      <ContainerLogs
        containerId={logsTarget?.id ?? null}
        containerName={logsTarget?.name ?? ""}
        onClose={() => setLogsTarget(null)}
      />
    </div>
  );
}
