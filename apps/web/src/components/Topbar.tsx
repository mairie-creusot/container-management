import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  openSettingsSection,
  pageTitle,
  setCurrentView,
  setSearchQuery,
  setSelectedEnvironmentId,
} from "@/features/ui/uiSlice";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { canAdminister, logout } from "@/features/auth/authSlice";
import { markAllRead, markServerNotificationsRead } from "@/features/notifications/notificationsSlice";
import { buildSettingsSections } from "@/features/settings/settingsSections";
import { useConfirm } from "@/components/ConfirmProvider";
import { IconBell, IconSearch, IconSettings } from "@/components/icons";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

// "secrets" : SecretsPage.tsx filtre déjà `items` sur `state.ui.searchQuery` (par nom), mais
// sans entrée ici ce champ de recherche n'était jamais affiché — la liste devient longue avec
// des dizaines de secrets, ce filtre existant restait donc inutilisable en pratique.
const SEARCHABLE_VIEWS = new Set(["images", "containers", "registries", "secrets"]);

export default function Topbar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((state) => state.ui.currentView);
  const searchQuery = useAppSelector((state) => state.ui.searchQuery);
  const selectedEnvironmentId = useAppSelector((state) => state.ui.selectedEnvironmentId);
  const environments = useAppSelector((state) => state.clusters.environments);
  const environmentsStatus = useAppSelector((state) => state.clusters.status);
  const session = useAppSelector((state) => state.auth.session);
  const unreadCount = useAppSelector((state) => state.notifications.items.filter((n) => !n.read).length);
  const plugins = useAppSelector((state) => state.plugins);
  const confirm = useConfirm();

  // Même dérivation que la page Réglages : un module installé à chaud entre dans ce menu sans
  // qu'une liste statique ait à être retouchée.
  const settingsSections = useMemo(() => buildSettingsSections(plugins), [plugins]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (environmentsStatus === "idle") {
      dispatch(fetchEnvironments());
    }
  }, [dispatch, environmentsStatus]);

  // Ferme le menu ouvert au clic en dehors ou à l'échappement — pattern standard pour un menu
  // déclenché par bouton (pas de librairie de popover dans ce projet, cf. absence de
  // dépendance équivalente dans package.json). Les deux menus (profil, Réglages) partagent
  // l'écouteur : un seul est ouvert à la fois.
  useEffect(() => {
    if (!menuOpen && !settingsOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
      if (settingsRef.current && !settingsRef.current.contains(target)) setSettingsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setSettingsOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen, settingsOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    const ok = await confirm({
      title: "Déconnexion",
      description: "Vous devrez vous ré-authentifier auprès de l'annuaire LDAP pour revenir.",
      confirmLabel: "Déconnecter",
    });
    if (ok) dispatch(logout());
  }

  function openSettings(sectionId: string | null) {
    setSettingsOpen(false);
    dispatch(openSettingsSection(sectionId));
  }

  return (
    <header className="topbar">
      <h1 className="topbar__title">{pageTitle(currentView)}</h1>

      {SEARCHABLE_VIEWS.has(currentView) && (
        <div className="topbar__search">
          <IconSearch />
          <input
            type="text"
            placeholder="Rechercher…"
            value={searchQuery}
            onChange={(event) => dispatch(setSearchQuery(event.target.value))}
          />
        </div>
      )}

      <div className="topbar__spacer" />

      <select
        className="topbar__env-select"
        value={selectedEnvironmentId ?? ""}
        onChange={(event) =>
          dispatch(setSelectedEnvironmentId(event.target.value === "" ? null : event.target.value))
        }
      >
        <option value="">Tous les environnements</option>
        {environments.map((env) => (
          <option key={env.id} value={env.id}>
            {env.name}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="topbar__bell"
        aria-label="Notifications"
        onClick={() => {
          dispatch(setCurrentView("notifications"));
          dispatch(markAllRead());
          // Persiste le "tout lu" côté serveur pour les notifications système (watchdog) —
          // silencieux en cas d'échec (viewer sans droit, réseau...), voir
          // errorNotificationMiddleware.ts.
          void dispatch(markServerNotificationsRead());
        }}
      >
        <IconBell />
        {unreadCount > 0 && <span className="topbar__bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>

      {/* Menu Réglages — toutes les configurations d'intégration, réservé aux admins (la vue
          "settings" refuse elle aussi les autres rôles). Ouvre la page dédiée sur la section
          choisie ; la liste est dérivée des modules réellement chargés, jamais recopiée ici. */}
      {canAdminister(session) && (
        <div className="topbar__settings" ref={settingsRef}>
          <button
            type="button"
            className="topbar__icon-btn"
            aria-label="Réglages"
            title="Réglages"
            aria-expanded={settingsOpen}
            aria-haspopup="menu"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <IconSettings />
          </button>

          {settingsOpen && (
            <div className="profile-menu settings-menu" role="menu">
              <div className="settings-menu__title">Réglages</div>
              {settingsSections.map((section) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    type="button"
                    className="profile-menu__item profile-menu__item--neutral settings-menu__item"
                    role="menuitem"
                    onClick={() => openSettings(section.id)}
                  >
                    <span className="settings-menu__icon">
                      <Icon />
                    </span>
                    {section.label}
                  </button>
                );
              })}
              <div className="profile-menu__divider" />
              <button
                type="button"
                className="profile-menu__item profile-menu__item--neutral"
                role="menuitem"
                onClick={() => openSettings(null)}
              >
                Tous les réglages
              </button>
            </div>
          )}
        </div>
      )}

      {session && (
        <div className="topbar__user" ref={menuRef}>
          <button
            type="button"
            className="topbar__user-trigger"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <div className="topbar__avatar">{initials(session.displayName)}</div>
            <div className="topbar__user-meta">
              <span className="topbar__user-name">{session.displayName}</span>
              <span className="topbar__user-role">{session.roles.join(", ")}</span>
            </div>
          </button>

          {menuOpen && (
            <div className="profile-menu" role="menu">
              <div className="profile-menu__header">
                <div className="topbar__avatar topbar__avatar--lg">{initials(session.displayName)}</div>
                <div>
                  <div className="profile-menu__name">{session.displayName}</div>
                  <div className="profile-menu__username">{session.username}</div>
                </div>
              </div>
              <div className="profile-menu__roles">
                {session.roles.map((role) => (
                  <span key={role} className="profile-menu__role-badge">
                    {role}
                  </span>
                ))}
              </div>
              {/* Ce menu ne garde que l'identité, le rôle et la déconnexion : la reconfiguration
                  (LDAP, Docker, registries) a rejoint le menu Réglages, avec les autres
                  intégrations. */}
              <div className="profile-menu__divider" />
              <button type="button" className="profile-menu__item" role="menuitem" onClick={handleLogout}>
                Déconnexion
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
