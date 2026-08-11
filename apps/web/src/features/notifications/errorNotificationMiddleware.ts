import type { Middleware, UnknownAction } from "@reduxjs/toolkit";
import { pushNotification } from "@/features/notifications/notificationsSlice";

/**
 * Filet de sécurité générique : capture TOUT thunk Redux rejeté dans l'app (peu importe la
 * feature, présente ou future) et le transforme en notification — évite d'avoir à cabler un
 * `.addCase(x.rejected, ...)` → toast dans chaque slice pour "gérer toutes les erreurs".
 *
 * Exclusions volontaires : rejets attendus/silencieux qui ne sont pas des erreurs pour
 * l'utilisateur (vérifications de session/config au chargement) ou déjà affichés inline
 * ailleurs (échec de login, montré directement sur LoginScreen).
 */
const SILENT_PREFIXES = ["auth/fetchSession", "setup/fetchStatus", "auth/login"];

function extractMessage(action: UnknownAction & { payload?: unknown; error?: { message?: string } }): string {
  if (typeof action.payload === "string" && action.payload.trim() !== "") return action.payload;
  if (action.error?.message) return action.error.message;
  return "Une erreur est survenue.";
}

export const errorNotificationMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action);

  if (typeof (action as UnknownAction).type === "string" && (action as UnknownAction).type.endsWith("/rejected")) {
    const type = (action as UnknownAction).type;
    if (!SILENT_PREFIXES.some((prefix) => type.startsWith(prefix))) {
      store.dispatch(
        pushNotification({
          level: "error",
          message: extractMessage(action as UnknownAction & { payload?: unknown; error?: { message?: string } }),
          source: type,
        }),
      );
    }
  }

  return result;
};
