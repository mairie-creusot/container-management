/**
 * Actions de greffons proposables sur un nœud du graphe — dérivation PURE des manifestes chargés
 * (GET /api/plugins), sans réseau ni Redux. C'est ce qui relie une action DÉCLARÉE côté serveur
 * (PluginManifest#actions) à une entrée de menu contextuel réelle.
 *
 * Ce qui est écarté, et pourquoi :
 *  - greffon désactivé ou pas configuré : ses actions échoueraient (409/400 côté route) ;
 *  - action sans `target` : elle ne vise aucun nœud (ex. le catalogue d'images Nutanix) ;
 *  - `target.nodeKind` différent du kind du nœud ;
 *  - `target.servedByCore` renseigné : le CŒUR rend déjà cette action à l'écran (bouton, popover
 *    dédié, confirmation par saisie du nom…) — la reproposer ici la dupliquerait ;
 *  - `target.when` non satisfait par l'état RÉEL du nœud (même évaluateur que les actions du cœur,
 *    matchesNodeState — jamais une seconde règle de visibilité qui pourrait diverger).
 */

import { ApiError, apiPost } from "@/api/client";
import { matchesNodeState, type NodeStateCondition } from "@/components/topologyNodeRegistry";
import { formSchemaFromManifest, type ManifestFormResult } from "@/components/formSchemaFromManifest";
import type { PluginActionConfirmation, PluginActionSpec, PluginSummary } from "@/features/plugins/pluginsModel";
import type { TopologyNode } from "@/types";

/** Une action déclarée, résolue pour un nœud précis : tout ce qu'il faut pour l'afficher et l'exécuter. */
export interface ResolvedPluginAction {
  pluginId: string;
  pluginName: string;
  actionId: string;
  /** Libellé de l'entrée de menu, tel que déclaré (`target.menuLabel`). */
  label: string;
  severity: "safe" | "caution" | "destructive";
  confirm: PluginActionConfirmation | undefined;
  /** Schéma d'entrée brut — `undefined` = l'action n'a aucune saisie, elle s'exécute au clic. */
  input: unknown;
}

function severityOf(spec: PluginActionSpec): "safe" | "caution" | "destructive" {
  return spec.severity ?? "safe";
}

/**
 * Actions des greffons applicables à CE nœud, dans l'ordre de déclaration de chaque manifeste
 * (greffons triés par identifiant, comme les rend l'API) — jamais un ordre recalculé au rendu.
 */
export function pluginActionsForNode(plugins: readonly PluginSummary[], node: TopologyNode): ResolvedPluginAction[] {
  const resolved: ResolvedPluginAction[] = [];
  for (const summary of plugins) {
    if (!summary.enabled || !summary.configured) continue;
    const declared = summary.manifest.actions;
    if (!declared) continue;

    for (const [actionId, spec] of Object.entries(declared)) {
      const target = spec.target;
      if (!target || target.servedByCore || !target.menuLabel) continue;
      if (target.nodeKind !== node.kind) continue;
      if (target.when && !matchesNodeState(node, target.when as NodeStateCondition[])) continue;

      resolved.push({
        pluginId: summary.manifest.id,
        pluginName: summary.manifest.name,
        actionId,
        label: target.menuLabel,
        severity: severityOf(spec),
        confirm: spec.confirm,
        input: spec.input,
      });
    }
  }
  return resolved;
}

/** `{cible}` -> libellé RÉEL du nœud visé. Aucun autre jeton n'est interprété. */
export function pluginActionConfirmMessage(message: string, nodeLabel: string): string {
  return message.split("{cible}").join(nodeLabel);
}

/** Formulaire déduit du schéma d'entrée — `null` si l'action n'en a aucun (exécution directe). */
export function pluginActionForm(action: ResolvedPluginAction): ManifestFormResult | null {
  if (action.input === undefined) return null;
  // Aucun champ secret dans une entrée d'action : le contrat le refuse à l'enregistrement.
  return formSchemaFromManifest(action.input, []);
}

export type PluginActionOutcome = { ok: true; result: unknown } | { ok: false; message: string };

/**
 * POST /api/plugins/:id/actions/:actionId — le CANAL d'exécution unique des actions de greffons.
 * Ne lève jamais : le message rendu est celui du serveur (refus explicite : greffon désactivé,
 * action inconnue, entrée refusée, erreur réelle de l'intégration), jamais un message inventé.
 * `nodeId` est l'identifiant de la ressource visée (uuid de VM…), sans le préfixe de kind du nœud.
 */
export async function runPluginAction(params: {
  pluginId: string;
  actionId: string;
  nodeId?: string;
  input?: Record<string, unknown>;
}): Promise<PluginActionOutcome> {
  const { pluginId, actionId, nodeId, input } = params;
  const path = `/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}`;
  try {
    const response = await apiPost<{ ok?: boolean; result?: unknown }>(path, {
      ...(nodeId !== undefined ? { nodeId } : {}),
      input: input ?? {},
    });
    return { ok: true, result: response?.result ?? null };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Action impossible." };
  }
}
