import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Statistiques temps réel + alertes Nutanix — GET /api/nutanix/cluster-stats et /api/nutanix/alerts
 * (services/nutanix.ts, section "Statistiques temps réel + alertes").
 *
 * Les corps de réponse mockés ci-dessous reproduisent les formes RÉELLES relevées le 19/08/2026 sur
 * l'instance 172.20.0.10:9440 (cluster CLUSTER_AHV_HDV, 3 hôtes HDVNUTA1/2/3, 5 storage containers,
 * 25 alertes non résolues) en LECTURE SEULE : mêmes noms de champs, mêmes valeurs sous forme de
 * CHAÎNES, mêmes sentinelles "-1", mêmes uuid. Aucun socket n'est ouvert (node:https est mocké,
 * routé par `${method} ${pathname}`) — l'instance réelle n'est jamais touchée par les tests.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockResponse {
  status: number;
  body: unknown;
}

const responsesByKey = new Map<string, MockResponse>();
/** Query string réelle de la DERNIÈRE requête par clé — pour vérifier `resolved=false&count=N`. */
const lastSearchByKey = new Map<string, string>();

function setResponse(key: string, body: unknown, status = 200): void {
  responsesByKey.set(key, { status, body });
}

vi.mock("node:https", () => ({
  request: (target: URL, options: { method?: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    const key = `${options.method ?? "GET"} ${target.pathname}`;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      lastSearchByKey.set(key, target.search);
      const found = responsesByKey.get(key) ?? { status: 404, body: { message: "not mocked" } };
      const res = Object.assign(new EventEmitter(), { statusCode: found.status });
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(found.body)));
      res.emit("end");
    };
    return req;
  },
}));

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { setNutanixConfig, clearNutanixConfig } = await import("../src/services/setupStore.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  responsesByKey.clear();
  lastSearchByKey.clear();
});

const V2 = "/PrismGateway/services/rest/v2.0";
const CLUSTERS_KEY = `GET ${V2}/clusters/`;
const HOSTS_KEY = `GET ${V2}/hosts/`;
const CONTAINERS_KEY = `GET ${V2}/storage_containers/`;
const ALERTS_KEY = `GET ${V2}/alerts/`;

const CLUSTER_UUID = "0005b4db-f6b4-0926-62f9-3cecef178022";
const HOST1_UUID = "655ce338-42e8-448a-b2b4-5a95150c0d43";
const HOST2_UUID = "c7f054cb-149e-4bf5-9327-48ce2522e79b";

async function seedNutanixConfig(): Promise<void> {
  await setNutanixConfig({ prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: "secret" });
}

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

/** Extrait RÉEL du bloc `stats` d'un cluster (valeurs telles quelles, sentinelles "-1" comprises). */
const REAL_CLUSTER_STATS = {
  hypervisor_cpu_usage_ppm: "147248",
  hypervisor_memory_usage_ppm: "435358",
  controller_num_iops: "517",
  controller_num_read_iops: "98",
  controller_num_write_iops: "418",
  controller_avg_io_latency_usecs: "679",
  controller_avg_read_io_latency_usecs: "1084",
  controller_avg_write_io_latency_usecs: "583",
  controller_io_bandwidth_kBps: "8415",
  controller_read_io_bandwidth_kBps: "3788",
  controller_write_io_bandwidth_kBps: "4627",
  num_iops: "138",
  num_read_iops: "95",
  num_write_iops: "42",
  avg_io_latency_usecs: "403",
  // Sentinelles réelles : ces deux latences n'étaient PAS disponibles sur l'instance.
  avg_read_io_latency_usecs: "-1",
  avg_write_io_latency_usecs: "-1",
  io_bandwidth_kBps: "5173",
  read_io_bandwidth_kBps: "3398",
  write_io_bandwidth_kBps: "1775",
};

const REAL_CLUSTER_USAGE_STATS = {
  "storage.capacity_bytes": "34841033768368",
  "storage.free_bytes": "16347480464816",
  "storage.usage_bytes": "18493553303552",
  "storage.logical_usage_bytes": "59901348118528",
  "storage.rebuild_capacity_bytes": "-1",
};

function clustersBody(): unknown {
  return {
    metadata: { grand_total_entities: 1, total_entities: 1, count: 1 },
    entities: [
      {
        id: `${CLUSTER_UUID}::7131798473239134242`,
        uuid: CLUSTER_UUID,
        cluster_uuid: CLUSTER_UUID,
        name: "CLUSTER_AHV_HDV",
        version: "7.5.0.6",
        num_nodes: 3,
        cluster_redundancy_state: {
          current_redundancy_factor: 2,
          desired_redundancy_factor: 2,
          desired_cluster_fault_tolerance: 2,
          current_cluster_fault_tolerance: 2,
        },
        stats: REAL_CLUSTER_STATS,
        usage_stats: REAL_CLUSTER_USAGE_STATS,
      },
    ],
  };
}

function hostsBody(): unknown {
  return {
    metadata: { grand_total_entities: 3, count: 3 },
    entities: [
      {
        uuid: HOST1_UUID,
        name: "HDVNUTA1",
        state: "NORMAL",
        cluster_uuid: CLUSTER_UUID,
        num_vms: 7,
        is_degraded: false,
        host_in_maintenance_mode: false,
        num_cpu_cores: 20,
        cpu_capacity_in_hz: 50000000000,
        memory_capacity_in_bytes: 269359251456,
        stats: {
          hypervisor_cpu_usage_ppm: "147572",
          hypervisor_memory_usage_ppm: "448126",
          controller_num_iops: "33",
          controller_num_read_iops: "7",
          controller_num_write_iops: "26",
          controller_avg_io_latency_usecs: "3431",
          controller_io_bandwidth_kBps: "587",
        },
        usage_stats: {
          "storage.capacity_bytes": "18350433456291",
          "storage.free_bytes": "11883102760152",
          "storage.usage_bytes": "6467330696139",
        },
      },
      {
        uuid: HOST2_UUID,
        name: "HDVNUTA2",
        state: "NORMAL",
        cluster_uuid: CLUSTER_UUID,
        num_vms: 8,
        is_degraded: false,
        host_in_maintenance_mode: false,
        num_cpu_cores: 20,
        cpu_capacity_in_hz: 50000000000,
        memory_capacity_in_bytes: 269359251456,
        stats: { hypervisor_cpu_usage_ppm: "120000", hypervisor_memory_usage_ppm: "400000" },
        usage_stats: {},
      },
    ],
  };
}

function storageContainersBody(): unknown {
  return {
    metadata: { grand_total_entities: 2, count: 2 },
    entities: [
      {
        storage_container_uuid: "f0add265-1a83-4e54-b4db-ba371d7c5864",
        name: "NutanixManagementShare",
        cluster_uuid: CLUSTER_UUID,
        usage_stats: {
          "storage.capacity_bytes": "16634576256432",
          "storage.free_bytes": "16359638822320",
          "storage.usage_bytes": "274937434112",
          "storage.logical_usage_bytes": "342679879680",
        },
      },
      {
        storage_container_uuid: "696a68d6-1ecf-4393-8dac-cdbd545136f2",
        name: "CLUSTER_AHV_C1",
        cluster_uuid: CLUSTER_UUID,
        usage_stats: {
          "storage.capacity_bytes": "32961673440688",
          "storage.free_bytes": "16359638822320",
          "storage.usage_bytes": "16602034618368",
        },
      },
    ],
  };
}

/** Alerte RÉELLE (message à marqueurs + tableaux parallèles context_types/context_values). */
function alertsBody(): unknown {
  return {
    metadata: { grand_total_entities: 25, total_entities: 25, page: 1, count: 2 },
    entities: [
      {
        id: "f9b5975d-3a52-48d1-8e23-e26bc9e28899",
        resolved: false,
        acknowledged: false,
        cluster_uuid: CLUSTER_UUID,
        created_time_stamp_in_usecs: 1786378665233736,
        last_occurrence_time_stamp_in_usecs: 1787069548796685,
        severity: "kWarning",
        message: "Application-Consistent Recovery Point for the VM {vm_name} failed because {reason}.",
        alert_title: "Application-Consistent Recovery Point Failed",
        affected_entities: [
          { entity_type: "vm", entity_type_display_name: "vm", entity_name: "HDVAIRSDB", uuid: "c8ca7426-8fb3-432d-a678-efec13e7dbf2", id: "" },
        ],
        context_types: ["vm_id", "vm_name", "recovery_point_create_time", "protection_rule_uuid", "reason"],
        context_values: [
          "c8ca7426-8fb3-432d-a678-efec13e7dbf2",
          "HDVAIRSDB",
          "Mon Aug 10 16:17:43 2026 GMT",
          "",
          "Quiescing guest VM failed or timed out",
        ],
      },
      {
        id: "1f9d0c31-0000-4000-8000-000000000002",
        resolved: false,
        acknowledged: true,
        cluster_uuid: CLUSTER_UUID,
        created_time_stamp_in_usecs: 1786342260737420,
        last_occurrence_time_stamp_in_usecs: 1786342260737420,
        severity: "kCritical",
        message: "Failed to capture the Recovery Point for VM '{vm_name}'. {reason}",
        alert_title: "VM Recovery Point Creation Failed.",
        affected_entities: [{ entity_type: "vm", entity_name: "HDVCIRIL", uuid: "e6167fb4-f91a-407c-934f-7d116d82db06" }],
        context_types: ["vm_name", "vm_id", "reason"],
        context_values: ["HDVCIRIL", "e6167fb4-f91a-407c-934f-7d116d82db06", "Failed to fetch VM info with error code: kNarsilVmGetFailed"],
      },
    ],
  };
}

describe("GET /api/nutanix/cluster-stats", () => {
  it("401 sans session (garde globale plugins/auth.ts)", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats" });
    expect(response.statusCode).toBe(401);
  });

  it("accessible en lecture à un rôle viewer (aucune mutation possible)", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: viewerCookie() });
    expect(response.statusCode).toBe(200);
  });

  it("configured:false si Nutanix n'a jamais été configuré (jamais un 500, jamais de fausse stat)", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, reachable: false, clusters: [] });
  });

  it("reachable:false si Prism ne répond pas sur /clusters/ — distinct de « non configuré »", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, { message: "Service unavailable" }, 503);
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const response = await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, reachable: false, clusters: [] });
  });

  it("convertit les ppm en pourcentage et expose les unités nommées des IO", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const response = await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() });
    const body = response.json();

    expect(body.reachable).toBe(true);
    expect(body.clusters).toHaveLength(1);
    const cluster = body.clusters[0];
    expect(cluster.uuid).toBe(CLUSTER_UUID);
    expect(cluster.name).toBe("CLUSTER_AHV_HDV");
    expect(cluster.version).toBe("7.5.0.6");
    expect(cluster.numNodes).toBe(3);
    // 147248 ppm = 14,7248 % ; 435358 ppm = 43,5358 %.
    expect(cluster.cpuUsagePercent).toBeCloseTo(14.7248, 4);
    expect(cluster.memoryUsagePercent).toBeCloseTo(43.5358, 4);
    expect(cluster.controllerIo).toMatchObject({
      totalIops: 517,
      readIops: 98,
      writeIops: 418,
      avgLatencyUsec: 679,
      avgReadLatencyUsec: 1084,
      avgWriteLatencyUsec: 583,
      totalThroughputKbytesPerSec: 8415,
      readThroughputKbytesPerSec: 3788,
      writeThroughputKbytesPerSec: 4627,
    });
    expect(cluster.clusterIo).toMatchObject({ totalIops: 138, readIops: 95, writeIops: 42, avgLatencyUsec: 403, totalThroughputKbytesPerSec: 5173 });
  });

  it("laisse ABSENTE toute métrique à la sentinelle \"-1\" plutôt que d'exposer -1", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const cluster = (await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() })).json().clusters[0];

    expect(cluster.clusterIo.avgReadLatencyUsec).toBeUndefined();
    expect(cluster.clusterIo.avgWriteLatencyUsec).toBeUndefined();
    // storage.rebuild_capacity_bytes vaut "-1" sur l'instance réelle et n'est pas exposé du tout.
    expect(cluster.storage).toEqual({
      capacityBytes: 34841033768368,
      freeBytes: 16347480464816,
      usedBytes: 18493553303552,
      logicalUsedBytes: 59901348118528,
    });
  });

  it("agrège les capacités CPU/mémoire depuis les hôtes réels et rapporte la santé", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const cluster = (await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() })).json().clusters[0];

    expect(cluster.cpuCapacityHz).toBe(100000000000);
    expect(cluster.memoryCapacityBytes).toBe(538718502912);
    expect(cluster.health).toEqual({
      currentFaultTolerance: 2,
      desiredFaultTolerance: 2,
      currentRedundancyFactor: 2,
      desiredRedundancyFactor: 2,
      hostsTotal: 2,
      hostsNormal: 2,
    });
  });

  it("expose les stats par hôte physique avec le MÊME uuid que /api/nutanix/vms (v3)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const cluster = (await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() })).json().clusters[0];

    expect(cluster.hosts).toHaveLength(2);
    expect(cluster.hosts[0]).toMatchObject({
      uuid: HOST1_UUID,
      name: "HDVNUTA1",
      state: "NORMAL",
      numVms: 7,
      inMaintenanceMode: false,
      degraded: false,
      numCpuCores: 20,
      cpuCapacityHz: 50000000000,
      memoryCapacityBytes: 269359251456,
    });
    expect(cluster.hosts[0].cpuUsagePercent).toBeCloseTo(14.7572, 4);
    expect(cluster.hosts[0].memoryUsagePercent).toBeCloseTo(44.8126, 4);
    expect(cluster.hosts[0].controllerIo).toMatchObject({ totalIops: 33, avgLatencyUsec: 3431, totalThroughputKbytesPerSec: 587 });
    expect(cluster.hosts[0].storage).toMatchObject({ capacityBytes: 18350433456291, usedBytes: 6467330696139 });
  });

  it("expose l'occupation par storage container réel", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    const cluster = (await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() })).json().clusters[0];

    expect(cluster.storageContainers).toHaveLength(2);
    expect(cluster.storageContainers[0]).toMatchObject({
      uuid: "f0add265-1a83-4e54-b4db-ba371d7c5864",
      name: "NutanixManagementShare",
      storage: { capacityBytes: 16634576256432, usedBytes: 274937434112, freeBytes: 16359638822320 },
    });
  });

  it("reste reachable:true si SEULS les hôtes/containers échouent (moitié réelle plutôt que rien)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, { message: "boom" }, 500);
    setResponse(CONTAINERS_KEY, { message: "boom" }, 500);

    const body = (await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() })).json();

    expect(body.reachable).toBe(true);
    const cluster = body.clusters[0];
    expect(cluster.hosts).toEqual([]);
    expect(cluster.storageContainers).toEqual([]);
    // Aucune capacité inventée quand aucun hôte n'a répondu (jamais « 0 Go de RAM »).
    expect(cluster.cpuCapacityHz).toBeUndefined();
    expect(cluster.memoryCapacityBytes).toBeUndefined();
    expect(cluster.health).toMatchObject({ hostsTotal: 0, hostsNormal: 0 });
  });

  it("n'émet AUCUNE requête v3 de statistiques (l'API v3 n'expose pas de stats de cluster)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(CLUSTERS_KEY, clustersBody());
    setResponse(HOSTS_KEY, hostsBody());
    setResponse(CONTAINERS_KEY, storageContainersBody());

    await app.inject({ method: "GET", url: "/api/nutanix/cluster-stats", cookies: adminCookie() });

    expect([...lastSearchByKey.keys()].some((k) => k.includes("/api/nutanix/v3/"))).toBe(false);
  });
});

describe("GET /api/nutanix/alerts", () => {
  it("401 sans session", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/alerts" });
    expect(response.statusCode).toBe(401);
  });

  it("configured:false si Nutanix n'a jamais été configuré", async () => {
    app = buildServer();
    await clearNutanixConfig();
    const response = await app.inject({ method: "GET", url: "/api/nutanix/alerts", cookies: adminCookie() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, reachable: false, alerts: [] });
  });

  it("reachable:false si Prism ne répond pas", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(ALERTS_KEY, { message: "nope" }, 503);

    const response = await app.inject({ method: "GET", url: "/api/nutanix/alerts", cookies: adminCookie() });

    expect(response.json()).toMatchObject({ configured: true, reachable: false, alerts: [] });
  });

  it("normalise la sévérité, résout les marqueurs du message et convertit les µs en ISO", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(ALERTS_KEY, alertsBody());

    const body = (await app.inject({ method: "GET", url: "/api/nutanix/alerts", cookies: adminCookie() })).json();

    expect(body).toMatchObject({ configured: true, reachable: true, totalUnresolved: 25 });
    expect(body.alerts).toHaveLength(2);
    const first = body.alerts[0];
    expect(first).toMatchObject({
      id: "f9b5975d-3a52-48d1-8e23-e26bc9e28899",
      severity: "warning",
      severityRaw: "kWarning",
      title: "Application-Consistent Recovery Point Failed",
      acknowledged: false,
      entityType: "vm",
      entityName: "HDVAIRSDB",
      entityUuid: "c8ca7426-8fb3-432d-a678-efec13e7dbf2",
      clusterUuid: CLUSTER_UUID,
    });
    expect(first.message).toBe(
      "Application-Consistent Recovery Point for the VM HDVAIRSDB failed because Quiescing guest VM failed or timed out.",
    );
    // 1786378665233736 µs -> 1786378665233,736 ms -> arrondi à la milliseconde la plus proche.
    expect(first.createdAt).toBe("2026-08-10T16:17:45.234Z");
    expect(first.lastOccurredAt).toBe("2026-08-18T16:12:28.797Z");
    expect(body.alerts[1]).toMatchObject({ severity: "critical", severityRaw: "kCritical", acknowledged: true });
    expect(body.alerts[1].message).toBe(
      "Failed to capture the Recovery Point for VM 'HDVCIRIL'. Failed to fetch VM info with error code: kNarsilVmGetFailed",
    );
  });

  it("trie les alertes de la plus récente à la plus ancienne", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(ALERTS_KEY, alertsBody());

    const body = (await app.inject({ method: "GET", url: "/api/nutanix/alerts", cookies: adminCookie() })).json();

    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual([
      "f9b5975d-3a52-48d1-8e23-e26bc9e28899",
      "1f9d0c31-0000-4000-8000-000000000002",
    ]);
  });

  it("ne demande QUE les alertes non résolues et borne le nombre demandé", async () => {
    app = buildServer();
    await seedNutanixConfig();
    setResponse(ALERTS_KEY, alertsBody());

    await app.inject({ method: "GET", url: "/api/nutanix/alerts?limit=5", cookies: adminCookie() });
    expect(lastSearchByKey.get(ALERTS_KEY)).toBe("?resolved=false&count=5");

    await app.inject({ method: "GET", url: "/api/nutanix/alerts?limit=9999", cookies: adminCookie() });
    expect(lastSearchByKey.get(ALERTS_KEY)).toBe("?resolved=false&count=100");

    await app.inject({ method: "GET", url: "/api/nutanix/alerts?limit=nawak", cookies: adminCookie() });
    expect(lastSearchByKey.get(ALERTS_KEY)).toBe("?resolved=false&count=25");
  });
});
