import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
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
const store = await import("../src/services/templatesStore.js");
const { ENGINE_ACTIONS } = await import("../src/services/iac/runner.js");
const { workspaceFilesPath } = await import("../src/services/iac/workspaces.js");
import type { ImageTemplate, TemplateBase, TemplateStep } from "../src/types.js";

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
  await fs.rm(templatesIndexPath, { force: true });
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

const cloudBase: TemplateBase = { type: "cloud-image", distro: "ubuntu", version: "24.04" };
const id = "12345678-0000-4000-8000-000000000000";

function recipe(base: TemplateBase, steps: TemplateStep[] = []) {
  return { name: "r", base, steps };
}

describe("validateCreateInput — recettes libres, injections toujours rejetées", () => {
  it("accepte une recette cloud-image complète (packages/script/file/user/service)", () => {
    expect(() =>
      templates.validateCreateInput(
        recipe(cloudBase, [
          { type: "packages", packages: ["docker.io", "python3", "g++-12"] },
          { type: "script", content: "echo hello" },
          { type: "file", path: "/etc/motd", content: "bienvenue", mode: "644" },
          { type: "user", username: "deploy", sudo: true, sshAuthorizedKey: "ssh-ed25519 AAAA demo@host" },
          { type: "service", name: "docker", enable: true },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejette un nom de paquet non conforme à la regex (défense injection shell)", () => {
    for (const bad of ["docker; rm -rf /", "$(evil)", "a b", "-flag", ""]) {
      expect(() => templates.validateCreateInput(recipe(cloudBase, [{ type: "packages", packages: [bad] }]))).toThrow(
        templates.TemplateValidationError,
      );
    }
  });

  it("rejette un chemin file/destPath non absolu, avec .. ou caractères dangereux", () => {
    for (const bad of ["../etc/passwd", "/etc/../etc/passwd", "relative/path", "/tmp/a'b", "/tmp/a b", "/tmp/a\nb"]) {
      expect(() => templates.validateCreateInput(recipe(cloudBase, [{ type: "file", path: bad, content: "x" }]))).toThrow(
        templates.TemplateValidationError,
      );
      expect(() =>
        templates.validateCreateInput(recipe(cloudBase, [{ type: "artifact", templateId: id, destPath: bad }])),
      ).toThrow(templates.TemplateValidationError);
    }
  });

  it("scratch : seules les étapes file/artifact (COPY) sont possibles — limite honnête", () => {
    const scratch: TemplateBase = { type: "container", image: "scratch" };
    expect(() =>
      templates.validateCreateInput(recipe(scratch, [{ type: "file", path: "/app/bin", content: "x" }])),
    ).not.toThrow();
    expect(() => templates.validateCreateInput(recipe(scratch, [{ type: "packages", packages: ["python3"] }]))).toThrow(/scratch/);
    expect(() => templates.validateCreateInput(recipe(scratch, [{ type: "script", content: "echo x" }]))).toThrow(/scratch/);
    expect(() => templates.validateCreateInput(recipe(scratch, [{ type: "user", username: "x" }]))).toThrow(/scratch/);
    // mode exige un chmod (shell) : refusé sur scratch, jamais un COPY --chmod (BuildKit absent).
    expect(() =>
      templates.validateCreateInput(recipe(scratch, [{ type: "file", path: "/app/bin", content: "x", mode: "755" }])),
    ).toThrow(/scratch/);
  });

  it("container : service refusé (pas de systemd), dockerLoad refusé (pas de démon pendant le build)", () => {
    const debian: TemplateBase = { type: "container", image: "debian:12" };
    expect(() => templates.validateCreateInput(recipe(debian, [{ type: "service", name: "cron", enable: true }]))).toThrow(/systemd/);
    expect(() =>
      templates.validateCreateInput(recipe(debian, [{ type: "artifact", templateId: id, destPath: "/opt/img.tar", dockerLoad: true }])),
    ).toThrow(/cloud-image/);
    expect(() =>
      templates.validateCreateInput(
        recipe({ type: "mkosi", distro: "debian", release: "bookworm" }, [
          { type: "artifact", templateId: id, destPath: "/opt/img.tar", dockerLoad: true },
        ]),
      ),
    ).toThrow(/cloud-image/);
  });

  it("container : packages sur une image au gestionnaire de paquets inconnu refusé honnêtement", () => {
    expect(() =>
      templates.validateCreateInput(recipe({ type: "container", image: "mycorp/customos:1" }, [{ type: "packages", packages: ["curl"] }])),
    ).toThrow(/gestionnaire de paquets inconnu/);
  });

  it("cloud-image : distro inconnue sans imageUrl refusée (jamais une URL inventée), acceptée avec imageUrl", () => {
    expect(() => templates.validateCreateInput(recipe({ type: "cloud-image", distro: "opensuse", version: "15.6" }))).toThrow(
      /imageUrl/,
    );
    expect(() =>
      templates.validateCreateInput(
        recipe({ type: "cloud-image", distro: "opensuse", version: "15.6", imageUrl: "https://example.org/leap-15.6.qcow2" }),
      ),
    ).not.toThrow();
  });

  it("mkosi : distro hors enum refusée", () => {
    expect(() =>
      templates.validateCreateInput(recipe({ type: "mkosi", distro: "gentoo" as never, release: "latest" })),
    ).toThrow(templates.TemplateValidationError);
  });
});

describe("resolveCloudImageUrl — résolution officielle ou imageUrl explicite", () => {
  it("ubuntu -> cloud-images.ubuntu.com indexé par numéro de version", () => {
    expect(templates.resolveCloudImageUrl({ type: "cloud-image", distro: "ubuntu", version: "24.04" })).toBe(
      "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img",
    );
  });

  it("debian -> cloud.debian.org (12 <-> bookworm, numéro ou nom de code acceptés)", () => {
    const expected = "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2";
    expect(templates.resolveCloudImageUrl({ type: "cloud-image", distro: "debian", version: "12" })).toBe(expected);
    expect(templates.resolveCloudImageUrl({ type: "cloud-image", distro: "debian", version: "bookworm" })).toBe(expected);
  });

  it("version debian inconnue -> erreur claire, jamais un nom de code deviné", () => {
    expect(() => templates.resolveCloudImageUrl({ type: "cloud-image", distro: "debian", version: "99" })).toThrow(/imageUrl/);
  });

  it("imageUrl explicite prioritaire sur la résolution", () => {
    expect(
      templates.resolveCloudImageUrl({ type: "cloud-image", distro: "ubuntu", version: "24.04", imageUrl: "https://mirror.local/x.img" }),
    ).toBe("https://mirror.local/x.img");
  });
});

describe("generateCloudImageFiles — Packer réel + un script par étape, zéro secret", () => {
  const tpl = {
    id,
    name: "Base Ubuntu",
    base: cloudBase,
    steps: [
      { type: "packages", packages: ["docker.io", "docker-compose-v2"] },
      { type: "file", path: "/etc/quai/app.conf", content: "clé=valeur\n", mode: "600" },
      { type: "service", name: "docker", enable: true },
    ] as TemplateStep[],
  };

  it("déclare le plugin officiel et des variables Prism SENSIBLES sans aucune valeur", () => {
    const files = templates.generateCloudImageFiles(tpl);
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('source  = "github.com/nutanix-cloud-native/nutanix"');
    expect(pkr).toMatch(/variable "nutanix_username" \{\n\s+type\s+= string\n\s+sensitive = true/);
    expect(pkr).toMatch(/variable "nutanix_password" \{\n\s+type\s+= string\n\s+sensitive = true/);
    expect(pkr).toContain("nutanix_username = var.nutanix_username");
    expect(pkr).toContain("https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img");
  });

  it("génère un script scripts/NN-<type>.sh par étape, ordonné, référencé par un provisioner sudo", () => {
    const files = templates.generateCloudImageFiles(tpl);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["scripts/01-packages.sh", "scripts/02-file.sh", "scripts/03-service.sh"]),
    );
    expect(files["scripts/01-packages.sh"]).toContain("apt-get install -y docker.io docker-compose-v2");
    expect(files["scripts/03-service.sh"]).toContain("systemctl enable 'docker'");
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('script          = "${path.root}/scripts/01-packages.sh"');
    expect(pkr).toContain('execute_command = "chmod +x {{ .Path }}; sudo -E {{ .Path }}"');
    expect(pkr.indexOf("01-packages")).toBeLessThan(pkr.indexOf("02-file"));
  });

  it("étape file : contenu écrit en base64 (jamais interpolé brut) + chmod du mode demandé", () => {
    const files = templates.generateCloudImageFiles(tpl);
    const script = files["scripts/02-file.sh"]!;
    const b64 = Buffer.from("clé=valeur\n", "utf-8").toString("base64");
    expect(script).toContain(`echo '${b64}' | base64 -d > '/etc/quai/app.conf'`);
    expect(script).toContain("chmod 600 '/etc/quai/app.conf'");
    expect(script).toContain("mkdir -p '/etc/quai'");
  });

  it("étape script libre : contenu verbatim dans un fichier provisionné, jamais dans une commande QUAI", () => {
    const files = templates.generateCloudImageFiles({
      ...tpl,
      steps: [{ type: "script", content: "curl -fsSL https://get.example.sh | sh" }],
    });
    expect(files["scripts/01-script.sh"]).toBe("#!/bin/sh\ncurl -fsSL https://get.example.sh | sh\n");
  });

  it("étape artifact : provisioner file + script mv/docker load dans la VM", () => {
    const files = templates.generateCloudImageFiles({
      ...tpl,
      steps: [{ type: "artifact", templateId: randomUUID(), destPath: "/opt/quai/app-image.tar", dockerLoad: true }],
    });
    const pkr = files["template.pkr.hcl"]!;
    expect(pkr).toContain('source      = "${path.root}/artifacts/01-artifact"');
    expect(pkr).toContain('destination = "/tmp/quai-artifact-01"');
    const script = files["scripts/01-artifact.sh"]!;
    expect(script).toContain("mv '/tmp/quai-artifact-01' '/opt/quai/app-image.tar'");
    expect(script).toContain("docker load -i '/opt/quai/app-image.tar'");
  });

  it("cloud-init : compte de build temporaire, mot de passe aléatoire par génération", () => {
    const a = templates.generateCloudImageFiles(tpl);
    const b = templates.generateCloudImageFiles(tpl);
    const passwordOf = (s: string) => /plain_text_passwd: "([^"]+)"/.exec(s)?.[1];
    expect(passwordOf(a["cloud-init.yaml"]!)).toBeTruthy();
    expect(passwordOf(a["cloud-init.yaml"]!)).not.toBe(passwordOf(b["cloud-init.yaml"]!));
  });

  it("post-processor manifest avec le nom d'image réel (capture d'artefact)", () => {
    const files = templates.generateCloudImageFiles(tpl);
    expect(files["template.pkr.hcl"]).toContain('image_name = "quai-template-base-ubuntu-12345678"');
  });
});

describe("generateContainerFiles — Dockerfile réel depuis la recette", () => {
  it("debian + python3 : RUN apt-get réel", () => {
    const files = templates.generateContainerFiles({
      id,
      name: "Debian py",
      base: { type: "container", image: "debian:12" },
      steps: [{ type: "packages", packages: ["python3"] }],
    });
    expect(files["Dockerfile"]).toContain("FROM debian:12");
    expect(files["Dockerfile"]).toContain("RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3");
  });

  it("alpine : RUN apk add ; étape script copiée puis exécutée dans le build", () => {
    const files = templates.generateContainerFiles({
      id,
      name: "outils",
      base: { type: "container", image: "alpine:3.20" },
      steps: [
        { type: "packages", packages: ["git", "curl"] },
        { type: "script", content: "echo built > /etc/quai-built" },
      ],
    });
    expect(files["Dockerfile"]).toContain("RUN apk add --no-cache git curl");
    expect(files["Dockerfile"]).toContain("COPY scripts/02-script.sh /tmp/quai-step-02.sh");
    expect(files["Dockerfile"]).toContain("RUN sh /tmp/quai-step-02.sh && rm -f /tmp/quai-step-02.sh");
    expect(files["scripts/02-script.sh"]).toContain("echo built > /etc/quai-built");
  });

  it("scratch + file/artifact : COPY uniquement, aucun RUN fabriqué ; mode -> RUN chmod si shell", () => {
    const files = templates.generateContainerFiles({
      id,
      name: "vide",
      base: { type: "container", image: "scratch" },
      steps: [
        { type: "file", path: "/app/bin", content: "BINARY" },
        { type: "artifact", templateId: randomUUID(), destPath: "/data/image.tar" },
      ],
    });
    const dockerfile = files["Dockerfile"]!;
    expect(dockerfile).toContain("FROM scratch");
    expect(dockerfile).toContain("COPY files/01-file /app/bin");
    expect(dockerfile).toContain("COPY artifacts/02-artifact /data/image.tar");
    expect(dockerfile).not.toContain("RUN ");
    expect(files["files/01-file"]).toBe("BINARY");

    const withMode = templates.generateContainerFiles({
      id,
      name: "conf",
      base: { type: "container", image: "debian:12" },
      steps: [{ type: "file", path: "/etc/app.conf", content: "x=1", mode: "600" }],
    });
    expect(withMode["Dockerfile"]).toContain("COPY files/01-file /etc/app.conf");
    expect(withMode["Dockerfile"]).toContain("RUN chmod 600 '/etc/app.conf'");
  });
});

describe("generateMkosiFiles — mkosi.conf + mkosi.extra/ + postinst, vérifiés sur le contenu", () => {
  const mkosiBase: TemplateBase = { type: "mkosi", distro: "debian", release: "bookworm" };

  it("mkosi.conf : distribution/release réels, Format=disk bootable, ImageId au contrat", () => {
    const files = templates.generateMkosiFiles({ id, name: "OS min", base: mkosiBase, steps: [{ type: "packages", packages: ["openssh-server", "vim"] }] });
    const conf = files["mkosi.conf"]!;
    expect(conf).toContain("Distribution=debian");
    expect(conf).toContain("Release=bookworm");
    expect(conf).toContain("Format=disk");
    expect(conf).toContain("Bootable=yes");
    expect(conf).toContain("ImageId=quai-template-os-min-12345678");
    expect(conf).toContain("OutputDirectory=mkosi.output");
    expect(conf).toContain("Packages=openssh-server,vim");
  });

  it("étape file -> mkosi.extra/<path> tel quel + chmod dans le postinst si mode", () => {
    const files = templates.generateMkosiFiles({
      id,
      name: "os",
      base: mkosiBase,
      steps: [{ type: "file", path: "/etc/quai/app.conf", content: "x=1\n", mode: "600" }],
    });
    expect(files["mkosi.extra/etc/quai/app.conf"]).toBe("x=1\n");
    expect(files["mkosi.postinst.chroot"]).toContain("chmod 600 '/etc/quai/app.conf'");
  });

  it("étapes script/user/service -> provisionnées puis exécutées en chroot via le postinst", () => {
    const files = templates.generateMkosiFiles({
      id,
      name: "os",
      base: mkosiBase,
      steps: [
        { type: "script", content: "echo hello" },
        { type: "user", username: "deploy", sudo: true },
        { type: "service", name: "sshd", enable: true },
      ],
    });
    expect(files["mkosi.extra/usr/local/lib/quai-steps/01-script.sh"]).toContain("echo hello");
    const postinst = files["mkosi.postinst.chroot"]!;
    expect(postinst.startsWith("#!/bin/sh\nset -e\n")).toBe(true);
    expect(postinst).toContain("sh /usr/local/lib/quai-steps/01-script.sh");
    expect(postinst).toContain("useradd -m -s /bin/sh 'deploy'");
    expect(postinst).toContain("/etc/sudoers.d/90-quai-deploy");
    expect(postinst).toContain("systemctl enable 'sshd'");
  });

  it("aucune étape postinst -> pas de fichier postinst fabriqué", () => {
    const files = templates.generateMkosiFiles({ id, name: "os", base: mkosiBase, steps: [] });
    expect(files["mkosi.postinst.chroot"]).toBeUndefined();
  });

  it("le runner connaît le moteur mkosi (action build uniquement)", () => {
    expect(ENGINE_ACTIONS.mkosi).toEqual(["build"]);
  });
});

describe("dockerTagForTemplate / parsePrismEndpoint / parsePackerManifestArtifact (inchangés)", () => {
  it("tag au contrat quai-template/<name>:<id-court>", () => {
    expect(templates.dockerTagForTemplate({ id: "deadbeef-0000-4000-8000-000000000000", name: "Mon Template 1!" })).toBe(
      "quai-template/mon-template-1:deadbeef",
    );
  });

  it("endpoint Prism : hostname + port séparés (le plugin n'accepte pas une URL)", () => {
    expect(templates.parsePrismEndpoint("https://prism.lecreusot.fr:9440")).toEqual({ endpoint: "prism.lecreusot.fr", port: 9440 });
    expect(templates.parsePrismEndpoint("172.20.0.10:9440")).toEqual({ endpoint: "172.20.0.10", port: 9440 });
  });

  it("manifest Packer : custom_data.image_name prioritaire, undefined si rien d'exploitable", async () => {
    const { parsePackerManifestArtifact } = await import("../src/services/iac/runner.js");
    expect(
      parsePackerManifestArtifact(JSON.stringify({ builds: [{ artifact_id: "uuid-brut", custom_data: { image_name: "quai-img" } }] })),
    ).toEqual({ type: "nutanix-image", reference: "quai-img" });
    expect(parsePackerManifestArtifact("not json")).toBeUndefined();
  });
});

describe("migration v1 -> recettes (à la lecture, réécrite une fois, rien perdu)", () => {
  it("convertit kind/baseVersion/components en base+steps et réécrit l'index", async () => {
    const v1 = [
      {
        id: randomUUID(),
        name: "Ubuntu Docker v1",
        kind: "vm-ubuntu",
        baseVersion: "24.04",
        components: ["docker", "docker-compose"],
        status: "ready",
        workspaceId: randomUUID(),
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastBuild: { runId: randomUUID(), status: "success", artifact: { type: "nutanix-image", reference: "img-1" } },
      },
      {
        id: randomUUID(),
        name: "Alpine v1",
        kind: "container-alpine",
        baseVersion: "3.20",
        components: ["docker-cli", "git"],
        status: "draft",
        workspaceId: randomUUID(),
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: randomUUID(),
        name: "Scratch v1",
        kind: "container-scratch",
        baseVersion: "",
        components: [],
        status: "draft",
        workspaceId: randomUUID(),
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(templatesIndexPath, JSON.stringify(v1, null, 2), "utf-8");

    const migrated = await store.listStoredTemplates();
    expect(migrated).toHaveLength(3);

    const ubuntu = migrated.find((t) => t.name === "Ubuntu Docker v1")!;
    expect(ubuntu.base).toEqual({ type: "cloud-image", distro: "ubuntu", version: "24.04" });
    expect(ubuntu.steps).toEqual([
      { type: "packages", packages: ["docker.io", "docker-compose-v2"] },
      { type: "service", name: "docker", enable: true },
    ]);
    expect(ubuntu.status).toBe("ready");
    expect(ubuntu.lastBuild?.artifact).toEqual({ type: "nutanix-image", reference: "img-1" });

    const alpine = migrated.find((t) => t.name === "Alpine v1")!;
    expect(alpine.base).toEqual({ type: "container", image: "alpine:3.20" });
    expect(alpine.steps).toEqual([{ type: "packages", packages: ["docker-cli", "git"] }]);

    const scratch = migrated.find((t) => t.name === "Scratch v1")!;
    expect(scratch.base).toEqual({ type: "container", image: "scratch" });
    expect(scratch.steps).toEqual([]);

    // L'index a été réécrit au nouveau format : plus aucun champ v1 sur disque.
    const rewritten = await fs.readFile(templatesIndexPath, "utf-8");
    expect(rewritten).not.toContain('"kind"');
    expect(rewritten).not.toContain('"components"');
    expect(rewritten).toContain('"base"');
  });
});

describe("Routes /api/templates — cycle de vie complet (store + workspace réels)", () => {
  it("POST cloud-image : workspace avec pkr + scripts générés ; build sans Nutanix refusé 400 ; DELETE nettoie", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: {
        name: "Ubuntu Docker",
        base: cloudBase,
        steps: [
          { type: "packages", packages: ["docker.io"] },
          { type: "service", name: "docker", enable: true },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json() as ImageTemplate;
    expect(template.status).toBe("draft");
    expect(template.base).toEqual(cloudBase);

    const wsDir = workspaceFilesPath(template.workspaceId);
    const pkr = await fs.readFile(path.join(wsDir, "template.pkr.hcl"), "utf-8");
    expect(pkr).toContain('source "nutanix" "template"');
    expect(pkr).not.toContain("quai-demo");
    await fs.access(path.join(wsDir, "cloud-init.yaml"));
    await fs.access(path.join(wsDir, "scripts", "01-packages.sh"));

    const detail = await app.inject({ method: "GET", url: `/api/templates/${template.id}`, cookies: cookieFor(["viewer"]) });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as ImageTemplate).steps).toHaveLength(2);

    const build = await app.inject({ method: "POST", url: `/api/templates/${template.id}/build`, cookies: cookieFor(["admin"]) });
    expect(build.statusCode).toBe(400);
    expect((build.json() as { error: string }).error).toContain("Nutanix");

    const deleted = await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
    expect(deleted.statusCode).toBe(200);
    await expect(fs.access(wsDir)).rejects.toThrow();
  });

  it("POST container : Dockerfile généré dans le workspace (moteur docker)", async () => {
    app = buildServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["operator"]),
      payload: { name: "debian python", base: { type: "container", image: "debian:12" }, steps: [{ type: "packages", packages: ["python3"] }] },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json() as ImageTemplate;
    const dockerfile = await fs.readFile(path.join(workspaceFilesPath(template.workspaceId), "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("FROM debian:12");
    expect(dockerfile).toContain("python3");
    await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["operator"]) });
  });

  it("GET /api/templates/presets : les 5 recettes pré-remplies du contrat", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/templates/presets", cookies: cookieFor(["viewer"]) });
    expect(res.statusCode).toBe(200);
    const presets = res.json() as Array<{ id: string; base: TemplateBase; steps: TemplateStep[]; label: string; description: string }>;
    expect(presets.map((p) => p.id)).toEqual(["ubuntu-docker", "debian-python3", "alpine", "scratch", "mkosi-minimal"]);
    const debianPy = presets.find((p) => p.id === "debian-python3")!;
    expect(debianPy.base).toEqual({ type: "cloud-image", distro: "debian", version: "12" });
    expect(debianPy.steps).toEqual([{ type: "packages", packages: ["python3"] }]);
  });

  it("GET /api/templates/artifact-sources : docker-image/raw-image exposés, nutanix-image exclu", async () => {
    app = buildServer();
    const mk = (name: string, artifact?: { type: "nutanix-image" | "docker-image" | "raw-image"; reference: string }): ImageTemplate => ({
      id: randomUUID(),
      name,
      base: { type: "container", image: "alpine:3.20" },
      steps: [],
      status: "ready",
      workspaceId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(artifact ? { lastBuild: { runId: randomUUID(), status: "success" as const, artifact } } : {}),
    });
    await store.insertTemplate(mk("docker src", { type: "docker-image", reference: "quai-template/docker-src:12345678" }));
    await store.insertTemplate(mk("raw src", { type: "raw-image", reference: "mkosi.output/quai-template-raw.raw" }));
    await store.insertTemplate(mk("nutanix src", { type: "nutanix-image", reference: "img-uuid" }));
    await store.insertTemplate(mk("jamais buildé"));

    const res = await app.inject({ method: "GET", url: "/api/templates/artifact-sources", cookies: cookieFor(["viewer"]) });
    expect(res.statusCode).toBe(200);
    const sources = res.json() as Array<{ templateId: string; name: string; artifactType: string; reference: string }>;
    expect(sources.map((s) => s.name).sort()).toEqual(["docker src", "raw src"]);
    expect(sources.find((s) => s.name === "docker src")?.artifactType).toBe("docker-image");
  });

  it("étape artifact : source inexistante, jamais buildée ou nutanix-image -> 400 honnête", async () => {
    app = buildServer();
    const post = (templateId: string) =>
      app!.inject({
        method: "POST",
        url: "/api/templates",
        cookies: cookieFor(["admin"]),
        payload: { name: "conso", base: cloudBase, steps: [{ type: "artifact", templateId, destPath: "/opt/a.tar" }] },
      });

    const missing = await post(randomUUID());
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toContain("introuvable");

    const neverBuilt: ImageTemplate = {
      id: randomUUID(),
      name: "brouillon",
      base: { type: "container", image: "alpine:3.20" },
      steps: [],
      status: "draft",
      workspaceId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.insertTemplate(neverBuilt);
    const notBuilt = await post(neverBuilt.id);
    expect(notBuilt.statusCode).toBe(400);
    expect((notBuilt.json() as { error: string }).error).toContain("artefact");

    const nutanixSrc: ImageTemplate = {
      ...neverBuilt,
      id: randomUUID(),
      name: "vm source",
      lastBuild: { runId: randomUUID(), status: "success", artifact: { type: "nutanix-image", reference: "img-uuid" } },
    };
    await store.insertTemplate(nutanixSrc);
    const untransferable = await post(nutanixSrc.id);
    expect(untransferable.statusCode).toBe(400);
    expect((untransferable.json() as { error: string }).error).toContain("non transférable");
  });

  it("base mkosi : refusée 409 avec message clair si le binaire mkosi est absent", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "os minimal", base: { type: "mkosi", distro: "debian", release: "bookworm" }, steps: [] },
    });
    if (await templates.isMkosiAvailable()) {
      expect(res.statusCode).toBe(201);
      const template = res.json() as ImageTemplate;
      await fs.access(path.join(workspaceFilesPath(template.workspaceId), "mkosi.conf"));
      await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
    } else {
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain("mkosi non disponible");
    }
  });

  it("mutations refusées à un viewer (403), validations 400/404 honnêtes", async () => {
    app = buildServer();
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["viewer"]),
      payload: { name: "x", base: { type: "container", image: "scratch" }, steps: [] },
    });
    expect(forbidden.statusCode).toBe(403);

    const badBase = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "x", base: { type: "vm-windows" }, steps: [] },
    });
    expect(badBase.statusCode).toBe(400);

    const badStep = await app.inject({
      method: "POST",
      url: "/api/templates",
      cookies: cookieFor(["admin"]),
      payload: { name: "x", base: { type: "container", image: "alpine:3.20" }, steps: [{ type: "packages", packages: ["evil; rm -rf /"] }] },
    });
    expect(badStep.statusCode).toBe(400);

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
      payload: { name: "sans secret", base: cloudBase, steps: [{ type: "script", content: "echo ok" }] },
    });
    const template = created.json() as ImageTemplate;
    const wsDir = workspaceFilesPath(template.workspaceId);
    const entries = (await fs.readdir(wsDir, { recursive: true })) as string[];
    for (const entry of entries) {
      const filePath = path.join(wsDir, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).not.toMatch(/nutanix_password\s*=\s*"[^"]/);
      expect(content).not.toMatch(/nutanix_username\s*=\s*"[^"]/);
    }
    const index = await fs.readFile(templatesIndexPath, "utf-8");
    expect(index).not.toContain("password");
    await app.inject({ method: "DELETE", url: `/api/templates/${template.id}`, cookies: cookieFor(["admin"]) });
  });
});
