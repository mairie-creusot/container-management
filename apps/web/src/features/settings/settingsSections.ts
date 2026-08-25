import type { ComponentType } from "react";
import type { ViewId } from "@/features/ui/uiSlice";
import {
  IconBackup,
  IconBell,
  IconCertificate,
  IconLifebuoy,
  IconPhone,
  IconServer,
  IconSettings,
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
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "setup",
    label: "Assistant de configuration",
    description: "LDAP, orchestrateurs Docker/Kubernetes et registries — rouvre l'assistant de premier lancement.",
    icon: IconSettings,
  },
  {
    id: "nutanix",
    label: "Nutanix",
    description: "Prism Central : clusters, hôtes AHV et VMs réels.",
    icon: IconVm,
    relatedView: "clusters",
  },
  {
    id: "ad-dns",
    label: "DNS Active Directory",
    description: "Synchronisation dynamique GSS-TSIG et diagnostic des comptes de l'annuaire.",
    icon: IconServer,
    relatedView: "publication",
  },
  {
    id: "threecx",
    label: "Téléphonie 3CX",
    description: "Accès en lecture seule au XAPI du PBX.",
    icon: IconPhone,
    relatedView: "threecx",
  },
  {
    id: "glpi",
    label: "Assistance GLPI",
    description: "API REST de GLPI : tickets et réconciliation d'inventaire.",
    icon: IconLifebuoy,
    relatedView: "glpi",
  },
  {
    id: "hycu",
    label: "Sauvegardes HYCU",
    description: "Contrôleur de sauvegarde HYCU (lecture seule).",
    icon: IconBackup,
    relatedView: "backups",
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

/** Section affichée quand aucune n'est explicitement demandée (entrée « Tous les réglages »). */
export function settingsSectionMeta(id: string | null): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0]!;
}
