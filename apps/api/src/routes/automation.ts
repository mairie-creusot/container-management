/**
 * GET    /api/automation/nodes   — liste des nœuds (trigger/condition/action), ouvert à toute
 *                                   session authentifiée.
 * POST   /api/automation/nodes   — { kind, label, triggerConfig?|conditionInvert?|actionConfig? }
 *                                   — operator/admin (hook global, aucune garde supplémentaire ici,
 *                                   même principe que POST .../trigger dans routes/cronJobs.ts :
 *                                   ce n'est jamais une commande shell arbitraire, seulement un
 *                                   câblage entre des ressources déjà existantes et déjà soumises
 *                                   à leurs propres gardes de rôle — ex: créer un nœud "action"
 *                                   qui redémarre un conteneur n'ouvre rien de plus que la route
 *                                   POST /api/containers/:id/restart, déjà operator/admin).
 * DELETE /api/automation/nodes/:id — operator/admin, supprime aussi les arêtes qui le touchent.
 * POST   /api/automation/edges   — { source, target } — operator/admin, valide que les DEUX
 *                                   nœuds existent et que la connexion respecte l'ordre logique
 *                                   trigger->condition, trigger->action ou condition->action
 *                                   (400 sinon, ex: action->trigger).
 * DELETE /api/automation/edges/:id — operator/admin.
 * GET    /api/automation/runs    — historique récent des chaînes RÉELLEMENT exécutées (voir
 *                                   services/automationRunLog.ts), ouvert à toute session
 *                                   authentifiée, même principe que GET /api/audit (sans la
 *                                   restriction admin de /api/audit : aucune donnée sensible
 *                                   d'un autre utilisateur n'y transite, seulement des exécutions
 *                                   d'automatisations partagées par toute l'équipe).
 */

import type { FastifyInstance } from "fastify";
import {
  createAutomationEdge,
  createAutomationNode,
  deleteAutomationEdge,
  deleteAutomationNode,
  getAutomationNode,
  listAutomationEdges,
  listAutomationNodes,
} from "../services/automationStore.js";
import type { AutomationNode, AutomationNodeKind } from "../services/automationStore.js";
import { listAutomationRuns } from "../services/automationRunLog.js";
import { asGlpiAutomationAction } from "../services/glpi.js";
import type { AutomationActionConfig, AutomationTriggerConfig, AutomationTriggerSource } from "../types.js";

const VALID_NODE_KINDS: AutomationNodeKind[] = ["automation-trigger", "automation-condition", "automation-action"];

interface AutomationNodeBody {
  kind?: AutomationNodeKind;
  label?: string;
  triggerConfig?: AutomationTriggerConfig;
  conditionInvert?: boolean;
  actionConfig?: AutomationActionConfig;
}

interface AutomationEdgeBody {
  source?: string;
  target?: string;
}

/** `undefined` si valide, sinon le message d'erreur 400 à renvoyer. */
function validateTriggerSource(source: AutomationTriggerSource | undefined): string | undefined {
  if (!source) return "triggerConfig.source is required for an automation-trigger node";
  if (source.kind === "topology-node") {
    if (!source.nodeId || !source.nodeId.trim()) return "triggerConfig.source.nodeId is required";
    return undefined;
  }
  if (source.kind === "reverse-proxy-route") {
    if (!source.routeId || !source.routeId.trim()) return "triggerConfig.source.routeId is required";
    return undefined;
  }
  return `triggerConfig.source.kind must be one of: topology-node, reverse-proxy-route`;
}

/** `undefined` si valide, sinon le message d'erreur 400 à renvoyer. */
function validateActionConfig(cfg: AutomationActionConfig | undefined): string | undefined {
  if (!cfg) return "actionConfig is required for an automation-action node";
  // Action GLPI : son type est déclaré dans services/glpi.ts (hors de l'union de types.ts), d'où
  // une reconnaissance depuis la valeur brute — le contexte de l'incident est rempli par le
  // moteur, seul un titre facultatif est configurable ici.
  if (asGlpiAutomationAction(cfg)) return undefined;
  if (cfg.kind === "run-cron-job") {
    if (!cfg.cronJobId || !cfg.cronJobId.trim()) return "actionConfig.cronJobId is required";
    return undefined;
  }
  if (cfg.kind === "send-notification") {
    if (!cfg.channelId || !cfg.channelId.trim()) return "actionConfig.channelId is required";
    if (!cfg.message || !cfg.message.trim()) return "actionConfig.message is required";
    return undefined;
  }
  if (cfg.kind === "container-action") {
    if (!cfg.containerId || !cfg.containerId.trim()) return "actionConfig.containerId is required";
    if (!["start", "stop", "restart"].includes(cfg.action)) {
      return `actionConfig.action must be one of: start, stop, restart`;
    }
    return undefined;
  }
  return `actionConfig.kind must be one of: run-cron-job, send-notification, container-action, create-glpi-ticket`;
}

/**
 * Ordre logique d'une chaîne d'automatisation (trigger -> [condition] -> action) — même règle
 * que celle appliquée par le moteur pour parcourir les arêtes (services/automationEngine.ts#
 * fireActionChain : un trigger peut mener à une condition ou directement à une action, une
 * condition ne peut mener qu'à une action, une action est toujours une feuille).
 */
function isValidConnection(source: AutomationNode, target: AutomationNode): boolean {
  if (source.kind === "automation-trigger") {
    return target.kind === "automation-condition" || target.kind === "automation-action";
  }
  if (source.kind === "automation-condition") {
    return target.kind === "automation-action";
  }
  return false; // "automation-action" en source : jamais valide, une action est toujours une feuille
}

export default async function automationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/automation/nodes", async (_request, reply) => {
    return reply.send(await listAutomationNodes());
  });

  fastify.get("/api/automation/edges", async (_request, reply) => {
    return reply.send(await listAutomationEdges());
  });

  fastify.post<{ Body: AutomationNodeBody }>("/api/automation/nodes", async (request, reply) => {
    const body = request.body ?? {};
    const label = body.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    if (!body.kind || !VALID_NODE_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_NODE_KINDS.join(", ")}` });
    }

    if (body.kind === "automation-trigger") {
      const error = validateTriggerSource(body.triggerConfig?.source);
      if (error) return reply.code(400).send({ error });
    }
    if (body.kind === "automation-action") {
      const error = validateActionConfig(body.actionConfig);
      if (error) return reply.code(400).send({ error });
    }

    const created = await createAutomationNode({
      kind: body.kind,
      label,
      ...(body.kind === "automation-trigger" && body.triggerConfig ? { triggerConfig: body.triggerConfig } : {}),
      ...(body.kind === "automation-condition" ? { conditionInvert: body.conditionInvert ?? false } : {}),
      ...(body.kind === "automation-action" && body.actionConfig ? { actionConfig: body.actionConfig } : {}),
    });
    return reply.code(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>("/api/automation/nodes/:id", async (request, reply) => {
    const deleted = await deleteAutomationNode(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `Automation node "${request.params.id}" not found` });
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: AutomationEdgeBody }>("/api/automation/edges", async (request, reply) => {
    const body = request.body ?? {};
    const source = body.source?.trim();
    const target = body.target?.trim();
    if (!source || !target) return reply.code(400).send({ error: "source and target are required" });

    const [sourceNode, targetNode] = await Promise.all([getAutomationNode(source), getAutomationNode(target)]);
    if (!sourceNode) return reply.code(400).send({ error: `Automation node "${source}" not found` });
    if (!targetNode) return reply.code(400).send({ error: `Automation node "${target}" not found` });
    if (!isValidConnection(sourceNode, targetNode)) {
      return reply.code(400).send({
        error: `Invalid connection: "${sourceNode.kind}" -> "${targetNode.kind}" (allowed: trigger->condition, trigger->action, condition->action)`,
      });
    }

    const created = await createAutomationEdge(source, target);
    return reply.code(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>("/api/automation/edges/:id", async (request, reply) => {
    const deleted = await deleteAutomationEdge(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `Automation edge "${request.params.id}" not found` });
    return reply.send({ ok: true });
  });

  fastify.get("/api/automation/runs", async (_request, reply) => {
    return reply.send(await listAutomationRuns());
  });
}
