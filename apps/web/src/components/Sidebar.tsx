import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  NAV_ITEMS,
  openSettingsSection,
  pageTitle,
  setCurrentView,
  setUnsavedFormActive,
  type ViewId,
} from "@/features/ui/uiSlice";
import { usePluginNavItems } from "@/features/plugins/usePluginNav";
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
  IconChevron,
  IconHistory,
  IconKey,
  IconGlobe,
  IconBackup,
  IconLifebuoy,
  IconPhone,
  IconStack,
} from "@/components/icons";

type IconComponent = (props: { className?: string }) => JSX.Element;

const ICONS: Partial<Record<ViewId, IconComponent>> = {
  overview: IconOverview,
  images: IconImages,
  registries: IconRegistries,
  containers: IconContainers,
  publication: IconGlobe,
  clusters: IconClusters,
  notifications: IconBell,
  audit: IconHistory,
};

/** Icône par greffon (id du manifeste), pas par vue : un greffon apporte sa page ET son icône. */
const PLUGIN_ICONS: Record<string, IconComponent> = {
  hycu: IconBackup,
  "3cx": IconPhone,
  glpi: IconLifebuoy,
};

const EXTENSIONS_OPEN_KEY = "quai.sidebar.extensions";

function readExtensionsOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(EXTENSIONS_OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

function writeExtensionsOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(EXTENSIONS_OPEN_KEY, open ? "open" : "closed");
  } catch {
    /* stockage indisponible (mode privé, quota) : le tiroir reste simplement volatile */
  }
}

export default function Sidebar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((state) => state.ui.currentView);
  const unsavedFormActive = useAppSelector((state) => state.ui.unsavedFormActive);
  const session = useAppSelector((state) => state.auth.session);
  const pluginNavItems = usePluginNavItems();
  const confirm = useConfirm();

  const [extensionsOpen, setExtensionsOpen] = useState(readExtensionsOpen);
  const activeIsExtension = pluginNavItems.some((item) => item.view === currentView);

  // Arriver sur une page d'extension (renvoi depuis les Réglages, par exemple) déplie le tiroir :
  // sinon l'entrée active serait invisible. Choix non mémorisé — seul un clic sur l'en-tête l'est.
  useEffect(() => {
    if (activeIsExtension) setExtensionsOpen(true);
  }, [activeIsExtension]);

  async function confirmLeaveCurrentView(): Promise<boolean> {
    if (!unsavedFormActive) return true;
    const ok = await confirm({
      title: "Modifications non enregistrées",
      description:
        "Un formulaire de cette page contient des modifications non enregistrées. Changer de vue les abandonnera.",
      confirmLabel: "Changer de vue quand même",
      cancelLabel: "Rester sur cette page",
      variant: "danger",
    });
    if (!ok) return false;
    dispatch(setUnsavedFormActive(false));
    return true;
  }

  async function handleNavigate(id: ViewId) {
    if (id === currentView) return;
    if (!(await confirmLeaveCurrentView())) return;
    dispatch(setCurrentView(id));
  }

  async function handleOpenSettings() {
    if (currentView !== "settings" && !(await confirmLeaveCurrentView())) return;
    dispatch(openSettingsSection(null));
  }

  function toggleExtensions() {
    const next = !extensionsOpen;
    setExtensionsOpen(next);
    writeExtensionsOpen(next);
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

        <div className="sidebar__group">
          <button
            type="button"
            className={`sidebar__item sidebar__group-toggle${activeIsExtension && !extensionsOpen ? " is-active" : ""}`}
            onClick={toggleExtensions}
            aria-expanded={extensionsOpen}
            title={`Extensions — ${pluginNavItems.length} activée(s)`}
          >
            <span className="sidebar__icon">
              <IconStack />
            </span>
            <span className="sidebar__group-label">Extensions</span>
            <span className="sidebar__group-count">{pluginNavItems.length}</span>
            <span className={`sidebar__group-chevron${extensionsOpen ? " is-open" : ""}`}>
              <IconChevron />
            </span>
          </button>

          {extensionsOpen &&
            (pluginNavItems.length === 0 ? (
              <div className="sidebar__group-empty">
                <p>Aucune extension activée.</p>
                <button type="button" className="sidebar__group-link" onClick={handleOpenSettings}>
                  Activer une intégration dans les Réglages
                </button>
              </div>
            ) : (
              <div className="sidebar__group-items">
                {pluginNavItems.map((item) => {
                  const Icon = PLUGIN_ICONS[item.pluginId] ?? IconStack;
                  return (
                    <button
                      key={item.pluginId}
                      type="button"
                      className={`sidebar__item sidebar__item--nested${currentView === item.view ? " is-active" : ""}`}
                      onClick={() => handleNavigate(item.view)}
                      title={item.needsConfiguration ? `${item.label} — à configurer` : item.label}
                    >
                      <span className="sidebar__icon">
                        <Icon />
                      </span>
                      <span className="sidebar__item-label">{item.label}</span>
                      {item.needsConfiguration && <span className="sidebar__dot" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>

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

        {/* « DNS Active Directory » a quitté ce menu le 24/08/2026 : son formulaire et son
            diagnostic de compte vivent dans les Réglages (menu engrenage du Topbar), et ses données
            métier sur le nœud de la VM contrôleur de domaine (module « ad-dns » du graphe). */}

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
