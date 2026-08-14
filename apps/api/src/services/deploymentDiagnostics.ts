/**
 * Diagnostic générique des échecs de déploiement GitHub — retour utilisateur réel (14/08/2026) :
 * "un systeme si le build echoue un truc qui generer un rapport visible et claire detecte tout ce
 * qui ne vas pas etc pour guider utilisateur esaye de faire un puissant systeme generique".
 *
 * Moteur de RECONNAISSANCE DE MOTIFS sur le log brut d'un déploiement déjà terminé (jamais une
 * réimplémentation d'un vrai compilateur/linter/résolveur de paquets — uniquement des expressions
 * régulières sur les messages d'erreur bien connus des outils réellement invoqués par QUAI :
 * `docker build`, `docker compose`, `composer`, `npm`, `pip`). Chaque motif reconnu produit UN
 * diagnostic humain actionnable ; générique par construction (aucun motif spécifique à un dépôt
 * précis) — alimenté par les cas RÉELS rencontrés en conditions réelles sur ce projet (voir chaque
 * fonction ci-dessous). Repli honnête si AUCUN motif ne matche : un diagnostic "unknown" explicite,
 * jamais une supposition plausible mais fausse (règle absolue de ce projet).
 *
 * Appelé À LA DEMANDE par services/github.ts#getDeploymentDetail (jamais persisté) : reste
 * toujours cohérent avec le contenu actuel du log, sans migration de données historiques.
 */

import type { DeploymentDiagnostic } from "../types.js";

/** Quelques lignes de contexte autour d'un match — jamais le log entier (illisible), jamais une
 * seule ligne hors contexte (souvent insuffisant pour comprendre l'erreur réelle). */
function extractEvidence(log: string, matchIndex: number, contextLines = 2): string {
  const lines = log.split("\n");
  let charCount = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i]!.length + 1;
    if (charCount > matchIndex) {
      matchLine = i;
      break;
    }
  }
  const start = Math.max(0, matchLine - contextLines);
  const end = Math.min(lines.length, matchLine + contextLines + 1);
  return lines.slice(start, end).join("\n").trim();
}

// --- En-tête manquant pour compiler une extension (cas réel : ldap.h manquant sur
// mairie-creusot/formulaire_hotline, 14/08/2026 — Dockerfile installant `libldap` (runtime) sans
// `openldap-dev` (en-têtes), nécessaire à `docker-php-ext-install ldap`) -----------------------

/** Correspondance connue en-tête -> paquet(s) probable(s), documentée par écosystème — jamais une
 * certitude absolue (une image peut avoir un nom de paquet différent), toujours formulée comme une
 * suggestion. Complétée au fil des cas réels rencontrés (base solide, pas exhaustive à l'infini,
 * voir mission). */
const HEADER_TO_PACKAGE_HINT: Record<string, string> = {
  "ldap.h": "openldap-dev (Alpine) / libldap2-dev (Debian/Ubuntu)",
  "lber.h": "openldap-dev (Alpine) / libldap2-dev (Debian/Ubuntu)",
  "zlib.h": "zlib-dev (Alpine) / zlib1g-dev (Debian/Ubuntu)",
  "zip.h": "libzip-dev (Alpine et Debian/Ubuntu)",
  "curl.h": "curl-dev (Alpine) / libcurl4-openssl-dev (Debian/Ubuntu)",
  "png.h": "libpng-dev (Alpine et Debian/Ubuntu)",
  "jpeglib.h": "libjpeg-turbo-dev (Alpine) / libjpeg-dev (Debian/Ubuntu)",
  "ssl.h": "openssl-dev (Alpine) / libssl-dev (Debian/Ubuntu)",
  "parser.h": "libxml2-dev (Alpine et Debian/Ubuntu)",
  "sasl.h": "cyrus-sasl-dev (Alpine) / libsasl2-dev (Debian/Ubuntu)",
  "pq.h": "postgresql-dev (Alpine) / libpq-dev (Debian/Ubuntu)",
  "mysql.h": "mariadb-dev/mysql-dev (Alpine) / libmysqlclient-dev (Debian/Ubuntu)",
  "gd.h": "gd-dev (Alpine) / libgd-dev (Debian/Ubuntu)",
  "ffi.h": "libffi-dev (Alpine et Debian/Ubuntu)",
  "readline.h": "readline-dev (Alpine) / libreadline-dev (Debian/Ubuntu)",
};

function packageHintForHeader(headerPath: string): string {
  const base = headerPath.split("/").pop() ?? headerPath;
  const known = HEADER_TO_PACKAGE_HINT[base.toLowerCase()];
  if (known) return known;
  // Heuristique générique de repli : nom sans extension + "-dev" (convention très répandue sur
  // Alpine/Debian/Ubuntu) — présentée explicitement comme une supposition, jamais une certitude.
  const guess = base.replace(/\.h$/i, "");
  return `probablement un paquet "*-dev" contenant "${guess}" (ex: apk/apt search "${guess}") — non confirmé automatiquement`;
}

const MISSING_HEADER_PATTERNS = [
  /fatal error:\s*([\w./+-]+\.h):\s*No such file or directory/i,
  /configure:\s*error:.*?[Cc]annot find\s+([\w./+-]+\.h)/,
  /error:\s*([\w./+-]+\.h):\s*No such file or directory/i,
];

function diagnoseMissingHeader(log: string): DeploymentDiagnostic | null {
  for (const pattern of MISSING_HEADER_PATTERNS) {
    const match = pattern.exec(log);
    if (!match?.[1]) continue;
    const header = match[1];
    return {
      category: "missing-header",
      title: `En-tête manquant pour compiler une extension (${header})`,
      explanation:
        `Le build a échoué en cherchant à compiler une bibliothèque/extension qui a besoin de "${header}", absent de l'image ` +
        `— l'image de base installe généralement la bibliothèque d'exécution (runtime) mais pas ses en-têtes de développement, ` +
        `nécessaires uniquement à la compilation. C'est un problème du Dockerfile applicatif du dépôt, pas de QUAI.`,
      suggestedAction: `Ajoutez le paquet de développement correspondant dans le Dockerfile : ${packageHintForHeader(header)}.`,
      evidence: extractEvidence(log, match.index),
    };
  }
  return null;
}

// --- Échec de résolution de dépendances (composer/npm/pip) -------------------------------------

const DEPENDENCY_PATTERNS: Array<{ regex: RegExp; ecosystem: string }> = [
  { regex: /Could not find package ([^\s.]+)/i, ecosystem: "composer" },
  { regex: /\[?InvalidArgumentException\]?\s*Package ([^\s.]+)/i, ecosystem: "composer" },
  { regex: /Your requirements could not be resolved to an installable set of packages/i, ecosystem: "composer" },
  { regex: /npm ERR!\s*404\s+'?([^\s']+)'?\s+is not in this registry/i, ecosystem: "npm" },
  { regex: /npm ERR!\s*Cannot find module\s+'([^']+)'/i, ecosystem: "npm" },
  { regex: /npm ERR!\s*ERESOLVE/i, ecosystem: "npm" },
  { regex: /Could not find a version that satisfies the requirement ([^\s(]+)/i, ecosystem: "pip" },
  { regex: /No matching distribution found for ([^\s(]+)/i, ecosystem: "pip" },
];

function diagnoseMissingDependency(log: string): DeploymentDiagnostic | null {
  for (const { regex, ecosystem } of DEPENDENCY_PATTERNS) {
    const match = regex.exec(log);
    if (!match) continue;
    const packageName = match[1];
    return {
      category: "missing-dependency",
      title: packageName
        ? `Dépendance ${ecosystem} introuvable ou non résolue (${packageName})`
        : `Résolution de dépendances ${ecosystem} échouée`,
      explanation: packageName
        ? `Le gestionnaire de paquets "${ecosystem}" n'a pas pu résoudre/trouver "${packageName}" — nom mal orthographié, version ` +
          `inexistante, registre privé non accessible, ou paquet retiré.`
        : `Le gestionnaire de paquets "${ecosystem}" n'a pas pu résoudre l'ensemble des dépendances demandées (conflit de versions le plus souvent).`,
      suggestedAction:
        `Vérifiez le fichier de dépendances (composer.json/package.json/requirements.txt) du dépôt` +
        (packageName ? ` pour "${packageName}"` : "") +
        `, et si un registre privé est utilisé, vérifiez ses identifiants (voir la page Registries de QUAI).`,
      evidence: extractEvidence(log, match.index),
    };
  }
  return null;
}

// --- Image introuvable / non autorisée ----------------------------------------------------------

const IMAGE_NOT_FOUND_PATTERNS = [
  /pull access denied for ([^\s,]+)/i,
  /manifest for ([^\s]+) not found/i,
  /repository ([^\s]+) does not exist/i,
  /unauthorized: authentication required/i,
  /401 Unauthorized/i,
  /(?:^|\s)404 Not Found(?:\s|$)/,
];

function diagnoseImageNotFound(log: string): DeploymentDiagnostic | null {
  for (const pattern of IMAGE_NOT_FOUND_PATTERNS) {
    const match = pattern.exec(log);
    if (!match) continue;
    const image = match[1];
    return {
      category: "image-not-found",
      title: image ? `Image "${image}" introuvable ou non autorisée` : "Image de base introuvable ou non autorisée",
      explanation:
        "Docker n'a pas pu récupérer une image (base du Dockerfile, ou image d'un service docker-compose) — l'image n'existe pas " +
        "sous ce nom/tag, ou le registre exige des identifiants que QUAI n'a pas (ou des identifiants invalides).",
      suggestedAction:
        "Vérifiez le nom/tag exact de l'image dans le Dockerfile/docker-compose.yml, et si c'est un registre privé, configurez-le " +
        "dans la page Registries de QUAI avec des identifiants valides.",
      evidence: extractEvidence(log, match.index),
    };
  }
  return null;
}

// --- Erreur de syntaxe YAML (compose) / HCL (Terraform) -----------------------------------------

const SYNTAX_ERROR_PATTERNS = [
  /YAMLException/i,
  /bad indentation/i,
  /mapping values are not allowed/i,
  /while parsing a block/i,
  /yaml:\s*line\s*(\d+)/i,
  /Error:\s*.*?\.tf.*?:\s*.*?(Argument or block definition required|Unsupported argument|Invalid character|Missing required argument)/i,
];

function diagnoseSyntaxError(log: string): DeploymentDiagnostic | null {
  for (const pattern of SYNTAX_ERROR_PATTERNS) {
    const match = pattern.exec(log);
    if (!match) continue;
    const lineMatch = /(?:line|:)\s*(\d+)/i.exec(match[0]);
    return {
      category: "syntax-error",
      title: "Fichier de configuration invalide (YAML/HCL)",
      explanation:
        `Le fichier compose (YAML) ou Terraform (HCL) de ce dépôt contient une erreur de syntaxe qui empêche son interprétation` +
        (lineMatch ? ` (voir ligne ${lineMatch[1]} indiquée par l'outil)` : "") +
        `.`,
      suggestedAction: "Corrigez la syntaxe du fichier indiqué (indentation YAML, accolades/guillemets HCL) puis relancez le déploiement.",
      evidence: extractEvidence(log, match.index),
    };
  }
  return null;
}

// --- Dépendance de service compose en échec (cas RÉEL rencontré le 14/08/2026 sur
// mairie-creusot/formulaire_hotline : le service "app" attend `depends_on: db: condition:
// service_healthy`, mais le conteneur "db" (mysql:8.0) sort en erreur juste après son démarrage —
// le build de l'image applicative avait pourtant RÉUSSI, l'échec est purement au démarrage) -------

const DEPENDENCY_FAILED_PATTERNS = [
  /dependency failed to start: container ([^\s]+) exited \((\d+)\)/i,
  /Container ([^\s]+)\s+Error\b/,
];

function diagnoseDependencyFailed(log: string): DeploymentDiagnostic | null {
  for (const pattern of DEPENDENCY_FAILED_PATTERNS) {
    const match = pattern.exec(log);
    if (!match) continue;
    const containerName = match[1];
    return {
      category: "dependency-failed",
      title: containerName ? `Un service dont dépend le déploiement a échoué à démarrer (${containerName})` : "Un service dépendant a échoué à démarrer",
      explanation:
        "L'image applicative a été construite avec succès, mais docker-compose attend qu'un AUTRE service (base de données le " +
        "plus souvent) devienne réellement sain avant de démarrer les services qui en dépendent — ce service s'est arrêté en " +
        "erreur juste après son démarrage, avant d'y parvenir.",
      suggestedAction:
        "Consultez les logs du conteneur concerné (page Conteneurs de QUAI, ou `docker logs` sur l'hôte) pour la cause exacte " +
        "— souvent une variable d'environnement invalide pour ce service, un volume de données corrompu d'un essai précédent, " +
        "ou une ressource insuffisante (mémoire) sur l'hôte Docker.",
      evidence: extractEvidence(log, match.index),
    };
  }
  return null;
}

// --- Cas déjà gérés EN AMONT du build par QUAI lui-même (conflit de port, configuration
// manquante) — ne devraient normalement plus jamais atteindre ce diagnostic post-mortem (ces
// situations produisent respectivement un remap automatique ou un statut "needs-config" dédié,
// jamais un statut "failed"), mais reconnus quand même par cohérence si un cas limite les laisse
// passer jusqu'ici malgré tout (voir mission). -------------------------------------------------

function diagnosePortConflict(log: string): DeploymentDiagnostic | null {
  const match = /port is already allocated|address already in use|ports are not available/i.exec(log);
  if (!match) return null;
  return {
    category: "port-conflict",
    title: "Conflit de port hôte non résolu automatiquement",
    explanation:
      "Un port hôte demandé par ce déploiement est déjà utilisé par un autre processus de l'hôte Docker — normalement détecté et " +
      "remplacé automatiquement par QUAI avant ce point, ce cas limite y a échappé.",
    suggestedAction: "Relancez le déploiement (un nouveau port libre sera choisi), ou précisez un port hôte différent explicitement.",
    evidence: extractEvidence(log, match.index),
  };
}

function diagnoseMissingConfig(log: string): DeploymentDiagnostic | null {
  const match = /Configuration requise avant de déployer/i.exec(log);
  if (!match) return null;
  return {
    category: "missing-config",
    title: "Configuration incomplète non bloquée avant le build",
    explanation:
      'Ce déploiement mentionne une "configuration requise" dans son propre journal — normalement ce cas produit un statut ' +
      '"needs-config" dédié plutôt qu\'un échec, ce cas limite y a échappé.',
    suggestedAction: "Ouvrez le formulaire de configuration de ce dépôt pour renseigner les valeurs manquantes puis relancez.",
    evidence: extractEvidence(log, match.index),
  };
}

/** Repli honnête — jamais une supposition plausible mais fausse (règle absolue de ce projet). */
function unknownDiagnostic(): DeploymentDiagnostic {
  return {
    category: "unknown",
    title: "Cause non reconnue automatiquement",
    explanation: "Aucun motif d'erreur connu n'a été détecté dans ce journal par le moteur de diagnostic.",
    suggestedAction: "Consultez le journal complet ci-dessous pour identifier la cause exacte.",
  };
}

const DIAGNOSTIC_FUNCTIONS = [
  diagnoseMissingHeader,
  diagnoseMissingDependency,
  diagnoseImageNotFound,
  diagnoseSyntaxError,
  diagnoseDependencyFailed,
  diagnosePortConflict,
  diagnoseMissingConfig,
];

/**
 * GET /api/github/deployments/:id (voir services/github.ts#getDeploymentDetail) — analyse le log
 * complet d'un déploiement en échec et retourne un ou plusieurs diagnostics structurés. Toujours
 * AU MOINS un élément (jamais [] — voir unknownDiagnostic ci-dessus, repli honnête).
 */
export function diagnoseDeploymentFailure(log: string): DeploymentDiagnostic[] {
  const found: DeploymentDiagnostic[] = [];
  for (const fn of DIAGNOSTIC_FUNCTIONS) {
    const diagnostic = fn(log);
    if (diagnostic) found.push(diagnostic);
  }
  return found.length > 0 ? found : [unknownDiagnostic()];
}
