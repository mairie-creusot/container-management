# @quai/wasm-core

Cœur Rust compilé en WebAssembly (via `wasm-pack`) du diff de manifestes
GitOps de QUAI. Voir [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (section
"Interface WASM (`@quai/wasm-core`)") pour le contrat figé consommé par
`apps/api`.

## Interface exposée

```ts
export function diffManifests(desiredYaml: string, actualYaml: string): DiffResult;

interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}
interface DiffResult {
  lines: DiffLine[];
  hasDrift: boolean;
}
```

- `desiredYaml` : le manifeste désiré (source de vérité, dépôt Git).
- `actualYaml` : le manifeste réel, reconstruit depuis le cluster.
- `hasDrift` vaut `true` dès qu'il existe au moins une ligne `add` ou `remove`
  dans le diff.

Les deux documents sont d'abord normalisés (parse YAML → re-sérialisation)
pour que deux formulations équivalentes (style bloc vs flow, indentation,
etc.) ne génèrent pas de faux diff. Si l'un des deux documents n'est pas un
YAML valide, le module **ne panique pas** : il retombe sur un diff texte brut
ligne à ligne du contenu non normalisé.

## Structure du crate

```
packages/wasm-core/
  Cargo.toml         crate `quai-wasm-core` (cdylib + rlib)
  src/
    lib.rs            point d'entrée wasm-bindgen : diffManifests(...)
    diff.rs            algorithme de diff LCS pur Rust + tests unitaires
  index.ts             wrapper TS qui réexporte pkg/ avec des types explicites
  package.json          @quai/wasm-core (scripts build / test)
  pkg/                  généré par `wasm-pack build` — absent du dépôt (gitignore racine)
```

L'algorithme de diff (`src/diff.rs`) est une implémentation maison de LCS
(programmation dynamique), volontairement sans dépendance externe de diff,
pour rester simple à auditer et à tester unitairement en Rust pur (donc
testable sans passer par wasm-pack ni Node).

## Prérequis pour builder en WASM

Cet environnement de développement dispose de `cargo`/`rustc` mais **pas**
de `wasm-pack` par défaut — à installer une fois :

```bash
# toolchain Rust (si absente)
# https://rustup.rs
rustup target add wasm32-unknown-unknown

# wasm-pack
cargo install wasm-pack
# ou, plus rapide :
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

Sur Windows (PowerShell), voir l'installeur officiel :
`https://rustwasm.github.io/wasm-pack/installer/`, ou `cargo install wasm-pack`
une fois `rustup`/`cargo` installés.

## Build

```bash
pnpm --filter @quai/wasm-core build
# équivalent à :
wasm-pack build --target bundler --out-dir pkg
```

Génère `pkg/quai_wasm_core.js`, `pkg/quai_wasm_core_bg.wasm` et
`pkg/quai_wasm_core.d.ts`. Ce dossier est ignoré par git (voir `.gitignore`
racine) : chaque environnement (dev, CI) doit le régénérer.

`index.ts`, à la racine du package, réexporte ces bindings en déclarant
explicitement les types `DiffLine` / `DiffResult` (voir plus haut), pour que
`apps/api` bénéficie d'un typage strict même si le `.d.ts` généré par
wasm-bindgen reste plus permissif.

## Tests

```bash
pnpm --filter @quai/wasm-core test
# équivalent à :
cargo test
```

`cargo test` compile et exécute la logique en natif (pas besoin de
`wasm-pack` ni de target `wasm32` pour lancer les tests) : c'est le moyen le
plus rapide de valider l'algorithme de diff et la normalisation YAML. Les
tests couvrent notamment (`src/diff.rs`, `src/lib.rs`) :

- YAML identique → `hasDrift = false`.
- une ligne modifiée / ajoutée / supprimée.
- documents vides.
- YAML invalide → repli sur diff texte brut sans panique.
- deux formulations YAML équivalentes (style bloc vs flow) → même
  normalisation.

État à la dernière validation dans cet environnement : `cargo test` →
**12/12 tests passés**. `cargo build --target wasm32-unknown-unknown` a
également été vérifié avec succès (compile proprement pour la cible wasm),
mais l'étape `wasm-pack build` elle-même (génération de `pkg/` et des
bindings JS/TS) n'a pas pu être exécutée faute de `wasm-pack` installé dans
cet environnement — à valider avec la toolchain complète avant intégration
dans `apps/api`.

## Consommation par `apps/api`

```ts
import { diffManifests } from "@quai/wasm-core";

const { lines, hasDrift } = diffManifests(gitOpsFile.desiredManifest, gitOpsFile.actualManifest);
```

`apps/api` importe ce package par son nom (`@quai/wasm-core`, résolu via le
workspace pnpm) sans connaître son implémentation interne. Le typage
(`DiffLine`, `DiffResult`) est fourni par `index.ts` ; le binaire WASM
lui-même doit avoir été buildé au préalable (`pnpm --filter @quai/wasm-core
build`) — à intégrer dans le pipeline CI (`.github/workflows/`) avant le
build de `apps/api`, puisque `pkg/` n'est pas versionné.

## Points à valider avec la toolchain Rust/wasm-pack installée

- Exécuter effectivement `wasm-pack build --target bundler --out-dir pkg` et
  vérifier que `pkg/quai_wasm_core.js` exporte bien une fonction nommée
  `diffManifests` (nom forcé via `#[wasm_bindgen(js_name = diffManifests)]`
  dans `src/lib.rs`) consommable telle quelle par `index.ts`.
- Vérifier l'intégration bout en bout avec `apps/api` une fois ce dernier
  développé (résolution du workspace pnpm, forme exacte de l'objet retourné
  par `serde-wasm-bindgen` côté JS).
- Éventuellement ajouter `wasm-bindgen-test` si des tests spécifiques au
  runtime wasm (navigateur / Node) s'avèrent nécessaires en plus des tests
  Rust natifs déjà présents.
