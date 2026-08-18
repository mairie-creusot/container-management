// Logique PURE du studio de templates (bases, étapes de recette, validations, statut de tâche
// Prism) — testée par templateCatalog.test.ts, aucun accès réseau/Redux ici.
import type {
  ImageTemplateArtifactType,
  ImageTemplateStatus,
  NutanixImageSummary,
  NutanixTaskStatus,
  TemplateBase,
  TemplateStep,
} from "@/types";

// --- Bases -------------------------------------------------------------------------------------

export const TEMPLATE_BASE_TYPE_LABEL: Record<TemplateBase["type"], string> = {
  "cloud-image": "VM cloud-image",
  container: "Conteneur",
  mkosi: "OS minimal (mkosi)",
  iso: "ISO (installation manuelle)",
};

/** Suggestions de saisie — la distro/l'image restent LIBRES (cœur de la demande utilisateur). */
export const CLOUD_IMAGE_DISTRO_SUGGESTIONS = ["ubuntu", "debian"];
export const CONTAINER_IMAGE_SUGGESTIONS = ["scratch", "debian:bookworm", "alpine:3.20"];

export const MKOSI_DISTROS = ["debian", "ubuntu", "fedora", "arch"] as const;
export type MkosiDistro = (typeof MKOSI_DISTROS)[number];

/** Release mkosi proposée par défaut pour chaque distro — modifiable librement ensuite. */
export const MKOSI_DEFAULT_RELEASE: Record<MkosiDistro, string> = {
  debian: "bookworm",
  ubuntu: "noble",
  fedora: "40",
  arch: "rolling",
};

/** Releases mkosi suggérées par distro (pills du studio) — la saisie reste libre. */
export const MKOSI_RELEASE_SUGGESTIONS: Record<MkosiDistro, string[]> = {
  debian: ["trixie", "bookworm"],
  ubuntu: ["noble", "jammy"],
  fedora: ["41", "40"],
  arch: ["rolling"],
};

/** Base par défaut d'un onglet du studio quand on bascule dessus sans recette pré-remplie. */
export function defaultBase(type: TemplateBase["type"]): TemplateBase {
  if (type === "cloud-image") return { type: "cloud-image", distro: "ubuntu", version: "24.04" };
  if (type === "container") return { type: "container", image: "debian:bookworm" };
  if (type === "iso") return { type: "iso", imageUuid: "" };
  return { type: "mkosi", distro: "debian", release: MKOSI_DEFAULT_RELEASE.debian };
}

/** Libellé court d'une base pour les chips/résumés — ex: "VM cloud-image ubuntu 24.04". */
export function templateBaseLabel(base: TemplateBase): string {
  if (base.type === "cloud-image") return `VM cloud-image ${base.distro} ${base.version}`.trim();
  if (base.type === "container") return `Conteneur ${base.image}`.trim();
  if (base.type === "iso") return base.imageUuid === "" ? "ISO (à choisir)" : `ISO ${base.imageUuid}`;
  return `mkosi ${base.distro} ${base.release}`.trim();
}

/** Cible produite par la base — pilote uniquement des textes d'aide côté studio. */
export function templateBaseTarget(base: TemplateBase): "vm" | "container" | "raw-image" {
  if (base.type === "cloud-image" || base.type === "iso") return "vm";
  if (base.type === "container") return "container";
  return "raw-image";
}

/** Une base ISO ne se construit pas : le template est "ready" dès la création (POST .../build → 400). */
export function baseIsBuildable(base: TemplateBase): boolean {
  return base.type !== "iso";
}

/** Une base ISO n'accepte aucune étape de provisioning — l'OS n'est pas encore installé. */
export function baseSupportsSteps(base: TemplateBase): boolean {
  return base.type !== "iso";
}

export const ISO_STEPS_DISABLED_MESSAGE =
  "Une base ISO n'a pas d'étapes de provisioning : l'OS n'est pas encore installé — il s'installera à la main via la console VNC après le déploiement en VM.";

/** ISO du catalogue Prism : imageType contenant "ISO" (casse ignorée) — jamais deviné sans type. */
export function isIsoImage(image: NutanixImageSummary): boolean {
  return (image.imageType ?? "").toUpperCase().includes("ISO");
}

// --- Étapes de recette -------------------------------------------------------------------------

export const STEP_TYPE_LABEL: Record<TemplateStep["type"], string> = {
  packages: "Paquets",
  script: "Script",
  file: "Fichier",
  artifact: "Artefact plateforme",
  user: "Utilisateur",
  service: "Service",
};

export const STEP_TYPES: TemplateStep["type"][] = ["packages", "script", "file", "artifact", "user", "service"];

/** Étape vierge d'un type donné — valeurs neutres, à compléter dans l'éditeur. */
export function createStep(type: TemplateStep["type"]): TemplateStep {
  switch (type) {
    case "packages":
      return { type: "packages", packages: [] };
    case "script":
      return { type: "script", content: "" };
    case "file":
      return { type: "file", path: "", content: "" };
    case "artifact":
      return { type: "artifact", templateId: "", destPath: "" };
    case "user":
      return { type: "user", username: "" };
    case "service":
      return { type: "service", name: "", enable: true };
  }
}

/** Résumé d'une ligne de la liste de recette — jamais le contenu complet. */
export function stepSummary(step: TemplateStep): string {
  switch (step.type) {
    case "packages":
      return step.packages.length === 0 ? "aucun paquet" : step.packages.join(", ");
    case "script": {
      const firstLine = step.content.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
      return firstLine === "" ? "script vide" : firstLine;
    }
    case "file":
      return step.path === "" ? "chemin à renseigner" : step.path;
    case "artifact":
      return step.templateId === "" ? "artefact à choisir" : `→ ${step.destPath || "destination à renseigner"}`;
    case "user":
      return step.username === "" ? "nom à renseigner" : `${step.username}${step.sudo ? " (sudo)" : ""}`;
    case "service":
      return step.name === "" ? "nom à renseigner" : `${step.name} — ${step.enable ? "activé" : "désactivé"}`;
  }
}

/** Résumé de la recette pour le panneau de détail — ex: "3 étapes : paquets, script, fichier". */
export function recipeSummary(steps: TemplateStep[]): string {
  if (steps.length === 0) return "Recette vide (base nue)";
  const types = [...new Set(steps.map((s) => STEP_TYPE_LABEL[s.type].toLowerCase()))].join(", ");
  return `${steps.length} ${steps.length > 1 ? "étapes" : "étape"} : ${types}`;
}

/** Déplace l'étape `index` de `delta` (±1) — retourne le même tableau si le déplacement sort des bornes. */
export function moveStep(steps: TemplateStep[], index: number, delta: -1 | 1): TemplateStep[] {
  const target = index + delta;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

// --- Validation locale légère (le serveur reste juge en dernier ressort) -----------------------

/** Nom de paquet plausible (apt/dnf/pacman/apk) : lettres/chiffres + .+-_:@ — jamais d'espace. */
export function isValidPackageName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9.+_:@-]*$/.test(name);
}

/** Chemin POSIX absolu exigé pour file.path et artifact.destPath. */
export function isAbsolutePosixPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\\") && path.trim() === path && path.length > 1;
}

/** Mode octal optionnel d'un fichier ("644", "0755"…) — vide = défaut serveur. */
export function isValidFileMode(mode: string): boolean {
  return /^0?[0-7]{3,4}$/.test(mode);
}

/** Erreur bloquante d'une étape, null si elle est valide — messages FR affichés tels quels. */
export function stepError(step: TemplateStep): string | null {
  switch (step.type) {
    case "packages": {
      if (step.packages.length === 0) return "Ajoutez au moins un paquet.";
      const bad = step.packages.find((p) => !isValidPackageName(p));
      return bad ? `Nom de paquet invalide : « ${bad} ».` : null;
    }
    case "script":
      return step.content.trim() === "" ? "Le script est vide." : null;
    case "file":
      if (!isAbsolutePosixPath(step.path)) return "Chemin absolu requis (ex : /etc/motd).";
      if (step.mode !== undefined && step.mode !== "" && !isValidFileMode(step.mode)) return "Mode invalide (ex : 644 ou 0755).";
      return null;
    case "artifact":
      if (step.templateId === "") return "Choisissez un artefact source.";
      if (!isAbsolutePosixPath(step.destPath)) return "Chemin de destination absolu requis (ex : /opt/app.tar).";
      return null;
    case "user":
      return /^[a-z_][a-z0-9_-]{0,31}$/.test(step.username) ? null : "Nom d'utilisateur POSIX invalide (minuscules).";
    case "service":
      return /^[a-zA-Z0-9@._-]+$/.test(step.name) ? null : "Nom de service invalide (ex : nginx).";
  }
}

/** Erreur bloquante de la base, null si valide. */
export function baseError(base: TemplateBase): string | null {
  if (base.type === "cloud-image") {
    if (base.distro.trim() === "") return "Indiquez une distribution (ex : ubuntu, debian).";
    if (base.version.trim() === "") return "Indiquez une version (ex : 24.04, 12).";
    if (base.imageUrl !== undefined && base.imageUrl !== "" && !/^https?:\/\/.+/.test(base.imageUrl))
      return "URL d'image invalide (http(s)://…).";
    return null;
  }
  if (base.type === "container") {
    return base.image.trim() === "" ? "Indiquez une image de base (ex : scratch, debian:bookworm)." : null;
  }
  if (base.type === "iso") {
    return base.imageUuid === "" ? "Choisissez un ISO du catalogue Prism (ou importez-en un)." : null;
  }
  return base.release.trim() === "" ? "Indiquez une release (ex : bookworm, noble)." : null;
}

/** Découpe une saisie de tags de paquets (espaces/virgules/retours à la ligne), sans doublons. */
export function parsePackagesInput(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((p) => p.trim()).filter((p) => p.length > 0))];
}

// --- Libellés partagés (panneau de détail, popovers) -------------------------------------------

export const TEMPLATE_STATUS_LABEL: Record<ImageTemplateStatus, string> = {
  draft: "Brouillon (jamais construit)",
  building: "Build en cours…",
  ready: "Prêt",
  error: "Build en échec",
};

/** Projection d'un statut de template sur la même palette de pastilles que le reste du graphe. */
export const TEMPLATE_STATUS_SEMANTIC: Record<ImageTemplateStatus, "success" | "critical" | "warning" | "neutral"> = {
  draft: "neutral",
  building: "warning",
  ready: "success",
  error: "critical",
};

export const ARTIFACT_TYPE_LABEL: Record<ImageTemplateArtifactType, string> = {
  "nutanix-image": "Image Nutanix (AHV)",
  "docker-image": "Image Docker",
  "raw-image": "Image disque brute (mkosi)",
};

// --- Déploiement en VM ---------------------------------------------------------------------------

/** Défauts raisonnables pré-remplis (mission "prêt en 2 min") — toujours ajustables. */
export const VM_DEPLOY_DEFAULTS = { numVcpus: 2, numCoresPerVcpu: 1, memoryMib: 4096, diskSizeGib: 50 };

/** Nom de VM/hostname valide (RFC 952/1123 simplifié) : 1-63 caractères alphanumériques/tirets,
 * jamais de tiret en tête/queue — même valeur envoyée comme nom ET hostname. */
export function isValidVmName(name: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name);
}

/** Compte invité valide : username POSIX + mot de passe OU clé SSH (au moins l'un des deux). */
export function isValidGuestAccount(username: string, password: string, sshKey: string): boolean {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) return false;
  return password.length > 0 || sshKey.trim().length > 0;
}

export type NutanixTaskOutcome = "running" | "succeeded" | "failed";

/** Statut brut Prism Central -> issue exploitable — tout statut inconnu reste "running" (le poll
 * continue plutôt que de conclure à tort). */
export function nutanixTaskOutcome(task: NutanixTaskStatus): NutanixTaskOutcome {
  const s = task.status.toUpperCase();
  if (s === "SUCCEEDED" || s === "SUCCESS" || s === "COMPLETED") return "succeeded";
  if (s === "FAILED" || s === "ERROR" || s === "ABORTED" || s === "CANCELED" || s === "CANCELLED") return "failed";
  return "running";
}

/** Pourcentage affiché pour la barre de progression — borné 0..100, 100 si la tâche a réussi sans
 * pourcentage rapporté, 0 sinon (jamais une progression inventée). */
export function nutanixTaskPercent(task: NutanixTaskStatus): number {
  if (typeof task.percentageComplete === "number") return Math.max(0, Math.min(100, task.percentageComplete));
  return nutanixTaskOutcome(task) === "succeeded" ? 100 : 0;
}
