import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { pageTitle, setCurrentView, setSearchQuery, setSelectedEnvironmentId } from "@/features/ui/uiSlice";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { canAdminister, logout } from "@/features/auth/authSlice";
import { resetSetup } from "@/features/setup/setupSlice";
import { markAllRead } from "@/features/notifications/notificationsSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { IconBell, IconSearch } from "@/components/icons";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

const SEARCHABLE_VIEWS = new Set(["images", "containers", "registries"]);

export default function Topbar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((state) => state.ui.currentView);
  const searchQuery = useAppSelector((state) => state.ui.searchQuery);
  const selectedEnvironmentId = useAppSelector((state) => state.ui.selectedEnvironmentId);
  const environments = useAppSelector((state) => state.clusters.environments);
  const environmentsStatus = useAppSelector((state) => state.clusters.status);
  const session = useAppSelector((state) => state.auth.session);
  const unreadCount = useAppSelector((state) => state.notifications.items.filter((n) => !n.read).length);
  const confirm = useConfirm();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (environmentsStatus === "idle") {
      dispatch(fetchEnvironments());
    }
  }, [dispatch, environmentsStatus]);

  // Ferme le menu au clic en dehors ou à l'échappement — pattern standard pour un menu
  // déclenché par bouton (pas de librairie de popover dans ce projet, cf. absence de
  // dépendance équivalente dans package.json).
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    const ok = await confirm({
      title: "Déconnexion",
      description: "Vous devrez vous ré-authentifier auprès de l'annuaire LDAP pour revenir.",
      confirmLabel: "Déconnecter",
    });
    if (ok) dispatch(logout());
  }

  async function handleReconfigure() {
    setMenuOpen(false);
    const ok = await confirm({
      title: "Reconfigurer QUAI",
      description:
        "Rouvre l'assistant de configuration (LDAP, Docker, Kubernetes, registries). L'application redevient inaccessible aux autres utilisateurs tant que l'assistant n'est pas terminé.",
      confirmLabel: "Reconfigurer",
      variant: "danger",
    });
    if (ok) dispatch(resetSetup());
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
        }}
      >
        <IconBell />
        {unreadCount > 0 && <span className="topbar__bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>

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
              {canAdminister(session) && (
                <>
                  <div className="profile-menu__divider" />
                  <button
                    type="button"
                    className="profile-menu__item profile-menu__item--neutral"
                    role="menuitem"
                    onClick={handleReconfigure}
                  >
                    Reconfigurer (LDAP, Docker, registries…)
                  </button>
                </>
              )}
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
