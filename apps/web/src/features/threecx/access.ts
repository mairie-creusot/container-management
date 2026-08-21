/**
 * Classification d'une réponse 3CX — logique pure, testable sans rendu. Un refus d'accès et une
 * erreur renvoyée par le PBX sont deux choses différentes : seul le refus d'accès a un rapport avec
 * la licence Enterprise, une erreur de requête n'en a aucun.
 */

import type { ThreecxAccess, ThreecxAccessState } from "@/features/threecx/types";

/**
 * Les CINQ états distingués par le backend : jamais configuré, PBX injoignable, accès refusé
 * (`accessError`), erreur renvoyée par le PBX (`pbxError`), réponse réelle (dont une liste
 * réellement vide). `unknown` = aucune réponse encore reçue.
 */
export function accessStateOf(access: ThreecxAccess): ThreecxAccessState {
  if (!access.configured) return "unconfigured";
  if (access.reachable === false) return "unreachable";
  if (access.accessError) return "denied";
  if (access.pbxError) return "pbx-error";
  if (access.reachable === true) return "ok";
  return "unknown";
}

/** Code HTTP tel que le backend l'a inscrit dans le message brut, s'il y figure. */
function httpStatusIn(message: string): number | null {
  const found = /HTTP (\d{3})/.exec(message);
  return found ? Number(found[1]) : null;
}

/**
 * Piste d'action FACTUELLE déduite du seul code HTTP présent dans le message du PBX — jamais une
 * reformulation du message, jamais une hypothèse sur la licence. `null` quand rien de sûr ne peut
 * être dit.
 */
export function pbxErrorHint(message: string): string | null {
  const status = httpStatusIn(message);
  if (status === null) return null;
  if (status === 400) {
    return "Le PBX a jugé la requête invalide : c'est une erreur de requête, pas un problème de droits ni de licence. Le détail exact est celui affiché ci-dessus.";
  }
  if (status === 404) return "La ressource demandée n'existe pas sur ce PBX : le XAPI de cette version ne l'expose pas.";
  if (status >= 500 && status <= 599) return "Erreur interne du PBX : il a accepté la requête mais n'a pas pu y répondre. Ses journaux en portent la trace.";
  return null;
}
