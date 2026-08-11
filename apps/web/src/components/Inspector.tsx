import type { ReactNode } from "react";
import { IconClose } from "@/components/icons";

interface InspectorProps {
  title?: string | undefined;
  subtitle?: string | undefined;
  onClose?: (() => void) | undefined;
  emptyLabel?: string | undefined;
  children?: ReactNode;
}

export default function Inspector({ title, subtitle, onClose, emptyLabel, children }: InspectorProps) {
  if (!title) {
    return (
      <aside className="inspector">
        <div className="inspector__empty">
          {emptyLabel ?? "Sélectionnez un élément pour afficher son détail."}
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <div>
          <div className="inspector__title">{title}</div>
          {subtitle && <div className="inspector__subtitle">{subtitle}</div>}
        </div>
        {onClose && (
          <button type="button" className="inspector__close" onClick={onClose} aria-label="Fermer">
            <IconClose />
          </button>
        )}
      </div>
      <div className="inspector__body">{children}</div>
    </aside>
  );
}
