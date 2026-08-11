import { useEffect, useState } from "react";
import { useAppSelector } from "@/hooks";
import type { AppNotification } from "@/features/notifications/notificationsSlice";

const AUTO_DISMISS_MS = 6000;
// Doit correspondre à la durée de @keyframes toast-out (apps/web/src/styles/base.css) — le
// toast reste dans le DOM le temps de l'animation de sortie avant d'être vraiment retiré.
const LEAVE_ANIMATION_MS = 180;

// Curseur "déjà toasté" persisté — sans lui, seenIds (en mémoire, remis à zéro à chaque montage
// du composant) ne protège que dans la session en cours : un simple rechargement de page faisait
// ressortir en toast tout ce qui n'était pas encore explicitement marqué lu (clic sur la cloche),
// même une notification déjà vue plusieurs fois. Voir aussi le filtre !n.read ci-dessous.
const LAST_TOASTED_KEY = "quai:toasts:lastSeenAt";

function loadLastToastedAt(): string {
  try {
    return localStorage.getItem(LAST_TOASTED_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastToastedAt(iso: string): void {
  try {
    localStorage.setItem(LAST_TOASTED_KEY, iso);
  } catch {
    // Stockage indisponible (navigation privée, quota) — la dédup ne survivra pas au
    // rechargement, mais seenIds continue de protéger dans la session en cours.
  }
}

/**
 * Toasts éphémères en bas à droite pour les notifications qui arrivent pendant que l'app est
 * ouverte — l'historique complet (lu/non lu, tout conserver) vit sur la page Notifications
 * (voir notificationsSlice.ts), ce composant n'affiche que les tout derniers événements.
 */
export default function ToastStack() {
  const items = useAppSelector((s) => s.notifications.items);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  // Toasts en cours de sortie (fondu) — retirés de visibleIds seulement une fois l'animation
  // terminée, pour éviter une disparition brute.
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());
  const [seenIds] = useState(() => new Set<string>());
  const [lastToastedAt, setLastToastedAt] = useState(() => loadLastToastedAt());

  useEffect(() => {
    // !n.read exclut les notifications système déjà connues au chargement (fetchSystemNotifications
    // recharge en une fois jusqu'à 300 événements historiques persistés côté API, voir
    // notificationsSlice.ts) ; n.createdAt > lastToastedAt exclut tout ce qui a déjà été toasté
    // lors d'une session/rechargement précédent (persisté dans localStorage, contrairement à
    // seenIds qui ne protège que le montage courant) — sans ça, une notification pas encore
    // marquée lue ressortait en toast à chaque rechargement de page. Les notifications purement
    // client (pushNotification/errorNotificationMiddleware) naissent avec un createdAt "à
    // l'instant", donc toujours postérieur au curseur : leur comportement est inchangé.
    const fresh = items.filter((n) => !seenIds.has(n.id) && !n.read && n.createdAt > lastToastedAt).slice(0, 4);
    if (fresh.length === 0) return;
    for (const n of fresh) seenIds.add(n.id);
    const newestSeen = fresh.reduce((max, n) => (n.createdAt > max ? n.createdAt : max), lastToastedAt);
    setLastToastedAt(newestSeen);
    saveLastToastedAt(newestSeen);
    setVisibleIds((prev) => [...fresh.map((n) => n.id), ...prev]);
    const timers = fresh.map((n) => setTimeout(() => dismiss(n.id), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function dismiss(id: string) {
    setLeavingIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setVisibleIds((prev) => prev.filter((v) => v !== id));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, LEAVE_ANIMATION_MS);
  }

  const visible = visibleIds
    .map((id) => items.find((n) => n.id === id))
    .filter((n): n is AppNotification => n !== undefined);

  if (visible.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {visible.map((n) => (
        <div key={n.id} className={`toast toast--${n.level}${leavingIds.has(n.id) ? " toast--leaving" : ""}`}>
          <span className="toast__message">{n.message}</span>
          <button type="button" className="toast__dismiss" onClick={() => dismiss(n.id)} aria-label="Fermer">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
