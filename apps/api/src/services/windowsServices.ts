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
import { enumerateWmiClass } from "./winrm.js";
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
