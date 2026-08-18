// Moteur de recettes de templates d'images : une base (cloud-image/container/mkosi) + des étapes
// libres, transformées en vrais fichiers de build (Packer/Dockerfile/mkosi) dans un workspace IaC.
// SECRETS : identifiants Prism jamais écrits sur disque (PKR_VAR_* injectées au spawn uniquement).
// Les scripts libres ne sont JAMAIS exécutés par QUAI : uniquement provisionnés dans la VM/l'image.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getEffectiveNutanixConfig } from "./setupStore.js";
import { createWorkspace, deleteWorkspace, workspaceFilesPath, writeFile, WorkspaceNotFoundError } from "./iac/workspaces.js";
import { lintShellScript } from "./iac/lint.js";
import { getEngineStatus } from "./iac/engines.js";
import { getRun, listRuns, startRun } from "./iac/runner.js";
import {
  getStoredTemplate,
  insertTemplate,
  listStoredTemplates,
  removeStoredTemplate,
  TemplateNotFoundError,
  updateStoredTemplate,
} from "./templatesStore.js";
import type {
  IacEngine,
  IacRun,
  ImageTemplate,
  ImageTemplateLastBuild,
  TemplateArtifactSource,
  TemplateBase,
  TemplatePreset,
  TemplateStep,
} from "../types.js";

export { TemplateNotFoundError } from "./templatesStore.js";

export class TemplateValidationError extends Error {}

export class NutanixNotConfiguredError extends Error {}

export class MkosiUnavailableError extends Error {}

export class TemplateBuildInProgressError extends Error {}

// Noms de paquets : jamais interprétés par un shell QUAI — validés ici puis interpolés uniquement
// dans des fichiers exécutés DANS la VM/l'image de build.
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISTRO_PATTERN = /^[a-z][a-z0-9-]*$/;
const CONTAINER_IMAGE_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[0-9]+)?(?:\/[a-zA-Z0-9._-]+)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
// Chemins VM/image : absolus, segments sûrs (quotables sans ambiguïté), jamais de "..".
const ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const FILE_MODE_PATTERN = /^[0-7]{3,4}$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;
const IMAGE_URL_PATTERN = /^https?:\/\/[^\s"'\\]+$/;
const SSH_KEY_PATTERN = /^[A-Za-z0-9@:. +\/=_-]+$/;
// Même format strict que runner.ts#DOCKER_TAG_PATTERN — revalidé avant tout argv `docker save`.
const DOCKER_REFERENCE_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

const MKOSI_DISTROS = ["debian", "ubuntu", "fedora", "arch"] as const;
// uuid v3 Prism (même forme que WORKSPACE_ID_PATTERN) — format seulement : l'existence réelle de
// l'ISO dans le catalogue est arbitrée par Prism au déploiement, jamais devinée ici.
const IMAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEPS = 50;
const MAX_SCRIPT_LENGTH = 256 * 1024;
const MAX_FILE_CONTENT_LENGTH = 1024 * 1024;

// Versions Debian publiées (cloud.debian.org est indexé par nom de code) — une version inconnue
// exige un imageUrl explicite, jamais un nom de code deviné.
const DEBIAN_CODENAMES: Record<string, string> = { "10": "buster", "11": "bullseye", "12": "bookworm", "13": "trixie" };

export interface CreateTemplateInput {
  name: string;
  base: TemplateBase;
  steps: TemplateStep[];
}

/** "Mon Template 1!" -> "mon-template-1" — pour les tags docker/noms d'image. */
export function sanitizeTemplateSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "template";
}

/** Tag réel du `docker build -t` d'un template conteneur — contrat : quai-template/<name>:<id-court>. */
export function dockerTagForTemplate(template: Pick<ImageTemplate, "id" | "name">): string {
  return `quai-template/${sanitizeTemplateSlug(template.name)}:${template.id.slice(0, 8)}`;
}

/** Nom de l'image produite (image disque Nutanix pour cloud-image, ImageId mkosi). */
export function imageNameForTemplate(template: Pick<ImageTemplate, "id" | "name">): string {
  return `quai-template-${sanitizeTemplateSlug(template.name)}-${template.id.slice(0, 8)}`;
}

/** Chemin relatif (workspace) de l'image disque produite par un build mkosi (Format=disk). */
export function mkosiOutputPathForTemplate(template: Pick<ImageTemplate, "id" | "name">): string {
  return `mkosi.output/${imageNameForTemplate(template)}.raw`;
}

/** "https://prism.lecreusot.fr:9440" -> { endpoint, port } — le plugin Nutanix attend un FQDN/IP
 * et un port séparés, pas une URL complète. */
export function parsePrismEndpoint(prismCentralUrl: string): { endpoint: string; port?: number } {
  try {
    const url = new URL(prismCentralUrl.includes("://") ? prismCentralUrl : `https://${prismCentralUrl}`);
    return { endpoint: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) };
  } catch {
    return { endpoint: prismCentralUrl };
  }
}

/** URL réelle de l'image cloud source — imageUrl explicite prioritaire, sinon résolution
 * ubuntu/debian officielles ; toute autre distro EXIGE un imageUrl (jamais une URL inventée). */
export function resolveCloudImageUrl(base: Extract<TemplateBase, { type: "cloud-image" }>): string {
  if (base.imageUrl) return base.imageUrl;
  if (base.distro === "ubuntu") {
    if (!/^\d{2}\.\d{2}$/.test(base.version)) {
      throw new TemplateValidationError(`version Ubuntu attendue au format "24.04" (reçu "${base.version}") — ou fournissez imageUrl`);
    }
    return `https://cloud-images.ubuntu.com/releases/${base.version}/release/ubuntu-${base.version}-server-cloudimg-amd64.img`;
  }
  if (base.distro === "debian") {
    const byCodename = Object.entries(DEBIAN_CODENAMES).find(([, codename]) => codename === base.version);
    const num = DEBIAN_CODENAMES[base.version] ? base.version : byCodename?.[0];
    const codename = DEBIAN_CODENAMES[base.version] ?? (byCodename ? base.version : undefined);
    if (!num || !codename) {
      throw new TemplateValidationError(
        `version Debian inconnue "${base.version}" (connues : ${Object.keys(DEBIAN_CODENAMES).join(", ")}) — fournissez imageUrl pour une autre version`,
      );
    }
    return `https://cloud.debian.org/images/cloud/${codename}/latest/debian-${num}-genericcloud-amd64.qcow2`;
  }
  throw new TemplateValidationError(`distro "${base.distro}" sans résolution d'image connue : imageUrl est REQUIS`);
}

function assertSafeAbsolutePath(value: string, field: string): void {
  if (!ABSOLUTE_PATH_PATTERN.test(value) || value.split("/").includes("..")) {
    throw new TemplateValidationError(`${field} doit être un chemin absolu sûr (ex "/opt/app/fichier"), sans ".." — reçu "${value}"`);
  }
}

function imageBaseName(image: string): string {
  const withoutDigest = image.split("@")[0] ?? image;
  const last = withoutDigest.split("/").at(-1) ?? withoutDigest;
  return last.split(":")[0] ?? last;
}

type PackageManager = "apt" | "apk" | "dnf" | "pacman";

/** Gestionnaire de paquets déduit du NOM de l'image de base — undefined si inconnu (refus honnête
 * plutôt qu'une commande d'installation devinée). */
export function packageManagerForImage(image: string): PackageManager | undefined {
  const name = imageBaseName(image);
  if (name === "alpine") return "apk";
  if (name === "debian" || name === "ubuntu") return "apt";
  if (["fedora", "centos", "rockylinux", "almalinux"].includes(name)) return "dnf";
  if (name === "archlinux") return "pacman";
  return undefined;
}

function validateBase(base: TemplateBase): void {
  switch (base.type) {
    case "cloud-image": {
      if (!DISTRO_PATTERN.test(base.distro)) throw new TemplateValidationError(`distro invalide "${base.distro}"`);
      if (!SAFE_VERSION_PATTERN.test(base.version)) throw new TemplateValidationError(`version invalide "${base.version}"`);
      if (base.imageUrl !== undefined && (!IMAGE_URL_PATTERN.test(base.imageUrl) || base.imageUrl.includes("${"))) {
        throw new TemplateValidationError(`imageUrl doit être une URL http(s) sans espace ni guillemet`);
      }
      resolveCloudImageUrl(base);
      return;
    }
    case "container": {
      if (base.image !== "scratch" && !CONTAINER_IMAGE_PATTERN.test(base.image)) {
        throw new TemplateValidationError(`image conteneur invalide "${base.image}"`);
      }
      return;
    }
    case "mkosi": {
      if (!MKOSI_DISTROS.includes(base.distro)) {
        throw new TemplateValidationError(`distro mkosi "${base.distro as string}" non supportée (${MKOSI_DISTROS.join(", ")})`);
      }
      if (!SAFE_VERSION_PATTERN.test(base.release)) throw new TemplateValidationError(`release mkosi invalide "${base.release}"`);
      return;
    }
    case "iso": {
      if (typeof base.imageUuid !== "string" || !IMAGE_UUID_PATTERN.test(base.imageUuid)) {
        throw new TemplateValidationError(`imageUuid doit être un uuid d'image Prism (reçu "${String(base.imageUuid)}")`);
      }
      return;
    }
    default:
      throw new TemplateValidationError(`base.type inconnu`);
  }
}

function validateStep(step: TemplateStep, index: number, base: TemplateBase): void {
  const at = `étape ${index + 1} (${(step as { type?: string }).type ?? "?"})`;
  const isScratch = base.type === "container" && base.image === "scratch";
  switch (step.type) {
    case "packages": {
      if (!Array.isArray(step.packages) || step.packages.length === 0) {
        throw new TemplateValidationError(`${at} : packages doit être une liste non vide`);
      }
      for (const pkg of step.packages) {
        if (typeof pkg !== "string" || !PACKAGE_NAME_PATTERN.test(pkg)) {
          throw new TemplateValidationError(`${at} : nom de paquet invalide "${String(pkg)}"`);
        }
      }
      if (isScratch) throw new TemplateValidationError(`${at} : impossible sur une image scratch (aucun gestionnaire de paquets)`);
      if (base.type === "container" && !packageManagerForImage(base.image)) {
        throw new TemplateValidationError(
          `${at} : gestionnaire de paquets inconnu pour l'image "${base.image}" — utilisez une étape script`,
        );
      }
      return;
    }
    case "script": {
      if (typeof step.content !== "string" || !step.content.trim()) {
        throw new TemplateValidationError(`${at} : content est requis`);
      }
      if (step.content.length > MAX_SCRIPT_LENGTH) throw new TemplateValidationError(`${at} : script trop long`);
      if (isScratch) throw new TemplateValidationError(`${at} : impossible sur une image scratch (aucun shell)`);
      return;
    }
    case "file": {
      if (typeof step.path !== "string") throw new TemplateValidationError(`${at} : path est requis`);
      assertSafeAbsolutePath(step.path, `${at} : path`);
      if (typeof step.content !== "string") throw new TemplateValidationError(`${at} : content est requis`);
      if (step.content.length > MAX_FILE_CONTENT_LENGTH) throw new TemplateValidationError(`${at} : contenu trop volumineux`);
      if (step.mode !== undefined && !FILE_MODE_PATTERN.test(step.mode)) {
        throw new TemplateValidationError(`${at} : mode doit être octal (ex "644", "0755")`);
      }
      // COPY --chmod exigerait BuildKit (absent du démon piloté) et chmod exige un shell.
      if (step.mode !== undefined && isScratch) {
        throw new TemplateValidationError(`${at} : mode non applicable sur une image scratch (aucun shell pour chmod)`);
      }
      return;
    }
    case "artifact": {
      if (typeof step.templateId !== "string" || !step.templateId.trim()) {
        throw new TemplateValidationError(`${at} : templateId est requis`);
      }
      if (typeof step.destPath !== "string") throw new TemplateValidationError(`${at} : destPath est requis`);
      assertSafeAbsolutePath(step.destPath, `${at} : destPath`);
      if (step.dockerLoad && base.type !== "cloud-image") {
        throw new TemplateValidationError(
          `${at} : dockerLoad n'est possible que sur une base cloud-image (aucun démon Docker pendant un docker build/mkosi build)`,
        );
      }
      return;
    }
    case "user": {
      if (typeof step.username !== "string" || !USERNAME_PATTERN.test(step.username)) {
        throw new TemplateValidationError(`${at} : username invalide (attendu ex "deploy")`);
      }
      if (step.sshAuthorizedKey !== undefined && !SSH_KEY_PATTERN.test(step.sshAuthorizedKey)) {
        throw new TemplateValidationError(`${at} : sshAuthorizedKey doit être une clé publique sur une seule ligne`);
      }
      if (isScratch) throw new TemplateValidationError(`${at} : impossible sur une image scratch (aucun shell)`);
      return;
    }
    case "service": {
      if (typeof step.name !== "string" || !SERVICE_NAME_PATTERN.test(step.name)) {
        throw new TemplateValidationError(`${at} : nom de service invalide`);
      }
      if (typeof step.enable !== "boolean") throw new TemplateValidationError(`${at} : enable doit être un booléen`);
      if (base.type === "container") {
        throw new TemplateValidationError(`${at} : pas de systemd dans un docker build — utilisez une étape script ou un ENTRYPOINT`);
      }
      return;
    }
    default:
      throw new TemplateValidationError(`étape ${index + 1} : type inconnu "${(step as { type?: string }).type ?? "?"}"`);
  }
}

export function validateCreateInput(input: CreateTemplateInput): void {
  if (!input.name.trim()) throw new TemplateValidationError("name is required");
  if (input.name.trim().length > 100) throw new TemplateValidationError("name is too long (max 100 characters)");
  if (!input.base || typeof input.base !== "object") throw new TemplateValidationError("base is required");
  validateBase(input.base);
  if (!Array.isArray(input.steps)) throw new TemplateValidationError("steps must be an array");
  if (input.steps.length > MAX_STEPS) throw new TemplateValidationError(`steps: ${MAX_STEPS} étapes maximum`);
  if (input.base.type === "iso" && input.steps.length > 0) {
    throw new TemplateValidationError("une base ISO n'exécute aucune étape (installation manuelle via la console VNC) — steps doit être vide");
  }
  input.steps.forEach((step, index) => validateStep(step, index, input.base));
}

/** Vérifie que chaque étape "artifact" référence un template dont l'artefact est réellement
 * transférable — refus honnête sinon (ex nutanix-image : l'image disque vit sur le cluster). */
async function validateArtifactSteps(steps: TemplateStep[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    if (step.type !== "artifact") continue;
    const at = `étape ${index + 1} (artifact)`;
    const source = await getStoredTemplate(step.templateId);
    if (!source) throw new TemplateValidationError(`${at} : template source "${step.templateId}" introuvable`);
    const artifact = source.lastBuild?.artifact;
    if (!artifact) {
      throw new TemplateValidationError(`${at} : le template "${source.name}" n'a pas encore d'artefact de build réussi`);
    }
    if (artifact.type === "nutanix-image") {
      throw new TemplateValidationError(
        `${at} : artefact "nutanix-image" non transférable (l'image disque vit sur le cluster Nutanix, pas dans QUAI)`,
      );
    }
    if (step.dockerLoad && artifact.type !== "docker-image") {
      throw new TemplateValidationError(`${at} : dockerLoad exige un artefact docker-image (reçu ${artifact.type})`);
    }
  }
}

const pad = (index: number): string => String(index + 1).padStart(2, "0");

const b64 = (content: string): string => Buffer.from(content, "utf-8").toString("base64");

function stepScriptRelPath(index: number, step: TemplateStep): string {
  return `scripts/${pad(index)}-${step.type}.sh`;
}

function packagesScriptBody(packages: string[]): string {
  const list = packages.join(" ");
  return `#!/bin/sh
set -e
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ${list}
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ${list}
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache ${list}
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm ${list}
else
  echo "Aucun gestionnaire de paquets supporté (apt/dnf/apk/pacman)" >&2
  exit 1
fi
`;
}

function userScriptBody(step: Extract<TemplateStep, { type: "user" }>): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    `if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh '${step.username}'; else adduser -D '${step.username}'; fi`,
  ];
  if (step.sudo) {
    lines.push(
      "mkdir -p /etc/sudoers.d",
      `printf '%s\\n' '${step.username} ALL=(ALL) NOPASSWD:ALL' > '/etc/sudoers.d/90-quai-${step.username}'`,
      `chmod 440 '/etc/sudoers.d/90-quai-${step.username}'`,
    );
  }
  if (step.sshAuthorizedKey) {
    lines.push(
      `home="$(getent passwd '${step.username}' | cut -d: -f6)"`,
      `mkdir -p "$home/.ssh"`,
      `echo '${b64(step.sshAuthorizedKey)}' | base64 -d > "$home/.ssh/authorized_keys"`,
      `chown -R '${step.username}' "$home/.ssh"`,
      `chmod 700 "$home/.ssh" && chmod 600 "$home/.ssh/authorized_keys"`,
    );
  }
  return lines.join("\n") + "\n";
}

function fileScriptBody(step: Extract<TemplateStep, { type: "file" }>): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    `mkdir -p '${path.posix.dirname(step.path)}'`,
    `echo '${b64(step.content)}' | base64 -d > '${step.path}'`,
  ];
  if (step.mode) lines.push(`chmod ${step.mode} '${step.path}'`);
  return lines.join("\n") + "\n";
}

function artifactScriptBody(step: Extract<TemplateStep, { type: "artifact" }>, index: number): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    `mkdir -p '${path.posix.dirname(step.destPath)}'`,
    `mv '/tmp/quai-artifact-${pad(index)}' '${step.destPath}'`,
  ];
  if (step.dockerLoad) lines.push(`docker load -i '${step.destPath}'`);
  return lines.join("\n") + "\n";
}

function serviceScriptBody(step: Extract<TemplateStep, { type: "service" }>): string {
  return `#!/bin/sh
set -e
systemctl ${step.enable ? "enable" : "disable"} '${step.name}'
`;
}

function freeScriptBody(content: string): string {
  const body = content.startsWith("#!") ? content : `#!/bin/sh\n${content}`;
  return body.endsWith("\n") ? body : body + "\n";
}

/** Script réellement exécuté dans la VM/l'image pour une étape — jamais par QUAI lui-même. */
function stepScriptContent(step: TemplateStep, index: number): string {
  switch (step.type) {
    case "packages":
      return packagesScriptBody(step.packages);
    case "script":
      return freeScriptBody(step.content);
    case "file":
      return fileScriptBody(step);
    case "artifact":
      return artifactScriptBody(step, index);
    case "user":
      return userScriptBody(step);
    case "service":
      return serviceScriptBody(step);
  }
}

/** Fichiers de build d'une base cloud-image : template Packer (plugin officiel Nutanix, build SUR
 * le cluster) + un script de provisioning par étape, ordonnés. */
export function generateCloudImageFiles(
  template: Pick<ImageTemplate, "id" | "name" | "base" | "steps">,
): Record<string, string> {
  const base = template.base;
  if (base.type !== "cloud-image") throw new TemplateValidationError("base cloud-image attendue");
  const imageName = imageNameForTemplate(template);
  const sourceImageUri = resolveCloudImageUrl(base);
  // Mot de passe de bootstrap du compte de build TEMPORAIRE "builder" (cloud-init, session SSH de
  // provisioning Packer uniquement) — aléatoire par template, aucun accès à l'existant.
  const builderPassword = randomBytes(12).toString("base64url");

  const files: Record<string, string> = {};
  const provisioners: string[] = [
    `  provisioner "shell" {
    inline = ["cloud-init status --wait || true"]
  }`,
  ];
  template.steps.forEach((step, index) => {
    const scriptPath = stepScriptRelPath(index, step);
    files[scriptPath] = stepScriptContent(step, index);
    if (step.type === "artifact") {
      provisioners.push(`  provisioner "file" {
    source      = "\${path.root}/artifacts/${pad(index)}-artifact"
    destination = "/tmp/quai-artifact-${pad(index)}"
  }`);
    }
    provisioners.push(`  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo -E {{ .Path }}"
    script          = "\${path.root}/${scriptPath}"
  }`);
  });

  files["template.pkr.hcl"] = `# Généré par QUAI (template "${template.name}") — image disque Nutanix depuis
# ${sourceImageUri}
# Identifiants Prism injectés à l'exécution via PKR_VAR_nutanix_* — ne JAMAIS les écrire ici.

packer {
  required_plugins {
    nutanix = {
      version = ">= 1.0.0"
      source  = "github.com/nutanix-cloud-native/nutanix"
    }
  }
}

variable "nutanix_username" {
  type      = string
  sensitive = true
}

variable "nutanix_password" {
  type      = string
  sensitive = true
}

variable "nutanix_endpoint" {
  type = string
}

variable "nutanix_port" {
  type    = number
  default = 9440
}

variable "nutanix_insecure" {
  type    = bool
  default = true
}

# Nom du cluster cible et du subnet : pas des secrets — à renseigner ici (ou via PKR_VAR_*)
# avant le premier build.
variable "nutanix_cluster" {
  type    = string
  default = ""
}

variable "nutanix_subnet" {
  type    = string
  default = ""
}

source "nutanix" "template" {
  nutanix_username = var.nutanix_username
  nutanix_password = var.nutanix_password
  nutanix_endpoint = var.nutanix_endpoint
  nutanix_port     = var.nutanix_port
  nutanix_insecure = var.nutanix_insecure
  cluster_name     = var.nutanix_cluster

  os_type   = "Linux"
  cpu       = 2
  memory_mb = 4096

  vm_disks {
    image_type       = "DISK_IMAGE"
    source_image_uri = "${sourceImageUri}"
    disk_size_gb     = 20
  }

  vm_nics {
    subnet_name = var.nutanix_subnet
  }

  user_data = base64encode(file("\${path.root}/cloud-init.yaml"))

  ssh_username = "builder"
  ssh_password = "${builderPassword}"

  shutdown_command = "sudo shutdown -P now"
  shutdown_timeout = "5m"

  image_name       = "${imageName}"
  force_deregister = true
}

build {
  sources = ["source.nutanix.template"]

${provisioners.join("\n\n")}

  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
    custom_data = {
      image_name = "${imageName}"
    }
  }
}
`;

  files["cloud-init.yaml"] = `#cloud-config
# Compte de build temporaire utilisé par Packer pour le provisioning SSH (voir template.pkr.hcl).
users:
  - name: builder
    groups: sudo
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    lock_passwd: false
    plain_text_passwd: "${builderPassword}"
ssh_pwauth: true
`;

  files["README.md"] = `# Template QUAI — ${template.name} (VM ${base.distro} ${base.version})

Build d'une image disque Nutanix via Packer (plugin officiel nutanix-cloud-native), depuis :
${sourceImageUri}
(si cette image n'existe pas/plus chez l'éditeur, le build échouera honnêtement au téléchargement).

Avant le premier build, renseignez \`nutanix_cluster\` et \`nutanix_subnet\` dans template.pkr.hcl.
Les identifiants Prism ne sont JAMAIS stockés ici (PKR_VAR_* injectées à l'exécution).
Chaque étape de la recette est un script \`scripts/NN-<type>.sh\`, exécuté DANS la VM de build
(en root via sudo), dans l'ordre. Les étapes "artifact" sont matérialisées dans \`artifacts/\`
au lancement du build (docker save/copie), puis téléversées dans la VM.

Étapes : ${template.steps.length > 0 ? template.steps.map((s) => s.type).join(", ") : "aucune"}.
`;

  return files;
}

/** Fichiers de build d'une base container : Dockerfile réel généré depuis les étapes. */
export function generateContainerFiles(
  template: Pick<ImageTemplate, "id" | "name" | "base" | "steps">,
): Record<string, string> {
  const base = template.base;
  if (base.type !== "container") throw new TemplateValidationError("base container attendue");
  const tag = dockerTagForTemplate(template);
  const pm = packageManagerForImage(base.image);

  const files: Record<string, string> = {};
  const lines: string[] = [
    `# Généré par QUAI (template "${template.name}") — recette conteneur, tag de build : ${tag}`,
    `FROM ${base.image}`,
  ];

  template.steps.forEach((step, index) => {
    const nn = pad(index);
    switch (step.type) {
      case "packages": {
        const list = step.packages.join(" ");
        if (pm === "apt") {
          lines.push(
            `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list} && rm -rf /var/lib/apt/lists/*`,
          );
        } else if (pm === "apk") {
          lines.push(`RUN apk add --no-cache ${list}`);
        } else if (pm === "dnf") {
          lines.push(`RUN dnf install -y ${list} && dnf clean all`);
        } else if (pm === "pacman") {
          lines.push(`RUN pacman -Sy --noconfirm ${list}`);
        }
        break;
      }
      case "script": {
        const scriptPath = stepScriptRelPath(index, step);
        files[scriptPath] = freeScriptBody(step.content);
        lines.push(`COPY ${scriptPath} /tmp/quai-step-${nn}.sh`, `RUN sh /tmp/quai-step-${nn}.sh && rm -f /tmp/quai-step-${nn}.sh`);
        break;
      }
      case "file": {
        // COPY + RUN chmod (pas de --chmod : BuildKit absent du démon piloté) — mode refusé sur
        // scratch à la validation (aucun shell pour chmod).
        files[`files/${nn}-file`] = step.content;
        lines.push(`COPY files/${nn}-file ${step.path}`);
        if (step.mode) lines.push(`RUN chmod ${step.mode} '${step.path}'`);
        break;
      }
      case "artifact": {
        // artifacts/NN-artifact matérialisé au lancement du build (docker save/copie côté QUAI).
        lines.push(`COPY artifacts/${nn}-artifact ${step.destPath}`);
        break;
      }
      case "user": {
        lines.push(
          `RUN if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh '${step.username}'; else adduser -D '${step.username}'; fi${step.sudo ? ` && mkdir -p /etc/sudoers.d && printf '%s\\n' '${step.username} ALL=(ALL) NOPASSWD:ALL' > '/etc/sudoers.d/90-quai-${step.username}' && chmod 440 '/etc/sudoers.d/90-quai-${step.username}'` : ""}`,
        );
        if (step.sshAuthorizedKey) {
          lines.push(
            `RUN home="$(getent passwd '${step.username}' | cut -d: -f6)" && mkdir -p "$home/.ssh" && echo '${b64(step.sshAuthorizedKey)}' | base64 -d > "$home/.ssh/authorized_keys" && chown -R '${step.username}' "$home/.ssh" && chmod 700 "$home/.ssh" && chmod 600 "$home/.ssh/authorized_keys"`,
          );
        }
        break;
      }
      case "service":
        break; // refusé à la validation — jamais atteint
    }
  });

  files["Dockerfile"] = lines.join("\n") + "\n";
  files["README.md"] = `# Template QUAI — ${template.name} (conteneur ${base.image})

Dockerfile généré depuis la recette (${template.steps.length} étape(s)). Tag produit : ${tag}
${base.image === "scratch" ? "\nImage scratch : aucun shell/libc — seules les étapes file/artifact (COPY) sont possibles.\n" : ""}Les étapes "artifact" sont matérialisées dans \`artifacts/\` au lancement du build (docker save/copie côté QUAI).
`;
  return files;
}

/** Fichiers de build d'une base mkosi : mkosi.conf + arbre mkosi.extra/ + mkosi.postinst.chroot
 * (exécuté DANS l'image en chroot par mkosi — suffixe .chroot requis par mkosi moderne). */
export function generateMkosiFiles(template: Pick<ImageTemplate, "id" | "name" | "base" | "steps">): Record<string, string> {
  const base = template.base;
  if (base.type !== "mkosi") throw new TemplateValidationError("base mkosi attendue");
  const imageId = imageNameForTemplate(template);

  const files: Record<string, string> = {};
  const packages: string[] = [];
  const postinst: string[] = [];

  template.steps.forEach((step, index) => {
    const nn = pad(index);
    switch (step.type) {
      case "packages":
        packages.push(...step.packages);
        break;
      case "script": {
        // Provisionné dans l'image via mkosi.extra puis exécuté par le postinst (chroot).
        const scriptPath = `mkosi.extra/usr/local/lib/quai-steps/${nn}-script.sh`;
        files[scriptPath] = freeScriptBody(step.content);
        postinst.push(`sh /usr/local/lib/quai-steps/${nn}-script.sh`);
        break;
      }
      case "file": {
        files[`mkosi.extra${step.path}`] = step.content;
        if (step.mode) postinst.push(`chmod ${step.mode} '${step.path}'`);
        break;
      }
      case "artifact":
        // Matérialisé au lancement du build dans mkosi.extra<destPath> (docker save/copie).
        break;
      case "user": {
        postinst.push(`if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh '${step.username}'; else adduser -D '${step.username}'; fi`);
        if (step.sudo) {
          postinst.push(
            "mkdir -p /etc/sudoers.d",
            `printf '%s\\n' '${step.username} ALL=(ALL) NOPASSWD:ALL' > '/etc/sudoers.d/90-quai-${step.username}'`,
            `chmod 440 '/etc/sudoers.d/90-quai-${step.username}'`,
          );
        }
        if (step.sshAuthorizedKey) {
          postinst.push(
            `home="$(getent passwd '${step.username}' | cut -d: -f6)"`,
            `mkdir -p "$home/.ssh"`,
            `echo '${b64(step.sshAuthorizedKey)}' | base64 -d > "$home/.ssh/authorized_keys"`,
            `chown -R '${step.username}' "$home/.ssh"`,
            `chmod 700 "$home/.ssh" && chmod 600 "$home/.ssh/authorized_keys"`,
          );
        }
        break;
      }
      case "service":
        postinst.push(`systemctl ${step.enable ? "enable" : "disable"} '${step.name}'`);
        break;
    }
  });

  files["mkosi.conf"] = `# Généré par QUAI (template "${template.name}") — OS minimal from-scratch (rootfs + noyau).
[Distribution]
Distribution=${base.distro}
Release=${base.release}

[Output]
Format=disk
ImageId=${imageId}
OutputDirectory=mkosi.output

[Content]
Bootable=yes
${packages.length > 0 ? `Packages=${packages.join(",")}\n` : ""}`;

  if (postinst.length > 0) {
    files["mkosi.postinst.chroot"] = ["#!/bin/sh", "set -e", ...postinst].join("\n") + "\n";
  }

  files["README.md"] = `# Template QUAI — ${template.name} (mkosi ${base.distro} ${base.release})

OS minimal construit from-scratch par mkosi (rootfs + noyau, Format=disk, Bootable=yes).
Artefact produit : ${mkosiOutputPathForTemplate(template)} (type raw-image).
- mkosi.conf : distribution/release/paquets ;
- mkosi.extra/ : fichiers copiés tels quels dans l'image (étapes file/script/artifact) ;
- mkosi.postinst.chroot : exécuté en chroot DANS l'image (étapes script/user/service).
`;
  return files;
}

/** Fichiers d'une base iso : un README seul — rien à construire, la VM vierge démarre sur l'ISO
 * (POST /api/nutanix/vms, variant isoImageUuid) et s'installe via la console VNC. */
export function generateIsoFiles(template: Pick<ImageTemplate, "id" | "name" | "base" | "steps">): Record<string, string> {
  const base = template.base;
  if (base.type !== "iso") throw new TemplateValidationError("base iso attendue");
  return {
    "README.md": `# Template QUAI — ${template.name} (ISO)

Base ISO du catalogue d'images Prism (uuid ${base.imageUuid}) : rien à construire côté QUAI
(le template est "ready" dès sa création, POST /:id/build est refusé).

Flux de déploiement :
1. déployer une VM depuis ce template (POST /api/nutanix/vms avec isoImageUuid + diskSizeMib) :
   disque SCSI vide + lecteur CDROM branché sur l'ISO, démarrage CDROM puis DISK ;
2. ouvrir la console VNC de la VM et dérouler l'installateur de l'OS manuellement ;
3. une fois l'OS installé sur le disque, retirer/ignorer le CDROM — la VM démarre sur le disque.
`,
  };
}

export function generateTemplateFiles(template: Pick<ImageTemplate, "id" | "name" | "base" | "steps">): Record<string, string> {
  switch (template.base.type) {
    case "cloud-image":
      return generateCloudImageFiles(template);
    case "container":
      return generateContainerFiles(template);
    case "mkosi":
      return generateMkosiFiles(template);
    case "iso":
      return generateIsoFiles(template);
  }
}

/** Recettes pré-remplies (GET /api/templates/presets) — réduites à 2 : le générateur cloud-image
 * reste disponible pour une recette vierge, mais n'est plus proposé en preset. */
export const TEMPLATE_PRESETS: readonly TemplatePreset[] = [
  {
    id: "scratch",
    label: "Conteneur scratch",
    description: "Image conteneur vide (FROM scratch) : copiez un binaire statique via une étape file/artifact.",
    base: { type: "container", image: "scratch" },
    steps: [],
  },
  {
    id: "mkosi-minimal",
    label: "OS minimal (mkosi)",
    description: "OS from-scratch (rootfs + noyau) Debian bookworm via mkosi — nécessite le binaire mkosi dans le conteneur API.",
    base: { type: "mkosi", distro: "debian", release: "bookworm" },
    steps: [],
  },
];

export async function isMkosiAvailable(): Promise<boolean> {
  return (await getEngineStatus("mkosi")).available;
}

/** Templates dont l'artefact du dernier build est exploitable comme étape "artifact" d'une autre
 * recette (docker-image/raw-image — jamais nutanix-image, non transférable). */
export async function listArtifactSources(): Promise<TemplateArtifactSource[]> {
  const templates = await listTemplates();
  return templates.flatMap((t) => {
    const artifact = t.lastBuild?.artifact;
    if (!artifact || artifact.type === "nutanix-image") return [];
    return [{ templateId: t.id, name: t.name, artifactType: artifact.type, reference: artifact.reference }];
  });
}

/** Réconciliation paresseuse d'un template "building" avec le run réel — lue à chaque GET
 * (robuste à un redémarrage du process pendant un build ; run introuvable = erreur honnête). */
async function reconcileTemplate(template: ImageTemplate): Promise<ImageTemplate> {
  if (template.status !== "building" || !template.lastBuild) return template;
  const run = await getRun(template.workspaceId, template.lastBuild.runId);
  const now = new Date().toISOString();
  if (!run) {
    return updateStoredTemplate(template.id, {
      status: "error",
      updatedAt: now,
      lastBuild: { ...template.lastBuild, status: "failed" },
    });
  }
  if (run.status === "running") return template;
  const lastBuild: ImageTemplateLastBuild = {
    runId: run.id,
    status: run.status,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.artifact ? { artifact: run.artifact } : {}),
  };
  return updateStoredTemplate(template.id, {
    status: run.status === "success" ? "ready" : "error",
    updatedAt: now,
    lastBuild,
  });
}

export async function listTemplates(): Promise<ImageTemplate[]> {
  const templates = await listStoredTemplates();
  return Promise.all(templates.map(reconcileTemplate));
}

export async function getTemplate(id: string): Promise<ImageTemplate | undefined> {
  const template = await getStoredTemplate(id);
  return template ? reconcileTemplate(template) : undefined;
}

function engineForBase(base: TemplateBase): IacEngine {
  // "packer" pour iso : jamais exécuté (une base ISO ne se construit pas), simple rattachement à la
  // famille Nutanix pour l'affichage du workspace.
  return base.type === "container" ? "docker" : base.type === "mkosi" ? "mkosi" : "packer";
}

/** Remplace TOUT le contenu du dossier files/ du workspace par les fichiers générés — utilisé à la
 * création (écrase le scaffold) et par updateTemplate (aucun fichier de l'ancienne recette ne doit
 * survivre : un mkosi.postinst.chroot orphelin s'exécuterait encore au prochain build). */
async function replaceWorkspaceFiles(workspaceId: string, files: Record<string, string>): Promise<void> {
  const dir = workspaceFilesPath(workspaceId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(workspaceId, relativePath, content);
  }
}

export async function createTemplate(input: CreateTemplateInput, createdBy: string): Promise<ImageTemplate> {
  const normalized: CreateTemplateInput = { name: input.name.trim(), base: input.base, steps: input.steps };
  validateCreateInput(normalized);
  await validateArtifactSteps(normalized.steps);
  if (normalized.base.type === "mkosi" && !(await isMkosiAvailable())) {
    throw new MkosiUnavailableError("mkosi non disponible — reconstruire le conteneur API");
  }

  const id = randomUUID();
  const workspace = await createWorkspace({
    name: `template-${sanitizeTemplateSlug(normalized.name)}`,
    engine: engineForBase(normalized.base),
    createdBy,
  });

  const now = new Date().toISOString();
  const template: ImageTemplate = {
    id,
    name: normalized.name,
    base: normalized.base,
    steps: normalized.steps,
    // iso : rien à construire — "ready" dès la création (POST /:id/build refusé).
    status: normalized.base.type === "iso" ? "ready" : "draft",
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
  };

  await replaceWorkspaceFiles(workspace.id, generateTemplateFiles(template));

  await insertTemplate(template);
  return template;
}

export interface UpdateTemplateInput {
  name?: string;
  base?: TemplateBase;
  steps?: TemplateStep[];
}

/**
 * PUT /api/templates/:id — met à jour la recette ET régénère les fichiers du workspace (mêmes
 * générateurs que la création). Refuse (TemplateBuildInProgressError -> 409) si un build est en
 * cours. Si le MOTEUR change (base d'un autre type), le workspace est recréé (l'index workspaces
 * porte l'engine, non modifiable) et lastBuild est abandonné — l'artefact de l'ancienne base n'a
 * plus de sens pour la nouvelle recette.
 */
export async function updateTemplate(id: string, patch: UpdateTemplateInput, updatedBy: string): Promise<ImageTemplate> {
  // getTemplate réconcilie un "building" périmé avec le run réel avant le garde-fou 409.
  const existing = await getTemplate(id);
  if (!existing) throw new TemplateNotFoundError(`Template "${id}" not found`);
  if (existing.status === "building") {
    throw new TemplateBuildInProgressError(`Template "${existing.name}" a un build en cours — attendez sa fin avant de le modifier`);
  }

  const normalized: CreateTemplateInput = {
    name: (patch.name ?? existing.name).trim(),
    base: patch.base ?? existing.base,
    steps: patch.steps ?? existing.steps,
  };
  validateCreateInput(normalized);
  await validateArtifactSteps(normalized.steps);
  if (normalized.base.type === "mkosi" && !(await isMkosiAvailable())) {
    throw new MkosiUnavailableError("mkosi non disponible — reconstruire le conteneur API");
  }

  const engineChanged = engineForBase(normalized.base) !== engineForBase(existing.base);
  let workspaceId = existing.workspaceId;
  if (engineChanged) {
    const workspace = await createWorkspace({
      name: `template-${sanitizeTemplateSlug(normalized.name)}`,
      engine: engineForBase(normalized.base),
      createdBy: updatedBy,
    });
    workspaceId = workspace.id;
    await deleteWorkspace(existing.workspaceId).catch((err) => {
      if (!(err instanceof WorkspaceNotFoundError)) throw err;
    });
  }

  const now = new Date().toISOString();
  const keepLastBuild = !engineChanged && existing.lastBuild ? existing.lastBuild : undefined;
  const updated: ImageTemplate = {
    id: existing.id,
    name: normalized.name,
    base: normalized.base,
    steps: normalized.steps,
    status: normalized.base.type === "iso" ? "ready" : keepLastBuild ? existing.status : "draft",
    workspaceId,
    createdAt: existing.createdAt,
    updatedAt: now,
    ...(keepLastBuild ? { lastBuild: keepLastBuild } : {}),
  };

  await replaceWorkspaceFiles(workspaceId, generateTemplateFiles(updated));

  // remove+insert plutôt qu'un patch : permet d'EFFACER lastBuild quand le moteur change.
  await removeStoredTemplate(id);
  await insertTemplate(updated);
  return updated;
}

export async function deleteTemplate(id: string): Promise<void> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);
  await deleteWorkspace(template.workspaceId).catch((err) => {
    if (!(err instanceof WorkspaceNotFoundError)) throw err;
  });
  await removeStoredTemplate(id);
}

function runDockerSave(reference: string, targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["save", "-o", targetPath, reference]);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(new Error(`docker save a échoué : ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new TemplateValidationError(`docker save "${reference}" a échoué (code ${code}) : ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/** Matérialise les étapes "artifact" AVANT le run : docker save côté QUAI (ou copie d'une image
 * raw-image depuis le workspace source) vers ce workspace — jamais un fichier inventé. */
async function materializeArtifactSteps(template: ImageTemplate): Promise<void> {
  const workspaceDir = workspaceFilesPath(template.workspaceId);
  for (const [index, step] of template.steps.entries()) {
    if (step.type !== "artifact") continue;
    const at = `étape ${index + 1} (artifact)`;
    const source = await getStoredTemplate(step.templateId);
    const artifact = source?.lastBuild?.artifact;
    if (!source || !artifact) {
      throw new TemplateValidationError(`${at} : le template source n'existe plus ou n'a plus d'artefact de build`);
    }
    const target =
      template.base.type === "mkosi"
        ? path.join(workspaceDir, "mkosi.extra", ...step.destPath.slice(1).split("/"))
        : path.join(workspaceDir, "artifacts", `${pad(index)}-artifact`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (artifact.type === "docker-image") {
      if (!DOCKER_REFERENCE_PATTERN.test(artifact.reference)) {
        throw new TemplateValidationError(`${at} : référence d'image docker invalide`);
      }
      await runDockerSave(artifact.reference, target);
    } else if (artifact.type === "raw-image") {
      const sourceDir = workspaceFilesPath(source.workspaceId);
      const from = path.resolve(sourceDir, artifact.reference);
      if (from !== sourceDir && !from.startsWith(sourceDir + path.sep)) {
        throw new TemplateValidationError(`${at} : référence d'artefact hors du workspace source`);
      }
      await fs.copyFile(from, target).catch(() => {
        throw new TemplateValidationError(`${at} : image "${artifact.reference}" introuvable dans le workspace source (re-buildez le template source)`);
      });
    } else {
      throw new TemplateValidationError(`${at} : artefact "${artifact.type}" non transférable`);
    }
  }
}

export async function buildTemplate(id: string, startedBy: string): Promise<ImageTemplate> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);

  let run: IacRun;
  switch (template.base.type) {
    case "iso":
      throw new TemplateValidationError("une base ISO ne se construit pas — la VM s'installe depuis l'ISO via la console VNC");
    case "cloud-image": {
      // Identifiants Prism lus AU MOMENT du spawn, jamais persistés ni loggés (StartRunOptions#extraEnv).
      const nutanix = await getEffectiveNutanixConfig();
      if (!nutanix) {
        throw new NutanixNotConfiguredError(
          "Nutanix n'est pas configuré : impossible de lancer un build cloud-image (voir /api/nutanix/config)",
        );
      }
      await materializeArtifactSteps(template);
      const { endpoint, port } = parsePrismEndpoint(nutanix.prismCentralUrl);
      run = await startRun(template.workspaceId, "packer", "build", startedBy, {
        extraEnv: {
          PKR_VAR_nutanix_username: nutanix.username,
          PKR_VAR_nutanix_password: nutanix.password,
          PKR_VAR_nutanix_endpoint: endpoint,
          ...(port !== undefined ? { PKR_VAR_nutanix_port: String(port) } : {}),
        },
        packerInitFirst: true,
        captureArtifact: "packer-manifest",
      });
      break;
    }
    case "container": {
      await materializeArtifactSteps(template);
      run = await startRun(template.workspaceId, "docker", "build", startedBy, {
        dockerTag: dockerTagForTemplate(template),
        captureArtifact: "docker-image",
      });
      break;
    }
    case "mkosi": {
      if (!(await isMkosiAvailable())) {
        throw new MkosiUnavailableError("mkosi non disponible — reconstruire le conteneur API");
      }
      await materializeArtifactSteps(template);
      run = await startRun(template.workspaceId, "mkosi", "build", startedBy, {
        captureArtifact: "mkosi-image",
        mkosiOutputPath: mkosiOutputPathForTemplate(template),
      });
      break;
    }
  }

  return updateStoredTemplate(id, {
    status: "building",
    updatedAt: new Date().toISOString(),
    lastBuild: { runId: run.id, status: "running" },
  });
}

/** Historique des runs du workspace du template (GET /api/templates/:id/builds). */
export async function listTemplateBuilds(id: string): Promise<IacRun[]> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);
  return listRuns(template.workspaceId);
}

const VALIDATE_TIMEOUT_MS = 60_000;

// `packer validate` avec des variables factices : la syntaxe/cohérence HCL est vérifiée sans
// toucher ni au cluster ni aux vrais identifiants (jamais lus ici).
function runValidateCommand(bin: string, args: string[], cwd: string, extraEnv: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), VALIDATE_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      if (output.length < 128 * 1024) output += chunk.toString("utf-8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

/** Vérification RÉELLE de la recette (POST /api/templates/:id/validate) : `sh -n` sur chaque
 * script du workspace + `packer init`/`packer validate` (variables factices) pour une base
 * cloud-image. Ne construit rien, ne contacte jamais Prism. */
export async function validateTemplate(id: string): Promise<{ ok: boolean; output: string }> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);
  if (template.base.type === "iso") {
    return { ok: true, output: "Base ISO : aucune étape à vérifier — installation manuelle via la console VNC." };
  }

  const filesDir = workspaceFilesPath(template.workspaceId);
  const sections: string[] = [];
  let ok = true;

  const scriptFiles = await fs.readdir(path.join(filesDir, "scripts")).catch(() => [] as string[]);
  for (const name of scriptFiles.filter((f) => f.endsWith(".sh")).sort()) {
    const content = await fs.readFile(path.join(filesDir, "scripts", name), "utf-8");
    const result = await lintShellScript(content);
    if (!result.ok) {
      ok = false;
      sections.push(`scripts/${name} :\n${result.errors.map((e) => `  ${e.line !== undefined ? `ligne ${e.line} : ` : ""}${e.message}`).join("\n")}`);
    }
  }
  if (scriptFiles.some((f) => f.endsWith(".sh")) && ok) sections.push("Scripts shell : syntaxe OK (sh -n).");

  if (template.base.type === "cloud-image") {
    const fakeVars = {
      PKR_VAR_nutanix_username: "validate-only",
      PKR_VAR_nutanix_password: "validate-only",
      PKR_VAR_nutanix_endpoint: "validate.invalid",
    };
    const init = await runValidateCommand("packer", ["init", "-color=false", "."], filesDir, fakeVars);
    if (!init.ok) {
      ok = false;
      sections.push(`packer init :\n${init.output}`);
    } else {
      const validate = await runValidateCommand("packer", ["validate", "-color=false", "."], filesDir, fakeVars);
      if (!validate.ok) ok = false;
      sections.push(`packer validate :\n${validate.output || "OK"}`);
    }
  } else if (template.base.type === "mkosi") {
    sections.push("mkosi n'a pas de validateur dédié — seuls les scripts shell sont vérifiés.");
  }

  return { ok, output: sections.join("\n\n") || "Rien à vérifier pour cette recette." };
}
