import { useEffect, useMemo, useState } from "react";
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
import type { PluginNavItem } from "@/features/plugins/pluginsModel";
import { buildSettingsSections } from "@/features/settings/settingsSections";
import { canAdminister, canOperate } from "@/features/auth/authSlice";
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
  IconPuzzle,
  IconVm,
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
  nutanix: IconVm,
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
  const plugins = useAppSelector((state) => state.plugins);
  const pluginNavItems = usePluginNavItems();
  const confirm = useConfirm();

  const [extensionsOpen, setExtensionsOpen] = useState(readExtensionsOpen);
  const activeIsExtension = pluginNavItems.some((item) => item.target.kind === "page" && item.target.view === currentView);
  // Section de Réglages d'un module qui n'apporte ni page ni nœud : c'est tout ce qu'il a à ouvrir.
  const sections = useMemo(() => buildSettingsSections(plugins), [plugins]);

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

  /** Où mène l'entrée d'un module : sa page, le graphe où vivent ses nœuds, ou sa configuration. */
  async function handlePluginNav(item: PluginNavItem) {
    if (item.target.kind === "page") return handleNavigate(item.target.view);
    if (item.target.kind === "graph") return handleNavigate("clusters");
    if (currentView !== "settings" && !(await confirmLeaveCurrentView())) return;
    const section = sections.find((entry) => entry.pluginId === item.pluginId);
    dispatch(openSettingsSection(section?.id ?? item.pluginId));
  }

  /** Ce que l'entrée va ouvrir, dit avant le clic — un module sans page n'a pas à surprendre. */
  function navHint(item: PluginNavItem): string {
    const suffix =
      item.target.kind === "graph"
        ? " — ses machines et ses liens sont dans le graphe des Environnements"
        : item.target.kind === "settings"
          ? " — ce module n'apporte que sa configuration"
          : "";
    return `${item.label}${item.needsConfiguration ? " — à configurer" : ""}${suffix}`;
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
                  const Icon = PLUGIN_ICONS[item.pluginId] ?? IconPuzzle;
                  const active = item.target.kind === "page" && currentView === item.target.view;
                  return (
                    <button
                      key={item.pluginId}
                      type="button"
                      className={`sidebar__item sidebar__item--nested${active ? " is-active" : ""}`}
                      onClick={() => void handlePluginNav(item)}
                      title={navHint(item)}
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

        {/* « Extensions » liste ce que les modules APPORTENT ; « Modules » est l'endroit où on les
            installe, active et retire — d'où sa place juste sous le tiroir. */}
        {canAdminister(session) && (
          <button
            type="button"
            className={`sidebar__item${currentView === "modules" ? " is-active" : ""}`}
            onClick={() => handleNavigate("modules")}
            title={pageTitle("modules")}
          >
            <span className="sidebar__icon">
              <IconPuzzle />
            </span>
            {pageTitle("modules")}
          </button>
        )}

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

        {/* Traçabilité ouverte à qui AGIT sur le parc, pas seulement aux admins : une équipe doit
            voir ce que font ses collègues sur les mêmes machines. */}
        {canOperate(session) && (
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
