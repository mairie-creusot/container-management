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
