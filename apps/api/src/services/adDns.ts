/**
 * DNS Active Directory : mise à jour dynamique SÉCURISÉE (RFC 2136, authentifiée par GSS-TSIG/
 * Kerberos) — quand une route de reverse proxy est créée/supprimée (voir reverseProxy.ts), QUAI
 * pousse/retire l'enregistrement DNS `A` correspondant dans le DNS intégré à l'AD de la mairie,
 * pour que le sous-domaine devienne réellement résolvable sur le réseau SANS entrée manuelle de
 * fichier hosts — exactement le mécanisme qu'utilisent nativement les clients Windows/DHCP pour
 * s'auto-enregistrer dans un DNS AD-intégré.
 *
 * QUAI ne réimplémente NI Kerberos NI le protocole DNS de mise à jour dynamique — deux VRAIS
 * binaires font tout le travail, en sous-processus (node:child_process), même philosophie que
 * OpenTofu/Ansible/Packer/Grype/OSV-Scanner déjà intégrés dans ce projet :
 *   1. `kinit` (paquet krb5-user) obtient un ticket Kerberos (TGT) pour le compte de service
 *      configuré, dans un cache de créances (ccache) et un `krb5.conf` TEMPORAIRES, propres à
 *      cet appel — jamais de credentials Kerberos partagés avec le reste du process.
 *   2. `nsupdate -g` (paquet bind9-dnsutils) authentifie la mise à jour dynamique avec CE ticket
 *      (GSS-TSIG) et l'envoie au serveur DNS (le contrôleur de domaine lui-même, `kdcHost`).
 *
 * Échec explicite, jamais avalé : un realm/KDC injoignable, un compte de service sans droit
 * "Dynamic Update" sur la zone, ou un mot de passe expiré font échouer kinit/nsupdate avec un
 * message clair (stderr relayé), jamais une fausse réussite. `pushDnsRecord`/`removeDnsRecord`
 * sont appelés en best-effort par reverseProxy.ts (ne bloquent jamais la création/suppression
 * d'une route côté QUAI) — leur résultat est simplement attaché à la route (`dnsSync`) pour que
 * l'utilisateur sache si la résolution DNS est réellement automatique ou s'il doit encore
 * l'appliquer manuellement.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { SetupAdDnsConfig } from "./setupStore.js";
import type { AdDnsSyncResult, AdDnsTestResult } from "../types.js";

/** Exécute `bin args…` avec `input` écrit sur stdin puis fermé — capture stdout+stderr, jamais
 * de shell (args passés en tableau, aucune interpolation). Résout toujours (même en échec) avec
 * le détail exploitable par l'appelant plutôt que de rejeter, pour distinguer proprement "le
 * binaire a tourné et a refusé" de "le binaire n'a pas pu être lancé du tout" (ENOENT — paquet
 * krb5-user/bind9-dnsutils manquant dans l'image, voir deploy/docker/Dockerfile.api). */
function runWithStdin(
  bin: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

interface KerberosWorkDir {
  dir: string;
  krb5ConfigPath: string;
  ccachePath: string;
  cleanup: () => Promise<void>;
}

/** `krb5.conf` minimal, TEMPORAIRE, pointant uniquement vers le realm/KDC de la config candidate
 * — n'affecte jamais un éventuel `/etc/krb5.conf` de l'image (via la variable d'env KRB5_CONFIG,
 * lue par kinit/nsupdate, pas par un chemin fixe). Un realm par déploiement QUAI dans ce premier
 * lot : pas de section [domain_realm] (jamais nécessaire, le realm est toujours donné explicitement
 * à kinit, jamais déduit d'un nom de domaine). */
async function prepareKerberosWorkDir(cfg: SetupAdDnsConfig): Promise<KerberosWorkDir> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quai-addns-"));
  const krb5ConfigPath = path.join(dir, "krb5.conf");
  const ccachePath = path.join(dir, "ccache");
  const realm = cfg.realm.toUpperCase();
  await fs.writeFile(
    krb5ConfigPath,
    [
      "[libdefaults]",
      `  default_realm = ${realm}`,
      "  dns_lookup_realm = false",
      "  dns_lookup_kdc = false",
      "  rdns = false",
      "[realms]",
      `  ${realm} = {`,
      `    kdc = ${cfg.kdcHost}`,
      `    admin_server = ${cfg.kdcHost}`,
      "  }",
      "",
    ].join("\n"),
    { encoding: "utf-8", mode: 0o600 },
  );
  return {
    dir,
    krb5ConfigPath,
    ccachePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Principal Kerberos complet ("svc-quai-dns@LECREUSOT.FR") à partir d'un compte de service
 * saisi avec ou sans son suffixe de realm. */
function principalFor(cfg: SetupAdDnsConfig): string {
  const realm = cfg.realm.toUpperCase();
  return cfg.serviceAccount.includes("@") ? cfg.serviceAccount : `${cfg.serviceAccount}@${realm}`;
}

/**
 * Obtient un ticket Kerberos (TGT) pour le compte de service — mot de passe transmis sur le
 * stdin de `kinit` (jamais en argument de ligne de commande, qui apparaîtrait dans la liste des
 * process de l'hôte) via `runWithStdin` ci-dessus, jamais journalisé.
 */
async function kinit(cfg: SetupAdDnsConfig, work: KerberosWorkDir): Promise<{ ok: boolean; message?: string }> {
  const principal = principalFor(cfg);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KRB5_CONFIG: work.krb5ConfigPath,
    KRB5CCNAME: `FILE:${work.ccachePath}`,
  };
  const result = await runWithStdin(
    "kinit",
    [principal],
    `${cfg.password}\n`,
    env,
    config.adDns.requestTimeoutMs,
  );
  if (result.spawnError) {
    return {
      ok: false,
      message: `kinit introuvable (${result.spawnError}) — le paquet krb5-user doit être installé dans l'image de l'API.`,
    };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, message: `kinit a échoué pour ${principal}${detail ? ` : ${detail}` : ` (code ${result.code})`}` };
  }
  return { ok: true };
}

/** `nsupdate -g` : authentifie la mise à jour DNS avec le ticket obtenu par kinit ci-dessus
 * (GSS-TSIG — c'est `-g` qui déclenche cette authentification, pas un TSIG à clé statique). */
async function nsupdate(
  cfg: SetupAdDnsConfig,
  work: KerberosWorkDir,
  scriptLines: string[],
): Promise<{ ok: boolean; message?: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KRB5_CONFIG: work.krb5ConfigPath,
    KRB5CCNAME: `FILE:${work.ccachePath}`,
  };
  const script = [`server ${cfg.kdcHost}`, `zone ${cfg.zone}`, ...scriptLines, "send", ""].join("\n");
  const result = await runWithStdin("nsupdate", ["-g"], script, env, config.adDns.requestTimeoutMs);
  if (result.spawnError) {
    return {
      ok: false,
      message: `nsupdate introuvable (${result.spawnError}) — le paquet bind9-dnsutils doit être installé dans l'image de l'API.`,
    };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, message: `nsupdate a échoué${detail ? ` : ${detail}` : ` (code ${result.code})`}` };
  }
  return { ok: true };
}

/** Nom pleinement qualifié pour un enregistrement DNS : `subdomain` est déjà le nom complet
 * (ex "monapp.lecreusot.priv") tel que saisi pour la route de reverse proxy — `nsupdate` exige un
 * nom absolu (terminé par un point). */
function fqdn(name: string): string {
  return name.endsWith(".") ? name : `${name}.`;
}

/**
 * Défense en profondeur, DUPLIQUÉE volontairement de services/reverseProxy.ts#isValidSubdomain
 * (un import direct créerait un cycle : reverseProxy.ts importe déjà pushDnsRecord/removeDnsRecord
 * d'ici) — reverseProxy.ts valide déjà `subdomain` avant tout appel, mais `subdomain` est ensuite
 * interpolé TEL QUEL dans un script `nsupdate` transmis en texte brut, ligne par ligne : n'importe
 * quel appelant futur de pushDnsRecord/removeDnsRecord qui oublierait cette validation permettrait
 * une injection de commandes DNS arbitraires (voir docs/reports/security-audit-2026-08-12.md,
 * finding C3) — jamais construire le script sans revalider ici, quoi qu'il arrive côté appelant.
 */
const DNS_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const SUBDOMAIN_PATTERN = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})+$`);

function isValidDnsName(value: string): boolean {
  return value.length <= 253 && SUBDOMAIN_PATTERN.test(value.toLowerCase());
}

/**
 * POST /api/ad-dns/test — valide uniquement les identifiants/realm/KDC (kinit), n'écrit AUCUN
 * enregistrement DNS : sert à vérifier une config candidate avant de l'enregistrer.
 */
export async function testAdDnsConnection(candidate: SetupAdDnsConfig): Promise<AdDnsTestResult> {
  const work = await prepareKerberosWorkDir(candidate);
  try {
    const result = await kinit(candidate, work);
    if (!result.ok) return { ok: false, message: result.message ?? "Échec de l'obtention du ticket Kerberos." };
    return { ok: true, message: `Ticket Kerberos obtenu pour ${principalFor(candidate)} — les identifiants sont valides.` };
  } finally {
    await work.cleanup();
  }
}

/**
 * Pousse (crée ou remplace) l'enregistrement DNS `A` de `subdomain` -> `cfg.targetIp` — appelée
 * par reverseProxy.ts#createRoute en best-effort (jamais bloquant : un échec ici n'empêche pas la
 * route d'exister côté Caddy/QUAI, voir dnsSync sur ReverseProxyRoute). `update delete` avant
 * `update add` : idempotent, fonctionne aussi bien pour un enregistrement déjà existant (route
 * recréée après suppression) que pour un nouveau.
 */
export async function pushDnsRecord(cfg: SetupAdDnsConfig, subdomain: string): Promise<AdDnsSyncResult> {
  const at = new Date().toISOString();
  if (!isValidDnsName(subdomain)) {
    return { status: "failed", message: `"${subdomain}" is not a valid DNS name — refusing to build an nsupdate script from it.`, at };
  }
  const work = await prepareKerberosWorkDir(cfg);
  try {
    const ticket = await kinit(cfg, work);
    if (!ticket.ok) return { status: "failed", message: ticket.message ?? "Échec Kerberos.", at };
    const name = fqdn(subdomain);
    const update = await nsupdate(cfg, work, [
      `update delete ${name} A`,
      `update add ${name} ${config.adDns.recordTtlSeconds} A ${cfg.targetIp}`,
    ]);
    if (!update.ok) return { status: "failed", message: update.message ?? "Échec nsupdate.", at };
    return { status: "synced", at };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : String(err), at };
  } finally {
    await work.cleanup();
  }
}

/** Retire l'enregistrement DNS `A` de `subdomain` — appelée par reverseProxy.ts#deleteRoute en
 * best-effort (une route déjà supprimée côté QUAI/Caddy le reste même si ce retrait échoue). */
export async function removeDnsRecord(cfg: SetupAdDnsConfig, subdomain: string): Promise<AdDnsSyncResult> {
  const at = new Date().toISOString();
  if (!isValidDnsName(subdomain)) {
    return { status: "failed", message: `"${subdomain}" is not a valid DNS name — refusing to build an nsupdate script from it.`, at };
  }
  const work = await prepareKerberosWorkDir(cfg);
  try {
    const ticket = await kinit(cfg, work);
    if (!ticket.ok) return { status: "failed", message: ticket.message ?? "Échec Kerberos.", at };
    const update = await nsupdate(cfg, work, [`update delete ${fqdn(subdomain)} A`]);
    if (!update.ok) return { status: "failed", message: update.message ?? "Échec nsupdate.", at };
    return { status: "synced", at };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : String(err), at };
  } finally {
    await work.cleanup();
  }
}
