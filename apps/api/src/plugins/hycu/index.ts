/**
 * Greffon HYCU — LECTURE SEULE stricte du contrôleur de sauvegarde (voir services/hycu.ts, qui
 * porte tout le savoir-faire réel : API REST /rest/v1.0 sur :8443, Basic Auth, pagination
 * pageNumber/pageSize, résumé CALCULÉ faute d'endpoint /dashboard). Ce fichier ne réimplémente
 * rien : il décrit l'intégration au socle et délègue.
 *
 * Aucune action mutante n'est exposée et `permissions.mutates: false` interdit au socle d'en
 * accepter une : l'appliance protège les VMs de production de la mairie, le service n'émet que des
 * GET.
 *
 * PREMIÈRE intégration qui contribue au GRAPHE (voir graph.ts) : nœud "hycu-appliance" et arêtes
 * de sauvegarde VM -> appliance.
 */

import type {
  Plugin,
  PluginGraphContribution,
  PluginTestResult,
  ServiceModuleSnapshot,
  ServiceModuleSummaryItem,
  ServiceModuleTone,
} from "@quai/plugin-contract";
import { getHycuStatus, testHycuConnection } from "../../services/hycu.js";
import { hycuConfigStore, HYCU_PLUGIN_ID, HYCU_SECRET_FIELDS, isHycuConfigComplete, parseHycuConfig } from "./config.js";
import { HYCU_GRAPH_NODE_KIND, hycuGraphContribution } from "./graph.js";

/** Même vocabulaire que le formulaire des Réglages (features/hycu/HycuConnectionForm.tsx). */
const NOT_CONFIGURED_MESSAGE =
  "Intégration HYCU non configurée — renseignez l'URL du contrôleur, l'utilisateur et le mot de passe dans les Réglages.";
const UNREACHABLE_MESSAGE = "Contrôleur HYCU injoignable — aucune donnée de sauvegarde n'est disponible.";

function emptySnapshot(status: "not-configured" | "unreachable", message: string): ServiceModuleSnapshot {
  return {
    moduleId: HYCU_PLUGIN_ID,
    generatedAt: new Date().toISOString(),
    status,
    message,
    summary: [],
    entities: [],
    relations: [],
  };
}

const JOB_TONES: Record<string, ServiceModuleTone> = { ERROR: "critical", WARNING: "warning", OK: "ok" };

export const hycuPlugin: Plugin = {
  manifest: {
    id: HYCU_PLUGIN_ID,
    name: "Sauvegarde HYCU",
    version: "1.0.0",
    coreApi: "^1.0",
    // Le formulaire de apps/web/src/features/hycu/HycuConnectionForm.tsx, champ pour champ.
    configSchema: {
      type: "object",
      title: "Contrôleur de sauvegarde (HYCU)",
      properties: {
        url: {
          type: "string",
          title: "URL du contrôleur HYCU",
          description: "Adresse de l'API REST du contrôleur — QUAI ajoute lui-même le préfixe /rest/v1.0.",
          examples: ["https://172.20.0.100:8443"],
        },
        username: {
          type: "string",
          title: "Utilisateur",
          description: "Compte HYCU en lecture : QUAI n'émet que des GET, aucune sauvegarde ni restauration.",
        },
        password: {
          type: "string",
          title: "Mot de passe",
        },
      },
      required: ["url", "username", "password"],
      additionalProperties: false,
    },
    secretFields: [...HYCU_SECRET_FIELDS],
    // Aucun hôte fixe : l'appliance jointe est celle de `url`, saisie par l'admin. Le contrat ne
    // sait pas exprimer « l'hôte que l'admin a saisi » — déclarer une valeur ici serait inventé.
    permissions: { network: [], mutates: false, graphNodeKinds: [HYCU_GRAPH_NODE_KIND] },
    // Aucune action exposée, donc aucun libellé d'audit : le greffon est en lecture seule.
    auditLabels: {},
  },

  configStore: hycuConfigStore,

  async test(config: unknown): Promise<PluginTestResult> {
    const parsed = parseHycuConfig(config);
    if (!parsed || !isHycuConfigComplete(parsed)) {
      return { ok: false, message: "url, username et password sont requis" };
    }
    // testHycuConnection teste RÉELLEMENT l'appliance (GET /rest/v1.0/vms?pageSize=1) et ne
    // persiste rien. Son `vmCount` est perdu ici : PluginTestResult n'a que { ok, message }.
    const result = await testHycuConnection(parsed.url, parsed.username, parsed.password);
    return { ok: result.ok, message: result.message };
  },

  /**
   * Résumé CALCULÉ du contrôleur (getHycuStatus, un seul jeu d'appels). `entities`/`relations`
   * restent vides volontairement : le détail par VM est contribué au GRAPHE (graph() ci-dessous),
   * pas dupliqué en entités de module qui ne seraient rendues nulle part.
   */
  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    const parsed = parseHycuConfig(config);
    if (!parsed || !isHycuConfigComplete(parsed)) return emptySnapshot("not-configured", NOT_CONFIGURED_MESSAGE);

    // Le service lit lui-même la configuration STOCKÉE : `config` dit si le greffon est configuré,
    // il ne sert jamais à joindre une autre appliance que celle enregistrée.
    const status = await getHycuStatus();
    if (!status.configured) return emptySnapshot("not-configured", NOT_CONFIGURED_MESSAGE);
    if (!status.reachable) return emptySnapshot("unreachable", UNREACHABLE_MESSAGE);

    const summary: ServiceModuleSummaryItem[] = [];
    if (status.vms) {
      const { total, protectedCount } = status.vms;
      summary.push({
        label: "VMs protégées",
        value: `${protectedCount} / ${total}`,
        tone: total > 0 && protectedCount === total ? "ok" : total > 0 ? "warning" : "neutral",
      });
    }
    if (status.policies) summary.push({ label: "Politiques", value: String(status.policies.count), tone: "neutral" });
    if (status.targets) {
      summary.push({ label: "Cibles de sauvegarde", value: String(status.targets.count), tone: "neutral" });
      // Occupation dérivée des capacités réelles (used/total), jamais un pourcentage supposé.
      if (status.targets.totalSizeInBytes > 0) {
        const pct = (status.targets.usedSizeInBytes / status.targets.totalSizeInBytes) * 100;
        summary.push({ label: "Occupation des cibles", value: `${Math.round(pct * 10) / 10} %`, tone: "neutral" });
      }
    }
    // Un item par statut RÉELLEMENT rencontré dans les jobs récents — aucune taxonomie inventée.
    if (status.jobs) {
      for (const [jobStatus, count] of Object.entries(status.jobs.byStatus)) {
        summary.push({ label: `Jobs ${jobStatus}`, value: String(count), tone: JOB_TONES[jobStatus] ?? "neutral" });
      }
    }

    return {
      moduleId: HYCU_PLUGIN_ID,
      generatedAt: new Date().toISOString(),
      status: "ready",
      summary,
      entities: [],
      relations: [],
    };
  },

  /**
   * Contribution au graphe. Le contrat ne passe QUE la configuration : sans contexte de graphe, le
   * greffon ne peut désigner aucune VM Nutanix, donc aucune arête n'est produite ici (voir
   * graph.ts#buildHycuGraph, qui produit nœud + arêtes + annotations dès qu'on lui donne les nœuds
   * VM existants — c'est ce chemin qu'emprunte services/topology.ts).
   */
  async graph(config: unknown): Promise<PluginGraphContribution> {
    const parsed = parseHycuConfig(config);
    if (!parsed || !isHycuConfigComplete(parsed)) return { nodes: [], edges: [], attachments: [] };
    return await hycuGraphContribution();
  },
};
