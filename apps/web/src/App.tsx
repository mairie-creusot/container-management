import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchSession } from "@/features/auth/authSlice";
import { fetchSetupStatus } from "@/features/setup/setupSlice";
import LoginScreen from "@/features/auth/LoginScreen";
import SetupWizard from "@/features/setup/SetupWizard";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import OverviewPage from "@/features/overview/OverviewPage";
import ImagesPage from "@/features/images/ImagesPage";
import RegistriesPage from "@/features/registries/RegistriesPage";
import ContainersPage from "@/features/containers/ContainersPage";
import VolumesPage from "@/features/volumes/VolumesPage";
import NetworksPage from "@/features/networks/NetworksPage";
import GitOpsPage from "@/features/gitops/GitOpsPage";
import EnvironmentsPage from "@/features/clusters/EnvironmentsPage";
import NotificationsPage from "@/features/notifications/NotificationsPage";
import AuditPage from "@/features/audit/AuditPage";
import TopologyPage from "@/features/topology/TopologyPage";
import IacPage from "@/features/iac/IacPage";
import ToastStack from "@/components/ToastStack";

function renderView(view: string) {
  switch (view) {
    case "overview":
      return <OverviewPage />;
    case "images":
      return <ImagesPage />;
    case "registries":
      return <RegistriesPage />;
    case "containers":
      return <ContainersPage />;
    case "volumes":
      return <VolumesPage />;
    case "networks":
      return <NetworksPage />;
    case "topology":
      return <TopologyPage />;
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
