// Cluster/subnet de la VM temporaire des builds Packer (GET/PUT /api/templates/build-defaults) —
// module autonome, types locaux : nutanixSlice n'est pas sollicité pour la liste des subnets, on
// lit directement la route réelle en lecture seule.

import { apiGet, apiPut, ApiError } from "@/api/client";

export interface BuildPlacement {
  clusterName?: string;
  subnetName?: string;
}

export interface BuildPlacementState {
  saved: BuildPlacement;
  resolved: BuildPlacement;
}

export interface SubnetOption {
  uuid: string;
  name: string;
  vlanId?: number;
}

export type BuildPlacementOutcome =
  | { outcome: "ok"; state: BuildPlacementState }
  | { outcome: "unavailable" }
  | { outcome: "error"; message: string };

function toOutcome(error: unknown): BuildPlacementOutcome {
  if (error instanceof ApiError && error.status === 404) return { outcome: "unavailable" };
  return { outcome: "error", message: error instanceof ApiError ? error.message : "Erreur inattendue" };
}

export async function fetchBuildPlacement(): Promise<BuildPlacementOutcome> {
  try {
    return { outcome: "ok", state: await apiGet<BuildPlacementState>("/templates/build-defaults") };
  } catch (error) {
    return toOutcome(error);
  }
}

export async function saveBuildPlacement(next: BuildPlacement): Promise<BuildPlacementOutcome> {
  try {
    return { outcome: "ok", state: await apiPut<BuildPlacementState>("/templates/build-defaults", next) };
  } catch (error) {
    return toOutcome(error);
  }
}

/** Subnets réels de Prism — [] si Nutanix n'est pas configuré (la route répond [] elle-même). */
export async function fetchSubnetOptions(): Promise<SubnetOption[]> {
  try {
    return await apiGet<SubnetOption[]>("/nutanix/subnets");
  } catch {
    return [];
  }
}
