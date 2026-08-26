import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { useConfirm } from "@/components/ConfirmProvider";
import KeyValueList, { type KeyValueRow } from "@/components/KeyValueList";
import StatusPill from "@/components/StatusPill";
import { IconCheck, IconInfo } from "@/components/icons";
import { openSettingsSection } from "@/features/ui/uiSlice";
import { fetchPlugins } from "@/features/plugins/pluginsSlice";
import { fetchModuleInventory, installModule, uninstallModule } from "@/features/plugins/pluginInstallApi";
import {
  deriveModuleRows,
  moduleInstallAvailability,
  moduleIsTrusted,
  moduleOriginLabel,
  moduleTrustLabel,
  moduleUninstallable,
  type ModuleInventorySource,
  type ModuleRow,
  type ModuleTrust,
} from "@/features/plugins/pluginInstallModel";
import { buildSettingsSections } from "@/features/settings/settingsSections";

const MISSING = "—";

function trustPillStatus(trust: ModuleTrust): string {
  if (trust === "verified") return "ok";
  if (trust === "untrusted") return "crit";
  if (trust === "unknown") return "warn";
  return "neutral";
}

function activationLabel(enabled: boolean | null): string {
  if (enabled === null) return "Activation non communiquée";
  return enabled ? "Activé" : "Désactivé";
}

function configurationLabel(configured: boolean | null): string {
  if (configured === null) return "Non communiquée";
  return configured ? "Enregistrée" : "Aucune";
}

/** Même format de date que le reste de l'application ; une date illisible reste affichée telle
 * quelle plutôt que remplacée. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function detailRows(row: ModuleRow): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: "Identifiant", value: row.id },
    { key: "Version", value: row.version ?? MISSING },
    { key: "Configuration", value: configurationLabel(row.configured) },
  ];
  if (row.signedBy !== null) rows.push({ key: "Clé de signature", value: row.signedBy });
  if (row.installedAt !== null) rows.push({ key: "Installé le", value: formatDate(row.installedAt) });
  if (row.installedBy !== null) rows.push({ key: "Installé par", value: row.installedBy });
  return rows;
}

/**
 * Écran des Modules : ce que le serveur a réellement chargé, d'où il vient, si sa signature a été
 * vérifiée et par quelle clé. L'inventaire et l'installation viennent de routes d'administration
 * distinctes de GET /api/plugins — absentes, l'écran retombe sur les seuls modules exposés, sans
 * jamais leur prêter une origine ni une confiance.
 */
export default function ModulesSection() {
  const dispatch = useAppDispatch();
  const confirm = useConfirm();
  const plugins = useAppSelector((state) => state.plugins);

  const [source, setSource] = useState<ModuleInventorySource>({ status: "loading" });
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setSource(await fetchModuleInventory());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (plugins.status === "idle") void dispatch(fetchPlugins());
  }, [dispatch, plugins.status]);

  const rows = useMemo(() => deriveModuleRows(source, plugins), [source, plugins]);
  const sections = useMemo(() => buildSettingsSections(plugins), [plugins]);
  const availability = moduleInstallAvailability(source);
  const inventory = source.status === "ready" ? source.inventory : null;

  function sectionIdFor(pluginId: string): string | null {
    return sections.find((section) => section.pluginId === pluginId)?.id ?? null;
  }

  async function handleUninstall(row: ModuleRow) {
    const ok = await confirm({
      title: `Désinstaller ${row.name} ?`,
      description:
        row.configured === true
          ? "Ce module est configuré : sa configuration enregistrée, identifiants compris, sera perdue. Ses pages et les données qu'il apporte quittent QUAI. Rien n'est modifié du côté de l'intégration."
          : "Le module est retiré du serveur : ses pages et les données qu'il apporte quittent QUAI. Rien n'est modifié du côté de l'intégration.",
      confirmLabel: "Désinstaller",
      variant: "danger",
    });
    if (!ok) return;

    setBusyId(row.id);
    setActionError(null);
    setNotice(null);
    const outcome = await uninstallModule(row.id);
    setBusyId(null);
    if (!outcome.ok) {
      setActionError(outcome.reason);
      return;
    }
    setNotice(`Module « ${row.name} » désinstallé.`);
    await reload();
    void dispatch(fetchPlugins());
  }

  async function handleInstall(event: FormEvent) {
    event.preventDefault();
    if (!packageFile) return;

    setInstalling(true);
    setActionError(null);
    setNotice(null);

    let envelope: unknown;
    try {
      envelope = JSON.parse(await packageFile.text());
    } catch {
      setInstalling(false);
      setActionError("Ce fichier n'est pas un paquet de module exploitable : un paquet signé au format JSON est attendu.");
      return;
    }

    const outcome = await installModule(envelope);
    setInstalling(false);
    if (!outcome.ok) {
      setActionError(outcome.reason);
      return;
    }
    setPackageFile(null);
    setNotice("Installation acceptée par le serveur.");
    await reload();
    void dispatch(fetchPlugins());
  }

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Modules</h3>
          <p>
            Modules livrés avec l'application et modules installés : version, origine, état de confiance de leur
            signature et activation. La vérification de signature est faite par le serveur, jamais ici.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          Actualiser
        </button>
      </div>

      {source.status === "unavailable" && (
        <div className="card module-notice" style={{ marginBottom: 16 }}>
          <strong>Inventaire des modules indisponible</strong>
          <p style={{ margin: 0 }}>
            Ce serveur ne publie pas l'inventaire des modules installés : origine et état de confiance ne sont pas
            connus ici, et rien n'est supposé à leur place. Les modules ci-dessous sont ceux que le serveur expose
            déjà.
          </p>
          <p className="create-container-hint" style={{ margin: 0 }}>
            {source.reason}
          </p>
        </div>
      )}

      {availability === "no-trust-key" && (
        <div className="card module-notice module-notice--caution" style={{ marginBottom: 16 }} role="alert">
          <strong>Installation de modules externes indisponible</strong>
          <p style={{ margin: 0 }}>
            Aucune clé de confiance n'est configurée sur le serveur : il ne peut vérifier la signature d'aucun paquet,
            donc aucune installation n'est proposée ici.
          </p>
        </div>
      )}

      {availability === "unsupported" && (
        <div className="card module-notice" style={{ marginBottom: 16 }}>
          <strong>Installation non proposée par ce serveur</strong>
          <p style={{ margin: 0 }}>
            Le serveur publie son inventaire mais n'accepte pas l'installation de modules : seuls les modules déjà
            présents sont administrables ici.
          </p>
        </div>
      )}

      {inventory !== null && inventory.trustKeys.length > 0 && (
        <div className="card module-notice" style={{ marginBottom: 16 }}>
          <strong>Clés de confiance configurées</strong>
          <div className="chip-row">
            {inventory.trustKeys.map((key) => (
              <span key={key} className="module-key">
                {key}
              </span>
            ))}
          </div>
        </div>
      )}

      {actionError && (
        <div className="error-banner" role="alert" style={{ marginBottom: 16 }}>
          {actionError}
        </div>
      )}

      {notice && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          <IconCheck />
          {notice}
        </div>
      )}

      {source.status === "loading" && <div className="empty-state">Lecture de l'inventaire des modules…</div>}

      {source.status !== "loading" && rows.length === 0 && (
        <div className="empty-state">
          <IconInfo />
          <strong>Aucun module connu</strong>
          <span>Le serveur n'expose aucun module : rien n'est listé à sa place.</span>
        </div>
      )}

      <div className="modules-list">
        {rows.map((row) => {
          const trusted = moduleIsTrusted(row);
          const refused = row.trust === "untrusted";
          const sectionId = sectionIdFor(row.id);
          const removable = moduleUninstallable(row, source);
          // Renvoi vers la configuration : seulement si le serveur a réellement chargé ce module.
          const configurable = sectionId !== null && !refused;
          return (
            <article key={row.id} className={`card module-card${refused ? " module-card--untrusted" : ""}`}>
              <div className="module-card__head">
                <h4 className="module-card__name">{row.name}</h4>
                <div className="chip-row">
                  <StatusPill status="neutral" label={moduleOriginLabel(row.origin)} />
                  <StatusPill status={trustPillStatus(row.trust)} label={moduleTrustLabel(row.trust)} />
                  <StatusPill
                    status={row.enabled === null ? "neutral" : row.enabled ? "ok" : "paused"}
                    label={activationLabel(row.enabled)}
                  />
                </div>
              </div>

              <KeyValueList rows={detailRows(row)} />

              {refused && (
                <div className="error-banner" role="alert">
                  {row.reason ?? "Le serveur n'a pas communiqué le motif du refus."}
                </div>
              )}

              {!trusted && (
                <p className="create-container-hint" style={{ margin: 0 }}>
                  {refused
                    ? "Confiance non établie : ce module n'est proposé ni à l'installation ni à l'activation depuis cet écran."
                    : "État de confiance non communiqué par le serveur : la signature de ce module n'est pas présentée comme vérifiée."}
                </p>
              )}

              {(configurable || removable) && (
                <div style={{ display: "flex", gap: 8 }}>
                  {configurable && sectionId !== null && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => dispatch(openSettingsSection(sectionId))}
                    >
                      Configurer
                    </button>
                  )}
                  {removable && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleUninstall(row)}
                      disabled={busyId === row.id}
                    >
                      {busyId === row.id ? "Désinstallation…" : "Désinstaller"}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {availability === "ready" && (
        <form className="card module-install" onSubmit={handleInstall}>
          <div>
            <strong>Installer un module</strong>
            <p className="create-container-hint" style={{ margin: "4px 0 0" }}>
              Le serveur vérifie la signature du paquet avec ses clés de confiance avant toute installation : un
              paquet qu'il ne peut vérifier est refusé, et rien n'est installé.
            </p>
          </div>
          <div className="field">
            <label htmlFor="module-install-package">Paquet signé du module</label>
            <input
              id="module-install-package"
              type="file"
              accept=".json,application/json"
              disabled={installing}
              onChange={(event) => setPackageFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={installing || packageFile === null}>
              {installing ? "Installation…" : "Installer"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
