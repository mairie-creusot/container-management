import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de la nouvelle logique de détection/priorité/déploiement docker-compose (cf. mission
 * "Intégration GitHub façon Railway" — apps/api/src/services/github.ts). Fonctions PURES testées
 * directement (aucun réseau, aucun clone, aucun Docker requis) ; la résolution de sous-dossiers
 * via l'API GitHub Contents est testée en mockant `fetch` global, même pattern que
 * test/registriesOrgResolution.test.ts.
 */
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const github = await import("../src/services/github.js");

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chooseDeploymentEngine — priorité compose > Dockerfile > Terraform > Ansible > rien", () => {
  const base = { hasDockerfile: false, hasCompose: false, terraformFiles: [] as string[], hasAnsible: false, packerFiles: [] as string[] };

  it("docker-compose ET Dockerfile présents au même endroit -> compose l'emporte (sur-ensemble strict)", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasDockerfile: true, hasCompose: true })).toBe("compose");
  });

  it("Dockerfile seul -> dockerfile", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasDockerfile: true })).toBe("dockerfile");
  });

  it("compose seul -> compose (le manque historique comblé par cette mission)", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasCompose: true })).toBe("compose");
  });

  it("Terraform seul (aucun Dockerfile/compose) -> terraform", () => {
    expect(github.chooseDeploymentEngine({ ...base, terraformFiles: ["main.tf"] })).toBe("terraform");
  });

  it("Dockerfile ET Terraform -> dockerfile l'emporte (comportement historique inchangé)", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasDockerfile: true, terraformFiles: ["main.tf"] })).toBe("dockerfile");
  });

  it("Ansible seul (aucun Dockerfile/compose/Terraform) -> ansible", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasAnsible: true })).toBe("ansible");
  });

  it("Terraform ET Ansible -> terraform l'emporte", () => {
    expect(github.chooseDeploymentEngine({ ...base, terraformFiles: ["main.tf"], hasAnsible: true })).toBe("terraform");
  });

  it("Packer seul (aucun autre mécanisme) -> packer", () => {
    expect(github.chooseDeploymentEngine({ ...base, packerFiles: ["ubuntu.pkr.hcl"] })).toBe("packer");
  });

  it("Ansible ET Packer -> ansible l'emporte (packer en dernier recours)", () => {
    expect(github.chooseDeploymentEngine({ ...base, hasAnsible: true, packerFiles: ["ubuntu.pkr.hcl"] })).toBe("ansible");
  });

  it("rien du tout -> none", () => {
    expect(github.chooseDeploymentEngine(base)).toBe("none");
  });
});

describe("summarizeEntries — détection Dockerfile/docker-compose/Terraform/Ansible dans un dossier", () => {
  it("détecte docker-compose.yml (jamais compose.yaml en priorité s'il coexiste)", () => {
    const s = github.summarizeEntries([
      { name: "docker-compose.yml", type: "file" },
      { name: "compose.yaml", type: "file" },
      { name: "README.md", type: "file" },
    ]);
    expect(s.hasCompose).toBe(true);
    expect(s.composeFileName).toBe("docker-compose.yml");
  });

  it("détecte compose.yml seul (convention alternative)", () => {
    const s = github.summarizeEntries([{ name: "compose.yml", type: "file" }]);
    expect(s.hasCompose).toBe(true);
    expect(s.composeFileName).toBe("compose.yml");
  });

  it("un repo sans Dockerfile/compose/Terraform/Ansible ne remonte JAMAIS un booléen à true", () => {
    const s = github.summarizeEntries([{ name: "README.md", type: "file" }, { name: "package.json", type: "file" }]);
    expect(s).toMatchObject({ hasDockerfile: false, hasCompose: false, hasAnsible: false, terraformFiles: [] });
  });

  it("détecte un playbook Ansible (playbook.yml) et un fichier Terraform simultanément", () => {
    const s = github.summarizeEntries([
      { name: "playbook.yml", type: "file" },
      { name: "main.tf", type: "file" },
    ]);
    expect(s.hasAnsible).toBe(true);
    expect(s.ansiblePlaybook).toBe("playbook.yml");
    expect(s.terraformFiles).toEqual(["main.tf"]);
  });

  it("détecte site.yml comme playbook Ansible (convention alternative)", () => {
    const s = github.summarizeEntries([{ name: "site.yml", type: "file" }]);
    expect(s.hasAnsible).toBe(true);
    expect(s.ansiblePlaybook).toBe("site.yml");
  });

  it("ignore les dossiers (type 'dir') — seuls les fichiers comptent", () => {
    const s = github.summarizeEntries([{ name: "Dockerfile", type: "dir" }]);
    expect(s.hasDockerfile).toBe(false);
  });

  it("détecte les templates Packer (*.pkr.hcl), jamais un .hcl quelconque", () => {
    const s = github.summarizeEntries([
      { name: "ubuntu.pkr.hcl", type: "file" },
      { name: "variables.pkr.hcl", type: "file" },
      { name: "terragrunt.hcl", type: "file" },
    ]);
    expect(s.packerFiles).toEqual(["ubuntu.pkr.hcl", "variables.pkr.hcl"]);
  });

  it("aucun fichier Packer -> packerFiles [] (jamais fabriqué)", () => {
    const s = github.summarizeEntries([{ name: "README.md", type: "file" }]);
    expect(s.packerFiles).toEqual([]);
  });
});

describe("parseComposeServiceCandidates — services candidats pour la route de sous-domaine", () => {
  it("un service SANS ports ni expose n'est jamais candidat (ex: base de données interne)", () => {
    const yaml = `
services:
  db:
    image: postgres:16
  web:
    build: .
    ports:
      - "3000:3000"
`;
    const candidates = github.parseComposeServiceCandidates(yaml);
    expect(candidates).toEqual([{ name: "web", port: 3000 }]);
  });

  it("plusieurs services exposant un port -> tous candidats (ambiguïté réelle, jamais résolue en silence)", () => {
    const yaml = `
services:
  web:
    ports: ["8080:80"]
  api:
    ports: ["3000:3000"]
`;
    const candidates = github.parseComposeServiceCandidates(yaml);
    expect(candidates.map((c) => c.name).sort()).toEqual(["api", "web"]);
  });

  it("port CONTENEUR extrait (jamais le port hôte) depuis la syntaxe courte", () => {
    const candidates = github.parseComposeServiceCandidates(`services:\n  web:\n    ports: ["8080:9000"]\n`);
    expect(candidates).toEqual([{ name: "web", port: 9000 }]);
  });

  it("service exposant seulement via 'expose:' (pas de port hôte publié) reste candidat", () => {
    const candidates = github.parseComposeServiceCandidates(`services:\n  internal:\n    expose: ["9090"]\n`);
    expect(candidates).toEqual([{ name: "internal", port: 9090 }]);
  });

  it("YAML invalide -> [] plutôt que de faire échouer la détection", () => {
    expect(github.parseComposeServiceCandidates("not: [valid: yaml: at: all")).toEqual([]);
  });
});

describe("Conflit de port docker-compose — détection et remap automatique", () => {
  it("parseFixedHostPort : syntaxe courte avec port hôte explicite", () => {
    expect(github.parseFixedHostPort("3000:3000")).toBe(3000);
    expect(github.parseFixedHostPort("127.0.0.1:8080:80")).toBe(8080);
    expect(github.parseFixedHostPort("8080:80/udp")).toBe(8080);
  });

  it("parseFixedHostPort : AUCUN port hôte explicite -> null (jamais un risque de conflit)", () => {
    expect(github.parseFixedHostPort("80")).toBeNull();
    expect(github.parseFixedHostPort("80/tcp")).toBeNull();
    expect(github.parseFixedHostPort({ target: 80 })).toBeNull();
  });

  it("parseFixedHostPort : syntaxe longue avec 'published'", () => {
    expect(github.parseFixedHostPort({ target: 80, published: 8080 })).toBe(8080);
  });

  it("rewriteComposePortsForConflicts : port déjà utilisé -> remplacé par un port libre, entrée reconstruite", () => {
    const doc: github.ComposeDoc = {
      services: {
        web: { ports: ["3000:3000"] },
        cache: { ports: ["6379:6379"] }, // libre : jamais touché
      },
    };
    const used = new Set([3000]); // ex: quai-dev-api-1 déjà sur 3000
    const remaps = github.rewriteComposePortsForConflicts(doc, used);

    expect(remaps).toHaveLength(1);
    expect(remaps[0]?.service).toBe("web");
    expect(remaps[0]?.oldHostPort).toBe(3000);
    expect(remaps[0]?.newHostPort).not.toBe(3000);
    expect(remaps[0]?.newHostPort).toBeGreaterThanOrEqual(20000);

    // Le port conteneur (3000) est conservé, seul le port hôte change.
    expect(doc.services!.web!.ports).toEqual([`${remaps[0]!.newHostPort}:3000`]);
    // Le service sans conflit n'est jamais réécrit.
    expect(doc.services!.cache!.ports).toEqual(["6379:6379"]);
  });

  it("rewriteComposePortsForConflicts : aucun conflit -> [] et le doc n'est pas modifié", () => {
    const doc: github.ComposeDoc = { services: { web: { ports: ["3000:3000"] } } };
    const remaps = github.rewriteComposePortsForConflicts(doc, new Set([9999]));
    expect(remaps).toEqual([]);
    expect(doc.services!.web!.ports).toEqual(["3000:3000"]);
  });

  it("rewriteComposePortsForConflicts : deux services en conflit sur le MÊME port -> deux ports de remplacement DISTINCTS", () => {
    const doc: github.ComposeDoc = {
      services: {
        a: { ports: ["8080:80"] },
        b: { ports: ["8080:81"] }, // même port hôte fixé par erreur dans le repo tiers
      },
    };
    const remaps = github.rewriteComposePortsForConflicts(doc, new Set([8080]));
    expect(remaps).toHaveLength(2);
    expect(remaps[0]?.newHostPort).not.toBe(remaps[1]?.newHostPort);
  });

  it("pickFreeHostPort : ne choisit jamais un port déjà dans `used`", () => {
    const used = new Set<number>();
    for (let i = 20000; i < 20050; i++) used.add(i); // sature une petite plage
    const picked = github.pickFreeHostPort(used);
    expect(used.has(picked)).toBe(false);
    expect(picked).toBeGreaterThanOrEqual(20000);
    expect(picked).toBeLessThanOrEqual(59999);
  });
});

describe("isSafeRelativeConfigPath — garde-fou contre la traversion de chemin (configPath client)", () => {
  it("accepte la racine (vide) et un sous-dossier simple/imbriqué", () => {
    expect(github.isSafeRelativeConfigPath("")).toBe(true);
    expect(github.isSafeRelativeConfigPath("docker")).toBe(true);
    expect(github.isSafeRelativeConfigPath("apps/api")).toBe(true);
  });

  it("rejette une tentative de traversée de répertoire (..) ou un chemin absolu", () => {
    expect(github.isSafeRelativeConfigPath("../../etc")).toBe(false);
    expect(github.isSafeRelativeConfigPath("docker/../../etc")).toBe(false);
    expect(github.isSafeRelativeConfigPath("/etc/passwd")).toBe(false);
    expect(github.isSafeRelativeConfigPath("C:\\Windows")).toBe(false);
  });
});

describe("detectRepo — parcours borné de sous-dossiers (racine vide uniquement)", () => {
  it("racine avec un Dockerfile -> résolu directement, aucun appel de parcours de sous-dossiers", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents?ref=main")) {
        return jsonResponse(200, [{ name: "Dockerfile", type: "file", path: "Dockerfile" }]);
      }
      if (u.includes("/contents/Dockerfile")) return jsonResponse(200, { content: Buffer.from("FROM node\nEXPOSE 8080\n").toString("base64"), encoding: "base64" });
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detection = await github.detectRepo("acme", "demo", "main");
    expect(detection.hasDockerfile).toBe(true);
    expect(detection.detectedPath).toBeUndefined();
    expect(detection.exposedPort).toBe(8080);
  });

  it("racine vide, UN SEUL sous-dossier candidat (docker/) -> résolu automatiquement avec detectedPath", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents?ref=main")) {
        return jsonResponse(200, [
          { name: "docker", type: "dir", path: "docker" },
          { name: "src", type: "dir", path: "src" },
          { name: "README.md", type: "file", path: "README.md" },
        ]);
      }
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents/docker?ref=main")) {
        return jsonResponse(200, [{ name: "docker-compose.yml", type: "file", path: "docker/docker-compose.yml" }]);
      }
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents/src?ref=main")) {
        return jsonResponse(200, [{ name: "index.js", type: "file", path: "src/index.js" }]);
      }
      if (u.includes("/contents/docker/docker-compose.yml")) {
        return jsonResponse(200, { content: Buffer.from("services:\n  web:\n    ports: [\"3000:3000\"]\n").toString("base64"), encoding: "base64" });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detection = await github.detectRepo("acme", "demo", "main");
    expect(detection.hasCompose).toBe(true);
    expect(detection.detectedPath).toBe("docker");
    expect(detection.composeServices).toEqual([{ name: "web", port: 3000 }]);
  });

  it("racine vide, PLUSIEURS sous-dossiers candidats -> aucun choisi automatiquement, tous remontés dans `candidates`", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents?ref=main")) {
        return jsonResponse(200, [
          { name: "docker", type: "dir", path: "docker" },
          { name: "deploy", type: "dir", path: "deploy" },
        ]);
      }
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents/docker?ref=main")) {
        return jsonResponse(200, [{ name: "Dockerfile", type: "file", path: "docker/Dockerfile" }]);
      }
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents/deploy?ref=main")) {
        return jsonResponse(200, [{ name: "docker-compose.yml", type: "file", path: "deploy/docker-compose.yml" }]);
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detection = await github.detectRepo("acme", "demo", "main");
    expect(detection.hasDockerfile).toBe(false);
    expect(detection.hasCompose).toBe(false);
    expect(detection.candidates?.map((c) => c.path).sort()).toEqual(["deploy", "docker"]);
  });

  it("racine et sous-dossiers vides -> résumé honnête 'rien détecté', jamais de candidat fabriqué", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents?ref=main")) {
        return jsonResponse(200, [{ name: "README.md", type: "file", path: "README.md" }]);
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detection = await github.detectRepo("acme", "demo", "main");
    expect(detection).toMatchObject({ hasDockerfile: false, hasCompose: false, hasTerraform: false, hasAnsible: false, terraformFiles: [] });
    expect(detection.candidates).toBeUndefined();
  });

  it("explicitPath fourni -> détecte DIRECTEMENT cet emplacement, sans parcourir quoi que ce soit d'autre", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/acme/demo/contents/apps/api?ref=main")) {
        return jsonResponse(200, [{ name: "Dockerfile", type: "file", path: "apps/api/Dockerfile" }]);
      }
      if (u.includes("/contents/apps/api/Dockerfile")) {
        return jsonResponse(200, { content: Buffer.from("FROM node\n").toString("base64"), encoding: "base64" });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detection = await github.detectRepo("acme", "demo", "main", "apps/api");
    expect(detection.hasDockerfile).toBe(true);
    expect(detection.detectedPath).toBe("apps/api");
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 listing + 1 lecture Dockerfile, jamais un scan racine
  });
});
