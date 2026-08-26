#!/usr/bin/env node
/**
 * Outil de signature HORS LIGNE des modules distribuables QUAI.
 *
 * À exécuter sur le poste de l'éditeur du module, JAMAIS sur le serveur : le serveur ne connaît que
 * des clés PUBLIQUES (PLUGIN_TRUSTED_KEYS) et ne sait que vérifier. Aucune clé privée n'a sa place
 * sur une machine qui exécute l'API.
 *
 *   node scripts/sign-plugin.mjs keygen --out ./quai-signing
 *       Crée quai-signing.key (clé privée Ed25519, PKCS8 PEM, 0600) et affiche la ligne
 *       PLUGIN_TRUSTED_KEYS à poser sur le serveur.
 *
 *   node scripts/sign-plugin.mjs sign <dossier> --key ./quai-signing.key --key-id mairie-2026
 *       Calcule l'empreinte SHA-256 de chaque fichier, écrit quai-plugin.json (manifeste de paquet)
 *       et signature.json dans le dossier, puis produit l'enveloppe de transport
 *       <id>-<version>.quaipkg.json à envoyer à POST /api/plugins/installed.
 *
 *   node scripts/sign-plugin.mjs verify <dossier|enveloppe.json> --keys '{"mairie-2026":"..."}'
 *       Rejoue la vérification exactement comme le serveur, avant de livrer.
 *
 * Le dossier source doit contenir un quai-plugin.json de départ portant id, name, version, entry et
 * exportName ; `sign` y ajoute `format` et `files` puis le réécrit — c'est CE fichier, octet pour
 * octet, qui est signé.
 */

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PACKAGE_FORMAT = "quai-plugin/1";
const MANIFEST_NAME = "quai-plugin.json";
const SIGNATURE_NAME = "signature.json";
const INSTALL_MARK_NAME = ".quai-install.json";
const RESERVED = new Set([SIGNATURE_NAME, INSTALL_MARK_NAME]);
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function fail(message) {
  console.error(`Erreur : ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        options[name] = true;
      } else {
        options[name] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readPackageDir(dir) {
  const files = new Map();
  const walk = async (current, prefix) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        files.set(relative, await fs.readFile(path.join(current, entry.name)));
      }
    }
  };
  await walk(dir, "");
  return files;
}

function publicKeyBase64(keyLike) {
  return createPublicKey(keyLike).export({ format: "der", type: "spki" }).toString("base64");
}

async function keygen(options) {
  const out = typeof options.out === "string" ? options.out : "./quai-signing";
  const keyId = typeof options["key-id"] === "string" ? options["key-id"] : "ma-cle";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  const privatePath = path.resolve(`${out}.key`);
  await fs.writeFile(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const publicBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await fs.writeFile(path.resolve(`${out}.pub`), `${publicBase64}\n`, { mode: 0o644 });

  console.log(`Clé privée écrite : ${privatePath} (0600) — ne la copiez JAMAIS sur le serveur.`);
  console.log(`Clé publique      : ${path.resolve(`${out}.pub`)}`);
  console.log("");
  console.log("À poser sur le serveur, dans son environnement :");
  console.log(`PLUGIN_TRUSTED_KEYS={${JSON.stringify(keyId)}:${JSON.stringify(publicBase64)}}`);
}

async function sign(dir, options) {
  const keyPath = options.key;
  const keyId = options["key-id"];
  if (typeof keyPath !== "string") fail("--key <chemin de la clé privée> est obligatoire.");
  if (typeof keyId !== "string" || keyId.trim().length === 0) fail("--key-id <identifiant de la clé> est obligatoire.");

  const root = path.resolve(dir);
  const sourcePath = path.join(root, MANIFEST_NAME);
  let source;
  try {
    source = JSON.parse(await fs.readFile(sourcePath, "utf-8"));
  } catch (err) {
    fail(`${MANIFEST_NAME} illisible dans ${root} : ${err.message}`);
  }
  for (const field of ["id", "name", "version", "entry", "exportName"]) {
    if (typeof source[field] !== "string" || source[field].trim().length === 0) {
      fail(`${MANIFEST_NAME} : le champ "${field}" est obligatoire.`);
    }
  }

  // On repart des fichiers RÉELS du dossier, manifeste et signature exclus : ce sont eux qui sont
  // couverts par les empreintes.
  const present = await readPackageDir(root);
  const files = {};
  for (const [name, content] of [...present].sort(([a], [b]) => a.localeCompare(b))) {
    if (name === MANIFEST_NAME || RESERVED.has(name)) continue;
    if (!SAFE_PATH.test(name)) fail(`Chemin de fichier refusé : ${name}`);
    files[name] = sha256(content);
  }
  if (files[source.entry] === undefined) fail(`Le point d'entrée "${source.entry}" est absent du dossier.`);

  const manifest = {
    format: PACKAGE_FORMAT,
    id: source.id,
    name: source.name,
    version: source.version,
    entry: source.entry,
    exportName: source.exportName,
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const privateKey = createPrivateKey(await fs.readFile(keyPath, "utf-8"));
  if (privateKey.asymmetricKeyType !== "ed25519") fail("La clé privée doit être une clé Ed25519.");
  const signature = edSign(null, manifestBytes, privateKey).toString("base64");

  await fs.writeFile(sourcePath, manifestBytes);
  await fs.writeFile(
    path.join(root, SIGNATURE_NAME),
    `${JSON.stringify({ algorithm: "ed25519", keyId, signature }, null, 2)}\n`,
    "utf-8",
  );

  const envelope = { files: {} };
  for (const [name, content] of await readPackageDir(root)) {
    if (name === INSTALL_MARK_NAME) continue;
    envelope.files[name] = content.toString("base64");
  }
  const outPath = path.resolve(
    typeof options.out === "string" ? options.out : path.join(process.cwd(), `${manifest.id}-${manifest.version}.quaipkg.json`),
  );
  await fs.writeFile(outPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");

  console.log(`Paquet signé : ${manifest.id} ${manifest.version} (${Object.keys(files).length} fichier(s))`);
  console.log(`Clé          : ${keyId} — clé publique ${publicKeyBase64(privateKey)}`);
  console.log(`Enveloppe    : ${outPath}`);
}

/** Même chaîne de vérification que le serveur, en local, avant de livrer. */
async function verify(target, options) {
  const raw = options.keys;
  if (typeof raw !== "string") fail(`--keys '{"identifiant":"clé publique base64"}' est obligatoire.`);
  let trusted;
  try {
    trusted = JSON.parse(raw);
  } catch (err) {
    fail(`--keys n'est pas du JSON valide : ${err.message}`);
  }

  const resolved = path.resolve(target);
  const files = new Map();
  if ((await fs.stat(resolved)).isDirectory()) {
    for (const [name, content] of await readPackageDir(resolved)) files.set(name, content);
  } else {
    const envelope = JSON.parse(await fs.readFile(resolved, "utf-8"));
    for (const [name, encoded] of Object.entries(envelope.files ?? {})) files.set(name, Buffer.from(encoded, "base64"));
  }

  const manifestBytes = files.get(MANIFEST_NAME);
  if (!manifestBytes) fail(`${MANIFEST_NAME} absent.`);
  const signatureBytes = files.get(SIGNATURE_NAME);
  if (!signatureBytes) fail(`${SIGNATURE_NAME} absent : le paquet n'est pas signé.`);

  const signatureDoc = JSON.parse(signatureBytes.toString("utf-8"));
  if (signatureDoc.algorithm !== "ed25519") fail(`Algorithme non supporté : ${signatureDoc.algorithm}`);
  const material = trusted[signatureDoc.keyId];
  if (material === undefined) fail(`Clé inconnue : "${signatureDoc.keyId}".`);

  const publicKey = createPublicKey({ key: Buffer.from(material, "base64"), format: "der", type: "spki" });
  if (!edVerify(null, manifestBytes, publicKey, Buffer.from(signatureDoc.signature, "base64"))) {
    fail("Signature invalide.");
  }

  const manifest = JSON.parse(manifestBytes.toString("utf-8"));
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    const content = files.get(name);
    if (!content) fail(`Fichier signé absent : ${name}`);
    if (sha256(content) !== expected) fail(`Le fichier "${name}" ne correspond pas à son empreinte signée.`);
  }
  for (const name of files.keys()) {
    if (name === MANIFEST_NAME || RESERVED.has(name)) continue;
    if (manifest.files?.[name] === undefined) fail(`Fichier non signé dans le paquet : ${name}`);
  }

  console.log(`Paquet vérifié : ${manifest.id} ${manifest.version}, signé par "${signatureDoc.keyId}".`);
}

const { positional, options } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (command === "keygen") {
  await keygen(options);
} else if (command === "sign") {
  if (positional[1] === undefined) fail("Usage : sign <dossier> --key <clé> --key-id <identifiant>");
  await sign(positional[1], options);
} else if (command === "verify") {
  if (positional[1] === undefined) fail("Usage : verify <dossier|enveloppe.json> --keys '<json>'");
  await verify(positional[1], options);
} else {
  console.error("Usage : node scripts/sign-plugin.mjs <keygen|sign|verify> [...]");
  console.error("  keygen --out ./quai-signing [--key-id mairie-2026]");
  console.error("  sign <dossier> --key ./quai-signing.key --key-id mairie-2026 [--out paquet.json]");
  console.error(`  verify <dossier|enveloppe.json> --keys '{"mairie-2026":"<clé publique base64>"}'`);
  process.exit(1);
}
