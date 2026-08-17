// Icônes SVG inline minimalistes (pas de dépendance externe).
type IconProps = { className?: string };

function base(children: JSX.Element, className?: string) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconOverview({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>,
    className,
  );
}

export function IconImages({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="3" width="18" height="14" rx="2" />
      <circle cx="8" cy="9" r="1.6" />
      <path d="M3 15l5-4 4 3 4-5 5 6" />
    </>,
    className,
  );
}

export function IconRegistries({ className }: IconProps) {
  return base(
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5V18.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5.5" />
      <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </>,
    className,
  );
}

export function IconContainers({ className }: IconProps) {
  return base(
    <>
      <path d="M3 8l9-5 9 5-9 5-9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </>,
    className,
  );
}

export function IconGitOps({ className }: IconProps) {
  return base(
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 8.4V15.6" />
      <path d="M8.2 6.9C11.8 8 15.7 9.6 15.8 10.2" />
    </>,
    className,
  );
}

export function IconClusters({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </>,
    className,
  );
}

export function IconSearch({ className }: IconProps) {
  return base(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
    className,
  );
}

export function IconClose({ className }: IconProps) {
  return base(
    <>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </>,
    className,
  );
}

export function IconChevron({ className }: IconProps) {
  return base(<path d="M9 6l6 6-6 6" />, className);
}

export function IconPlus({ className }: IconProps) {
  return base(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    className,
  );
}

export function IconVolumes({ className }: IconProps) {
  return base(
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>,
    className,
  );
}

export function IconNetworks({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="4" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 6v4" />
      <path d="M12 10 5 17" />
      <path d="M12 10l7 7" />
    </>,
    className,
  );
}

export function IconHistory({ className }: IconProps) {
  return base(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l4 2" />
    </>,
    className,
  );
}

export function IconStack({ className }: IconProps) {
  return base(
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </>,
    className,
  );
}

export function IconTopology({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="4" width="7" height="6" rx="1.5" />
      <rect x="8.5" y="15" width="7" height="6" rx="1.5" />
      <path d="M6.5 10v2.5a2 2 0 0 0 2 2H10" />
      <path d="M17.5 10v2.5a2 2 0 0 1-2 2H14" />
    </>,
    className,
  );
}

export function IconBell({ className }: IconProps) {
  return base(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>,
    className,
  );
}

export function IconTrash({ className }: IconProps) {
  return base(
    <>
      <path d="M4 7h16" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </>,
    className,
  );
}

export function IconPlay({ className }: IconProps) {
  return base(<path d="M7 5l12 7-12 7V5Z" />, className);
}

export function IconStop({ className }: IconProps) {
  return base(<rect x="6" y="6" width="12" height="12" rx="1.5" />, className);
}

export function IconRestart({ className }: IconProps) {
  return base(
    <>
      <path d="M3 12a9 9 0 1 1 3 6.7" />
      <path d="M3 21v-6h6" />
    </>,
    className,
  );
}

export function IconSettings({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.6a1.7 1.7 0 0 0 .35 1.9l.06.06a2 2 0 1 1-2.9 2.9l-.06-.06a1.7 1.7 0 0 0-1.9-.35 1.7 1.7 0 0 0-1 1.55V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.9.35l-.06.06a2 2 0 1 1-2.9-2.9l.06-.06a1.7 1.7 0 0 0 .35-1.9 1.7 1.7 0 0 0-1.55-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.35-1.9l-.06-.06a2 2 0 1 1 2.9-2.9l.06.06a1.7 1.7 0 0 0 1.9.35H10a1.7 1.7 0 0 0 1-1.55V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.9-.35l.06-.06a2 2 0 1 1 2.9 2.9l-.06.06a1.7 1.7 0 0 0-.35 1.9V10a1.7 1.7 0 0 0 1.55 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.6Z" />
    </>,
    className,
  );
}

export function IconKey({ className }: IconProps) {
  return base(
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9" />
      <path d="M17 6l3 3" />
      <path d="M14 9l3 3" />
    </>,
    className,
  );
}

/** VM Nutanix — écran + socle, façon "poste virtuel", distincte de IconContainers (boîte 3D). */
export function IconVm({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </>,
    className,
  );
}

/** Reverse proxy interne — globe (réseau) + flèche de routage, distincte de IconNetworks. */
export function IconGlobe({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.7 3.8 6 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-6-3.8-9s1.3-6.3 3.8-9Z" />
    </>,
    className,
  );
}

/** Dossier — utilisé par l'explorateur de fichiers de volume (VolumeFilesModal.tsx). */
export function IconFolder({ className }: IconProps) {
  return base(
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    className,
  );
}

/** Console/terminal — bouton "Console" dans l'Inspector d'un conteneur en cours d'exécution. */
export function IconTerminal({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l4 3-4 3" />
      <path d="M13 15h4" />
    </>,
    className,
  );
}

/** Œil ouvert — "Révéler" une valeur de secret (SecretsPage.tsx), jamais affichée par défaut. */
export function IconEye({ className }: IconProps) {
  return base(
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    className,
  );
}

/** Œil barré — "Masquer de nouveau" une valeur de secret révélée (SecretsPage.tsx). */
export function IconEyeOff({ className }: IconProps) {
  return base(
    <>
      <path d="M17.9 17.9A10.6 10.6 0 0 1 12 20c-6.5 0-10-7-10-7a18.6 18.6 0 0 1 4.2-5.2" />
      <path d="M9.9 4.6A9.7 9.7 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.3 3.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M2 2l20 20" />
    </>,
    className,
  );
}

/** Copier — bouton "Copier" à côté d'une valeur de secret révélée (Clipboard API, SecretsPage.tsx). */
export function IconCopy({ className }: IconProps) {
  return base(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    className,
  );
}

/** Coche — retour visuel bref "Copié" après un clic sur IconCopy. */
export function IconCheck({ className }: IconProps) {
  return base(<path d="M4 12.5l5 5L20 6" />, className);
}

/** Hôte générique (cluster Nutanix physique / environnement Docker distant / hôte LXD) — façon
 * "puce de calcul" (boîtier + broches), nœud "host" du graphe de topologie, distincte de IconServer
 * (rack, contrôleur de domaine) et IconVm (poste virtuel Nutanix) : ce n'est ni un rack ni un
 * poste, mais la machine/le cluster hôte qui HÉBERGE ces ressources. */
export function IconHostMachine({ className }: IconProps) {
  return base(
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.2" />
      <path d="M4 9h2M4 15h2M18 9h2M18 15h2M9 4v2M15 4v2M9 18v2M15 18v2" />
    </>,
    className,
  );
}

/** Serveur/contrôleur de domaine (façon rack empilé) — nœud "ad-server" du graphe de topologie et
 * page de configuration DNS AD, distincte de IconVm (poste virtuel Nutanix). */
export function IconServer({ className }: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.2" />
      <rect x="3" y="14" width="18" height="6" rx="1.2" />
      <circle cx="7" cy="7" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

/** Horloge (cadran + aiguilles) — nœud "cron-job" du graphe de topologie (services/cronJobsStore.ts),
 * façon Railway "Cron Jobs" : planification récurrente, distincte de IconHistory (liste chronologique
 * plate, utilisée pour l'audit/l'historique d'exécution) et de IconPlay (déclenchement manuel). */
export function IconClock({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>,
    className,
  );
}

/** Sauvegardes automatiques (nuage + flèche descendante, façon upload S3) — Sidebar/BackupsPage.tsx. */
export function IconBackup({ className }: IconProps) {
  return base(
    <>
      <path d="M7 18a4.5 4.5 0 01-1-8.9 5.5 5.5 0 0110.6-2A4.5 4.5 0 0117 18H7z" />
      <path d="M12 10v7" />
      <path d="M9 14.5L12 17.5 15 14.5" />
    </>,
    className,
  );
}

/** Nœud "automation-condition" du graphe de topologie (services/automationStore.ts) — point de
 * décision qui se divise en deux branches, façon organigramme : aucune icône de fourche/branchement
 * n'existait déjà dans ce fichier (IconChevron est un simple chevron directionnel, pas un point de
 * décision), ajoutée ici en suivant EXACTEMENT le même style que les autres (base(), 3 points +
 * tracés, mêmes proportions viewBox 24 que IconKey/IconSettings ci-dessus). */
export function IconBranch({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="19" r="2.2" />
      <path d="M12 7.2v3" />
      <path d="M12 10.2c0 2-2.3 3-4.8 4.7" />
      <path d="M12 10.2c0 2 2.3 3 4.8 4.7" />
    </>,
    className,
  );
}

/** "i" encerclé — bouton "Légende" de la barre d'outils du graphe de topologie (TopologyGraph.tsx),
 * même famille visuelle que IconBell/IconChevron ci-dessus (contour, base()), aucune icône
 * d'information n'existait déjà dans ce fichier. */
export function IconInfo({ className }: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.75" r="0.9" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

/** GitHub (marque octocat simplifiée, tracé plein — pas base(), les autres icônes sont en contour) : Sidebar/GitHubDeployPage.tsx. */
export function IconGithub({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.833.092-.647.35-1.088.636-1.339-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.203 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.678.921.678 1.856 0 1.34-.012 2.421-.012 2.751 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.523 2 12 2z"
      />
    </svg>
  );
}
