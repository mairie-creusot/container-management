/**
 * Garde-fou de COMPILATION : tant que services/serviceModules.ts porte sa propre définition de
 * `ServiceModuleSnapshot`, celle du contrat (@quai/plugin-contract, définition de référence) doit
 * lui rester strictement interchangeable. Toute divergence casse `tsc` ici, jamais en production.
 * Ce fichier disparaîtra quand serviceModules.ts réexportera le contrat (phase ultérieure).
 */

import type { ServiceModuleSnapshot as SnapshotContrat } from "@quai/plugin-contract";
import type { ServiceModuleSnapshot as SnapshotApi } from "../services/serviceModules.js";

type SeSubstitueA<A, B> = A extends B ? true : false;
type Verifie<T extends true> = T;

export type ContratCompatibleAvecApi = Verifie<SeSubstitueA<SnapshotContrat, SnapshotApi>>;
export type ApiCompatibleAvecContrat = Verifie<SeSubstitueA<SnapshotApi, SnapshotContrat>>;
