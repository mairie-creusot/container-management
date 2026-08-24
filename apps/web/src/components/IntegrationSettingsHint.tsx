import type { ReactNode } from "react";
import { useAppDispatch } from "@/hooks";
import { setCurrentView, type ViewId } from "@/features/ui/uiSlice";

// Identifiant de la vue « Réglages », construite séparément : typé `string` pour que ce fichier
// compile avant qu'elle n'existe dans ViewId — SEUL endroit à corriger si l'id retenu diffère.
const SETTINGS_VIEW: string = "settings";

/** Bouton de renvoi vers la page Réglages — les pages métier n'hébergent plus de formulaire. */
export function OpenSettingsButton({ label = "Ouvrir les Réglages" }: { label?: string }) {
  const dispatch = useAppDispatch();
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => dispatch(setCurrentView(SETTINGS_VIEW as ViewId))}
    >
      {label}
    </button>
  );
}

interface IntegrationSettingsHintProps {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  /** Seul un administrateur peut configurer une intégration : les autres voient pourquoi. */
  admin: boolean;
  className?: string;
}

/** État « non configuré » d'une intégration : ce qui manque, et où le renseigner. */
export default function IntegrationSettingsHint({
  title,
  description,
  icon,
  admin,
  className = "empty-state",
}: IntegrationSettingsHintProps) {
  return (
    <div className={className}>
      {icon}
      <strong>{title}</strong>
      <span>{description}</span>
      {admin ? (
        <OpenSettingsButton />
      ) : (
        <span>Seul un administrateur peut configurer cette intégration.</span>
      )}
    </div>
  );
}
