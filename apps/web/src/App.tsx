import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchSession } from "@/features/auth/authSlice";
import { fetchSetupStatus } from "@/features/setup/setupSlice";
import { fetchSystemNotifications } from "@/features/notifications/notificationsSlice";
import LoginScreen from "@/features/auth/LoginScreen";
import SetupWizard from "@/features/setup/SetupWizard";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import OverviewPage from "@/features/overview/OverviewPage";
import ImagesPage from "@/features/images/ImagesPage";
import RegistriesPage from "@/features/registries/RegistriesPage";
import RegistryExplorerPage from "@/features/registries/RegistryExplorerPage";
import SecretsPage from "@/features/secrets/SecretsPage";
import ContainersPage from "@/features/containers/ContainersPage";
import VolumesPage from "@/features/volumes/VolumesPage";
import NetworksPage from "@/features/networks/NetworksPage";
import ReverseProxyPage from "@/features/reverseProxy/ReverseProxyPage";
import GitOpsPage from "@/features/gitops/GitOpsPage";
import EnvironmentsPage from "@/features/clusters/EnvironmentsPage";
import NotificationsPage from "@/features/notifications/NotificationsPage";
import AuditPage from "@/features/audit/AuditPage";
import IacPage from "@/features/iac/IacPage";
import ToastStack from "@/components/ToastStack";

// Notifications système (watchdog proactif côté API — nouvelle version d'image, intégration
// devenue injoignable/de nouveau joignable) : câblé ici plutôt que dans une page précise, pour
// rester actif quelle que soit la vue affichée (même principe que la cloche du Topbar, toujours
// visible). Intervalle volontairement plus lâche que le dashboard (voir OverviewPage.tsx) :
// ces événements sont eux-mêmes émis par un cycle serveur de 60-90s, inutile de poller plus vite.
const NOTIFICATIONS_REFRESH_INTERVAL_MS = 20_000;

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
    case "volumes":
      return <VolumesPage />;
    case "networks":
      return <NetworksPage />;
    case "reverse-proxy":
      return <ReverseProxyPage />;
    case "iac":
      return <IacPage />;
    case "gitops":
      return <GitOpsPage />;
    case "clusters":
      return <EnvironmentsPage />;
    case "notifications":
      return <NotificationsPage />;
    case "audit":
      return <AuditPage />;
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
        {renderView(currentView)}
      </div>
      <ToastStack />
    </div>
  );
}
