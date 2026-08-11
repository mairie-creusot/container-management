import type { CSSProperties } from "react";

export type SkeletonVariant = "rect" | "circle" | "text";

interface SkeletonProps {
  /** Largeur — nombre (px) ou valeur CSS (%, rem…). */
  width?: number | string;
  /** Hauteur — nombre (px) ou valeur CSS. */
  height?: number | string;
  /** Forme : "rect" (par défaut), "circle" (avatar/icône), "text" (ligne de texte). */
  variant?: SkeletonVariant;
  /** Rayon personnalisé — prioritaire sur celui du variant. */
  radius?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Bloc squelette générique — rectangle/cercle gris avec effet de balayage (shimmer) en CSS pur
 * (voir apps/web/src/styles/skeleton.css), utilisé à la place d'un texte "Chargement…" pendant
 * le premier chargement d'une vue. Sert de brique de base aux variantes ci-dessous
 * (SkeletonTable, SkeletonCard) et peut aussi être composé directement pour des silhouettes
 * sur mesure (voir OverviewPage.tsx, TopologyGraph.tsx). Respecte `prefers-reduced-motion`
 * (animation coupée, voir skeleton.css).
 */
export default function Skeleton({ width = "100%", height = 14, variant = "rect", radius, className = "", style }: SkeletonProps) {
  return (
    <span
      className={`skeleton skeleton--${variant}${className ? ` ${className}` : ""}`}
      style={{ width, height, ...(radius ? { borderRadius: radius } : {}), ...style }}
      aria-hidden="true"
    />
  );
}

interface SkeletonTableProps {
  /** En-têtes réels de la table — affichés normalement, seul le corps (tbody) est en squelette
   * pour que l'apparition des vraies lignes ne provoque aucun saut de mise en page. */
  columns: string[];
  rows?: number;
}

/** Squelette de `.data-table` (Images, Conteneurs, Volumes, Networks, Traçabilité…). */
export function SkeletonTable({ columns, rows = 6 }: SkeletonTableProps) {
  return (
    <div className="data-table-wrap">
      <table className="data-table is-skeleton">
        <thead>
          <tr>
            {columns.map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, colIndex) => (
                <td key={colIndex}>
                  {/* Largeurs variées par colonne pour une silhouette moins uniforme/artificielle. */}
                  <Skeleton variant="text" height={12} width={colIndex === 0 ? "72%" : `${40 + ((colIndex * 17) % 40)}%`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Squelette de carte générique (`.card`) — silhouette icône/pastille + titre + sous-titre +
 * ligne de pied, calée sur `.registry-card` (voir RegistriesPage.tsx) mais réutilisable pour
 * toute grille de cartes.
 */
export function SkeletonCard() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <div className="skeleton-card__row">
        <Skeleton variant="rect" width={34} height={34} radius="9px" />
        <Skeleton variant="rect" width={64} height={20} radius="999px" />
      </div>
      <Skeleton variant="text" height={15} width="55%" style={{ marginTop: 12 }} />
      <Skeleton variant="text" height={11} width="80%" style={{ marginTop: 6 }} />
      <div className="skeleton-card__row" style={{ marginTop: 14 }}>
        <Skeleton variant="text" height={11} width="35%" />
        <Skeleton variant="text" height={11} width="30%" />
      </div>
    </div>
  );
}
