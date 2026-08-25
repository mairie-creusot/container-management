import type { ComponentType } from "react";
import type { ViewId } from "@/features/ui/uiSlice";
import type { PluginsNavSource, PluginSummary } from "@/features/plugins/pluginsModel";
import {
  IconBackup,
  IconBell,
  IconCertificate,
  IconLifebuoy,
  IconPhone,
  IconServer,
  IconSettings,
  IconStack,
  IconVm,
} from "@/components/icons";

/** Une entrée du menu Réglages = une intégration. Partagée par le Topbar (menu déroulant) et par
 * la page Réglages (rail de gauche) — jamais deux listes à garder synchronisées. */
export interface SettingsSectionMeta {
  id: string;
  label: string;
  /** Une phrase : ce que ce réglage commande réellement. */
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Page métier qui consomme ce réglage — proposée en renvoi depuis la section. */
  relatedView?: ViewId;
  /** Formulaire pas encore extrait : la section renvoie honnêtement vers la page qui le porte. */
  pendingOn?: ViewId;
  /** Section apportée par un GREFFON : son formulaire est déduit du manifeste, pas écrit ici. */
  pluginId?: string;
}

/**
 * Ordre de référence des sections. Les entrées portant un `pluginId` sont des emplacements de
 * greffon : leur libellé définitif vient du manifeste (voir buildSettingsSections), celui déclaré
 * ici ne sert que tant que GET /api/plugins n'a pas répondu — notamment au menu du Topbar, qui lit
 * cette liste statique.
 */
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "setup",
    label: "Assistant de configuration",
    description: "LDAP, orchestrateurs Docker/Kubernetes et registries — rouvre l'assistant de premier lancement.",
    icon: IconSettings,
  },
  {
    id: "nutanix",
    label: "Virtualisation Nutanix",
    description: "Prism Central : clusters, hôtes AHV et VMs réels.",
    icon: IconVm,
    relatedView: "clusters",
    pluginId: "nutanix",
  },
  {
    id: "ad-dns",
    label: "DNS Active Directory",
    description: "Synchronisation dynamique GSS-TSIG et diagnostic des comptes de l'annuaire.",
    icon: IconServer,
    relatedView: "publication",
  },
  {
    // Identifiant historique conservé : le greffon s'appelle « 3cx », la section « threecx ».
    id: "threecx",
    label: "Téléphonie 3CX",
    description: "Accès en lecture seule au XAPI du PBX.",
    icon: IconPhone,
    relatedView: "threecx",
    pluginId: "3cx",
  },
  {
    id: "glpi",
    label: "Assistance GLPI",
    description: "API REST de GLPI : tickets et réconciliation d'inventaire.",
    icon: IconLifebuoy,
    relatedView: "glpi",
    pluginId: "glpi",
  },
  {
    id: "hycu",
    label: "Sauvegarde HYCU",
    description: "Contrôleur de sauvegarde HYCU (lecture seule).",
    icon: IconBackup,
    relatedView: "backups",
    pluginId: "hycu",
  },
  {
    id: "certificates",
    label: "Autorité de certification AD CS",
    description: "Émission des certificats internes pour les sous-domaines publiés.",
    icon: IconCertificate,
    relatedView: "publication",
  },
  {
    id: "notification-channels",
    label: "Canaux de notification",
    description: "Webhook, Slack, Discord ou email SMTP pour les événements système.",
    icon: IconBell,
    relatedView: "notifications",
  },
];

function manifestLabel(summary: PluginSummary, fallback: string): string {
  const name = summary.manifest.name;
  return typeof name === "string" && name.trim().length > 0 ? name : fallback;
}

/**
 * Sections réellement affichables. Un emplacement de greffon absent de GET /api/plugins disparaît
 * — sans manifeste il n'y a pas de formulaire à déduire ; un greffon inconnu du catalogue est
 * ajouté à la fin, nommé par son manifeste. Tant que la liste n'a pas répondu, l'ordre de référence
 * est rendu tel quel : rien ne disparaît sur une supposition.
 */
export function buildSettingsSections(
  source: PluginsNavSource,
  reference: readonly SettingsSectionMeta[] = SETTINGS_SECTIONS,
): SettingsSectionMeta[] {
  if (source.status !== "ready") return [...reference];

  const sections: SettingsSectionMeta[] = [];
  const placed = new Set<string>();

  for (const section of reference) {
    if (section.pluginId === undefined) {
      sections.push(section);
      continue;
    }
    placed.add(section.pluginId);
    const summary = source.items.find((entry) => entry.manifest.id === section.pluginId);
    if (!summary) continue;
    sections.push({ ...section, label: manifestLabel(summary, section.label) });
  }

  for (const summary of source.items) {
    const id = summary.manifest.id;
    if (placed.has(id)) continue;
    sections.push({
      id,
      label: manifestLabel(summary, id),
      description: "Greffon enregistré par le serveur — formulaire déduit de son manifeste.",
      icon: IconStack,
      pluginId: id,
    });
  }

  return sections;
}

/** Section affichée quand aucune n'est explicitement demandée (entrée « Tous les réglages »). */
export function settingsSectionMeta(
  id: string | null,
  sections: readonly SettingsSectionMeta[] = SETTINGS_SECTIONS,
): SettingsSectionMeta {
  return sections.find((section) => section.id === id) ?? sections[0] ?? SETTINGS_SECTIONS[0]!;
}
