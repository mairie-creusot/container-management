import { useEffect, useState } from "react";
import { useAppSelector } from "@/hooks";
import type { AppNotification } from "@/features/notifications/notificationsSlice";

const AUTO_DISMISS_MS = 6000;

/**
 * Toasts éphémères en bas à droite pour les notifications qui arrivent pendant que l'app est
 * ouverte — l'historique complet (lu/non lu, tout conserver) vit sur la page Notifications
 * (voir notificationsSlice.ts), ce composant n'affiche que les tout derniers événements.
 */
export default function ToastStack() {
  const items = useAppSelector((s) => s.notifications.items);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [seenIds] = useState(() => new Set<string>());

  useEffect(() => {
    const fresh = items.filter((n) => !seenIds.has(n.id)).slice(0, 4);
    if (fresh.length === 0) return;
    for (const n of fresh) seenIds.add(n.id);
    setVisibleIds((prev) => [...fresh.map((n) => n.id), ...prev]);
    const timers = fresh.map((n) =>
      setTimeout(() => {
        setVisibleIds((prev) => prev.filter((id) => id !== n.id));
      }, AUTO_DISMISS_MS),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const visible = visibleIds
    .map((id) => items.find((n) => n.id === id))
    .filter((n): n is AppNotification => n !== undefined);

  if (visible.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {visible.map((n) => (
        <div key={n.id} className={`toast toast--${n.level}`}>
          <span className="toast__message">{n.message}</span>
          <button
            type="button"
            className="toast__dismiss"
            onClick={() => setVisibleIds((prev) => prev.filter((id) => id !== n.id))}
            aria-label="Fermer"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
