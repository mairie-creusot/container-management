import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "@/hooks";
import type { AppNotification } from "@/features/notifications/notificationsSlice";

const AUTO_DISMISS_MS = 3000;
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
  // Un timer de disparition PAR toast, indexé par id — bug réel corrigé le 13/08/2026 (retour
  // utilisateur : "les notification ne disparaisse pas automatiquement", capture montrant
  // plusieurs toasts empilés qui ne partaient jamais). Avant : les setTimeout vivaient dans une
  // variable locale de l'effet ci-dessous, nettoyés en bloc par sa fonction de cleanup à CHAQUE
  // ré-exécution (déclenchée par tout changement de `items`, y compris l'arrivée d'une notification
  // SANS RAPPORT) — dès qu'une deuxième notification arrivait avant les 3s du délai de la
  // première, le timer de la première était annulé et jamais reprogrammé (elle n'était déjà plus
  // dans `fresh` au tour suivant, seenIds l'ayant marquée) : elle restait affichée indéfiniment.
  // Une ref (persiste entre rendus, ne déclenche aucun re-render) découple le cycle de vie de
  // chaque timer de celui de l'effet qui les crée.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
    // PAS de cleanup ici qui annulerait ces timers : chacun doit survivre indépendamment d'une
    // future ré-exécution de cet effet (voir timersRef ci-dessus) — seul `dismiss` (départ anticipé
    // au clic, ou ce même délai qui expire normalement) ou le démontage du composant (effet séparé
    // juste en dessous) doivent jamais les annuler.
    for (const n of fresh) {
      timersRef.current.set(
        n.id,
        setTimeout(() => dismiss(n.id), AUTO_DISMISS_MS),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Démontage réel du composant UNIQUEMENT (deps []) — évite un setState après unmount, sans
  // jamais interférer avec le cycle de vie normal de chaque timer individuel ci-dessus.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  function dismiss(id: string) {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
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
