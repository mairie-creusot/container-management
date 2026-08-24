import NotificationChannelsSection from "@/features/notificationChannels/NotificationChannelsSection";

/**
 * Page « Canaux de notification » du menu latéral — enveloppe seulement la section partagée
 * (NotificationChannelsSection.tsx), qui est aussi montée par la page Réglages : un seul
 * formulaire, une seule source de vérité.
 */
export default function NotificationChannelsPage() {
  return (
    <div className="workspace">
      <div className="page-content">
        <NotificationChannelsSection />
      </div>
    </div>
  );
}
