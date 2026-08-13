import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ReverseProxyRoute, Topology, TopologyNode } from "../src/types.js";

/**
 * CONFIG_PATH/AUTOMATION_STORE_PATH/AUTOMATION_HISTORY_PATH isolés (même pattern EXACT que
 * reverseProxy.test.ts/cronJobsScheduler.test.ts) — ce fichier ne touche JAMAIS les vrais
 * apps/api/data/config.json, data/automation.json, data/automation-runs.jsonl de dev.
 * AUTOMATION_PROBE_TIMEOUT_MS abaissé : le test "reverse-proxy-route" ci-dessous effectue une
 * VRAIE tentative de connexion TCP vers un port sur lequel rien n'écoute (voir plus bas) — un
 * timeout court garde le test rapide même si l'environnement ne renvoie pas de RST immédiat.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const tmpAutomationStorePath = path.join(
  os.tmpdir(),
  `quai-api-test-automation-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
const tmpAutomationHistoryPath = path.join(
  os.tmpdir(),
  `quai-api-test-automation-runs-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
);
process.env.CONFIG_PATH = tmpConfigPath;
process.env.AUTOMATION_STORE_PATH = tmpAutomationStorePath;
process.env.AUTOMATION_HISTORY_PATH = tmpAutomationHistoryPath;
process.env.AUTOMATION_PROBE_TIMEOUT_MS = "500";
process.env.CONFIG_ENCRYPTION_KEY = "9".repeat(64); // clé fixe pour ce process de test uniquement

// Isolation des dépendances externes du moteur (services/automationEngine.ts) : la topologie
// (getTopology) est mockée pour contrôler précisément l'état "réel" observé par un trigger
// "topology-node" sans dépendre d'un vrai démon Docker — même principe que test/topology.test.ts.
// docker.ts/cronJobsScheduler.ts/notificationDispatch.ts sont mockés pour vérifier QUELLE action
// est appelée et AVEC QUELS arguments, sans jamais toucher un vrai conteneur/cron job/canal
// pendant ce test unitaire (la vérification en conditions réelles est faite séparément, voir le
// rapport de mission). reverseProxy.ts (listRoutes/resolveUpstream) est mocké pour piloter la
// route retournée, mais la sonde TCP elle-même (net.Socket, dans automationEngine.ts) n'est PAS
// mockée : elle effectue une VRAIE tentative de connexion, voir le describe dédié plus bas.
const getTopologyMock = vi.fn<[], Promise<Topology>>();
vi.mock("../src/services/topology.js", () => ({
  getTopology: () => getTopologyMock(),
}));

const startContainerMock = vi.fn<[string], Promise<void>>();
const stopContainerMock = vi.fn<[string], Promise<void>>();
const restartContainerMock = vi.fn<[string], Promise<void>>();
vi.mock("../src/services/docker.js", () => ({
  startContainer: (id: string) => startContainerMock(id),
  stopContainer: (id: string) => stopContainerMock(id),
  restartContainer: (id: string) => restartContainerMock(id),
}));

class CronJobNotFoundErrorStub extends Error {}
const triggerCronJobRunMock = vi.fn();
vi.mock("../src/services/cronJobsScheduler.js", () => ({
  CronJobNotFoundError: CronJobNotFoundErrorStub,
  triggerCronJobRun: (id: string) => triggerCronJobRunMock(id),
}));

const sendChannelNotificationMock = vi.fn<[string, string], Promise<{ ok: boolean; message: string }>>();
vi.mock("../src/services/notificationDispatch.js", () => ({
  sendChannelNotification: (channelId: string, message: string) => sendChannelNotificationMock(channelId, message),
}));

const listRoutesMock = vi.fn<[], Promise<ReverseProxyRoute[]>>();
const resolveUpstreamMock = vi.fn<[ReverseProxyRoute], Promise<string | null>>();
vi.mock("../src/services/reverseProxy.js", () => ({
  listRoutes: () => listRoutesMock(),
  resolveUpstream: (route: ReverseProxyRoute) => resolveUpstreamMock(route),
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const {
  createAutomationEdge,
  createAutomationNode,
  deleteAutomationNode,
  getAutomationNode,
  listAutomationEdges,
  listAutomationNodes,
} = await import("../src/services/automationStore.js");
const { listAutomationRuns } = await import("../src/services/automationRunLog.js");
const { runAutomationEngineCycle } = await import("../src/services/automationEngine.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(tmpAutomationStorePath, { force: true });
  await fs.rm(tmpAutomationHistoryPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

describe("services/automationStore — CRUD", () => {
  it("starts empty", async () => {
    expect(await listAutomationNodes()).toEqual([]);
    expect(await listAutomationEdges()).toEqual([]);
  });

  it("creates a trigger node with lastFired=null/lastStatus=unknown by default", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "surveille app",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:abc" } },
    });
    expect(trigger.lastFired).toBeNull();
    expect(trigger.lastStatus).toBe("unknown");
    await deleteAutomationNode(trigger.id);
  });

  it("deleting a node also deletes edges that touch it", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "trigger",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:x" } },
    });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "action",
      actionConfig: { kind: "container-action", containerId: "x", action: "restart" },
    });
    const edge = await createAutomationEdge(trigger.id, action.id);
    expect(await listAutomationEdges()).toContainEqual(edge);

    await deleteAutomationNode(trigger.id);
    expect(await getAutomationNode(trigger.id)).toBeUndefined();
    expect((await listAutomationEdges()).some((e) => e.id === edge.id)).toBe(false);

    await deleteAutomationNode(action.id);
  });
});

describe("routes/automation.ts — nodes/edges CRUD", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/automation/nodes" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a viewer trying to create a node with 403 (mutating method, hook global)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies: cookieFor(["viewer"]),
      payload: { kind: "automation-action", label: "x", actionConfig: { kind: "container-action", containerId: "c", action: "start" } },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a trigger node with no triggerConfig with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies: cookieFor(["operator"]),
      payload: { kind: "automation-trigger", label: "no source" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an action node with no actionConfig with 400", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies: cookieFor(["operator"]),
      payload: { kind: "automation-action", label: "no action" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("creates a trigger -> condition -> action chain and rejects an illogical edge (action -> trigger)", async () => {
    app = buildServer();
    const cookies = cookieFor(["operator"]);

    const triggerRes = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies,
      payload: {
        kind: "automation-trigger",
        label: "route down",
        triggerConfig: { source: { kind: "reverse-proxy-route", routeId: "route-1" } },
      },
    });
    expect(triggerRes.statusCode).toBe(201);
    const trigger = triggerRes.json();

    const conditionRes = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies,
      payload: { kind: "automation-condition", label: "non inversée" },
    });
    expect(conditionRes.statusCode).toBe(201);
    const condition = conditionRes.json();

    const actionRes = await app.inject({
      method: "POST",
      url: "/api/automation/nodes",
      cookies,
      payload: {
        kind: "automation-action",
        label: "notifie",
        actionConfig: { kind: "send-notification", channelId: "chan-1", message: "route en échec" },
      },
    });
    expect(actionRes.statusCode).toBe(201);
    const action = actionRes.json();

    const edge1 = await app.inject({
      method: "POST",
      url: "/api/automation/edges",
      cookies,
      payload: { source: trigger.id, target: condition.id },
    });
    expect(edge1.statusCode).toBe(201);

    const edge2 = await app.inject({
      method: "POST",
      url: "/api/automation/edges",
      cookies,
      payload: { source: condition.id, target: action.id },
    });
    expect(edge2.statusCode).toBe(201);

    // action -> trigger : ordre illogique, rejeté avant toute persistance.
    const badEdge = await app.inject({
      method: "POST",
      url: "/api/automation/edges",
      cookies,
      payload: { source: action.id, target: trigger.id },
    });
    expect(badEdge.statusCode).toBe(400);

    const listRes = await app.inject({ method: "GET", url: "/api/automation/nodes", cookies: cookieFor(["viewer"]) });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining([trigger.id, condition.id, action.id]));

    for (const id of [trigger.id, condition.id, action.id]) {
      await deleteAutomationNode(id);
    }
  });

  it("GET /api/automation/runs returns an array, even empty", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/automation/runs", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });
});

describe("services/automationEngine — cycle (transition ok/unknown -> failing uniquement)", () => {
  function containerNode(status: TopologyNode["status"], healthStatus?: TopologyNode["healthStatus"]): Topology {
    return {
      nodes: [
        {
          id: "container:app-1",
          kind: "container",
          label: "app-1",
          subtitle: "nginx:latest",
          status,
          ...(healthStatus ? { healthStatus } : {}),
        },
      ],
      edges: [],
      generatedAt: new Date().toISOString(),
      groups: [],
    };
  }

  it("fires the connected container-action on the FIRST failing cycle, and never again while it stays failing", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "app-1 down",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:app-1" } },
    });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "restart app-1",
      actionConfig: { kind: "container-action", containerId: "app-1", action: "restart" },
    });
    await createAutomationEdge(trigger.id, action.id);

    getTopologyMock.mockResolvedValue(containerNode("stopped"));
    restartContainerMock.mockResolvedValue(undefined);

    await runAutomationEngineCycle();

    expect(restartContainerMock).toHaveBeenCalledTimes(1);
    expect(restartContainerMock).toHaveBeenCalledWith("app-1");
    const afterFirst = await getAutomationNode(trigger.id);
    expect(afterFirst?.lastStatus).toBe("failing");
    expect(afterFirst?.lastFired).not.toBeNull();
    const runsAfterFirst = await listAutomationRuns();
    expect(runsAfterFirst.filter((r) => r.triggerNodeId === trigger.id)).toHaveLength(1);
    expect(runsAfterFirst.find((r) => r.triggerNodeId === trigger.id)?.ok).toBe(true);

    // Second cycle : toujours "stopped" -> pas une nouvelle transition, l'action n'est PAS
    // réexécutée (sinon spam à chaque cycle, voir mission).
    await runAutomationEngineCycle();
    expect(restartContainerMock).toHaveBeenCalledTimes(1);
    const runsAfterSecond = await listAutomationRuns();
    expect(runsAfterSecond.filter((r) => r.triggerNodeId === trigger.id)).toHaveLength(1);

    // Troisième cycle : le conteneur redevient "running" -> lastStatus repasse à "ok", toujours
    // aucune nouvelle exécution (ce n'est pas une transition VERS l'échec).
    getTopologyMock.mockResolvedValue(containerNode("running"));
    await runAutomationEngineCycle();
    expect(restartContainerMock).toHaveBeenCalledTimes(1);
    expect((await getAutomationNode(trigger.id))?.lastStatus).toBe("ok");

    await deleteAutomationNode(trigger.id);
    await deleteAutomationNode(action.id);
  });

  it("treats healthStatus === 'unhealthy' as failing even when status === 'running' (containers only)", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "app-2 unhealthy",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:app-1" } },
    });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "notify",
      actionConfig: { kind: "send-notification", channelId: "chan-1", message: "app-2 unhealthy" },
    });
    await createAutomationEdge(trigger.id, action.id);
    sendChannelNotificationMock.mockResolvedValue({ ok: true, message: "sent" });

    getTopologyMock.mockResolvedValue(containerNode("running", "unhealthy"));
    await runAutomationEngineCycle();

    expect(sendChannelNotificationMock).toHaveBeenCalledWith("chan-1", "app-2 unhealthy");
    expect((await getAutomationNode(trigger.id))?.lastStatus).toBe("failing");

    await deleteAutomationNode(trigger.id);
    await deleteAutomationNode(action.id);
  });

  it("blocks the chain when the connected condition has conditionInvert=true (NON logique)", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "app-3 down",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:app-1" } },
    });
    const condition = await createAutomationNode({ kind: "automation-condition", label: "bloque tout", conditionInvert: true });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "restart app-3",
      actionConfig: { kind: "container-action", containerId: "app-3", action: "restart" },
    });
    await createAutomationEdge(trigger.id, condition.id);
    await createAutomationEdge(condition.id, action.id);

    getTopologyMock.mockResolvedValue(containerNode("stopped"));
    await runAutomationEngineCycle();

    expect(restartContainerMock).not.toHaveBeenCalled();
    expect((await getAutomationNode(trigger.id))?.lastStatus).toBe("failing");
    expect((await listAutomationRuns()).some((r) => r.triggerNodeId === trigger.id)).toBe(false);

    await deleteAutomationNode(trigger.id);
    await deleteAutomationNode(condition.id);
    await deleteAutomationNode(action.id);
  });

  it("run-cron-job action calls triggerCronJobRun with the configured cronJobId", async () => {
    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "app-4 down",
      triggerConfig: { source: { kind: "topology-node", nodeId: "container:app-1" } },
    });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "run remediation job",
      actionConfig: { kind: "run-cron-job", cronJobId: "job-42" },
    });
    await createAutomationEdge(trigger.id, action.id);
    triggerCronJobRunMock.mockResolvedValue({ id: "run-1", jobId: "job-42", status: "running", trigger: "manual", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, output: "" });

    getTopologyMock.mockResolvedValue(containerNode("stopped"));
    await runAutomationEngineCycle();

    expect(triggerCronJobRunMock).toHaveBeenCalledWith("job-42");

    await deleteAutomationNode(trigger.id);
    await deleteAutomationNode(action.id);
  });

  it("reverse-proxy-route trigger: a REAL failed TCP probe (unreachable local port) is treated as failing", async () => {
    const route: ReverseProxyRoute = {
      id: "route-down",
      subdomain: "down.lecreusot.priv",
      targetHost: "127.0.0.1",
      targetPort: 1, // port réservé, rien n'y écoute jamais : connexion réellement refusée/timeout
      createdAt: new Date().toISOString(),
    };
    listRoutesMock.mockResolvedValue([route]);
    resolveUpstreamMock.mockResolvedValue("127.0.0.1:1");

    const trigger = await createAutomationNode({
      kind: "automation-trigger",
      label: "route down",
      triggerConfig: { source: { kind: "reverse-proxy-route", routeId: "route-down" } },
    });
    const action = await createAutomationNode({
      kind: "automation-action",
      label: "notify route down",
      actionConfig: { kind: "send-notification", channelId: "chan-2", message: "route down" },
    });
    await createAutomationEdge(trigger.id, action.id);
    sendChannelNotificationMock.mockResolvedValue({ ok: true, message: "sent" });

    await runAutomationEngineCycle();

    expect(listRoutesMock).toHaveBeenCalled();
    expect(resolveUpstreamMock).toHaveBeenCalledWith(route);
    expect((await getAutomationNode(trigger.id))?.lastStatus).toBe("failing");
    expect(sendChannelNotificationMock).toHaveBeenCalledWith("chan-2", "route down");

    await deleteAutomationNode(trigger.id);
    await deleteAutomationNode(action.id);
  }, 10000);
});
