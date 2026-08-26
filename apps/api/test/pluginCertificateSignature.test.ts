import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * SIGNATURE DE MODULE PAR CERTIFICAT (AD CS) — plugins/package.ts.
 *
 * Rien n'est simulé : une hiérarchie racine → émettrice est fabriquée avec l'openssl du conteneur
 * (comme certificates.test.ts), les certificats de signature sont de VRAIS X.509, et les paquets
 * sont signés par l'outil hors ligne RÉEL du dépôt (scripts/sign-plugin.mjs). L'autorité réelle de
 * la mairie n'est jamais sollicitée.
 *
 * Ce que ces tests protègent : l'autorité décide qui peut habiliter du code. Un certificat qui n'en
 * vient pas, qui a expiré, qui ne porte pas l'usage « signature de code » ou qui a été retiré ne
 * charge rien — et un signataire tiers ne peut pas se faire passer pour l'image.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-cert-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDir, { recursive: true });

const caDir = path.join(tmpDir, "ca");
fsSync.mkdirSync(caDir, { recursive: true });
const caFile = (name: string): string => path.join(caDir, name);
const openssl = (args: string[]): void => {
  execFileSync("openssl", args, { stdio: "pipe" });
};

const ROOT_CN = "Mairie Le Creusot Root CA";
const SIGNER_CN = "BANAS Yann (signature de code)";

fsSync.writeFileSync(caFile("ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
fsSync.writeFileSync(
  caFile("code.ext"),
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n",
);
// Certificat de serveur : parfaitement valide, mais pour TLS — il n'habilite aucun code.
fsSync.writeFileSync(
  caFile("tls.ext"),
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,serverAuth\n",
);

openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caFile("root.key"), "-out", caFile("root.crt"), "-days", "3650", "-nodes", "-subj", `/CN=${ROOT_CN}`]);
openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile("int.key"), "-out", caFile("int.csr"), "-nodes", "-subj", "/CN=Mairie Le Creusot Issuing CA"]);
openssl(["x509", "-req", "-in", caFile("int.csr"), "-CA", caFile("root.crt"), "-CAkey", caFile("root.key"), "-days", "1825", "-extfile", caFile("ca.ext"), "-out", caFile("int.crt")]);

/** Autorité SANS aucun rapport : ses porteurs ne doivent rien pouvoir installer ici. */
openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caFile("autre-root.key"), "-out", caFile("autre-root.crt"), "-days", "3650", "-nodes", "-subj", "/CN=Autorite Etrangere"]);

/** Émet une feuille signée par l'émettrice interne, avec l'extension et la durée demandées. */
function issueLeaf(name: string, subject: string, ext: string, days: number): void {
  openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile(`${name}.key`), "-out", caFile(`${name}.csr`), "-nodes", "-subj", subject]);
  openssl([
    "x509", "-req", "-in", caFile(`${name}.csr`),
    "-CA", caFile("int.crt"), "-CAkey", caFile("int.key"),
    "-days", String(days), "-extfile", caFile(ext), "-out", caFile(`${name}.crt`),
  ]);
  // La chaîne livrée avec le paquet : feuille puis émettrice, la racine restant chez le serveur.
  fsSync.writeFileSync(
    caFile(`${name}-chain.pem`),
    fsSync.readFileSync(caFile(`${name}.crt`), "utf-8") + fsSync.readFileSync(caFile("int.crt"), "utf-8"),
  );
}

issueLeaf("signataire", `/CN=${SIGNER_CN}`, "code.ext", 365);
issueLeaf("serveur", "/CN=quai.lecreusot.priv", "tls.ext", 365);
issueLeaf("bientot-perime", "/CN=Signataire temporaire", "code.ext", 1);

/** Feuille de signature de code émise par l'autorité ÉTRANGÈRE, chaîne comprise. */
openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile("intrus.key"), "-out", caFile("intrus.csr"), "-nodes", "-subj", "/CN=Intrus"]);
openssl(["x509", "-req", "-in", caFile("intrus.csr"), "-CA", caFile("autre-root.crt"), "-CAkey", caFile("autre-root.key"), "-days", "365", "-extfile", caFile("code.ext"), "-out", caFile("intrus.crt")]);
fsSync.writeFileSync(caFile("intrus-chain.pem"), fsSync.readFileSync(caFile("intrus.crt"), "utf-8"));

const ROOT_PEM = fsSync.readFileSync(caFile("root.crt"), "utf-8");

// La configuration lit l'environnement à l'import : l'autorité doit y être AVANT.
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "9".repeat(64);
process.env.PLUGIN_TRUSTED_CA = ROOT_PEM;
process.env.PLUGIN_REVOKED_CERTS = "";

const { verifyPluginPackage } = await import("../src/plugins/package.js");
const { certificateTrust, isPluginInstallAvailable, trustedKeyIds } = await import("../src/plugins/installed.js");

const signerPath = fileURLToPath(new URL("../../../scripts/sign-plugin.mjs", import.meta.url));

const MODULE_SOURCE = `export const monGreffon = {
  manifest: {
    id: "supervision",
    name: "Supervision",
    version: "1.0.0",
    coreApi: "^1.0",
    configSchema: { type: "object", properties: {} },
    secretFields: [],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  },
  async test() { return { ok: true, message: "ne contacte rien" }; },
  async snapshot() { return { moduleId: "supervision", generatedAt: "", status: "ready", summary: [], entities: [], relations: [] }; },
};
`;

let packageCounter = 0;

/** Répertoire du dernier paquet signé — l'outil hors ligne se vérifie sur un répertoire. */
let lastPackageDir = "";

/** Prépare un paquet et le fait signer par l'outil RÉEL, avec le certificat demandé. */
function signPackage(certificateFile: string, keyFile: string): Map<string, Buffer> {
  packageCounter += 1;
  const dir = path.join(tmpDir, `paquet-${packageCounter}`);
  lastPackageDir = dir;
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, "index.mjs"), MODULE_SOURCE, "utf-8");
  fsSync.writeFileSync(
    path.join(dir, "quai-plugin.json"),
    JSON.stringify({ id: "supervision", name: "Supervision", version: "1.0.0", entry: "index.mjs", exportName: "monGreffon" }, null, 2),
    "utf-8",
  );
  // L'enveloppe est écrite HORS du paquet : déposée dedans, elle deviendrait un fichier non signé.
  execFileSync(
    process.execPath,
    [
      signerPath, "sign", dir,
      "--key", caFile(keyFile),
      "--cert", caFile(certificateFile),
      "--out", path.join(tmpDir, `enveloppe-${packageCounter}.json`),
    ],
    { stdio: "pipe" },
  );

  const files = new Map<string, Buffer>();
  for (const name of fsSync.readdirSync(dir)) files.set(name, fsSync.readFileSync(path.join(dir, name)));
  return files;
}

/** Ce que le signataire produit avec un certificat valide — réutilisé par plusieurs cas. */
const validPackage = signPackage("signataire-chain.pem", "signataire.key");
const validPackageDir = lastPackageDir;

const TRUST = { anchors: [ROOT_PEM], revoked: [] as string[] };

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("un certificat délivré par l'autorité interne habilite un module", () => {
  it("accepte le paquet, nomme le signataire et rattache la confiance à l'AUTORITÉ", () => {
    const result = verifyPluginPackage(validPackage, {}, TRUST);

    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.verified.manifest.id).toBe("supervision");
    // L'identité vient du certificat : c'est ce que la clé nue ne sait pas dire.
    expect(result.verified.signer).toBe(SIGNER_CN);
    expect(result.verified.keyId).toBe(`x509:${ROOT_CN}`);
    expect(result.verified.certificateFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("l'autorité configurée est annoncée comme confiance disponible, sans sortir son certificat", () => {
    expect(trustedKeyIds()).toEqual([`x509:${ROOT_CN}`]);
    expect(isPluginInstallAvailable()).toBe(true);
    expect(certificateTrust().anchors).toHaveLength(1);
    expect(JSON.stringify(trustedKeyIds())).not.toContain("BEGIN CERTIFICATE");
  });

  it("un signataire tiers ne peut pas se faire passer pour l'image, même en le réclamant", () => {
    const files = new Map(validPackage);
    const signature = JSON.parse(files.get("signature.json")!.toString("utf-8")) as Record<string, unknown>;
    signature.keyId = "quai-origin";
    files.set("signature.json", Buffer.from(`${JSON.stringify(signature, null, 2)}\n`, "utf-8"));

    const result = verifyPluginPackage(files, {}, TRUST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // L'identifiant de confiance est DÉRIVÉ de l'autorité : ce que le paquet annonce ne compte pas.
    expect(result.verified.keyId).toBe(`x509:${ROOT_CN}`);
  });

  it("modifier un fichier après signature casse la vérification, comme pour une clé nue", () => {
    const files = new Map(validPackage);
    files.set("index.mjs", Buffer.from(`${MODULE_SOURCE}// ajout après signature\n`, "utf-8"));

    const result = verifyPluginPackage(files, {}, TRUST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("modifié après signature");
  });
});

describe("ce qu'une autorité ne couvre pas est refusé", () => {
  it("un certificat d'une AUTRE autorité ne charge rien", () => {
    const foreign = signPackage("intrus-chain.pem", "intrus.key");
    const result = verifyPluginPackage(foreign, {}, TRUST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("ne remonte à aucune autorité configurée");
  });

  it("un certificat de serveur, pourtant émis par la bonne autorité, n'habilite pas du code", () => {
    // Le cas qui compte : le certificat TLS d'un service interne traîne partout, il ne doit pas
    // suffire à faire exécuter du code dans ce processus.
    let refused = "";
    try {
      signPackage("serveur-chain.pem", "serveur.key");
    } catch (err) {
      refused = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(refused).toContain("signature de code");
  });

  it("un certificat expiré ne charge plus rien, même signé le jour où il était valide", () => {
    const shortLived = signPackage("bientot-perime-chain.pem", "bientot-perime.key");
    expect(verifyPluginPackage(shortLived, {}, TRUST).ok).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const result = verifyPluginPackage(shortLived, {}, TRUST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("n'est pas valide aujourd'hui");
  });

  it("un certificat retiré cesse d'être accepté, sans rien reconstruire", () => {
    const accepted = verifyPluginPackage(validPackage, {}, TRUST);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const revoked = verifyPluginPackage(validPackage, {}, {
      anchors: [ROOT_PEM],
      revoked: [accepted.verified.certificateFingerprint!],
    });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) return;
    expect(revoked.reason).toContain("a été retiré");
  });

  it("sans autorité configurée, un paquet signé par certificat est refusé et le dit", () => {
    const result = verifyPluginPackage(validPackage, { "une-cle": "aW52YWxpZGU=" }, { anchors: [], revoked: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("aucune autorité de signature n'est configurée");
  });
});

describe("l'outil hors ligne rejoue exactement la vérification du serveur", () => {
  function runSigner(args: string[]): string {
    return execFileSync(process.execPath, [signerPath, ...args], { stdio: "pipe" }).toString("utf-8");
  }

  it("verify --ca accepte le paquet et nomme signataire et autorité", () => {
    const output = runSigner(["verify", validPackageDir, "--ca", caFile("root.crt")]);

    expect(output).toContain("Paquet vérifié");
    expect(output).toContain(SIGNER_CN);
    expect(output).toContain(ROOT_CN);
  });

  it("verify --ca refuse un paquet d'une autre autorité, avant toute livraison", () => {
    const foreignDir = path.join(tmpDir, `paquet-etranger`);
    fsSync.mkdirSync(foreignDir, { recursive: true });
    for (const [name, content] of signPackage("intrus-chain.pem", "intrus.key")) {
      fsSync.writeFileSync(path.join(foreignDir, name), content);
    }

    let refused = "";
    try {
      runSigner(["verify", foreignDir, "--ca", caFile("root.crt")]);
    } catch (err) {
      refused = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(refused).toContain("ne remonte à aucune autorité");
  });
});
