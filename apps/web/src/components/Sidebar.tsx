import { useAppDispatch, useAppSelector } from "@/hooks";
import { NAV_ITEMS, pageTitle, setCurrentView, setUnsavedFormActive, type ViewId } from "@/features/ui/uiSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Brand from "@/components/Brand";
import {
  IconOverview,
  IconImages,
  IconRegistries,
  IconContainers,
  IconClusters,
  IconBell,
  IconHistory,
  IconKey,
  IconGlobe,
  IconServer,
  IconBackup,
  IconCertificate,
  IconLifebuoy,
  IconPhone,
  IconStorageArray,
} from "@/components/icons";

const ICONS: Partial<Record<ViewId, (props: { className?: string }) => JSX.Element>> = {
  overview: IconOverview,
  images: IconImages,
  registries: IconRegistries,
  containers: IconContainers,
  "reverse-proxy": IconGlobe,
  clusters: IconClusters,
  hycu: IconBackup,
  exagrid: IconStorageArray,
  threecx: IconPhone,
  glpi: IconLifebuoy,
  certificates: IconCertificate,
  notifications: IconBell,
  audit: IconHistory,
};

export default function Sidebar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((state) => state.ui.currentView);
  const unsavedFormActive = useAppSelector((state) => state.ui.unsavedFormActive);
  const session = useAppSelector((state) => state.auth.session);
  const confirm = useConfirm();

  async function handleNavigate(id: ViewId) {
    if (id === currentView) return;
    if (unsavedFormActive) {
      const ok = await confirm({
        title: "Modifications non enregistrées",
        description:
          "Un formulaire de cette page contient des modifications non enregistrées. Changer de vue les abandonnera.",
        confirmLabel: "Changer de vue quand même",
        cancelLabel: "Rester sur cette page",
        variant: "danger",
      });
      if (!ok) return;
      dispatch(setUnsavedFormActive(false));
    }
    dispatch(setCurrentView(id));
  }

  return (
    <nav className="sidebar">
      <div className="sidebar__brand">
        <Brand size="sm" />
      </div>
      <div className="sidebar__nav">
        {NAV_ITEMS.map((item) => {
          // NAV_ITEMS n'inclut jamais "notifications" (accessible via la cloche du Topbar) —
          // tous les autres ViewId y ont une icône, d'où le non-null assertion ici.
          const Icon = ICONS[item.id]!;
          return (
            <button
              key={item.id}
              type="button"
              className={`sidebar__item${currentView === item.id ? " is-active" : ""}`}
              onClick={() => handleNavigate(item.id)}
              title={item.label}
            >
              <span className="sidebar__icon">
                <Icon />
              </span>
              {item.label}
            </button>
          );
        })}

        {canAdminister(session) && (
          <button
            type="button"
            className={`sidebar__item${currentView === "secrets" ? " is-active" : ""}`}
            onClick={() => handleNavigate("secrets")}
            title={pageTitle("secrets")}
          >
            <span className="sidebar__icon">
              <IconKey />
            </span>
            {pageTitle("secrets")}
          </button>
        )}

        {canAdminister(session) && (
          <button
            type="button"
            className={`sidebar__item${currentView === "audit" ? " is-active" : ""}`}
            onClick={() => handleNavigate("audit")}
            title={pageTitle("audit")}
          >
            <span className="sidebar__icon">
              <IconHistory />
            </span>
            {pageTitle("audit")}
          </button>
        )}

        {canAdminister(session) && (
          <button
            type="button"
            className={`sidebar__item${currentView === "ad-dns" ? " is-active" : ""}`}
            onClick={() => handleNavigate("ad-dns")}
            title={pageTitle("ad-dns")}
          >
            <span className="sidebar__icon">
              <IconServer />
            </span>
            {pageTitle("ad-dns")}
          </button>
        )}

        {canAdminister(session) && (
          <button
            type="button"
            className={`sidebar__item${currentView === "notification-channels" ? " is-active" : ""}`}
            onClick={() => handleNavigate("notification-channels")}
            title={pageTitle("notification-channels")}
          >
            <span className="sidebar__icon">
              <IconBell />
            </span>
            {pageTitle("notification-channels")}
          </button>
        )}

      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__footer">© 2026 - Mairie Le Creusot</div>
    </nav>
  );
}
