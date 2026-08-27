/**
 * CLIENT WinRM (WS-Management) — pour voir et piloter l'intérieur d'un Windows Server depuis QUAI.
 *
 * Pourquoi `curl` en sous-processus plutôt qu'une bibliothèque. QUAI wrappe déjà de VRAIS binaires
 * là où le protocole est complexe et bien outillé (`kinit`, `nsupdate -g` pour le DNS dynamique) :
 * l'authentification Kerberos/SPNEGO est exactement ce cas. `curl --negotiate` la fait avec la
 * bibliothèque GSS-API du système, en lisant le ticket de la personne connectée (KRB5CCNAME) —
 * réimplémenter SPNEGO en TypeScript serait long, fragile, et entrerait dans le chemin qui décide
 * de ce qui s'exécute sur les serveurs.
 *
 * POURQUOI HTTPS OBLIGATOIRE. En HTTP simple, WinRM exige un chiffrement au niveau du MESSAGE
 * (enveloppe SPNEGO/MIME) que `curl --negotiate` ne produit pas : le service répond alors
 * « unencrypted traffic is currently disabled ». En HTTPS (5986), le transport suffit et l'échange
 * passe. Conséquence assumée et documentée : les serveurs doivent porter un listener WinRM HTTPS,
 * avec un certificat émis par l'autorité interne — la même que QUAI fait déjà confiance ailleurs.
 *
 * LECTURE SEULE dans ce premier lot : seule l'énumération est exposée. Démarrer ou arrêter un
 * service est une mutation sur une machine de production ; elle viendra avec sa confirmation
 * explicite et sa trace, pas en effet de bord d'un écran de consultation.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { KerberosTicket } from "./kerberosSession.js";

const WSMAN_NS = "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd";
const ADDRESSING_NS = "http://schemas.xmlsoap.org/ws/2004/08/addressing";
const ENUMERATION_NS = "http://schemas.xmlsoap.org/ws/2004/09/enumeration";
const SOAP_NS = "http://www.w3.org/2003/05/soap-envelope";
/** Classes WMI accessibles par WS-Management, espace root/cimv2. */
const WMI_RESOURCE_BASE = "http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2";
/** Une énumération WinRM se pagine ; au-delà, on cesse de tirer plutôt que de boucler sans fin. */
const MAX_PULLS = 20;
const MAX_ELEMENTS_PER_PULL = 64;

export type WinrmFailure =
  | { kind: "no-ticket"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "failed"; message: string };

export type WinrmResult<T> = { ok: true; value: T } | { ok: false; failure: WinrmFailure };

interface CurlResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function runCurl(args: string[], body: string, env: NodeJS.ProcessEnv): Promise<CurlResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("curl", args, { env });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), config.windows.winrmTimeoutMs + 5000);
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
    child.stdin.write(body);
    child.stdin.end();
  });
}

function endpointFor(host: string): string {
  return `https://${host}:${config.windows.winrmPort}/wsman`;
}

/** Enveloppe SOAP commune — `action` et `body` sont les seules parties qui changent. */
function envelope(host: string, resourceUri: string, action: string, body: string, selector?: Record<string, string>): string {
  const selectorSet =
    selector === undefined
      ? ""
      : `<w:SelectorSet>${Object.entries(selector)
          .map(([name, value]) => `<w:Selector Name="${escapeXml(name)}">${escapeXml(value)}</w:Selector>`)
          .join("")}</w:SelectorSet>`;
  return [
    `<s:Envelope xmlns:s="${SOAP_NS}" xmlns:a="${ADDRESSING_NS}" xmlns:w="${WSMAN_NS}" xmlns:n="${ENUMERATION_NS}">`,
    "<s:Header>",
    `<a:To>${escapeXml(endpointFor(host))}</a:To>`,
    `<w:ResourceURI s:mustUnderstand="true">${escapeXml(resourceUri)}</w:ResourceURI>`,
    `<a:ReplyTo><a:Address s:mustUnderstand="true">${ADDRESSING_NS}/role/anonymous</a:Address></a:ReplyTo>`,
    `<a:Action s:mustUnderstand="true">${escapeXml(action)}</a:Action>`,
    '<w:MaxEnvelopeSize s:mustUnderstand="true">512000</w:MaxEnvelopeSize>',
    `<a:MessageID>uuid:${randomUUID()}</a:MessageID>`,
    '<w:Locale xml:lang="fr-FR" s:mustUnderstand="false"/>',
    `<w:OperationTimeout>PT${Math.round(config.windows.winrmTimeoutMs / 1000)}S</w:OperationTimeout>`,
    selectorSet,
    "</s:Header>",
    `<s:Body>${body}</s:Body>`,
    "</s:Envelope>",
  ].join("");
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Éléments d'un nom de balise donné, avec leurs champs enfants. Volontairement étroit : les
 * réponses WS-Management sont produites par une machine et suivent une forme fixe, mais on ne
 * prétend pas lire du XML quelconque — tout ce qui n'est pas reconnu est simplement ignoré, jamais
 * deviné.
 */
export function extractInstances(xml: string, className: string): Record<string, string>[] {
  const instances: Record<string, string>[] = [];
  const blockPattern = new RegExp(`<(?:[A-Za-z0-9_]+:)?${className}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${className}>`, "g");
  const fieldPattern = /<(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?\1>/g;

  for (const block of xml.matchAll(blockPattern)) {
    const inner = block[1] ?? "";
    const fields: Record<string, string> = {};
    for (const field of inner.matchAll(fieldPattern)) {
      const name = field[1];
      const raw = field[2] ?? "";
      // Un champ composite (sous-éléments) n'est pas aplati en texte : il est ignoré.
      if (name === undefined || raw.includes("<")) continue;
      fields[name] = unescapeXml(raw.trim());
    }
    if (Object.keys(fields).length > 0) instances.push(fields);
  }
  return instances;
}

/** Contexte d'énumération à tirer ensuite ; absent = tout a été rendu. */
function enumerationContext(xml: string): string | undefined {
  const match = /<(?:[A-Za-z0-9_]+:)?EnumerationContext(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?EnumerationContext>/.exec(xml);
  const value = match?.[1]?.trim();
  return value ? unescapeXml(value) : undefined;
}

/** Message d'erreur RÉEL d'un WS-Management Fault, jamais reformulé. */
function faultReason(xml: string): string | undefined {
  const match = /<(?:[A-Za-z0-9_]+:)?(?:Text|Message)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?(?:Text|Message)>/.exec(xml);
  const value = match?.[1]?.trim();
  return value ? unescapeXml(value) : undefined;
}

function classify(host: string, result: CurlResult): WinrmFailure | undefined {
  if (result.spawnError !== undefined) {
    return { kind: "failed", message: `curl introuvable (${result.spawnError}) — il doit être installé dans l'image de l'API.` };
  }
  if (result.code === 0) {
    // curl a abouti : reste à voir ce que le service a répondu (voir l'appelant).
    return undefined;
  }
  // Codes de sortie curl réellement rencontrés ici — le reste remonte tel quel plutôt que traduit.
  if (result.code === 7 || result.code === 28) {
    return { kind: "unreachable", message: `${host} n'a pas répondu sur le port ${config.windows.winrmPort} (WinRM HTTPS).` };
  }
  if (result.code === 60 || result.code === 51) {
    return {
      kind: "failed",
      message: `Le certificat présenté par ${host} n'est pas validé par l'autorité de confiance de QUAI (INTERNAL_CA_BUNDLE_B64).`,
    };
  }
  if (result.code === 67 || result.code === 22) {
    return { kind: "denied", message: `Authentification refusée par ${host} — le ticket Kerberos n'a pas été accepté.` };
  }
  const detail = (result.stderr || result.stdout).trim();
  return { kind: "failed", message: `curl a échoué (code ${result.code})${detail ? ` : ${detail}` : ""}` };
}

async function callWsman(host: string, ticket: KerberosTicket, body: string): Promise<WinrmResult<string>> {
  const args = [
    "--silent",
    "--show-error",
    "--negotiate",
    // Utilisateur vide : c'est le TICKET (KRB5CCNAME) qui porte l'identité, jamais un mot de passe.
    "--user",
    ":",
    "--header",
    "Content-Type: application/soap+xml;charset=UTF-8",
    "--max-time",
    String(Math.round(config.windows.winrmTimeoutMs / 1000)),
    "--data-binary",
    "@-",
  ];
  if (config.windows.caBundlePath.trim().length > 0) args.push("--cacert", config.windows.caBundlePath);
  args.push(endpointFor(host));

  const result = await runCurl(args, body, {
    ...process.env,
    KRB5_CONFIG: ticket.krb5ConfigPath,
    KRB5CCNAME: `FILE:${ticket.ccachePath}`,
  });

  const failure = classify(host, result);
  if (failure) return { ok: false, failure };

  if (/<(?:[A-Za-z0-9_]+:)?Fault\b/.test(result.stdout)) {
    const reason = faultReason(result.stdout) ?? "le service WinRM a renvoyé une erreur sans message.";
    const denied = /access is denied|accès refusé/i.test(reason);
    return { ok: false, failure: { kind: denied ? "denied" : "failed", message: reason } };
  }
  return { ok: true, value: result.stdout };
}

/**
 * Instances d'une classe WMI sur une machine, sous l'identité du ticket fourni. L'énumération est
 * tirée page par page ; une pagination anormalement longue est INTERROMPUE et le dit, plutôt que de
 * boucler indéfiniment sur une machine qui répondrait mal.
 */
export async function enumerateWmiClass(
  host: string,
  className: string,
  ticket: KerberosTicket,
): Promise<WinrmResult<{ instances: Record<string, string>[]; truncated: boolean }>> {
  const resourceUri = `${WMI_RESOURCE_BASE}/${className}`;
  const first = await callWsman(
    host,
    ticket,
    envelope(
      host,
      resourceUri,
      `${ENUMERATION_NS}/Enumerate`,
      `<n:Enumerate><w:OptimizeEnumeration/><w:MaxElements>${MAX_ELEMENTS_PER_PULL}</w:MaxElements></n:Enumerate>`,
    ),
  );
  if (!first.ok) return first;

  const instances = extractInstances(first.value, className);
  let context = enumerationContext(first.value);
  let pulls = 0;

  while (context !== undefined && pulls < MAX_PULLS) {
    pulls += 1;
    const next = await callWsman(
      host,
      ticket,
      envelope(
        host,
        resourceUri,
        `${ENUMERATION_NS}/Pull`,
        `<n:Pull><n:EnumerationContext>${escapeXml(context)}</n:EnumerationContext><n:MaxElements>${MAX_ELEMENTS_PER_PULL}</n:MaxElements></n:Pull>`,
      ),
    );
    if (!next.ok) return next;
    instances.push(...extractInstances(next.value, className));
    context = enumerationContext(next.value);
  }

  return { ok: true, value: { instances, truncated: context !== undefined } };
}
