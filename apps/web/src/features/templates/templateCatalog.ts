// Logique PURE de la fabrique de templates (choix de base, composants, défauts VM, statut de
// tâche Prism) — testée par templateCatalog.test.ts, aucun accès réseau/Redux ici.
import type { ImageTemplateKind, ImageTemplateStatus, NutanixTaskStatus } from "@/types";

export interface TemplateBaseOption {
  kind: ImageTemplateKind;
  title: string;
  description: string;
  target: "vm" | "container";
  /** Versions proposées en select — [] = saisie libre (tag Alpine) ou version figée. */
  baseVersions: string[];
  defaultBaseVersion: string;
  /** true = champ texte libre (tag), false = select (ou valeur figée si baseVersions est vide). */
  baseVersionEditable: boolean;
}

export const TEMPLATE_BASE_OPTIONS: TemplateBaseOption[] = [
  {
    kind: "vm-ubuntu",
    title: "Ubuntu Server",
    description: "VM construite via Packer sur le cluster Nutanix — image AHV prête à déployer.",
    target: "vm",
    baseVersions: ["24.04", "26.04"],
    defaultBaseVersion: "24.04",
    baseVersionEditable: false,
  },
  {
    kind: "container-alpine",
    title: "Alpine",
    description: "Image de conteneur légère — choisissez le tag Alpine de base.",
    target: "container",
    baseVersions: [],
    defaultBaseVersion: "3.20",
    baseVersionEditable: true,
  },
  {
    kind: "container-scratch",
    title: "scratch",
    description: "Conteneur ultra-minimal, sans distribution — pour binaires statiques.",
    target: "container",
    baseVersions: [],
    defaultBaseVersion: "latest",
    baseVersionEditable: false,
  },
];

export function templateBaseOption(kind: ImageTemplateKind): TemplateBaseOption {
  // Les 3 kinds du contrat sont tous déclarés ci-dessus — le repli n'arrive jamais en pratique.
  return TEMPLATE_BASE_OPTIONS.find((o) => o.kind === kind) ?? TEMPLATE_BASE_OPTIONS[0]!;
}

export interface TemplateComponentOption {
  id: string;
  label: string;
  /** Toujours inclus (case cochée non décochable) — ex : Docker + Compose pour vm-ubuntu. */
  required: boolean;
  defaultChecked: boolean;
}

export const TEMPLATE_COMPONENTS: Record<ImageTemplateKind, TemplateComponentOption[]> = {
  "vm-ubuntu": [
    { id: "docker", label: "Docker Engine", required: true, defaultChecked: true },
    { id: "docker-compose", label: "Docker Compose (plugin)", required: true, defaultChecked: true },
    { id: "qemu-guest-agent", label: "QEMU guest agent (recommandé sur AHV)", required: false, defaultChecked: true },
    { id: "openssh-server", label: "Serveur SSH", required: false, defaultChecked: true },
  ],
  "container-alpine": [
    { id: "ca-certificates", label: "Certificats racine (ca-certificates)", required: false, defaultChecked: true },
    { id: "curl", label: "curl", required: false, defaultChecked: false },
    { id: "tzdata", label: "Fuseaux horaires (tzdata)", required: false, defaultChecked: false },
  ],
  "container-scratch": [
    { id: "ca-certificates", label: "Certificats racine (ca-certificates)", required: false, defaultChecked: false },
  ],
};

/** Composants cochés par défaut pour un kind. */
export function defaultComponents(kind: ImageTemplateKind): string[] {
  return TEMPLATE_COMPONENTS[kind].filter((c) => c.defaultChecked || c.required).map((c) => c.id);
}

/** Sélection nettoyée avant POST : composants requis toujours inclus, ids inconnus écartés,
 * ordre stable = celui du catalogue. */
export function normalizeComponents(kind: ImageTemplateKind, selected: string[]): string[] {
  const picked = new Set(selected);
  return TEMPLATE_COMPONENTS[kind].filter((c) => c.required || picked.has(c.id)).map((c) => c.id);
}

export const TEMPLATE_KIND_LABEL: Record<ImageTemplateKind, string> = {
  "vm-ubuntu": "VM Ubuntu Server",
  "container-alpine": "Conteneur Alpine",
  "container-scratch": "Conteneur scratch",
};

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
