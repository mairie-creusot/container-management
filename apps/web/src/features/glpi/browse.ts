// Logique pure de la consultation des tickets d'un AUTRE compte GLPI (aucun rendu, aucun appel).
import { canOperate } from "@/features/auth/authSlice";
import type { Session } from "@/types";
import type { GlpiAccount } from "@/features/glpi/types";

/**
 * Même frontière que la garde de préfixe /api/glpi/browse/* côté API (routes/glpi.ts) : operator et
 * admin. L'interface ne fait que refléter ce que le backend autorise — un viewer qui appellerait la
 * route à la main reçoit 403 de toute façon.
 */
export function canBrowseOtherAccounts(session: Session | null): boolean {
  return canOperate(session);
}

/** Nom réel + identifiant, ou l'identifiant seul quand GLPI ne donne pas de nom (jamais inventé). */
export function accountLabel(account: GlpiAccount): string {
  return account.displayName === account.login ? account.login : `${account.displayName} (${account.login})`;
}

export interface GlpiPagerState {
  /** Rang du premier / dernier ticket de la page dans l'ensemble GLPI (1-based, 0 si page vide). */
  first: number;
  last: number;
  hasPrevious: boolean;
  hasNext: boolean;
  previousOffset: number;
  nextOffset: number;
  label: string;
}

/**
 * Pagination CÔTÉ GLPI. `total` absent (l'instance ne l'a pas communiqué) : on ne l'estime pas —
 * une page pleine laisse simplement supposer une suite, ce que le libellé dit franchement.
 */
export function glpiPagerState(input: {
  offset: number;
  limit: number;
  count: number;
  total?: number | undefined;
}): GlpiPagerState {
  const offset = Math.max(0, Math.floor(input.offset));
  const limit = Math.max(1, Math.floor(input.limit));
  const count = Math.max(0, Math.floor(input.count));
  const first = count === 0 ? 0 : offset + 1;
  const last = offset + count;
  const total = input.total;
  return {
    first,
    last,
    hasPrevious: offset > 0,
    hasNext: total !== undefined ? last < total : count === limit,
    previousOffset: Math.max(0, offset - limit),
    nextOffset: offset + limit,
    label:
      total !== undefined
        ? `Tickets ${first}–${last} sur ${total.toLocaleString("fr-FR")} dans GLPI`
        : `Tickets ${first}–${last} · total non communiqué par GLPI`,
  };
}
