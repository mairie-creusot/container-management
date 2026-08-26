/**
 * DÉLAIS D'EXPIRATION des appels aux greffons — posés une seule fois, à l'enregistrement
 * (plugins/registry.ts), donc valables pour TOUS les appelants : routes génériques, construction du
 * graphe, instantanés, actions.
 *
 * Sans isolation hors processus, le code d'un greffon s'exécute dans ce process : un `fetch` sans
 * timeout, une boucle qui ne rend jamais la main, et c'est le graphe entier qui se fige. Un appel
 * qui dépasse son délai est ABANDONNÉ (l'appelant reçoit un refus daté), tracé, et le greffon
 * traité comme non contributif. La promesse abandonnée continue peut-être de vivre — on ne peut pas
 * la tuer sans isolation — mais plus personne ne l'attend, et son rejet éventuel est absorbé.
 */

import type { Plugin, PluginAction, PluginGraphContribution } from "@quai/plugin-contract";
import { config } from "../config.js";

export class PluginTimeoutError extends Error {
  /** Lu par les routes génériques (routes/plugins.ts) : un greffon muet est une passerelle muette. */
  readonly httpStatus = 504;
  readonly pluginId: string;

  constructor(pluginId: string, what: string, ms: number) {
    super(`Le greffon "${pluginId}" n'a pas répondu en ${Math.round(ms / 100) / 10} s (${what}) : appel abandonné.`);
    this.name = "PluginTimeoutError";
    this.pluginId = pluginId;
  }
}

async function withTimeout<T>(pluginId: string, what: string, ms: number, run: () => Promise<T> | T): Promise<T> {
  const started = Promise.resolve().then(run);
  // L'appel abandonné ne doit pas remonter plus tard en rejet non traité et tuer le process.
  started.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new PluginTimeoutError(pluginId, what, ms);
          console.warn(`[greffons] ${error.message}`);
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Le second temps de la contribution au graphe est un appel comme un autre : il s'expire aussi. */
function guardContributionLink(pluginId: string, contribution: PluginGraphContribution, ms: number): PluginGraphContribution {
  const link: unknown = (contribution as { link?: unknown } | null | undefined)?.link;
  if (typeof link !== "function") return contribution;

  const original = link as NonNullable<PluginGraphContribution["link"]>;
  return {
    ...contribution,
    link: async (context) => await withTimeout(pluginId, "liens vers les autres greffons", ms, () => original.call(contribution, context)),
  };
}

/**
 * Copie du greffon dont chaque appel du contrat est borné dans le temps. Le manifeste, lui, n'est
 * pas touché : c'est la même identité, avec des appels qui rendent la main.
 */
export function guardPluginCalls(plugin: Plugin): Plugin {
  const id = plugin.manifest.id;
  const delays = config.plugins;

  const guarded: Plugin = {
    ...plugin,
    test: async (candidate) => await withTimeout(id, "test de connexion", delays.testTimeoutMs, () => plugin.test(candidate)),
    snapshot: async (candidate) => await withTimeout(id, "instantané", delays.snapshotTimeoutMs, () => plugin.snapshot(candidate)),
  };

  const graph = plugin.graph;
  if (graph) {
    guarded.graph = async (candidate) => {
      const contribution = await withTimeout(id, "contribution au graphe", delays.graphTimeoutMs, () => graph.call(plugin, candidate));
      return guardContributionLink(id, contribution, delays.graphTimeoutMs);
    };
  }

  const actions = plugin.actions;
  if (actions) {
    const bounded: Record<string, PluginAction> = {};
    for (const [name, action] of Object.entries(actions)) {
      bounded[name] = async (input) => await withTimeout(id, `action « ${name} »`, delays.actionTimeoutMs, () => action.call(plugin, input));
    }
    guarded.actions = bounded;
  }

  return guarded;
}
