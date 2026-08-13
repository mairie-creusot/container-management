import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePackageFiles, __testing } from "../src/services/packageInspector.js";

const execFileAsync = promisify(execFile);

// --- Disponibilité de docker (skip proprement si injoignable, même esprit que
// containerFilesHexdump.test.ts#dockerReachable) : ces tests ne doivent jamais faire échouer la
// suite dans un environnement sans Docker, mais DOIVENT s'exécuter réellement dès qu'un démon
// répond, comme demandé par la mission. ---
let dockerAvailable = false;
try {
  await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

// Images RÉELLEMENT déjà présentes localement au moment où ces tests ont été écrits (vérifié via
// `docker images`, jamais tirées pour ce test — voir le rapport de mission). `imageExistsLocally`
// re-vérifie à l'exécution : si l'une d'elles a été supprimée de l'environnement entre-temps, le
// test concerné se `skip` proprement (retour anticipé) plutôt que d'échouer à tort ou de tirer une
// nouvelle image en douce.
const APT_IMAGE = "node:22-slim"; // Debian slim officielle, dpkg réellement présent
const NPM_IMAGE = "pawchat-pawchat-app-dev:latest"; // /app/node_modules/sharp réel avec fichiers .js/.mjs

async function imageExistsLocally(ref: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", ref]);
    return true;
  } catch {
    return false;
  }
}

describe("packageInspector — parsing pur (aucun Docker requis)", () => {
  it("looksLikeGoModulePath reconnaît un chemin de module Go réel et rejette les noms npm/apt", () => {
    expect(__testing.looksLikeGoModulePath("github.com/klauspost/compress")).toBe(true);
    expect(__testing.looksLikeGoModulePath("github.com/aws/aws-sdk-go-v2/config")).toBe(true);
    expect(__testing.looksLikeGoModulePath("golang.org/x/net")).toBe(true);
    expect(__testing.looksLikeGoModulePath("k8s.io/client-go")).toBe(true);
    expect(__testing.looksLikeGoModulePath("gopkg.in/yaml.v3")).toBe(true);
    expect(__testing.looksLikeGoModulePath("lodash")).toBe(false);
    expect(__testing.looksLikeGoModulePath("@babel/core")).toBe(false);
    expect(__testing.looksLikeGoModulePath("openssl")).toBe(false);
    expect(__testing.looksLikeGoModulePath("glibc")).toBe(false);
  });

  it("parsePipShowOutput reconstruit les chemins absolus depuis Location: + Files:", () => {
    const output = [
      "Name: requests",
      "Version: 2.31.0",
      "Location: /usr/lib/python3/dist-packages",
      "Requires: charset-normalizer, idna",
      "Files:",
      "  requests/__init__.py",
      "  requests/api.py",
      "  requests-2.31.0.dist-info/METADATA",
    ];
    const { root, files } = __testing.parsePipShowOutput(output);
    expect(root).toBe("/usr/lib/python3/dist-packages");
    expect(files).toEqual([
      "/usr/lib/python3/dist-packages/requests/__init__.py",
      "/usr/lib/python3/dist-packages/requests/api.py",
      "/usr/lib/python3/dist-packages/requests-2.31.0.dist-info/METADATA",
    ]);
  });

  it("parsePipShowOutput renvoie [] sans planter quand pip ne liste aucun fichier (métapaquet)", () => {
    const { root, files } = __testing.parsePipShowOutput(["Name: meta-pkg", "Location: /usr/lib/python3"]);
    expect(root).toBe("/usr/lib/python3");
    expect(files).toEqual([]);
  });

  it("parseInspectionOutput reconnaît un succès apt (APT_OK) et remonte la liste de fichiers telle quelle", () => {
    const stdout = ["APT_OK openssl", "/usr/lib/ssl", "/usr/bin/openssl", "/etc/ssl/openssl.cnf"].join("\n");
    const result = __testing.parseInspectionOutput(stdout, "openssl", false);
    expect(result).toEqual({
      ecosystem: "apt",
      available: true,
      files: ["/usr/lib/ssl", "/usr/bin/openssl", "/etc/ssl/openssl.cnf"],
    });
  });

  it("parseInspectionOutput signale la résolution best-effort quand le nom apt résolu diffère du nom demandé", () => {
    const stdout = ["APT_OK libssl3", "/usr/lib/x86_64-linux-gnu/libssl.so.3"].join("\n");
    const result = __testing.parseInspectionOutput(stdout, "openssl", false);
    expect(result.ecosystem).toBe("apt");
    expect(result.available).toBe(true);
    expect(result.files).toEqual(["/usr/lib/x86_64-linux-gnu/libssl.so.3"]);
    // Le nom résolu ("libssl3") diffère du nom demandé ("openssl") -> reason doit le signaler
    // explicitement, jamais un résultat silencieux qui laisserait croire à une correspondance exacte.
    expect(result.reason).toEqual(expect.stringContaining("libssl3"));
    expect(result.reason).toEqual(expect.stringContaining("openssl"));
  });

  it("parseInspectionOutput retombe honnêtement sur available:false + raison Go quand rien n'est trouvé pour un chemin de module Go", () => {
    const stdout = ["APT_NOT_FOUND", "NPM_SKIPPED_GO_SHAPED", "PIP_NO_BIN", "NONE"].join("\n");
    const result = __testing.parseInspectionOutput(stdout, "github.com/klauspost/compress", true);
    expect(result.ecosystem).toBe("unknown");
    expect(result.available).toBe(false);
    expect(result.reason).toEqual(expect.stringContaining("module Go"));
    // Jamais de `files` fabriqué (ni [] qui laisserait croire à un paquet vide plutôt qu'à une
    // impossibilité technique) :
    expect(result.files).toBeUndefined();
  });

  it("parseInspectionOutput retombe sur le message générique (pas la formulation spécifique Go) pour un nom non-Go introuvable", () => {
    const stdout = ["APT_NO_DPKG", "NPM_NOT_FOUND", "PIP_NO_BIN", "NONE"].join("\n");
    const result = __testing.parseInspectionOutput(stdout, "some-totally-unknown-thing", false);
    expect(result.ecosystem).toBe("unknown");
    expect(result.available).toBe(false);
    // La formulation spécifique ("a la forme d'un chemin de module Go") ne doit apparaître QUE
    // pour goShaped=true — "module Go" seul n'est pas un bon distinguo : le message générique le
    // cite aussi, légitimement, comme UN exemple parmi d'autres écosystèmes compilés.
    expect(result.reason).not.toEqual(expect.stringContaining("a la forme d'un chemin de module Go"));
    expect(result.reason).toEqual(expect.stringContaining("Aucun fichier trouvé"));
  });

  it("resolvePackageFiles renvoie un résultat honnête immédiat pour un nom de paquet vide (aucun docker run)", async () => {
    const result = await resolvePackageFiles("nginx:1.27", "   ");
    expect(result).toEqual({ ecosystem: "unknown", available: false, reason: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------------------
// Vérification RÉELLE contre des images Docker déjà présentes localement (skip proprement si
// Docker est injoignable ou si l'image attendue a disparu de l'environnement — jamais de faux
// négatif, jamais de nouvelle image tirée en douce pour ce test).
// ---------------------------------------------------------------------------------------
describe.skipIf(!dockerAvailable)("packageInspector — inspection RÉELLE d'images Docker locales", () => {
  it("trouve les vrais fichiers apt/dpkg d'un nom de paquet Debian exact sur node:22-slim, identiques à `dpkg -L` en direct", async () => {
    if (!(await imageExistsLocally(APT_IMAGE))) return; // image absente de cet environnement -> pas de faux négatif

    const result = await resolvePackageFiles(APT_IMAGE, "libc6");
    expect(result.ecosystem).toBe("apt");
    expect(result.available).toBe(true);
    expect(result.files).toBeDefined();
    expect(result.files!.length).toBeGreaterThan(0);
    // Un paquet apt n'a pas de racine unique (fichiers dispersés sous /usr, /etc, /lib...).
    expect(result.packageRoot).toBeUndefined();

    // Comparaison RÉELLE, octet pour octet des chemins, avec `docker run --rm node:22-slim dpkg -L libc6`
    // lancé en direct ici — exactement la vérification demandée par la mission.
    const { stdout } = await execFileAsync("docker", ["run", "--rm", APT_IMAGE, "dpkg", "-L", "libc6"]);
    const expectedFiles = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(result.files).toEqual(expectedFiles);
  }, 30_000);

  it("résout un nom apt approximatif façon Grype (\"libc\") vers un vrai paquet Debian installé via le fallback dpkg -l | grep", async () => {
    if (!(await imageExistsLocally(APT_IMAGE))) return;

    const result = await resolvePackageFiles(APT_IMAGE, "libc");
    expect(result.ecosystem).toBe("apt");
    expect(result.available).toBe(true);
    expect(result.reason).toEqual(expect.stringContaining("Résolu vers le paquet Debian réel"));

    // Le nom résolu doit être un VRAI paquet installé contenant "libc" — recalculé dynamiquement ici
    // (jamais un nom supposé à l'avance : l'ordre de dpkg -l peut varier selon la version de l'image).
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      APT_IMAGE,
      "-c",
      `dpkg -l | awk '$1=="ii"{print $2}' | sed 's/:.*//' | grep -i libc | head -n 1`,
    ]);
    const expectedCandidate = stdout.trim();
    expect(expectedCandidate.length).toBeGreaterThan(0);
    expect(result.reason).toEqual(expect.stringContaining(expectedCandidate));
  }, 30_000);

  it("détecte honnêtement un vrai chemin de module Go comme available:false, sans jamais fabriquer de fichiers", async () => {
    if (!(await imageExistsLocally(APT_IMAGE))) return;

    const result = await resolvePackageFiles(APT_IMAGE, "github.com/klauspost/compress");
    expect(result.available).toBe(false);
    expect(result.ecosystem).toBe("unknown");
    expect(result.reason).toEqual(expect.stringContaining("module Go"));
    expect(result.files).toBeUndefined();
  }, 30_000);

  it("trouve les vrais fichiers npm d'un paquet réel (sharp) dans node_modules d'une image applicative", async () => {
    if (!(await imageExistsLocally(NPM_IMAGE))) return; // image absente de cet environnement -> pas de faux négatif

    const result = await resolvePackageFiles(NPM_IMAGE, "sharp");
    expect(result.ecosystem).toBe("npm");
    expect(result.available).toBe(true);
    expect(result.packageRoot).toEqual(expect.stringContaining("node_modules/sharp"));
    expect(result.files).toBeDefined();
    expect(result.files!.length).toBeGreaterThan(0);
    for (const file of result.files!) {
      expect(file).toMatch(/\.(js|mjs|ts)$/);
      expect(file.startsWith(result.packageRoot!)).toBe(true);
    }
  }, 30_000);
});
