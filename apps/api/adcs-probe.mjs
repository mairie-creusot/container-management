// Découverte EN LECTURE SEULE de l'autorité AD CS publiée dans l'annuaire (partition Configuration).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/workspace/apps/api/");
const ldap = require("ldapjs");

const cfg = JSON.parse(readFileSync("/workspace/apps/api/data/config.json", "utf8")).ldap;
const { decryptSecret } = await import("/workspace/apps/api/dist/services/setupStore.js").catch(() => ({}));

// Le mot de passe est chiffré au repos : on passe par le service pour le déchiffrer, jamais affiché.
const store = await import("/workspace/apps/api/src/services/setupStore.js").catch(() => null);
let bindPassword = null;
if (store?.getEffectiveLdapConfig) {
  const eff = await store.getEffectiveLdapConfig();
  bindPassword = eff.bindPassword;
}
if (!bindPassword) {
  console.log("Impossible de déchiffrer le mot de passe du compte de service ici — sonde abandonnée.");
  process.exit(0);
}

const client = ldap.createClient({ url: cfg.url, timeout: 10000, connectTimeout: 10000 });
await new Promise((res, rej) => client.bind(cfg.bindDn, bindPassword, (e) => (e ? rej(e) : res())));

function search(base, filter, attributes) {
  return new Promise((resolve, reject) => {
    const rows = [];
    client.search(base, { scope: "sub", filter, attributes }, (err, r) => {
      if (err) return reject(err);
      r.on("searchEntry", (e) => rows.push(e.pojo ?? e.object));
      r.on("error", (e) => (e.name === "NoSuchObjectError" ? resolve([]) : reject(e)));
      r.on("end", () => resolve(rows));
    });
  });
}

const configNc = "CN=Configuration,DC=lecreusot,DC=priv";
const pki = `CN=Public Key Services,CN=Services,${configNc}`;

const cas = await search(`CN=Enrollment Services,${pki}`, "(objectClass=pKIEnrollmentService)", [
  "cn",
  "dNSHostName",
  "certificateTemplates",
]);
console.log("=== Autorités de certification publiées ===");
for (const ca of cas) {
  const attrs = Object.fromEntries((ca.attributes ?? []).map((a) => [a.type, a.values]));
  console.log("  CA :", attrs.cn?.[0], "| hôte :", attrs.dNSHostName?.[0]);
  console.log("  modèles publiés :", (attrs.certificateTemplates ?? []).join(", ") || "(aucun)");
}
if (cas.length === 0) console.log("  aucune (le compte de service peut ne pas avoir le droit de lire cette partition)");

client.unbind();
