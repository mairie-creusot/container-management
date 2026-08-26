import { useEffect, useId } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import StatusPill from "@/components/StatusPill";
import {
  fetchPluginConfig,
  fetchPlugins,
  pluginConfigOf,
  setPluginEnabled,
} from "@/features/plugins/pluginsSlice";

/**
 * Interrupteur Activer/Désactiver d'un module — la seule bascule, commune à la section générée et
 * aux sections encore écrites à la main. Elle vaut aussi pour un module jamais configuré : c'est cet
 * état qui empêche son code d'être chargé, le refuser rendrait l'interrupteur inopérant là où il
 * compte le plus, sur un module fraîchement installé.
 */
export default function PluginEnableCard({ pluginId }: { pluginId: string }) {
  const dispatch = useAppDispatch();
  const toggleId = useId();
  const summary = useAppSelector((state) => state.plugins.items.find((entry) => entry.manifest.id === pluginId));
  const entry = useAppSelector((state) => pluginConfigOf(state.plugins, pluginId));

  // Seule amorce de la lecture : cette carte est rendue par les deux formes de section.
  useEffect(() => {
    if (entry.status === "idle") void dispatch(fetchPluginConfig(pluginId));
  }, [dispatch, pluginId, entry.status]);

  // La vue de configuration fait foi dès qu'elle a répondu : elle est plus fraîche que la liste.
  const known = entry.status === "ready";
  const configured = known ? entry.configured : (summary?.configured ?? false);
  const enabled = known ? entry.enabled : (summary?.enabled ?? false);

  async function toggle(next: boolean) {
    const action = await dispatch(setPluginEnabled({ pluginId, enabled: next }));
    // La liste alimente le menu latéral : à redemander pour que la page du greffon suive la bascule.
    if (setPluginEnabled.fulfilled.match(action) && action.payload.ok) void dispatch(fetchPlugins());
  }

  return (
    <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="chip-row">
        <StatusPill status={configured ? "ok" : "unconfigured"} label={configured ? "Configuré" : "Non configuré"} />
        <StatusPill status={enabled ? "ok" : "paused"} label={enabled ? "Activé" : "Désactivé"} />
      </div>

      <label className="filter-toggle" htmlFor={toggleId} style={{ marginBottom: 0 }}>
        <input
          id={toggleId}
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={entry.toggling}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{entry.toggling ? "Bascule en cours…" : "Module activé"}</span>
      </label>

      <p className="create-container-hint" style={{ margin: 0 }}>
        Désactiver met le module en pause sans toucher à sa configuration : il n'interroge plus rien et ses pages
        quittent le menu.
      </p>

      {!configured && (
        <p className="create-container-hint" style={{ margin: 0 }}>
          Ce module n'a aucune configuration enregistrée : activé, il reste chargé mais n'a rien à interroger tant
          que la connexion n'a pas été renseignée ici.
        </p>
      )}

      {entry.enabledError && (
        <div className="error-banner" role="alert">
          {entry.enabledError}
        </div>
      )}
    </div>
  );
}
