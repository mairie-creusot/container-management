import { lazy, Suspense, useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchSession } from "@/features/auth/authSlice";
import { fetchSetupStatus } from "@/features/setup/setupSlice";
import { fetchSystemNotifications } from "@/features/notifications/notificationsSlice";
import LoginScreen from "@/features/auth/LoginScreen";
import SetupWizard from "@/features/setup/SetupWizard";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ToastStack from "@/components/ToastStack";

// Code-splitting par page (docs/reports/optimization-audit-2026-08-12.md §É7) : sans lazy(),
// les 17 pages de renderView() ci-dessous (dont @xyflow/react pour la Vue d'ensemble et
// @xterm/xterm via ContainersPage/ContainerConsole) finissaient TOUTES dans le même bundle
// initial (~1,02 Mo mesuré) quelle que soit la page réellement visitée. Chaque import() dynamique
// devient son propre chunk, chargé au premier accès à la vue puis mis en cache par le navigateur.
const OverviewPage = lazy(() => import("@/features/overview/OverviewPage"));
const ImagesPage = lazy(() => import("@/features/images/ImagesPage"));
const RegistriesPage = lazy(() => import("@/features/registries/RegistriesPage"));
const RegistryExplorerPage = lazy(() => import("@/features/registries/RegistryExplorerPage"));
const SecretsPage = lazy(() => import("@/features/secrets/SecretsPage"));
const ContainersPage = lazy(() => import("@/features/containers/ContainersPage"));
const ReverseProxyPage = lazy(() => import("@/features/reverseProxy/ReverseProxyPage"));
const AdDnsPage = lazy(() => import("@/features/adDns/AdDnsPage"));
const NotificationChannelsPage = lazy(() => import("@/features/notificationChannels/NotificationChannelsPage"));
const EnvironmentsPage = lazy(() => import("@/features/clusters/EnvironmentsPage"));
const NotificationsPage = lazy(() => import("@/features/notifications/NotificationsPage"));
const AuditPage = lazy(() => import("@/features/audit/AuditPage"));
const HycuPage = lazy(() => import("@/features/hycu/HycuPage"));
const ExagridPage = lazy(() => import("@/features/exagrid/ExagridPage"));
const ThreecxPage = lazy(() => import("@/features/threecx/ThreecxPage"));
const GlpiPage = lazy(() => import("@/features/glpi/GlpiPage"));
const CertificatesPage = lazy(() => import("@/features/certificates/CertificatesPage"));

// Notifications système (watchdog proactif côté API — nouvelle version d'image, intégration
// devenue injoignable/de nouveau joignable) : câblé ici plutôt que dans une page précise, pour
// rester actif quelle que soit la vue affichée (même principe que la cloche du Topbar, toujours
// visible). Intervalle volontairement plus lâche que le dashboard (voir OverviewPage.tsx) :
// ces événements sont eux-mêmes émis par un cycle serveur de 60-90s, inutile de poller plus vite.
const NOTIFICATIONS_REFRESH_INTERVAL_MS = 20_000;

/** Fallback de <Suspense> pendant le chargement du chunk d'une page — même silhouette
 * (spinner + libellé) que les écrans de chargement déjà présents plus bas dans ce fichier
 * (vérification de session/config), pour rester cohérent avec le reste du design system plutôt
 * que d'introduire un nouveau pattern de chargement. */
function PageLoadingFallback() {
  return (
    <div className="center-screen">
      <div className="spinner" />
      <span>Chargement…</span>
    </div>
  );
}

function renderView(view: string) {
  switch (view) {
    case "overview":
      return <OverviewPage />;
    case "images":
      return <ImagesPage />;
    case "registries":
      return <RegistriesPage />;
    case "registry-explorer":
      return <RegistryExplorerPage />;
    case "secrets":
      return <SecretsPage />;
    case "containers":
      return <ContainersPage />;
    case "reverse-proxy":
      return <ReverseProxyPage />;
    case "ad-dns":
      return <AdDnsPage />;
    case "notification-channels":
      return <NotificationChannelsPage />;
    case "clusters":
      return <EnvironmentsPage />;
    case "notifications":
      return <NotificationsPage />;
    case "audit":
      return <AuditPage />;
    case "hycu":
      return <HycuPage />;
    case "exagrid":
      return <ExagridPage />;
    case "threecx":
      return <ThreecxPage />;
    case "glpi":
      return <GlpiPage />;
    case "certificates":
      return <CertificatesPage />;
    default:
      return <OverviewPage />;
  }
}

export default function App() {
  const dispatch = useAppDispatch();
  const { session, status: authStatus } = useAppSelector((state) => state.auth);
  const setupCompleted = useAppSelector((state) => state.setup.completed);
  const currentView = useAppSelector((state) => state.ui.currentView);

  // ARCHITECTURE.md § "Assistant de configuration au premier lancement" :
  // GET /api/setup/status est vérifié avant toute autre décision d'affichage.
  useEffect(() => {
    dispatch(fetchSetupStatus());
  }, [dispatch]);

  useEffect(() => {
    if (setupCompleted === true && authStatus === "idle") {
      dispatch(fetchSession());
    }
  }, [dispatch, setupCompleted, authStatus]);

  // Poll des notifications système une fois une session active — pas avant (sinon 401 en
  // boucle tant que l'utilisateur n'est pas connecté, cf. SILENT_PREFIXES dans
  // errorNotificationMiddleware.ts qui les rend silencieux mais autant ne pas les déclencher).
  useEffect(() => {
    if (!session) return;
    dispatch(fetchSystemNotifications());
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") dispatch(fetchSystemNotifications());
    }, NOTIFICATIONS_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch, session]);

  if (setupCompleted === null) {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <span>Vérification de la configuration…</span>
      </div>
    );
  }

  if (!setupCompleted) {
    return <SetupWizard />;
  }

  if (authStatus === "idle" || authStatus === "checking") {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <span>Vérification de la session…</span>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-column">
        <Topbar />
        <Suspense fallback={<PageLoadingFallback />}>{renderView(currentView)}</Suspense>
      </div>
      <ToastStack />
    </div>
  );
}
