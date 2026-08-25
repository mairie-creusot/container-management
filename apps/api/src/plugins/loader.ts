/**
 * Chargement À LA DEMANDE des greffons : le code d'une intégration n'entre dans le process que si
 * elle est réellement active.
 *
 * Règle unique, celle de plugins/activation.ts : « désactivé = mis en pause EXPLICITEMENT ». Un
 * greffon jamais configuré reste donc actif (simplement sans rien à faire) et est chargé ; un
 * greffon dont l'admin a basculé `enabled: false` n'est ni importé, ni enregistré, ni sondé.
 *
 * Robustesse : un greffon qui refuse de se charger (module introuvable, export manquant, manifeste
 * refusé par le contrat) est SIGNALÉ puis ignoré. Il ne fait jamais tomber le démarrage de l'API —
 * les trois autres intégrations, elles, doivent continuer de fonctionner.
 *
 * Ré-évaluation sans redémarrage : `refreshPluginActivation(id)` rejoue la décision pour un seul
 * greffon (à appeler juste après PUT /api/plugins/:id/enabled). Activer importe et enregistre ;
 * mettre en pause retire du registre. Le module déjà importé reste dans le cache de modules de Node
 * — impossible de l'en sortir — mais plus rien ne l'appelle.
 */

import { isPluginDisabled } from "./activation.js";
import { BUILTIN_PLUGINS } from "./builtins.js";
import type { PluginModuleEntry } from "./builtins.js";
import { hasPlugin, registerPlugin, unregisterPlugin } from "./registry.js";

export interface PluginLoadFailure {
  id: string;
  /** Motif RÉEL du refus, tel que rapporté — jamais un message générique. */
  reason: string;
}

export interface PluginLoadOutcome {
  /** Greffons actifs et réellement enregistrés à l'issue de cette passe. */
  loaded: string[];
  /** Greffons mis en pause : jamais importés. */
  paused: string[];
  failed: PluginLoadFailure[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Passes SÉRIALISÉES : le démarrage (onReady), un rafraîchissement d'activation et une
 * construction de graphe peuvent se croiser — deux imports concurrents du même greffon
 * produiraient un refus « déjà enregistré ». */
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = pending.then(task, task);
  pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Le greffon exporté par le module, refusé tout de suite si le module ne le porte pas. */
function pluginFromModule(module: unknown, entry: PluginModuleEntry): unknown {
  const exported = (module as Record<string, unknown> | null | undefined)?.[entry.exportName];
  if (exported === undefined) {
    throw new Error(`son module n'exporte pas "${entry.exportName}"`);
  }
  const manifestId = (exported as { manifest?: { id?: unknown } } | null)?.manifest?.id;
  if (manifestId !== entry.id) {
    throw new Error(`son manifeste annonce l'identifiant ${JSON.stringify(manifestId)}, attendu "${entry.id}"`);
  }
  return exported;
}

async function loadEntry(entry: PluginModuleEntry, outcome: PluginLoadOutcome): Promise<void> {
  let disabled = false;
  try {
    disabled = await isPluginDisabled(entry.id);
  } catch (err) {
    // Configuration illisible : on ne peut PAS prouver une mise en pause, et une absence de preuve
    // ne doit pas éteindre silencieusement une intégration de production.
    console.warn(`[greffons] état d'activation de "${entry.id}" illisible (${messageOf(err)}) — traité comme actif`);
  }

  if (disabled) {
    if (unregisterPlugin(entry.id)) {
      console.warn(`[greffons] "${entry.id}" mis en pause : retiré du socle, son code n'est plus consommé`);
    }
    outcome.paused.push(entry.id);
    return;
  }

  if (hasPlugin(entry.id)) {
    outcome.loaded.push(entry.id);
    return;
  }

  try {
    registerPlugin(pluginFromModule(await entry.load(), entry));
    outcome.loaded.push(entry.id);
  } catch (err) {
    const reason = messageOf(err);
    outcome.failed.push({ id: entry.id, reason });
    console.warn(`[greffons] "${entry.id}" ignoré : ${reason}`);
  }
}

async function syncEntries(entries: readonly PluginModuleEntry[], only?: string): Promise<PluginLoadOutcome> {
  const outcome: PluginLoadOutcome = { loaded: [], paused: [], failed: [] };
  for (const entry of entries) {
    if (only !== undefined && entry.id !== only) continue;
    await loadEntry(entry, outcome);
  }
  return outcome;
}

/**
 * Aligne le registre sur l'état d'activation RÉEL : importe et enregistre les greffons actifs
 * encore absents, retire ceux qui viennent d'être mis en pause. Idempotent (buildServer() est
 * appelé plusieurs fois dans une même exécution de tests) et sans exception : les échecs sont
 * rapportés dans `failed`.
 */
export async function loadActivePlugins(entries: readonly PluginModuleEntry[] = BUILTIN_PLUGINS): Promise<PluginLoadOutcome> {
  return await serialize(async () => await syncEntries(entries));
}

/**
 * Rejoue la décision pour UN greffon (ou pour tous si aucun identifiant n'est donné) — à appeler
 * après une bascule d'activation, pour qu'elle prenne effet sans redémarrage. Un identifiant hors
 * catalogue ne fait rien : il n'y a pas de module à charger pour lui.
 */
export async function refreshPluginActivation(
  pluginId?: string,
  entries: readonly PluginModuleEntry[] = BUILTIN_PLUGINS,
): Promise<PluginLoadOutcome> {
  return await serialize(async () => await syncEntries(entries, pluginId));
}

/** Garantit que les greffons actifs sont chargés avant de lire le registre (construction du graphe
 * notamment) : la même passe idempotente, résultat ignoré. */
export async function ensurePluginsLoaded(): Promise<void> {
  await loadActivePlugins();
}

/**
 * Charge et enregistre un greffon du catalogue SANS consulter son activation — réservé à
 * l'ADMINISTRATION. Un greffon en pause n'étant pas enregistré, rien ne pourrait plus le retrouver
 * pour le réactiver ni afficher son manifeste : c'est la seule porte qui rouvre ce cas, et elle ne
 * s'ouvre que sur une action explicite de l'admin (PUT /api/plugins/:id/enabled), jamais au
 * démarrage ni pendant la construction du graphe.
 *
 * `false` si l'identifiant n'est pas au catalogue ou si le module refuse de se charger (motif
 * tracé) — jamais une exception.
 *
 * Le greffon ainsi chargé ne peut PAS se faufiler dans le graphe : la construction du graphe
 * commence par `ensurePluginsLoaded()`, qui retire de nouveau tout greffon en pause avant de
 * collecter quoi que ce soit (voir services/topology.ts#collectPluginGraphParts).
 */
export async function loadPluginForAdmin(pluginId: string): Promise<boolean> {
  return await serialize(async () => {
    if (hasPlugin(pluginId)) return true;
    const entry = BUILTIN_PLUGINS.find((candidate) => candidate.id === pluginId);
    if (!entry) return false;
    try {
      registerPlugin(pluginFromModule(await entry.load(), entry));
      return true;
    } catch (err) {
      console.warn(`[greffons] "${pluginId}" non chargé pour administration : ${messageOf(err)}`);
      return false;
    }
  });
}
