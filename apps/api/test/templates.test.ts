import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé (même pattern que iacWorkspaces.test.ts) : templatesStore.ts et
// services/iac/* dérivent leurs dossiers de données du répertoire de CONFIG_PATH.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const templates = await import("../src/services/templates.js");
const { parsePackerManifestArtifact } = await import("../src/services/iac/runner.js");
const { workspaceFilesPath } = await import("../src/services/iac/workspaces.js");

const dataDir = path.dirname(path.resolve(tmpConfigPath));
const iacDataDir = path.join(dataDir, "iac");
const templatesIndexPath = path.join(dataDir, "templates.json");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(iacDataDir, { recursive: true, force: true });
  await fs.rm(templatesIndexPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

describe("validateCreateInput — catalogue fermé, jamais d'interpolation arbitraire", () => {
  it("accepte un vm-ubuntu 24.04 avec composants connus", () => {
    expect(() =>
      templates.validateCreateInput({ name: "base", kind: "vm-ubuntu", baseVersion: "24.04", components: ["docker", "docker-compose"] }),
    ).not.toThrow();
  });

  it("rejette un composant inconnu (défense contre l'injection shell via components)", () => {
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "vm-ubuntu", baseVersion: "24.04", components: ["docker; rm -rf /"] }),
    ).toThrow(templates.TemplateValidationError);
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "container-alpine", baseVersion: "3.20", components: ["$(evil)"] }),
    ).toThrow(templates.TemplateValidationError);
  });

  it("rejette un kind inconnu, un nom vide, une baseVersion invalide", () => {
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "vm-windows" as never, baseVersion: "", components: [] }),
    ).toThrow(templates.TemplateValidationError);
    expect(() => templates.validateCreateInput({ name: "  ", kind: "vm-ubuntu", baseVersion: "24.04", components: [] })).toThrow();
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "vm-ubuntu", baseVersion: "noble", components: [] }),
    ).toThrow(templates.TemplateValidationError);
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "container-alpine", baseVersion: "3.20; echo pwned", components: [] }),
    ).toThrow(templates.TemplateValidationError);
  });

  it("container-scratch : baseVersion doit être \"\" et aucun composant n'est supporté", () => {
    expect(() => templates.validateCreateInput({ name: "x", kind: "container-scratch", baseVersion: "", components: [] })).not.toThrow();
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "container-scratch", baseVersion: "1.0", components: [] }),
    ).toThrow(templates.TemplateValidationError);
    expect(() =>
      templates.validateCreateInput({ name: "x", kind: "container-scratch", baseVersion: "", components: ["docker"] }),
    ).toThrow(templates.TemplateValidationError);
  });
});

describe("generateVmUbuntuFiles — template Packer réel (plugin officiel Nutanix), zéro secret", () => {
  const base = { id: "12345678-0000-4000-8000-000000000000", name: "Base Ubuntu", baseVersion: "24.04", components: ["docker", "docker-compose"] };

  it("déclare le plugin officiel et des variables Prism SENSIBLES sans aucune valeur", () => {
    const files = templates.generateVmUbuntuFiles(base);
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('source  = "github.com/nutanix-cloud-native/nutanix"');
    expect(pkr).toMatch(/variable "nutanix_username" \{\n\s+type\s+= string\n\s+sensitive = true/);
    expect(pkr).toMatch(/variable "nutanix_password" \{\n\s+type\s+= string\n\s+sensitive = true/);
    // Les identifiants ne sont référencés QUE via var.* (injectés en PKR_VAR_* à l'exécution).
    expect(pkr).toContain("nutanix_username = var.nutanix_username");
    expect(pkr).toContain("nutanix_password = var.nutanix_password");
    expect(pkr).toContain("nutanix_endpoint = var.nutanix_endpoint");
  });

  it("part de l'image cloud Ubuntu officielle indexée par numéro de version (vm_disks DISK_IMAGE)", () => {
    const files = templates.generateVmUbuntuFiles(base);
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('image_type       = "DISK_IMAGE"');
    expect(pkr).toContain("https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img");
  });

  it("accepte une version future (26.04) telle quelle — jamais un nom de code inventé", () => {
    const files = templates.generateVmUbuntuFiles({ ...base, baseVersion: "26.04" });
    expect(files["template.pkr.hcl"]).toContain("releases/26.04/release/ubuntu-26.04-server-cloudimg-amd64.img");
    expect(files["README.md"]).toContain("échouera au téléchargement");
  });

  it("provisionne les composants cochés via apt (docker.io + plugin compose)", () => {
    const files = templates.generateVmUbuntuFiles(base);
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain("apt-get install -y docker.io docker-compose-v2");
    expect(pkr).toContain("sudo systemctl enable docker");
  });

  it("aucun composant coché -> aucun apt-get, provisioner minimal", () => {
    const files = templates.generateVmUbuntuFiles({ ...base, components: [] });
    expect(files["template.pkr.hcl"]).not.toContain("apt-get install");
  });

  it("post-processor manifest avec le nom d'image réel (capture d'artefact)", () => {
    const files = templates.generateVmUbuntuFiles(base);
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('output     = "packer-manifest.json"');
    expect(pkr).toContain('image_name = "quai-template-base-ubuntu-12345678"');
    expect(pkr).toContain('image_name       = "quai-template-base-ubuntu-12345678"');
  });

  it("génère un cloud-init pour le compte de build temporaire (mot de passe aléatoire par template)", () => {
    const a = templates.generateVmUbuntuFiles(base);
    const b = templates.generateVmUbuntuFiles(base);
    expect(a["cloud-init.yaml"]).toContain("name: builder");
    const passwordOf = (s: string) => /plain_text_passwd: "([^"]+)"/.exec(s)?.[1];
    expect(passwordOf(a["cloud-init.yaml"]!)).toBeTruthy();
    expect(passwordOf(a["cloud-init.yaml"]!)).not.toBe(passwordOf(b["cloud-init.yaml"]!));
  });
});

describe("generateContainerFiles — Dockerfile réel scratch/alpine", () => {
  it("container-scratch : FROM scratch minimal + README d'usage (binaire statique)", () => {
    const files = templates.generateContainerFiles({
      id: "aaaaaaaa-0000-4000-8000-000000000000",
      name: "Vide",
      kind: "container-scratch",
      baseVersion: "",
      components: [],
    });
    expect(files["Dockerfile"]).toContain("FROM scratch");
    expect(files["README.md"]).toContain("STATIQUEMENT");
  });

  it("container-alpine : FROM alpine:<tag> + composants apk (docker-cli, plugin compose)", () => {
    const files = templates.generateContainerFiles({
      id: "bbbbbbbb-0000-4000-8000-000000000000",
      name: "Outils",
      kind: "container-alpine",
      baseVersion: "3.20",
      components: ["docker-cli", "docker-compose", "git"],
    });
    expect(files["Dockerfile"]).toContain("FROM alpine:3.20");
    expect(files["Dockerfile"]).toContain("RUN apk add --no-cache docker-cli docker-cli-compose git");
  });

  it("alpine sans composant : aucun RUN apk fabriqué", () => {
    const files = templates.generateContainerFiles({
      id: "cccccccc-0000-4000-8000-000000000000",
      name: "nu",
      kind: "container-alpine",
      baseVersion: "3.20",
      components: [],
    });
    expect(files["Dockerfile"]).not.toContain("apk add");
  });
});

describe("dockerTagForTemplate / parsePrismEndpoint", () => {
  it("tag au contrat quai-template/<name>:<id-court>", () => {
    expect(templates.dockerTagForTemplate({ id: "deadbeef-0000-4000-8000-000000000000", name: "Mon Template 1!" })).toBe(
      "quai-template/mon-template-1:deadbeef",
    );
  });

  it("endpoint Prism : hostname + port séparés (le plugin n'accepte pas une URL)", () => {
    expect(templates.parsePrismEndpoint("https://prism.lecreusot.fr:9440")).toEqual({ endpoint: "prism.lecreusot.fr", port: 9440 });
    expect(templates.parsePrismEndpoint("172.20.0.10:9440")).toEqual({ endpoint: "172.20.0.10", port: 9440 });
    expect(templates.parsePrismEndpoint("https://prism.local")).toEqual({ endpoint: "prism.local" });
  });
});

describe("parsePackerManifestArtifact — capture d'artefact réelle depuis le manifest", () => {
  it("préfère custom_data.image_name posé par le template généré", () => {
    const manifest = JSON.stringify({
      builds: [{ artifact_id: "uuid-brut", custom_data: { image_name: "quai-template-base-12345678" } }],
    });
    expect(parsePackerManifestArtifact(manifest)).toEqual({ type: "nutanix-image", reference: "quai-template-base-12345678" });
  });

  it("repli sur artifact_id du dernier build si aucun custom_data", () => {
    const manifest = JSON.stringify({ builds: [{ artifact_id: "old" }, { artifact_id: "9f0b-uuid" }] });
    expect(parsePackerManifestArtifact(manifest)).toEqual({ type: "nutanix-image", reference: "9f0b-uuid" });
  });

  it("manifest illisible/vide -> undefined, jamais une référence inventée", () => {
    expect(parsePackerManifestArtifact("not json")).toBeUndefined();
    expect(parsePackerManifestArtifact(JSON.stringify({ builds: [] }))).toBeUndefined();
    expect(parsePackerManifestArtifact(JSON.stringify({}))).toBeUndefined();
  });
});

describe("Routes /api/templates — cycle de vie complet (store + workspace réels)", () => {
  it("POST crée le template ET son workspace avec les fichiers de build générés (vm-ubuntu)", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "Ubuntu Docker", kind: "vm-ubuntu", baseVersion: "24.04", components: ["docker"] },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json() as { id: string; workspaceId: string; status: string; kind: string };
    expect(template.status).toBe("draft");
    expect(template.kind).toBe("vm-ubuntu");

    const wsDir = workspaceFilesPath(template.workspaceId);
    const pkr = await fs.readFile(path.join(wsDir, "template.pkr.hcl"), "utf-8");
    expect(pkr).toContain('source "nutanix" "template"');
    // Le scaffold de démo Packer (image Docker alpine) a bien été remplacé.
    expect(pkr).not.toContain("quai-demo");
    await fs.access(path.join(wsDir, "cloud-init.yaml"));

    const detail = await app.inject({ method: "GET", url: `/api/templates/${template.id}`, cookies: cookieFor(["viewer"]) });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { id: string }).id).toBe(template.id);

    const builds = await app.inject({ method: "GET", url: `/api/templates/${template.id}/builds`, cookies: cookieFor(["viewer"]) });
    expect(builds.statusCode).toBe(200);
    expect(builds.json()).toEqual([]);

    // Build vm-ubuntu SANS configuration Nutanix : refus propre 400, jamais un packer build lancé.
    const build = await app.inject({ method: "POST", url: `/api/templates/${template.id}/build`, cookies: cookieFor(["admin"]) });
    expect(build.statusCode).toBe(400);
    expect((build.json() as { error: string }).error).toContain("Nutanix");

    // DELETE supprime le template ET son workspace.
    const deleted = await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
    expect(deleted.statusCode).toBe(200);
    await expect(fs.access(wsDir)).rejects.toThrow();
    const gone = await app.inject({ method: "GET", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
    expect(gone.statusCode).toBe(404);
  });

  it("POST container-alpine : Dockerfile généré dans le workspace (moteur docker)", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["operator"]),
      payload: { name: "outils alpine", kind: "container-alpine", baseVersion: "3.20", components: ["docker-cli"] },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json() as { id: string; workspaceId: string };
    const dockerfile = await fs.readFile(path.join(workspaceFilesPath(template.workspaceId), "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("FROM alpine:3.20");
    expect(dockerfile).toContain("docker-cli");
    await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["operator"]) });
  });

  it("GET liste les templates créés", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "scratch min", kind: "container-scratch", baseVersion: "", components: [] },
    });
    const template = created.json() as { id: string };
    const list = await app.inject({ method: "GET", url: "/api/templates", cookies: cookieFor(["viewer"]) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).some((t) => t.id === template.id)).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
  });

  it("mutations refusées à un viewer (403), validations 400/404 honnêtes", async () => {
    app = buildServer();
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["viewer"]),
      payload: { name: "x", kind: "container-scratch", baseVersion: "", components: [] },
    });
    expect(forbidden.statusCode).toBe(403);

    const badKind = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "x", kind: "vm-windows", baseVersion: "11", components: [] },
    });
    expect(badKind.statusCode).toBe(400);

    const badComponent = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "x", kind: "container-alpine", baseVersion: "3.20", components: ["evil; rm -rf /"] },
    });
    expect(badComponent.statusCode).toBe(400);

    const notFound = await app.inject({ method: "GET", url: "/api/templates/unknown-id", cookies: cookieFor(["admin"]) });
    expect(notFound.statusCode).toBe(404);
    const buildNotFound = await app.inject({ method: "POST", url: "/api/templates/unknown-id/build", cookies: cookieFor(["admin"]) });
    expect(buildNotFound.statusCode).toBe(404);
    const deleteNotFound = await app.inject({ method: "DELETE", url: "/api/templates/unknown-id", cookies: cookieFor(["admin"]) });
    expect(deleteNotFound.statusCode).toBe(404);
  });

  it("aucun secret Prism dans AUCUN fichier écrit par la création d'un template", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "sans secret", kind: "vm-ubuntu", baseVersion: "24.04", components: [] },
    });
    const template = created.json() as { id: string; workspaceId: string };
    const wsDir = workspaceFilesPath(template.workspaceId);
    const entries = (await fs.readdir(wsDir, { recursive: true })) as string[];
    for (const entry of entries) {
      const filePath = path.join(wsDir, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(filePath, "utf-8");
      // Jamais une affectation littérale des identifiants Prism — uniquement var.* / PKR_VAR_*.
      expect(content).not.toMatch(/nutanix_password\s*=\s*"[^"]/);
      expect(content).not.toMatch(/nutanix_username\s*=\s*"[^"]/);
    }
    // L'index des templates lui-même ne porte aucun champ secret.
    const index = await fs.readFile(templatesIndexPath, "utf-8");
    expect(index).not.toContain("password");
    await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
  });
});
