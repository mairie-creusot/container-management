// SEUL point de contact réseau de l'écran des Modules (administration des modules installés).
// Rien n'y lève : une route absente devient `unavailable`, un refus devient le motif du serveur.

import { ApiError, apiDelete, apiGet, apiPost } from "@/api/client";
import { normalizeModuleInventory, type ModuleInventory } from "@/features/plugins/pluginInstallModel";

export type ModuleInventoryResult =
  | { status: "ready"; inventory: ModuleInventory }
  | { status: "unavailable"; reason: string };

export type ModuleMutationOutcome = { ok: true } | { ok: false; reason: string };

const INVENTORY_PATH = "/plugins/installed";
const ROUTE_ABSENT = "Le serveur ne publie pas d'inventaire des modules installés.";

function isMissingRoute(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function modulePath(id: string): string {
  return `${INVENTORY_PATH}/${encodeURIComponent(id)}`;
}

export async function fetchModuleInventory(): Promise<ModuleInventoryResult> {
  try {
    const inventory = normalizeModuleInventory(await apiGet<unknown>(INVENTORY_PATH));
    if (!inventory) {
      return { status: "unavailable", reason: `${INVENTORY_PATH} n'a pas renvoyé d'inventaire exploitable.` };
    }
    return { status: "ready", inventory };
  } catch (error) {
    if (isMissingRoute(error)) return { status: "unavailable", reason: ROUTE_ABSENT };
    return { status: "unavailable", reason: reasonOf(error, "Inventaire des modules injoignable.") };
  }
}

/** `envelope` est le paquet signé produit hors ligne, transmis tel quel : c'est le serveur qui en
 * vérifie la signature avant toute écriture, l'interface n'en juge rien. */
export async function installModule(envelope: unknown): Promise<ModuleMutationOutcome> {
  try {
    await apiPost<unknown>(INVENTORY_PATH, envelope);
    return { ok: true };
  } catch (error) {
    if (isMissingRoute(error)) return { ok: false, reason: "Ce serveur n'expose pas l'installation de modules." };
    return { ok: false, reason: reasonOf(error, "Installation impossible.") };
  }
}

export async function uninstallModule(id: string): Promise<ModuleMutationOutcome> {
  try {
    await apiDelete<unknown>(modulePath(id));
    return { ok: true };
  } catch (error) {
    if (isMissingRoute(error)) return { ok: false, reason: "Ce serveur n'expose pas la désinstallation de modules." };
    return { ok: false, reason: reasonOf(error, "Désinstallation impossible.") };
  }
}

/** Réinstalle un module d'ORIGINE depuis l'image — sa configuration, retirée à la désinstallation,
 * reste à ressaisir : rien n'est restauré à sa place. */
export async function restoreModule(id: string): Promise<ModuleMutationOutcome> {
  try {
    await apiPost<unknown>(`${modulePath(id)}/restore`, {});
    return { ok: true };
  } catch (error) {
    if (isMissingRoute(error)) return { ok: false, reason: "Ce serveur n'expose pas la réinstallation de modules." };
    return { ok: false, reason: reasonOf(error, "Réinstallation impossible.") };
  }
}
