import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

/**
 * Détection automatique du port de routage (services/reverseProxy.ts) — le port n'est plus
 * obligatoire à la création d'une route ni au déploiement : il est déduit du conteneur RÉEL.
 *
 * Aucun démon Docker n'est requis : services/docker.ts est mocké par un faux client dockerode dont
 * l'`inspect()` renvoie exactement les formes que renvoie le vrai (`Config.ExposedPorts`,
 * `NetworkSettings.Ports`). Stores isolés dans un dossier temporaire et CADDY_ADMIN_URL détourné
 * (même précaution que test/reverseProxy.test.ts : jamais le Caddy de dev), `fetch` stubé pour que
 * le push de configuration réussisse sans réseau.
 */
const tmpDir = path.join(os.tmpdir(), `quai-api-test-port-detection-${Date.now()}-${Math.random().toString(16).slice(2)}`);
fsSync.mkdirSync(tmpDir, { recursive: true });
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.REVERSE_PROXY_PATH = path.join(tmpDir, "reverse-proxy.json");
process.env.CERTIFICATES_PATH = path.join(tmpDir, "certificates.json");
process.env.CADDY_ADMIN_URL = "http://caddy:1";
process.env.CONFIG_ENCRYPTION_KEY = "3".repeat(64);

/** Conteneurs "réels" présentés par le faux client, pilotés par chaque test. */
let inspectByContainerId = new Map<string, unknown>();
/** Ids réellement inspectés — sert à prouver qu'un port saisi n'entraîne AUCUNE inspection. */
let inspectedIds: string[] = [];

const fakeDocker = {
  getContainer: (id: string) => ({
    inspect: async () => {
      inspectedIds.push(id);
      const found = inspectByContainerId.get(id);
      if (!found) throw new Error(`No such container: ${id}`);
      return found;
    },
  }),
};

vi.mock("../src/services/docker.js", () => ({
  getClient: async () => fakeDocker,
  getContainerNetworkAddress: async (id: string) => (inspectByContainerId.has(id) ? "10.0.0.5" : null),
}));

const {
  chooseTargetPort,
  containerPortCandidates,
  createRoute,
  deleteRoute,
  describeTargetPortDetection,
  detectContainerTargetPort,
  listRoutes,
  TargetPortDetectionError,
} = await import("../src/services/reverseProxy.js");

beforeEach(() => {
  inspectByContainerId = new Map();
  inspectedIds = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(async () => {
  // Via l'API réelle : le service garde un cache mémoire que supprimer le fichier ne viderait pas.
  for (const route of await listRoutes()) await deleteRoute(route.id);
  vi.unstubAllGlobals();
  await fs.rm(path.join(tmpDir, "reverse-proxy.json"), { force: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("chooseTargetPort — règle de choix documentée", () => {
  it("un seul port exposé : on le prend", () => {
    expect(chooseTargetPort([8080])).toEqual({ port: 8080, rule: "single" });
  });

  it("plusieurs ports : 80, puis 8080, 8000, 3000, 5000 — dans cet ordre", () => {
    expect(chooseTargetPort([5432, 8080, 80])).toEqual({ port: 80, rule: "preferred" });
    expect(chooseTargetPort([5432, 8080, 8000])).toEqual({ port: 8080, rule: "preferred" });
    expect(chooseTargetPort([9000, 8000, 3000])).toEqual({ port: 8000, rule: "preferred" });
    expect(chooseTargetPort([9000, 5000, 3000])).toEqual({ port: 3000, rule: "preferred" });
    expect(chooseTargetPort([9000, 5000])).toEqual({ port: 5000, rule: "preferred" });
  });

  it("plusieurs ports, aucun usuel : le plus petit", () => {
    expect(chooseTargetPort([9000, 5432])).toEqual({ port: 5432, rule: "lowest" });
  });

  it("aucun port : null — jamais un port inventé", () => {
    expect(chooseTargetPort([])).toBeNull();
  });
});

describe("containerPortCandidates — configuration du conteneur d'abord, ports publiés à défaut", () => {
  it("lit Config.ExposedPorts et ignore l'UDP (jamais un upstream HTTP)", () => {
    expect(containerPortCandidates({ Config: { ExposedPorts: { "8080/tcp": {}, "53/udp": {} } } })).toEqual({
      ports: [8080],
      source: "exposed",
    });
  });

  it("aucun ExposedPorts : retombe sur les ports RÉELLEMENT publiés", () => {
    expect(
      containerPortCandidates({
        Config: { ExposedPorts: {} },
        NetworkSettings: {
          Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }], "9229/tcp": null },
        },
      }),
    ).toEqual({ ports: [3000], source: "published" });
  });

  it("rien d'exposé ni de publié : aucun candidat", () => {
    expect(containerPortCandidates({}).ports).toEqual([]);
    expect(containerPortCandidates({ Config: { ExposedPorts: {} }, NetworkSettings: { Ports: {} } }).ports).toEqual([]);
  });
});

describe("createRoute sans targetPort — déduction depuis le conteneur réel", () => {
  it("un seul port exposé : retenu et conservé sur la route", async () => {
    inspectByContainerId.set("c-mono", { Config: { ExposedPorts: { "8080/tcp": {} } } });

    const route = await createRoute({ subdomain: "mono.lecreusot.priv", targetContainerId: "c-mono" });

    expect(route.targetPort).toBe(8080);
    expect(route.portDetection).toEqual({ rule: "single", candidates: [8080], source: "exposed" });
    expect(inspectedIds).toEqual(["c-mono"]);
  });

  it("plusieurs ports : ordre de préférence respecté, tous les candidats conservés pour correction", async () => {
    inspectByContainerId.set("c-multi", {
      Config: { ExposedPorts: { "9000/tcp": {}, "5432/tcp": {}, "8080/tcp": {} } },
    });

    const route = await createRoute({ subdomain: "multi.lecreusot.priv", targetContainerId: "c-multi" });

    expect(route.targetPort).toBe(8080);
    expect(route.portDetection).toEqual({ rule: "preferred", candidates: [5432, 8080, 9000], source: "exposed" });
    // Ce que le journal de déploiement écrit tel quel (services/github.ts) : le port ET son origine.
    expect(describeTargetPortDetection({ port: 8080, rule: "preferred", candidates: [5432, 8080, 9000], source: "exposed" })).toBe(
      "port 8080 parmi 5432, 8080, 9000 (ports HTTP usuels prioritaires : 80, 8080, 8000, 3000, 5000)",
    );
  });

  it("plusieurs ports sans port HTTP usuel : plus petit retenu, choix journalisable", () => {
    const detection = { port: 5432, rule: "lowest" as const, candidates: [5432, 9000], source: "exposed" as const };
    expect(describeTargetPortDetection(detection)).toBe(
      "port 5432 parmi 5432, 9000 (aucun port HTTP usuel exposé : le plus petit est retenu)",
    );
    expect(describeTargetPortDetection({ port: 8080, rule: "single", candidates: [8080], source: "exposed" })).toBe(
      "port 8080 (seul port TCP du conteneur)",
    );
  });

  it("aucun port exposé : échec EXPLICITE demandant de le saisir, aucune route créée", async () => {
    inspectByContainerId.set("c-vide", { Config: { ExposedPorts: {} }, NetworkSettings: { Ports: {} } });

    const error = await createRoute({ subdomain: "vide.lecreusot.priv", targetContainerId: "c-vide" }).catch((err) => err);

    expect(error).toBeInstanceOf(TargetPortDetectionError);
    expect((error as Error).message).toContain("n'expose aucun port TCP");
    expect((error as Error).message).toContain("saisissez le port cible explicitement");
    expect(await listRoutes()).toEqual([]);
  });

  it("conteneur inintrospectable : échec explicite, jamais un port de repli inventé", async () => {
    const error = await createRoute({ subdomain: "absent.lecreusot.priv", targetContainerId: "c-absent" }).catch((err) => err);

    expect(error).toBeInstanceOf(TargetPortDetectionError);
    expect((error as Error).message).toContain("Impossible d'inspecter le conteneur");
    expect(await listRoutes()).toEqual([]);
  });

  it("cible host:port arbitraire : le port reste obligatoire (rien à inspecter)", async () => {
    const error = await createRoute({ subdomain: "hote.lecreusot.priv", targetHost: "10.1.2.3" }).catch((err) => err);

    expect(error).toBeInstanceOf(TargetPortDetectionError);
    expect(await listRoutes()).toEqual([]);
  });
});

describe("Port saisi à la main — toujours prioritaire", () => {
  it("le port fourni l'emporte sur les ports exposés, et aucune inspection n'a lieu", async () => {
    inspectByContainerId.set("c-manuel", { Config: { ExposedPorts: { "80/tcp": {} } } });

    const route = await createRoute({ subdomain: "manuel.lecreusot.priv", targetContainerId: "c-manuel", targetPort: 9443 });

    expect(route.targetPort).toBe(9443);
    expect(route.portDetection).toBeUndefined();
    expect(inspectedIds).toEqual([]);
  });
});

describe("detectContainerTargetPort — client dockerode fourni par l'appelant", () => {
  it("inspecte l'hôte de l'appelant (déploiement sur un Docker distant) plutôt que le démon local", async () => {
    const remote = {
      getContainer: () => ({
        inspect: async () => ({ Config: { ExposedPorts: { "9229/tcp": {}, "3000/tcp": {} } } }),
      }),
    } as unknown as Docker;

    expect(await detectContainerTargetPort("c-distant", remote)).toEqual({
      port: 3000,
      rule: "preferred",
      candidates: [3000, 9229],
      source: "exposed",
    });
    // Le démon local n'a pas été sollicité.
    expect(inspectedIds).toEqual([]);
  });
});
