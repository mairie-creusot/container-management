/**
 * TICKET KERBEROS DE SESSION — ce qui permet à QUAI d'agir sur Windows SOUS L'IDENTITÉ RÉELLE de
 * la personne connectée, plutôt que sous un compte de service partagé.
 *
 * Choix central, et sa raison. La demande était « que ça utilise le compte de la personne
 * connectée ». La façon naïve serait de garder son mot de passe de domaine pour la durée de sa
 * session. On garde à la place un TICKET, obtenu par `kinit` au moment de la connexion :
 *   - il porte la même identité côté Windows, et les droits AD de la personne s'appliquent ;
 *   - il EXPIRE de lui-même, là où un mot de passe reste valable jusqu'à son changement ;
 *   - il ne permet PAS de changer le mot de passe de la personne, contrairement au mot de passe.
 * Le mot de passe ne traverse ce fichier que sur le stdin de `kinit`, n'est jamais écrit, jamais
 * journalisé, jamais conservé.
 *
 * Le ticket vit UNIQUEMENT dans le conteneur (répertoire temporaire, 0600), est détruit à la
 * déconnexion et à son expiration. Il n'est jamais renvoyé par une route, ni exposé à l'interface.
 *
 * Capacité OPTIONNELLE : sans configuration Active Directory, ou si `kinit` échoue, la connexion à
 * QUAI réussit quand même — seules les fonctions Windows deviennent indisponibles, avec leur motif.
 * Une panne de KDC ne doit jamais empêcher d'administrer des conteneurs.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { getEffectiveAdDnsConfig } from "./setupStore.js";

export interface KerberosTicket {
  username: string;
  /** Chemin du cache d'identifiants — passé à curl/kinit par KRB5CCNAME, jamais lu ici. */
  ccachePath: string;
  krb5ConfigPath: string;
  realm: string;
  obtainedAt: number;
  expiresAt: number;
}

export type TicketOutcome =
  | { ok: true; ticket: KerberosTicket }
  | { ok: false; reason: string; configured: boolean };

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** Même patron que services/adDns.ts : le secret passe par stdin, jamais en argument de commande
 * (les arguments sont visibles dans la liste des processus de l'hôte). */
function runWithStdin(command: string, args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
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

/** Tickets vivants, en MÉMOIRE seulement : un redémarrage de l'API les perd, ce qui est correct —
 * personne ne doit pouvoir agir sous une identité au-delà de la vie du processus qui l'a obtenue. */
const tickets = new Map<string, KerberosTicket>();

function isExpired(ticket: KerberosTicket, now: number): boolean {
  return ticket.expiresAt <= now;
}

async function removeTicket(ticket: KerberosTicket): Promise<void> {
  await fs.rm(path.dirname(ticket.ccachePath), { recursive: true, force: true }).catch(() => undefined);
}

/** `krb5.conf` TEMPORAIRE ne décrivant que le realm visé — n'affecte jamais l'éventuel
 * /etc/krb5.conf de l'image (KRB5_CONFIG est lu par kinit et par curl). */
async function prepareWorkDir(realm: string, kdcHost: string): Promise<{ dir: string; krb5ConfigPath: string; ccachePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quai-krb-"));
  const krb5ConfigPath = path.join(dir, "krb5.conf");
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
      `    kdc = ${kdcHost}`,
      `    admin_server = ${kdcHost}`,
      "  }",
      "",
    ].join("\n"),
    { encoding: "utf-8", mode: 0o600 },
  );
  return { dir, krb5ConfigPath, ccachePath: path.join(dir, "ccache") };
}

/**
 * Obtient un ticket pour la personne qui vient de se connecter. Appelée depuis la route de
 * connexion, APRÈS que l'annuaire a validé le mot de passe.
 *
 * Ne lève jamais : un échec rend son motif, et l'appelant continue. Le realm et le KDC sont ceux
 * déjà configurés pour le DNS Active Directory — c'est le même domaine, et exiger une seconde
 * saisie des mêmes valeurs n'apporterait qu'une occasion de les faire diverger.
 */
export async function establishTicket(username: string, password: string): Promise<TicketOutcome> {
  const adConfig = await getEffectiveAdDnsConfig();
  if (!adConfig) {
    return {
      ok: false,
      configured: false,
      reason: "Aucun domaine Active Directory configuré (Réglages › DNS Active Directory) : les fonctions Windows sont indisponibles.",
    };
  }

  const realm = adConfig.realm.toUpperCase();
  const principal = username.includes("@") ? username : `${username}@${realm}`;
  const work = await prepareWorkDir(realm, adConfig.kdcHost);

  const result = await runWithStdin(
    "kinit",
    [principal],
    `${password}\n`,
    { ...process.env, KRB5_CONFIG: work.krb5ConfigPath, KRB5CCNAME: `FILE:${work.ccachePath}` },
    config.windows.kinitTimeoutMs,
  );

  if (result.spawnError !== undefined || result.code !== 0) {
    await fs.rm(work.dir, { recursive: true, force: true }).catch(() => undefined);
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      configured: true,
      reason:
        result.spawnError !== undefined
          ? `kinit introuvable (${result.spawnError}) — le paquet krb5-user doit être installé dans l'image de l'API.`
          : `kinit a échoué pour ${principal}${detail ? ` : ${detail}` : ` (code ${result.code})`}`,
    };
  }

  const now = Date.now();
  const ticket: KerberosTicket = {
    username,
    ccachePath: work.ccachePath,
    krb5ConfigPath: work.krb5ConfigPath,
    realm,
    obtainedAt: now,
    // La durée réelle est décidée par le KDC ; on ne prétend pas la connaître, on borne la nôtre.
    // À l'usage, un ticket périmé côté KDC se manifeste par un refus, rapporté tel quel.
    expiresAt: now + config.windows.ticketTtlMs,
  };

  const previous = tickets.get(username);
  if (previous) await removeTicket(previous);
  tickets.set(username, ticket);
  return { ok: true, ticket };
}

/** Ticket utilisable de cette personne, ou `undefined`. Un ticket périmé est détruit à la volée. */
export async function ticketFor(username: string): Promise<KerberosTicket | undefined> {
  const ticket = tickets.get(username);
  if (!ticket) return undefined;
  if (isExpired(ticket, Date.now())) {
    tickets.delete(username);
    await removeTicket(ticket);
    return undefined;
  }
  return ticket;
}

/** Déconnexion : le ticket ne doit pas survivre à la session qui l'a fait naître. */
export async function destroyTicket(username: string): Promise<boolean> {
  const ticket = tickets.get(username);
  if (!ticket) return false;
  tickets.delete(username);
  await removeTicket(ticket);
  return true;
}

/** Ce que l'interface a le droit de savoir : qu'un ticket existe et jusqu'à quand — jamais où il
 * est ni ce qu'il contient. */
export function ticketStatusFor(username: string): { present: boolean; expiresAt: string | null } {
  const ticket = tickets.get(username);
  if (!ticket || isExpired(ticket, Date.now())) return { present: false, expiresAt: null };
  return { present: true, expiresAt: new Date(ticket.expiresAt).toISOString() };
}

/** Fin de processus et tests : rien ne doit rester sur le disque. */
export async function destroyAllTickets(): Promise<void> {
  const all = [...tickets.values()];
  tickets.clear();
  for (const ticket of all) await removeTicket(ticket);
}
