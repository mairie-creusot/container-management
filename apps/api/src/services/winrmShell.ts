/**
 * EXÉCUTION DE POWERSHELL À DISTANCE (protocole Shell de WS-Management).
 *
 * Pourquoi cette brique. Les services Windows se lisent et se pilotent par des classes WMI, ce qui
 * suffisait au premier lot. DHCP, DNS, Active Directory et le stockage, eux, s'administrent par des
 * cmdlets — `Get-DhcpServerv4Scope`, `Add-DnsServerResourceRecordA`, `Unlock-ADAccount`,
 * `Get-SmbShare`. Il faut donc ouvrir un shell distant, y exécuter un script, et récupérer sa
 * sortie. Avec `ConvertTo-Json` côté Windows, les données reviennent structurées.
 *
 * GARDE-FOU CENTRAL, écrit avant la première fonctionnalité qui s'en sert : AUCUN script ne peut
 * venir de l'extérieur. Ce module n'exporte pas « exécute ce que l'utilisateur a tapé » — il exécute
 * des scripts que le code de QUAI compose, dont les paramètres passent par `psLiteral()`. Sans cette
 * règle, une route mal écrite donnerait à quiconque atteint QUAI un interpréteur de commandes sur
 * les serveurs, avec les droits de la personne connectée. Le contrôle d'accès de Windows ne
 * protégerait alors plus rien : la personne A pourrait faire exécuter n'importe quoi SOUS SON PROPRE
 * compte, ce qu'aucun droit AD ne peut empêcher.
 *
 * La commande part en `-EncodedCommand` (UTF-16LE base64) : plus aucune question de guillemets, de
 * retours à la ligne ou de caractères spéciaux dans la ligne de commande.
 */

import { Buffer } from "node:buffer";
import { config } from "../config.js";
import { callWsman, escapeXml, wsmanEnvelope } from "./winrm.js";
import type { WinrmResult } from "./winrm.js";
import type { KerberosTicket } from "./kerberosSession.js";

const SHELL_NS = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell";
const SHELL_RESOURCE = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd";
const TRANSFER_NS = "http://schemas.xmlsoap.org/ws/2004/09/transfer";
/** Au-delà, on cesse de tirer la sortie plutôt que de boucler sur une machine qui répond mal. */
const MAX_RECEIVES = 60;

export interface PowerShellResult {
  stdout: string;
  stderr: string;
  /** Code de sortie de PowerShell — 0 = succès. */
  exitCode: number;
}

/**
 * Chaîne PowerShell littérale : guillemets SIMPLES, où rien n'est interprété (ni `$`, ni backtick,
 * ni sous-expression), et où le seul caractère à neutraliser est l'apostrophe, doublée.
 *
 * C'est le seul chemin par lequel une valeur venue de l'utilisateur entre dans un script.
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function base64Utf16(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`).exec(xml);
  return match?.[1]?.trim();
}

/** Flux `stdout`/`stderr` d'une réponse Receive — base64, potentiellement en plusieurs morceaux. */
function readStream(xml: string, name: string): string {
  const pattern = new RegExp(`<(?:[A-Za-z0-9_]+:)?Stream[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?Stream>`, "g");
  let out = "";
  for (const match of xml.matchAll(pattern)) {
    const chunk = match[1]?.trim();
    if (chunk) out += Buffer.from(chunk, "base64").toString("utf-8");
  }
  return out;
}

/** Valeur d'un `<w:Selector Name="…">` précis — jamais « le premier Selector venu ». */
function namedSelector(xml: string, name: string): string | undefined {
  const match = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?Selector[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?Selector>`,
  ).exec(xml);
  return match?.[1]?.trim();
}

/**
 * Fin de commande. La forme réelle est `<rsp:CommandState CommandId="…" State="…/CommandState/Done">`
 * : l'état est dans l'attribut `State` d'un élément `CommandState`, PAS dans un attribut qui
 * porterait ce nom. Chercher `CommandState="…"` ne trouvait jamais rien et la lecture tournait
 * jusqu'à sa limite avant d'abandonner — bug trouvé par les tests le 27/08/2026.
 */
function commandDone(xml: string): boolean {
  return /<(?:[A-Za-z0-9_]+:)?CommandState[^>]*State="[^"]*\/Done"/.test(xml);
}

function exitCodeOf(xml: string): number {
  const raw = firstTag(xml, "ExitCode");
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ouvre un shell, exécute le script, récupère sa sortie, referme le shell. Le shell est TOUJOURS
 * refermé, même en cas d'échec : un shell laissé ouvert consomme un quota côté Windows et finit par
 * empêcher toute nouvelle connexion.
 */
export async function runPowerShell(host: string, script: string, ticket: KerberosTicket): Promise<WinrmResult<PowerShellResult>> {
  const created = await callWsman(
    host,
    ticket,
    wsmanEnvelope(
      host,
      SHELL_RESOURCE,
      `${TRANSFER_NS}/Create`,
      `<rsp:Shell xmlns:rsp="${SHELL_NS}"><rsp:InputStreams>stdin</rsp:InputStreams>` +
        `<rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`,
      undefined,
      // Pas de profil utilisateur : plus rapide, et rien du profil ne doit influencer un script
      // que QUAI compose lui-même. Page de codes UTF-8 pour que les accents survivent.
      { WINRS_NOPROFILE: "TRUE", WINRS_CODEPAGE: "65001" },
    ),
  );
  if (!created.ok) return created;

  // Windows rend l'identifiant sous DEUX formes selon la version : `<rsp:ShellId>` dans le corps,
  // et/ou un `<w:Selector Name="ShellId">` dans l'en-tête. On lit la première, puis la seconde —
  // jamais « le premier Selector venu », qui pourrait en désigner un autre.
  const shellId = firstTag(created.value, "ShellId") ?? namedSelector(created.value, "ShellId");
  if (!shellId) {
    return { ok: false, failure: { kind: "failed", message: "La machine n'a pas ouvert de session distante (aucun identifiant de shell renvoyé)." } };
  }

  try {
    const started = await callWsman(
      host,
      ticket,
      wsmanEnvelope(
        host,
        SHELL_RESOURCE,
        `${SHELL_NS}/Command`,
        `<rsp:CommandLine xmlns:rsp="${SHELL_NS}"><rsp:Command>powershell.exe</rsp:Command>` +
          `<rsp:Arguments>-NoProfile</rsp:Arguments><rsp:Arguments>-NonInteractive</rsp:Arguments>` +
          `<rsp:Arguments>-EncodedCommand</rsp:Arguments><rsp:Arguments>${escapeXml(base64Utf16(script))}</rsp:Arguments>` +
          `</rsp:CommandLine>`,
        { ShellId: shellId },
      ),
    );
    if (!started.ok) return started;

    const commandId = firstTag(started.value, "CommandId");
    if (!commandId) {
      return { ok: false, failure: { kind: "failed", message: "La machine n'a pas accepté la commande (aucun identifiant renvoyé)." } };
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (let attempt = 0; attempt < MAX_RECEIVES; attempt += 1) {
      const received = await callWsman(
        host,
        ticket,
        wsmanEnvelope(
          host,
          SHELL_RESOURCE,
          `${SHELL_NS}/Receive`,
          `<rsp:Receive xmlns:rsp="${SHELL_NS}"><rsp:DesiredStream CommandId="${escapeXml(commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`,
          { ShellId: shellId },
        ),
      );
      if (!received.ok) return received;

      stdout += readStream(received.value, "stdout");
      stderr += readStream(received.value, "stderr");
      if (commandDone(received.value)) {
        exitCode = exitCodeOf(received.value);
        return { ok: true, value: { stdout, stderr, exitCode } };
      }
    }

    return {
      ok: false,
      failure: {
        kind: "failed",
        message: `La commande n'a pas rendu la main après ${MAX_RECEIVES} lectures : abandonnée plutôt que d'attendre indéfiniment.`,
      },
    };
  } finally {
    // Toujours, y compris après un échec : un shell orphelin consomme un quota côté Windows.
    await callWsman(
      host,
      ticket,
      wsmanEnvelope(host, SHELL_RESOURCE, `${TRANSFER_NS}/Delete`, "", { ShellId: shellId }),
    ).catch(() => undefined);
  }
}

/**
 * Exécute un script et lit sa sortie JSON. Le script DOIT produire du JSON (`ConvertTo-Json`).
 *
 * `ConvertTo-Json` rend un objet seul quand la collection ne compte qu'un élément, et rien du tout
 * quand elle est vide : les deux sont normalisés en tableau ici, sinon chaque appelant réinventerait
 * ce détail — et se tromperait le jour où la machine n'a qu'une étendue DHCP.
 */
export async function runPowerShellJson<T>(host: string, script: string, ticket: KerberosTicket): Promise<WinrmResult<T[]>> {
  const wrapped = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`;
  const result = await runPowerShell(host, wrapped, ticket);
  if (!result.ok) return result;

  const { stdout, stderr, exitCode } = result.value;
  if (exitCode !== 0) {
    // Le message de PowerShell est rendu TEL QUEL : c'est lui qui dit ce qui a échoué sur la machine.
    const detail = stderr.trim() || stdout.trim();
    return { ok: false, failure: { kind: "failed", message: detail || `La commande a échoué (code ${exitCode}).` } };
  }

  const text = stdout.trim();
  if (text.length === 0) return { ok: true, value: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: { kind: "failed", message: `La machine n'a pas renvoyé de JSON exploitable : ${text.slice(0, 200)}` },
    };
  }
  return { ok: true, value: (Array.isArray(parsed) ? parsed : [parsed]) as T[] };
}

/** Suffixe standard d'un script de lecture — une seule écriture de la profondeur et du compactage. */
export function toJsonSuffix(depth = 4): string {
  return ` | ConvertTo-Json -Depth ${depth} -Compress`;
}

export const POWERSHELL_TIMEOUT_MS = config.windows.winrmTimeoutMs;
