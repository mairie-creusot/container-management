/**
 * Déclaration ambiante de secours pour @quai/wasm-core.
 *
 * packages/wasm-core est développé en parallèle par un autre agent (crate Rust + wasm-pack).
 * Tant que le package n'est pas buildé/publié dans le workspace, TypeScript ne peut pas
 * résoudre ses propres types. Cette déclaration ambiante permet à apps/api de compiler
 * dès maintenant en respectant l'interface figée dans ARCHITECTURE.md.
 *
 * Dès que packages/wasm-core expose ses propres types (via wasm-pack / son package.json),
 * la résolution de module réelle prend le pas sur cette déclaration ambiante et ce fichier
 * peut être supprimé.
 */
declare module "@quai/wasm-core" {
  export interface DiffLine {
    kind: "context" | "add" | "remove";
    text: string;
  }

  export interface DiffResult {
    lines: DiffLine[];
    hasDrift: boolean;
  }

  export function diffManifests(desiredYaml: string, actualYaml: string): DiffResult;
}
