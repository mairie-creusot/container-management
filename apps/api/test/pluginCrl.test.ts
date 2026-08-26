import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * RÉVOCATION des certificats de signature de module — plugins/crl.ts.
 *
 * Les listes utilisées ici sont de VRAIES CRL, produites par `openssl ca -gencrl` à partir d'une
 * autorité fabriquée pour ce test, avec un certificat réellement révoqué dans sa base. Rien n'est
 * simulé : c'est le lecteur DER du dépôt qui les analyse et la signature qui décide de leur origine.
 *
 * Ce que ces tests protègent : « aucune liste ne couvre ce certificat » ne doit jamais se confondre
 * avec « ce certificat est sain », et une liste périmée ou signée par quelqu'un d'autre ne compte
 * pas. La politique stricte doit, elle, refuser ce qu'elle ne peut pas vérifier.
 */
const tmpDir = path.join(os.tmpdir(), `quai-plugin-crl-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const caDir = path.join(tmpDir, "ca");
const crlDir = path.join(tmpDir, "crl");
fsSync.mkdirSync(path.join(caDir, "newcerts"), { recursive: true });
fsSync.mkdirSync(crlDir, { recursive: true });

const caFile = (name: string): string => path.join(caDir, name);
const openssl = (args: string[]): void => {
  execFileSync("openssl", args, { stdio: "pipe" });
};

const ROOT_CN = "CRL Test Root CA";

fsSync.writeFileSync(caFile("ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
fsSync.writeFileSync(
  caFile("code.ext"),
  "[ v3_code ]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n",
);
fsSync.writeFileSync(
  caFile("ca.cnf"),
  `[ ca ]
default_ca = CA_default

[ CA_default ]
dir = ${caDir}
database = $dir/index.txt
crlnumber = $dir/crlnumber
serial = $dir/serial
new_certs_dir = $dir/newcerts
certificate = $dir/int.crt
private_key = $dir/int.key
default_md = sha256
default_crl_days = 30
unique_subject = no
policy = policy_any

[ policy_any ]
commonName = optional
countryName = optional
stateOrProvinceName = optional
organizationName = optional
organizationalUnitName = optional
emailAddress = optional
`,
);
fsSync.writeFileSync(caFile("index.txt"), "");
fsSync.writeFileSync(caFile("crlnumber"), "01\n");
fsSync.writeFileSync(caFile("serial"), "01\n");

openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caFile("root.key"), "-out", caFile("root.crt"), "-days", "3650", "-nodes", "-subj", `/CN=${ROOT_CN}`]);
openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile("int.key"), "-out", caFile("int.csr"), "-nodes", "-subj", "/CN=CRL Test Issuing CA"]);
openssl(["x509", "-req", "-in", caFile("int.csr"), "-CA", caFile("root.crt"), "-CAkey", caFile("root.key"), "-days", "1825", "-extfile", caFile("ca.ext"), "-out", caFile("int.crt")]);

/** Émise PAR L'ÉMETTRICE via `openssl ca` : elle entre ainsi dans sa base, seule façon de la révoquer. */
function issueThroughCa(name: string, subject: string): void {
  openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile(`${name}.key`), "-out", caFile(`${name}.csr`), "-nodes", "-subj", subject]);
  openssl([
    "ca", "-config", caFile("ca.cnf"), "-batch", "-days", "365",
    "-extfile", caFile("code.ext"), "-extensions", "v3_code",
    "-in", caFile(`${name}.csr`), "-out", caFile(`${name}.crt`),
  ]);
  fsSync.writeFileSync(
    caFile(`${name}-chain.pem`),
    fsSync.readFileSync(caFile(`${name}.crt`), "utf-8") + fsSync.readFileSync(caFile("int.crt"), "utf-8"),
  );
}

issueThroughCa("revoque", "/CN=Signataire revoque");
issueThroughCa("valide", "/CN=Signataire valide");

/** Autorité étrangère : sa CRL ne doit rien pouvoir dire des certificats de la nôtre. */
openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caFile("autre.key"), "-out", caFile("autre.crt"), "-days", "3650", "-nodes", "-subj", "/CN=Autorite Etrangere"]);

// Révocation RÉELLE, puis publication de la liste.
openssl(["ca", "-config", caFile("ca.cnf"), "-batch", "-revoke", caFile("revoque.crt")]);
openssl(["ca", "-config", caFile("ca.cnf"), "-batch", "-gencrl", "-out", caFile("liste.crl")]);

const ROOT_PEM = fsSync.readFileSync(caFile("root.crt"), "utf-8");
const CRL_PEM = fsSync.readFileSync(caFile("liste.crl"));

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "4".repeat(64);
process.env.PLUGIN_TRUSTED_CA = ROOT_PEM;

const { verifyPluginPackage } = await import("../src/plugins/package.js");
const { checkRevocation, crlSignedBy, loadCrls, parseCrl, pemToDer, resetCrlCacheForTests } = await import("../src/plugins/crl.js");

const signerPath = fileURLToPath(new URL("../../../scripts/sign-plugin.mjs", import.meta.url));

const MODULE_SOURCE = `export const monGreffon = {
  manifest: { id: "supervision", name: "Supervision", version: "1.0.0", coreApi: "^1.0", configSchema: { type: "object", properties: {} }, secretFields: [], permissions: { network: [], mutates: false }, auditLabels: {} },
  async test() { return { ok: true, message: "ne contacte rien" }; },
  async snapshot() { return { moduleId: "supervision", generatedAt: "", status: "ready", summary: [], entities: [], relations: [] }; },
};
`;

let counter = 0;

function signPackage(certificateFile: string, keyFile: string): Map<string, Buffer> {
  counter += 1;
  const dir = path.join(tmpDir, `paquet-${counter}`);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, "index.mjs"), MODULE_SOURCE, "utf-8");
  fsSync.writeFileSync(
    path.join(dir, "quai-plugin.json"),
    JSON.stringify({ id: "supervision", name: "Supervision", version: "1.0.0", entry: "index.mjs", exportName: "monGreffon" }, null, 2),
    "utf-8",
  );
  execFileSync(
    process.execPath,
    [signerPath, "sign", dir, "--key", caFile(keyFile), "--cert", caFile(certificateFile), "--out", path.join(tmpDir, `env-${counter}.json`)],
    { stdio: "pipe" },
  );
  const files = new Map<string, Buffer>();
  for (const name of fsSync.readdirSync(dir)) files.set(name, fsSync.readFileSync(path.join(dir, name)));
  return files;
}

const revokedPackage = signPackage("revoque-chain.pem", "revoque.key");
const validPackage = signPackage("valide-chain.pem", "valide.key");

/** Les CRL telles que le socle les lira, chargées depuis un répertoire réel. */
function crlsFromDisk(files: Record<string, Buffer>) {
  resetCrlCacheForTests();
  for (const name of fsSync.readdirSync(crlDir)) fsSync.rmSync(path.join(crlDir, name));
  for (const [name, content] of Object.entries(files)) fsSync.writeFileSync(path.join(crlDir, name), content);
  return loadCrls(crlDir);
}

function trustWith(crls: ReturnType<typeof crlsFromDisk>["crls"], crlPolicy: "off" | "soft" | "strict" = "soft") {
  return { anchors: [ROOT_PEM], revoked: [] as string[], crls, crlPolicy };
}

afterEach(() => {
  vi.useRealTimers();
  resetCrlCacheForTests();
});

afterAll(() => {
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("lecture d'une vraie CRL", () => {
  it("y trouve le numéro de série réellement révoqué, et la date de publication", () => {
    const parsed = parseCrl(pemToDer(CRL_PEM), "liste.crl");
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    if (!parsed.ok) return;

    const revokedSerial = new X509Certificate(fsSync.readFileSync(caFile("revoque.crt"))).serialNumber.replace(/^0+/, "").toLowerCase();
    expect(parsed.crl.revoked.has(revokedSerial)).toBe(true);
    expect(parsed.crl.thisUpdate.getTime()).toBeLessThanOrEqual(Date.now());
    expect(parsed.crl.nextUpdate?.getTime()).toBeGreaterThan(Date.now());
  });

  it("la signature dit QUI l'a émise — aucun nom n'est comparé", () => {
    const parsed = parseCrl(pemToDer(CRL_PEM), "liste.crl");
    if (!parsed.ok) throw new Error(parsed.reason);

    const issuer = new X509Certificate(fsSync.readFileSync(caFile("int.crt")));
    const stranger = new X509Certificate(fsSync.readFileSync(caFile("autre.crt")));
    expect(crlSignedBy(parsed.crl, issuer.publicKey)).toBe(true);
    expect(crlSignedBy(parsed.crl, stranger.publicKey)).toBe(false);
  });

  it("un fichier qui n'est pas une CRL est refusé, jamais lu comme une liste vide", () => {
    const parsed = parseCrl(Buffer.from("<html>404</html>", "utf-8"), "erreur.html");
    expect(parsed.ok).toBe(false);

    const loaded = crlsFromDisk({ "erreur.crl": Buffer.from("<html>404</html>", "utf-8"), "liste.crl": CRL_PEM });
    expect(loaded.crls).toHaveLength(1);
    expect(loaded.rejected.map((entry) => entry.source)).toEqual(["erreur.crl"]);
  });
});

describe("un certificat révoqué ne charge plus rien", () => {
  it("le paquet est refusé, avec la liste et sa date dans le motif", () => {
    const { crls } = crlsFromDisk({ "liste.crl": CRL_PEM });
    const result = verifyPluginPackage(revokedPackage, {}, trustWith(crls));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("révoqué par l'autorité");
    expect(result.reason).toContain("liste.crl");
  });

  it("le certificat NON révoqué de la même autorité reste accepté, et se dit vérifié", () => {
    const { crls } = crlsFromDisk({ "liste.crl": CRL_PEM });
    const result = verifyPluginPackage(validPackage, {}, trustWith(crls));

    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.verified.revocation?.state).toBe("clear");
  });

  it("politique « off » : la liste n'est pas consultée, même présente", () => {
    const { crls } = crlsFromDisk({ "liste.crl": CRL_PEM });
    const result = verifyPluginPackage(revokedPackage, {}, trustWith(crls, "off"));
    expect(result.ok).toBe(true);
  });
});

describe("ce qu'une liste ne couvre pas n'est pas réputé sain", () => {
  it("aucune liste disponible : l'état est « inconnu », et le paquet passe en mode souple", () => {
    const { crls } = crlsFromDisk({});
    const result = verifyPluginPackage(validPackage, {}, trustWith(crls));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified.revocation?.state).toBe("unknown");
  });

  it("une liste que l'émetteur du certificat n'a pas signée ne le couvre pas", () => {
    // Même liste, mais confrontée à un certificat dont l'émetteur est une AUTRE autorité : la
    // signature ne correspond pas, donc la liste ne dit rien de lui — « inconnu », pas « sain ».
    const { crls } = crlsFromDisk({ "liste.crl": CRL_PEM });
    const verdict = checkRevocation(
      [new X509Certificate(fsSync.readFileSync(caFile("revoque.crt")))],
      [new X509Certificate(fsSync.readFileSync(caFile("autre.crt")))],
      crls,
      new Date(),
    );
    expect(verdict.state).toBe("unknown");
  });

  it("une liste périmée ne compte pas : souple laisse passer, strict refuse", () => {
    const { crls } = crlsFromDisk({ "liste.crl": CRL_PEM });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));

    const soft = verifyPluginPackage(revokedPackage, {}, trustWith(crls, "soft"));
    expect(soft.ok).toBe(true);
    if (soft.ok) expect(soft.verified.revocation?.state).toBe("unknown");

    const strict = verifyPluginPackage(revokedPackage, {}, trustWith(crls, "strict"));
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.reason).toContain("périmée");
  });

  it("mode strict sans aucune liste : rien ne se charge, et le motif le dit", () => {
    const { crls } = crlsFromDisk({});
    const result = verifyPluginPackage(validPackage, {}, trustWith(crls, "strict"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Révocation invérifiable");
    expect(result.reason).toContain("mode strict");
  });
});
