import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** false pour les variantes destructrices : pas de fermeture au clic backdrop / touche Échap. */
  dismissible?: boolean;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  dismissible = true,
  labelledBy,
  describedBy,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Bug réel corrigé le 14/08/2026 (retour utilisateur : "ya un probleme des que ecrit une lettre
  // sa se remet sur type" — le focus revenait au premier champ du formulaire à CHAQUE frappe).
  // Root-causé : l'effet de gestion du focus ci-dessous avait `onClose`/`dismissible` en
  // dépendances — `onClose` est presque toujours une fonction déclarée directement dans le corps
  // du composant appelant (ex: `onClose={handleCancelForm}`, jamais enveloppée dans `useCallback`),
  // donc une IDENTITÉ NOUVELLE à CHAQUE rendu du parent. Taper un caractère dans un champ contrôlé
  // déclenche un `setState` → un rendu du parent → un nouvel `onClose` → cet effet se redéclenchait
  // en entier, y compris `(first ?? dialog)?.focus()` qui vole le focus vers le PREMIER champ
  // focusable de la modale. Un ref garde `onClose`/`dismissible` toujours à jour SANS faire partie
  // des dépendances de l'effet de focus : celui-ci ne se redéclenche donc plus que sur une VRAIE
  // ouverture/fermeture (`open`), jamais sur un simple changement de référence de fonction.
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  // Ouverture : mémorise le focus courant, déplace le focus dans la modale,
  // pose le piège de focus (Tab/Shift+Tab) et l'écoute d'Échap.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    const first = focusables && focusables.length > 0 ? focusables[0] : undefined;
    (first ?? dialog)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (dismissibleRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key === "Tab" && dialog) {
        const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null,
        );
        const firstEl = nodes[0];
        const lastEl = nodes[nodes.length - 1];
        if (!firstEl || !lastEl) return;
        if (event.shiftKey && document.activeElement === firstEl) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        ref={dialogRef}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
