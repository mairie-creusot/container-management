interface BrandProps {
  /** "sm" pour la sidebar, "lg" pour les écrans plein écran (login, assistant de configuration). */
  size?: "sm" | "lg";
  /** Affiche la légende "Gestion du parc virtuel" sous le nom — réservé aux tailles "lg". */
  withCaption?: boolean;
}

/**
 * Identité de marque QUAI unique, réutilisée partout (Sidebar, LoginScreen, SetupWizard) pour
 * éviter que chaque écran ne réimplémente son propre logo/typo — c'était la cause du mark et de
 * la police incohérents entre l'écran de connexion et l'assistant de configuration.
 */
export default function Brand({ size = "sm", withCaption = false }: BrandProps) {
  return (
    <div className={`brand brand--${size}`}>
      <span className="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 6 L8 2 L14 6 L14 11 L8 15 L2 11 Z" />
          <path d="M2 6 L8 9 L14 6" />
          <path d="M8 9 L8 15" />
        </svg>
      </span>
      <span className="brand__text">
        <span className="brand__name">QUAI</span>
        {withCaption && size === "lg" && <span className="brand__caption">Gestion du parc virtuel</span>}
      </span>
    </div>
  );
}
