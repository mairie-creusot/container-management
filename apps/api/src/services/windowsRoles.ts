/**
 * RÔLES WINDOWS installés sur une machine — ce qui décide des onglets réellement proposés.
 *
 * « En fonction des services présents » : un serveur sans DHCP n'a pas d'onglet DHCP. La détection
 * se fait par `Get-WindowsFeature`, qui dit ce qui est INSTALLÉ — jamais par le nom de la machine,
 * jamais par une supposition tirée de son rôle apparent dans le graphe.
 *
 * `Get-WindowsFeature` n'existe pas sur un Windows client. Son absence n'est donc pas une panne :
 * elle signifie « ce n'est pas un Windows Server », et se rend comme telle.
 */

import { ticketFor } from "./kerberosSession.js";
import { runPowerShellJson, toJsonSuffix } from "./winrmShell.js";
import type { WinrmFailure } from "./winrm.js";

/** Rôles que QUAI sait présenter. Un rôle installé mais absent d'ici n'ouvre aucun onglet — il est
 * simplement listé, plutôt que masqué comme s'il n'existait pas. */
export const KNOWN_ROLES = {
  DHCP: "dhcp",
  DNS: "dns",
  "AD-Domain-Services": "ad",
  "FS-FileServer": "storage",
} as const;

export type WindowsRoleId = (typeof KNOWN_ROLES)[keyof typeof KNOWN_ROLES];

export interface WindowsRole {
  /** Nom de la fonctionnalité Windows ("DHCP", "AD-Domain-Services"). */
  name: string;
  displayName: string;
  /** Onglet QUAI correspondant, quand il en existe un. */
  tab?: WindowsRoleId;
}

export type WindowsRolesOutcome =
  | { status: "ready"; host: string; roles: WindowsRole[] }
  | { status: "not-a-server"; host: string; message: string }
  | { status: "no-ticket" | "unreachable" | "denied" | "failed"; host: string; message: string };

interface RawFeature {
  Name?: unknown;
  DisplayName?: unknown;
}

/** Rôles INSTALLÉS uniquement — `Installed` est l'état réel, pas `Available`. */
const SCRIPT = `Get-WindowsFeature | Where-Object { $_.Installed -and $_.FeatureType -eq 'Role' } | Select-Object Name,DisplayName${toJsonSuffix(3)}`;

function failureToOutcome(host: string, failure: WinrmFailure): WindowsRolesOutcome {
  // `Get-WindowsFeature` absent = Windows client, pas un échec d'administration.
  if (failure.kind === "failed" && /Get-WindowsFeature|n'est pas reconnu|is not recognized/i.test(failure.message)) {
    return {
      status: "not-a-server",
      host,
      message: "Cette machine ne propose pas Get-WindowsFeature : ce n'est pas un Windows Server, aucun rôle à administrer.",
    };
  }
  return { status: failure.kind === "no-ticket" ? "no-ticket" : failure.kind, host, message: failure.message };
}

export async function listWindowsRoles(host: string, username: string): Promise<WindowsRolesOutcome> {
  const target = host.trim();
  if (target.length === 0) {
    return { status: "failed", host, message: "Aucun nom d'hôte : cette machine ne rapporte ni nom DNS ni adresse IP." };
  }

  const ticket = await ticketFor(username);
  if (!ticket) {
    return {
      status: "no-ticket",
      host: target,
      message: "Aucun ticket Kerberos pour votre session : reconnectez-vous à QUAI pour administrer cette machine.",
    };
  }

  const result = await runPowerShellJson<RawFeature>(target, SCRIPT, ticket);
  if (!result.ok) return failureToOutcome(target, result.failure);

  const roles: WindowsRole[] = [];
  for (const raw of result.value) {
    const name = typeof raw.Name === "string" ? raw.Name.trim() : "";
    if (!name) continue;
    const tab = (KNOWN_ROLES as Record<string, WindowsRoleId | undefined>)[name];
    roles.push({
      name,
      displayName: typeof raw.DisplayName === "string" && raw.DisplayName.trim() ? raw.DisplayName.trim() : name,
      ...(tab ? { tab } : {}),
    });
  }
  roles.sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"));
  return { status: "ready", host: target, roles };
}
