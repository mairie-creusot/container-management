/**
 * Retrouve, DANS UNE VRAIE IMAGE DOCKER, les fichiers réels d'un paquet rapporté par un scan de
 * vulnérabilités (Grype ou OSV-Scanner, voir services/scan.ts#Vulnerability#packageName) — complète
 * ce module SANS jamais y toucher : scan.ts sait QU'UN paquet est vulnérable, celui-ci retrouve OÙ
 * (s'il existe) le code de ce paquet vit réellement dans l'image, pour l'afficher côté frontend.
 *
 * Grype et OSV-Scanner nomment les paquets selon des conventions différentes et jamais unifiées :
 * un paquet système (Grype) rapporte souvent juste "openssl" ou "glibc" ; OSV rapporte des chemins
 * de module Go complets ("github.com/aws/aws-sdk-go-v2/config") ou des noms npm ("lodash",
 * "@babel/core"). Ce module ne réimplémente donc PAS un mapping figé entre ces conventions : il
 * INSPECTE RÉELLEMENT l'image (comme Grype/OSV le font déjà eux-mêmes) via
 * `docker run --rm --entrypoint sh <image> -c "<script>"` — jamais de conteneur déjà en cours de
 * requis, l'image locale suffit. `--entrypoint sh` est OBLIGATOIRE (pas juste `sh -c "..."` en
 * argument) : une image dont l'ENTRYPOINT est un binaire applicatif (cas fréquent pour une image
 * "un seul process", vérifié en direct sur une image réelle de ce dépôt) ignore sinon la commande
 * demandée et lance l'application elle-même à la place — sans le forçage explicite de l'entrypoint,
 * ce module démarrerait par erreur de vrais services au lieu de les inspecter.
 *
 * Stratégie, dans cet ordre, arrêt à la première qui trouve réellement quelque chose (tout est
 * évalué en UN SEUL script shell POSIX, un seul `docker run` par appel — évite un aller-retour de
 * conteneur par étape) :
 *   a. apt/dpkg  : `dpkg -L <nom>` ; si échec, `dpkg -l | grep -i <nom>` pour un nom de paquet
 *      Debian réel proche (ex: "openssl" -> "libssl3"), best-effort documenté dans `reason`. Si
 *      `dpkg` est absent de l'image (non-Debian), l'étape est sautée sans faire échouer le reste.
 *   b. npm       : recherche RÉELLE d'un dossier `node_modules/<nom>` dans toute l'image (le nom
 *      peut porter un scope, "@org/pkg") — SAUTÉE d'emblée si `<nom>` a la forme d'un chemin de
 *      module Go (voir looksLikeGoModulePath) : chercher un tel dossier ne trouverait jamais rien,
 *      ce serait chercher pour la forme plutôt qu'honnêtement.
 *   c. pip       : `pip show -f <nom>` (ou `pip3`, selon ce qui est réellement présent).
 *   d. Sinon     : `available: false` avec une raison concrète — notamment tout module Go
 *      (`github.com/...`) ou crate Rust compilé, dont le code source n'est JAMAIS présent dans
 *      l'image finale (compilé statiquement dans le binaire).
 *
 * Nettoyage : `docker run --rm` s'en charge lui-même (le conteneur est supprimé dès qu'il se
 * termine, y compris sur timeout — voir INSPECTION_TIMEOUT_MS ci-dessous, `execFile` tue le
 * process `docker run` avec SIGTERM au-delà de ce délai, ce qui arrête puis supprime le conteneur
 * `--rm` sous-jacent) : aucun conteneur orphelin ne peut survivre à un appel de ce module.
 */

import { execFile, type ExecFileException } from "node:child_process";
import type { PackageFilesResult } from "../types.js";

// Borne la taille de la sortie remontée au frontend — un paquet système peut lister plusieurs
// milliers de chemins (ex: paquets de données/locales), jamais utile d'en afficher autant.
const MAX_LISTED_FILES = 500;

// L'image est déjà présente localement dans tous les cas réels (elle vient d'être scannée par
// Grype/OSV-Scanner, voir routes/scan.ts) : aucun téléchargement à attendre ici, contrairement à
// scan.ts#config.scan.timeoutMs (qui doit lui tolérer un premier téléchargement de base de
// vulnérabilités). Un script shell de quelques commandes doit répondre en quelques secondes ; ce
// délai protège uniquement contre une image dont l'ENTRYPOINT d'origine tournerait malgré
// `--entrypoint sh` forcé sur un runtime exotique, ou un `find /` anormalement lent.
const INSPECTION_TIMEOUT_MS = 30_000;

/** Code de sortie POSIX standard "command not found" — Docker le renvoie quand `sh` n'existe pas
 * dans l'image cible (image "distroless"/scratch, typiquement un binaire Go/Rust compilé
 * statiquement) : SIGNATURE VÉRIFIÉE EN DIRECT (build local d'une image `FROM scratch` sans
 * aucun shell, `docker run --rm --entrypoint sh <image> -c "echo hi"`) -> code de sortie 127,
 * stderr contenant exactement `exec: "sh": executable file not found in $PATH` — même mécanisme
 * que `docker exec` pour le même cas (voir services/containerInternals.ts). */
const NO_SHELL_EXIT_CODE = 127;

function isNoShellFailure(exitCode: number | null, stderr: string): boolean {
  return exitCode === NO_SHELL_EXIT_CODE && /executable file not found|no such file or directory/i.test(stderr);
}

/** Code de sortie exploitable d'un execFile terminé : null si le process n'a pas pu être lancé du
 * tout (ENOENT, "docker" absent du PATH...) — même helper que scan.ts#execFileExitCode, dupliqué
 * ici volontairement (4 lignes, pas vaut la peine de coupler les deux modules pour ça). */
function execFileExitCode(err: ExecFileException | null): number | null {
  if (!err) return 0;
  return typeof err.code === "number" ? err.code : null;
}

/**
 * Échappe une valeur pour l'embarquer telle quelle entre apostrophes dans un script shell POSIX
 * (seule forme de citation garantie sûre : aucune expansion, aucune interprétation de
 * métacaractère à l'intérieur). `packageName` vient d'un scan Grype/OSV — jamais fait confiance
 * aveuglément à sa forme avant de l'injecter dans une commande shell.
 */
function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Un module Go s'identifie TOUJOURS par un chemin commençant par un domaine (avec un point, ex
 * "github.com", "golang.org", "k8s.io", "gopkg.in") suivi d'un "/" — forme qu'aucune convention de
 * nommage npm/apt/pip n'utilise jamais (un paquet npm scope s'écrit "@org/pkg", jamais
 * "org.tld/pkg"). Sert UNIQUEMENT à éviter de chercher un dossier node_modules/<chemin-go> qui
 * n'existera jamais ; n'affirme jamais qu'un nom SANS cette forme est forcément npm/apt/pip (ces
 * stratégies restent tentées et honnêtes sur leur propre échec).
 */
function looksLikeGoModulePath(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(name);
}

interface InspectionScriptOptions {
  includeNpm: boolean;
}

/**
 * Construit le script shell POSIX (dash/busybox ash compatibles — pas de bash-isme) exécuté en UN
 * SEUL `docker run`. Émet des marqueurs de ligne ("APT_OK <nom>", "NPM_OK <dossier>", "PIP_OK",
 * "APT_NOT_FOUND"...) que parseInspectionOutput() ci-dessous reconnaît — chaque étape teste
 * RÉELLEMENT la commande (exit code + sortie non vide), jamais une supposition sur la présence
 * d'un outil. S'arrête au premier `exit 0` explicite dès qu'une étape trouve réellement quelque
 * chose.
 */
function buildInspectionScript(packageName: string, opts: InspectionScriptOptions): string {
  const pkg = shellSingleQuote(packageName);
  const npmBlock = opts.includeNpm
    ? [
        `DIR=$(find / -xdev -type d -path "*/node_modules/$PKG" 2>/dev/null | head -n 1)`,
        `if [ -n "$DIR" ]; then`,
        `  echo "NPM_OK $DIR"`,
        `  find "$DIR" -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.ts' \\) 2>/dev/null | head -n ${MAX_LISTED_FILES}`,
        `  exit 0`,
        `fi`,
        `echo "NPM_NOT_FOUND"`,
      ].join("\n")
    : `echo "NPM_SKIPPED_GO_SHAPED"`;

  return [
    `PKG=${pkg}`,
    // --- a. apt/dpkg ---
    `if command -v dpkg >/dev/null 2>&1; then`,
    `  if dpkg -L "$PKG" >/tmp/.quai_pkgfiles 2>/dev/null && [ -s /tmp/.quai_pkgfiles ]; then`,
    `    echo "APT_OK $PKG"`,
    `    head -n ${MAX_LISTED_FILES} /tmp/.quai_pkgfiles`,
    `    exit 0`,
    `  fi`,
    // Nom Grype/OSV parfois plus générique que le nom de paquet Debian réel (ex "openssl" ->
    // "libssl3") : on cherche le paquet INSTALLÉ ("ii") dont le nom contient <nom>, en retirant le
    // suffixe multi-arch (":amd64") avant de le tester à son tour.
    `  CANDIDATE=$(dpkg -l 2>/dev/null | awk '$1=="ii"{print $2}' | sed 's/:.*//' | grep -i -- "$PKG" | head -n 1)`,
    `  if [ -n "$CANDIDATE" ] && dpkg -L "$CANDIDATE" >/tmp/.quai_pkgfiles 2>/dev/null && [ -s /tmp/.quai_pkgfiles ]; then`,
    `    echo "APT_OK $CANDIDATE"`,
    `    head -n ${MAX_LISTED_FILES} /tmp/.quai_pkgfiles`,
    `    exit 0`,
    `  fi`,
    `  echo "APT_NOT_FOUND"`,
    `else`,
    `  echo "APT_NO_DPKG"`,
    `fi`,
    // --- b. npm ---
    npmBlock,
    // --- c. pip ---
    `PIPBIN=""`,
    `if command -v pip >/dev/null 2>&1; then PIPBIN=pip; elif command -v pip3 >/dev/null 2>&1; then PIPBIN=pip3; fi`,
    `if [ -n "$PIPBIN" ]; then`,
    `  OUT=$($PIPBIN show -f "$PKG" 2>/dev/null)`,
    `  if [ -n "$OUT" ]; then`,
    `    echo "PIP_OK"`,
    `    printf '%s\\n' "$OUT" | head -n ${MAX_LISTED_FILES}`,
    `    exit 0`,
    `  fi`,
    `  echo "PIP_NOT_FOUND"`,
    `else`,
    `  echo "PIP_NO_BIN"`,
    `fi`,
    // --- d. rien trouvé ---
    `echo "NONE"`,
    `exit 0`,
  ].join("\n");
}

interface RawInspectionResult {
  stdout: string;
  exitCode: number | null;
  stderr: string;
}

function runInspectionScript(imageReference: string, script: string): Promise<RawInspectionResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", imageReference, "-c", script],
      { timeout: INSPECTION_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 8 },
      (err, stdout, stderr) => {
        resolve({ stdout, exitCode: execFileExitCode(err), stderr: stderr ?? "" });
      },
    );
  });
}

/** Parse la section `Files:` de `pip show -f` — chemins listés relatifs à `Location:`. Format
 * réel : "Location: <dir>" puis "Files:" puis une ligne indentée par fichier ; absent (paquet sans
 * fichiers listés, ex: métapaquet) -> `files: []`, jamais fabriqué. */
function parsePipShowOutput(lines: string[]): { root: string | undefined; files: string[] } {
  let location: string | undefined;
  const relativeFiles: string[] = [];
  let inFilesSection = false;
  for (const rawLine of lines) {
    if (rawLine.startsWith("Location:")) {
      location = rawLine.slice("Location:".length).trim();
      inFilesSection = false;
      continue;
    }
    if (rawLine.trim() === "Files:") {
      inFilesSection = true;
      continue;
    }
    if (inFilesSection) {
      const trimmed = rawLine.trim();
      if (trimmed) relativeFiles.push(trimmed);
    }
  }
  const files = location ? relativeFiles.map((f) => `${location}/${f}`) : relativeFiles;
  return { root: location, files };
}

function honestNotFoundResult(packageName: string, goShaped: boolean): PackageFilesResult {
  return {
    ecosystem: "unknown",
    available: false,
    reason: goShaped
      ? `"${packageName}" a la forme d'un chemin de module Go (ex: github.com/..., golang.org/x/...) : ` +
        `un module Go est compilé STATIQUEMENT dans le binaire final, son code source n'est jamais ` +
        `présent dans l'image Docker — recherche npm volontairement pas tentée pour ce nom (aucun ` +
        `dossier node_modules/<chemin-go> ne peut exister).`
      : `Aucun fichier trouvé pour "${packageName}" via apt/dpkg, npm (node_modules) ou pip dans cette ` +
        `image. Cause probable : paquet d'un écosystème compilé sans code source embarqué dans ` +
        `l'image finale (ex: module Go, crate Rust), ou nom qui ne correspond à aucune convention ` +
        `reconnue par ces trois gestionnaires.`,
  };
}

function parseInspectionOutput(stdout: string, packageName: string, goShaped: boolean): PackageFilesResult {
  const lines = stdout.split("\n");

  const aptOkIndex = lines.findIndex((l) => l.startsWith("APT_OK "));
  if (aptOkIndex !== -1) {
    const resolvedName = lines[aptOkIndex]!.slice("APT_OK ".length).trim();
    const files = lines.slice(aptOkIndex + 1).filter((l) => l.trim() !== "");
    const result: PackageFilesResult = { ecosystem: "apt", available: files.length > 0, files };
    if (resolvedName !== packageName) {
      result.reason =
        `Résolu vers le paquet Debian réel "${resolvedName}" (best-effort : "${packageName}" n'est pas ` +
        `un nom de paquet dpkg exact sur cette image, "${resolvedName}" est le paquet installé le plus ` +
        `proche trouvé).`;
    }
    return result;
  }

  const npmOkIndex = lines.findIndex((l) => l.startsWith("NPM_OK "));
  if (npmOkIndex !== -1) {
    const dir = lines[npmOkIndex]!.slice("NPM_OK ".length).trim();
    const files = lines.slice(npmOkIndex + 1).filter((l) => l.trim() !== "");
    const result: PackageFilesResult = { ecosystem: "npm", available: files.length > 0, files, packageRoot: dir };
    if (files.length === 0) {
      result.reason = `Dossier "${dir}" trouvé mais aucun fichier .js/.mjs/.ts dedans (paquet purement natif/binaire, ou dossier vide).`;
    }
    return result;
  }

  const pipOkIndex = lines.findIndex((l) => l === "PIP_OK");
  if (pipOkIndex !== -1) {
    const { root, files } = parsePipShowOutput(lines.slice(pipOkIndex + 1));
    const result: PackageFilesResult = {
      ecosystem: "pip",
      available: files.length > 0,
      files,
      ...(root ? { packageRoot: root } : {}),
    };
    if (files.length === 0) {
      result.reason = `"pip show -f" n'a listé aucun fichier pour "${packageName}" (métadonnées seules, ex: paquet namespace/metapackage).`;
    }
    return result;
  }

  return honestNotFoundResult(packageName, goShaped);
}

/**
 * Retrouve les fichiers réels de `packageName` (tel que rapporté par Grype ou OSV-Scanner, voir
 * types.ts#Vulnerability#packageName) dans l'image Docker `imageReference` ("name:tag") — voir
 * l'en-tête de fichier pour la stratégie complète. Lève une VRAIE erreur (jamais un
 * `available: false` silencieux) pour toute panne d'infrastructure réelle : "docker" absent du
 * PATH, image introuvable localement, timeout — distinct du cas honnête "image inspectée avec
 * succès mais paquet non trouvé/sans source", seul cas qui retourne `available: false`.
 */
export async function resolvePackageFiles(imageReference: string, packageName: string): Promise<PackageFilesResult> {
  const trimmed = packageName.trim();
  if (!trimmed) {
    return { ecosystem: "unknown", available: false, reason: "Nom de paquet vide — rien à rechercher." };
  }

  const goShaped = looksLikeGoModulePath(trimmed);
  const script = buildInspectionScript(trimmed, { includeNpm: !goShaped });
  const { stdout, exitCode, stderr } = await runInspectionScript(imageReference, script);

  if (exitCode === null) {
    throw new Error(`Impossible de lancer "docker" pour inspecter l'image "${imageReference}" — binaire absent du PATH ?`);
  }

  if (exitCode !== 0) {
    if (isNoShellFailure(exitCode, stderr)) {
      // Image sans aucun shell POSIX (voir NO_SHELL_EXIT_CODE ci-dessus) : cas honnête, pas une
      // panne — typiquement une image minimale/scratch construite autour d'un unique binaire
      // compilé statiquement (Go, Rust...).
      return {
        ecosystem: "unknown",
        available: false,
        reason: goShaped
          ? `Image "${imageReference}" sans aucun shell POSIX (image minimale/scratch, typique d'un ` +
            `binaire Go compilé statiquement) — impossible de l'inspecter ; de toute façon, ` +
            `"${trimmed}" ressemble à un chemin de module Go dont le code source n'est jamais ` +
            `présent dans l'image finale.`
          : `Image "${imageReference}" sans aucun shell POSIX (image minimale/scratch, typique d'un ` +
            `binaire compilé statiquement — ex. Go ou Rust) — impossible d'y rechercher les fichiers ` +
            `de "${trimmed}".`,
      };
    }
    // Vraie panne (image introuvable localement, démon injoignable, timeout tué par execFile...) —
    // jamais avalée en un faux `available: false`.
    throw new Error(
      `Échec de l'inspection de l'image "${imageReference}" (code de sortie ${exitCode})` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
    );
  }

  return parseInspectionOutput(stdout, trimmed, goShaped);
}

// Exporté uniquement pour les tests unitaires du parsing pur (voir test/packageInspector.test.ts) —
// jamais utilisé en dehors de ce module en production.
export const __testing = {
  looksLikeGoModulePath,
  parseInspectionOutput,
  parsePipShowOutput,
  buildInspectionScript,
};
