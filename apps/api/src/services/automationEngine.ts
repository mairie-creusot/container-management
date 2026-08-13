/**
 * Moteur du chantier "automatisation" (trigger -> condition -> action, façon n8n mais câblé
 * UNIQUEMENT sur les capacités RÉELLES déjà existantes de QUAI) — cf. ARCHITECTURE.md.
 *
 * Boucle périodique (`setInterval`, cf. startAutomationEngine ci-dessous, même câblage que
 * services/cronJobsScheduler.ts#startCronJobsScheduler) : à chaque cycle, pour CHAQUE
 * `AutomationNode` de kind "automation-trigger", résout son état RÉEL actuel :
 *  - `topology-node` : relit le graphe (services/topology.ts#getTopology, chargé UNE SEULE fois
 *    par cycle et partagé entre tous les triggers "topology-node" de ce cycle, jamais un appel
 *    par trigger) — règle d'échec : `status !== "running"` OU (conteneur uniquement)
 *    `healthStatus === "unhealthy"`.
 *  - `reverse-proxy-route` : résout la route (services/reverseProxy.ts#listRoutes), résout son
 *    upstream réel avec la MÊME fonction que le reverse proxy lui-même (services/reverseProxy.ts#
 *    resolveUpstream, exportée pour cet usage), puis tente une VRAIE connexion TCP (`net.Socket`,
 *    timeout court `config.automation.probeTimeoutMs`) — échec = injoignable.
 *
 * `lastFired`/`lastStatus` sont mis à jour à CHAQUE cycle pour CHAQUE trigger évalué (via
 * automationStore.ts#updateTriggerState), quoi qu'il arrive. La chaîne d'actions n'est en
 * revanche exécutée QUE sur la TRANSITION précise ok/unknown -> failing (jamais en boucle tant
 * que ça reste en échec, sinon spam de notifications/redémarrages à chaque cycle).
 *
 * Sur transition : parcourt les `AutomationEdge` sortantes du trigger, applique le NON logique
 * minimal d'une éventuelle "automation-condition" rencontrée (`conditionInvert: true` bloque la
 * branche, sinon elle passe — pas de moteur de règles), puis EXÉCUTE réellement chaque
 * "automation-action" atteinte en réutilisant les fonctions de service DÉJÀ existantes
 * (cronJobsScheduler.ts#triggerCronJobRun, notificationDispatch.ts#sendChannelNotification,
 * docker.ts#startContainer/stopContainer/restartContainer) — jamais une nouvelle implémentation
 * d'effet de bord. Chaque exécution de chaîne (succès ou échec réel) est journalisée
 * (automationRunLog.ts#recordAutomationRun).
 *
 * Chaque trigger est protégé individuellement par un try/catch (jamais d'exception qui remonte
 * et casse la boucle globale) — même discipline que auditLog.ts/watchdog.ts.
 */

import net from "node:net";
import { config } from "../config.js";
import {
  listAutomationEdges,
  listAutomationNodes,
  updateTriggerState,
} from "./automationStore.js";
import type { AutomationEdge, AutomationNode } from "./automationStore.js";
import { recordAutomationRun } from "./automationRunLog.js";
import { getTopology } from "./topology.js";
import type { Topology } from "../types.js";
import { listRoutes, resolveUpstream } from "./reverseProxy.js";
import { restartContainer, startContainer, stopContainer } from "./docker.js";
import { CronJobNotFoundError, triggerCronJobRun } from "./cronJobsScheduler.js";
import { sendChannelNotification } from "./notificationDispatch.js";

type ResolvedTriggerState = "ok" | "failing" | "unknown";

/** Règle d'échec d'un nœud de topologie déjà calculé par services/topology.ts — jamais une
 * nouvelle métrique inventée, voir en-tête de fichier. "unknown" si le nœud ciblé n'existe plus
 * (ex: conteneur supprimé entre deux cycles) : on ne peut alors rien affirmer, donc pas de
 * transition possible tant qu'il reste dans cet état. */
function resolveTopologyNodeState(nodeId: string, topology: Topology): ResolvedTriggerState {
  const node = topology.nodes.find((n) => n.id === nodeId);
  if (!node) return "unknown";
  const failing = node.status !== "running" || (node.kind === "container" && node.healthStatus === "unhealthy");
  return failing ? "failing" : "ok";
}

function splitHostPort(hostPort: string): { host: string; port: number } | null {
  const idx = hostPort.lastIndexOf(":");
  if (idx === -1) return null;
  const host = hostPort.slice(0, idx);
  const port = Number(hostPort.slice(idx + 1));
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

/** VRAIE tentative de connexion TCP vers `host:port` — timeout court, jamais de simulation
 * (règle absolue #2 de la mission) : `true` seulement si la connexion s'établit réellement. */
function probeTcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function resolveReverseProxyRouteState(routeId: string): Promise<ResolvedTriggerState> {
  const routes = await listRoutes();
  const route = routes.find((r) => r.id === routeId);
  if (!route) return "unknown";
  const upstream = await resolveUpstream(route);
  if (!upstream) return "failing"; // cible non résolvable (conteneur cible disparu, host/port absent) = injoignable
  const parsed = splitHostPort(upstream);
  if (!parsed) return "failing";
  const reachable = await probeTcpReachable(parsed.host, parsed.port, config.automation.probeTimeoutMs);
  return reachable ? "ok" : "failing";
}

/** Exécute RÉELLEMENT une action en réutilisant une fonction de service déjà existante — jamais
 * une nouvelle implémentation d'effet de bord (voir en-tête de fichier). */
async function executeAction(action: AutomationNode): Promise<{ ok: boolean; message?: string }> {
  const cfg = action.actionConfig;
  if (!cfg) return { ok: false, message: `Action "${action.label}" (${action.id}) : aucune configuration` };
  try {
    if (cfg.kind === "run-cron-job") {
      const run = await triggerCronJobRun(cfg.cronJobId);
      return { ok: true, message: `Cron job "${cfg.cronJobId}" déclenché (run ${run.id})` };
    }
    if (cfg.kind === "send-notification") {
      return await sendChannelNotification(cfg.channelId, cfg.message);
    }
    if (cfg.kind === "container-action") {
      if (cfg.action === "start") await startContainer(cfg.containerId);
      else if (cfg.action === "stop") await stopContainer(cfg.containerId);
      else await restartContainer(cfg.containerId);
      return { ok: true, message: `Conteneur ${cfg.containerId} : action "${cfg.action}" exécutée` };
    }
    return { ok: false, message: "Configuration d'action inconnue" };
  } catch (err) {
    if (err instanceof CronJobNotFoundError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parcourt les arêtes sortantes du trigger (BFS), applique le NON logique d'une éventuelle
 * condition rencontrée, puis exécute RÉELLEMENT chaque action atteinte — une entrée de journal
 * par action exécutée, avec le chemin EXACT parcouru jusqu'à elle (trigger -> [condition] ->
 * action). Aucune entrée si aucune action n'est atteinte (arête absente, ou branche bloquée par
 * une condition inversée) : il ne s'est structurellement rien passé, pas un échec.
 */
async function fireActionChain(trigger: AutomationNode, allNodes: AutomationNode[], allEdges: AutomationEdge[]): Promise<void> {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const outgoing = (id: string) => allEdges.filter((e) => e.source === id);
  const parent = new Map<string, string>();
  const visited = new Set<string>([trigger.id]);
  const queue: string[] = [trigger.id];
  const actionIds: string[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of outgoing(currentId)) {
      if (visited.has(edge.target)) continue;
      const node = nodeById.get(edge.target);
      if (!node) continue;
      if (node.kind === "automation-condition" && node.conditionInvert) {
        // NON logique minimal (v1) : bloque cette branche, jamais explorée plus loin — pas
        // d'action atteinte via ce chemin.
        visited.add(edge.target);
        continue;
      }
      visited.add(edge.target);
      parent.set(edge.target, currentId);
      if (node.kind === "automation-action") {
        actionIds.push(edge.target);
        continue; // une action est une feuille (v1 : pas de chaînage action -> action)
      }
      if (node.kind === "automation-condition") {
        queue.push(edge.target); // condition qui passe : continue d'explorer ses propres arêtes
      }
    }
  }

  function reconstructPath(id: string): string[] {
    const path = [id];
    let cur = id;
    while (parent.has(cur)) {
      cur = parent.get(cur)!;
      path.unshift(cur);
    }
    return path;
  }

  for (const actionId of actionIds) {
    const action = nodeById.get(actionId);
    if (!action) continue;
    const result = await executeAction(action);
    await recordAutomationRun({
      triggerNodeId: trigger.id,
      path: reconstructPath(actionId),
      ok: result.ok,
      ...(result.message ? { message: result.message } : {}),
    });
  }
}

async function evaluateTrigger(trigger: AutomationNode, topology: Topology | null, allNodes: AutomationNode[], allEdges: AutomationEdge[]): Promise<void> {
  const source = trigger.triggerConfig?.source;
  if (!source) return; // trigger mal formé (jamais créé par routes/automation.ts) : rien à évaluer

  const state: ResolvedTriggerState =
    source.kind === "topology-node"
      ? topology
        ? resolveTopologyNodeState(source.nodeId, topology)
        : "unknown"
      : await resolveReverseProxyRouteState(source.routeId);

  const previousStatus = trigger.lastStatus ?? "unknown";
  // `lastStatus` reflète l'état RÉEL observé à CHAQUE cycle, quoi qu'il arrive — c'est
  // `lastFired` (mis à jour UNIQUEMENT juste en dessous, sur la transition réelle) qui porte
  // l'information utile pour l'administrateur : voir TopologyNode#automationLastFired.
  await updateTriggerState(trigger.id, { lastStatus: state });

  // Transition ok/unknown -> failing UNIQUEMENT : jamais en boucle tant que ça reste en échec
  // (sinon spam de notifications/redémarrages à chaque cycle, voir en-tête de fichier).
  if (state === "failing" && previousStatus !== "failing") {
    await updateTriggerState(trigger.id, { lastFired: new Date().toISOString() });
    await fireActionChain(trigger, allNodes, allEdges);
  }
}

/** Un cycle complet — exporté pour les tests et un déclenchement manuel éventuel, même pattern
 * que cronJobsScheduler.ts#runCronJobsSchedulerCycle/watchdog.ts#runWatchdogCycle. */
export async function runAutomationEngineCycle(): Promise<void> {
  let nodes: AutomationNode[];
  let edges: AutomationEdge[];
  try {
    [nodes, edges] = await Promise.all([listAutomationNodes(), listAutomationEdges()]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[automation] failed to read nodes/edges: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const triggers = nodes.filter((n) => n.kind === "automation-trigger");
  if (triggers.length === 0) return;

  // Topologie chargée UNE SEULE fois par cycle, partagée entre tous les triggers "topology-node"
  // de ce cycle (jamais un appel getTopology() par trigger) — null si le graphe n'a pas pu être
  // construit ce cycle-ci, auquel cas chaque trigger "topology-node" résoudra "unknown".
  const needsTopology = triggers.some((t) => t.triggerConfig?.source.kind === "topology-node");
  let topology: Topology | null = null;
  if (needsTopology) {
    try {
      topology = await getTopology();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[automation] failed to load topology for this cycle: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const trigger of triggers) {
    try {
      await evaluateTrigger(trigger, topology, nodes, edges);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[automation] trigger "${trigger.label}" (${trigger.id}) evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Démarré UNIQUEMENT depuis index.ts (jamais pendant les tests qui construisent juste le
 * serveur avec `app.inject`), même câblage que cronJobsScheduler.ts#startCronJobsScheduler. */
export function startAutomationEngine(intervalMs: number = config.automation.pollIntervalMs): () => void {
  const timer = setInterval(() => void runAutomationEngineCycle(), intervalMs);
  return () => clearInterval(timer);
}
