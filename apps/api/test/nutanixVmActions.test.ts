import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Cycle de vie (démarrer/arrêter/redémarrer/supprimer) + migration hôte-à-hôte d'une VM Nutanix —
 * voir services/nutanix.ts (section "Actions de cycle de vie...") et routes/nutanix.ts.
 *
 * Même isolement CONFIG_PATH que nutanix.test.ts (positionné avant le premier import de
 * src/config.js) — évite de polluer le config.json de développement réel. Contrairement à
 * nutanixHostsAndVmDetails.test.ts (qui mocke aussi ../src/services/setupStore.js car il
 * n'exerce que des fonctions services isolées), ce fichier utilise buildServer()+inject() de
 * bout en bout : setupStore.js reste RÉEL (isSetupCompleted/hasEverCompletedSetup sont utilisés
 * par le hook d'auth global sur CHAQUE requête, les mocker casserait l'authentification de tout
 * ce fichier) — seule la config Nutanix effective est seedée via le vrai setNutanixConfig()
 * (persistance seule, aucun appel réseau) dans le fichier de config temporaire isolé.
 *
 * `node:https` est mocké (jamais un vrai socket ouvert vers Prism Central, ni a fortiori vers
 * l'instance réelle de production) — routé par `${method} ${pathname}`, avec une FILE de réponses
 * par clé (nécessaire pour restartNutanixVm, qui enchaîne plusieurs GET/PUT sur le même chemin) :
 * la dernière réponse enregistrée pour une clé est répétée indéfiniment une fois la file épuisée.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

interface MockResponse {
  status: number;
  body: unknown;
}

const queuesByKey = new Map<string, MockResponse[]>();
const lastByKey = new Map<string, MockResponse>();
/** Corps JSON envoyé (PUT) pour la DERNIÈRE requête de chaque clé — pour assertions sur le body réel. */
const lastRequestBodyByKey = new Map<string, unknown>();

function queueResponse(key: string, body: unknown, status = 200): void {
  const list = queuesByKey.get(key) ?? [];
  list.push({ status, body });
  queuesByKey.set(key, list);
}

function nextResponse(key: string): MockResponse {
  const queue = queuesByKey.get(key);
  if (queue && queue.length > 0) {
    const res = queue.shift()!;
    lastByKey.set(key, res);
    return res;
  }
  return lastByKey.get(key) ?? { status: 200, body: {} };
}

vi.mock("node:https", () => ({
  request: (target: URL, options: { method?: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write: (b: unknown) => void; end: () => void; destroy: () => void };
    const key = `${options.method ?? "GET"} ${target.pathname}`;
    let written = "";
    req.write = (chunk: unknown) => {
      written += typeof chunk === "string" ? chunk : String(chunk);
    };
    req.destroy = () => {};
    req.end = () => {
      if (written) {
        try {
          lastRequestBodyByKey.set(key, JSON.parse(written));
        } catch {
          lastRequestBodyByKey.set(key, written);
        }
      }
      const found = nextResponse(key);
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
const { setNutanixConfig } = await import("../src/services/setupStore.js");
// Retour à "jamais configuré" APRÈS migration en greffon : le champ typé seedé ci-dessus est repris
// puis retiré par plugins/nutanix/config.ts — seul removeNutanixPluginConfig() efface les deux.
const { removeNutanixPluginConfig } = await import("../src/plugins/nutanix/config.js");
const { listAuditEvents } = await import("../src/services/auditLog.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  queuesByKey.clear();
  lastByKey.clear();
  lastRequestBodyByKey.clear();
});

const VM_UUID = "dc52605f-e91a-4dd2-b966-3dd76c52bf8d";
const CLUSTER_UUID = "0005b4db-f6b4-0926-62f9-3cecef178022";
const HOST_A = "9708aa74-e03a-4adf-ac1f-1cbfd82ea8eb"; // hôte actuel de la VM
const HOST_B = "655ce338-42e8-448a-b2b4-5a95150c0d43"; // même cluster, autre hôte
const HOST_OTHER_CLUSTER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Extrait RÉEL (allégé) d'une entité VM complète, forme confirmée en conditions réelles le
 * 14/08/2026 sur l'instance 172.20.0.10:9440 (VM "HDVAPPLI", vérification en LECTURE SEULE
 * uniquement — voir services/nutanix.ts en-tête de section). */
function vmEntity(overrides: { powerState: "ON" | "OFF"; hostUuid?: string }): unknown {
  return {
    api_version: "3.1",
    metadata: { uuid: VM_UUID, spec_version: 5, kind: "vm" },
    spec: {
      name: "HDVAPPLI",
      resources: {
        power_state: overrides.powerState,
        power_state_mechanism: { mechanism: "HARD" },
        num_sockets: 2,
        num_vcpus_per_socket: 2,
        memory_size_mib: 8192,
      },
      cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID, name: "CLUSTER_AHV_HDV" },
    },
    status: {
      name: "HDVAPPLI",
      resources: {
        power_state: overrides.powerState,
        ...(overrides.hostUuid ? { host_reference: { kind: "host", uuid: overrides.hostUuid, name: "172.20.0.5" } } : {}),
      },
      cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID, name: "CLUSTER_AHV_HDV" },
    },
  };
}

async function seedNutanixConfig(): Promise<void> {
  await setNutanixConfig({ prismCentralUrl: "https://172.20.0.10:9440", username: "Admin", password: "secret" });
}

/** L'écriture de l'événement d'audit (plugins/audit.ts#onResponse, `fs.appendFile`) n'est pas
 * garantie terminée au moment où `app.inject()` résout sa promesse (le hook `onResponse` de
 * Fastify s'exécute APRÈS l'envoi de la réponse — constaté empiriquement ici : une lecture
 * immédiate de `listAuditEvents()` manque parfois le tout dernier événement) — on repolle
 * brièvement plutôt que de supposer une écriture synchrone qu'aucune garantie ne promet. */
async function waitForAuditEvent(predicate: (e: Awaited<ReturnType<typeof listAuditEvents>>[number]) => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await listAuditEvents();
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function adminCookie() {
  const token = signSessionToken({ username: "ybanas", displayName: "Yann Banas", roles: ["admin"] });
  return { [config.session.cookieName]: token };
}
function viewerCookie() {
  const token = signSessionToken({ username: "viewer", displayName: "Viewer", roles: ["viewer"] });
  return { [config.session.cookieName]: token };
}

describe("Actions de cycle de vie d'une VM Nutanix — autorisation", () => {
  it("401 sans session sur POST .../start", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start` });
    expect(response.statusCode).toBe(401);
  });

  it("403 pour un rôle viewer (operator/admin requis — garde globale plugins/auth.ts)", async () => {
    app = buildServer();
    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: viewerCookie() });
    expect(response.statusCode).toBe(403);
  });

  it("400 si Nutanix n'a jamais été configuré", async () => {
    app = buildServer();
    await removeNutanixPluginConfig();
    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: adminCookie() });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/nutanix/vms/:uuid/start", () => {
  it("démarre une VM éteinte", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));
    queueResponse(`PUT /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
    const body = lastRequestBodyByKey.get(`PUT /api/nutanix/v3/vms/${VM_UUID}`) as { spec: { resources: { power_state: string } } };
    expect(body.spec.resources.power_state).toBe("ON");
  });

  it("409 si la VM est déjà allumée (no-op explicite, jamais un faux succès)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: adminCookie() });

    expect(response.statusCode).toBe(409);
  });

  it("enregistre l'action dans le journal d'audit (mécanisme automatique plugins/audit.ts)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));
    queueResponse(`PUT /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON" }));

    await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: adminCookie() });

    const event = await waitForAuditEvent((e) => e.path === `/api/nutanix/vms/${VM_UUID}/start` && e.ok);
    expect(event).toBeDefined();
    expect(event?.actor).toBe("ybanas");
    expect(event?.ok).toBe(true);
    expect(event?.method).toBe("POST");
  });
});

describe("POST /api/nutanix/vms/:uuid/stop", () => {
  it("arrête GRACIEUSEMENT (ACPI, jamais HARD) une VM allumée", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse(`PUT /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/stop`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    const body = lastRequestBodyByKey.get(`PUT /api/nutanix/v3/vms/${VM_UUID}`) as {
      spec: { resources: { power_state: string; power_state_mechanism: { mechanism: string } } };
    };
    expect(body.spec.resources.power_state).toBe("OFF");
    expect(body.spec.resources.power_state_mechanism.mechanism).toBe("ACPI");
  });

  it("409 si la VM est déjà éteinte", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/stop`, cookies: adminCookie() });

    expect(response.statusCode).toBe(409);
  });
});

describe("POST /api/nutanix/vms/:uuid/restart", () => {
  it("redémarre GRACIEUSEMENT : extinction ACPI, attente de convergence réelle, puis rallumage", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const getKey = `GET /api/nutanix/v3/vms/${VM_UUID}`;
    const putKey = `PUT /api/nutanix/v3/vms/${VM_UUID}`;
    // 1) chargement initial : VM allumée
    queueResponse(getKey, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    // 2) PUT extinction accepté
    queueResponse(putKey, vmEntity({ powerState: "OFF" }));
    // 3) poll de convergence : déjà éteinte au premier essai
    queueResponse(getKey, vmEntity({ powerState: "OFF" }));
    // 4) rechargement avant le second PUT
    queueResponse(getKey, vmEntity({ powerState: "OFF" }));
    // 5) PUT rallumage accepté
    queueResponse(putKey, vmEntity({ powerState: "ON", hostUuid: HOST_A }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/restart`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
  });

  it("409 si la VM n'est pas actuellement allumée (utiliser Démarrer à la place)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/restart`, cookies: adminCookie() });

    expect(response.statusCode).toBe(409);
  });
});

describe("DELETE /api/nutanix/vms/:uuid", () => {
  it("409 si la VM est actuellement allumée (garde-fou QUAI — jamais de suppression en un clic d'une VM en cours d'exécution)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));

    const response = await app.inject({ method: "DELETE", url: `/api/nutanix/vms/${VM_UUID}`, cookies: adminCookie() });

    expect(response.statusCode).toBe(409);
  });

  it("supprime réellement une VM déjà éteinte", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));
    queueResponse(`DELETE /api/nutanix/v3/vms/${VM_UUID}`, {});

    const response = await app.inject({ method: "DELETE", url: `/api/nutanix/vms/${VM_UUID}`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
  });
});

describe("POST /api/nutanix/vms/:uuid/migrate", () => {
  function seedHosts(): void {
    // /hosts/list est toujours un POST côté Prism Central v3 (voir nutanix.ts#nutanixPost), jamais un GET.
    queueResponse("POST /api/nutanix/v3/hosts/list", {
      entities: [
        { metadata: { uuid: HOST_A }, status: { name: "HDVNUTA1", cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID } } },
        { metadata: { uuid: HOST_B }, status: { name: "HDVNUTA2", cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID } } },
        {
          metadata: { uuid: HOST_OTHER_CLUSTER },
          status: { name: "AUTRE-CLUSTER-HOTE", cluster_reference: { kind: "cluster", uuid: "un-autre-cluster" } },
        },
      ],
    });
  }

  it("400 si targetHostUuid absent du body", async () => {
    app = buildServer();
    await seedNutanixConfig();
    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("409 si l'hôte cible = hôte actuel (rien à faire)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: { targetHostUuid: HOST_A },
    });

    expect(response.statusCode).toBe(409);
  });

  it("409 si l'hôte cible appartient à un AUTRE cluster (jamais de migration inter-cluster silencieuse)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    seedHosts();

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: { targetHostUuid: HOST_OTHER_CLUSTER },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/different cluster/i);
  });

  it("409 si la VM n'est pas allumée (la migration live exige une VM en cours d'exécution)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "OFF" }));

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: { targetHostUuid: HOST_B },
    });

    expect(response.statusCode).toBe(409);
  });

  it("migre réellement vers un autre hôte du MÊME cluster", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(`GET /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    seedHosts();
    queueResponse(`PUT /api/nutanix/v3/vms/${VM_UUID}`, vmEntity({ powerState: "ON", hostUuid: HOST_B }));

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: { targetHostUuid: HOST_B },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI", targetHostName: "HDVNUTA2" });
    const body = lastRequestBodyByKey.get(`PUT /api/nutanix/v3/vms/${VM_UUID}`) as {
      spec: { resources: { host_reference: { uuid: string } } };
    };
    expect(body.spec.resources.host_reference.uuid).toBe(HOST_B);
  });
});

/** Corps 405 RÉEL observé le 18/08/2026 (notification QUAI en production, VM gérée côté Prism
 * Element) — déclenche le repli v2.0 (services/nutanix.ts#nutanixV2Mutation). */
const PE_405_BODY = {
  api_version: "3.1",
  code: 405,
  message_list: [{ message: "PE VM Put request not supported.", reason: "REQUEST_NOT_SUPPORTED" }],
  state: "ERROR",
};

describe("Repli API v2.0 quand la VM est gérée côté Prism Element (405 REQUEST_NOT_SUPPORTED)", () => {
  const GET_KEY = `GET /api/nutanix/v3/vms/${VM_UUID}`;
  const PUT_KEY = `PUT /api/nutanix/v3/vms/${VM_UUID}`;
  const V2_POWER_KEY = `POST /PrismGateway/services/rest/v2.0/vms/${VM_UUID}/set_power_state`;

  it("stop : bascule sur set_power_state ACPI_SHUTDOWN (gracieux, jamais un OFF brutal)", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse(PUT_KEY, PE_405_BODY, 405);
    queueResponse(V2_POWER_KEY, { task_uuid: "t-stop" });

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/stop`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
    expect(lastRequestBodyByKey.get(V2_POWER_KEY)).toEqual({ transition: "ACPI_SHUTDOWN" });
  });

  it("start : bascule sur set_power_state ON", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "OFF" }));
    queueResponse(PUT_KEY, PE_405_BODY, 405);
    queueResponse(V2_POWER_KEY, { task_uuid: "t-start" });

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/start`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(lastRequestBodyByKey.get(V2_POWER_KEY)).toEqual({ transition: "ON" });
  });

  it("restart : un SEUL appel ACPI_REBOOT (action gracieuse dédiée v2.0), jamais la séquence off/attente/on", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse(PUT_KEY, PE_405_BODY, 405);
    queueResponse(V2_POWER_KEY, { task_uuid: "t-reboot" });

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/restart`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
    expect(lastRequestBodyByKey.get(V2_POWER_KEY)).toEqual({ transition: "ACPI_REBOOT" });
  });

  it("delete : bascule sur DELETE v2.0", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "OFF" }));
    queueResponse(`DELETE /api/nutanix/v3/vms/${VM_UUID}`, PE_405_BODY, 405);
    queueResponse(`DELETE /PrismGateway/services/rest/v2.0/vms/${VM_UUID}`, { task_uuid: "t-del" });

    const response = await app.inject({ method: "DELETE", url: `/api/nutanix/vms/${VM_UUID}`, cookies: adminCookie() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI" });
  });

  it("migrate : bascule sur POST /migrate v2.0 avec host_uuid", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse("POST /api/nutanix/v3/hosts/list", {
      entities: [
        { metadata: { uuid: HOST_A }, status: { name: "HDVNUTA1", cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID } } },
        { metadata: { uuid: HOST_B }, status: { name: "HDVNUTA2", cluster_reference: { kind: "cluster", uuid: CLUSTER_UUID } } },
      ],
    });
    queueResponse(PUT_KEY, PE_405_BODY, 405);
    const v2MigrateKey = `POST /PrismGateway/services/rest/v2.0/vms/${VM_UUID}/migrate`;
    queueResponse(v2MigrateKey, { task_uuid: "t-mig" });

    const response = await app.inject({
      method: "POST",
      url: `/api/nutanix/vms/${VM_UUID}/migrate`,
      cookies: adminCookie(),
      payload: { targetHostUuid: HOST_B },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, vmName: "HDVAPPLI", targetHostName: "HDVNUTA2" });
    expect(lastRequestBodyByKey.get(v2MigrateKey)).toEqual({ host_uuid: HOST_B });
  });

  it("un 405 SANS REQUEST_NOT_SUPPORTED reste un 502 v3, AUCUN repli tenté", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse(PUT_KEY, { code: 405, message_list: [{ message: "Method Not Allowed" }] }, 405);

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/stop`, cookies: adminCookie() });

    expect(response.statusCode).toBe(502);
    expect(lastRequestBodyByKey.get(V2_POWER_KEY)).toBeUndefined();
  });

  it("un refus v2.0 remonte tel quel en 502 (message 'API v2.0'), jamais masqué", async () => {
    app = buildServer();
    await seedNutanixConfig();
    queueResponse(GET_KEY, vmEntity({ powerState: "ON", hostUuid: HOST_A }));
    queueResponse(PUT_KEY, PE_405_BODY, 405);
    queueResponse(V2_POWER_KEY, { message: "kInvalidState: cannot shutdown" }, 500);

    const response = await app.inject({ method: "POST", url: `/api/nutanix/vms/${VM_UUID}/stop`, cookies: adminCookie() });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(/v2\.0/);
  });
});
