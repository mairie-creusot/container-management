import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  SelectionMode,
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
  addContainerEnv,
  clearContainerConvergence,
  createContainer,
  fetchContainers,
  renameContainer,
  runContainerAction,
  type CreateContainerInput,
  type LifecycleAction,
} from "@/features/containers/containersSlice";
import { createVolume, mountVolumeOnContainer, removeVolume } from "@/features/volumes/volumesSlice";
import { fetchSecrets } from "@/features/secrets/secretsSlice";
import {
  connectContainerToNetwork,
  createNetwork,
  disconnectContainerFromNetwork,
  fetchNetworks,
  removeNetwork,
} from "@/features/networks/networksSlice";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
// "Ajouter un environnement…" (menu du canevas, Phase 2 du 17/08/2026) : la VRAIE modale de
// création d'environnement Docker distant (TCP+TLS/SSH, identifiants/IP complets), extraite
// d'EnvironmentsPage.tsx en composant réutilisable — jamais un formulaire simplifié dupliqué ici,
// une seule source de vérité (exigence utilisateur explicite de la maquette validée).
import RemoteEnvironmentCreateModal from "@/features/remoteEnvironments/RemoteEnvironmentCreateModal";
// "Ajouter Nutanix…" (même menu) : Nutanix se configure via la section dédiée de la page
// Environnements (EnvironmentsPage.tsx#NutanixConfigSection, seul flux réel existant — test de
// connexion Prism Central avant persistance) — l'entrée du spotlight NAVIGUE vers cette page
// plutôt que de dupliquer son formulaire ici.
import { setCurrentView } from "@/features/ui/uiSlice";
// Ouverture ciblée de la page Sauvegardes depuis le menu du nœud HYCU (onglet Jobs/Configuration).
import { focusHycuSection } from "@/features/hycu/hycuSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import Modal from "@/components/Modal";
import TopologyNodeDetailPanel, { type TabId } from "@/components/TopologyNodeDetailPanel";
import TopologySubGraphPanel from "@/components/TopologySubGraphPanel";
import { IconGithub, IconInfo, IconKey, IconNetworks, IconSearch, IconServer, IconTopology, IconTrash, IconVolumes } from "@/components/icons";
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
import {
  addNutanixVmDisk,
  addNutanixVmNic,
  clearNutanixVmConvergence,
  fetchNutanixSubnets,
  migrateNutanixVm,
  runNutanixVmAction,
  updateNutanixVmCompute,
  type NutanixVmLifecycleAction,
} from "@/features/nutanix/nutanixSlice";
// Fabrique de templates (assistant de création, build + poll de suivi, déploiement en VM) — voir
// features/templates/* : POST /api/templates réels, 404 = backend pas encore là (état vide explicite).
import { buildTemplate, deleteTemplate, fetchTemplates } from "@/features/templates/templatesSlice";
import { templateBaseLabel } from "@/features/templates/templateCatalog";
import TemplateStudioModal from "@/features/templates/TemplateStudioModal";
import DeployVmModal from "@/features/templates/DeployVmModal";
import TemplateBuildsPopover from "@/features/templates/TemplateBuildsPopover";
import type { IacEngine } from "@/types";
// Registre déclaratif des kinds (voir topologyNodeContract.tsx#NODE_CONTRACT) — ports, actions de
// menu par kind, colonne par défaut : ce composant n'est plus qu'un consommateur générique qui
// injecte les callbacks réels (dispatch/confirm/popovers) par id d'action.
import {
  CAPABILITY_DEFS,
  CONNECTION_ACTIONS,
  NODE_CONTRACT,
  buildNodeMenuItems,
  capabilityPairKey,
  mapNodeContract,
  type ConnectionActionId,
  type NodeMenuActionId,
  type QuickLifecycleAction,
} from "@/components/topologyNodeContract";
import {
  ACTION_LABEL,
  KIND_ICON,
  attachmentToTopologyNode,
  buildTopologyEdges,
  deriveGroupPorts,
  edgeTypes,
  GroupLabelPopover,
  hostHierarchyPositions,
  idWithoutPrefix,
  nodeMinimapColor,
  nodeTypes,
  resolveGroupMemberNodeIds,
  TopologyAlertStack,
  TopologyLegendPanel,
  useDismiss,
  usePrefersReducedMotion,
  type CapabilityDef,
  type CapabilityId,
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

const REFRESH_INTERVAL_MS = 15_000;

// Phrases du loader initial — reflètent les vraies étapes de GET /api/topology, dans l'ordre.
const LOADER_PHRASES = [
  "Interrogation du démon Docker…",
  "Découverte des VMs Nutanix…",
  "Lecture des environnements distants…",
  "Résolution des réseaux et volumes…",
  "Assemblage du graphe…",
];

function TopologyLoader() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPhraseIndex((i) => (i + 1) % LOADER_PHRASES.length), 1800);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="topology-loader__inner" role="status" aria-live="polite">
      <div className="topology-loader__orbit">
        <span className="topology-loader__dot" />
        <span className="topology-loader__dot" />
        <span className="topology-loader__dot" />
      </div>
      <p className="topology-loader__phrase" key={phraseIndex}>
        {LOADER_PHRASES[phraseIndex]}
      </p>
    </div>
  );
}
// Colonnes par défaut PAR KIND — valeurs désormais déclarées dans le contrat
// (NODE_CONTRACT[kind].defaultColumnX, topologyNodeContract.tsx : mêmes abscisses qu'avant la
// migration, le pourquoi de chaque colonne est documenté sur l'entrée du kind), projetées ici en
// table plate. Colonnes "nutanix-vm"/"ad-server"/"host"/"iac-workspace"/"cron-job"/"backup" à
// part, après network — nœuds isolés ou reliés entre eux uniquement (jamais d'arête vers Docker),
// des colonnes dédiées les gardent lisibles plutôt que de les mélanger aux conteneurs.
const COLUMN_X: Record<TopologyNode["kind"], number> = mapNodeContract((c) => c.defaultColumnX);
// 130 -> 200 (Phase 2, 17/08/2026) : les volumes attachés d'un conteneur sont rendus en "tiroirs"
// qui DÉPASSENT sous le bord inférieur de la carte (voir .topology-node__drawers, topology.css) —
// l'ancien pas de 130px aurait fait chevaucher un tiroir sur la carte du dessous dans les positions
// PAR DÉFAUT (uniquement elles : toute position déplacée à la main/sauvegardée reste souveraine).
// 200 -> 260 (18/08/2026) : même élargissement ~30% que l'arbre "host" (AUTO_LAYOUT_*, retour
// utilisateur "un padding entre les node un peut plus important") — une carte riche + tiroirs
// approche 300px, 200px restait juste.
const ROW_HEIGHT = 260;

/**
 * Ancre horizontale de l'arbre "host" auto-disposé (hostHierarchyPositions) — le master "QUAI" est
 * désormais la racine unique de cet arbre, placé à GAUCHE de toutes les colonnes fixes (maquette
 * validée : master -> environnements -> hiérarchie), assez loin pour que le niveau le plus profond
 * (VMs en grille repliée) ne chevauche jamais la colonne des volumes (x = 0). Reculée de -2300 à
 * -3000 le 18/08/2026 avec l'élargissement des espacements (AUTO_LAYOUT_LEVEL_SPACING 300 -> 380,
 * HOST_TREE_GRID_LINE_SPACING 270 -> 340) : au pire réel (profondeur 3 + grille de ~29 VMs sur 5
 * colonnes), le bord droit reste à x < -200.
 */
const HOST_TREE_ANCHOR_X = -3000;
const NETWORK_DRIVERS = ["bridge", "overlay", "host", "none"];

/** Garde-fou : un arrêt ACPI ignoré par l'OS invité ne doit pas laisser une carte "pending" à vie. */
const CONVERGENCE_TIMEOUT_MS = 5 * 60_000;
function convergenceStillPending(entry: { expected: "running" | "stopped"; since: number } | undefined, status: string): boolean {
  return entry !== undefined && status !== entry.expected && Date.now() - entry.since < CONVERGENCE_TIMEOUT_MS;
}

// Fil rendu nativement par React Flow pendant le drag — pointillé accent (maquette validée).
const CONNECTION_LINE_STYLE: CSSProperties = { stroke: "var(--accent-end)", strokeWidth: 1.5, strokeDasharray: "6 4" };

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

// --- Groupes imbriqués (13/08/2026, voir apps/api/src/types.ts#TopologyGroup#nodeIds) -----------
// Un vrai nœud OU un sous-groupe n'a jamais plus d'un parent à la fois (voir
// topologyGroupsStore.ts#createGroup, DuplicateGroupMemberError) : ces trois fonctions pures,
// partagées par la construction de `flowNodes`/`groupFrameNodes`/`groupedTopologyEdges` ci-dessous,
// s'appuient toutes sur cette même table "membre -> son groupe parent direct".

/** Table "membre (vrai nœud OU sous-groupe) -> son groupe parent direct". */
function buildParentGroupByMemberId(groups: TopologyGroup[]): Map<string, TopologyGroup> {
  const map = new Map<string, TopologyGroup>();
  for (const g of groups) for (const id of g.nodeIds) map.set(id, g);
  return map;
}

/**
 * `id` (vrai nœud OU sous-groupe) est-il masqué du niveau racine du canevas ? Oui dès que son
 * parent direct est REPLIÉ — un parent replié masque TOUT ce qu'il contient, y compris un
 * sous-groupe lui-même DÉPLIÉ (retour utilisateur du 13/08/2026). Si le parent est déplié, `id`
 * reste visible SEULEMENT si ce parent est lui-même visible (récursion vers le haut de la chaîne) —
 * c'est le cas inverse : un sous-groupe replié dont le PARENT est déplié ne masque, lui, que ses
 * propres membres (remplacés par sa propre carte repliée, visible dans le cadre du parent).
 * `guard` protège contre un cycle corrompu déjà visité (jamais censé arriver, la création refuse
 * déjà tout cycle côté API — voir topologyGroupsStore.ts#CyclicGroupError).
 */
function isHiddenAtRoot(id: string, parentGroupByMemberId: Map<string, TopologyGroup>, guard: Set<string> = new Set()): boolean {
  const parent = parentGroupByMemberId.get(id);
  if (!parent || guard.has(parent.id)) return false;
  if (parent.collapsed) return true;
  return isHiddenAtRoot(parent.id, parentGroupByMemberId, new Set(guard).add(parent.id));
}

/**
 * Remonte récursivement la chaîne de parents de `id` (extrémité RÉELLE d'une TopologyEdge) jusqu'à
 * la carte réellement VISIBLE qui le représente — ex : membre d'un groupe A lui-même membre d'un
 * groupe B replié -> retourne B, jamais A (une arête touchant ce membre doit se rediriger vers B,
 * seule carte affichée). Retourne `id` inchangé si aucun ancêtre replié ne le masque.
 *
 * Bug réel corrigé le 13/08/2026 : un parent DIRECT déplié (frame, pas de carte de substitution) ne
 * suffit pas à conclure que `id` reste visible tel quel — si CE parent déplié est lui-même masqué
 * par un ANCÊTRE plus extérieur replié (cas : sous-groupe A déplié pour consultation via le
 * sous-graphe, mais A reste membre d'un groupe B replié au niveau racine), `id` est quand même
 * absent de `flowNodes` (voir isHiddenAtRoot/collapsedMemberIds ci-dessous) et l'arête doit se
 * rediriger vers B, pas rester accrochée à `id` (qui produirait une arête fantôme, sans nœud
 * React Flow correspondant). On ne s'arrête donc plus au premier lien déplié : on continue de
 * remonter tant qu'un parent existe, et on ne redirige vers une carte repliée que si celle-ci est
 * elle-même réellement visible (isHiddenAtRoot(parent) === false) — sinon on continue au-delà.
 */
function resolveVisibleGroupTarget(id: string, parentGroupByMemberId: Map<string, TopologyGroup>, guard: Set<string> = new Set()): string {
  const parent = parentGroupByMemberId.get(id);
  if (!parent || guard.has(parent.id)) return id;
  const nextGuard = new Set(guard).add(parent.id);
  if (parent.collapsed && !isHiddenAtRoot(parent.id, parentGroupByMemberId, nextGuard)) return parent.id;
  return resolveVisibleGroupTarget(parent.id, parentGroupByMemberId, nextGuard);
}

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
  /** Image pré-remplie (kind "container" uniquement) — ex : "Créer un conteneur" depuis l'artifact
   * docker-image d'un nœud template. */
  initialImage?: string;
}

const CREATE_TITLE: Record<CreatableKind, string> = {
  container: "Nouveau conteneur",
  volume: "Nouveau volume",
  network: "Nouveau network",
};

/** Popover de création rapide (clic droit sur le canevas) — réutilise les mêmes thunks Redux
 * que ContainersPage/VolumesPage/NetworksPage, en version minimale positionnée près du clic. */
function CreatePopover({ kind, x, y, onClose, initialImage }: CreatePopoverProps) {
  const dispatch = useAppDispatch();
  const { ref, style } = useDismiss(onClose, x, y);
  const [image, setImage] = useState(initialImage ?? "");
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
            {/* Limite RÉELLE vérifiée le 17/08/2026 (Phase 2) : POST /api/containers ne supporte
                AUCUN environnement cible (routes/containers.ts#CreateContainerBody sans
                targetEnvironmentId, services/docker.ts#createAndStartContainer -> getClient()
                local) — seul le déploiement GitHub sait cibler un environnement distant
                (POST /api/github/.../deploy#targetEnvironmentId). Mention explicite plutôt qu'un
                sélecteur d'environnement inventé qui ne serait branché sur rien. */}
            <p className="create-container-hint">
              Créé sur le démon Docker local. La création directe sur un environnement distant n'est pas encore
              supportée par l'API — seul « Déployer depuis GitHub » sait cibler un environnement distant.
            </p>
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
  /** Entrée visible mais NON cliquable (ex : "Ajouter Proxmox / VMware" — aucune intégration
   * réelle n'existe, voir infrastructureActions) — même rendu grisé que `busy`, sans le "…". */
  disabled?: boolean;
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
  // "Ajouter un environnement…"/"Ajouter Nutanix…" (Phase 2, 17/08/2026) — la création d'un
  // environnement Docker distant et la configuration Nutanix sont réservées admin (mêmes gardes
  // que la page Environnements : bouton "Nouvel environnement"/formulaire Nutanix masqués pour un
  // non-admin, l'API refuse de toute façon) : entrées masquées ici pour un operator plutôt que
  // proposées puis refusées au clic.
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  // "Ajouter un environnement Docker distant…" : monte la VRAIE modale extraite
  // (RemoteEnvironmentCreateModal.tsx) — même bascule interne que showGithubDeploy ci-dessus.
  const [showRemoteEnvCreate, setShowRemoteEnvCreate] = useState(false);
  // "Créer un template" (fabrique de templates) : modale portée document.body, même bascule/garde
  // useDismiss que showGithubDeploy/showRemoteEnvCreate ci-dessus.
  const [showTemplateCreate, setShowTemplateCreate] = useState(false);
  // useDismiss ferme sur clic hors de `ref`/Échap — mais une fois la modal GitHub (ou celle de
  // création d'environnement) ouverte, son contenu vit dans un portail document.body (Modal.tsx),
  // donc HORS de `ref` : sans ce garde-fou, le premier clic à l'intérieur de la modal (un repo, un
  // champ...) la refermerait aussitôt. Modal.tsx gère alors seule Échap/clic-extérieur pour son
  // propre contenu.
  const { ref, style } = useDismiss(() => {
    if (!showGithubDeploy && !showRemoteEnvCreate && !showTemplateCreate) onClose();
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

  // La VRAIE modale de création d'environnement Docker distant (TCP+TLS/SSH, identifiants/IP
  // complets — RemoteEnvironmentCreateModal.tsx, extraite d'EnvironmentsPage.tsx, une seule source
  // de vérité) : montée par-dessus le canevas, exactement comme la modal GitHub ci-dessous.
  if (showRemoteEnvCreate) {
    return <RemoteEnvironmentCreateModal open onClose={onClose} />;
  }

  // Studio de templates (fabrique de templates) — même montage par-dessus le canevas.
  if (showTemplateCreate) {
    return <TemplateStudioModal onClose={onClose} />;
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

  // Studio de templates : presets ou recette vierge, base libre (cloud-image/conteneur/mkosi),
  // étapes ordonnées — POST /api/templates réel, 404 backend géré par un état vide explicite.
  const templateAction: SpotlightAction = {
    id: "create-image-template",
    title: "Créer un template d'image",
    description: "Studio de recettes : n'importe quelle distro, étapes libres (paquets, scripts, artefacts…), build suivi jusqu'au bout.",
    icon: KIND_ICON["image-template"],
    onSelect: () => setShowTemplateCreate(true),
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

  // --- "Infrastructure" (Phase 2, 17/08/2026 — "tout ce qu'il y a en graphique dans le menu doit
  // être possible dans le graphe") : rattacher un NOUVEL HÉBERGEUR depuis le canevas. ------------
  // "Ajouter un environnement Docker distant…" ouvre la VRAIE modale (identifiants/IP complets,
  // TCP+TLS/SSH — RemoteEnvironmentCreateModal.tsx, extraite d'EnvironmentsPage.tsx, jamais un
  // formulaire simplifié : exigence utilisateur explicite de la maquette validée). "Ajouter
  // Nutanix…" NAVIGUE vers le seul flux réel existant (section Nutanix de la page Environnements —
  // test de connexion Prism Central avant persistance) plutôt que d'en dupliquer le formulaire.
  // Les deux réservées admin (voir `admin` ci-dessus). Proxmox/VMware : AUCUNE infrastructure
  // réelle de ce type chez l'utilisateur et AUCUNE intégration côté API — entrée volontairement
  // DÉSACTIVÉE "bientôt" (jamais une fausse intégration), visible par tous les rôles.
  const infrastructureActions: SpotlightAction[] = [
    ...(admin
      ? [
          {
            id: "add-remote-environment",
            title: "Ajouter un environnement Docker distant…",
            description: "Démon Docker distant via TCP+TLS ou tunnel SSH — connexion réellement testée avant enregistrement.",
            icon: KIND_ICON.host,
            onSelect: () => setShowRemoteEnvCreate(true),
          },
          {
            id: "configure-nutanix",
            title: "Ajouter Nutanix (Prism Central)…",
            description: "Ouvre la page Environnements — configuration réelle de Prism Central (URL, identifiants).",
            icon: KIND_ICON["nutanix-vm"],
            onSelect: () => {
              dispatch(setCurrentView("clusters"));
              onClose();
            },
          },
        ]
      : []),
    {
      id: "add-proxmox-vmware",
      title: "Ajouter Proxmox / VMware",
      description: "Bientôt — aucune intégration réelle n'existe encore pour ces hyperviseurs.",
      icon: KIND_ICON.host,
      onSelect: () => {},
      disabled: true,
    },
  ];

  const normalizedQuery = query.trim().toLowerCase();
  const filterActions = (actions: SpotlightAction[]) =>
    normalizedQuery
      ? actions.filter((a) => a.title.toLowerCase().includes(normalizedQuery) || a.description.toLowerCase().includes(normalizedQuery))
      : actions;
  const filteredGithubActions = filterActions([githubAction]);
  const filteredKindActions = filterActions(kindActions);
  const filteredPresetActions = filterActions(presetActions);
  const filteredIacActions = filterActions([iacWorkspaceAction]);
  const filteredTemplateActions = filterActions([templateAction]);
  const filteredCronJobActions = filterActions([cronJobAction]);
  const filteredBackupActions = filterActions([backupAction]);
  const filteredAutomationActions = filterActions([triggerAction, conditionAction, automationActionSpotlightAction]);
  const filteredInfrastructureActions = filterActions(infrastructureActions);
  const hasResults =
    filteredGithubActions.length > 0 ||
    filteredKindActions.length > 0 ||
    filteredPresetActions.length > 0 ||
    filteredIacActions.length > 0 ||
    filteredTemplateActions.length > 0 ||
    filteredCronJobActions.length > 0 ||
    filteredBackupActions.length > 0 ||
    filteredAutomationActions.length > 0 ||
    filteredInfrastructureActions.length > 0;

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
        {filteredTemplateActions.length > 0 && (
          <div className="graph-spotlight__group">
            {filteredTemplateActions.map((action) => (
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
        {filteredInfrastructureActions.length > 0 && (
          <div className="graph-spotlight__group">
            <div className="graph-spotlight__group-title">Infrastructure</div>
            {filteredInfrastructureActions.map((action) => (
              <SpotlightRow key={action.id} action={action} />
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
    <button type="button" className="graph-spotlight__row" onClick={action.onSelect} disabled={busy || action.disabled}>
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

interface NetworkConnectPopoverProps {
  containerId: string;
  /** Ids Docker bruts (pas "network:<id>") des networks déjà connectés à ce conteneur — retirés du
   * choix, qu'ils soient restés un vrai nœud (partagé/par défaut) ou devenus une brique. */
  excludeNetworkIds: Set<string>;
  /** Network présélectionné (id Docker brut) — câblage au fil (vague 3), le fil vise déjà un network précis. */
  initialNetworkId?: string;
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
function NetworkConnectPopover({ containerId, excludeNetworkIds, initialNetworkId, x, y, onClose }: NetworkConnectPopoverProps) {
  const dispatch = useAppDispatch();
  const { ref, style } = useDismiss(onClose, x, y);
  const networks = useAppSelector((s) => s.networks.items);
  const [networkId, setNetworkId] = useState(initialNetworkId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchNetworks());
  }, [dispatch]);

  const options = networks.filter((n) => !excludeNetworkIds.has(n.id));

  useEffect(() => {
    // Présélection absente des options (ex : déjà connecté entre-temps) : repli sur la première.
    if ((!networkId || !options.some((n) => n.id === networkId)) && options.length > 0) setNetworkId(options[0]!.id);
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

/** Cible du popover de montage : volume existant (choisir le conteneur — menu du nœud volume, ou
 * conteneur présélectionné par un fil volume -> conteneur) ou conteneur fixé (créer un volume neuf
 * puis le monter — bouton ＋ / "Attacher"). */
type MountPopoverTarget =
  | { kind: "existing-volume"; volumeName: string; initialContainerNodeId?: string }
  | { kind: "new-volume"; containerNode: TopologyNode };

interface MountVolumePopoverProps {
  target: MountPopoverTarget;
  topologyNodes: TopologyNode[];
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Popover de montage d'un volume par RECRÉATION réelle du conteneur (POST /api/containers/:id/
 * mounts) — source unique pour les deux flux (menu du volume ET bouton ＋ d'un conteneur) :
 * avertissement permanent + confirmation danger avant tout appel.
 */
function MountVolumePopover({ target, topologyNodes, x, y, onClose }: MountVolumePopoverProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const { ref, style } = useDismiss(onClose, x, y);
  const containers = topologyNodes.filter((n) => n.kind === "container");
  const fixedContainer = target.kind === "new-volume" ? target.containerNode : null;
  const [containerNodeId, setContainerNodeId] = useState(
    fixedContainer?.id ?? (target.kind === "existing-volume" ? target.initialContainerNodeId : undefined) ?? containers[0]?.id ?? "",
  );
  const [newVolumeName, setNewVolumeName] = useState(() =>
    target.kind === "new-volume" ? `${target.containerNode.label}-data-${shortId()}` : "",
  );
  const [mountPath, setMountPath] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedContainer = fixedContainer ?? containers.find((c) => c.id === containerNodeId) ?? null;
  const volumeName = target.kind === "existing-volume" ? target.volumeName : newVolumeName.trim();
  const trimmedPath = mountPath.trim();
  // Mêmes règles que la validation serveur (retour immédiat, le serveur revalide de toute façon).
  const pathValid = trimmedPath.startsWith("/") && !trimmedPath.includes(":");
  const volumeNameValid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volumeName);
  const canSubmit = !!selectedContainer && trimmedPath.length > 0 && pathValid && volumeNameValid;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selectedContainer || !canSubmit) return;
    const ok = await confirm({
      title: "Recréer le conteneur pour monter ce volume",
      description: `Monter "${volumeName}" sur "${selectedContainer.label}" (${trimmedPath}) nécessite de RECRÉER ce conteneur : il sera arrêté puis recréé avec sa configuration actuelle plus ce montage (son id Docker change), et brièvement indisponible s'il est en cours d'exécution.`,
      confirmLabel: "Recréer et monter",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    if (target.kind === "new-volume") {
      const createResult = await dispatch(createVolume(volumeName));
      if (!createVolume.fulfilled.match(createResult)) {
        setBusy(false);
        setError(createResult.payload ?? "Échec de la création du volume.");
        return;
      }
    }
    const result = await dispatch(
      mountVolumeOnContainer({
        volumeName,
        containerId: idWithoutPrefix(selectedContainer.id),
        containerName: selectedContainer.label,
        mountPath: trimmedPath,
        readOnly,
      }),
    );
    setBusy(false);
    if (mountVolumeOnContainer.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      // Volume créé mais montage échoué : suppression best-effort pour ne pas laisser un orphelin.
      if (target.kind === "new-volume") void dispatch(removeVolume({ name: volumeName, silent: true }));
      setError(result.payload ?? "Échec du montage du volume.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">
        {target.kind === "existing-volume"
          ? `Monter « ${target.volumeName} » sur un conteneur`
          : `Nouveau stockage pour « ${target.containerNode.label} »`}
      </div>
      <form onSubmit={handleSubmit}>
        {target.kind === "existing-volume" && containers.length === 0 ? (
          <p className="graph-popover__error" style={{ color: "var(--color-text-faint)" }}>
            Aucun conteneur connu de QUAI sur lequel monter ce volume.
          </p>
        ) : (
          <>
            {target.kind === "existing-volume" && (
              <div className="field">
                <label htmlFor="graph-mount-container">Conteneur cible</label>
                <select
                  id="graph-mount-container"
                  value={containerNodeId}
                  onChange={(e) => setContainerNodeId(e.target.value)}
                  disabled={busy}
                  required
                >
                  {containers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({c.subtitle})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {target.kind === "new-volume" && (
              <div className="field">
                <label htmlFor="graph-mount-volume-name">Nom du volume (créé puis monté)</label>
                <input
                  id="graph-mount-volume-name"
                  type="text"
                  value={newVolumeName}
                  onChange={(e) => setNewVolumeName(e.target.value)}
                  disabled={busy}
                  required
                />
                {volumeName.length > 0 && !volumeNameValid && (
                  <span style={{ fontSize: 12, color: "var(--color-critical)" }}>
                    Nom de volume invalide (lettres/chiffres puis lettres, chiffres, « _ . - »).
                  </span>
                )}
              </div>
            )}
            <div className="field">
              <label htmlFor="graph-mount-path">Chemin de montage (dans le conteneur)</label>
              <input
                id="graph-mount-path"
                type="text"
                autoFocus={target.kind === "existing-volume"}
                placeholder="ex : /data"
                value={mountPath}
                onChange={(e) => setMountPath(e.target.value)}
                disabled={busy}
                required
              />
              {trimmedPath.length > 0 && !pathValid && (
                <span style={{ fontSize: 12, color: "var(--color-critical)" }}>
                  Chemin absolu requis (commence par « / », sans « : »).
                </span>
              )}
            </div>
            <label className="filter-toggle">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} disabled={busy} />
              Lecture seule (ro)
            </label>
            <p className="create-container-hint">
              Nécessite la recréation du conteneur : Docker ne permet pas d'ajouter un montage à un conteneur
              existant. Le conteneur sera arrêté puis recréé avec sa configuration actuelle plus ce montage
              (réseaux, ports, variables et montages existants conservés — son id Docker change).
            </p>
          </>
        )}

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canSubmit}>
            {busy ? "Recréation…" : target.kind === "new-volume" ? "Créer et monter" : "Monter"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface AttachEnvPopoverProps {
  containerNode: TopologyNode;
  x: number;
  y: number;
  onClose: () => void;
}

/** Popover "Variable d'environnement" du picker ＋ — NOM + secret de la plateforme (la page Secrets
 * est LA source des variables, valeur résolue côté serveur, jamais saisie en clair ici). POST
 * /api/containers/:id/env, recréation réelle du conteneur (avertissement + confirmation danger). */
function AttachEnvPopover({ containerNode, x, y, onClose }: AttachEnvPopoverProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const { ref, style } = useDismiss(onClose, x, y);
  const secrets = useAppSelector((s) => s.secrets.items);
  const [envName, setEnvName] = useState("");
  const [secretId, setSecretId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchSecrets());
  }, [dispatch]);

  useEffect(() => {
    if (!secretId && secrets.length > 0) setSecretId(secrets[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secrets.length]);

  const trimmedName = envName.trim();
  // Même règle que la route (ENV_NAME_PATTERN côté API).
  const nameValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedName);
  const canSubmit = nameValid && !!secretId;
  const selectedSecret = secrets.find((s) => s.id === secretId) ?? null;

  // Navigue vers la vraie page Secrets (création/gestion) — ferme le popover en partant.
  function goToSecrets() {
    dispatch(setCurrentView("secrets"));
    onClose();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const ok = await confirm({
      title: "Recréer le conteneur pour ajouter la variable",
      description: `Ajouter la variable ${trimmedName} à "${containerNode.label}" nécessite de RECRÉER ce conteneur : il sera arrêté puis recréé avec sa configuration actuelle plus cette variable (son id Docker change), et brièvement indisponible s'il est en cours d'exécution.`,
      confirmLabel: "Recréer et ajouter",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(
      addContainerEnv({
        containerId: idWithoutPrefix(containerNode.id),
        containerName: containerNode.label,
        secretEnv: [{ envName: trimmedName, secretId }],
      }),
    );
    setBusy(false);
    if (addContainerEnv.fulfilled.match(result)) {
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de l'ajout de la variable.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{`Variable d'environnement pour « ${containerNode.label} »`}</div>
      <p className="graph-popover__desc">
        La valeur vient du gestionnaire de secrets — résolue côté serveur, jamais retapée ici.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-env-name">Nom de la variable</label>
          <input
            id="graph-env-name"
            type="text"
            autoFocus
            className="cell-mono"
            placeholder="ex : DATABASE_URL"
            value={envName}
            onChange={(e) => setEnvName(e.target.value)}
            disabled={busy}
            required
          />
          {trimmedName.length > 0 && !nameValid && (
            <span style={{ fontSize: 12, color: "var(--color-critical)" }}>
              Nom invalide (lettres, chiffres, « _ », ne commence pas par un chiffre).
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="graph-env-secret">Secret</label>
          <select id="graph-env-secret" value={secretId} onChange={(e) => setSecretId(e.target.value)} disabled={busy} required>
            {secrets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {secrets.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              Aucun secret dans le gestionnaire — créez-en un d'abord depuis la page Secrets.
            </span>
          )}
          {selectedSecret?.description && (
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{selectedSecret.description}</span>
          )}
          <button type="button" className="graph-popover__nav-link" onClick={goToSecrets} disabled={busy}>
            <IconKey /> {secrets.length === 0 ? "Créer un secret — ouvrir la page Secrets" : "Gérer les secrets"}
          </button>
        </div>
        <p className="create-container-hint">
          Nécessite la recréation du conteneur : Docker ne permet pas de modifier l'environnement d'un conteneur
          existant. Le conteneur sera arrêté puis recréé avec sa configuration actuelle plus cette variable
          (réseaux, ports, variables et montages existants conservés — son id Docker change). La valeur du
          secret est résolue côté serveur et devient une variable d'environnement Docker ordinaire : elle sera
          visible dans l'inspect Docker du conteneur sur l'hôte (QUAI la masque dans son propre panneau de
          détail).
        </p>

        {error && <p className="graph-popover__error">{error}</p>}

        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canSubmit}>
            {busy ? "Recréation…" : "Recréer et ajouter"}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Popovers "configuration matérielle" d'une VM Nutanix (18/08/2026) — mêmes entrées que le
// menu "Update VM" de Prism (captures de référence) : Add New Disk / Add New NIC / Compute.
// Mêmes patterns que MountVolumePopover/AttachEnvPopover ci-dessus (useDismiss + confirmation
// explicite variant danger AVANT tout appel réel — ces actions modifient une VRAIE VM de
// production de la mairie, jamais déclenchées par le seul clic de soumission). Backend :
// POST /api/nutanix/vms/:uuid/{disks,nics}, PATCH .../compute (services/nutanix.ts).

interface NutanixVmPopoverProps {
  vmNode: TopologyNode;
  x: number;
  y: number;
  onClose: () => void;
}

/** "Ajouter un disque" — taille en Gio (bornes QUAI 1 Gio – 2 Tio, revalidées serveur). Type/bus
 * fixes (DISK/SCSI, seule forme d'ajout supportée ici) et storage container recopié du disque
 * existant de la VM côté serveur — affichés comme informations, jamais des choix fictifs. */
function NutanixAddDiskPopover({ vmNode, x, y, onClose }: NutanixVmPopoverProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const { ref, style } = useDismiss(onClose, x, y);
  const [sizeGib, setSizeGib] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(sizeGib);
  const sizeValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 2048;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!sizeValid) return;
    const ok = await confirm({
      title: "Ajouter un disque à la VM",
      description: `Ajouter un disque SCSI de ${parsed} Gio à "${vmNode.label}" ? Cette action modifie réellement la VM sur Prism Central.`,
      confirmLabel: "Ajouter le disque",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(addNutanixVmDisk({ uuid: idWithoutPrefix(vmNode.id), sizeMib: parsed * 1024 }));
    setBusy(false);
    if (addNutanixVmDisk.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "success", message: `Disque de ${parsed} Gio ajouté à "${result.payload.vmName}".` }));
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de l'ajout du disque.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{`Nouveau disque pour « ${vmNode.label} »`}</div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-nutanix-disk-size">Taille (Gio)</label>
          <input
            id="graph-nutanix-disk-size"
            type="number"
            autoFocus
            min={1}
            max={2048}
            value={sizeGib}
            onChange={(e) => setSizeGib(e.target.value)}
            disabled={busy}
            required
          />
          {sizeGib.trim().length > 0 && !sizeValid && (
            <span style={{ fontSize: 12, color: "var(--color-critical)" }}>Entier entre 1 et 2048 Gio.</span>
          )}
        </div>
        <p className="create-container-hint">
          Disque SCSI ajouté via Prism Central (ajout à chaud supporté par AHV, VM allumée ou éteinte). Le storage
          container du disque existant de la VM est réutilisé — à défaut, celui par défaut du cluster.
        </p>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !sizeValid}>
            {busy ? "…" : "Ajouter"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** "Ajouter une carte réseau" — subnets RÉELS (GET /api/nutanix/subnets, mêmes données que la
 * résolution VLAN du poll de topologie), jamais une liste inventée ; subnet revalidé côté serveur. */
function NutanixAddNicPopover({ vmNode, x, y, onClose }: NutanixVmPopoverProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const { ref, style } = useDismiss(onClose, x, y);
  const subnets = useAppSelector((s) => s.nutanix.subnets);
  const [subnetUuid, setSubnetUuid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(fetchNutanixSubnets());
  }, [dispatch]);

  useEffect(() => {
    if ((!subnetUuid || !subnets.some((s) => s.uuid === subnetUuid)) && subnets.length > 0) setSubnetUuid(subnets[0]!.uuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subnets.length]);

  const selected = subnets.find((s) => s.uuid === subnetUuid);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!subnetUuid) return;
    const ok = await confirm({
      title: "Ajouter une carte réseau à la VM",
      description: `Ajouter une carte réseau sur le subnet "${selected?.name ?? subnetUuid}" à "${vmNode.label}" ? Cette action modifie réellement la VM sur Prism Central.`,
      confirmLabel: "Ajouter la carte réseau",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(addNutanixVmNic({ uuid: idWithoutPrefix(vmNode.id), subnetUuid }));
    setBusy(false);
    if (addNutanixVmNic.fulfilled.match(result)) {
      dispatch(
        pushNotification({ level: "success", message: `Carte réseau (${result.payload.subnetName}) ajoutée à "${result.payload.vmName}".` }),
      );
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de l'ajout de la carte réseau.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{`Nouvelle carte réseau pour « ${vmNode.label} »`}</div>
      <form onSubmit={handleSubmit}>
        {subnets.length === 0 ? (
          <p className="graph-popover__error" style={{ color: "var(--color-text-faint)" }}>
            Aucun subnet Nutanix disponible (Prism Central injoignable, ou aucun subnet configuré).
          </p>
        ) : (
          <div className="field">
            <label htmlFor="graph-nutanix-nic-subnet">Subnet / VLAN</label>
            <select
              id="graph-nutanix-nic-subnet"
              value={subnetUuid}
              onChange={(e) => setSubnetUuid(e.target.value)}
              disabled={busy}
              required
            >
              {subnets.map((s) => (
                <option key={s.uuid} value={s.uuid}>
                  {s.name}
                  {s.vlanId !== undefined ? ` (VLAN ${s.vlanId})` : ""}
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
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !subnetUuid || subnets.length === 0}>
            {busy ? "…" : "Ajouter"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** "vCPU / Mémoire" — champ vide = inchangé (le nœud du graphe ne porte que le TOTAL de vCPUs,
 * jamais la décomposition sockets × cœurs : aucun pré-remplissage inventé). Contrainte à-chaud
 * affichée honnêtement ; un refus réel de Prism Central remonte tel quel (jamais masqué). */
function NutanixComputePopover({ vmNode, x, y, onClose }: NutanixVmPopoverProps) {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const { ref, style } = useDismiss(onClose, x, y);
  const [numVcpus, setNumVcpus] = useState("");
  const [coresPerVcpu, setCoresPerVcpu] = useState("");
  const [memoryMib, setMemoryMib] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseField(raw: string, min: number, max: number): { value?: number; invalid: boolean } {
    const trimmed = raw.trim();
    if (!trimmed) return { invalid: false };
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < min || n > max) return { invalid: true };
    return { value: n, invalid: false };
  }

  const vcpus = parseField(numVcpus, 1, 64);
  const cores = parseField(coresPerVcpu, 1, 16);
  const memory = parseField(memoryMib, 256, 1024 * 1024);
  const anyProvided = vcpus.value !== undefined || cores.value !== undefined || memory.value !== undefined;
  const anyInvalid = vcpus.invalid || cores.invalid || memory.invalid;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!anyProvided || anyInvalid) return;
    const changes = [
      ...(vcpus.value !== undefined ? [`${vcpus.value} vCPU`] : []),
      ...(cores.value !== undefined ? [`${cores.value} cœur(s) par vCPU`] : []),
      ...(memory.value !== undefined ? [`${memory.value} Mio de mémoire`] : []),
    ].join(", ");
    const ok = await confirm({
      title: "Modifier vCPU / mémoire de la VM",
      description: `Appliquer ${changes} à "${vmNode.label}" ? Cette action modifie réellement la VM sur Prism Central.`,
      confirmLabel: "Appliquer",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await dispatch(
      updateNutanixVmCompute({
        uuid: idWithoutPrefix(vmNode.id),
        ...(vcpus.value !== undefined ? { numVcpus: vcpus.value } : {}),
        ...(cores.value !== undefined ? { numCoresPerVcpu: cores.value } : {}),
        ...(memory.value !== undefined ? { memoryMib: memory.value } : {}),
      }),
    );
    setBusy(false);
    if (updateNutanixVmCompute.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "success", message: `vCPU/mémoire mis à jour pour "${result.payload.vmName}".` }));
      dispatch(fetchTopology());
      onClose();
    } else {
      setError(result.payload ?? "Échec de la mise à jour vCPU/mémoire.");
    }
  }

  return (
    <div className="graph-popover" style={style} ref={ref}>
      <div className="graph-popover__title">{`vCPU / Mémoire de « ${vmNode.label} »`}</div>
      <p className="graph-popover__desc">
        Actuel :{" "}
        {typeof vmNode.numVcpus === "number" ? `${vmNode.numVcpus} vCPU au total` : "vCPU non rapportés"}
        {typeof vmNode.memoryMib === "number" ? ` · ${vmNode.memoryMib} Mio` : ""}. Champ vide = inchangé.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="graph-nutanix-vcpus">vCPU (sockets)</label>
          <input
            id="graph-nutanix-vcpus"
            type="number"
            autoFocus
            min={1}
            max={64}
            placeholder="inchangé"
            value={numVcpus}
            onChange={(e) => setNumVcpus(e.target.value)}
            disabled={busy}
          />
          {vcpus.invalid && <span style={{ fontSize: 12, color: "var(--color-critical)" }}>Entier entre 1 et 64.</span>}
        </div>
        <div className="field">
          <label htmlFor="graph-nutanix-cores">Cœurs par vCPU</label>
          <input
            id="graph-nutanix-cores"
            type="number"
            min={1}
            max={16}
            placeholder="inchangé"
            value={coresPerVcpu}
            onChange={(e) => setCoresPerVcpu(e.target.value)}
            disabled={busy}
          />
          {cores.invalid && <span style={{ fontSize: 12, color: "var(--color-critical)" }}>Entier entre 1 et 16.</span>}
        </div>
        <div className="field">
          <label htmlFor="graph-nutanix-memory">Mémoire (Mio)</label>
          <input
            id="graph-nutanix-memory"
            type="number"
            min={256}
            max={1024 * 1024}
            placeholder="inchangé"
            value={memoryMib}
            onChange={(e) => setMemoryMib(e.target.value)}
            disabled={busy}
          />
          {memory.invalid && <span style={{ fontSize: 12, color: "var(--color-critical)" }}>Entier entre 256 et 1 048 576 Mio.</span>}
        </div>
        <p className="create-container-hint">
          VM allumée : l'AJOUT de vCPU/mémoire est généralement appliqué à chaud par AHV ; une DIMINUTION ou un
          changement des cœurs par vCPU exigent en général la VM éteinte — dans ce cas Prism Central refuse et son
          message d'erreur réel s'affiche tel quel.
        </p>
        {error && <p className="graph-popover__error">{error}</p>}
        <div className="graph-popover__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !anyProvided || anyInvalid}>
            {busy ? "…" : "Appliquer"}
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

// --- Migration d'une VM Nutanix par glisser-déposer (voir handleNodeDragStop plus bas) ----------
// Réutilise le drag de POSITION déjà en place pour TOUT nœud du graphe (nodesDraggable={operate},
// handleNodeDragStop persiste déjà la position finale via PUT /api/topology/positions) — PAS le
// mécanisme de connexion par Handle/port (handleConnect/classifyConnection) : la relation "hosts"/
// "hosted-by" y est délibérément non-interactive (voir NODE_CONTRACT, topologyNodeContract.tsx)
// car c'est une vérité SERVEUR, jamais une intention à glisser à la main comme un network. Détecter
// une "dépose sur un hôte" est donc un test géométrique simple sur les positions déjà connues du
// canevas, pas un nouveau type de Handle.

/** Nœud "hôte physique Nutanix" (kind "host", hostKind "nutanix-host") UNIQUEMENT — une VM ne migre
 * jamais vers le nœud "cluster" (niveau agrégé, aucune notion de placement à ce niveau) ni vers un
 * hôte Docker distant/LXD (aucune API de migration de VM Nutanix ne s'applique à eux). */
function isMigratableNutanixHostNode(n: Node): boolean {
  const topoNode = n.data as unknown as TopologyNode;
  return topoNode.kind === "host" && topoNode.hostKind === "nutanix-host";
}

/** Hôte physique dont la carte (position + taille APPROXIMATIVE, voir GROUP_NODE_APPROX_WIDTH/
 * HEIGHT ci-dessus — même compromis assumé que pour le cadre de groupe : pas de layout DOM réel
 * nécessaire pour ce simple test de dépose) contient le CENTRE du nœud VM déposé — `undefined` si
 * la VM a été lâchée dans le vide ou sur un nœud d'un autre type. */
function findNutanixHostNodeUnderDrop(vmNode: Node, allNodes: Node[]): Node | undefined {
  const cx = vmNode.position.x + GROUP_NODE_APPROX_WIDTH / 2;
  const cy = vmNode.position.y + GROUP_NODE_APPROX_HEIGHT / 2;
  return allNodes.find((n) => {
    if (n.id === vmNode.id || !isMigratableNutanixHostNode(n)) return false;
    return (
      cx >= n.position.x && cx <= n.position.x + GROUP_NODE_APPROX_WIDTH && cy >= n.position.y && cy <= n.position.y + GROUP_NODE_APPROX_HEIGHT
    );
  });
}

/** "host:nutanix-host:<uuid>" -> "<uuid>" — l'id d'un nœud "host" physique Nutanix a DEUX préfixes
 * côté serveur (services/topology.ts#nutanixHostNodeId), contrairement à "container:<id>"/
 * "nutanix-vm:<uuid>" qui n'en ont qu'un seul : `idWithoutPrefix` (topologyGraphShared.tsx) ne
 * retire que le premier segment, insuffisant ici. Les uuids Nutanix ne contiennent jamais ":",
 * prendre tout ce qui suit le DERNIER ":" est donc fiable quel que soit le nombre de préfixes. */
function rawNutanixHostUuid(hostNodeId: string): string {
  return hostNodeId.slice(hostNodeId.lastIndexOf(":") + 1);
}

/** id du nœud "host" hébergeant ACTUELLEMENT cette VM — dérivé de la VRAIE arête `kind: "hosts"`
 * du graphe (jamais recalculé/deviné), voir services/topology.ts#getNutanixTopologyParts.
 * `undefined` si la VM n'a pas d'hôte déterminable (éteinte, ou juste rattachée au nœud cluster). */
function currentNutanixHostNodeId(vmNodeId: string, edges: TopologyEdge[]): string | undefined {
  return edges.find((e) => e.kind === "hosts" && e.target === vmNodeId)?.source;
}

export default function TopologyGraph({ height = 460, onSelectNode, refreshIntervalMs = REFRESH_INTERVAL_MS }: TopologyGraphProps) {
  const dispatch = useAppDispatch();
  const { data, status, error, positions } = useAppSelector((s) => s.topology);
  const session = useAppSelector((s) => s.auth.session);
  const operate = canOperate(session);
  const admin = canAdminister(session);
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
  const [popover, setPopover] = useState<{ kind: CreatableKind; x: number; y: number; initialImage?: string } | null>(null);
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
  // Popover "Connecter à un network…" (menu contextuel d'un conteneur, ou fil conteneur -> network
  // avec `initialNetworkId` pré-rempli) — voir NetworkConnectPopover ci-dessus : chemin de connexion
  // qui fonctionne même quand le network visé est une brique (donc sans nœud à glisser-déposer dessus).
  const [networkConnectPopover, setNetworkConnectPopover] = useState<{
    containerId: string;
    initialNetworkId?: string;
    x: number;
    y: number;
  } | null>(null);
  // Popover de montage (voir MountVolumePopover : deux cibles, volume existant ou volume neuf).
  const [mountVolumePopover, setMountVolumePopover] = useState<{ target: MountPopoverTarget; x: number; y: number } | null>(null);
  // Picker "Attacher" (bouton ＋ au survol d'une carte conteneur, ou entrée du clic droit).
  const [attachPicker, setAttachPicker] = useState<{ x: number; y: number; node: TopologyNode } | null>(null);
  // Popover "Variable d'environnement" du picker (voir AttachEnvPopover — adossé aux secrets).
  const [attachEnvPopover, setAttachEnvPopover] = useState<{ node: TopologyNode; x: number; y: number } | null>(
    null,
  );
  // Popovers "configuration matérielle" d'une VM Nutanix (picker ＋ contextuel / menu contextuel,
  // 18/08/2026) — voir NutanixAddDiskPopover/NutanixAddNicPopover/NutanixComputePopover ci-dessus.
  const [nutanixDiskPopover, setNutanixDiskPopover] = useState<{ node: TopologyNode; x: number; y: number } | null>(null);
  const [nutanixNicPopover, setNutanixNicPopover] = useState<{ node: TopologyNode; x: number; y: number } | null>(null);
  const [nutanixComputePopover, setNutanixComputePopover] = useState<{ node: TopologyNode; x: number; y: number } | null>(null);
  // Fabrique de templates : popover "Voir les builds" + modale "Déployer en VM" d'un nœud template.
  const [templateBuildsPopover, setTemplateBuildsPopover] = useState<{
    templateId: string;
    templateName: string;
    x: number;
    y: number;
  } | null>(null);
  const [deployVmModal, setDeployVmModal] = useState<{ templateName: string; artifactReference: string } | null>(null);
  const templates = useAppSelector((s) => s.templates.items);
  /** Recette réelle par id de template — chips "appliance repliée" des cartes image-template
   * (GraphNodeTemplateMeta, topologyGraphShared.tsx) : nombre d'étapes + libellé de base. */
  const templatesById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  // Verrous "action en cours" (boutons rapides des cartes, 18/08/2026) — mêmes sources que le
  // panneau de détail (nutanix.actionPendingUuid) et la page Conteneurs (containers.actionPendingId).
  const nutanixActionPendingUuid = useAppSelector((s) => s.nutanix.actionPendingUuid);
  const containerActionPendingId = useAppSelector((s) => s.containers.actionPendingId);
  // Convergence : la carte reste "pending" après un start/stop réussi jusqu'à ce que le poll
  // constate l'état attendu (retour utilisateur du 18/08/2026 : "la transition doit rester jusqu'à
  // arrêté ou le succès") — voir nutanixSlice/containersSlice#convergence.
  const nutanixConvergence = useAppSelector((s) => s.nutanix.convergence);
  const containerConvergence = useAppSelector((s) => s.containers.convergence);
  // Purge des attentes de convergence satisfaites (état réel constaté au poll) ou expirées.
  useEffect(() => {
    for (const n of data?.nodes ?? []) {
      const raw = idWithoutPrefix(n.id);
      const entry = n.kind === "nutanix-vm" ? nutanixConvergence[raw] : n.kind === "container" ? containerConvergence[raw] : undefined;
      if (entry && (n.status === entry.expected || Date.now() - entry.since >= CONVERGENCE_TIMEOUT_MS)) {
        dispatch(n.kind === "nutanix-vm" ? clearNutanixVmConvergence(raw) : clearContainerConvergence(raw));
      }
    }
  }, [data, nutanixConvergence, containerConvergence, dispatch]);
  // "Ajouter un environnement…" depuis un nœud cluster Nutanix — même modale réelle que le spotlight.
  const [remoteEnvModalOpen, setRemoteEnvModalOpen] = useState(false);
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  // Panneau de détail complet, ancré en overlay sur le canevas (clic droit sur un nœud ou une
  // brique -> "Voir le détail") — voir TopologyNodeDetailPanel.tsx. Distincte de `selectedId`
  // (simple surbrillance visuelle du nœud, conservée) : ce n'est plus l'Inspector latéral (retiré
  // de la Vue d'ensemble) qui affiche quoi que ce soit ici, uniquement ce panneau ouvert à la
  // demande.
  const [detailNode, setDetailNode] = useState<TopologyNode | null>(null);
  // Onglet à ouvrir pour le PROCHAIN affichage de `detailNode` (voir openNodeDetail ci-dessous) —
  // undefined = comportement historique ("overview"). Sert à la carte flottante d'alerte "CPU
  // élevé" (GraphNode, topologyGraphShared.tsx) pour ouvrir directement sur "metrics".
  const [detailInitialTab, setDetailInitialTab] = useState<TabId | undefined>(undefined);
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
  // Action de fil différée entre onConnect (pas de coordonnées) et onConnectEnd (position réelle).
  const pendingWireActionRef = useRef<((x: number, y: number) => void) | null>(null);

  // --- Regroupement de nœuds ("encapsulation façon Railway/Logisim", voir TopologyGroup) --------
  // Sélection multiple (Maj+clic sur des nœuds OU rectangle de sélection glissé sur le canevas
  // vide, voir handleNodeClick/onSelectionEnd) — DISTINCTE de `selectedId` ci-dessus (simple
  // surbrillance d'UN nœud pour l'Inspector/le détail) : un clic simple réinitialise toujours
  // cette sélection multiple, elle ne sert QUE pour l'action "Regrouper".
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  // Dernière sélection RAPPORTÉE par React Flow (onSelectionChange, déclenché aussi bien par un
  // clic que par un rectangle de sélection glissé) — gardée à part dans une ref plutôt que
  // synchronisée directement dans `multiSelectedIds` : un clic simple gère déjà `multiSelectedIds`
  // lui-même (handleNodeClick, Maj+clic) et ne doit pas être perturbé par ce mécanisme parallèle.
  // Seul `onSelectionEnd` (déclenché UNIQUEMENT à la fin d'un geste de rectangle de sélection, JAMAIS
  // par un simple clic) copie effectivement cette ref dans `multiSelectedIds`.
  const lastReactFlowSelectionIds = useRef<string[]>([]);
  /**
   * Bug réel corrigé le 13/08/2026 (retour utilisateur : "j'ai créé une zone bleue mais ça n'a pas
   * sélectionné les nœuds") : le memo `nodes` ci-dessous (canevas CONTRÔLÉ) recalculait `selected`
   * UNIQUEMENT depuis `selectedId`/`multiSelectedIds`, en écrasant systématiquement le `selected`
   * que React Flow lui-même pose en interne pendant le glissé (`commitUserSelectionRect` ->
   * `onNodesChange` -> `applyNodeChanges` -> `flowNodes[].selected`). Comme `multiSelectedIds` ne se
   * met à jour qu'À LA FIN du geste (`onSelectionEnd`, voir plus haut), CHAQUE frame intermédiaire du
   * glissé renvoyait `selected: false` pour les nœuds pourtant dans le rectangle -> ce faux `nodes`
   * contrôlé était resynchronisé vers le store interne de React Flow, qui écrasait à son tour son
   * PROPRE `nodeLookup` avant même que `SelectionListenerInner` (useEffect différé) ait pu lire l'état
   * réel -> `onSelectionChange`/`onSelectionEnd` ne recevaient jamais qu'une liste vide. Ce drapeau,
   * posé UNIQUEMENT pendant un vrai geste de rectangle (`onSelectionStart`/`onSelectionEnd` ne se
   * déclenchent jamais sur un simple clic, voir Pane#onPointerMove de la lib : le seuil de distance
   * `paneClickDistance` doit être dépassé), laisse alors le memo `nodes` respecter le `selected`
   * QUE React Flow vient lui-même de poser plutôt que de le contredire — sans rien changer au
   * comportement hors glissé (clic simple/Maj+clic restent pilotés par `selectedId`/`multiSelectedIds`
   * comme avant).
   */
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  // Popover de saisie du libellé — réutilisé pour la création ("Regrouper" sur la sélection
  // courante) ET le renommage d'un groupe existant (voir groupMenuItems ci-dessous).
  const [groupLabelPopover, setGroupLabelPopover] = useState<
    { mode: "create"; nodeIds: string[]; x: number; y: number } | { mode: "rename"; group: TopologyGroup; x: number; y: number } | null
  >(null);
  // Menu contextuel d'un nœud de groupe (replié) ou du cadre d'un groupe déplié — distinct de
  // `nodeMenu` (un groupe n'est pas un TopologyNode réel, voir GroupNodeData/GroupFrameNodeData).
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: TopologyGroup } | null>(null);
  /** Clic droit sur le canevas VIDE pendant une sélection multiple active (retour utilisateur du
   * 13/08/2026, voir handlePaneContextMenu) : propose "Grouper la sélection" au lieu du picker de
   * création habituel (canvasMenu/CreateSpotlight) — créer un nouveau nœud n'a aucun sens tant
   * qu'une sélection est en cours, alors que grouper est justement l'action attendue à cet instant. */
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  // Bouton "grille" de la barre d'outils (voir <Controls> plus bas) — bascule la MiniMap, seule
  // "vue d'ensemble" que ce graphe propose pour l'instant.
  const [showMiniMap, setShowMiniMap] = useState(true);
  // Bouton "i" de la barre d'outils (voir <Controls> plus bas) — bascule le panneau "Légende"
  // (TopologyLegendPanel, topologyGraphShared.tsx), replié par défaut : mission du 17/08/2026,
  // point 4 — la grille couleur/pointillé des arêtes n'était documentée que dans le code jusqu'ici.
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => {
    // Premier paint rapide (sources locales seules) + fetch complet enchaîné aussitôt — le graphe
    // partiel n'écrase jamais un graphe déjà affiché (voir topologySlice#fetchTopology.fulfilled).
    dispatch(fetchTopology({ scope: "local" }));
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

  // Templates : liste chargée à l'ouverture (404 = backend absent, géré silencieusement par le
  // slice) puis POLL de suivi UNIQUEMENT tant qu'un build tourne — même pattern que le poll des
  // runs IaC (IacWorkspacePanel), les transitions building -> ready/error déclenchent le toast
  // final + un rafraîchissement du graphe depuis fetchTemplates lui-même.
  useEffect(() => {
    dispatch(fetchTemplates());
  }, [dispatch]);
  const anyTemplateBuilding = templates.some((t) => t.status === "building");
  useEffect(() => {
    if (!anyTemplateBuilding) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchTemplates());
    }, 4000);
    return () => clearInterval(interval);
  }, [dispatch, anyTemplateBuilding]);

  /**
   * Disposition automatique en arbre de TOUTE la hiérarchie "host" du graphe (cluster Nutanix ->
   * hôte AHV -> VM, mais aussi tout autre nœud "host" isolé — environnement Docker distant/hôte
   * LXD sans VM hébergée — devenu sa propre racine d'arbre à une seule feuille) — voir
   * hostHierarchyPositions (topologyGraphShared.tsx) pour l'algorithme. Recalculée seulement quand
   * `data` change (nouveau poll/arêtes), jamais à chaque render : un `useMemo`, pas un calcul posé
   * inline dans l'effet ci-dessous, pour ne pas le refaire à chaque changement de `positions` (une
   * simple sauvegarde de position manuelle n'a AUCUNE raison de redisposer tout l'arbre calculé,
   * seul le nœud déplacé doit changer — voir `defaultPosition` plus bas qui reste de toute façon
   * ignoré dès qu'une position sauvegardée existe pour ce nœud précis).
   */
  const hostTreePositions = useMemo(() => {
    if (!data) return {};
    // L'appliance HYCU est rattachée au master par une arête "hosts" : elle appartient donc au
    // même arbre auto-disposé, sinon elle resterait dans sa colonne fixe loin de sa racine.
    const hostTreeNodeIds = data.nodes
      .filter((n) => n.kind === "host" || n.kind === "nutanix-vm" || n.kind === "hycu-appliance")
      .map((n) => n.id);
    const hostsEdges = data.edges.filter((e) => e.kind === "hosts");
    return hostHierarchyPositions(hostTreeNodeIds, hostsEdges, { x: HOST_TREE_ANCHOR_X, y: 0 });
  }, [data]);

  // Recalcule la liste des nœuds à chaque nouveau fetch (toutes les 15s) ou changement de
  // positions sauvegardées — sans écraser la position d'un nœud déjà positionné (à la main ou par
  // un calcul précédent), contrairement à l'ancien recalcul systématique en 3 colonnes fixes.
  useEffect(() => {
    if (!data) {
      setFlowNodes([]);
      return;
    }
    // Un compteur de ligne par kind — initialisé depuis le registre (mapNodeContract,
    // topologyNodeContract.tsx) plutôt qu'un littéral à 13 entrées à maintenir à la main : un
    // futur kind ajouté au contrat a automatiquement son compteur ici.
    const columnCounters: Record<TopologyNode["kind"], number> = mapNodeContract(() => 0);
    // Membres d'un groupe REPLIÉ : n'apparaissent plus comme des nœuds individuels (voir plus bas,
    // un seul nœud "topologyGroupNode" les représente) — un membre d'un groupe DÉPLIÉ continue en
    // revanche d'être rendu ici tel quel (voir topologyGraphShared.tsx en-tête § "Regroupement").
    // Groupes imbriqués (13/08/2026) : RÉCURSIF via isHiddenAtRoot — un nœud est caché du niveau
    // racine s'il est membre, directement ou transitivement à travers une chaîne de groupes TOUS
    // repliés, d'un groupe replié (voir isHiddenAtRoot ci-dessus pour les deux cas limites : parent
    // replié masquant un sous-groupe déplié, et parent déplié laissant un sous-groupe replié visible
    // en tant que sa propre carte).
    const parentGroupByMemberId = buildParentGroupByMemberId(data.groups);
    const collapsedMemberIds = new Set(data.nodes.filter((n) => isHiddenAtRoot(n.id, parentGroupByMemberId)).map((n) => n.id));
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      // Scale-in d'un nœud dont l'id est inconnu du rendu précédent — au premier chargement aussi
      // (mission micro-interactions du 18/08/2026), mais en cascade douce via --enter-delay plutôt
      // qu'une pluie de pop-ins simultanés, voir .topology-node-new (topology.css).
      const isFirstRender = prev.length === 0;
      const nodes: Node[] = data.nodes
        .filter((n) => !collapsedMemberIds.has(n.id))
        .map((n, nodeIndex) => {
          const row = columnCounters[n.kind]++;
          // Hiérarchie "host" (cluster/hôte/VM Nutanix, environnement Docker distant, hôte LXD) :
          // position par défaut calculée par l'arbre auto-disposé ci-dessus plutôt que la colonne
          // fixe historique (COLUMN_X) — celle-ci ne sert plus qu'en repli défensif improbable (id
          // absent de l'arbre, ne devrait jamais arriver puisqu'il est calculé sur TOUS les nœuds
          // "host"/"nutanix-vm" de `data.nodes`, exactement ceux filtrés ici par `n.kind`).
          const defaultPosition =
            n.kind === "host" || n.kind === "nutanix-vm"
              ? hostTreePositions[n.id] ?? { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT }
              : { x: COLUMN_X[n.kind], y: row * ROW_HEIGHT };
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
          // d'ouvrir son détail / son menu contextuel. Les cartes d'alerte "CPU élevé"/"Mémoire
          // élevée" ne passent PLUS par ici (onViewMetrics/onRestartFromAlert retirés du 17/08/2026,
          // voir TopologyAlertStack ci-dessous) : la nouvelle pile fixe vit directement dans ce
          // composant, qui a déjà accès à openNodeDetail/handleCpuAlertRestart sans détour par
          // node.data.
          // Picker ＋ ancré sous le bouton — partagé conteneur/VM (le contenu du picker est
          // contextuel par kind, voir attachPicker plus bas).
          const openAttachPicker = (event: React.MouseEvent) => {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            setAttachPicker({ x: rect.left, y: rect.bottom + 6, node: n });
          };
          const rawActionId = idWithoutPrefix(n.id);
          const callbacks: GraphNodeCallbacks =
            n.kind === "container"
              ? {
                  onOpenAttachment: (attachment) => handleOpenAttachment(attachment),
                  onAttachmentContextMenu: (event, attachment) => handleAttachmentContextMenu(event, n.id, attachment),
                  // Bouton ＋ + actions rapides (operator+ uniquement — non injecté = non rendu).
                  ...(operate
                    ? {
                        onOpenAttachPicker: openAttachPicker,
                        // MÊMES handlers réels que le menu contextuel (confirmations comprises).
                        onQuickAction: (action: QuickLifecycleAction) => void handleContainerAction(rawActionId, n.label, action),
                        actionPending:
                          containerActionPendingId === rawActionId ||
                          convergenceStillPending(containerConvergence[rawActionId], n.status),
                      }
                    : {}),
                }
              : n.kind === "nutanix-vm" && operate
                ? {
                    onOpenAttachPicker: openAttachPicker,
                    onQuickAction: (action: QuickLifecycleAction) => void handleNutanixVmAction(rawActionId, n.label, action),
                    actionPending:
                      nutanixActionPendingUuid === rawActionId ||
                      convergenceStillPending(nutanixConvergence[rawActionId], n.status),
                  }
                : {};
          // Chips "appliance repliée" d'un nœud template (voir templatesById) — absentes tant que
          // la liste de templates n'est pas chargée, jamais un compte inventé.
          const template = n.kind === "image-template" ? templatesById.get(rawActionId) : undefined;
          const templateMeta = template
            ? { templateStepCount: template.steps.length, templateBaseLabel: templateBaseLabel(template.base) }
            : {};
          return {
            id: n.id,
            type: "graphNode",
            position,
            ...(!prevNode
              ? {
                  className: "topology-node-new",
                  ...(isFirstRender
                    ? { style: { "--enter-delay": `${Math.min(nodeIndex * 30, 360)}ms` } as CSSProperties }
                    : {}),
                }
              : {}),
            data: { ...n, ...callbacks, ...templateMeta } as unknown as Record<string, unknown>,
          };
        });
      // Un nœud par groupe REPLIÉ (voir collapsedMemberIds ci-dessus) — position : celle déjà
      // sauvegardée par l'utilisateur (comme n'importe quel nœud), sinon celle du groupe au rendu
      // précédent (le collapse/déploiement ne doit pas faire "sauter" la carte), sinon le centre
      // (moyenne) des dernières positions CONNUES de ses membres — jamais une position inventée
      // hors de leur voisinage.
      for (const group of data.groups) {
        if (!group.collapsed) continue;
        // Groupes imbriqués (13/08/2026) : un groupe replié lui-même masqué par un ancêtre replié
        // (nesting collapsed-dans-collapsed) n'a AUCUNE carte propre à ce niveau — il est entièrement
        // absorbé par la carte de son ancêtre le plus extérieur (voir isHiddenAtRoot ci-dessus).
        if (isHiddenAtRoot(group.id, parentGroupByMemberId)) continue;
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
          ports: deriveGroupPorts(group, data.edges, data.groups),
          onToggleCollapse: () => handleToggleGroupCollapse(group),
          realNodeCount: resolveGroupMemberNodeIds(group.nodeIds, data.groups).length,
        };
        nodes.push({
          id: group.id,
          type: "topologyGroupNode",
          position,
          ...(!prevGroupNode ? { className: "topology-node-new" } : {}),
          data: groupData as unknown as Record<string, unknown>,
        });
      }
      return nodes;
    });
    // Les deux ids "action en cours" invalident le rendu des boutons rapides (voir
    // graphNodePropsEqual#actionPending, topologyGraphShared.tsx) — d'où leur présence ici.
    // `templatesById` : chips des cartes image-template (graphNodePropsEqual borne les re-renders).
  }, [data, positions, hostTreePositions, nutanixActionPendingUuid, containerActionPendingId, templatesById]);

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
    const groupsById = new Map(data.groups.map((g) => [g.id, g]));
    const parentGroupByMemberId = buildParentGroupByMemberId(data.groups);
    const frames: Node[] = [];

    function frameRect(inner: { minX: number; minY: number; maxX: number; maxY: number }) {
      return {
        x: inner.minX - GROUP_FRAME_PADDING,
        y: inner.minY - GROUP_FRAME_PADDING - GROUP_FRAME_HEADER_HEIGHT,
        width: inner.maxX - inner.minX + GROUP_FRAME_PADDING * 2,
        height: inner.maxY - inner.minY + GROUP_FRAME_PADDING * 2 + GROUP_FRAME_HEADER_HEIGHT,
      };
    }

    // Bornes RÉELLES (positions connues) de `group` DÉPLIÉ, à partir de ses membres DIRECTS —
    // groupes imbriqués (13/08/2026) : un membre qui est lui-même un sous-groupe DÉPLIÉ n'a AUCUNE
    // carte propre dans `flowById` (seuls ses propres membres, potentiellement plus profonds, en
    // ont une) — on calcule alors récursivement SON propre cadre (poussé dans `frames` au passage)
    // et on inclut son rectangle EXTÉRIEUR (padding+en-tête compris) dans le calcul du parent, comme
    // s'il s'agissait d'une carte de taille variable. Un sous-groupe REPLIÉ, lui, a bien une carte
    // (poussée par le useEffect ci-dessus, voir collapsedMemberIds) : traité comme un vrai membre.
    function computeInnerBounds(group: TopologyGroup): { minX: number; minY: number; maxX: number; maxY: number } | null {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let any = false;
      function include(x: number, y: number, w: number, h: number) {
        any = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      }
      for (const memberId of group.nodeIds) {
        const subGroup = groupsById.get(memberId);
        if (subGroup && !subGroup.collapsed) {
          const childInner = computeInnerBounds(subGroup);
          if (!childInner) continue;
          const rect = frameRect(childInner);
          const frameData: GroupFrameNodeData = { group: subGroup, onToggleCollapse: () => handleToggleGroupCollapse(subGroup) };
          frames.push({
            id: `group-frame:${subGroup.id}`,
            type: "topologyGroupFrame",
            position: { x: rect.x, y: rect.y },
            style: { width: rect.width, height: rect.height },
            zIndex: -1,
            draggable: false,
            selectable: false,
            connectable: false,
            data: frameData as unknown as Record<string, unknown>,
          });
          include(rect.x, rect.y, rect.width, rect.height);
          continue;
        }
        const pos = flowById.get(memberId)?.position;
        if (!pos) continue;
        include(pos.x, pos.y, GROUP_NODE_APPROX_WIDTH, GROUP_NODE_APPROX_HEIGHT);
      }
      return any ? { minX, minY, maxX, maxY } : null;
    }

    for (const group of data.groups) {
      if (group.collapsed) continue;
      // Un groupe DÉPLIÉ avec un parent est dessiné par récursion DEPUIS ce parent DÉPLIÉ
      // (computeInnerBounds ci-dessus) — jamais deux fois. S'il n'apparaît jamais dans cette
      // récursion (son parent est en réalité REPLIÉ, donc ce sous-groupe déplié est entièrement
      // masqué, voir isHiddenAtRoot), il ne doit lui non plus jamais recevoir de cadre ici : ce cas
      // est déjà couvert en ne partant QUE des groupes racine (sans parent) ci-dessous.
      if (parentGroupByMemberId.has(group.id)) continue;
      const inner = computeInnerBounds(group);
      if (!inner) continue;
      const rect = frameRect(inner);
      const frameData: GroupFrameNodeData = { group, onToggleCollapse: () => handleToggleGroupCollapse(group) };
      frames.push({
        id: `group-frame:${group.id}`,
        type: "topologyGroupFrame",
        position: { x: rect.x, y: rect.y },
        style: { width: rect.width, height: rect.height },
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
    () => [
      ...groupFrameNodes,
      ...flowNodes.map((n) => ({
        ...n,
        // `isBoxSelecting` (voir sa définition ci-dessus, bug réel corrigé le 13/08/2026) : pendant un
        // glissé de rectangle en cours, on respecte le `selected` que React Flow vient de poser lui-même
        // sur `n` plutôt que de le remplacer par `false`, sous peine d'empêcher le geste d'aboutir.
        selected: n.id === selectedId || multiSelectedIds.has(n.id) || (isBoxSelecting && !!n.selected),
      })),
    ],
    [groupFrameNodes, flowNodes, selectedId, multiSelectedIds, isBoxSelecting],
  );

  // Recherche O(1) du nœud à chaque bout d'une arête pour en dériver sa couleur (voir
  // buildTopologyEdges/NODE_CONTRACT[kind].edgeHealth) — recalculée seulement quand les données de
  // topologie changent.
  const nodesById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  /**
   * Redirige toute arête touchant un membre d'un groupe REPLIÉ vers le nœud du groupe lui-même
   * (voir deriveGroupPorts, topologyGraphShared.tsx) — une arête ENTIÈREMENT interne au groupe
   * (les deux bouts sont membres) est masquée (rien à connecter au monde extérieur). `sourceHandle`/
   * `targetHandle` fixés explicitement au nom de la capacité côté groupe : un groupe peut porter
   * plusieurs handles du même type (ex: "network" ET "provide", tous deux source/Right), React Flow
   * ne peut alors plus deviner tout seul lequel utiliser.
   *
   * Groupes imbriqués (13/08/2026) : `resolveVisibleGroupTarget` (ci-dessus) remonte RÉCURSIVEMENT
   * à travers plusieurs niveaux de groupes repliés imbriqués — si un membre appartient à un groupe A
   * lui-même membre d'un groupe B replié, l'arête est redirigée vers B (la carte réellement
   * visible), jamais vers A (masqué par B).
   */
  const groupedTopologyEdges = useMemo<(TopologyEdge & { sourceHandle?: string; targetHandle?: string })[]>(() => {
    if (!data) return [];
    const hasCollapsedGroup = data.groups.some((g) => g.collapsed);
    if (!hasCollapsedGroup) return data.edges;
    const parentGroupByMemberId = buildParentGroupByMemberId(data.groups);
    const result: (TopologyEdge & { sourceHandle?: string; targetHandle?: string })[] = [];
    for (const e of data.edges) {
      const resolvedSource = resolveVisibleGroupTarget(e.source, parentGroupByMemberId);
      const resolvedTarget = resolveVisibleGroupTarget(e.target, parentGroupByMemberId);
      const sourceRedirected = resolvedSource !== e.source;
      const targetRedirected = resolvedTarget !== e.target;
      if (resolvedSource === resolvedTarget && (sourceRedirected || targetRedirected)) continue; // interne au même groupe visible, masquée
      if (!sourceRedirected && !targetRedirected) {
        result.push(e);
        continue;
      }
      // Capacité du côté groupe = EXACTEMENT la même règle que deriveGroupPorts (topologyGraphShared.tsx)
      // — mount: target->"volume-mount", source->"provide" ; network: source->"network",
      // target->"attach" ; hosts: target->"hosted-by" (jamais de port côté source, voir
      // deriveGroupPorts). Un "automation-flow" redirigé vers un groupe (cas rare, non supporté
      // dans ce premier lot) retomberait sur "network"/"attach" par défaut plutôt que de planter —
      // pas un vrai port existant sur le groupe, React Flow masque alors simplement l'arête.
      const sourceHandle = e.kind === "mount" ? "provide" : "network";
      const targetHandle = e.kind === "mount" ? "volume-mount" : e.kind === "hosts" ? "hosted-by" : "attach";
      result.push({
        ...e,
        id: `${e.id}__grouped`,
        source: resolvedSource,
        target: resolvedTarget,
        ...(sourceRedirected ? { sourceHandle } : {}),
        ...(targetRedirected ? { targetHandle } : {}),
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
   * rechargement de page, et suit désormais l'utilisateur d'un poste à l'autre. Comportement
   * INCHANGÉ pour tout nœud/toute dépose (voir mission : "ne régresse pas") — la migration
   * ci-dessous est un effet ADDITIONNEL déclenché en plus, jamais à la place de la sauvegarde de
   * position (annulée par l'utilisateur = simple repositionnement manuel, comme avant). */
  function handleNodeDragStop(_event: unknown, node: Node) {
    dispatch(saveTopologyPositions({ ...positions, [node.id]: { x: node.position.x, y: node.position.y } }));
    void maybeHandleNutanixVmDrop(node);
  }

  /**
   * Glisser-déposer une VM Nutanix sur un nœud "hôte physique" -> migration live RÉELLE (mission :
   * "si jai node A B C je doit pouvoir deplace de a a b ou b a c... et cela deplace la vm il faut
   * un controle totale via le graphe"). Ne fait RIEN (silencieux) si : ce n'est pas une VM Nutanix,
   * la dépose n'atterrit sur AUCUN hôte physique valide, ou l'hôte visé est déjà l'hôte actuel
   * (retour utilisateur du geste, pas une erreur — l'utilisateur a juste repositionné la carte dans
   * la même zone). Confirmation explicite AVANT tout appel réel (variant danger — jamais un simple
   * drag qui migrerait une VRAIE VM de production sans confirmation) ; le serveur revalide de toute
   * façon les mêmes gardes (même hôte, hôte d'un autre cluster, VM éteinte — services/nutanix.ts#
   * migrateNutanixVm), ce contrôle client n'est qu'un confort, jamais la seule barrière.
   */
  async function maybeHandleNutanixVmDrop(vmNode: Node) {
    const topoNode = vmNode.data as unknown as TopologyNode;
    if (!operate || topoNode.kind !== "nutanix-vm" || !data) return;

    const targetHostFlowNode = findNutanixHostNodeUnderDrop(vmNode, flowNodes);
    if (!targetHostFlowNode) return;

    const targetHostUuid = rawNutanixHostUuid(targetHostFlowNode.id);
    const currentHostNodeId = currentNutanixHostNodeId(vmNode.id, data.edges);
    if (currentHostNodeId === targetHostFlowNode.id) return; // reposée sur son hôte actuel : rien à faire, pas une erreur

    const targetHostTopoNode = targetHostFlowNode.data as unknown as TopologyNode;
    const currentHostLabel = topoNode.nutanixHostName ?? "un hôte indéterminé";
    const ok = await confirm({
      title: "Migrer cette VM vers un autre hôte",
      description: `Migrer "${topoNode.label}" de ${currentHostLabel} vers ${targetHostTopoNode.label} ? Cette action déclenche une VRAIE migration live sur Prism Central.`,
      confirmLabel: "Migrer",
      variant: "danger",
    });
    if (!ok) return;

    const result = await dispatch(migrateNutanixVm({ uuid: idWithoutPrefix(vmNode.id), targetHostUuid }));
    if (migrateNutanixVm.fulfilled.match(result)) dispatch(fetchTopology());
  }

  function findPort(nodeId: string | null | undefined, handleId: string | null | undefined): PortSpec | null {
    if (!nodeId || !handleId) return null;
    const node = data?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    return NODE_CONTRACT[node.kind].ports.find((p) => p.id === handleId) ?? null;
  }

  /** Classe une tentative de connexion glissée en comparant les capacités des deux ports visés
   * (table déclarative NODE_CONTRACT[kind].ports/CAPABILITY_DEFS, topologyNodeContract.tsx) —
   * l'action réelle d'une paire interactive vit dans CONNECTION_ACTIONS (contrat), jamais un if en
   * cascade ici. La paire retournée sert à interroger cette table dans handleConnect. */
  function classifyConnection(
    connection: Edge | Connection,
  ): { def: CapabilityDef; sourceCapability: CapabilityId; targetCapability: CapabilityId } | null {
    if (!connection.source || !connection.target || connection.source === connection.target) return null;
    const sourcePort = findPort(connection.source, connection.sourceHandle);
    const targetPort = findPort(connection.target, connection.targetHandle);
    if (!sourcePort || !targetPort) return null;
    if (CAPABILITY_DEFS[sourcePort.capability].linksTo !== targetPort.capability) return null;
    return { def: CAPABILITY_DEFS[sourcePort.capability], sourceCapability: sourcePort.capability, targetCapability: targetPort.capability };
  }

  /** true si ce kind est l'un des 3 nœuds du moteur d'automatisation (voir
   * services/automationStore.ts) — jamais validés via classifyConnection/CAPABILITY_DEFS (ports
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

    const classified = classifyConnection(connection);
    if (!classified) return;
    if (!classified.def.interactive) {
      if (classified.def.infoMessage) dispatch(pushNotification({ level: "info", message: classified.def.infoMessage }));
      return;
    }
    if (!sourceNode || !targetNode) return;
    // Paire -> action réelle : table déclarative du contrat (CONNECTION_ACTIONS), jamais un if par paire.
    const actionId = CONNECTION_ACTIONS[capabilityPairKey(classified.sourceCapability, classified.targetCapability)];
    if (!actionId) {
      dispatch(pushNotification({ level: "info", message: "Cette connexion n'a pas d'action réelle associée." }));
      return;
    }
    // onConnect ne porte aucune coordonnée : l'ouverture du popover est différée jusqu'à
    // handleConnectEnd (même geste, position réelle du relâchement).
    pendingWireActionRef.current = (x, y) => connectionWireHandlers[actionId](sourceNode, targetNode, x, y);
  }

  /** Implémentations par action de fil (CONNECTION_ACTIONS) — source/target déjà normalisés par
   * React Flow (Handle source -> Handle target), quel que soit le bout où le geste a commencé. */
  const connectionWireHandlers: Record<ConnectionActionId, (sourceNode: TopologyNode, targetNode: TopologyNode, x: number, y: number) => void> = {
    // source = volume (provide), target = conteneur (volume-mount) : popover pré-rempli, la
    // recréation reste confirmée par l'utilisateur — jamais déclenchée par le seul geste.
    "mount-volume-on-container": (volumeNode, containerNode, x, y) =>
      setMountVolumePopover({
        target: { kind: "existing-volume", volumeName: idWithoutPrefix(volumeNode.id), initialContainerNodeId: containerNode.id },
        x,
        y,
      }),
    // source = conteneur (network), target = network (attach) : même POST réel que l'action de menu
    // "container-connect-network" (connectContainerToNetwork), network présélectionné.
    "connect-container-to-network": (containerNode, networkNode, x, y) =>
      setNetworkConnectPopover({ containerId: idWithoutPrefix(containerNode.id), initialNetworkId: idWithoutPrefix(networkNode.id), x, y }),
  };

  /** Fin du geste de connexion — seule étape qui connaît la position du pointeur : joue l'action
   * différée posée par handleConnect (le cas échéant), au point de relâchement du fil. */
  function handleConnectEnd(event: MouseEvent | TouchEvent) {
    const pending = pendingWireActionRef.current;
    pendingWireActionRef.current = null;
    if (!pending) return;
    const point = "clientX" in event ? event : event.changedTouches[0];
    const rect = graphContainerRef.current?.getBoundingClientRect();
    pending(point?.clientX ?? (rect ? rect.left + rect.width / 2 : 0), point?.clientY ?? (rect ? rect.top + rect.height / 2 : 0));
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
    // Sélection multiple active (retour utilisateur du 13/08/2026, voir `selectionMenu` ci-dessus) :
    // clic droit sur le vide propose "Grouper la sélection" plutôt que le picker de création.
    if (multiSelectedIds.size >= 2) {
      setSelectionMenu({ x: mouseEvent.clientX, y: mouseEvent.clientY });
      return;
    }
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

  /** Démarrer/Arrêter/Redémarrer une VM Nutanix depuis le menu contextuel du graphe — même
   * confirmation que TopologyNodeDetailPanel.tsx#handleNutanixVmAction (dupliquée volontairement :
   * ce composant a son propre `confirm`/`dispatch`, pas de state partagé pratique entre les deux
   * sans complexifier les deux pour un accès rapide). "Supprimer" reste volontairement ABSENT de ce
   * menu rapide — la confirmation lourde "taper le nom de la VM" (mission) vit UNIQUEMENT dans
   * TopologyNodeDetailPanel.tsx, ouvert via "Voir le détail" (premier item de ce même menu) : une
   * seule source de vérité pour l'action la plus destructrice plutôt que deux dialogues à maintenir
   * en parallèle. */
  async function handleNutanixVmAction(uuid: string, vmName: string, action: NutanixVmLifecycleAction) {
    if (action === "stop" || action === "restart") {
      const ok = await confirm({
        title: action === "stop" ? "Arrêter la VM" : "Redémarrer la VM",
        description:
          action === "stop"
            ? `Confirmer l'arrêt GRACIEUX (ACPI) de "${vmName}" ? Les services qu'elle héberge seront interrompus.`
            : `Confirmer le redémarrage GRACIEUX de "${vmName}" ? Les services qu'elle héberge seront brièvement interrompus.`,
        confirmLabel: action === "stop" ? "Arrêter" : "Redémarrer",
        variant: "danger",
      });
      if (!ok) return;
    }
    const result = await dispatch(runNutanixVmAction({ uuid, action }));
    if (runNutanixVmAction.fulfilled.match(result)) dispatch(fetchTopology());
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
  function openNodeDetail(node: TopologyNode, initialTab?: TabId) {
    selectNode(node.id);
    setDetailNode(node);
    setDetailInitialTab(initialTab);
  }

  /** Bouton "Redémarrer" d'une carte de la pile d'alertes "CPU élevé"/"Mémoire élevée"
   * (TopologyAlertStack, topologyGraphShared.tsx, voir son montage plus bas dans ce fichier) —
   * MÊME chemin réel que "Redémarrer" du menu contextuel du nœud (handleContainerAction/
   * runContainerAction), avec une confirmation `useConfirm` posée ICI (handleContainerAction
   * lui-même ne confirme que stop/remove) : un redémarrage interrompt le service, mérite lui aussi
   * une confirmation explicite depuis cette carte d'alerte. */
  async function handleCpuAlertRestart(node: TopologyNode) {
    const ok = await confirm({
      title: "Redémarrer le conteneur",
      description: `Confirmer le redémarrage de "${node.label}" ? Le service sera interrompu le temps du redémarrage.`,
      confirmLabel: "Redémarrer",
      variant: "danger",
    });
    if (!ok) return;
    await handleContainerAction(idWithoutPrefix(node.id), node.label, "restart");
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

  /** "Construire" d'un nœud template — POST /api/templates/:id/build puis relance du fetch : le
   * statut "building" démarre le poll de suivi (toast final à ready/error, voir fetchTemplates). */
  async function handleTemplateBuild(templateId: string, templateName: string) {
    const result = await dispatch(buildTemplate({ id: templateId }));
    if (buildTemplate.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "info", message: `Build de « ${templateName} » lancé — suivi automatique jusqu'à la fin.` }));
      dispatch(fetchTemplates());
      dispatch(fetchTopology());
    }
  }

  async function handleDeleteTemplate(templateId: string, templateName: string) {
    const ok = await confirm({
      title: "Supprimer le template",
      description: `Confirmer la suppression du template « ${templateName} » ? Son workspace de build et son historique seront perdus.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    const result = await dispatch(deleteTemplate({ id: templateId }));
    if (deleteTemplate.fulfilled.match(result)) {
      dispatch(pushNotification({ level: "success", message: `Template « ${templateName} » supprimé.` }));
      dispatch(fetchTopology());
    }
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
    // "Grouper la sélection" (retour utilisateur du 13/08/2026 : "si je fait clic droit jai rien
    // pour creer le groupe") — jusqu'ici cette action n'existait QUE via le bouton flottant en haut
    // à droite du canevas (voir plus bas), jamais accessible depuis le clic droit sur l'un des
    // nœuds sélectionnés lui-même, contrairement à la règle ≤3 clics. Affiché seulement quand CE
    // nœud fait partie de la sélection multiple en cours (>= 2, sinon le clic droit reste ambigu :
    // grouper QUOI ?) — jamais pour un nœud hors sélection, où le clic droit garde son sens habituel
    // (actions sur ce seul nœud).
    if (operate && multiSelectedIds.size >= 2 && multiSelectedIds.has(node.id)) {
      items.push({ label: `Grouper la sélection (${multiSelectedIds.size})`, onClick: () => openCreateGroupPopover(x, y) });
    }
    if (!operate) return items;

    // Actions PAR KIND : la LISTE (id/libellé/danger/condition de visibilité sur l'état réel du
    // nœud) est déclarée dans le contrat (NODE_CONTRACT[kind].menuItems, topologyNodeContract.tsx
    // — mêmes entrées, même ordre, mêmes gardes qu'avant la migration du 17/08/2026, y compris
    // l'absence volontaire de "Supprimer" pour une VM Nutanix : la confirmation lourde "taper le
    // nom de la VM" reste réservée à TopologyNodeDetailPanel.tsx, voir le contrat) ; seuls les
    // CALLBACKS réels sont fournis ici, par id d'action — ce composant est le seul à avoir accès à
    // dispatch/confirm/aux popovers. `id` : partie utile de l'id du nœud (id Docker brut, uuid de
    // VM, nom de volume... selon le kind — même convention idWithoutPrefix qu'avant).
    const id = idWithoutPrefix(node.id);
    // "hycu-configure" exclu de cette table : il n'est proposé qu'aux admins (voir plus bas) — le
    // compilateur continue d'exiger un handler pour TOUTES les autres actions déclarées.
    const actionHandlers: Record<Exclude<NodeMenuActionId, "hycu-configure">, () => void> = {
      "container-stop": () => void handleContainerAction(id, node.label, "stop"),
      "container-start": () => void handleContainerAction(id, node.label, "start"),
      "container-restart": () => void handleContainerAction(id, node.label, "restart"),
      "container-rename": () => setRenamePopover({ containerId: id, initialName: node.label, x, y }),
      // Depuis les "briques" (voir GraphNode/services/topology.ts), un network mono-conteneur
      // n'est plus un nœud du graphe à viser au glisser-déposer — cette action couvre ce cas (et
      // reste disponible aussi pour un network resté un vrai nœud, résultat identique).
      "container-connect-network": () => setNetworkConnectPopover({ containerId: id, x, y }),
      "container-remove": () => void handleContainerAction(id, node.label, "remove"),
      "nutanix-vm-stop": () => void handleNutanixVmAction(id, node.label, "stop"),
      "nutanix-vm-restart": () => void handleNutanixVmAction(id, node.label, "restart"),
      "nutanix-vm-start": () => void handleNutanixVmAction(id, node.label, "start"),
      // Configuration matérielle (18/08/2026) — mêmes popovers que le picker ＋ de la carte.
      "nutanix-vm-add-disk": () => setNutanixDiskPopover({ node, x, y }),
      "nutanix-vm-add-nic": () => setNutanixNicPopover({ node, x, y }),
      "nutanix-vm-edit-compute": () => setNutanixComputePopover({ node, x, y }),
      "volume-mount-on-container": () => setMountVolumePopover({ target: { kind: "existing-volume", volumeName: id }, x, y }),
      "volume-remove": () => void handleRemoveVolume(id),
      "network-remove": () => void handleRemoveNetwork(id, node.label),
      "automation-node-remove": () => void handleDeleteAutomationNode(node),
      "container-attach": () => setAttachPicker({ x, y, node }),
      "host-add-environment": () => setRemoteEnvModalOpen(true),
      "host-create-vm": () => {}, // entrée désactivée "bientôt" — aucun backend de création de VM
      // Fabrique de templates — visibilités déjà gardées par le contrat (artifact/statut réels).
      "image-template-build": () => void handleTemplateBuild(id, node.label),
      "image-template-view-builds": () => setTemplateBuildsPopover({ templateId: id, templateName: node.label, x, y }),
      "image-template-deploy-vm": () =>
        setDeployVmModal({ templateName: node.label, artifactReference: node.templateArtifactReference ?? "" }),
      "image-template-create-container": () =>
        setPopover({ kind: "container", x, y, ...(node.templateArtifactReference ? { initialImage: node.templateArtifactReference } : {}) }),
      "image-template-remove": () => void handleDeleteTemplate(id, node.label),
      // HYCU : navigation vers la page Sauvegardes RÉELLE (aucune mutation possible — l'appliance
      // est en lecture seule côté API). "Voir les jobs" ouvre la page directement sur cet onglet.
      "hycu-open-page": () => dispatch(setCurrentView("hycu")),
      "hycu-view-jobs": () => {
        dispatch(focusHycuSection({ tab: "jobs" }));
        dispatch(setCurrentView("hycu"));
      },
    };
    // "Configurer…" seulement pour un admin : la section de configuration de la page Sauvegardes
    // lui est réservée — sans handler, buildNodeMenuItems omet simplement l'entrée.
    const allowedHandlers: Partial<Record<NodeMenuActionId, () => void>> = {
      ...actionHandlers,
      ...(admin
        ? {
            "hycu-configure": () => {
              dispatch(focusHycuSection({ config: true }));
              dispatch(setCurrentView("hycu"));
            },
          }
        : {}),
    };
    items.push(...buildNodeMenuItems(node, allowedHandlers));
    return items;
  }

  if (status === "loading" && !data) {
    return (
      <div className="topology-graph topology-loader" style={{ height }}>
        <TopologyLoader />
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
          onConnectEnd={handleConnectEnd}
          connectionLineStyle={CONNECTION_LINE_STYLE}
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
          // Rectangle de sélection au clic-glissé sur le canevas VIDE (façon Figma/Miro, demande
          // utilisateur du 13/08/2026) — réservé operator/admin, seul rôle qui peut ensuite
          // "Regrouper" (le bouton flottant reste de toute façon masqué pour un viewer). Le bouton
          // gauche de la souris sert alors à sélectionner plutôt qu'à panner : panOnDrag=[1,2]
          // laisse le clic milieu/droit continuer de panner (jamais retiré, juste déplacé sur un
          // autre bouton). Un viewer garde le comportement précédent (clic gauche = pan) —
          // panOnDrag=true par défaut — puisqu'il ne peut de toute façon rien faire d'une sélection.
          // SelectionMode.Partial : un nœud est inclus dès qu'il touche le rectangle, pas
          // seulement s'il y est entièrement contenu — plus indulgent, correspond à l'attente la
          // plus courante pour ce genre de geste.
          panOnDrag={operate ? [1, 2] : true}
          selectionOnDrag={operate}
          selectionMode={SelectionMode.Partial}
          onSelectionChange={(params) => {
            lastReactFlowSelectionIds.current = params.nodes.map((n) => n.id);
          }}
          onSelectionStart={() => setIsBoxSelecting(true)}
          onSelectionEnd={() => {
            setIsBoxSelecting(false);
            if (lastReactFlowSelectionIds.current.length >= 2) {
              setMultiSelectedIds(new Set(lastReactFlowSelectionIds.current));
            }
          }}
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
            {/* Panneau "Légende" (couleur/pointillé des arêtes, TopologyLegendPanel ci-dessous) —
                même pattern de bouton bascule que "vue d'ensemble" ci-dessus. */}
            <button
              type="button"
              className="react-flow__controls-button topology-controls__minimap-toggle"
              title={showLegend ? "Masquer la légende" : "Afficher la légende"}
              onClick={() => setShowLegend((v) => !v)}
            >
              <IconInfo />
            </button>
          </Controls>
          <Background gap={20} size={1.6} color="var(--color-text-faint)" />
          {showMiniMap && (
            <MiniMap
              position="top-left"
              nodeColor={(n) =>
                n.type === "topologyGroupNode" || n.type === "topologyGroupFrame"
                  ? "#e879f9"
                  : nodeMinimapColor(n.data as unknown as TopologyNode)
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

      {/* Pile FIXE d'alertes de ressources "CPU élevé"/"Mémoire élevée" (TopologyAlertStack,
          topologyGraphShared.tsx) — retour utilisateur du 17/08/2026 : "ce genre alert devrais
          aparaitre en haut a droite", capture d'écran à l'appui (l'ancien rendu, ancré à chaque
          nœud DANS le canevas, restait invisible dès que l'utilisateur n'était pas en train de
          regarder/zoomer exactement sur ce nœud précis parmi des dizaines de nœuds éparpillés).
          Montée ICI, sibling direct de `.topology-graph__main` (PAS un enfant) : `.topology-graph__
          main--receded` applique un `transform` conditionnel qui redéfinirait le bloc englobant
          d'un descendant `position: fixed`, ce qui casserait le positionnement "haut-droite de
          l'ÉCRAN" voulu (voir topology.css#.topology-alert-stack pour le détail). `data?.nodes ??
          []` : TOUS les nœuds du graphe, pas seulement ceux du rendu React Flow actuel
          (`flowNodes` exclut déjà les membres de groupes repliés) — une alerte doit rester
          découvrable même pour un conteneur caché dans un groupe replié. `onViewMetrics`/
          `onRestart` réutilisent directement openNodeDetail/handleCpuAlertRestart (ce composant y a
          déjà accès, plus besoin de les faire transiter par node.data comme l'ancien rendu ancré au
          nœud). */}
      <TopologyAlertStack
        nodes={data?.nodes ?? []}
        onViewMetrics={(node) => openNodeDetail(node, "metrics")}
        onRestart={(node) => void handleCpuAlertRestart(node)}
      />

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
          services/topology.ts § "Volumes/networks ORPHELINS") — coin bas-GAUCHE du canevas,
          PERMANENT (retour utilisateur du 13/08/2026 : découvrabilité, plutôt que masqué tant qu'il
          n'y a rien à nettoyer) mais désactivé si `orphanCount === 0` (handleCleanOrphans refuse de
          toute façon toute action à 0, voir sa garde ci-dessus — le bouton reflète honnêtement cet
          état plutôt que de laisser croire qu'il ferait quelque chose). Style glassmorphisme (fond
          translucide + flou) distinct des boutons pleins "Regrouper"/toolbar : une action de
          nettoyage volontairement discrète en overlay, jamais dans le flux normal des nœuds. */}
      {operate && (
        <div className="topology-toolbar-bottom-left">
          <button
            type="button"
            className="topology-glass-btn"
            disabled={cleaningOrphans || orphanCount === 0}
            onClick={handleCleanOrphans}
            title={
              orphanCount === 0
                ? "Aucun volume/network orphelin à supprimer pour l'instant"
                : "Supprimer tous les volumes/networks non utilisés par aucun conteneur"
            }
          >
            <IconTrash />
            {cleaningOrphans ? "Nettoyage…" : `Nettoyer les orphelins (${orphanCount})`}
          </button>
          {/* Efface les positions manuelles sauvegardées : le placement automatique reprend la main. */}
          <button
            type="button"
            className="topology-glass-btn"
            onClick={() => {
              void dispatch(saveTopologyPositions({}));
              setFlowNodes([]);
            }}
            title="Effacer les positions déplacées à la main et revenir au placement automatique"
          >
            <IconTopology />
            Replacer
          </button>
        </div>
      )}

      {/* Panneau "Légende" (voir showLegend/bouton bascule ci-dessus) — coin bas-droit du canevas,
          seul coin resté libre (haut-gauche = Contrôles/MiniMap, haut-droit = "Regrouper" en
          sélection multiple, bas-gauche = "Nettoyer les orphelins"). `data?.nutanixLastPoll` :
          voir Topology#nutanixLastPoll (types.ts), simple report — jamais recalculé ici. */}
      {showLegend && (
        <div className="topology-toolbar-bottom-right">
          <TopologyLegendPanel {...(data?.nutanixLastPoll ? { nutanixLastPoll: data.nutanixLastPoll } : {})} onClose={() => setShowLegend(false)} />
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

      {selectionMenu && operate && (
        <ContextMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onClose={() => setSelectionMenu(null)}
          items={[
            {
              label: `Grouper la sélection (${multiSelectedIds.size})`,
              onClick: () => openCreateGroupPopover(selectionMenu.x, selectionMenu.y),
            },
          ]}
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

      {popover && (
        <CreatePopover
          kind={popover.kind}
          x={popover.x}
          y={popover.y}
          onClose={() => setPopover(null)}
          {...(popover.initialImage ? { initialImage: popover.initialImage } : {})}
        />
      )}

      {templateBuildsPopover && (
        <TemplateBuildsPopover
          templateId={templateBuildsPopover.templateId}
          templateName={templateBuildsPopover.templateName}
          x={templateBuildsPopover.x}
          y={templateBuildsPopover.y}
          onClose={() => setTemplateBuildsPopover(null)}
        />
      )}

      {deployVmModal && (
        <DeployVmModal
          templateName={deployVmModal.templateName}
          artifactReference={deployVmModal.artifactReference}
          onClose={() => setDeployVmModal(null)}
        />
      )}

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
          {...(networkConnectPopover.initialNetworkId ? { initialNetworkId: networkConnectPopover.initialNetworkId } : {})}
          x={networkConnectPopover.x}
          y={networkConnectPopover.y}
          onClose={() => setNetworkConnectPopover(null)}
        />
      )}

      {mountVolumePopover && (
        <MountVolumePopover
          target={mountVolumePopover.target}
          topologyNodes={data?.nodes ?? []}
          x={mountVolumePopover.x}
          y={mountVolumePopover.y}
          onClose={() => setMountVolumePopover(null)}
        />
      )}

      {/* Picker du bouton ＋ (ou "Attacher…"/entrées matérielles du menu) — CONTEXTUEL par kind
          (18/08/2026) : conteneur -> Stockage/Variable (flux par recréation, les variables SONT
          les secrets de la plateforme) ; VM Nutanix -> Disque/Carte réseau/vCPU-Mémoire (mêmes
          entrées que le menu "Update VM" de Prism, backend réel routes/nutanix.ts). */}
      {attachPicker && (
        <ContextMenu
          x={attachPicker.x}
          y={attachPicker.y}
          onClose={() => setAttachPicker(null)}
          items={
            attachPicker.node.kind === "nutanix-vm"
              ? [
                  {
                    label: "Disque…",
                    icon: IconVolumes,
                    onClick: () => setNutanixDiskPopover({ node: attachPicker.node, x: attachPicker.x, y: attachPicker.y }),
                  },
                  {
                    label: "Carte réseau…",
                    icon: IconNetworks,
                    onClick: () => setNutanixNicPopover({ node: attachPicker.node, x: attachPicker.x, y: attachPicker.y }),
                  },
                  {
                    label: "vCPU / Mémoire…",
                    icon: IconServer,
                    onClick: () => setNutanixComputePopover({ node: attachPicker.node, x: attachPicker.x, y: attachPicker.y }),
                  },
                ]
              : [
                  {
                    label: "Stockage (volume)…",
                    icon: IconVolumes,
                    onClick: () =>
                      setMountVolumePopover({ target: { kind: "new-volume", containerNode: attachPicker.node }, x: attachPicker.x, y: attachPicker.y }),
                  },
                  {
                    label: "Variable d'environnement…",
                    icon: IconKey,
                    onClick: () => setAttachEnvPopover({ node: attachPicker.node, x: attachPicker.x, y: attachPicker.y }),
                  },
                ]
          }
        />
      )}

      {nutanixDiskPopover && (
        <NutanixAddDiskPopover
          vmNode={nutanixDiskPopover.node}
          x={nutanixDiskPopover.x}
          y={nutanixDiskPopover.y}
          onClose={() => setNutanixDiskPopover(null)}
        />
      )}

      {nutanixNicPopover && (
        <NutanixAddNicPopover
          vmNode={nutanixNicPopover.node}
          x={nutanixNicPopover.x}
          y={nutanixNicPopover.y}
          onClose={() => setNutanixNicPopover(null)}
        />
      )}

      {nutanixComputePopover && (
        <NutanixComputePopover
          vmNode={nutanixComputePopover.node}
          x={nutanixComputePopover.x}
          y={nutanixComputePopover.y}
          onClose={() => setNutanixComputePopover(null)}
        />
      )}

      {attachEnvPopover && (
        <AttachEnvPopover
          containerNode={attachEnvPopover.node}
          x={attachEnvPopover.x}
          y={attachEnvPopover.y}
          onClose={() => setAttachEnvPopover(null)}
        />
      )}

      {remoteEnvModalOpen && <RemoteEnvironmentCreateModal open onClose={() => setRemoteEnvModalOpen(false)} />}

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
        initialTab={detailInitialTab}
      />
    </div>
  );
}

