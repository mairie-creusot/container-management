import { useAppDispatch, useAppSelector } from "@/hooks";
import { clearAllNotifications, dismissNotification } from "@/features/notifications/notificationsSlice";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const LEVEL_LABEL: Record<string, string> = { error: "Erreur", success: "Succès", info: "Info" };

export default function NotificationsPage() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.notifications.items);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Notifications</h2>
          <p>Historique des événements et erreurs de l'application (session courante).</p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => dispatch(clearAllNotifications())}>
            Tout effacer
          </button>
        )}
      </div>

      {items.length === 0 && <div className="empty-state">Aucune notification pour l'instant.</div>}

      {items.length > 0 && (
        <div className="notification-list">
          {items.map((n) => (
            <div key={n.id} className={`notification-row notification-row--${n.level}`}>
              <span className={`notification-row__badge notification-row__badge--${n.level}`}>
                {LEVEL_LABEL[n.level] ?? n.level}
              </span>
              <div className="notification-row__body">
                <span className="notification-row__message">{n.message}</span>
                {n.source && <span className="notification-row__source">{n.source}</span>}
              </div>
              <span className="notification-row__time">{formatDate(n.createdAt)}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dispatch(dismissNotification(n.id))}
              >
                Effacer
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
