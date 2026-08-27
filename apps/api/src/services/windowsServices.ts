/**
 * SERVICES WINDOWS d'une machine du parc — ce que QUAI montre de l'INTÉRIEUR d'un Windows Server.
 *
 * Prism ne sait rien de l'intérieur d'une VM : nom, IP, état, disques, cartes réseau, et c'est tout.
 * Ces données-ci viennent donc de la machine elle-même, par WinRM, sous l'identité RÉELLE de la
 * personne connectée (services/kerberosSession.ts). Une personne sans droits sur le serveur ne voit
 * rien : c'est Windows qui tranche, pas QUAI.
 *
 * LECTURE SEULE. Démarrer ou arrêter un service est une mutation sur une machine de production :
 * elle viendra avec sa confirmation et sa trace, jamais en effet de bord d'un écran de consultation.
 */

import { ticketFor } from "./kerberosSession.js";
import { enumerateWmiClass, invokeWmiMethod } from "./winrm.js";
import type { WinrmFailure } from "./winrm.js";

/** État tel que Windows le rapporte, projeté sur le vocabulaire déjà utilisé par le graphe. */
export type WindowsServiceStatus = "running" | "stopped" | "unknown";

export interface WindowsService {
  name: string;
  displayName: string;
  status: WindowsServiceStatus;
  /** "Automatic", "Manual", "Disabled" — tel que Windows le dit, jamais traduit en devinant. */
  startMode: string;
  /** Compte sous lequel le service tourne ("LocalSystem", "NT AUTHORITY\\NetworkService"…). */
  account: string;
  description: string;
}

export type WindowsServicesOutcome =
  | { status: "ready"; host: string; services: WindowsService[]; truncated: boolean }
  | { status: "no-ticket" | "unreachable" | "denied" | "failed"; host: string; message: string };

function statusOf(state: string | undefined): WindowsServiceStatus {
  const value = (state ?? "").toLowerCase();
  if (value === "running") return "running";
  if (value === "stopped") return "stopped";
  // "Start Pending", "Paused"… : réels mais pas assimilables à l'un des deux — jamais forcés.
  return "unknown";
}

function toService(raw: Record<string, string>): WindowsService | null {
  const name = raw.Name?.trim();
  if (!name) return null;
  return {
    name,
    displayName: raw.DisplayName?.trim() || name,
    status: statusOf(raw.State),
    startMode: raw.StartMode?.trim() ?? "",
    account: raw.StartName?.trim() ?? "",
    description: raw.Description?.trim() ?? "",
  };
}

function failureToOutcome(host: string, failure: WinrmFailure): WindowsServicesOutcome {
  return { status: failure.kind === "no-ticket" ? "no-ticket" : failure.kind, host, message: failure.message };
}

/**
 * Services réels de `host`, vus par `username`. Un nom d'hôte vide, une personne sans ticket, une
 * machine injoignable : chacun rend son propre état, jamais une liste vide qui laisserait croire
 * que la machine n'a aucun service.
 */
export async function listWindowsServices(host: string, username: string): Promise<WindowsServicesOutcome> {
  const target = host.trim();
  if (target.length === 0) {
    return { status: "failed", host, message: "Aucun nom d'hôte : cette machine ne rapporte ni nom DNS ni adresse IP." };
  }

  const ticket = await ticketFor(username);
  if (!ticket) {
    return {
      status: "no-ticket",
      host: target,
      message:
        "Aucun ticket Kerberos pour votre session : reconnectez-vous à QUAI, ou vérifiez que le domaine Active Directory est configuré.",
    };
  }

  const result = await enumerateWmiClass(target, "Win32_Service", ticket);
  if (!result.ok) return failureToOutcome(target, result.failure);

  const services: WindowsService[] = [];
  for (const raw of result.value.instances) {
    const service = toService(raw);
    if (service) services.push(service);
  }
  // Ordre stable et utile : ce qui tourne d'abord, puis par nom affiché.
  services.sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : b.status === "running" ? 1 : 0;
    return a.displayName.localeCompare(b.displayName, "fr");
  });

  return { status: "ready", host: target, services, truncated: result.value.truncated };
}

/**
 * Codes de retour de Win32_Service.StartService/StopService, tels que Microsoft les documente.
 * Traduits ICI parce qu'ils sont propres à CETTE classe — un code 5 ne veut pas dire la même chose
 * ailleurs. Un code inconnu n'est jamais présenté comme un succès : il est rendu tel quel.
 */
const SERVICE_RETURN_MESSAGES: Record<number, string> = {
  0: "",
  1: "L'opération n'est pas prise en charge par ce service.",
  2: "Accès refusé : votre compte Windows n'a pas le droit de piloter ce service.",
  3: "Le service a des services dépendants en cours d'exécution.",
  5: "Le service n'est pas dans un état permettant cette opération.",
  7: "Le service n'a pas répondu à temps.",
  8: "Erreur inconnue rapportée par le gestionnaire de services.",
  9: "Le chemin du service est introuvable.",
  10: "Le service est déjà en cours d'exécution.",
  11: "La base de données des services est verrouillée.",
  15: "Le service n'a pas démarré : dépendance manquante.",
  21: "Paramètre invalide rapporté par le gestionnaire de services.",
  22: "Le compte du service est invalide.",
  24: "Le service est déjà en cours d'arrêt.",
};

export type ServiceAction = "start" | "stop";

export type ServiceActionOutcome =
  | { status: "done"; host: string; service: string; action: ServiceAction }
  | { status: "no-ticket" | "unreachable" | "denied" | "failed"; host: string; service: string; message: string };

/**
 * Démarre ou arrête un service RÉEL. Mutation sur une machine de production : elle est journalisée
 * automatiquement (plugins/audit.ts) et l'interface la fait confirmer avant d'arriver ici.
 *
 * Les droits sont ceux de WINDOWS : un refus vient du gestionnaire de services de la machine, pas
 * d'une règle inventée par QUAI.
 */
export async function controlWindowsService(
  host: string,
  service: string,
  action: ServiceAction,
  username: string,
): Promise<ServiceActionOutcome> {
  const target = host.trim();
  const name = service.trim();
  if (target.length === 0 || name.length === 0) {
    return { status: "failed", host, service, message: "Hôte et nom de service sont tous deux requis." };
  }

  const ticket = await ticketFor(username);
  if (!ticket) {
    return {
      status: "no-ticket",
      host: target,
      service: name,
      message: "Aucun ticket Kerberos pour votre session : reconnectez-vous à QUAI avant d'agir sur un service.",
    };
  }

  const method = action === "start" ? "StartService" : "StopService";
  const result = await invokeWmiMethod(target, "Win32_Service", method, { Name: name }, ticket);
  if (!result.ok) {
    const failure = result.failure;
    return { status: failure.kind === "no-ticket" ? "no-ticket" : failure.kind, host: target, service: name, message: failure.message };
  }

  const code = result.value.returnValue;
  if (code === 0) return { status: "done", host: target, service: name, action };
  if (code === undefined) {
    return {
      status: "failed",
      host: target,
      service: name,
      message: "La machine n'a pas renvoyé de code de retour : l'état réel du service est inconnu, vérifiez-le avant de réessayer.",
    };
  }
  const known = SERVICE_RETURN_MESSAGES[code];
  return {
    status: code === 2 ? "denied" : "failed",
    host: target,
    service: name,
    message: known && known.length > 0 ? known : `Le gestionnaire de services a répondu par le code ${code}.`,
  };
}
