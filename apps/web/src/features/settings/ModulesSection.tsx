import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { useConfirm } from "@/components/ConfirmProvider";
import StatusPill from "@/components/StatusPill";
import { IconCheck, IconInfo, IconPuzzle } from "@/components/icons";
import { openSettingsSection } from "@/features/ui/uiSlice";
import { fetchPlugins, setPluginEnabled } from "@/features/plugins/pluginsSlice";
import { pluginContributions } from "@/features/plugins/pluginsModel";
import {
  fetchModuleInventory,
  installModule,
  restoreModule,
  uninstallModule,
} from "@/features/plugins/pluginInstallApi";
import {
  deriveModuleRows,
  moduleInstallAvailability,
  moduleIsTrusted,
  moduleOriginLabel,
  moduleRestorable,
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

/**
 * Interrupteur d'un module. Il ne prétend jamais commander ce qu'il ne commande pas : tant que la
 * liste des modules chargés n'a pas répondu, il n'affirme aucun état ; et un module que le serveur
 * n'a pas chargé le rend inerte, avec le motif juste en dessous.
 */
function ModuleSwitch({
  row,
  ready,
  busy,
  onToggle,
}: {
  row: ModuleRow;
  ready: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const id = useId();
  const known = ready && row.enabled !== null;
  return (
    <label className={`module-switch${ready && !known ? " module-switch--unknown" : ""}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={row.enabled === true}
        disabled={busy || !known}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className="module-switch__track" aria-hidden="true" />
      <span className="module-switch__label">
        {busy ? "Bascule…" : !ready ? "Lecture…" : known ? (row.enabled ? "Activé" : "En pause") : "Non chargé"}
      </span>
    </label>
  );
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
  const [togglingId, setTogglingId] = useState<string | null>(null);
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

  /** Icône et description viennent de la section de Réglages du module — écrites une seule fois,
   * jamais recopiées ici. Un module que le serveur n'a pas chargé n'en a pas : rien n'est inventé. */
  function presentationOf(pluginId: string) {
    const meta = sections.find((section) => section.pluginId === pluginId);
    return { Icon: meta?.icon ?? IconPuzzle, description: meta?.description ?? null };
  }

  /** Ce que le module apporte — déduit de son manifeste, donc absent tant qu'il n'est pas chargé. */
  function contributionsFor(pluginId: string): string[] {
    const summary = plugins.items.find((entry) => entry.manifest.id === pluginId);
    return summary ? pluginContributions(summary.manifest) : [];
  }

  async function handleToggle(row: ModuleRow, enabled: boolean) {
    setTogglingId(row.id);
    setActionError(null);
    setNotice(null);
    const action = await dispatch(setPluginEnabled({ pluginId: row.id, enabled }));
    setTogglingId(null);
    if (setPluginEnabled.fulfilled.match(action) && !action.payload.ok) {
      setActionError(action.payload.reason);
      return;
    }
    setNotice(
      enabled
        ? `Module « ${row.name} » activé : son code est chargé et ses données reviennent.`
        : `Module « ${row.name} » mis en pause : son code n'est plus chargé, ses pages et ses données quittent QUAI.`,
    );
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

  async function handleRestore(row: ModuleRow) {
    setBusyId(row.id);
    setActionError(null);
    setNotice(null);
    const outcome = await restoreModule(row.id);
    setBusyId(null);
    if (!outcome.ok) {
      setActionError(outcome.reason);
      return;
    }
    setNotice(`Module « ${row.name} » réinstallé depuis l'image — sa configuration est à ressaisir.`);
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

      <div className="modules-grid">
        {rows.map((row) => {
          const trusted = moduleIsTrusted(row);
          const refused = row.trust === "untrusted";
          const removed = row.state === "removed";
          const sectionId = sectionIdFor(row.id);
          const removable = moduleUninstallable(row, source);
          const restorable = moduleRestorable(row, source);
          // Renvoi vers la configuration : seulement si le serveur a réellement chargé ce module.
          const configurable = sectionId !== null && !refused && !removed;
          const contributions = contributionsFor(row.id);
          const { Icon, description } = presentationOf(row.id);
          // Installé, signature vérifiée, et pourtant inconnu de GET /api/plugins : le serveur ne l'a
          // pas chargé. C'est le seul cas où « installé » et « présent dans l'interface » divergent —
          // et il n'est affirmé qu'une fois la liste des modules chargés réellement obtenue.
          const notLoaded = plugins.status === "ready" && !removed && !refused && row.enabled === null;
          // Un module livré et jamais retiré n'a ni clé ni trace d'installation à montrer : sa liste
          // de détails serait vide et n'ajouterait qu'un blanc dans la carte.
          const hasMeta =
            removed ||
            row.signer !== null ||
            row.signedBy !== null ||
            row.certificateFingerprint !== null ||
            row.revocation !== null ||
            row.installedAt !== null ||
            row.installedBy !== null;

          return (
            <article
              key={row.id}
              className={`card module-card${refused ? " module-card--untrusted" : ""}${removed ? " module-card--removed" : ""}`}
            >
              <div className="module-card__head">
                <span className="module-card__icon" aria-hidden="true">
                  <Icon />
                </span>
                <div className="module-card__identity">
                  <h4 className="module-card__name">{row.name}</h4>
                  <span className="module-card__id">
                    {row.id}
                    {row.version !== null && ` · v${row.version}`}
                  </span>
                </div>
                {/* Ni pour un module retiré, ni pour un paquet refusé : rien n'est chargé dans les
                    deux cas, un interrupteur y serait un mensonge. */}
                {!removed && !refused && (
                  <ModuleSwitch
                    row={row}
                    ready={plugins.status === "ready"}
                    busy={togglingId === row.id}
                    onToggle={(enabled) => void handleToggle(row, enabled)}
                  />
                )}
              </div>

              <div className="chip-row">
                {removed ? (
                  <StatusPill status="paused" label="Désinstallé" />
                ) : (
                  <>
                    <StatusPill status="neutral" label={moduleOriginLabel(row.origin)} />
                    <StatusPill status={trustPillStatus(row.trust)} label={moduleTrustLabel(row.trust)} />
                    <StatusPill
                      status={row.configured === null ? "neutral" : row.configured ? "ok" : "unconfigured"}
                      label={row.configured === null ? "Configuration inconnue" : row.configured ? "Configuré" : "Non configuré"}
                    />
                  </>
                )}
              </div>

              {description !== null && <p className="module-card__description">{description}</p>}

              {contributions.length > 0 && (
                <p className="module-card__contributions">
                  <span>Apporte</span> {contributions.join(" · ")}
                </p>
              )}

              {hasMeta && (
                <dl className="module-card__meta">
                  {removed ? (
                    <>
                      <div>
                        <dt>Désinstallé le</dt>
                        <dd>{row.removedAt !== null ? formatDate(row.removedAt) : MISSING}</dd>
                      </div>
                      <div>
                        <dt>Par</dt>
                        <dd>{row.removedBy ?? MISSING}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Un module signé par certificat dit QUI l'a signé ; une clé nue ne le dit
                          jamais, et rien n'est inventé à sa place. */}
                      {row.signer !== null && (
                        <div>
                          <dt>Signé par</dt>
                          <dd>{row.signer}</dd>
                        </div>
                      )}
                      {row.signedBy !== null && (
                        <div>
                          <dt>{row.signer !== null ? "Autorité" : "Clé de signature"}</dt>
                          <dd>{row.signedBy}</dd>
                        </div>
                      )}
                      {/* C'est cette empreinte qu'on pose dans PLUGIN_REVOKED_CERTS pour retirer ce
                          signataire : sans elle à l'écran, la révocation resterait théorique. */}
                      {row.certificateFingerprint !== null && (
                        <div>
                          <dt>Empreinte</dt>
                          <dd>{row.certificateFingerprint}</dd>
                        </div>
                      )}
                      {/* « Non vérifiée » n'est PAS « saine » : le motif accompagne toujours l'état,
                          sinon une liste absente se lirait comme un feu vert. */}
                      {row.revocation !== null && (
                        <div>
                          <dt>Révocation</dt>
                          <dd>
                            {row.revocation === "clear"
                              ? "vérifiée auprès de l'autorité"
                              : `non vérifiée — ${row.revocationReason ?? "motif non communiqué"}`}
                          </dd>
                        </div>
                      )}
                      {row.installedAt !== null && (
                        <div>
                          <dt>Installé le</dt>
                          <dd>{formatDate(row.installedAt)}</dd>
                        </div>
                      )}
                      {row.installedBy !== null && (
                        <div>
                          <dt>Installé par</dt>
                          <dd>{row.installedBy}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
              )}

              {refused && (
                <div className="error-banner" role="alert">
                  {row.reason ?? "Le serveur n'a pas communiqué le motif du refus."}
                </div>
              )}

              {notLoaded && (
                <div className="error-banner" role="alert">
                  Ce module est installé mais le serveur ne l'a pas chargé : il n'apporte ni page, ni section de
                  réglages, ni données. Le motif est dans le journal du serveur (« greffons »).
                </div>
              )}

              {removed && (
                <p className="create-container-hint" style={{ margin: 0 }}>
                  Son paquet est resté dans l'image : le réinstaller le remet en place, sans sa configuration.
                </p>
              )}

              {!trusted && !removed && (
                <p className="create-container-hint" style={{ margin: 0 }}>
                  {refused
                    ? "Confiance non établie : ce module n'est proposé ni à l'installation ni à l'activation depuis cet écran."
                    : "État de confiance non communiqué par le serveur : la signature de ce module n'est pas présentée comme vérifiée."}
                </p>
              )}

              {(configurable || removable || restorable) && (
                <div className="module-card__actions">
                  {configurable && sectionId !== null && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => dispatch(openSettingsSection(sectionId))}
                    >
                      Configurer
                    </button>
                  )}
                  {restorable && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleRestore(row)}
                      disabled={busyId === row.id}
                    >
                      {busyId === row.id ? "Réinstallation…" : "Réinstaller"}
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
