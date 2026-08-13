import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createTopologyGroup,
  deleteTopologyGroup,
  fetchTopology,
  fetchTopologyPositions,
  saveTopologyPositions,
  updateTopologyGroup,
} from "@/features/topology/topologySlice";
import {
  createContainer,
  fetchContainers,
  renameContainer,
  runContainerAction,
  type CreateContainerInput,
  type LifecycleAction,
} from "@/features/containers/containersSlice";
import { createVolume, removeVolume } from "@/features/volumes/volumesSlice";
import {
  connectContainerToNetwork,
  createNetwork,
  disconnectContainerFromNetwork,
  fetchNetworks,
  removeNetwork,
} from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import Modal from "@/components/Modal";
import Skeleton from "@/components/Skeleton";
import TopologyNodeDetailPanel from "@/components/TopologyNodeDetailPanel";
import TopologySubGraphPanel from "@/components/TopologySubGraphPanel";
import { IconGithub, IconSearch, IconTopology, IconTrash } from "@/components/icons";
// Réutilise TEL QUEL le flux de déploiement GitHub existant (détection Dockerfile/compose/
// Terraform, build, déploiement, déploiement auto sur push — voir ARCHITECTURE.md § "Intégration
// GitHub") : CreateSpotlight ne fait que le monter dans une modal par-dessus le canevas, aucune
// logique n'est dupliquée ici (voir CreateSpotlight ci-dessous pour le choix "inline vs
// navigation").
import GitHubDeployPage from "@/features/github/GitHubDeployPage";
// "Nouveau workspace Infra-as-code" (CreateSpotlight ci-dessous, point 4 de la mission) : réutilise
// le thunk existant createWorkspace (iacSlice.ts, déjà utilisé par TopologyNodeDetailPanel.tsx pour
// le panneau de détail d'un workspace) — POST /api/iac/workspaces réel, aucune route dupliquée.
import { createWorkspace } from "@/features/iac/iacSlice";
// "Nouveau Cron Job"/"Nouvelle sauvegarde" (CreateSpotlight ci-dessous, mission A.4/B.4) —
// réutilisent les thunks existants (cronJobsSlice.ts/backupsSlice.ts, déjà utilisés par
// TopologyNodeDetailPanel.tsx pour le panneau de détail) : POST /api/cron-jobs/POST /api/backups
// réels, aucune route dupliquée.
import { createCronJob, fetchCronJobs } from "@/features/cronJobs/cronJobsSlice";
import { createBackupDefinition } from "@/features/backups/backupsSlice";
// "Nouveau déclencheur"/"Nouvelle condition"/"Nouvelle action" (câblage frontend du moteur
// d'automatisation, voir apps/api/src/routes/automation.ts) — même principe que les imports
// ci-dessus : réutilise le nouveau slice dédié (automationSlice.ts, POST /api/automation/nodes
// réel), ainsi que fetchRoutes (reverseProxySlice.ts, déjà utilisé par ReverseProxyPage.tsx) et
// fetchNotificationChannels (notificationChannelsSlice.ts, déjà utilisé par
// NotificationChannelsPage.tsx) pour peupler les select de source/action avec des ressources RÉELLES,
// jamais une liste inventée.
import { createAutomationEdge, createAutomationNode, deleteAutomationEdge, deleteAutomationNode } from "@/features/automation/automationSlice";
import { fetchRoutes } from "@/features/reverseProxy/reverseProxySlice";
import { fetchNotificationChannels } from "@/features/notificationChannels/notificationChannelsSlice";
import type { IacEngine } from "@/types";
import {
  CAPABILITY_DEFS,
  KIND_ICON,
  MINIMAP_NODE_COLOR,
  NODE_CAPABILITIES,
  attachmentToTopologyNode,
  buildTopologyEdges,
  deriveGroupPorts,
  edgeTypes,
  idWithoutPrefix,
  nodeTypes,
  useDismiss,
  usePrefersReducedMotion,
  type CapabilityDef,
  type GraphNodeCallbacks,
  type GroupFrameNodeData,
  type GroupNodeData,
  type PortSpec,
} from "@/components/topologyGraphShared";
import type {
  AutomationActionConfig,
  AutomationTriggerSource,
  BackupTargetKind,
  TopologyEdge,
  TopologyGroup,
  TopologyNode,
  TopologyNodeAttachment,
} from "@/types";

/** Nombre de nœuds squelettes par colonne (volumes / conteneurs / networks) pendant le premier
 * chargement — silhouette approximative, pas besoin de coller exactement au nombre réel. */
const SKELETON_COLUMN_ROWS = [2, 3, 2];

const REFRESH_INTERVAL_MS = 15_000;
// Colonnes "nutanix-vm"/"ad-server"/"host"/"iac-workspace"/"cron-job"/"backup" à part, après
// network — nœuds isolés ou reliés entre eux uniquement (jamais d'arête vers Docker), des
// colonnes dédiées les gardent lisibles plutôt que de les mélanger aux conteneurs.
const COLUMN_X: Record<TopologyNode["kind"], number> = {
  volume: 0,
  container: 340,
  network: 680,
  "nutanix-vm": 1020,
  "ad-server": 1360,
  host: 1700,
  "iac-workspace": 2040,
  "cron-job": 2380,
  backup: 2720,
  "gitops-source": 3060,
  // Zone "Automatisation" (trigger -> condition -> action, voir services/automationStore.ts) —
  // 3 colonnes adjacentes après gitops-source, dans l'ordre de lecture naturel de la chaîne
  // (gauche = déclencheur, milieu = condition, droite = action), même largeur de colonne (340) que
  // le reste de ce tableau.
  "automation-trigger": 3400,
  "automation-condition": 3740,
  "automation-action": 4080,
};
const ROW_HEIGHT = 130;
const NETWORK_DRIVERS = ["bridge", "overlay", "host", "none"];
const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  remove: "Supprimer",
};

// --- Regroupement de nœuds ("encapsulation façon Railway/Logisim", voir topologyGraphShared.tsx
// et TopologyGroup) — largeur/hauteur APPROXIMATIVES d'une carte .topology-node (voir topology.css,
// largeur fixe 260px, hauteur variable selon badges/métriques/briques affichés) : sert uniquement à
// dessiner le CADRE décoratif (.topology-group-frame) autour des membres d'un groupe déplié, pas un
// calcul pixel-perfect (un cadre légèrement trop grand/petit reste un détail purement visuel, jamais
// une donnée d'infrastructure) — mesurer la taille RÉELLE de chaque carte demanderait d'attendre le
// layout DOM de React Flow (`node.measured`), complexité non justifiée pour un simple repère visuel.
const GROUP_NODE_APPROX_WIDTH = 260;
const GROUP_NODE_APPROX_HEIGHT = 170;
const GROUP_FRAME_PADDING = 48;
const GROUP_FRAME_HEADER_HEIGHT = 44;

/**
 * Raccourcis "1 clic, 0 champ" de la palette de création (façon Railway "Deploy PostgreSQL"/
 * "Deploy Redis"...) — un conteneur créé directement avec l'image Docker OFFICIELLE et des valeurs
 * par défaut sensées (réutilise POST /api/containers via createContainer, EXACTEMENT la même route
 * que le formulaire détaillé). Aucun champ à remplir : le nom est suffixé d'un identifiant court
 * pour éviter une collision de nom Docker si l'utilisateur clique plusieurs fois. Le mot de passe
 * par défaut est volontairement visible/documenté (jamais un secret réel) — à changer ensuite par
 * l'utilisateur (variables d'environnement modifiables comme n'importe quel conteneur QUAI).
 */
interface QuickDeployPreset {
  id: string;
  title: string;
  description: string;
  namePrefix: string;
  image: string;
  env?: string[];
  volumeMountPath?: string;
}

const QUICK_DEPLOY_PRESETS: QuickDeployPreset[] = [
  {
    id: "postgres",
    title: "Déployer une base PostgreSQL",
    description: "Base de données relationnelle prête à l'emploi (image officielle postgres:16).",
    namePrefix: "postgres",
    image: "postgres:16",
    env: ["POSTGRES_PASSWORD=changeme"],
    volumeMountPath: "/var/lib/postgresql/data",
  },
  {
    id: "redis",
    title: "Déployer un cache Redis",
    description: "Base clé-valeur en mémoire, pour du cache ou des files d'attente (image officielle redis:7-alpine).",
    namePrefix: "redis",
    image: "redis:7-alpine",
    volumeMountPath: "/data",
  },
  {
    id: "mysql",
    title: "Déployer une base MySQL",
    description: "Base de données relationnelle largement utilisée (image officielle mysql:8).",
    namePrefix: "mysql",
    image: "mysql:8",
    env: ["MYSQL_ROOT_PASSWORD=changeme"],
    volumeMountPath: "/var/lib/mysql",
  },
  {
    id: "mongo",
    title: "Déployer une base MongoDB",
    description: "Base de données orientée documents (image officielle mongo:7).",
    namePrefix: "mongo",
    image: "mongo:7",
    volumeMountPath: "/data/db",
  },
];

function shortId(): string {
  return Math.random().toString(36).slice(2, 7);
}

/** Sous-ensemble créable par le popover de création rapide (clic droit sur le canevas) — les
 * VMs Nutanix ne le sont pas (QUAI ne fait que les lire via Prism Central), pas d'entrée pour
 * ce kind ici plutôt qu'une entrée jamais utilisée dans TopologyNode["kind"] au complet. */
type CreatableKind = "container" | "volume" | "network";

interface CreatePopoverProps {
  kind: CreatableKind;
  x: number;
  y: number;
  onClose: () => void;
}

const CREATE_TITLE: Record<CreatableKind, string> = {
  container: "Nouveau conteneur",
  volume: "Nouveau volume",
  network: "Nouveau network",
};

/** Popover de création rapide (clic droit sur le canevas) — réutilise les mêmes thunks Redux
 * que ContainersPage/VolumesPage/NetworksPage, en version minimale positionnée près du clic. */
function CreatePopover({ kind, x, y, onClose }: CreatePopoverProps) {
  const dispatch = useAppDispatch();
  const { ref, style } = useDismiss(onClose, x, y);
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (kind === "container") {
        const trimmedImage = image.trim();
        if (!trimmedImage) return;
        const result = await dispatch(
          createContainer({
            image: trimmedImage,
            ...(name.trim() ? { name: name.trim() } : {}),
            ports: ports.split(",").map((p) => p.trim()).filter(Boolean),
          }),
        );
        if (createContainer.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du conteneur.");
      } else if (kind === "volume") {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const result = await dispatch(createVolume(trimmedName));
        if (createVolume.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du volume.");
      } else {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const result = await dispatch(createNetwork({ name: trimmedName, driver }));
        if (createNetwork.fulfilled.match(result)) {
          dispatch(fetchTopology());
          onClose();
          return;
        }
        setError(result.payload ?? "Échec de la création du network.");
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = kind === "container" ? image.trim().length > 0 : name.trim().length > 0;

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{CREATE_TITLE[kind]}</div>
      <form onSubmit={handleSubmit}>
        {kind === "container" && (
          <>
            <div className="field">
              <label htmlFor="graph-new-image">Image</label>
              <input
                id="graph-new-image"
                type="text"
                autoFocus
                placeholder="ex : redis:7-alpine"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="graph-new-name">Nom (optionnel)</label>
              <input id="graph-new-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </div>
            <div className="field">
              <label htmlFor="graph-new-ports">Ports (optionnel)</label>
              <input
                id="graph-new-ports"
                type="text"
                placeholder="ex : 8080:80"
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                disabled={busy}
              />
            </div>
          </>
        )}
        {kind === "volume" && (
          <div className="field">
            <label htmlFor="graph-new-volume-name">Nom</label>
            <input
              id="graph-new-volume-name"
              type="text"
              autoFocus
              placeholder="ex : pgdata"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              required
            />
          </div>
        )}
        {kind === "network" && (
          <>
            <div className="field">
              <label htmlFor="graph-new-network-name">Nom</label>
              <input
                id="graph-new-network-name"
                type="text"
                autoFocus
                placeholder="ex : quai-app-net"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="graph-new-network-driver">Driver</label>
              <select id="graph-new-network-driver" value={driver} onChange={(e) => setDriver(e.target.value)} disabled={busy}>
                {NETWORK_DRIVERS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canSubmit}>
            {busy ? "…" : "Créer"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface SpotlightAction {
  id: string;
  title: string;
  description: string;
  icon: (props: { className?: string }) => JSX.Element;
  onSelect: () => void;
}

interface CreateSpotlightProps {
  x: number;
  y: number;
  onClose: () => void;
  /** Ouvre le formulaire détaillé existant (CreatePopover) pour ce kind — conteneur/volume/network
   * "classiques", inchangés, juste précédés désormais d'un champ de recherche pour les retrouver. */
  onPickKind: (kind: CreatableKind) => void;
  /** Nœuds RÉELS du graphe déjà chargés (voir TopologyGraph.tsx#return, `data?.nodes ?? []`) —
   * uniquement pour peupler le select "Surveiller un nœud du graphe" du formulaire "Nouveau
   * déclencheur" ci-dessous, jamais une liste inventée/recalculée. */
  topologyNodes: TopologyNode[];
}

/**
 * Palette de création façon "spotlight" (Railway "What can we help with?", voir ARCHITECTURE.md
 * chapitre "Graphe de topologie", point 4 de la mission) : un champ de recherche libre au-dessus
 * d'une liste d'actions — les 3 types de nœud "classiques" (ouvrent le formulaire détaillé existant,
 * CreatePopover, inchangé) PLUS des raccourcis "1 clic, 0 champ" pour les bases de données les plus
 * courantes (QUICK_DEPLOY_PRESETS ci-dessus, réutilisent EXACTEMENT la même route de création de
 * conteneur que le formulaire détaillé) PLUS, tout en haut (façon Railway "Deploy from GitHub repo"),
 * "Déployer depuis GitHub". Remplace l'ancien menu contextuel plat (3 entrées) du clic droit sur le
 * canevas — ET accessible par un bouton "+ Créer" toujours visible (voir TopologyGraph.tsx#return),
 * pas seulement via clic droit.
 *
 * Approche choisie pour "Déployer depuis GitHub" (voir mission) : INLINE, pas navigation. Vérifié
 * avant d'écrire une seule ligne que GitHubDeployPage.tsx (détection Dockerfile/compose/Terraform,
 * build, déploiement, déploiement auto sur push — TOUT entièrement fonctionnel côté
 * services/github.ts) n'était en fait rattachée à AUCUNE vue navigable (`ViewId`
 * apps/web/src/features/ui/uiSlice.ts, `App.tsx#renderView`, Sidebar.tsx) : l'alternative
 * "navigation" documentée dans la mission comme repli acceptable aurait donc exigé de créer cette
 * vue de toutes pièces (uiSlice.ts + App.tsx + Sidebar.tsx), hors du périmètre de fichiers confié
 * ici. Monter <GitHubDeployPage/> INCHANGÉ dans une <Modal> (composant partagé déjà utilisé
 * ailleurs dans l'appli, focus trap/Échap/clic-extérieur déjà gérés) est le chemin qui ne
 * duplique ni ne réimplémente RIEN de sa logique — seul un nouveau bloc CSS (topology.css,
 * `.graph-github-modal*`) l'élargit au-delà des 420px par défaut d'une modal de confirmation.
 */
function CreateSpotlight({ x, y, onClose, onPickKind, topologyNodes }: CreateSpotlightProps) {
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState("");
  const [deployingId, setDeployingId] = useState<string | null>(null);
  // Bascule interne : true dès que "Déployer depuis GitHub" est choisi ci-dessous — la MÊME
  // instance de popover troque alors sa recherche spotlight contre le flux GitHub réel (voir
  // JSDoc ci-dessus). Reste locale à CreateSpotlight, aucun état ajouté ailleurs dans le fichier.
  const [showGithubDeploy, setShowGithubDeploy] = useState(false);
  // Même principe pour "Nouveau workspace Infra-as-code" (mission point 4) — mais un simple
  // formulaire inline (pas de portail document.body comme la modal GitHub ci-dessus) : reste DANS
  // `ref`, useDismiss continue donc de le fermer normalement au clic extérieur/Échap, aucun garde
  // supplémentaire nécessaire dans useDismiss ci-dessous.
  const [showIacCreate, setShowIacCreate] = useState(false);
  const [iacName, setIacName] = useState("");
  const [iacEngine, setIacEngine] = useState<IacEngine>("tofu");
  const [iacBusy, setIacBusy] = useState(false);
  const [iacError, setIacError] = useState<string | null>(null);
  // "Nouveau Cron Job" (mission A.4) — même principe de mini-formulaire inline que
  // "Nouveau workspace Infra-as-code" ci-dessus. Conteneurs "running" chargés à l'ouverture du
  // formulaire (pas à l'ouverture du spotlight lui-même, inutile tant que ce choix n'est pas fait).
  const [showCronJobCreate, setShowCronJobCreate] = useState(false);
  const [cronName, setCronName] = useState("");
  const [cronContainerId, setCronContainerId] = useState("");
  const [cronCommand, setCronCommand] = useState("");
  const [cronSchedule, setCronSchedule] = useState("*/5 * * * *");
  const [cronBusy, setCronBusy] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);
  const containers = useAppSelector((s) => s.containers.items);
  const runningContainers = containers.filter((c) => c.state === "running");
  // "Nouvelle sauvegarde" (mission B.4) — formulaire minimal : region/forcePathStyle/identifiants
  // S3 restent à leurs valeurs par défaut côté serveur (voir services/backupsStore.ts#
  // encryptDestination), toujours modifiables ensuite depuis le panneau de détail du nœud créé.
  const [showBackupCreate, setShowBackupCreate] = useState(false);
  const [backupName, setBackupName] = useState("");
  const [backupTargetKind, setBackupTargetKind] = useState<BackupTargetKind>("volume");
  const [backupTargetRef, setBackupTargetRef] = useState("");
  const [backupEndpoint, setBackupEndpoint] = useState("");
  const [backupBucket, setBackupBucket] = useState("");
  const [backupSchedule, setBackupSchedule] = useState("0 3 * * *");
  const [backupRetentionCount, setBackupRetentionCount] = useState("7");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  // "Nouveau déclencheur"/"Nouvelle condition"/"Nouvelle action" (câblage frontend du moteur
  // d'automatisation) — même principe de mini-formulaire inline que "Nouveau workspace
  // Infra-as-code"/"Nouveau Cron Job"/"Nouvelle sauvegarde" ci-dessus. Réutilise createAutomationNode
  // (automationSlice.ts) — POST /api/automation/nodes réel, aucune route dupliquée.
  const [showTriggerCreate, setShowTriggerCreate] = useState(false);
  const [triggerName, setTriggerName] = useState("");
  const [triggerSourceKind, setTriggerSourceKind] = useState<AutomationTriggerSource["kind"]>("topology-node");
  const [triggerSourceNodeId, setTriggerSourceNodeId] = useState("");
  const [triggerSourceRouteId, setTriggerSourceRouteId] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  // Nœuds du graphe surveillables par un trigger "topology-node" — mêmes 4 kinds qui portent un
  // état réel et durable, jamais un autre nœud d'automatisation (voir mission). `nodeId` envoyé au
  // serveur est l'id COMPLET préfixé du nœud (ex: "container:abcd1234"), pas un id brut : c'est ce
  // que services/automationEngine.ts#resolveTopologyNodeState recherche directement dans
  // `topology.nodes` (`topology.nodes.find(n => n.id === nodeId)`), jamais un id Docker nu.
  const watchableTopologyNodes = topologyNodes.filter(
    (n) => n.kind === "container" || n.kind === "host" || n.kind === "nutanix-vm" || n.kind === "ad-server",
  );
  const routes = useAppSelector((s) => s.reverseProxy.items);
  const [showConditionCreate, setShowConditionCreate] = useState(false);
  const [conditionName, setConditionName] = useState("");
  const [conditionInvert, setConditionInvert] = useState(false);
  const [conditionBusy, setConditionBusy] = useState(false);
  const [conditionError, setConditionError] = useState<string | null>(null);
  const [showActionCreate, setShowActionCreate] = useState(false);
  const [automationActionName, setAutomationActionName] = useState("");
  const [automationActionKind, setAutomationActionKind] = useState<AutomationActionConfig["kind"]>("run-cron-job");
  const [automationActionCronJobId, setAutomationActionCronJobId] = useState("");
  const [automationActionChannelId, setAutomationActionChannelId] = useState("");
  const [automationActionMessage, setAutomationActionMessage] = useState("");
  const [automationActionContainerId, setAutomationActionContainerId] = useState("");
  const [automationActionLifecycle, setAutomationActionLifecycle] = useState<"start" | "stop" | "restart">("restart");
  const [automationActionBusy, setAutomationActionBusy] = useState(false);
  const [automationActionError, setAutomationActionError] = useState<string | null>(null);
  const cronJobs = useAppSelector((s) => s.cronJobs.items);
  const notificationChannels = useAppSelector((s) => s.notificationChannels.items);
  // useDismiss ferme sur clic hors de `ref`/Échap — mais une fois la modal GitHub ouverte, son
  // contenu vit dans un portail document.body (Modal.tsx), donc HORS de `ref` : sans ce garde-fou,
  // le premier clic à l'intérieur de la modal (un repo, un champ...) la refermerait aussitôt.
  // Modal.tsx gère alors seule Échap/clic-extérieur pour son propre contenu.
  const { ref, style } = useDismiss(() => {
    if (!showGithubDeploy) onClose();
  }, x, y);

  // Conteneurs "running" pour le sélecteur du formulaire "Nouveau Cron Job" — chargés seulement une
  // fois ce formulaire effectivement ouvert (inutile tant que ce choix n'a pas été fait). Même
  // chargement paresseux pour le formulaire "Nouvelle action" quand son type "Action sur un
  // conteneur" est sélectionné (state.containers.items, TOUS les conteneurs connus — pas seulement
  // "running", une action peut aussi bien démarrer un conteneur arrêté).
  useEffect(() => {
    if (showCronJobCreate || (showActionCreate && automationActionKind === "container-action")) {
      dispatch(fetchContainers(null));
    }
  }, [dispatch, showCronJobCreate, showActionCreate, automationActionKind]);

  // "Nouveau déclencheur" (source "reverse-proxy-route") — routes réelles chargées seulement une
  // fois ce choix effectivement fait, même principe que les conteneurs ci-dessus. Réutilise
  // fetchRoutes (reverseProxySlice.ts), déjà utilisé par ReverseProxyPage.tsx.
  useEffect(() => {
    if (showTriggerCreate && triggerSourceKind === "reverse-proxy-route") dispatch(fetchRoutes());
  }, [dispatch, showTriggerCreate, triggerSourceKind]);

  // "Nouvelle action" — cron jobs/canaux de notification réels chargés seulement une fois le type
  // d'action correspondant effectivement sélectionné, même principe. Réutilise fetchCronJobs
  // (cronJobsSlice.ts)/fetchNotificationChannels (notificationChannelsSlice.ts), déjà utilisés par
  // TopologyNodeDetailPanel.tsx/NotificationChannelsPage.tsx.
  useEffect(() => {
    if (showActionCreate && automationActionKind === "run-cron-job") dispatch(fetchCronJobs());
    if (showActionCreate && automationActionKind === "send-notification") dispatch(fetchNotificationChannels());
  }, [dispatch, showActionCreate, automationActionKind]);

  async function handleCreateIacWorkspace(event: FormEvent) {
    event.preventDefault();
    const trimmed = iacName.trim();
    if (!trimmed) return;
    setIacBusy(true);
    setIacError(null);
    // createWorkspace (iacSlice.ts) pousse déjà une notification de succès et POST réellement
    // /api/iac/workspaces — aucune route dupliquée, même thunk que le panneau de détail du nœud créé.
    const result = await dispatch(createWorkspace({ name: trimmed, engine: iacEngine }));
    setIacBusy(false);
    if (createWorkspace.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setIacError(result.payload ?? "Échec de la création du workspace.");
    }
  }

  if (showIacCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouveau workspace Infra-as-code</div>
        <form onSubmit={handleCreateIacWorkspace}>
          <div className="field">
            <label htmlFor="graph-iac-name">Nom</label>
            <input
              id="graph-iac-name"
              type="text"
              autoFocus
              placeholder="ex : infra-prod"
              value={iacName}
              onChange={(e) => setIacName(e.target.value)}
              disabled={iacBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-iac-engine">Moteur</label>
            <select
              id="graph-iac-engine"
              value={iacEngine}
              onChange={(e) => setIacEngine(e.target.value as IacEngine)}
              disabled={iacBusy}
            >
              <option value="tofu">OpenTofu</option>
              <option value="ansible">Ansible</option>
              <option value="packer">Packer</option>
            </select>
          </div>
          {iacError && <p className="graph-popover__error">{iacError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={iacBusy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={iacBusy || !iacName.trim()}>
              {iacBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  async function handleCreateCronJob(event: FormEvent) {
    event.preventDefault();
    const trimmedName = cronName.trim();
    const trimmedCommand = cronCommand.trim();
    const trimmedSchedule = cronSchedule.trim();
    if (!trimmedName || !cronContainerId || !trimmedCommand || !trimmedSchedule) return;
    setCronBusy(true);
    setCronError(null);
    const containerName = containers.find((c) => c.id === cronContainerId)?.name ?? cronContainerId;
    // createCronJob (cronJobsSlice.ts) POST réellement /api/cron-jobs — même thunk que le panneau
    // de détail du nœud créé (TopologyNodeDetailPanel.tsx#CronJobDetailPanel), aucune route dupliquée.
    const result = await dispatch(
      createCronJob({ name: trimmedName, containerId: cronContainerId, containerName, command: trimmedCommand, schedule: trimmedSchedule, enabled: true }),
    );
    setCronBusy(false);
    if (createCronJob.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setCronError(result.payload ?? "Échec de la création du cron job.");
    }
  }

  if (showCronJobCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouveau Cron Job</div>
        <form onSubmit={handleCreateCronJob}>
          <div className="field">
            <label htmlFor="graph-cron-name">Nom</label>
            <input
              id="graph-cron-name"
              type="text"
              autoFocus
              placeholder="ex : Purge des logs applicatifs"
              value={cronName}
              onChange={(e) => setCronName(e.target.value)}
              disabled={cronBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-cron-container">Conteneur cible</label>
            <select
              id="graph-cron-container"
              value={cronContainerId}
              onChange={(e) => setCronContainerId(e.target.value)}
              disabled={cronBusy}
              required
            >
              <option value="">— sélectionner —</option>
              {runningContainers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.image})
                </option>
              ))}
            </select>
            {runningContainers.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                Aucun conteneur en cours d'exécution connu de QUAI.
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="graph-cron-command">Commande</label>
            <textarea
              id="graph-cron-command"
              className="iac-editor"
              style={{ minHeight: 60 }}
              value={cronCommand}
              onChange={(e) => setCronCommand(e.target.value)}
              placeholder="ex : find /var/log/app -mtime +7 -delete"
              spellCheck={false}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-cron-schedule">Planification (cron, 5 champs)</label>
            <input
              id="graph-cron-schedule"
              className="cell-mono"
              value={cronSchedule}
              onChange={(e) => setCronSchedule(e.target.value)}
              placeholder="*/5 * * * *"
              disabled={cronBusy}
              required
            />
          </div>
          {cronError && <p className="graph-popover__error">{cronError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={cronBusy}>
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={cronBusy || !cronName.trim() || !cronContainerId || !cronCommand.trim() || !cronSchedule.trim()}
            >
              {cronBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  async function handleCreateBackup(event: FormEvent) {
    event.preventDefault();
    const trimmedName = backupName.trim();
    const trimmedRef = backupTargetRef.trim();
    const trimmedEndpoint = backupEndpoint.trim();
    const trimmedBucket = backupBucket.trim();
    const trimmedSchedule = backupSchedule.trim();
    const retentionCount = Number(backupRetentionCount);
    if (!trimmedName || !trimmedRef || !trimmedEndpoint || !trimmedBucket || !trimmedSchedule || !Number.isInteger(retentionCount) || retentionCount < 1) {
      return;
    }
    setBackupBusy(true);
    setBackupError(null);
    // createBackupDefinition (backupsSlice.ts) POST réellement /api/backups — même thunk que le
    // panneau de détail du nœud créé, aucune route dupliquée. region/forcePathStyle/identifiants S3
    // omis ici : valeurs par défaut côté serveur, modifiables ensuite depuis le panneau de détail.
    const result = await dispatch(
      createBackupDefinition({
        name: trimmedName,
        target: { kind: backupTargetKind, ref: trimmedRef },
        destination: { endpoint: trimmedEndpoint, bucket: trimmedBucket },
        schedule: trimmedSchedule,
        retentionCount,
        enabled: true,
      }),
    );
    setBackupBusy(false);
    if (createBackupDefinition.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setBackupError(result.payload ?? "Échec de la création de la sauvegarde.");
    }
  }

  if (showBackupCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouvelle sauvegarde</div>
        <form onSubmit={handleCreateBackup}>
          <div className="field">
            <label htmlFor="graph-backup-name">Nom</label>
            <input
              id="graph-backup-name"
              type="text"
              autoFocus
              placeholder="ex : Base citoyens (nocturne)"
              value={backupName}
              onChange={(e) => setBackupName(e.target.value)}
              disabled={backupBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-backup-target-kind">Type de cible</label>
            <select
              id="graph-backup-target-kind"
              value={backupTargetKind}
              onChange={(e) => setBackupTargetKind(e.target.value as BackupTargetKind)}
              disabled={backupBusy}
            >
              <option value="volume">Volume Docker</option>
              <option value="database">Base de données (conteneur)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="graph-backup-target-ref">
              {backupTargetKind === "volume" ? "Nom du volume" : "Conteneur cible"}
            </label>
            <input
              id="graph-backup-target-ref"
              type="text"
              value={backupTargetRef}
              onChange={(e) => setBackupTargetRef(e.target.value)}
              placeholder={backupTargetKind === "volume" ? "ex : quai_pgdata" : "ex : id ou nom du conteneur postgres"}
              disabled={backupBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-backup-endpoint">Endpoint S3</label>
            <input
              id="graph-backup-endpoint"
              type="text"
              value={backupEndpoint}
              onChange={(e) => setBackupEndpoint(e.target.value)}
              placeholder="https://minio.lecreusot.priv:9000"
              disabled={backupBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-backup-bucket">Bucket</label>
            <input
              id="graph-backup-bucket"
              type="text"
              value={backupBucket}
              onChange={(e) => setBackupBucket(e.target.value)}
              placeholder="quai-backups"
              disabled={backupBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-backup-schedule">Planification (cron, 5 champs)</label>
            <input
              id="graph-backup-schedule"
              className="cell-mono"
              value={backupSchedule}
              onChange={(e) => setBackupSchedule(e.target.value)}
              placeholder="0 3 * * *"
              disabled={backupBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-backup-retention">Rétention (copies conservées)</label>
            <input
              id="graph-backup-retention"
              type="number"
              min={1}
              value={backupRetentionCount}
              onChange={(e) => setBackupRetentionCount(e.target.value)}
              disabled={backupBusy}
              required
            />
          </div>
          {backupError && <p className="graph-popover__error">{backupError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={backupBusy}>
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={backupBusy || !backupName.trim() || !backupTargetRef.trim() || !backupEndpoint.trim() || !backupBucket.trim()}
            >
              {backupBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  async function handleCreateTrigger(event: FormEvent) {
    event.preventDefault();
    const trimmed = triggerName.trim();
    if (!trimmed) return;
    if (triggerSourceKind === "topology-node" && !triggerSourceNodeId) return;
    if (triggerSourceKind === "reverse-proxy-route" && !triggerSourceRouteId) return;
    setTriggerBusy(true);
    setTriggerError(null);
    const source: AutomationTriggerSource =
      triggerSourceKind === "topology-node"
        ? { kind: "topology-node", nodeId: triggerSourceNodeId }
        : { kind: "reverse-proxy-route", routeId: triggerSourceRouteId };
    // createAutomationNode (automationSlice.ts) POST réellement /api/automation/nodes — aucune
    // route dupliquée, même thunk que le panneau de détail du nœud créé (TopologyNodeDetailPanel.tsx).
    const result = await dispatch(createAutomationNode({ kind: "automation-trigger", label: trimmed, triggerConfig: { source } }));
    setTriggerBusy(false);
    if (createAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setTriggerError(result.payload ?? "Échec de la création du déclencheur.");
    }
  }

  if (showTriggerCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouveau déclencheur</div>
        <form onSubmit={handleCreateTrigger}>
          <div className="field">
            <label htmlFor="graph-trigger-name">Nom</label>
            <input
              id="graph-trigger-name"
              type="text"
              autoFocus
              placeholder="ex : Panne du serveur web"
              value={triggerName}
              onChange={(e) => setTriggerName(e.target.value)}
              disabled={triggerBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-trigger-source-kind">Source surveillée</label>
            <select
              id="graph-trigger-source-kind"
              value={triggerSourceKind}
              onChange={(e) => setTriggerSourceKind(e.target.value as AutomationTriggerSource["kind"])}
              disabled={triggerBusy}
            >
              <option value="topology-node">Un nœud du graphe</option>
              <option value="reverse-proxy-route">Une route de reverse proxy</option>
            </select>
          </div>
          {triggerSourceKind === "topology-node" && (
            <div className="field">
              <label htmlFor="graph-trigger-node">Nœud surveillé</label>
              <select
                id="graph-trigger-node"
                value={triggerSourceNodeId}
                onChange={(e) => setTriggerSourceNodeId(e.target.value)}
                disabled={triggerBusy}
                required
              >
                <option value="">— sélectionner —</option>
                {watchableTopologyNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} ({n.kind})
                  </option>
                ))}
              </select>
              {watchableTopologyNodes.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  Aucun conteneur/hôte/VM Nutanix/contrôleur AD connu de QUAI.
                </span>
              )}
            </div>
          )}
          {triggerSourceKind === "reverse-proxy-route" && (
            <div className="field">
              <label htmlFor="graph-trigger-route">Route surveillée</label>
              <select
                id="graph-trigger-route"
                value={triggerSourceRouteId}
                onChange={(e) => setTriggerSourceRouteId(e.target.value)}
                disabled={triggerBusy}
                required
              >
                <option value="">— sélectionner —</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.subdomain}
                  </option>
                ))}
              </select>
              {routes.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  Aucune route de reverse proxy connue de QUAI.
                </span>
              )}
            </div>
          )}
          {triggerError && <p className="graph-popover__error">{triggerError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={triggerBusy}>
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={
                triggerBusy ||
                !triggerName.trim() ||
                (triggerSourceKind === "topology-node" ? !triggerSourceNodeId : !triggerSourceRouteId)
              }
            >
              {triggerBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  async function handleCreateCondition(event: FormEvent) {
    event.preventDefault();
    const trimmed = conditionName.trim();
    if (!trimmed) return;
    setConditionBusy(true);
    setConditionError(null);
    // createAutomationNode (automationSlice.ts) POST réellement /api/automation/nodes — même thunk
    // que "Nouveau déclencheur" ci-dessus, aucune route dupliquée.
    const result = await dispatch(createAutomationNode({ kind: "automation-condition", label: trimmed, conditionInvert }));
    setConditionBusy(false);
    if (createAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setConditionError(result.payload ?? "Échec de la création de la condition.");
    }
  }

  if (showConditionCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouvelle condition</div>
        <form onSubmit={handleCreateCondition}>
          <div className="field">
            <label htmlFor="graph-condition-name">Nom</label>
            <input
              id="graph-condition-name"
              type="text"
              autoFocus
              placeholder="ex : Uniquement si en échec"
              value={conditionName}
              onChange={(e) => setConditionName(e.target.value)}
              disabled={conditionBusy}
              required
            />
          </div>
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={conditionInvert}
              onChange={(e) => setConditionInvert(e.target.checked)}
              disabled={conditionBusy}
            />
            Inverser (bloquer la chaîne si la source est en échec, au lieu de la laisser passer)
          </label>
          {conditionError && <p className="graph-popover__error">{conditionError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={conditionBusy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={conditionBusy || !conditionName.trim()}>
              {conditionBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  async function handleCreateAutomationAction(event: FormEvent) {
    event.preventDefault();
    const trimmed = automationActionName.trim();
    if (!trimmed) return;
    let actionConfig: AutomationActionConfig;
    if (automationActionKind === "run-cron-job") {
      if (!automationActionCronJobId) return;
      actionConfig = { kind: "run-cron-job", cronJobId: automationActionCronJobId };
    } else if (automationActionKind === "send-notification") {
      const trimmedMessage = automationActionMessage.trim();
      if (!automationActionChannelId || !trimmedMessage) return;
      actionConfig = { kind: "send-notification", channelId: automationActionChannelId, message: trimmedMessage };
    } else {
      if (!automationActionContainerId) return;
      actionConfig = { kind: "container-action", containerId: automationActionContainerId, action: automationActionLifecycle };
    }
    setAutomationActionBusy(true);
    setAutomationActionError(null);
    // createAutomationNode (automationSlice.ts) POST réellement /api/automation/nodes — même thunk
    // que "Nouveau déclencheur"/"Nouvelle condition" ci-dessus, aucune route dupliquée. L'action
    // RÉELLEMENT exécutée (cron job/notification/action conteneur) appelle toujours une route déjà
    // existante et déjà soumise à ses propres gardes de rôle, voir routes/automation.ts.
    const result = await dispatch(createAutomationNode({ kind: "automation-action", label: trimmed, actionConfig }));
    setAutomationActionBusy(false);
    if (createAutomationNode.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setAutomationActionError(result.payload ?? "Échec de la création de l'action.");
    }
  }

  if (showActionCreate) {
    return (
      <div className="graph-popover" style={style} ref={ref}>
        <div className="graph-popover__title">Nouvelle action</div>
        <form onSubmit={handleCreateAutomationAction}>
          <div className="field">
            <label htmlFor="graph-automation-action-name">Nom</label>
            <input
              id="graph-automation-action-name"
              type="text"
              autoFocus
              placeholder="ex : Redémarrer le service"
              value={automationActionName}
              onChange={(e) => setAutomationActionName(e.target.value)}
              disabled={automationActionBusy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="graph-automation-action-kind">Type d'action</label>
            <select
              id="graph-automation-action-kind"
              value={automationActionKind}
              onChange={(e) => setAutomationActionKind(e.target.value as AutomationActionConfig["kind"])}
              disabled={automationActionBusy}
            >
              <option value="run-cron-job">Déclencher un cron job</option>
              <option value="send-notification">Envoyer une notification</option>
              <option value="container-action">Action sur un conteneur</option>
            </select>
          </div>
          {automationActionKind === "run-cron-job" && (
            <div className="field">
              <label htmlFor="graph-automation-action-cronjob">Cron job</label>
              <select
                id="graph-automation-action-cronjob"
                value={automationActionCronJobId}
                onChange={(e) => setAutomationActionCronJobId(e.target.value)}
                disabled={automationActionBusy}
                required
              >
                <option value="">— sélectionner —</option>
                {cronJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
              {cronJobs.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Aucun cron job connu de QUAI.</span>
              )}
            </div>
          )}
          {automationActionKind === "send-notification" && (
            <>
              <div className="field">
                <label htmlFor="graph-automation-action-channel">Canal de notification</label>
                <select
                  id="graph-automation-action-channel"
                  value={automationActionChannelId}
                  onChange={(e) => setAutomationActionChannelId(e.target.value)}
                  disabled={automationActionBusy}
                  required
                >
                  <option value="">— sélectionner —</option>
                  {notificationChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {notificationChannels.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    Aucun canal de notification connu de QUAI.
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="graph-automation-action-message">Message</label>
                <textarea
                  id="graph-automation-action-message"
                  className="iac-editor"
                  style={{ minHeight: 60 }}
                  value={automationActionMessage}
                  onChange={(e) => setAutomationActionMessage(e.target.value)}
                  placeholder="ex : Le serveur web est injoignable"
                  disabled={automationActionBusy}
                  required
                />
              </div>
            </>
          )}
          {automationActionKind === "container-action" && (
            <>
              <div className="field">
                <label htmlFor="graph-automation-action-container">Conteneur cible</label>
                <select
                  id="graph-automation-action-container"
                  value={automationActionContainerId}
                  onChange={(e) => setAutomationActionContainerId(e.target.value)}
                  disabled={automationActionBusy}
                  required
                >
                  <option value="">— sélectionner —</option>
                  {containers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.image})
                    </option>
                  ))}
                </select>
                {containers.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Aucun conteneur connu de QUAI.</span>
                )}
              </div>
              <div className="field">
                <label htmlFor="graph-automation-action-lifecycle">Action</label>
                <select
                  id="graph-automation-action-lifecycle"
                  value={automationActionLifecycle}
                  onChange={(e) => setAutomationActionLifecycle(e.target.value as "start" | "stop" | "restart")}
                  disabled={automationActionBusy}
                >
                  <option value="start">Démarrer</option>
                  <option value="stop">Arrêter</option>
                  <option value="restart">Redémarrer</option>
                </select>
              </div>
            </>
          )}
          {automationActionError && <p className="graph-popover__error">{automationActionError}</p>}
          <div className="graph-popover__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={automationActionBusy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={automationActionBusy || !automationActionName.trim()}>
              {automationActionBusy ? "…" : "Créer"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (showGithubDeploy) {
    return (
      <Modal open onClose={onClose} labelledBy="graph-github-deploy-title">
        <div className="graph-github-modal">
          <div className="graph-github-modal__head">
            <h3 id="graph-github-deploy-title">
              <IconGithub className="inline-icon" /> Déployer depuis GitHub
            </h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Fermer
            </button>
          </div>
          <div className="graph-github-modal__body">
            <GitHubDeployPage />
          </div>
        </div>
      </Modal>
    );
  }

  async function handleDeployPreset(preset: QuickDeployPreset) {
    setDeployingId(preset.id);
    const name = `${preset.namePrefix}-${shortId()}`;
    const input: CreateContainerInput = {
      image: preset.image,
      name,
      ...(preset.env ? { env: preset.env } : {}),
      ...(preset.volumeMountPath ? { volumes: [`${name}-data:${preset.volumeMountPath}`] } : {}),
    };
    const result = await dispatch(createContainer(input));
    setDeployingId(null);
    if (createContainer.fulfilled.match(result)) {
      // Retour visuel net et gratifiant (voir consigne UX) : jamais un changement d'état silencieux.
      dispatch(pushNotification({ level: "success", message: `${preset.title.replace("Déployer ", "")} déployé — ${name}` }));
      dispatch(fetchTopology());
      onClose();
    } else {
      dispatch(pushNotification({ level: "error", message: result.payload ?? `Échec du déploiement de ${preset.title}.` }));
    }
  }

  // Tout en haut de la liste, façon Railway "Deploy from GitHub repo" — voir JSDoc au-dessus de
  // cette fonction pour le choix inline (modal) vs navigation.
  const githubAction: SpotlightAction = {
    id: "deploy-github",
    title: "Déployer depuis GitHub",
    description: "Détecte Dockerfile/docker-compose/Terraform sur un vrai dépôt, build et déploie réellement.",
    icon: IconGithub,
    onSelect: () => setShowGithubDeploy(true),
  };

  const kindActions: SpotlightAction[] = (["container", "volume", "network"] as CreatableKind[]).map((kind) => ({
    id: `kind-${kind}`,
    title: CREATE_TITLE[kind],
    description:
      kind === "container"
        ? "Lancer n'importe quelle image Docker, avec vos propres réglages."
        : kind === "volume"
          ? "Créer un espace de stockage persistant pour un conteneur."
          : "Créer un réseau privé pour faire communiquer plusieurs conteneurs.",
    icon: KIND_ICON[kind],
    onSelect: () => onPickKind(kind),
  }));

  const presetActions: SpotlightAction[] = QUICK_DEPLOY_PRESETS.map((preset) => ({
    id: preset.id,
    title: preset.title,
    description: preset.description,
    icon: KIND_ICON.container,
    onSelect: () => void handleDeployPreset(preset),
  }));

  // "Nouveau workspace Infra-as-code" (OpenTofu/Ansible/Packer réels, voir services/iac/*) —
  // remplace l'ancienne page dédiée du menu latéral : entièrement pilotable depuis le graphe,
  // même philosophie produit que "Déployer depuis GitHub"/les presets de base de données ci-dessus.
  const iacWorkspaceAction: SpotlightAction = {
    id: "create-iac-workspace",
    title: "Nouveau workspace Infra-as-code",
    description: "OpenTofu, Ansible ou Packer réels, pilotés directement depuis un workspace du graphe.",
    icon: KIND_ICON["iac-workspace"],
    onSelect: () => setShowIacCreate(true),
  };

  // "Nouveau Cron Job"/"Nouvelle sauvegarde" (mission A.4/B.4) — remplacent les anciennes pages
  // dédiées du menu latéral (CronJobsPage.tsx/BackupsPage.tsx, retirées) : entièrement pilotables
  // depuis le graphe, même philosophie produit que "Nouveau workspace Infra-as-code" ci-dessus.
  const cronJobAction: SpotlightAction = {
    id: "create-cron-job",
    title: "Nouveau Cron Job",
    description: "Exécute une commande shell selon une expression cron, via un vrai docker exec dans un conteneur déjà démarré.",
    icon: KIND_ICON["cron-job"],
    onSelect: () => setShowCronJobCreate(true),
  };
  const backupAction: SpotlightAction = {
    id: "create-backup",
    title: "Nouvelle sauvegarde",
    description: "Sauvegarde planifiée d'un volume ou d'une base de données vers un stockage S3-compatible.",
    icon: KIND_ICON.backup,
    onSelect: () => setShowBackupCreate(true),
  };

  // "Nouveau déclencheur"/"Nouvelle condition"/"Nouvelle action" (moteur d'automatisation réel,
  // voir apps/api/src/routes/automation.ts) — remplacent le menu contextuel plat d'origine, même
  // philosophie produit que les entrées ci-dessus.
  const triggerAction: SpotlightAction = {
    id: "create-automation-trigger",
    title: "Nouveau déclencheur",
    description: "Surveille un nœud du graphe ou une route de reverse proxy pour démarrer une chaîne d'automatisation.",
    icon: KIND_ICON["automation-trigger"],
    onSelect: () => setShowTriggerCreate(true),
  };
  const conditionAction: SpotlightAction = {
    id: "create-automation-condition",
    title: "Nouvelle condition",
    description: "Filtre une chaîne d'automatisation selon l'état (échec/sain) de ce qui la précède.",
    icon: KIND_ICON["automation-condition"],
    onSelect: () => setShowConditionCreate(true),
  };
  const automationActionSpotlightAction: SpotlightAction = {
    id: "create-automation-action",
    title: "Nouvelle action",
    description: "Déclenche réellement un cron job, une notification ou une action sur un conteneur.",
    icon: KIND_ICON["automation-action"],
    onSelect: () => setShowActionCreate(true),
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filterActions = (actions: SpotlightAction[]) =>
    normalizedQuery
      ? actions.filter((a) => a.title.toLowerCase().includes(normalizedQuery) || a.description.toLowerCase().includes(normalizedQuery))
      : actions;
  const filteredGithubActions = filterActions([githubAction]);
  const filteredKindActions = filterActions(kindActions);
  const filteredPresetActions = filterActions(presetActions);
  const filteredIacActions = filterActions([iacWorkspaceAction]);
  const filteredCronJobActions = filterActions([cronJobAction]);
  const filteredBackupActions = filterActions([backupAction]);
  const filteredAutomationActions = filterActions([triggerAction, conditionAction, automationActionSpotlightAction]);
  const hasResults =
    filteredGithubActions.length > 0 ||
    filteredKindActions.length > 0 ||
    filteredPresetActions.length > 0 ||
    filteredIacActions.length > 0 ||
    filteredCronJobActions.length > 0 ||
    filteredBackupActions.length > 0 ||
    filteredAutomationActions.length > 0;

  return (
    <div className="graph-popover graph-spotlight" style={style} ref={ref}>
      <div className="graph-spotlight__search">
        <IconSearch className="graph-spotlight__search-icon" />
        <input
          type="text"
          autoFocus
          placeholder="Que voulez-vous créer ?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="graph-spotlight__search-input"
        />
      </div>
      <div className="graph-spotlight__list">
        {!hasResults && <div className="graph-spotlight__empty">Aucun résultat pour « {query} ».</div>}
        {filteredGithubActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredGithubActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredKindActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredKindActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredIacActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredIacActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredCronJobActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredCronJobActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredBackupActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredBackupActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredAutomationActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredAutomationActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
            ))}
          </div>
        )}
        {filteredPresetActions.length > 0 && (
          <div className="graph-spotlight__group">
            <div className="graph-spotlight__group-title">Bases de données en un clic</div>
            {filteredPresetActions.map((action) => (
              <SpotlightRow key={action.id} action={action} busy={deployingId === action.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SpotlightRow({ action, busy }: { action: SpotlightAction; busy?: boolean }) {
  const Icon = action.icon;
  return (
    <button type="button" className="graph-spotlight__row" onClick={action.onSelect} disabled={busy}>
      <span className="graph-spotlight__row-icon">
        <Icon />
      </span>
      <span className="graph-spotlight__row-text">
        <span className="graph-spotlight__row-title">{action.title}</span>
        <span className="graph-spotlight__row-desc">{action.description}</span>
      </span>
      {busy && <span className="graph-spotlight__row-busy">…</span>}
    </button>
  );
}

interface RenamePopoverProps {
  containerId: string;
  initialName: string;
  x: number;
  y: number;
  onClose: () => void;
}

/** Popover de renommage (menu contextuel d'un nœud conteneur) — POST /api/containers/:id/rename. */
function RenamePopover({ containerId, initialName, x, y, onClose }: RenamePopoverProps) {
  const dispatch = useAppDispatch();
  const { ref, style } = useDismiss(onClose, x, y);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await dispatch(renameContainer({ id: containerId, name: trimmed }));
    setBusy(false);
    if (renameContainer.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec du renommage.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">Renommer le conteneur</div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-rename-input">Nouveau nom</label>
          <input
            id="graph-rename-input"
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
            {busy ? "…" : "Renommer"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface GroupLabelPopoverProps {
  title: string;
  initialLabel: string;
  submitLabel: string;
  x: number;
  y: number;
  onSubmit: (label: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

/**
 * Popover de saisie du libellé d'un groupe — réutilisé pour "Regrouper" (label initial suggéré,
 * voir handleCreateGroup) ET pour "Renommer" un groupe existant (label initial = son nom actuel).
 * Même pattern que RenamePopover ci-dessus (un seul champ texte).
 */
function GroupLabelPopover({ title, initialLabel, submitLabel, x, y, onSubmit, onClose }: GroupLabelPopoverProps) {
  const { ref, style } = useDismiss(onClose, x, y);
  const [label, setLabel] = useState(initialLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const result = await onSubmit(trimmed);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? "Échec de l'opération.");
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{title}</div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-group-label-input">Nom du groupe</label>
          <input
            id="graph-group-label-input"
            type="text"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !label.trim()}>
            {busy ? "…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

interface NetworkConnectPopoverProps {
  containerId: string;
  /** Ids Docker bruts (pas "network:<id>") des networks déjà connectés à ce conteneur — retirés du
   * choix, qu'ils soient restés un vrai nœud (partagé/par défaut) ou devenus une brique. */
  excludeNetworkIds: Set<string>;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Popover "Connecter à un network…" (menu contextuel d'un nœud conteneur) — depuis l'introduction
 * des "briques" (voir services/topology.ts § "Briques"), un network attaché à un seul conteneur
 * n'est plus un nœud du graphe : le glisser-connecter historique (container -> network, toujours
 * fonctionnel pour les networks restés de vrais nœuds, partagés/par défaut) n'a alors plus de
 * cible à viser. Cette action, disponible pour TOUT network existant (brique ou nœud), couvre ce
 * cas sans exiger de point de connexion dédié sur chaque brique — POST /api/networks/:id/connect
 * comme le glisser-connecter, résultat strictement identique.
 */
function NetworkConnectPopover({ containerId, excludeNetworkIds, x, y, onClose }: NetworkConnectPopoverProps) {
  const dispatch = useAppDispatch();
  const { ref, style } = useDismiss(onClose, x, y);
  const networks = useAppSelector((s) => s.networks.items);
  const [networkId, setNetworkId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchNetworks());
  }, [dispatch]);

  const options = networks.filter((n) => !excludeNetworkIds.has(n.id));

  useEffect(() => {
    if (!networkId && options.length > 0) setNetworkId(options[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!networkId) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(connectContainerToNetwork({ networkId, containerId }));
    setBusy(false);
    if (connectContainerToNetwork.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de la connexion au network.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">Connecter à un network</div>
      <form onSubmit={handleSubmit}>
        {options.length === 0 ? (
          <p className="graph-popover__error" style={{ color: "var(--color-text-faint)" }}>
            Aucun network disponible à connecter (déjà tous connectés, ou aucun n'existe encore).
          </p>
        ) : (
          <div className="field">
            <label htmlFor="graph-network-connect-select">Network</label>
            <select
              id="graph-network-connect-select"
              value={networkId}
              onChange={(e) => setNetworkId(e.target.value)}
              disabled={busy}
              required
            >
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.driver})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !networkId || options.length === 0}>
            {busy ? "…" : "Connecter"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface TopologyGraphProps {
  height?: number;
  onSelectNode?: (node: TopologyNode | null) => void;
  /** Intervalle de rafraîchissement — 15s par défaut, réduit sur la vue d'ensemble (pièce centrale du dashboard). */
  refreshIntervalMs?: number;
}

export default function TopologyGraph({ height = 460, onSelectNode, refreshIntervalMs = REFRESH_INTERVAL_MS }: TopologyGraphProps) {
  const dispatch = useAppDispatch();
  const { data, status, error, positions } = useAppSelector((s) => s.topology);
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  const confirm = useConfirm();
  const [cleaningOrphans, setCleaningOrphans] = useState(false);

  // Volumes/networks orphelins (voir TopologyNode#orphan, services/topology.ts) — vrais nœuds du
  // graphe, jamais reliés par une arête (0 conteneur ne référence rien à connecter). Recalculé à
  // chaque fetch pour alimenter le bouton flottant "Nettoyer les orphelins" ci-dessous.
  const orphanVolumeNodes = useMemo(() => (data?.nodes ?? []).filter((n) => n.kind === "volume" && n.orphan), [data]);
  const orphanNetworkNodes = useMemo(() => (data?.nodes ?? []).filter((n) => n.kind === "network" && n.orphan), [data]);
  const orphanCount = orphanVolumeNodes.length + orphanNetworkNodes.length;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; id: string; source: string; target: string; kind: string } | null>(
    null,
  );
  const [popover, setPopover] = useState<{ kind: CreatableKind; x: number; y: number } | null>(null);
  const [renamePopover, setRenamePopover] = useState<{ containerId: string; initialName: string; x: number; y: number } | null>(
    null,
  );
  // Menu contextuel d'une "brique" (volume/network monté par un seul conteneur, voir
  // TopologyNode#attachments et GraphNode dans topologyGraphShared.tsx) — clic droit sur une
  // brique plutôt que sur un nœud/une arête, distinct de `nodeMenu`/`edgeMenu` (une brique n'est
  // ni l'un ni l'autre : pas de nœud top-level, pas d'arête, voir services/topology.ts).
  const [attachmentMenu, setAttachmentMenu] = useState<{
    x: number;
    y: number;
    containerNodeId: string;
    attachment: TopologyNodeAttachment;
  } | null>(null);
  // Popover "Connecter à un network…" (menu contextuel d'un conteneur) — voir NetworkConnectPopover
  // ci-dessus : chemin de connexion qui fonctionne même quand le network visé est une brique (donc
  // sans nœud à glisser-déposer dessus).
  const [networkConnectPopover, setNetworkConnectPopover] = useState<{ containerId: string; x: number; y: number } | null>(
    null,
  );
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  // Panneau de détail complet, ancré en overlay sur le canevas (clic droit sur un nœud ou une
  // brique -> "Voir le détail") — voir TopologyNodeDetailPanel.tsx. Distincte de `selectedId`
  // (simple surbrillance visuelle du nœud, conservée) : ce n'est plus l'Inspector latéral (retiré
  // de la Vue d'ensemble) qui affiche quoi que ce soit ici, uniquement ce panneau ouvert à la
  // demande.
  const [detailNode, setDetailNode] = useState<TopologyNode | null>(null);
  // Sous-graphe de dépendances/composition interne (double-clic sur un nœud, ou "Visualiser les
  // dépendances" du menu contextuel) — voir TopologySubGraphPanel.tsx. Ne stocke que l'id racine :
  // le sous-graphe se recalcule depuis `data` (déjà en mémoire), jamais de nouvel appel réseau.
  // Remplace le graphe principal EN PLACE (pas une modal flottante) avec une transition "on rentre
  // dans le nœud" (scale+fade depuis sa position à l'écran) : `subGraphMounted` garde le panneau
  // monté pendant l'animation de sortie (`subGraphVisible -> false`), `handleSubGraphExited` fait
  // le démontage réel une fois cette animation terminée (voir onTransitionEnd du panneau).
  const [subGraphRootId, setSubGraphRootId] = useState<string | null>(null);
  const [subGraphMounted, setSubGraphMounted] = useState(false);
  const [subGraphVisible, setSubGraphVisible] = useState(false);
  const [subGraphOrigin, setSubGraphOrigin] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  // --- Regroupement de nœuds ("encapsulation façon Railway/Logisim", voir TopologyGroup) --------
  // Sélection multiple (Maj+clic sur des nœuds, voir handleNodeClick) — DISTINCTE de `selectedId`
  // ci-dessus (simple surbrillance d'UN nœud pour l'Inspector/le détail) : un clic simple réinitialise
  // toujours cette sélection multiple, elle ne sert QUE pour l'action "Regrouper".
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  // Popover de saisie du libellé — réutilisé pour la création ("Regrouper" sur la sélection
  // courante) ET le renommage d'un groupe existant (voir groupMenuItems ci-dessous).
  const [groupLabelPopover, setGroupLabelPopover] = useState<
    { mode: "create"; nodeIds: string[]; x: number; y: number } | { mode: "rename"; group: TopologyGroup; x: number; y: number } | null
  >(null);
  // Menu contextuel d'un nœud de groupe (replié) ou du cadre d'un groupe déplié — distinct de
  // `nodeMenu` (un groupe n'est pas un TopologyNode réel, voir GroupNodeData/GroupFrameNodeData).
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: TopologyGroup } | null>(null);
  // Bouton "grille" de la barre d'outils (voir <Controls> plus bas) — bascule la MiniMap, seule
  // "vue d'ensemble" que ce graphe propose pour l'instant.
  const [showMiniMap, setShowMiniMap] = useState(true);

  useEffect(() => {
    dispatch(fetchTopology());
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchTopology());
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [dispatch, refreshIntervalMs]);

  // Canevas libre et persistant : positions déplacées à la main, chargées une seule fois depuis
  // le compte de l'utilisateur connecté (GET /api/topology/positions — pas localStorage, la
  // disposition suit l'identité, pas l'appareil) puis tenues à jour par handleNodeDragStop.
  useEffect(() => {
    dispatch(fetchTopologyPositions());
  }, [dispatch]);

  // Recalcule la liste des nœuds à chaque nouveau fetch (toutes les 15s) ou changement de
  // positions sauvegardées — sans écraser la position d'un nœud déjà positionné (à la main ou par
  // un calcul précédent), contrairement à l'ancien recalcul systématique en 3 colonnes fixes.
  useEffect(() => {
    if (!data) {
      setFlowNodes([]);
      return;
    }
    const columnCounters: Record<TopologyNode["kind"], number> = {
      volume: 0,
      container: 0,
      network: 0,
      "nutanix-vm": 0,
      "ad-server": 0,
      host: 0,
      "iac-workspace": 0,
      "cron-job": 0,
      backup: 0,
      "gitops-source": 0,
      "automation-trigger": 0,
      "automation-condition": 0,
      "automation-action": 0,
    };
    // Membres d'un groupe REPLIÉ : n'apparaissent plus comme des nœuds individuels (voir plus bas,
    // un seul nœud "topologyGroupNode" les représente) — un membre d'un groupe DÉPLIÉ continue en
    // revanche d'être rendu ici tel quel (voir topologyGraphShared.tsx en-tête § "Regroupement").
    const collapsedMemberIds = new Set(data.groups.filter((g) => g.collapsed).flatMap((g) => g.nodeIds));
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const nodes: Node[] = data.nodes
        .filter((n) => !collapsedMemberIds.has(n.id))
        .map((n) => {
          const row = columnCounters[n.kind]++;
          const defaultPosition = { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT };
          const prevNode = prevById.get(n.id);
          // Défense en profondeur contre un id de nœud recyclé DANS LA MÊME SESSION : un volume
          // (ou network) supprimé puis recréé sous EXACTEMENT le même nom reprend le même id
          // `volume:<nom>` (Docker n'expose aucun identifiant immuable pour un volume local
          // au-delà de son nom, contrairement à un conteneur/network dont l'id est un hash Docker
          // jamais réattribué — voir TopologyNode#createdAt). Si les deux nœuds portent un
          // horodatage de création et qu'ils diffèrent, ce n'est pas la même ressource : on ignore
          // la position héritée du nœud précédent plutôt que de la lui appliquer à tort. (La
          // position persistée côté serveur, `positions[n.id]`, ne porte pas cet horodatage et
          // reste donc un angle mort résiduel dans le cas plus rare d'une recréation à l'identique
          // entre deux sessions — voir services/topologyPositionsStore.ts.)
          const prevCreatedAt = (prevNode?.data as { createdAt?: string } | undefined)?.createdAt;
          const sameResource = !prevCreatedAt || !n.createdAt || prevCreatedAt === n.createdAt;
          const position = positions[n.id] ?? (sameResource ? prevNode?.position : undefined) ?? defaultPosition;
          // Briques (voir GraphNode, topologyGraphShared.tsx) : callbacks posés UNIQUEMENT sur les
          // nœuds conteneur (seul kind qui en rend), liés par fermeture à CE nœud précis — une
          // brique elle-même ne porte aucun id de nœud top-level, ces callbacks sont son seul moyen
          // d'ouvrir son détail / son menu contextuel.
          const callbacks: GraphNodeCallbacks =
            n.kind === "container"
              ? {
                  onOpenAttachment: (attachment) => handleOpenAttachment(attachment),
                  onAttachmentContextMenu: (event, attachment) => handleAttachmentContextMenu(event, n.id, attachment),
                }
              : {};
          return {
            id: n.id,
            type: "graphNode",
            position,
            data: { ...n, ...callbacks } as unknown as Record<string, unknown>,
          };
        });
      // Un nœud par groupe REPLIÉ (voir collapsedMemberIds ci-dessus) — position : celle déjà
      // sauvegardée par l'utilisateur (comme n'importe quel nœud), sinon celle du groupe au rendu
      // précédent (le collapse/déploiement ne doit pas faire "sauter" la carte), sinon le centre
      // (moyenne) des dernières positions CONNUES de ses membres — jamais une position inventée
      // hors de leur voisinage.
      for (const group of data.groups) {
        if (!group.collapsed) continue;
        const prevGroupNode = prevById.get(group.id);
        const memberPositions = group.nodeIds.map((id) => prevById.get(id)?.position).filter((p): p is { x: number; y: number } => !!p);
        const centroid =
          memberPositions.length > 0
            ? {
                x: memberPositions.reduce((sum, p) => sum + p.x, 0) / memberPositions.length,
                y: memberPositions.reduce((sum, p) => sum + p.y, 0) / memberPositions.length,
              }
            : { x: 0, y: 0 };
        const position = positions[group.id] ?? prevGroupNode?.position ?? centroid;
        const groupData: GroupNodeData = {
          group,
          ports: deriveGroupPorts(group, data.edges),
          onToggleCollapse: () => handleToggleGroupCollapse(group),
        };
        nodes.push({ id: group.id, type: "topologyGroupNode", position, data: groupData as unknown as Record<string, unknown> });
      }
      return nodes;
    });
  }, [data, positions]);

  /**
   * Cadre décoratif (voir topologyGraphShared.tsx#GroupFrameNode) autour des membres d'un groupe
   * DÉPLIÉ — dérivé de `flowNodes` (pas de `data` directement) pour se recalculer en direct pendant
   * un glisser-déposer de membre (handleNodesChange met `flowNodes` à jour à chaque frame de drag,
   * bien avant le prochain rafraîchissement de `data`/positions). Non connectable/non sélectionnable
   * (voir style `nodesDraggable`/`nodesConnectable` posés par kind plus bas sur <ReactFlow>).
   */
  const groupFrameNodes = useMemo<Node[]>(() => {
    if (!data) return [];
    const flowById = new Map(flowNodes.map((n) => [n.id, n]));
    const frames: Node[] = [];
    for (const group of data.groups) {
      if (group.collapsed) continue;
      const memberPositions = group.nodeIds.map((id) => flowById.get(id)?.position).filter((p): p is { x: number; y: number } => !!p);
      if (memberPositions.length === 0) continue;
      const minX = Math.min(...memberPositions.map((p) => p.x));
      const minY = Math.min(...memberPositions.map((p) => p.y));
      const maxX = Math.max(...memberPositions.map((p) => p.x));
      const maxY = Math.max(...memberPositions.map((p) => p.y));
      const frameData: GroupFrameNodeData = { group, onToggleCollapse: () => handleToggleGroupCollapse(group) };
      frames.push({
        id: `group-frame:${group.id}`,
        type: "topologyGroupFrame",
        position: { x: minX - GROUP_FRAME_PADDING, y: minY - GROUP_FRAME_PADDING - GROUP_FRAME_HEADER_HEIGHT },
        style: {
          width: maxX - minX + GROUP_NODE_APPROX_WIDTH + GROUP_FRAME_PADDING * 2,
          height: maxY - minY + GROUP_NODE_APPROX_HEIGHT + GROUP_FRAME_PADDING * 2 + GROUP_FRAME_HEADER_HEIGHT,
        },
        zIndex: -1,
        draggable: false,
        selectable: false,
        connectable: false,
        data: frameData as unknown as Record<string, unknown>,
      });
    }
    return frames;
  }, [data, flowNodes]);

  // Cadres de groupe D'ABORD (zIndex négatif, mais l'ordre dans le tableau compte aussi pour
  // React Flow) puis les nœuds réels/groupes repliés — `selected` reflète soit la surbrillance
  // simple (`selectedId`, un seul nœud) soit la sélection multiple en cours pour "Regrouper"
  // (`multiSelectedIds`, voir handleNodeClick) : les deux réutilisent le même style `.is-selected`.
  const nodes = useMemo(
    () => [...groupFrameNodes, ...flowNodes.map((n) => ({ ...n, selected: n.id === selectedId || multiSelectedIds.has(n.id) }))],
    [groupFrameNodes, flowNodes, selectedId, multiSelectedIds],
  );

  // Recherche O(1) du nœud à chaque bout d'une arête pour en dériver sa couleur (voir
  // edgeContainerNode ci-dessus) — recalculée seulement quand les données de topologie changent.
  const nodesById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  /**
   * Redirige toute arête touchant un membre d'un groupe REPLIÉ vers le nœud du groupe lui-même
   * (voir deriveGroupPorts, topologyGraphShared.tsx) — une arête ENTIÈREMENT interne au groupe
   * (les deux bouts sont membres) est masquée (rien à connecter au monde extérieur). `sourceHandle`/
   * `targetHandle` fixés explicitement au nom de la capacité côté groupe : un groupe peut porter
   * plusieurs handles du même type (ex: "network" ET "provide", tous deux source/Right), React Flow
   * ne peut alors plus deviner tout seul lequel utiliser.
   */
  const groupedTopologyEdges = useMemo<(TopologyEdge & { sourceHandle?: string; targetHandle?: string })[]>(() => {
    if (!data) return [];
    const collapsedGroups = data.groups.filter((g) => g.collapsed);
    if (collapsedGroups.length === 0) return data.edges;
    const groupIdByMember = new Map<string, string>();
    for (const g of collapsedGroups) for (const id of g.nodeIds) groupIdByMember.set(id, g.id);
    const result: (TopologyEdge & { sourceHandle?: string; targetHandle?: string })[] = [];
    for (const e of data.edges) {
      const sourceGroupId = groupIdByMember.get(e.source);
      const targetGroupId = groupIdByMember.get(e.target);
      if (sourceGroupId && targetGroupId && sourceGroupId === targetGroupId) continue; // interne au groupe, masquée
      if (!sourceGroupId && !targetGroupId) {
        result.push(e);
        continue;
      }
      result.push({
        ...e,
        id: `${e.id}__grouped`,
        source: sourceGroupId ?? e.source,
        target: targetGroupId ?? e.target,
        // Capacité du côté groupe = même règle que deriveGroupPorts (mount: target->"volume-mount",
        // source->"provide" ; network: source->"network", target->"attach").
        ...(sourceGroupId ? { sourceHandle: e.kind === "mount" ? "provide" : "network" } : {}),
        ...(targetGroupId ? { targetHandle: e.kind === "mount" ? "volume-mount" : "attach" } : {}),
      });
    }
    return result;
  }, [data]);

  // Construction des arêtes déléguée à buildTopologyEdges (topologyGraphShared.tsx), partagée
  // avec le sous-graphe de dépendances ouvert au double-clic — même couleur/état/animation.
  const edges = useMemo<Edge[]>(
    () => (data ? buildTopologyEdges(groupedTopologyEdges, nodesById) : []),
    [data, groupedTopologyEdges, nodesById],
  );

  function selectNode(id: string | null) {
    setSelectedId(id);
    const topoNode = id ? data?.nodes.find((n) => n.id === id) ?? null : null;
    onSelectNode?.(topoNode);
  }

  /** Applique les changements React Flow (drag en cours, redimensionnement...) à l'état local des
   * nœuds — nécessaire pour que le drag reste fluide, un <ReactFlow> "contrôlé" sans ceci ignore
   * les déplacements en cours de geste. */
  function handleNodesChange(changes: NodeChange[]) {
    setFlowNodes((nds) => applyNodeChanges(changes, nds));
  }

  /** Fin de glissé d'un nœud : persiste sa position finale par id, sur le compte de l'utilisateur
   * connecté (PUT /api/topology/positions) — elle survivra au prochain fetch (15s), à un
   * rechargement de page, et suit désormais l'utilisateur d'un poste à l'autre. */
  function handleNodeDragStop(_event: unknown, node: Node) {
    dispatch(saveTopologyPositions({ ...positions, [node.id]: { x: node.position.x, y: node.position.y } }));
  }

  function findPort(nodeId: string | null | undefined, handleId: string | null | undefined): PortSpec | null {
    if (!nodeId || !handleId) return null;
    const node = data?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    return NODE_CAPABILITIES[node.kind].find((p) => p.id === handleId) ?? null;
  }

  /** Classe une tentative de connexion glissée en comparant les capacités des deux ports visés
   * (table déclarative NODE_CAPABILITIES/CAPABILITY_DEFS ci-dessus) — remplace l'ancienne logique
   * à deux paires de kinds codées en dur, sans changer le comportement fonctionnel : container<->
   * network reste la seule connexion réelle, container<->volume reste un message d'information. */
  function classifyConnection(connection: Edge | Connection): CapabilityDef | null {
    if (!connection.source || !connection.target || connection.source === connection.target) return null;
    const sourcePort = findPort(connection.source, connection.sourceHandle);
    const targetPort = findPort(connection.target, connection.targetHandle);
    if (!sourcePort || !targetPort) return null;
    if (CAPABILITY_DEFS[sourcePort.capability].linksTo !== targetPort.capability) return null;
    return CAPABILITY_DEFS[sourcePort.capability];
  }

  /** true si ce kind est l'un des 3 nœuds du moteur d'automatisation (voir
   * services/automationStore.ts) — jamais connectés via NODE_CAPABILITIES/CAPABILITY_DEFS (ports
   * typés réseau/volume, sans objet ici), toujours via ce chemin dédié. */
  function isAutomationNodeKind(kind: TopologyNode["kind"] | undefined): boolean {
    return kind === "automation-trigger" || kind === "automation-condition" || kind === "automation-action";
  }

  /** Même règle EXACTE que routes/automation.ts#isValidConnection côté serveur (qui reste la
   * validation faisant foi, celle-ci n'est qu'un message d'erreur immédiat côté UI) : trigger ->
   * condition/action, condition -> action, tout le reste refusé (notamment une action, toujours
   * une feuille, ne peut jamais être une source). */
  function isAutomationConnectionAllowed(sourceKind: TopologyNode["kind"], targetKind: TopologyNode["kind"]): boolean {
    if (sourceKind === "automation-trigger") return targetKind === "automation-condition" || targetKind === "automation-action";
    if (sourceKind === "automation-condition") return targetKind === "automation-action";
    return false;
  }

  function isValidConnection(connection: Edge | Connection): boolean {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    const sourceNode = data?.nodes.find((n) => n.id === connection.source);
    const targetNode = data?.nodes.find((n) => n.id === connection.target);
    if (isAutomationNodeKind(sourceNode?.kind) || isAutomationNodeKind(targetNode?.kind)) {
      // Les deux bouts doivent être des nœuds d'automatisation (jamais un mélange avec un nœud
      // Docker/Nutanix classique) — l'ordre précis (trigger->condition/action, condition->action)
      // est vérifié dans handleConnect ci-dessous, avec un message d'erreur clair plutôt qu'un
      // simple refus silencieux du glisser-déposer (voir mission).
      return isAutomationNodeKind(sourceNode?.kind) && isAutomationNodeKind(targetNode?.kind);
    }
    return classifyConnection(connection) !== null;
  }

  function handleConnect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    const sourceNode = data?.nodes.find((n) => n.id === connection.source);
    const targetNode = data?.nodes.find((n) => n.id === connection.target);
    if (isAutomationNodeKind(sourceNode?.kind) || isAutomationNodeKind(targetNode?.kind)) {
      if (!sourceNode || !targetNode) return;
      if (!isAutomationConnectionAllowed(sourceNode.kind, targetNode.kind)) {
        dispatch(
          pushNotification({
            level: "error",
            message: `Connexion invalide : ${sourceNode.kind} → ${targetNode.kind}. Ordre autorisé : déclencheur → condition/action, condition → action.`,
          }),
        );
        return;
      }
      // createAutomationEdge (automationSlice.ts) POST réellement /api/automation/edges avec les
      // ids BRUTS du store (idWithoutPrefix retire le préfixe `${kind}:` posé côté graphe par
      // services/topology.ts#getAutomationNodes) — le backend revalide de toute façon la même règle
      // en dernier recours (routes/automation.ts#isValidConnection).
      dispatch(
        createAutomationEdge({ source: idWithoutPrefix(connection.source), target: idWithoutPrefix(connection.target) }),
      ).then((result) => {
        if (createAutomationEdge.fulfilled.match(result)) dispatch(fetchTopology());
        else dispatch(pushNotification({ level: "error", message: result.payload ?? "Impossible de créer cette connexion." }));
      });
      return;
    }

    const def = classifyConnection(connection);
    if (!def) return;
    if (!def.interactive) {
      if (def.infoMessage) dispatch(pushNotification({ level: "info", message: def.infoMessage }));
      return;
    }
    // Seule capacité interactive à ce jour : container <-> network (docker network connect réel).
    const containerNodeId = sourceNode?.kind === "container" ? connection.source! : connection.target!;
    const networkNodeId = containerNodeId === connection.source ? connection.target! : connection.source!;
    const containerId = idWithoutPrefix(containerNodeId);
    const networkId = idWithoutPrefix(networkNodeId);
    dispatch(connectContainerToNetwork({ networkId, containerId })).then((result) => {
      if (connectContainerToNetwork.fulfilled.match(result)) dispatch(fetchTopology());
    });
  }

  /** Maj+clic accumule/retire de la sélection multiple (voir multiSelectedIds, uniquement pour
   * "Regrouper" — React Flow supporte nativement le multi-select, voir ARCHITECTURE.md mission) ;
   * un clic simple la vide et retombe sur le comportement historique (surbrillance/Inspector). */
  function handleNodeClick(event: React.MouseEvent, node: Node) {
    if (event.shiftKey && operate && !node.id.startsWith("group-frame:")) {
      setMultiSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      return;
    }
    if (multiSelectedIds.size > 0) setMultiSelectedIds(new Set());
    selectNode(node.id === selectedId ? null : node.id);
  }

  function handlePaneClick() {
    selectNode(null);
    if (multiSelectedIds.size > 0) setMultiSelectedIds(new Set());
  }

  function handlePaneContextMenu(event: MouseEvent | React.MouseEvent) {
    event.preventDefault();
    if (!operate) return;
    const mouseEvent = event as MouseEvent;
    setCanvasMenu({ x: mouseEvent.clientX, y: mouseEvent.clientY });
  }

  function handleNodeContextMenu(event: React.MouseEvent, node: Node) {
    event.preventDefault();
    // Un nœud de groupe (replié) ou le cadre d'un groupe déplié n'est PAS un TopologyNode réel
    // (voir GroupNodeData/GroupFrameNodeData, topologyGraphShared.tsx) — menu contextuel dédié.
    if (node.type === "topologyGroupNode" || node.type === "topologyGroupFrame") {
      const group = (node.data as unknown as { group: TopologyGroup }).group;
      setGroupMenu({ x: event.clientX, y: event.clientY, group });
      return;
    }
    const topoNode = node.data as unknown as TopologyNode;
    setNodeMenu({ x: event.clientX, y: event.clientY, node: topoNode });
  }

  function handleEdgeContextMenu(event: React.MouseEvent, edge: Edge) {
    event.preventDefault();
    if (!operate) return;
    const kind = (edge.data as { kind?: string } | undefined)?.kind ?? "mount";
    setEdgeMenu({ x: event.clientX, y: event.clientY, id: edge.id, source: edge.source, target: edge.target, kind });
  }

  async function handleContainerAction(id: string, name: string, action: LifecycleAction) {
    if (action === "stop" || action === "remove") {
      const ok = await confirm({
        title: `${ACTION_LABEL[action]} le conteneur`,
        description:
          action === "remove"
            ? `Confirmer la suppression de "${name}" ? Cette action est irréversible.`
            : `Confirmer l'arrêt de "${name}" ?`,
        confirmLabel: ACTION_LABEL[action],
        variant: "danger",
      });
      if (!ok) return;
    }
    const result = await dispatch(runContainerAction({ id, action }));
    if (runContainerAction.fulfilled.match(result)) dispatch(fetchTopology());
  }

  async function handleRemoveVolume(name: string) {
    const ok = await confirm({
      title: "Supprimer le volume",
      description: `Confirmer la suppression du volume "${name}" ? Les données qu'il contient seront perdues.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeVolume({ name }));
    if (removeVolume.fulfilled.match(result)) dispatch(fetchTopology());
  }

  async function handleRemoveNetwork(id: string, name: string) {
    const ok = await confirm({
      title: "Supprimer le network",
      description: `Confirmer la suppression du network "${name}" ?`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(removeNetwork({ id, name }));
    if (removeNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  /** Bouton flottant "Nettoyer les orphelins" (voir orphanVolumeNodes/orphanNetworkNodes ci-dessus)
   * — supprime EN UNE FOIS tous les volumes/networks à 0 conteneur actuellement affichés comme
   * nœuds atténués sur le graphe. Séquentiel plutôt que Promise.all : chaque suppression Docker
   * réelle, pas besoin de paralléliser une poignée d'appels, et un échec isolé (ressource déjà
   * supprimée entre-temps, verrou Docker...) ne doit pas interrompre les suivants. */
  async function handleCleanOrphans() {
    if (orphanCount === 0) return;
    const ok = await confirm({
      title: "Nettoyer les ressources orphelines",
      description: `Confirmer la suppression de ${orphanVolumeNodes.length} volume(s) et ${orphanNetworkNodes.length} network(s) non utilisés par aucun conteneur ? Les données des volumes seront définitivement perdues. Cette action est irréversible.`,
      confirmLabel: `Nettoyer (${orphanCount})`,
      variant: "danger",
    });
    if (!ok) return;
    setCleaningOrphans(true);
    let failures = 0;
    for (const node of orphanVolumeNodes) {
      const result = await dispatch(removeVolume({ name: idWithoutPrefix(node.id), silent: true }));
      if (!removeVolume.fulfilled.match(result)) failures++;
    }
    for (const node of orphanNetworkNodes) {
      const result = await dispatch(removeNetwork({ id: idWithoutPrefix(node.id), name: node.label, silent: true }));
      if (!removeNetwork.fulfilled.match(result)) failures++;
    }
    setCleaningOrphans(false);
    dispatch(fetchTopology());
    dispatch(
      pushNotification({
        level: failures > 0 ? "error" : "success",
        message:
          failures > 0
            ? `${orphanCount - failures}/${orphanCount} ressource(s) orpheline(s) supprimée(s), ${failures} échec(s) (déjà en cours d'utilisation par un autre processus ?).`
            : `${orphanCount} ressource(s) orpheline(s) supprimée(s).`,
      }),
    );
  }

  async function handleDisconnectEdge(source: string, target: string) {
    const containerId = idWithoutPrefix(source);
    const networkId = idWithoutPrefix(target);
    const ok = await confirm({
      title: "Déconnecter du network",
      description: "Le conteneur sera détaché de ce network.",
      confirmLabel: "Déconnecter",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(disconnectContainerFromNetwork({ networkId, containerId }));
    if (disconnectContainerFromNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  /** Menu contextuel d'une arête "automation-flow" (voir edgeMenu ci-dessus) — DELETE
   * /api/automation/edges/:id réel (automationSlice.ts), id BRUT extrait de l'id préfixé du graphe
   * (`automation-flow:<uuid>`, voir services/topology.ts#getAutomationNodes), même garde
   * `useConfirm` que handleDisconnectEdge ci-dessus. */
  async function handleDisconnectAutomationEdge(edgeId: string) {
    const ok = await confirm({
      title: "Déconnecter",
      description: "Cette connexion d'automatisation sera supprimée.",
      confirmLabel: "Déconnecter",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteAutomationEdge(idWithoutPrefix(edgeId)));
    if (deleteAutomationEdge.fulfilled.match(result)) dispatch(fetchTopology());
  }

  /** "Voir le détail" ouvre TopologyNodeDetailPanel (contenu complet — env/ports/mounts/
   * vulnérabilités réelles selon le kind) ; `selectNode` reste appelé en plus pour la surbrillance
   * visuelle du nœud sur le graphe (déjà utilisée ailleurs via `selected`), les deux ne s'excluent
   * pas. Pour une brique (id synthétique, jamais un nœud top-level réel — voir
   * attachmentToTopologyNode), `selectNode` est un no-op visuel inoffensif : aucun flowNode ne
   * porte cet id, rien ne se met en surbrillance, mais rien ne casse non plus. */
  function openNodeDetail(node: TopologyNode) {
    selectNode(node.id);
    setDetailNode(node);
  }

  /** Clic sur une brique (volume/network monté par un seul conteneur, voir GraphNode) -> ouvre le
   * MÊME panneau de détail qu'un vrai nœud, avec un TopologyNode synthétique reconstruit depuis
   * l'attachment (le panneau va chercher lui-même le détail complet réel via GET /api/volumes ou
   * GET /api/networks, il n'a besoin que de id/kind pour ça). */
  function handleOpenAttachment(attachment: TopologyNodeAttachment) {
    openNodeDetail(attachmentToTopologyNode(attachment));
  }

  function handleAttachmentContextMenu(event: React.MouseEvent, containerNodeId: string, attachment: TopologyNodeAttachment) {
    setAttachmentMenu({ x: event.clientX, y: event.clientY, containerNodeId, attachment });
  }

  function attachmentMenuItems(containerNodeId: string, attachment: TopologyNodeAttachment): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Voir le détail", onClick: () => handleOpenAttachment(attachment) }];
    // Un volume ne peut pas être détaché sans recréer le conteneur (identique à .edgeMenu "mount"
    // ci-dessous) — seule la déconnexion d'un network briqué a un sens réel ici.
    if (operate && attachment.kind === "network") {
      items.push({
        label: "Déconnecter du network",
        danger: true,
        onClick: () => handleDisconnectAttachment(containerNodeId, attachment),
      });
    }
    return items;
  }

  async function handleDisconnectAttachment(containerNodeId: string, attachment: TopologyNodeAttachment) {
    const containerId = idWithoutPrefix(containerNodeId);
    const networkId = idWithoutPrefix(attachment.id);
    const ok = await confirm({
      title: "Déconnecter du network",
      description: `Le conteneur sera détaché du network "${attachment.label}".`,
      confirmLabel: "Déconnecter",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(disconnectContainerFromNetwork({ networkId, containerId }));
    if (disconnectContainerFromNetwork.fulfilled.match(result)) dispatch(fetchTopology());
  }

  /** Ids Docker bruts (pas "network:<id>") de TOUS les networks déjà connectés au conteneur
   * `containerNodeId` — partagés/par défaut (vrais nœuds, via les arêtes) ET briqués (via
   * node.attachments) — pour ne pas les reproposer dans NetworkConnectPopover. Ensemble vide si le
   * nœud n'existe plus (course avec un rafraîchissement entre l'ouverture du menu et son usage). */
  function connectedNetworkIds(containerNodeId: string): Set<string> {
    const ids = new Set<string>();
    const node = data?.nodes.find((n) => n.id === containerNodeId);
    if (!node) return ids;
    for (const a of node.attachments ?? []) if (a.kind === "network") ids.add(idWithoutPrefix(a.id));
    if (data) {
      for (const e of data.edges) {
        if (e.kind !== "network") continue;
        if (e.source === node.id) ids.add(idWithoutPrefix(e.target));
        else if (e.target === node.id) ids.add(idWithoutPrefix(e.source));
      }
    }
    return ids;
  }

  /** Ouvre le panneau de sous-graphe sur `nodeId`, avec une transition "on rentre dans le nœud" —
   * `clientX`/`clientY` (coordonnées écran du double-clic, ou du clic droit d'origine ayant ouvert
   * le menu contextuel) fixent le point de départ du scale+fade (voir TopologySubGraphPanel.tsx).
   * Sous `prefers-reduced-motion`, le panneau apparaît directement visible (pas d'étape
   * intermédiaire à transitionner). */
  function openSubGraph(nodeId: string, clientX: number, clientY: number) {
    const rect = graphContainerRef.current?.getBoundingClientRect();
    setSubGraphOrigin(
      rect && rect.width > 0 && rect.height > 0
        ? { x: ((clientX - rect.left) / rect.width) * 100, y: ((clientY - rect.top) / rect.height) * 100 }
        : { x: 50, y: 50 },
    );
    setSubGraphRootId(nodeId);
    setSubGraphMounted(true);
    if (reducedMotion) {
      setSubGraphVisible(true);
      return;
    }
    // Monté d'abord non visible (scale réduit + transparent), puis basculé à visible une frame
    // plus tard pour que le navigateur ait le temps d'appliquer l'état de départ avant de
    // transitionner vers l'état final — sans ce double rAF, les deux styles seraient posés dans
    // le même frame et la transition CSS ne jouerait pas (aucun changement d'état détecté).
    setSubGraphVisible(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setSubGraphVisible(true)));
  }

  /** L'utilisateur remonte vers le graphe complet — sous `prefers-reduced-motion`, démontage
   * immédiat (pas d'animation à attendre) ; sinon, `TopologySubGraphPanel` joue l'animation de
   * sortie et appelle `handleSubGraphExited` une fois terminée. */
  function closeSubGraph() {
    if (reducedMotion) {
      setSubGraphVisible(false);
      setSubGraphMounted(false);
      setSubGraphRootId(null);
      return;
    }
    setSubGraphVisible(false);
  }

  function handleSubGraphExited() {
    setSubGraphMounted(false);
    setSubGraphRootId(null);
  }

  // --- Regroupement de nœuds ("encapsulation façon Railway/Logisim") ----------------------------

  /** Replie/déplie un groupe — PATCH /api/topology/groups/:id, puis rafraîchit le graphe (même
   * pattern que toute autre mutation de ce composant). Retour visuel immédiat : la carte repliée/le
   * cadre déplié apparaît dès le prochain rendu de `data` (le poll de 15s n'a pas besoin d'attendre,
   * `fetchTopology()` est redéclenché explicitement ici). */
  async function handleToggleGroupCollapse(group: TopologyGroup) {
    const result = await dispatch(updateTopologyGroup({ id: group.id, collapsed: !group.collapsed }));
    if (updateTopologyGroup.fulfilled.match(result)) dispatch(fetchTopology());
    else dispatch(pushNotification({ level: "error", message: result.payload ?? "Échec de la mise à jour du groupe." }));
  }

  /** Ouvre le popover de nom pour la sélection multiple en cours (bouton flottant "Regrouper",
   * voir le rendu plus bas) — jamais moins de 2 nœuds (bouton non affiché sinon). */
  function openCreateGroupPopover(x: number, y: number) {
    if (multiSelectedIds.size < 2) return;
    setGroupLabelPopover({ mode: "create", nodeIds: Array.from(multiSelectedIds), x, y });
  }

  async function submitGroupLabelPopover(label: string): Promise<{ ok: boolean; error?: string }> {
    if (!groupLabelPopover) return { ok: false };
    if (groupLabelPopover.mode === "create") {
      const result = await dispatch(createTopologyGroup({ label, nodeIds: groupLabelPopover.nodeIds }));
      if (createTopologyGroup.fulfilled.match(result)) {
        setMultiSelectedIds(new Set());
        dispatch(pushNotification({ level: "success", message: `Groupe « ${label} » créé (${groupLabelPopover.nodeIds.length} éléments).` }));
        dispatch(fetchTopology());
        return { ok: true };
      }
      return { ok: false, error: result.payload ?? "Échec de la création du groupe." };
    }
    const result = await dispatch(updateTopologyGroup({ id: groupLabelPopover.group.id, label }));
    if (updateTopologyGroup.fulfilled.match(result)) {
      dispatch(fetchTopology());
      return { ok: true };
    }
    return { ok: false, error: result.payload ?? "Échec du renommage du groupe." };
  }

  /** "Dissocier le groupe" — DELETE /api/topology/groups/:id : les membres redeviennent des nœuds
   * autonomes à leur position actuelle (jamais supprimés eux-mêmes), confirmation explicite comme
   * toute action structurante de ce composant. */
  async function handleUngroup(group: TopologyGroup) {
    const ok = await confirm({
      title: "Dissocier le groupe",
      description: `« ${group.label} » sera dissocié — ses ${group.nodeIds.length} éléments redeviennent des nœuds indépendants (rien n'est supprimé).`,
      confirmLabel: "Dissocier",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteTopologyGroup(group.id));
    if (deleteTopologyGroup.fulfilled.match(result)) dispatch(fetchTopology());
    else dispatch(pushNotification({ level: "error", message: result.payload ?? "Échec de la dissociation du groupe." }));
  }

  function groupMenuItems(group: TopologyGroup, x: number, y: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        label: group.collapsed ? "Déplier le groupe" : "Replier le groupe",
        onClick: () => handleToggleGroupCollapse(group),
      },
    ];
    if (!operate) return items;
    items.push({ label: "Renommer le groupe", onClick: () => setGroupLabelPopover({ mode: "rename", group, x, y }) });
    items.push({ label: "Dissocier le groupe", danger: true, onClick: () => handleUngroup(group) });
    return items;
  }

  /** Menu contextuel d'un nœud d'automatisation (voir nodeMenuItems ci-dessous) — DELETE
   * /api/automation/nodes/:id réel (automationSlice.ts), avec confirmation `useConfirm` comme les
   * autres kinds (handleRemoveVolume/handleRemoveNetwork ci-dessus). Supprime aussi côté serveur
   * toute arête qui touchait ce nœud (services/automationStore.ts#deleteAutomationNode) — un
   * rafraîchissement de la topologie suffit donc à refléter l'état complet. */
  async function handleDeleteAutomationNode(node: TopologyNode) {
    const ok = await confirm({
      title: "Supprimer ce nœud d'automatisation",
      description: `Confirmer la suppression de "${node.label}" ? Les connexions qui le touchent seront supprimées avec lui.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteAutomationNode(idWithoutPrefix(node.id)));
    if (deleteAutomationNode.fulfilled.match(result)) dispatch(fetchTopology());
  }

  function nodeMenuItems(node: TopologyNode, x: number, y: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: "Voir le détail", onClick: () => openNodeDetail(node) },
      // Toujours proposé, même pour un nœud isolé (ex : VM Nutanix, jamais reliée à Docker) — le
      // sous-graphe affiche alors simplement le nœud seul avec un message explicite plutôt que de
      // masquer l'entrée du menu selon le kind. Origine de la transition = position du clic droit
      // qui a ouvert CE menu (x, y), pas la position du clic sur l'entrée de menu elle-même.
      { label: "Visualiser les dépendances", onClick: () => openSubGraph(node.id, x, y) },
    ];
    if (!operate) return items;

    if (node.kind === "container") {
      const id = idWithoutPrefix(node.id);
      if (node.status === "running") {
        items.push({ label: "Arrêter", onClick: () => handleContainerAction(id, node.label, "stop") });
      } else {
        items.push({ label: "Démarrer", onClick: () => handleContainerAction(id, node.label, "start") });
      }
      items.push({ label: "Redémarrer", onClick: () => handleContainerAction(id, node.label, "restart") });
      items.push({
        label: "Renommer",
        onClick: () => setRenamePopover({ containerId: id, initialName: node.label, x, y }),
      });
      // Depuis les "briques" (voir GraphNode/services/topology.ts), un network mono-conteneur
      // n'est plus un nœud du graphe à viser au glisser-déposer — cette action couvre ce cas (et
      // reste disponible aussi pour un network resté un vrai nœud, résultat identique).
      items.push({
        label: "Connecter à un network…",
        onClick: () => setNetworkConnectPopover({ containerId: id, x, y }),
      });
      items.push({ label: "Supprimer", danger: true, onClick: () => handleContainerAction(id, node.label, "remove") });
    } else if (node.kind === "volume") {
      const name = idWithoutPrefix(node.id);
      items.push({ label: "Supprimer", danger: true, onClick: () => handleRemoveVolume(name) });
    } else if (node.kind === "network") {
      const id = idWithoutPrefix(node.id);
      if (!["bridge", "host", "none"].includes(node.label)) {
        items.push({ label: "Supprimer", danger: true, onClick: () => handleRemoveNetwork(id, node.label) });
      }
    } else if (node.kind === "automation-trigger" || node.kind === "automation-condition" || node.kind === "automation-action") {
      items.push({ label: "Supprimer", danger: true, onClick: () => void handleDeleteAutomationNode(node) });
    }
    return items;
  }

  if (status === "loading" && !data) {
    return (
      <div className="topology-graph topology-graph--skeleton" style={{ height }}>
        {SKELETON_COLUMN_ROWS.map((rowCount, columnIndex) => (
          <div className="topology-skeleton-column" key={columnIndex}>
            {Array.from({ length: rowCount }).map((_, rowIndex) => (
              <div className="topology-skeleton-node" key={rowIndex}>
                <div className="skeleton-card__row">
                  <Skeleton variant="circle" width={22} height={22} />
                  <Skeleton variant="text" height={12} width="60%" />
                </div>
                <Skeleton variant="text" height={10} width="80%" />
                <Skeleton variant="text" height={8} width="100%" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (error && !data) {
    // Même traitement que .empty-state juste en dessous (largeur/hauteur pleines, centré) —
    // sans ça .error-banner (block, largeur au contenu) se retrouvait étiré sur toute la hauteur
    // du flex du parent .workspace mais étroit, une colonne rouge disgracieuse plutôt qu'un
    // message centré. Trouvé en testant réellement l'échec de GET /api/topology (capture d'écran
    // Playwright), pas une supposition.
    return (
      <div className="empty-state" style={{ height }}>
        <div className="error-banner">{error}</div>
      </div>
    );
  }
  if (data && data.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height }}>
        Aucune ressource à représenter pour l'instant.
      </div>
    );
  }

  return (
    <div className="topology-graph" style={{ height }} ref={graphContainerRef}>
      {/* Graphe principal — s'efface/se dézoome légèrement quand le panneau de sous-graphe est
          monté par-dessus (topology-graph__main--receded, voir topology.css), pour l'effet "on
          rentre dans le nœud" plutôt qu'un calque flottant classique. `pointer-events: none` dans
          cet état évite toute interaction fantôme avec le graphe caché derrière le panneau. */}
      <div className={`topology-graph__main${subGraphMounted ? " topology-graph__main--receded" : ""}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={(event, node) => openSubGraph(node.id, event.clientX, event.clientY)}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeContextMenu={handleEdgeContextMenu}
          onConnect={handleConnect}
          isValidConnection={isValidConnection}
          nodesConnectable={operate}
          // La disposition est persistée par compte (PUT /api/topology/positions, réservé
          // operator/admin comme toute route mutante — voir plugins/auth.ts) : un viewer ne peut
          // donc pas la faire persister, autant ne pas lui laisser croire qu'un glissé "prend".
          nodesDraggable={operate}
          // Sélection multiple (Maj+clic, voir handleNodeClick) native à React Flow — MULTI_SELECTION
          // reste "Shift" quel que soit l'OS, plus prévisible que le défaut (Meta/Control) sur ce
          // canevas où Ctrl/Cmd n'a par ailleurs aucun autre usage.
          multiSelectionKeyCode="Shift"
          deleteKeyCode={null}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
        >
          {/* Barre d'outils du canevas (façon Railway, coin haut-gauche) : zoom +/-, "fit to screen"
              (composant natif React Flow, déjà stylé en thème sombre par .react-flow__controls dans
              topology.css) + un bouton "grille" fait maison pour basculer la MiniMap ci-dessous —
              pas d'undo/redo : un vrai historique d'actions serait un chantier à part entière,
              volontairement non fait dans cette passe plutôt qu'à moitié (voir résumé de livraison). */}
          <Controls showInteractive={false} position="top-left">
            <button
              type="button"
              className="react-flow__controls-button topology-controls__minimap-toggle"
              title={showMiniMap ? "Masquer la vue d'ensemble" : "Afficher la vue d'ensemble"}
              onClick={() => setShowMiniMap((v) => !v)}
            >
              <IconTopology />
            </button>
          </Controls>
          <Background gap={20} size={1.6} color="var(--color-text-faint)" />
          {showMiniMap && (
            <MiniMap
              position="top-left"
              nodeColor={(n) =>
                n.type === "topologyGroupNode" || n.type === "topologyGroupFrame"
                  ? "#e879f9"
                  : MINIMAP_NODE_COLOR[(n.data as unknown as TopologyNode).kind]
              }
              nodeStrokeWidth={0}
              nodeBorderRadius={4}
              maskColor="rgba(11, 12, 16, 0.75)"
              pannable
              zoomable
            />
          )}
        </ReactFlow>
      </div>

      {/* Bouton flottant "Regrouper" (apparaît uniquement sur une sélection multiple d'au moins
          2 nœuds, voir multiSelectedIds/handleNodeClick) — coin haut-droit du canevas. La création
          reste accessible par clic droit sur le canevas (onPaneContextMenu -> handlePaneContextMenu
          -> CreateSpotlight ci-dessous) : pas de bouton "+ Créer" persistant, retiré (gênait la
          lecture du graphe et se chevauchait avec d'autres éléments d'UI sur la page principale). */}
      {operate && multiSelectedIds.size >= 2 && (
        <div className="topology-toolbar-top-right">
          <button
            type="button"
            className="btn btn-primary btn-sm topology-group-action-btn"
            onClick={(event) => openCreateGroupPopover(event.clientX, event.clientY)}
          >
            Regrouper ({multiSelectedIds.size})
          </button>
        </div>
      )}

      {/* Bouton flottant "Nettoyer les orphelins" (voir orphanVolumeNodes/orphanNetworkNodes —
          services/topology.ts § "Volumes/networks ORPHELINS") — coin bas-droit du canevas, visible
          UNIQUEMENT quand il existe au moins une ressource orpheline, plutôt qu'un bouton mort la
          plupart du temps. Style glassmorphisme (fond translucide + flou) distinct des boutons
          pleins "Regrouper"/toolbar : une action de nettoyage volontairement discrète en overlay,
          jamais dans le flux normal des nœuds. */}
      {operate && orphanCount > 0 && (
        <div className="topology-toolbar-bottom-right">
          <button
            type="button"
            className="topology-glass-btn"
            disabled={cleaningOrphans}
            onClick={handleCleanOrphans}
            title="Supprimer tous les volumes/networks non utilisés par aucun conteneur"
          >
            <IconTrash />
            {cleaningOrphans ? "Nettoyage…" : `Nettoyer les orphelins (${orphanCount})`}
          </button>
        </div>
      )}

      {canvasMenu && operate && (
        <CreateSpotlight
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(null)}
          onPickKind={(kind) => {
            setPopover({ kind, x: canvasMenu.x, y: canvasMenu.y });
            setCanvasMenu(null);
          }}
          topologyNodes={data?.nodes ?? []}
        />
      )}

      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={groupMenuItems(groupMenu.group, groupMenu.x, groupMenu.y)}
        />
      )}

      {groupLabelPopover && (
        <GroupLabelPopover
          title={groupLabelPopover.mode === "create" ? "Regrouper la sélection" : "Renommer le groupe"}
          initialLabel={groupLabelPopover.mode === "create" ? `Groupe (${groupLabelPopover.nodeIds.length} éléments)` : groupLabelPopover.group.label}
          submitLabel={groupLabelPopover.mode === "create" ? "Regrouper" : "Renommer"}
          x={groupLabelPopover.x}
          y={groupLabelPopover.y}
          onSubmit={submitGroupLabelPopover}
          onClose={() => setGroupLabelPopover(null)}
        />
      )}

      {nodeMenu && (
        <ContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          onClose={() => setNodeMenu(null)}
          items={nodeMenuItems(nodeMenu.node, nodeMenu.x, nodeMenu.y)}
        />
      )}

      {edgeMenu && (
        <ContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          onClose={() => setEdgeMenu(null)}
          items={
            edgeMenu.kind === "network"
              ? [{ label: "Déconnecter du network", danger: true, onClick: () => handleDisconnectEdge(edgeMenu.source, edgeMenu.target) }]
              : edgeMenu.kind === "automation-flow"
                ? [{ label: "Déconnecter", danger: true, onClick: () => void handleDisconnectAutomationEdge(edgeMenu.id) }]
                : [{ label: "Détachement impossible sans recréer le conteneur", onClick: () => {}, disabled: true }]
          }
        />
      )}

      {attachmentMenu && (
        <ContextMenu
          x={attachmentMenu.x}
          y={attachmentMenu.y}
          onClose={() => setAttachmentMenu(null)}
          items={attachmentMenuItems(attachmentMenu.containerNodeId, attachmentMenu.attachment)}
        />
      )}

      {popover && <CreatePopover kind={popover.kind} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}

      {renamePopover && (
        <RenamePopover
          containerId={renamePopover.containerId}
          initialName={renamePopover.initialName}
          x={renamePopover.x}
          y={renamePopover.y}
          onClose={() => setRenamePopover(null)}
        />
      )}

      {networkConnectPopover && (
        <NetworkConnectPopover
          containerId={networkConnectPopover.containerId}
          excludeNetworkIds={connectedNetworkIds(`container:${networkConnectPopover.containerId}`)}
          x={networkConnectPopover.x}
          y={networkConnectPopover.y}
          onClose={() => setNetworkConnectPopover(null)}
        />
      )}

      {/* Sous-graphe de dépendances/composition interne (double-clic sur un nœud, ou "Visualiser
          les dépendances" du menu contextuel) — remplace le graphe principal EN PLACE (voir
          .topology-graph__main--receded ci-dessus), rendu APRÈS les popovers/menus mais AVANT la
          modal de détail ci-dessous dans le DOM, pour qu'une modal de détail ouverte depuis
          l'intérieur du panneau s'affiche bien par-dessus (même z-index, l'ordre de montage
          tranche). Resté monté pendant l'animation de sortie (`subGraphMounted`), démonté
          seulement une fois celle-ci terminée (`handleSubGraphExited`, voir openSubGraph/
          closeSubGraph ci-dessus). */}
      {subGraphMounted && data && (
        <TopologySubGraphPanel
          topology={data}
          rootId={subGraphRootId}
          visible={subGraphVisible}
          origin={subGraphOrigin}
          reducedMotion={reducedMotion}
          onRequestClose={closeSubGraph}
          onExited={handleSubGraphExited}
          onOpenDetail={openNodeDetail}
        />
      )}

      {/* Panneau de détail complet — ANCRÉ en overlay sur le bord droit du canevas (voir
          TopologyNodeDetailPanel.tsx, même pattern d'ancrage que .topology-subgraph-panel
          ci-dessus), rendu EN DERNIER dans le DOM pour rester au-dessus du sous-graphe quand il
          est ouvert depuis l'intérieur de celui-ci (onOpenDetail). Clic droit sur un nœud ou une
          brique -> "Voir le détail" (voir nodeMenuItems/attachmentMenuItems ci-dessus). */}
      <TopologyNodeDetailPanel
        node={detailNode}
        topology={data ?? null}
        onClose={() => setDetailNode(null)}
        onNavigate={openNodeDetail}
      />
    </div>
  );
}

