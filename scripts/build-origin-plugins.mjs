#!/usr/bin/env node
/**
 * Empaquetage des intégrations livrées avec QUAI en PAQUETS D'ORIGINE signés, pendant la
 * construction de l'image (deploy/docker/Dockerfile.api).
 *
 * La paire de clés Ed25519 est générée pour CE build et n'est jamais écrite sur disque : seule la
 * clé publique part dans l'image (origin-key.pub), la clé privée disparaît avec ce processus.
 * L'image est donc cohérente avec elle-même — elle n'accepte que les paquets qu'elle a produits — et
 * il n'y a aucun secret à conserver ni à faire tourner.
 *
 *   node scripts/build-origin-plugins.mjs --dist <dist compilé> --host-root <chemin d'exécution> --out <répertoire>
 *
 * Chaque paquet contient un module ESM d'une ligne qui réexporte le greffon depuis le code de
 * l'application (`--host-root`) : les intégrations partagent l'état des services du socle (jeton 3CX
 * unique, caches de sondage), ce qu'un bundle autonome dupliquerait. Ce qui change, c'est leur CYCLE
 * DE VIE : plus aucun import statique, une installation, une désactivation et une désinstallation
 * réelles. Nom et version viennent du manifeste RÉEL du greffon, lu dans le code compilé.
 */

import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_FORMAT = "quai-plugin/1";
const MANIFEST_NAME = "quai-plugin.json";
const SIGNATURE_NAME = "signature.json";
const ENTRY_NAME = "index.mjs";
const PUBLIC_KEY_NAME = "origin-key.pub";
/** Doit correspondre à PLUGIN_ORIGIN_KEY_ID de apps/api/src/config.ts. */
const ORIGIN_KEY_ID = "quai-origin";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function fail(message) {
  console.error(`Erreur : ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[token.slice(2)] = true;
    } else {
      options[token.slice(2)] = next;
      index += 1;
    }
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim().length === 0) fail(`--${name} est obligatoire.`);
  return value.trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * URL `file:` du module de l'application tel qu'il sera vu À L'EXÉCUTION — jamais le chemin de
 * build. `pathToFileURL` résoudrait un chemin POSIX contre le lecteur courant sous Windows : la
 * forme est donc construite explicitement.
 */
function hostModuleUrl(hostRoot, dir) {
  const normalized = hostRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = /^[A-Za-z]:\//.test(normalized) ? "file:///" : "file://";
  return `${prefix}${normalized}/plugins/${dir}/index.js`.replace(/ /g, "%20");
}

/**
 * Le shim est un chemin écrit en dur : sans cette vérification, un répertoire mal deviné produit un
 * paquet parfaitement signé qui échoue à l'`import()` à l'exécution — l'intégration disparaît alors
 * de l'interface sans que rien n'ait échoué au build (cas réel de 3CX, dont le module vit dans
 * `threecx/`). On importe donc ICI le module exact que le shim visera, par le même chemin relatif,
 * et on exige qu'il exporte bien ce greffon.
 */
async function loadThroughShimPath(dist, dir, exportName, id) {
  const target = path.join(dist, "plugins", dir, "index.js");
  try {
    await fs.access(target);
  } catch {
    fail(`Le paquet d'origine "${id}" viserait ${target}, qui n'existe pas : corrigez "hostDir" dans plugins/builtins.ts.`);
  }
  let module;
  try {
    module = await import(pathToFileURL(target).href);
  } catch (err) {
    fail(`Le module visé par le paquet d'origine "${id}" (${target}) ne se charge pas : ${err.message}`);
  }
  const exported = module[exportName];
  if (exported?.manifest?.id !== id) {
    fail(`${target} n'exporte pas "${exportName}" avec l'identifiant "${id}" : le paquet d'origine viserait le mauvais module.`);
  }
  return exported;
}

const options = parseArgs(process.argv.slice(2));
const dist = path.resolve(required(options, "dist"));
const hostRoot = required(options, "host-root");
const out = path.resolve(required(options, "out"));

const catalogPath = path.join(dist, "plugins", "builtins.js");
let catalog;
try {
  catalog = await import(pathToFileURL(catalogPath).href);
} catch (err) {
  fail(`Catalogue interne illisible (${catalogPath}) : ${err.message}`);
}
const builtins = catalog.BUILTIN_PLUGINS;
if (!Array.isArray(builtins) || builtins.length === 0) fail(`${catalogPath} n'exporte aucun greffon à empaqueter.`);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

for (const entry of builtins) {
  if (typeof entry?.id !== "string" || typeof entry?.exportName !== "string") fail("Entrée de catalogue interne inexploitable.");
  if (!IDENTIFIER.test(entry.exportName)) fail(`"${entry.exportName}" n'est pas un nom d'export JavaScript utilisable.`);

  // Le manifeste RÉEL du greffon, lu PAR LE CHEMIN QUE LE SHIM VISERA : aucune métadonnée n'est
  // recopiée à la main, et un paquet qui pointerait à côté fait échouer le build.
  // Répertoire du module DANS l'application — celui du greffon "3cx" s'appelle "threecx".
  const hostDir = typeof entry.hostDir === "string" && entry.hostDir.length > 0 ? entry.hostDir : entry.id;
  const plugin = await loadThroughShimPath(dist, hostDir, entry.exportName, entry.id);
  const manifest = plugin.manifest;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    fail(`Le manifeste du greffon "${entry.id}" n'a ni nom ni version exploitables.`);
  }

  const shim = Buffer.from(`export { ${entry.exportName} } from ${JSON.stringify(hostModuleUrl(hostRoot, hostDir))};\n`, "utf-8");
  const packageManifest = {
    format: PACKAGE_FORMAT,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entry: ENTRY_NAME,
    exportName: entry.exportName,
    files: { [ENTRY_NAME]: sha256(shim) },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf-8");
  const signature = edSign(null, manifestBytes, privateKey).toString("base64");
  // Vérification immédiate : un paquet que cette image refuserait ne doit jamais y entrer.
  if (!edVerify(null, manifestBytes, publicKey, Buffer.from(signature, "base64"))) fail(`Signature invalide pour "${entry.id}".`);

  const dir = path.join(out, entry.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ENTRY_NAME), shim);
  await fs.writeFile(path.join(dir, MANIFEST_NAME), manifestBytes);
  await fs.writeFile(
    path.join(dir, SIGNATURE_NAME),
    `${JSON.stringify({ algorithm: "ed25519", keyId: ORIGIN_KEY_ID, signature }, null, 2)}\n`,
    "utf-8",
  );

  console.log(`Paquet d'origine : ${manifest.id} ${manifest.version} — ${manifest.name}`);
}

await fs.writeFile(path.join(out, PUBLIC_KEY_NAME), `${publicBase64}\n`, "utf-8");
console.log(`Clé publique d'origine écrite : ${path.join(out, PUBLIC_KEY_NAME)} (clé privée jamais écrite, perdue avec ce build)`);
