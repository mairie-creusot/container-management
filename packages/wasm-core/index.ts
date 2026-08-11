/**
 * `@quai/wasm-core` — wrapper TypeScript autour des bindings générés par
 * `wasm-pack build --target bundler` (dossier `pkg/`, généré au build,
 * ignoré par git — voir README.md de ce package).
 *
 * Ce fichier réexporte `diffManifests` en déclarant explicitement les types
 * `DiffLine` / `DiffResult` du contrat défini dans `ARCHITECTURE.md` (section
 * "Interface WASM"), pour que les consommateurs (`apps/api`, et
 * potentiellement `apps/web`) obtiennent un typage strict même si le
 * `.d.ts` généré par wasm-bindgen reste, lui, plus permissif (`any`/
 * `JsValue`-like).
 */

// `pkg/` n'existe qu'après build (`pnpm --filter @quai/wasm-core build`,
// voir package.json / README.md). Il est volontairement absent du dépôt
// (voir .gitignore racine), d'où le @ts-expect-error tant qu'il n'a pas été
// généré localement.
// @ts-expect-error -- généré par `wasm-pack build`, absent avant le premier build local.
import { diffManifests as diffManifestsWasm } from "./pkg/quai_wasm_core.js";

/** Nature d'une ligne du diff : inchangée, ajoutée, ou supprimée. */
export type DiffLineKind = "context" | "add" | "remove";

/** Une ligne du diff entre le manifeste désiré et le manifeste réel. */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Résultat du diff entre deux manifestes YAML. */
export interface DiffResult {
  lines: DiffLine[];
  hasDrift: boolean;
}

/**
 * Diffe un manifeste désiré (source de vérité GitOps, dépôt Git) et un
 * manifeste réel (reconstruit depuis le cluster), ligne à ligne.
 *
 * `hasDrift` vaut `true` dès qu'il existe au moins une ligne `add` ou
 * `remove`, c'est-à-dire dès que l'état réel diverge de l'état désiré.
 *
 * @param desiredYaml - contenu YAML brut du manifeste désiré.
 * @param actualYaml - contenu YAML brut du manifeste réel.
 */
export function diffManifests(desiredYaml: string, actualYaml: string): DiffResult {
  return diffManifestsWasm(desiredYaml, actualYaml) as DiffResult;
}
