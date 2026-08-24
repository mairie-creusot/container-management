import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Intégration Certificats (AD CS) — services/certificates.ts + certificatesReconciler.ts +
 * routes/certificates.ts + intégration TLS dans reverseProxy.ts.
 *
 * AUCUN test ne touche l'autorité réelle de la mairie (son adresse et ses identifiants ne sont pas
 * connus et ne doivent jamais être devinés) : une autorité à deux niveaux (racine + émettrice, la
 * hiérarchie AD CS usuelle) est fabriquée ICI avec l'openssl du conteneur, et le site d'inscription
 * web `certsrv` est simulé par un mock de node:https reproduisant les formes établies par la
 * recherche :
 *  - POST certfnsh.asp (Mode=newreq, CertRequest, CertAttrib="CertificateTemplate:<modèle>") puis
 *    page de succès contenant `certnew.cer?ReqID=<n>&` — magnuswatn/certsrv, certsrv.py.
 *  - GET certnew.cer?ReqID=<n>&Enc=b64 -> certificat PEM ; GET certnew.p7b -> chaîne PKCS#7.
 *  - Refus signalé par `The disposition message is "..."`, attente par `Certificate Pending`.
 * Les certificats produits sont de VRAIS X.509 signés : le service les parse réellement.
 */
const tmpDataDir = path.join(os.tmpdir(), `quai-api-test-certs-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDataDir, { recursive: true });
const tmpConfigPath = path.join(tmpDataDir, "config.json");
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CERTIFICATES_PATH = path.join(tmpDataDir, "certificates.json");
process.env.REVERSE_PROXY_PATH = path.join(tmpDataDir, "reverse-proxy.json");
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

// --- Autorité de certification de test (racine -> émettrice -> feuille) ------------------------

const caDir = path.join(tmpDataDir, "ca");
fsSync.mkdirSync(caDir, { recursive: true });
const caFile = (name: string): string => path.join(caDir, name);
const openssl = (args: string[]): void => {
  execFileSync("openssl", args, { stdio: "pipe" });
};

fsSync.writeFileSync(caFile("int.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caFile("root.key"), "-out", caFile("root.crt"), "-days", "3650", "-nodes", "-subj", "/CN=Mairie Le Creusot Root CA"]);
openssl(["req", "-new", "-newkey", "rsa:2048", "-keyout", caFile("int.key"), "-out", caFile("int.csr"), "-nodes", "-subj", "/CN=Mairie Le Creusot Issuing CA"]);
openssl(["x509", "-req", "-in", caFile("int.csr"), "-CA", caFile("root.crt"), "-CAkey", caFile("root.key"), "-days", "1825", "-extfile", caFile("int.ext"), "-out", caFile("int.crt")]);
openssl(["crl2pkcs7", "-nocrl", "-certfile", caFile("int.crt"), "-certfile", caFile("root.crt"), "-outform", "DER", "-out", caFile("chain.p7b")]);

const CA_URL = "https://ca.lecreusot.priv/certsrv";
const CA_USERNAME = "svc-quai";
const CA_PASSWORD = "mot-de-passe-tres-secret-adcs";
const TEMPLATE = "WebServer";

// Compte de l'annuaire (LDAP) : c'est lui qui doit servir par défaut, sans compte dédié.
const LDAP_BIND_DN = "CN=svc-annuaire,OU=Informatique,OU=ville-du-Creusot,DC=lecreusot,DC=priv";
const LDAP_BIND_PASSWORD = "mot-de-passe-annuaire-tres-secret";
/** UPN implicite que le service doit dériver de LDAP_BIND_DN. */
const DIRECTORY_USERNAME = "svc-annuaire@lecreusot.priv";
/** DN dont le CN est un nom d'affichage : aucun identifiant Windows n'en est dérivable. */
const UNDERIVABLE_BIND_DN = "CN=Copieur NT,OU=Informatique,OU=ville-du-Creusot,DC=lecreusot,DC=priv";

let caReachable = true;
let nextValidityDays = 365;
let serveChain = true;
let denyReason: string | null = null;
let pendingApproval = false;
let signingCounter = 0;
let requestIdCounter = 0;
const issuedByRequestId = new Map<number, string>();
const seenCertAttribs: string[] = [];
/** Chaque tentative d'authentification vue par l'autorité simulée (acceptée ou non). */
const seenAccounts: { username: string; password: string }[] = [];
let acceptedAccounts = new Map<string, string>();

function signCsr(csrPem: string, days: number): string {
  signingCounter += 1;
  const csrPath = caFile(`req-${signingCounter}.csr`);
  const outPath = caFile(`leaf-${signingCounter}.crt`);
  fsSync.writeFileSync(csrPath, csrPem);
  openssl(["x509", "-req", "-in", csrPath, "-CA", caFile("int.crt"), "-CAkey", caFile("int.key"), "-days", String(days), "-copy_extensions", "copy", "-out", outPath]);
  return fsSync.readFileSync(outPath, "utf-8");
}

/** Décode l'en-tête Basic pour savoir QUEL compte a été présenté, accepté ou non. */
function decodeBasic(authorization: string | undefined): { username: string; password: string } | null {
  if (!authorization?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf-8");
  const separator = decoded.indexOf(":");
  return separator === -1
    ? { username: decoded, password: "" }
    : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function respond(target: URL, method: string, body: string, authorization: string | undefined): { status: number; payload: Buffer | string } {
  const presented = decodeBasic(authorization);
  if (presented) seenAccounts.push(presented);
  if (!presented || acceptedAccounts.get(presented.username) !== presented.password) {
    return { status: 401, payload: "<html><body>401 - Unauthorized: Access is denied due to invalid credentials.</body></html>" };
  }
  const route = `${method} ${target.pathname}`;
  if (route === "GET /certsrv/certrqxt.asp") {
    return { status: 200, payload: "<html><body>Submit a Certificate Request or Renewal Request</body></html>" };
  }
  if (route === "POST /certsrv/certfnsh.asp") {
    const params = new URLSearchParams(body);
    seenCertAttribs.push(params.get("CertAttrib") ?? "");
    if (denyReason) {
      return { status: 200, payload: `<html><body>The disposition message is "${denyReason}"</body></html>` };
    }
    if (pendingApproval) {
      requestIdCounter += 1;
      return { status: 200, payload: `<html><body>Certificate Pending<br>Your Request Id is ${requestIdCounter}.</body></html>` };
    }
    const certificate = signCsr(params.get("CertRequest") ?? "", nextValidityDays);
    requestIdCounter += 1;
    issuedByRequestId.set(requestIdCounter, certificate);
    return {
      status: 200,
      payload: `<html><body><a href="certnew.cer?ReqID=${requestIdCounter}&amp;Enc=b64">Download certificate</a></body></html>`,
    };
  }
  if (route === "GET /certsrv/certnew.cer") {
    const id = Number(target.searchParams.get("ReqID"));
    return { status: 200, payload: issuedByRequestId.get(id) ?? "" };
  }
  if (route === "GET /certsrv/certnew.p7b") {
    if (!serveChain) return { status: 404, payload: "" };
    return { status: 200, payload: fsSync.readFileSync(caFile("chain.p7b")) };
  }
  return { status: 404, payload: "" };
}

vi.mock("node:https", () => ({
  request: (
    target: URL,
    options: { method?: string; headers?: Record<string, string> },
    callback: (res: EventEmitter & { statusCode: number }) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { write: (chunk: unknown) => void; end: () => void; destroy: () => void };
    let body = "";
    req.write = (chunk: unknown) => {
      body += String(chunk);
    };
    req.destroy = () => {};
    req.end = () => {
      if (!caReachable) {
        req.emit("error", new Error("connect ECONNREFUSED 10.20.0.9:443"));
        return;
      }
      const { status, payload } = respond(target, options.method ?? "GET", body, options.headers?.Authorization);
      const res = Object.assign(new EventEmitter(), { statusCode: status });
      callback(res);
      res.emit("data", Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      res.emit("end");
    };
    return req;
  },
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setCertificatesConfig, clearCertificatesConfig, setLdapConfig } = await import("../src/services/setupStore.js");
const {
  buildCertificateSigningRequest,
  describeEnrollmentAccount,
  extractCertificatesFromPkcs7,
  getCertificatesStatus,
  getServableCertificates,
  issueCertificate,
  resetCertificatesCache,
  resolveEnrollmentAccount,
  scrubSecrets,
  windowsIdentifierFromBindDn,
} = await import("../src/services/certificates.js");
const { runCertificatesReconcileCycle, planCertificateWork } = await import("../src/services/certificatesReconciler.js");
const { buildDesiredCaddyConfig, createRoute, deleteRoute, listRoutes } = await import("../src/services/reverseProxy.js");

afterAll(async () => {
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

beforeEach(async () => {
  caReachable = true;
  nextValidityDays = 365;
  serveChain = true;
  denyReason = null;
  pendingApproval = false;
  seenCertAttribs.length = 0;
  seenAccounts.length = 0;
  // Les deux comptes sont acceptés par défaut : chaque test choisit lequel doit servir.
  acceptedAccounts = new Map([
    [CA_USERNAME, CA_PASSWORD],
    [DIRECTORY_USERNAME, LDAP_BIND_PASSWORD],
  ]);
  await seedLdapConfig();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  // Via l'API réelle : reverseProxy.ts garde un cache mémoire que supprimer le fichier ne vide pas.
  for (const route of await listRoutes()) await deleteRoute(route.id);
  await clearCertificatesConfig();
  await fs.rm(path.join(tmpDataDir, "certificates.json"), { force: true });
  resetCertificatesCache();
  vi.unstubAllGlobals();
});

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function operatorCookie() {
  const token = signSessionToken({ username: "op", displayName: "Operator", roles: ["operator"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

/** Compte dédié explicite — le mode historique, qui doit rester prioritaire. */
async function seedCertificatesConfig(overrides: Partial<Parameters<typeof setCertificatesConfig>[0]> = {}): Promise<void> {
  await setCertificatesConfig({
    caUrl: CA_URL,
    method: "certsrv",
    template: TEMPLATE,
    accountSource: "dedicated",
    username: CA_USERNAME,
    password: CA_PASSWORD,
    ...overrides,
  });
}

/** Aucun compte dédié : l'inscription doit retomber sur le compte de l'annuaire. */
async function seedDirectoryOnlyCertificatesConfig(
  overrides: Partial<Parameters<typeof setCertificatesConfig>[0]> = {},
): Promise<void> {
  await setCertificatesConfig({ caUrl: CA_URL, method: "certsrv", template: TEMPLATE, ...overrides });
}

interface AuditEventLine {
  actor: string;
  method: string;
  path: string;
  ok: boolean;
}

/** plugins/audit.ts écrit dans le dossier de CONFIG_PATH (voir auditLog.ts#resolvedAuditLogPath). */
async function readAuditEvents(): Promise<AuditEventLine[]> {
  try {
    const raw = await fs.readFile(path.join(tmpDataDir, "audit-log.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as AuditEventLine);
  } catch {
    return [];
  }
}

/** Le hook onResponse s'exécute APRÈS la résolution d'inject() : attente bornée, pas un sleep fixe. */
async function waitForAuditEvent(predicate: (event: AuditEventLine) => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readAuditEvents()).some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function seedLdapConfig(bindDn: string = LDAP_BIND_DN, bindPassword: string = LDAP_BIND_PASSWORD): Promise<void> {
  await setLdapConfig({
    url: "ldap://dc.lecreusot.priv:389",
    bindDn,
    bindPassword,
    searchBase: "DC=lecreusot,DC=priv",
    searchFilter: "(sAMAccountName={{username}})",
    groupRoleMap: {},
    defaultRole: "viewer",
  });
}

// ------------------------------------------------------------------------------------------

describe("CSR PKCS#10 généré en pur Node", () => {
  it("est un CSR valide, signé, portant le CN et les SAN demandés (vérifié par openssl réel)", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const csr = buildCertificateSigningRequest("monapp.lecreusot.priv", ["monapp.lecreusot.priv", "alias.lecreusot.priv"], privateKey, publicKey);

    const csrPath = caFile("verify.csr");
    fsSync.writeFileSync(csrPath, csr);
    const text = execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-verify", "-text"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

    expect(text).toContain("CN = monapp.lecreusot.priv");
    expect(text).toContain("DNS:monapp.lecreusot.priv");
    expect(text).toContain("DNS:alias.lecreusot.priv");
    expect(text).toContain("sha256WithRSAEncryption");
  });

  it("extrait les certificats d'une chaîne PKCS#7 réelle", () => {
    const certificates = extractCertificatesFromPkcs7(fsSync.readFileSync(caFile("chain.p7b")));
    expect(certificates).toHaveLength(2);
    expect(certificates.map((certificate) => certificate.subject).sort()).toEqual([
      "CN=Mairie Le Creusot Issuing CA",
      "CN=Mairie Le Creusot Root CA",
    ]);
  });
});

describe("Routes Certificats — autorisation", () => {
  it("401 sans session", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/certificates" });
    expect(response.statusCode).toBe(401);
  });

  it("lecture autorisée à un viewer, configuration réservée aux admins", async () => {
    app = buildServer();
    expect((await app.inject({ method: "GET", url: "/api/certificates", cookies: viewerCookie() })).statusCode).toBe(200);

    const asViewer = await app.inject({ method: "PUT", url: "/api/certificates/config", cookies: viewerCookie(), payload: {} });
    expect(asViewer.statusCode).toBe(403);

    const asOperator = await app.inject({ method: "PUT", url: "/api/certificates/config", cookies: operatorCookie(), payload: {} });
    expect(asOperator.statusCode).toBe(403);
    expect(asOperator.json()).toEqual({ error: "Insufficient role: admin required" });
  });
});

describe("Configuration AD CS — test réel avant persistance, chiffrement au repos", () => {
  it("refuse d'enregistrer une configuration dont l'autorité rejette les identifiants", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, username: CA_USERNAME, password: "mauvais-mot-de-passe" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("401");
    expect((await app.inject({ method: "GET", url: "/api/certificates/config", cookies: adminCookie() })).json()).toEqual({ configured: false });
  });

  it("enregistre après test réussi, chiffre le mot de passe au repos et ne le renvoie jamais", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, username: CA_USERNAME, password: CA_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(CA_PASSWORD);
    expect(response.json().config).toMatchObject({ caUrl: CA_URL, template: TEMPLATE, username: CA_USERNAME, method: "certsrv" });

    const raw = await fs.readFile(tmpConfigPath, "utf-8");
    expect(raw).not.toContain(CA_PASSWORD);
    const onDisk = JSON.parse(raw) as { certificates?: { password?: string } };
    expect(onDisk.certificates?.password).toMatch(/^enc:v1:/);
  });

  it("un mot de passe vide conserve celui déjà enregistré", async () => {
    await seedCertificatesConfig();
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: "WebServerV2", username: CA_USERNAME, password: "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().config.template).toBe("WebServerV2");
  });
});

describe("Compte présenté à l'autorité — annuaire par défaut, compte dédié prioritaire", () => {
  it("ne dérive un identifiant Windows du bindDn que lorsque c'est certain", () => {
    expect(windowsIdentifierFromBindDn(LDAP_BIND_DN)).toMatchObject({ ok: true, username: DIRECTORY_USERNAME });
    expect(windowsIdentifierFromBindDn("LECREUSOT\\svc-quai")).toMatchObject({ ok: true, username: "LECREUSOT\\svc-quai" });
    expect(windowsIdentifierFromBindDn("svc-quai@lecreusot.priv")).toMatchObject({ ok: true, username: "svc-quai@lecreusot.priv" });

    // Un CN avec espace est un nom d'affichage, pas un identifiant de connexion : on REFUSE de deviner.
    const refused = windowsIdentifierFromBindDn(UNDERIVABLE_BIND_DN);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("CN=Copieur NT");
    expect(windowsIdentifierFromBindDn("CN=svcquai,OU=Informatique").ok).toBe(false);
    expect(windowsIdentifierFromBindDn("").ok).toBe(false);
  });

  it("sans compte dédié configuré, s'inscrit avec le compte de l'annuaire", async () => {
    await seedDirectoryOnlyCertificatesConfig();
    await issueCertificate("monapp.lecreusot.priv");

    expect(seenAccounts.map((account) => account.username)).toContain(DIRECTORY_USERNAME);
    expect(seenAccounts.every((account) => account.username !== CA_USERNAME)).toBe(true);
    expect(seenAccounts.every((account) => account.password === LDAP_BIND_PASSWORD)).toBe(true);
  });

  it("le compte dédié est prioritaire dès qu'il est renseigné", async () => {
    await seedCertificatesConfig();
    await issueCertificate("monapp.lecreusot.priv");

    expect(seenAccounts.map((account) => account.username)).toContain(CA_USERNAME);
    expect(seenAccounts.every((account) => account.username !== DIRECTORY_USERNAME)).toBe(true);
  });

  it("l'identifiant Windows saisi pour le compte de l'annuaire l'emporte sur la dérivation", async () => {
    await seedLdapConfig(UNDERIVABLE_BIND_DN);
    acceptedAccounts.set("LECREUSOT\\copieurnt", LDAP_BIND_PASSWORD);
    await seedDirectoryOnlyCertificatesConfig({ username: "LECREUSOT\\copieurnt" });

    await issueCertificate("monapp.lecreusot.priv");
    expect(seenAccounts.map((account) => account.username)).toContain("LECREUSOT\\copieurnt");
  });

  it("refuse SANS aucun appel réseau quand le DN de l'annuaire ne donne pas d'identifiant Windows", async () => {
    await seedLdapConfig(UNDERIVABLE_BIND_DN);
    await seedDirectoryOnlyCertificatesConfig();
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    // Problème de CONFIGURATION (400), pas un échec de l'autorité (502).
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("CN=Copieur NT");
    expect(response.json().error).toContain("compte dédié");
    expect(seenAccounts).toHaveLength(0);
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);
  });

  it("expose le compte réellement utilisé, jamais son mot de passe", async () => {
    await seedDirectoryOnlyCertificatesConfig();
    app = buildServer();

    const status = await app.inject({ method: "GET", url: "/api/certificates", cookies: viewerCookie() });
    expect(status.json().account).toMatchObject({ source: "directory", username: DIRECTORY_USERNAME });
    expect(status.body).not.toContain(LDAP_BIND_PASSWORD);

    const configResponse = await app.inject({ method: "GET", url: "/api/certificates/config", cookies: adminCookie() });
    expect(configResponse.json().config).toMatchObject({
      accountSource: "directory",
      account: { source: "directory", username: DIRECTORY_USERNAME },
    });
    expect(configResponse.body).not.toContain(LDAP_BIND_PASSWORD);
  });

  it("describeEnrollmentAccount ne porte aucun mot de passe, resolveEnrollmentAccount le garde en interne", async () => {
    const view = await describeEnrollmentAccount({ caUrl: CA_URL, template: TEMPLATE });
    expect(view).toMatchObject({ source: "directory", username: DIRECTORY_USERNAME });
    expect(JSON.stringify(view)).not.toContain(LDAP_BIND_PASSWORD);

    const resolved = await resolveEnrollmentAccount({ caUrl: CA_URL, template: TEMPLATE });
    expect(resolved.password).toBe(LDAP_BIND_PASSWORD);
  });
});

describe("Refus de l'autorité — diagnostic distinct selon le compte essayé", () => {
  it("compte de l'annuaire refusé (401) : le message invite explicitement à renseigner un compte dédié", async () => {
    acceptedAccounts.delete(DIRECTORY_USERNAME);
    await seedDirectoryOnlyCertificatesConfig();
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    const error = response.json().error as string;
    expect(error).toContain("compte de l'annuaire");
    expect(error).toContain(DIRECTORY_USERNAME);
    expect(error).toContain("HTTP 401");
    expect(error).toContain("compte dédié");
    expect(error).toContain(TEMPLATE);
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);
  });

  it("compte dédié refusé (401) : on renvoie à ses identifiants, pas à la création d'un autre compte", async () => {
    acceptedAccounts.delete(CA_USERNAME);
    await seedCertificatesConfig();
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    const error = response.json().error as string;
    expect(error).toContain("compte dédié");
    expect(error).toContain("HTTP 401");
    expect(error).not.toContain("Renseignez un compte dédié");
    expect(response.body).not.toContain(CA_PASSWORD);
  });

  it("droits insuffisants sur le modèle : distingué d'un refus d'identifiants", async () => {
    await seedDirectoryOnlyCertificatesConfig();
    denyReason =
      "Denied by Policy Module 0x80094012, The permissions on the certificate template do not allow the current user to enroll for this type of certificate.";
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    const error = response.json().error as string;
    expect(error).toContain(`modèle « ${TEMPLATE} »`);
    expect(error).toContain("Inscrire");
    expect(error).toContain("compte de l'annuaire");
    expect(error).not.toContain("HTTP 401");
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);
  });

  it("autorité injoignable : ni « identifiants refusés », ni « droits », et aucun secret", async () => {
    await seedDirectoryOnlyCertificatesConfig();
    caReachable = false;
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    const error = response.json().error as string;
    expect(error).toContain("injoignable");
    expect(error).not.toContain("401");
    expect(error).not.toContain("Inscrire");
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);
  });
});

describe("Configuration — le compte de l'annuaire ne réclame aucun identifiant", () => {
  it("PUT sans identifiant ni mot de passe enregistre et utilise le compte de l'annuaire", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, accountSource: "directory" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().config).toMatchObject({
      accountSource: "directory",
      account: { source: "directory", username: DIRECTORY_USERNAME },
    });
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);

    const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8")) as { certificates?: { password?: string } };
    expect(onDisk.certificates?.password).toBeUndefined();
  });

  it("repasser au compte de l'annuaire efface le mot de passe dédié du disque", async () => {
    await seedCertificatesConfig();
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, accountSource: "directory", username: "" },
    });
    expect(response.statusCode).toBe(200);

    const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8")) as {
      certificates?: { password?: string; username?: string };
    };
    expect(onDisk.certificates?.password).toBeUndefined();
    expect(onDisk.certificates?.username).toBeUndefined();
  });

  it("le mode dédié exige toujours identifiant ET mot de passe", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, accountSource: "dedicated", username: CA_USERNAME },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("password");
  });

  it("un échec d'enregistrement joint le compte essayé, sans son mot de passe", async () => {
    acceptedAccounts.delete(DIRECTORY_USERNAME);
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/certificates/config",
      cookies: adminCookie(),
      payload: { caUrl: CA_URL, template: TEMPLATE, accountSource: "directory" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().account).toMatchObject({ source: "directory", username: DIRECTORY_USERNAME });
    expect(response.body).not.toContain(LDAP_BIND_PASSWORD);
    // Rien n'a été persisté.
    expect((await app.inject({ method: "GET", url: "/api/certificates/config", cookies: adminCookie() })).json()).toEqual({
      configured: false,
    });
  });
});

describe("Traçabilité — manuel audité, automatique resté système", () => {
  it("une émission manuelle est inscrite au journal d'audit avec son demandeur", async () => {
    await seedDirectoryOnlyCertificatesConfig();
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(200);

    const audited = await waitForAuditEvent(
      (event) => event.actor === "ybanas" && event.method === "POST" && event.path === "/api/certificates/issue" && event.ok,
    );
    expect(audited).toBe(true);
  });

  it("le renouvellement automatique n'invente aucun utilisateur", async () => {
    await seedDirectoryOnlyCertificatesConfig({ renewBeforeDays: 30 });
    nextValidityDays = 10; // dans la marge -> à renouveler au prochain cycle
    await issueCertificate("monapp.lecreusot.priv");

    // Laisse retomber un éventuel onResponse en vol du test précédent avant de figer le compteur.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = await readAuditEvents();
    nextValidityDays = 365;
    expect(await runCertificatesReconcileCycle()).toBe("renewed");
    expect(await readAuditEvents()).toHaveLength(before.length);
  });
});

describe("Émission réelle d'un certificat", () => {
  it("émet, parse et expose le certificat (émetteur, validité, jours restants)", async () => {
    await seedCertificatesConfig();
    nextValidityDays = 365;
    app = buildServer();

    const issue = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(issue.statusCode).toBe(200);

    const status = issue.json();
    expect(status.configured).toBe(true);
    expect(status.certificates).toHaveLength(1);
    const certificate = status.certificates[0];
    expect(certificate.subject).toBe("monapp.lecreusot.priv");
    expect(certificate.issuer).toContain("Mairie Le Creusot Issuing CA");
    expect(certificate.health).toBe("valid");
    expect(certificate.daysRemaining).toBeGreaterThan(300);
    expect(certificate.serialNumber).toBeTruthy();
    expect(new Date(certificate.notAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it("transmet le modèle de certificat demandé dans CertAttrib", async () => {
    await seedCertificatesConfig({ template: "MairieWebServer" });
    await issueCertificate("monapp.lecreusot.priv");
    expect(seenCertAttribs[0]).toBe("CertificateTemplate:MairieWebServer\r\n");
  });

  it("remonte un refus de l'autorité en 502 sans jamais divulguer le mot de passe", async () => {
    await seedCertificatesConfig();
    denyReason = "Denied by Policy Module: the template is not permitted";
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "refuse.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("Denied by Policy Module");
    expect(response.body).not.toContain(CA_PASSWORD);
  });

  it("signale explicitement une demande laissée en attente d'approbation", async () => {
    await seedCertificatesConfig();
    pendingApproval = true;
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "attente.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("EN ATTENTE");
  });

  it("ne fait fuiter ni la clé privée ni les identifiants dans une réponse d'API", async () => {
    await seedCertificatesConfig();
    await issueCertificate("monapp.lecreusot.priv");
    app = buildServer();

    const status = await app.inject({ method: "GET", url: "/api/certificates", cookies: viewerCookie() });
    expect(status.body).not.toContain("PRIVATE KEY");
    expect(status.body).not.toContain(CA_PASSWORD);

    const configResponse = await app.inject({ method: "GET", url: "/api/certificates/config", cookies: adminCookie() });
    expect(configResponse.body).not.toContain(CA_PASSWORD);
    expect(configResponse.body).not.toContain("PRIVATE KEY");
  });

  it("chiffre la clé privée au repos — jamais de PEM en clair sur disque", async () => {
    await seedCertificatesConfig();
    await issueCertificate("monapp.lecreusot.priv");

    const raw = await fs.readFile(path.join(tmpDataDir, "certificates.json"), "utf-8");
    expect(raw).not.toContain("BEGIN PRIVATE KEY");
    const onDisk = JSON.parse(raw) as { privateKeyPem: string }[];
    expect(onDisk[0]!.privateKeyPem).toMatch(/^enc:v1:/);
    // Le certificat lui-même est public : il reste lisible.
    expect(raw).toContain("BEGIN CERTIFICATE");
  });

  it("scrubSecrets retire un secret répété par l'amont", () => {
    expect(scrubSecrets(`echec pour ${CA_PASSWORD} ici`, [CA_PASSWORD])).toBe("echec pour *** ici");
  });
});

describe("Intégration Caddy — AD CS remplace l'autorité interne pour le seul sujet concerné", () => {
  it("sans AD CS configuré : aucune régression, tout reste sur l'autorité interne", async () => {
    await createRoute({ subdomain: "interne.lecreusot.priv", targetHost: "10.1.2.3", targetPort: 8080 });

    const desired = await buildDesiredCaddyConfig();
    expect(desired.adcsSubjects).toEqual([]);
    expect(desired.body.apps.tls.certificates).toBeUndefined();
    expect(desired.body.apps.tls.automation?.policies[0]).toEqual({
      subjects: ["localhost", "interne.lecreusot.priv"],
      issuers: [{ module: "internal" }],
    });
  });

  it("un sujet avec certificat AD CS passe en load_pem et sort des subjects de l'autorité interne", async () => {
    await seedCertificatesConfig();
    await createRoute({ subdomain: "monapp.lecreusot.priv", targetHost: "10.1.2.3", targetPort: 8080 });
    await createRoute({ subdomain: "autre.lecreusot.priv", targetHost: "10.1.2.4", targetPort: 8080 });
    await issueCertificate("monapp.lecreusot.priv");

    const desired = await buildDesiredCaddyConfig();
    expect(desired.adcsSubjects).toEqual(["monapp.lecreusot.priv"]);
    expect(desired.body.apps.tls.certificates?.load_pem).toHaveLength(1);
    expect(desired.body.apps.tls.certificates?.load_pem[0]!.certificate).toContain("BEGIN CERTIFICATE");
    expect(desired.body.apps.tls.certificates?.load_pem[0]!.key).toContain("BEGIN PRIVATE KEY");
    // Les sujets sans certificat AD CS gardent EXACTEMENT le comportement précédent.
    expect(desired.body.apps.tls.automation?.policies[0]!.subjects).toEqual(["localhost", "autre.lecreusot.priv"]);
    expect(desired.body.apps.tls.automation?.policies[0]!.issuers).toEqual([{ module: "internal" }]);
  });

  it("joint la chaîne de l'autorité émettrice (hors racine auto-signée) au certificat servi", async () => {
    await seedCertificatesConfig();
    await issueCertificate("monapp.lecreusot.priv");

    const servable = await getServableCertificates();
    expect(servable).toHaveLength(1);
    const chunks = servable[0]!.certificatePem.match(/BEGIN CERTIFICATE/g) ?? [];
    expect(chunks).toHaveLength(2); // feuille + émettrice, jamais la racine auto-signée
  });

  it("un certificat expiré n'est plus servi : le sujet retombe sur l'autorité interne", async () => {
    await seedCertificatesConfig();
    await createRoute({ subdomain: "monapp.lecreusot.priv", targetHost: "10.1.2.3", targetPort: 8080 });
    nextValidityDays = -1;
    await issueCertificate("monapp.lecreusot.priv");

    expect(await getServableCertificates()).toEqual([]);
    const desired = await buildDesiredCaddyConfig();
    expect(desired.adcsSubjects).toEqual([]);
    expect(desired.body.apps.tls.automation?.policies[0]!.subjects).toContain("monapp.lecreusot.priv");

    // ... mais il reste VISIBLE et signalé comme expiré, jamais masqué.
    const status = await getCertificatesStatus();
    expect(status.certificates[0]!.health).toBe("expired");
    expect(status.certificates[0]!.daysRemaining).toBeLessThan(0);
  });
});

describe("Renouvellement automatique", () => {
  it("planCertificateWork : renouvellements dus + première émission des sous-domaines sans certificat", () => {
    expect(planCertificateWork(["a.priv", "b.priv"], ["a.priv"], ["a.priv"], true)).toEqual(["a.priv", "b.priv"]);
    // Émission automatique désactivée : seuls les renouvellements dus sont planifiés.
    expect(planCertificateWork(["a.priv", "b.priv"], ["a.priv"], ["a.priv"], false)).toEqual(["a.priv"]);
    expect(planCertificateWork(["a.priv"], ["a.priv"], [], true)).toEqual([]);
  });

  it("renouvelle un certificat qui entre dans la fenêtre de marge (nouveau numéro de série)", async () => {
    await seedCertificatesConfig({ renewBeforeDays: 30 });
    nextValidityDays = 10; // dans la marge de 30 jours -> à renouveler
    const first = await issueCertificate("monapp.lecreusot.priv");

    nextValidityDays = 365;
    const outcome = await runCertificatesReconcileCycle();
    expect(outcome).toBe("renewed");

    const status = await getCertificatesStatus();
    expect(status.certificates).toHaveLength(1);
    expect(status.certificates[0]!.serialNumber).not.toBe(first.serialNumber);
    expect(status.certificates[0]!.health).toBe("valid");
    expect(status.certificates[0]!.daysRemaining).toBeGreaterThan(300);
  });

  it("ne touche à rien quand aucun certificat n'arrive à échéance", async () => {
    await seedCertificatesConfig({ renewBeforeDays: 30, autoEnroll: false });
    nextValidityDays = 365;
    const first = await issueCertificate("monapp.lecreusot.priv");

    expect(await runCertificatesReconcileCycle()).toBe("nothing-to-do");
    const status = await getCertificatesStatus();
    expect(status.certificates[0]!.serialNumber).toBe(first.serialNumber);
  });

  it("émet automatiquement pour un sous-domaine du reverse proxy qui n'a pas encore de certificat", async () => {
    await seedCertificatesConfig();
    await createRoute({ subdomain: "nouveau.lecreusot.priv", targetHost: "10.1.2.9", targetPort: 8080 });

    expect(await runCertificatesReconcileCycle()).toBe("renewed");
    const status = await getCertificatesStatus();
    expect(status.certificates.map((certificate) => certificate.subject)).toEqual(["nouveau.lecreusot.priv"]);
  });

  it("ne fait AUCUN appel réseau quand AD CS n'est pas configuré", async () => {
    await createRoute({ subdomain: "interne.lecreusot.priv", targetHost: "10.1.2.3", targetPort: 8080 });
    expect(await runCertificatesReconcileCycle()).toBe("not-configured");
    expect(await getServableCertificates()).toEqual([]);
  });
});

describe("Autorité injoignable — on ne casse JAMAIS TLS", () => {
  it("conserve et sert le certificat existant, et affiche l'échec sans le masquer", async () => {
    await seedCertificatesConfig({ renewBeforeDays: 30 });
    await createRoute({ subdomain: "monapp.lecreusot.priv", targetHost: "10.1.2.3", targetPort: 8080 });
    nextValidityDays = 10; // à renouveler
    const first = await issueCertificate("monapp.lecreusot.priv");

    caReachable = false;
    expect(await runCertificatesReconcileCycle()).toBe("partial-failure");

    // Le certificat existant est INTACT et toujours servi par Caddy.
    const servable = await getServableCertificates();
    expect(servable.map((certificate) => certificate.subject)).toEqual(["monapp.lecreusot.priv"]);
    const desired = await buildDesiredCaddyConfig();
    expect(desired.adcsSubjects).toEqual(["monapp.lecreusot.priv"]);

    const status = await getCertificatesStatus();
    expect(status.certificates[0]!.serialNumber).toBe(first.serialNumber);
    expect(status.certificates[0]!.lastRenewalError).toContain("injoignable");
    expect(status.certificates[0]!.lastRenewalAttemptAt).toBeTruthy();
  });

  it("l'échec remonté par l'API ne contient jamais le mot de passe du compte de service", async () => {
    await seedCertificatesConfig();
    caReachable = false;
    app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/certificates/issue",
      cookies: adminCookie(),
      payload: { subject: "monapp.lecreusot.priv" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(CA_PASSWORD);
    expect(response.json().error).toContain("injoignable");
  });
});
