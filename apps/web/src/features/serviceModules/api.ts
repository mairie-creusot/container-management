import { apiDelete, apiGet, apiPut } from "@/api/client";
import type { ServiceModuleBinding, ServiceModuleDescriptor, ServiceModuleSnapshot } from "./types";

/** Registre des modules disponibles + leur état de configuration RÉEL. */
export function fetchServiceModules(): Promise<{ modules: ServiceModuleDescriptor[] }> {
  return apiGet("/service-modules");
}

/** Liaisons effectives (manuelles persistées + automatiques recalculées côté serveur). */
export function fetchServiceModuleBindings(): Promise<{ bindings: ServiceModuleBinding[] }> {
  return apiGet("/service-modules/bindings");
}

/** operator/admin — lie explicitement un nœud du graphe à un module. */
export function putServiceModuleBinding(nodeId: string, moduleId: string): Promise<ServiceModuleBinding> {
  return apiPut("/service-modules/bindings", { nodeId, moduleId });
}

/** operator/admin — retire la liaison MANUELLE d'un nœud (une liaison automatique n'est pas
 * supprimable : elle disparaît d'elle-même dès que la correspondance cesse d'être vraie). */
export function deleteServiceModuleBinding(nodeId: string): Promise<{ ok: true }> {
  return apiDelete(`/service-modules/bindings/${encodeURIComponent(nodeId)}`);
}

export function fetchServiceModuleSnapshot(moduleId: string): Promise<ServiceModuleSnapshot> {
  return apiGet(`/service-modules/${encodeURIComponent(moduleId)}/snapshot`);
}
