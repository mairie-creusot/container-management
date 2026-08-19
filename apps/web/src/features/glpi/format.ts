import type { GlpiInventoryField, GlpiInventoryValue, GlpiRealResourceKind, GlpiTicketSummary } from "@/features/glpi/types";

/** Valeur absente de la réponse GLPI — affichée telle quelle, jamais remplacée par une valeur. */
export const MISSING = "—";

/** GLPI date ses objets en "AAAA-MM-JJ hh:mm:ss" (pas en ISO 8601) : converti pour l'affichage,
 * et rendu tel quel si la conversion échoue plutôt que d'afficher une date fausse. */
export function formatDateTime(value?: string): string {
  if (!value) return MISSING;
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(" ", "T") : value;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("fr-FR");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#039": "'",
};

/** Les contenus et suivis GLPI sont du HTML : ramenés en texte, jamais injectés dans le DOM. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#0?39|amp|lt|gt|quot|apos|nbsp);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pastille de statut : le libellé GLPI est repris tel quel, seule la couleur est une lecture QUAI.
 * Un code non libellé reste affiché en clair plutôt que rattaché arbitrairement à un état. */
export function ticketPill(ticket: Pick<GlpiTicketSummary, "status" | "statusLabel">): { status: string; label: string } {
  const label = ticket.statusLabel ?? (ticket.status !== undefined ? `Statut GLPI ${ticket.status}` : "Statut non communiqué");
  if (ticket.status === 5 || ticket.status === 6) return { status: "ok", label };
  if (ticket.status === 4) return { status: "warn", label };
  return { status: "glpi-open", label };
}

const FIELD_LABELS: Record<GlpiInventoryField, string> = {
  name: "Nom",
  uuid: "UUID",
  serial: "Numéro de série",
  vcpu: "vCPU / cœurs",
  memoryMib: "Mémoire (MiB)",
  ipAddresses: "Adresses IP",
  operatingSystem: "Système d'exploitation",
  host: "Hôte de virtualisation",
};

export function fieldLabel(field: GlpiInventoryField): string {
  return FIELD_LABELS[field] ?? field;
}

export function formatInventoryValue(value: GlpiInventoryValue): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : MISSING;
  if (typeof value === "number") return String(value);
  return value.trim() === "" ? MISSING : value;
}

export function resourceKindLabel(kind: GlpiRealResourceKind): string {
  return kind === "nutanix-vm" ? "VM Nutanix" : "Hôte Nutanix";
}

export function absenceLabel(missingOn: "glpi" | "real" | "both"): string {
  if (missingOn === "glpi") return "non renseigné dans GLPI";
  if (missingOn === "real") return "non communiqué par l'infrastructure";
  return "absent des deux côtés";
}
