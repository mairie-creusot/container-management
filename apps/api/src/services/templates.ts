/**
 * Catalogue de templates d'images — étage "builder" du pipeline (voir ARCHITECTURE.md) :
 *  - "vm-ubuntu" : template Packer réel utilisant le plugin officiel Nutanix
 *    (github.com/nutanix-cloud-native/packer-plugin-nutanix) — le build tourne SUR le cluster,
 *    depuis l'image cloud Ubuntu officielle (cloud-images.ubuntu.com, URL indexée par numéro de
 *    version : jamais un nom de code deviné pour une version non publiée).
 *  - "container-scratch"/"container-alpine" : Dockerfile réel, construit via `docker build`
 *    (services/iac/runner.ts, moteur "docker").
 *
 * Chaque template possède son propre workspace IaC réel (services/iac/workspaces.ts) contenant
 * les fichiers de build générés — éditables ensuite comme tout workspace. SECRETS : les
 * identifiants Prism ne sont JAMAIS écrits dans les fichiers générés ni sur disque — variables
 * HCL sensibles injectées à l'exécution via PKR_VAR_* (StartRunOptions#extraEnv), lues de
 * getEffectiveNutanixConfig() au moment du spawn uniquement.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { getEffectiveNutanixConfig } from "./setupStore.js";
import { createWorkspace, deleteWorkspace, writeFile, WorkspaceNotFoundError } from "./iac/workspaces.js";
import { getRun, listRuns, startRun } from "./iac/runner.js";
import {
  getStoredTemplate,
  insertTemplate,
  listStoredTemplates,
  removeStoredTemplate,
  TemplateNotFoundError,
  updateStoredTemplate,
} from "./templatesStore.js";
import type { IacRun, ImageTemplate, ImageTemplateKind, ImageTemplateLastBuild } from "../types.js";

export { TemplateNotFoundError } from "./templatesStore.js";

export class TemplateValidationError extends Error {}

export class NutanixNotConfiguredError extends Error {}

export const TEMPLATE_KINDS: readonly ImageTemplateKind[] = ["vm-ubuntu", "container-scratch", "container-alpine"];

/**
 * Catalogue FERMÉ des composants installables par kind — les identifiants de composants sont
 * mappés vers de vrais noms de paquets (apt pour Ubuntu, apk pour Alpine) ici, jamais interpolés
 * tels quels dans une commande shell (un composant inconnu est rejeté à la création, voir
 * validateCreateInput : défense contre toute injection via ce champ).
 */
const UBUNTU_APT_PACKAGES: Record<string, string[]> = {
  docker: ["docker.io"],
  // docker-compose v2 (plugin CLI) — paquet "docker-compose-v2" de l'archive Ubuntu (>= 24.04).
  "docker-compose": ["docker-compose-v2"],
  git: ["git"],
  curl: ["curl"],
  htop: ["htop"],
  python3: ["python3"],
  "build-essential": ["build-essential"],
  "qemu-guest-agent": ["qemu-guest-agent"],
};

const ALPINE_APK_PACKAGES: Record<string, string[]> = {
  "docker-cli": ["docker-cli"],
  "docker-compose": ["docker-cli-compose"],
  git: ["git"],
  curl: ["curl"],
  bash: ["bash"],
  python3: ["python3"],
  nodejs: ["nodejs"],
  openssl: ["openssl"],
};

/** Composants proposables par kind (exposé pour le frontend/les tests) — scratch : aucun (pas de
 * gestionnaire de paquets dans une image vide, limite honnête plutôt qu'un composant ignoré). */
export const COMPONENT_CATALOG: Record<ImageTemplateKind, readonly string[]> = {
  "vm-ubuntu": Object.keys(UBUNTU_APT_PACKAGES),
  "container-scratch": [],
  "container-alpine": Object.keys(ALPINE_APK_PACKAGES),
};

const UBUNTU_VERSION_PATTERN = /^\d{2}\.\d{2}$/;
const ALPINE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CreateTemplateInput {
  name: string;
  kind: ImageTemplateKind;
  baseVersion: string;
  components: string[];
}

export function validateCreateInput(input: CreateTemplateInput): void {
  if (!input.name.trim()) throw new TemplateValidationError("name is required");
  if (input.name.trim().length > 100) throw new TemplateValidationError("name is too long (max 100 characters)");
  if (!TEMPLATE_KINDS.includes(input.kind)) {
    throw new TemplateValidationError(`kind must be one of: ${TEMPLATE_KINDS.join(", ")}`);
  }
  switch (input.kind) {
    case "vm-ubuntu":
      if (!UBUNTU_VERSION_PATTERN.test(input.baseVersion)) {
        throw new TemplateValidationError(`baseVersion must be an Ubuntu version like "24.04" for kind "vm-ubuntu"`);
      }
      break;
    case "container-alpine":
      if (!ALPINE_TAG_PATTERN.test(input.baseVersion)) {
        throw new TemplateValidationError(`baseVersion must be a valid alpine tag (ex "3.20") for kind "container-alpine"`);
      }
      break;
    case "container-scratch":
      if (input.baseVersion !== "") {
        throw new TemplateValidationError(`baseVersion must be "" for kind "container-scratch"`);
      }
      break;
  }
  const allowed = COMPONENT_CATALOG[input.kind];
  for (const component of input.components) {
    if (!allowed.includes(component)) {
      throw new TemplateValidationError(
        `Unknown component "${component}" for kind "${input.kind}"${allowed.length > 0 ? ` (allowed: ${allowed.join(", ")})` : " (no components supported)"}`,
      );
    }
  }
}

/** "Mon Template 1!" -> "mon-template-1" — pour les tags docker/noms d'image Nutanix. */
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

/** Nom de l'image disque Nutanix produite par un build vm-ubuntu réussi. */
export function nutanixImageNameForTemplate(template: Pick<ImageTemplate, "id" | "name">): string {
  return `quai-template-${sanitizeTemplateSlug(template.name)}-${template.id.slice(0, 8)}`;
}

/** "https://prism.lecreusot.fr:9440" -> { endpoint: "prism.lecreusot.fr", port: 9440 } — le
 * plugin Nutanix attend un FQDN/IP + un port séparés, pas une URL complète. */
export function parsePrismEndpoint(prismCentralUrl: string): { endpoint: string; port?: number } {
  try {
    const url = new URL(prismCentralUrl.includes("://") ? prismCentralUrl : `https://${prismCentralUrl}`);
    return { endpoint: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) };
  } catch {
    return { endpoint: prismCentralUrl };
  }
}

/**
 * Fichiers de build d'un template "vm-ubuntu" — template Packer réel, syntaxe vérifiée contre la
 * doc officielle du plugin (developer.hashicorp.com/packer/integrations/nutanix-cloud-native/
 * nutanix, builder "nutanix" : nutanix_endpoint/nutanix_port/cluster_name/vm_disks{image_type=
 * "DISK_IMAGE", source_image_uri}/vm_nics{subnet_name}/user_data/shutdown_command/image_name) et
 * l'exemple Ubuntu du dépôt du plugin (example/source.nutanix.pkr.hcl).
 *
 * baseVersion est acceptée telle quelle (URL cloud-images indexée par numéro de version) : si la
 * version n'est pas encore publiée par Canonical (ex "26.04" avant sa sortie), le build échouera
 * honnêtement au téléchargement de l'image source — jamais un nom de code inventé.
 */
export function generateVmUbuntuFiles(template: Pick<ImageTemplate, "id" | "name" | "baseVersion" | "components">): Record<string, string> {
  const imageName = nutanixImageNameForTemplate(template);
  const sourceImageUri = `https://cloud-images.ubuntu.com/releases/${template.baseVersion}/release/ubuntu-${template.baseVersion}-server-cloudimg-amd64.img`;
  // Mot de passe de bootstrap du compte de build TEMPORAIRE "builder" (créé par cloud-init dans
  // la VM de build, comme l'exemple officiel du plugin) — généré aléatoirement par template,
  // uniquement pour que Packer puisse ouvrir sa session SSH de provisioning. PAS un identifiant
  // d'infrastructure : ne donne accès à rien d'existant. Les identifiants Prism, eux, ne sont
  // jamais écrits ici (variables sensibles injectées via PKR_VAR_* à l'exécution).
  const builderPassword = randomBytes(12).toString("base64url");

  const aptPackages = template.components.flatMap((c) => UBUNTU_APT_PACKAGES[c] ?? []);
  const provisionerLines: string[] = ['      "cloud-init status --wait || true",'];
  if (aptPackages.length > 0) {
    provisionerLines.push(
      '      "sudo DEBIAN_FRONTEND=noninteractive apt-get update",',
      `      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${aptPackages.join(" ")}",`,
    );
  }
  if (template.components.includes("docker")) {
    provisionerLines.push('      "sudo systemctl enable docker",');
  }
  const inline = provisionerLines.join("\n").replace(/,$/, "");

  const pkr = `# Généré par QUAI (template "${template.name}") — build d'une image disque Nutanix depuis
# l'image cloud Ubuntu ${template.baseVersion} officielle. Le build tourne SUR le cluster (VM
# temporaire créée puis supprimée par Packer). Les identifiants Prism sont injectés à
# l'exécution via les variables d'environnement PKR_VAR_nutanix_* — ne JAMAIS les écrire ici.

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

  provisioner "shell" {
    inline = [
${inline}
    ]
  }

  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
    custom_data = {
      image_name = "${imageName}"
    }
  }
}
`;

  const cloudInit = `#cloud-config
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

  const readme = `# Template QUAI — ${template.name} (VM Ubuntu ${template.baseVersion})

Build d'une image disque Nutanix via Packer (plugin officiel nutanix-cloud-native), depuis
l'image cloud Ubuntu officielle :
${sourceImageUri}
(si cette version n'est pas encore publiée par Canonical, le build échouera au téléchargement).

Avant le premier build, renseignez \`nutanix_cluster\` et \`nutanix_subnet\` dans
template.pkr.hcl (noms réels du cluster et du subnet cibles — pas des secrets).

Les identifiants Prism Central ne sont JAMAIS stockés dans ce workspace : ils sont injectés à
l'exécution (variables d'environnement PKR_VAR_nutanix_username/password/endpoint) depuis la
configuration Nutanix de QUAI. Le compte "builder" de cloud-init.yaml est un compte de build
temporaire créé dans la VM de build uniquement (il subsiste dans l'image produite : supprimez-le
ou remplacez-le via vos propres étapes de provisioning si nécessaire).

Composants installés : ${template.components.length > 0 ? template.components.join(", ") : "aucun"}.
`;

  return { "template.pkr.hcl": pkr, "cloud-init.yaml": cloudInit, "README.md": readme };
}

/** Fichiers de build d'un template conteneur (scratch ou alpine) — Dockerfile réel + README. */
export function generateContainerFiles(
  template: Pick<ImageTemplate, "id" | "name" | "kind" | "baseVersion" | "components">,
): Record<string, string> {
  const tag = dockerTagForTemplate(template);

  if (template.kind === "container-scratch") {
    const dockerfile = `# Généré par QUAI (template "${template.name}") — image minimale FROM scratch.
# Copiez ici votre binaire STATIQUE (aucune libc/shell dans l'image) puis relancez le build :
#   COPY mon-binaire /mon-binaire
#   ENTRYPOINT ["/mon-binaire"]
FROM scratch
`;
    const readme = `# Template QUAI — ${template.name} (conteneur scratch)

Image vide (FROM scratch) : aucun shell, aucune libc, aucun gestionnaire de paquets.
Usage : copiez un binaire compilé STATIQUEMENT (ex Go avec CGO_ENABLED=0, Rust musl) dans ce
workspace, ajoutez au Dockerfile :

    COPY mon-binaire /mon-binaire
    ENTRYPOINT ["/mon-binaire"]

puis lancez le build — tag produit : ${tag}
`;
    return { Dockerfile: dockerfile, "README.md": readme };
  }

  const apkPackages = template.components.flatMap((c) => ALPINE_APK_PACKAGES[c] ?? []);
  const dockerfile = `# Généré par QUAI (template "${template.name}") — base Alpine ${template.baseVersion}.
FROM alpine:${template.baseVersion}
${apkPackages.length > 0 ? `RUN apk add --no-cache ${apkPackages.join(" ")}\n` : ""}CMD ["sh"]
`;
  const readme = `# Template QUAI — ${template.name} (conteneur Alpine ${template.baseVersion})

Composants installés : ${template.components.length > 0 ? template.components.join(", ") : "aucun"}.
Tag produit par le build : ${tag}
`;
  return { Dockerfile: dockerfile, "README.md": readme };
}

export function generateTemplateFiles(
  template: Pick<ImageTemplate, "id" | "name" | "kind" | "baseVersion" | "components">,
): Record<string, string> {
  return template.kind === "vm-ubuntu" ? generateVmUbuntuFiles(template) : generateContainerFiles(template);
}

/**
 * Réconciliation paresseuse d'un template "building" avec le run réel du runner (lue à chaque
 * GET liste/détail plutôt qu'un callback : robuste aussi à un redémarrage du process pendant un
 * build). Un run introuvable (index de runs supprimé) est un état d'erreur honnête, jamais un
 * "building" éternel.
 */
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

export async function createTemplate(input: CreateTemplateInput, createdBy: string): Promise<ImageTemplate> {
  const normalized: CreateTemplateInput = {
    name: input.name.trim(),
    kind: input.kind,
    baseVersion: input.baseVersion,
    components: input.components,
  };
  validateCreateInput(normalized);

  const id = randomUUID();
  const workspace = await createWorkspace({
    name: `template-${sanitizeTemplateSlug(normalized.name)}`,
    engine: normalized.kind === "vm-ubuntu" ? "packer" : "docker",
    createdBy,
  });

  const now = new Date().toISOString();
  const template: ImageTemplate = {
    id,
    name: normalized.name,
    kind: normalized.kind,
    baseVersion: normalized.baseVersion,
    components: normalized.components,
    status: "draft",
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
  };

  // Écrase le scaffold de démonstration du workspace (mêmes noms de fichiers) par les vrais
  // fichiers de build générés — le workspace est immédiatement prêt à builder.
  const files = generateTemplateFiles(template);
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(workspace.id, relativePath, content);
  }

  await insertTemplate(template);
  return template;
}

export async function deleteTemplate(id: string): Promise<void> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);
  // Workspace déjà supprimé à la main via /api/iac : pas bloquant pour retirer le template.
  await deleteWorkspace(template.workspaceId).catch((err) => {
    if (!(err instanceof WorkspaceNotFoundError)) throw err;
  });
  await removeStoredTemplate(id);
}

export async function buildTemplate(id: string, startedBy: string): Promise<ImageTemplate> {
  const template = await getStoredTemplate(id);
  if (!template) throw new TemplateNotFoundError(`Template "${id}" not found`);

  let run: IacRun;
  if (template.kind === "vm-ubuntu") {
    // Identifiants Prism lus AU MOMENT du spawn, jamais persistés ni loggés (voir
    // StartRunOptions#extraEnv, services/iac/runner.ts).
    const nutanix = await getEffectiveNutanixConfig();
    if (!nutanix) {
      throw new NutanixNotConfiguredError(
        "Nutanix n'est pas configuré : impossible de lancer un build vm-ubuntu (voir /api/nutanix/config)",
      );
    }
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
  } else {
    run = await startRun(template.workspaceId, "docker", "build", startedBy, {
      dockerTag: dockerTagForTemplate(template),
      captureArtifact: "docker-image",
    });
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
