import { useMemo, type ComponentType } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { canAdminister } from "@/features/auth/authSlice";
import { openSettingsSection, pageTitle, setCurrentView } from "@/features/ui/uiSlice";
import { resetSetup } from "@/features/setup/setupSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { IconInfo, IconSettings } from "@/components/icons";
import {
  buildSettingsSections,
  settingsSectionMeta,
  type SettingsSectionMeta,
} from "@/features/settings/settingsSections";
import PluginEnableCard from "@/features/settings/PluginEnableCard";
import PluginSettingsSection from "@/features/settings/PluginSettingsSection";
import AdDnsConfigSection, { LdapAccountDiagnosticSection } from "@/features/adDns/AdDnsConfigSection";
import ThreecxConfigSection from "@/features/threecx/ThreecxConfigSection";
import GlpiConfigSection from "@/features/glpi/GlpiConfigSection";
import NotificationChannelsSection from "@/features/notificationChannels/NotificationChannelsSection";
import CertificateAuthorityForm from "@/features/certificates/CertificateAuthorityForm";

/** Assistant de premier lancement (LDAP, Docker/Kubernetes, registries) — la seule configuration
 * qui n'a pas de formulaire propre dans l'application : elle se rejoue en rouvrant l'assistant.
 * Bouton déplacé du menu utilisateur du Topbar le 24/08/2026. */
function SetupWizardSection() {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();

  async function handleReconfigure() {
    const ok = await confirm({
      title: "Reconfigurer QUAI",
      description:
        "Rouvre l'assistant de configuration (LDAP, Docker, Kubernetes, registries). L'application redevient inaccessible aux autres utilisateurs tant que l'assistant n'est pas terminé.",
      confirmLabel: "Reconfigurer",
      variant: "danger",
    });
    if (ok) dispatch(resetSetup());
  }

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Assistant de configuration</h3>
          <p>
            Annuaire LDAP, orchestrateurs (Docker, Kubernetes) et registries d'images ont été renseignés au premier
            lancement. Les rejouer suppose de rouvrir l'assistant complet.
          </p>
        </div>
      </div>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0 }}>
          Tant que l'assistant n'est pas terminé, l'application redevient inaccessible aux autres utilisateurs — y
          compris à ceux qui sont déjà connectés.
        </p>
        <div>
          <button type="button" className="btn btn-ghost" onClick={handleReconfigure}>
            Rouvrir l'assistant (LDAP, Docker, registries…)
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Emplacement RÉSERVÉ d'une intégration dont le formulaire est extrait par ailleurs : rien n'est
 * dupliqué ici en attendant, et la section renvoie vers la page qui porte encore le réglage.
 * Voir SectionBody ci-dessous pour la ligne exacte à brancher par intégration.
 */
function PendingSection({ meta }: { meta: SettingsSectionMeta }) {
  const dispatch = useAppDispatch();
  const target = meta.pendingOn;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>{meta.label}</h3>
          <p>{meta.description}</p>
        </div>
      </div>
      <div className="empty-state">
        <IconInfo />
        <strong>Emplacement réservé</strong>
        <span>
          Le formulaire de cette intégration n'est pas encore monté ici — aucun doublon n'a été créé en attendant.
        </span>
        {target && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => dispatch(setCurrentView(target))}
          >
            Ouvrir {pageTitle(target)}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Greffons dont le formulaire reste écrit à la main : leur manifeste ne porte pas encore tout ce
 * que l'écran actuel montre (3CX : conditions de licence XAPI ; GLPI : vérification des options de
 * recherche). L'interrupteur, lui, est le générique — le formulaire seul est propre à l'intégration.
 */
const HAND_WRITTEN_PLUGIN_FORMS: Record<string, ComponentType> = {
  "3cx": ThreecxConfigSection,
  glpi: GlpiConfigSection,
};

function PluginSection({ pluginId }: { pluginId: string }) {
  const HandWritten = HAND_WRITTEN_PLUGIN_FORMS[pluginId];
  if (!HandWritten) return <PluginSettingsSection pluginId={pluginId} />;
  return (
    <>
      <PluginEnableCard pluginId={pluginId} />
      <HandWritten />
    </>
  );
}

function SectionBody({ meta }: { meta: SettingsSectionMeta }) {
  if (meta.pluginId !== undefined) return <PluginSection pluginId={meta.pluginId} />;
  if (meta.pendingOn) return <PendingSection meta={meta} />;
  switch (meta.id) {
    case "setup":
      return <SetupWizardSection />;
    case "ad-dns":
      return (
        <>
          <AdDnsConfigSection />
          <LdapAccountDiagnosticSection />
        </>
      );
    case "certificates":
      return <CertificateAuthorityForm />;
    case "notification-channels":
      return <NotificationChannelsSection />;
    default:
      return <PendingSection meta={meta} />;
  }
}

/**
 * Page Réglages — TOUTES les configurations d'intégration au même endroit, réservée aux
 * administrateurs. Les sections de greffons viennent de GET /api/plugins et leur formulaire est
 * déduit du manifeste ; les autres montent le composant de configuration du cœur.
 */
export default function SettingsPage() {
  const dispatch = useAppDispatch();
  const session = useAppSelector((s) => s.auth.session);
  const activeId = useAppSelector((s) => s.ui.settingsSection);
  const plugins = useAppSelector((s) => s.plugins);
  const sections = useMemo(() => buildSettingsSections(plugins), [plugins]);
  const admin = canAdminister(session);

  if (!admin) {
    return (
      <div className="workspace">
        <div className="page-content">
          <div className="empty-state">
            <IconSettings />
            <strong>Réglages réservés aux administrateurs</strong>
            <span>Les intégrations (Nutanix, DNS AD, téléphonie, GLPI…) ne se configurent qu'avec le rôle admin.</span>
          </div>
        </div>
      </div>
    );
  }

  const active = settingsSectionMeta(activeId, sections);

  return (
    <div className="workspace">
      <div className="page-content settings-layout">
        <nav className="settings-rail" aria-label="Réglages par intégration">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className={`settings-rail__item${section.id === active.id ? " is-active" : ""}`}
                onClick={() => dispatch(openSettingsSection(section.id))}
                aria-current={section.id === active.id}
              >
                <span className="settings-rail__icon">
                  <Icon />
                </span>
                <span className="settings-rail__label">{section.label}</span>
              </button>
            );
          })}
        </nav>

        <section className="settings-panel">
          <SectionBody meta={active} />
          {/* Renvoi vers la page qui CONSOMME ce réglage — les données restent là-bas, seule la
              configuration vit ici. Masqué pour une section encore portée par sa page (le renvoi
              est déjà le contenu principal de PendingSection). */}
          {active.relatedView && !active.pendingOn && (
            <div className="settings-panel__related">
              <span>Données correspondantes :</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dispatch(setCurrentView(active.relatedView!))}
              >
                {pageTitle(active.relatedView)}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
