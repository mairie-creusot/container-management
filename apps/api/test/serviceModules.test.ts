import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONFIG_PATH isolé (même pattern que adDns.test.ts/lxc.test.ts) : le store de liaisons écrit à
 * côté de config.json (services/serviceBindingsStore.ts), et le module "ad-dns" lit la config AD
 * réellement persistée.
 *
 * Couvre les deux étages du mécanisme générique :
 *  - le CONTRAT (forme du snapshot, registre, liaison automatique VÉRIFIABLE et son refus de
 *    deviner en cas d'ambiguïté) ;
 *  - le premier fournisseur RÉEL "ad-dns" (état explicite tant que l'intégration n'est pas
 *    configurée, jamais de données de démonstration).
 */
const tmpDir = path.join(os.tmpdir(), `quai-svcmod-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tmpConfigPath = path.join(tmpDir, "config.json");
process.env.CONFIG_PATH = tmpConfigPath;
process.env.CONFIG_ENCRYPTION_KEY = "7".repeat(64);

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const {
  buildAdDnsSnapshot,
  getServiceModuleProvider,
  listServiceModules,
  mergeBindings,
  nodeIdentity,
  resolveAutomaticBindings,
  resolveServiceModuleProvider,
  SERVICE_MODULE_PROVIDERS,
} = await import("../src/services/serviceModules.js");
const { resetServiceBindingsCacheForTests } = await import("../src/services/serviceBindingsStore.js");

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetServiceBindingsCacheForTests();
  await fs.rm(path.join(tmpDir, "service-bindings.json"), { force: true });
});

function cookieFor(roles: ("admin" | "operator" | "viewer")[]) {
  const token = signSessionToken({ username: "demo", displayName: "Demo User", roles });
  return { [config.session.cookieName]: token };
}

describe("registre de modules métier", () => {
  it("expose chaque fournisseur avec son état de configuration réel", async () => {
    const modules = await listServiceModules();
    expect(modules.map((m) => m.id)).toContain("ad-dns");
    // Aucune config AD dans ce CONFIG_PATH isolé -> honnêtement non configuré, jamais "configuré".
    expect(modules.find((m) => m.id === "ad-dns")?.configured).toBe(false);
  });

  it("résout un fournisseur par id et ignore un id inconnu", () => {
    expect(getServiceModuleProvider("ad-dns")?.label).toBeTruthy();
    expect(getServiceModuleProvider("nope")).toBeUndefined();
  });

  it("chaque fournisseur du registre déclare le contrat complet", () => {
    for (const provider of SERVICE_MODULE_PROVIDERS) {
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.label).toBe("string");
      expect(typeof provider.isConfigured).toBe("function");
      expect(typeof provider.configuredHosts).toBe("function");
      expect(typeof provider.getSnapshot).toBe("function");
    }
  });
});

describe("tout module ACTIF est un module métier liable", () => {
  // Sans cela, seuls les deux fournisseurs écrits à la main étaient rattachables à une VM : HYCU,
  // GLPI, Nutanix et tout module tiers décrivent pourtant déjà leur instantané.
  it("les greffons livrés rejoignent le registre, avec le libellé de leur manifeste", async () => {
    const modules = await listServiceModules();
    const ids = modules.map((m) => m.id);

    expect(ids).toContain("hycu");
    expect(ids).toContain("nutanix");
    expect(modules.find((m) => m.id === "hycu")?.label).toBe("Sauvegarde HYCU");
    // Rien n'est configuré dans ce CONFIG_PATH isolé : c'est dit, jamais supposé.
    expect(modules.find((m) => m.id === "hycu")?.configured).toBe(false);
  });

  it("un fournisseur ÉCRIT À LA MAIN l'emporte sur le greffon de même identifiant", async () => {
    // "3cx" existe des deux côtés : l'instantané écrit ici sait rendre les appels en cours, pas
    // celui déduit du manifeste. Un seul doit rester, et c'est le plus riche.
    const modules = await listServiceModules();
    expect(modules.filter((m) => m.id === "3cx")).toHaveLength(1);
    expect((await resolveServiceModuleProvider("3cx"))?.description).toContain("appels en cours");
  });

  it("résout un module de greffon par son identifiant, et rend son instantané réel", async () => {
    const provider = await resolveServiceModuleProvider("hycu");
    expect(provider).toBeDefined();

    const snapshot = await provider!.getSnapshot();
    expect(snapshot.moduleId).toBe("hycu");
    // Non configuré : listes VIDES et état explicite, jamais des données de démonstration.
    expect(snapshot.status).toBe("not-configured");
    expect(snapshot.entities).toEqual([]);
  });

  it("un greffon n'apporte AUCUNE liaison automatique : le socle ne devine aucun hôte", async () => {
    const provider = await resolveServiceModuleProvider("hycu");
    expect(await provider!.configuredHosts()).toEqual([]);
  });

  it("un identifiant inconnu reste inconnu, greffons compris", async () => {
    expect(await resolveServiceModuleProvider("nope")).toBeUndefined();
  });
});

describe("liaison automatique nœud <-> module", () => {
  const nodes = [
    { id: "nutanix-vm:uuid-3cx", label: "HDV3CX", ips: ["10.10.0.30"] },
    { id: "nutanix-vm:uuid-dc", label: "SRVDC01", ips: ["10.10.0.10"] },
    { id: "container:abc", label: "quai-dev-api-1", ips: [] },
  ];

  it("lie sur le nom court quand l'intégration est configurée avec un FQDN", () => {
    const bindings = resolveAutomaticBindings(nodes, { "ad-dns": ["srvdc01.lecreusot.priv"] });
    expect(bindings).toEqual([
      { nodeId: "nutanix-vm:uuid-dc", moduleId: "ad-dns", origin: "automatic", matchedOn: "srvdc01.lecreusot.priv" },
    ]);
  });

  it("lie sur une IP RÉELLE du nœud quand l'intégration est configurée par IP", () => {
    const bindings = resolveAutomaticBindings(nodes, { "3cx": ["10.10.0.30"] });
    expect(bindings).toEqual([{ nodeId: "nutanix-vm:uuid-3cx", moduleId: "3cx", origin: "automatic", matchedOn: "10.10.0.30" }]);
  });

  it("ne lie RIEN sur une correspondance partielle (jamais une sous-chaîne)", () => {
    expect(resolveAutomaticBindings(nodes, { "ad-dns": ["srvdc"] })).toEqual([]);
    expect(resolveAutomaticBindings(nodes, { "ad-dns": ["srvdc01-old.lecreusot.priv"] })).toEqual([]);
  });

  it("ne lie RIEN quand une IP configurée n'appartient réellement à aucun nœud", () => {
    expect(resolveAutomaticBindings(nodes, { "3cx": ["10.10.0.99"] })).toEqual([]);
  });

  it("ne devine PAS en cas d'ambiguïté (deux nœuds homonymes)", () => {
    const ambiguous = [
      { id: "nutanix-vm:a", label: "HDV3CX", ips: [] },
      { id: "nutanix-vm:b", label: "hdv3cx.lecreusot.priv", ips: [] },
    ];
    expect(resolveAutomaticBindings(ambiguous, { "3cx": ["HDV3CX"] })).toEqual([]);
  });

  // Régression du 24/08/2026 : le graphe portait un nœud "ad-server" étiqueté avec le hostname du
  // KDC EN PLUS de la VM Nutanix qui l'exécute — deux candidats pour le même hôte configuré, donc
  // ambiguïté et AUCUNE liaison. Le nœud a été retiré de services/topology.ts : seule la VM reste,
  // et le module se rattache enfin au nœud réel.
  it("le module AD/DNS se lie à la VM du contrôleur de domaine, plus aucun nœud « ad-server » ne le rend ambigu", () => {
    const withLegacyAdServerNode = [
      { id: "nutanix-vm:uuid-dc", label: "HDVAD2", ips: [] },
      { id: "ad-server:HDVAD2.lecreusot.priv", label: "HDVAD2.lecreusot.priv", ips: [] },
    ];
    expect(resolveAutomaticBindings(withLegacyAdServerNode, { "ad-dns": ["HDVAD2.lecreusot.priv"] })).toEqual([]);

    const graphOfToday = [{ id: "nutanix-vm:uuid-dc", label: "HDVAD2", ips: [] }];
    expect(resolveAutomaticBindings(graphOfToday, { "ad-dns": ["HDVAD2.lecreusot.priv"] })).toEqual([
      { nodeId: "nutanix-vm:uuid-dc", moduleId: "ad-dns", origin: "automatic", matchedOn: "HDVAD2.lecreusot.priv" },
    ]);
  });

  it("fait primer la liaison manuelle sur l'automatique pour un même nœud", () => {
    const merged = mergeBindings(
      [{ nodeId: "nutanix-vm:uuid-3cx", moduleId: "3cx", origin: "manual" }],
      [{ nodeId: "nutanix-vm:uuid-3cx", moduleId: "ad-dns", origin: "automatic", matchedOn: "x" }],
    );
    expect(merged).toEqual([{ nodeId: "nutanix-vm:uuid-3cx", moduleId: "3cx", origin: "manual" }]);
  });

  it("n'extrait comme IP que celles RÉELLEMENT rapportées par la plateforme", () => {
    const identity = nodeIdentity({
      id: "nutanix-vm:x",
      kind: "nutanix-vm",
      label: "HDV3CX",
      subtitle: "10.10.0.30 — jamais lu comme une IP",
      status: "running",
      nutanixNetworks: [{ ips: ["10.10.0.30", "pas-une-ip"] }],
    });
    expect(identity.ips).toEqual(["10.10.0.30"]);
  });
});

describe("module ad-dns (fournisseur réel)", () => {
  it("renvoie un état explicite tant que l'intégration n'est pas configurée", async () => {
    const snapshot = await buildAdDnsSnapshot({ probe: async () => new Map() });
    expect(snapshot.moduleId).toBe("ad-dns");
    expect(snapshot.status).toBe("not-configured");
    expect(snapshot.message).toBeTruthy();
    // Jamais d'entité/relation de démonstration pour combler l'absence de configuration.
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.relations).toEqual([]);
    expect(snapshot.summary).toEqual([]);
  });

  it("décrit serveur + zone dès que la configuration AD est réelle, sans inventer d'enregistrement", async () => {
    app = buildServer();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/ad-dns/config",
      cookies: cookieFor(["admin"]),
      payload: {
        realm: "lecreusot.priv",
        kdcHost: "srvdc01.lecreusot.priv",
        zone: "lecreusot.priv",
        serviceAccount: "svc-quai-dns",
        targetIp: "10.0.0.42",
        password: "s3cret",
      },
    });
    expect(saved.statusCode).toBe(200);

    const snapshot = await buildAdDnsSnapshot({ probe: async () => new Map() });
    expect(snapshot.status).toBe("ready");
    const kinds = snapshot.entities.map((e) => e.kind);
    expect(kinds).toContain("dns-server");
    expect(kinds).toContain("dns-zone");
    // Un enregistrement n'existe QUE s'il correspond à une vraie route de reverse proxy — jamais
    // fabriqué (le nombre réel dépend de l'environnement, seule la forme est vérifiable ici).
    const recordCount = kinds.filter((k) => k === "dns-record").length;
    expect(snapshot.summary.find((s) => s.label === "Enregistrements gérés")?.value).toBe(String(recordCount));
    expect(snapshot.relations).toContainEqual({
      id: "serves:zone:lecreusot.priv",
      source: "server:srvdc01.lecreusot.priv",
      target: "zone:lecreusot.priv",
      kind: "serves",
      label: "zone servie",
      state: "idle",
    });
    // Cohérence structurelle du contrat : toute relation relie deux entités réellement présentes.
    const entityIds = new Set(snapshot.entities.map((e) => e.id));
    for (const relation of snapshot.relations) {
      expect(entityIds.has(relation.source)).toBe(true);
      expect(entityIds.has(relation.target)).toBe(true);
    }
    expect(snapshot.summary.find((s) => s.label === "Realm")?.value).toBe("LECREUSOT.PRIV");

    // L'hôte configuré devient la base de la liaison automatique — vérifiable, jamais supposée.
    expect(await getServiceModuleProvider("ad-dns")!.configuredHosts()).toEqual(["srvdc01.lecreusot.priv"]);
  });
});

describe("routes /api/service-modules", () => {
  it("liste les modules pour tout utilisateur authentifié", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/service-modules", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { modules: { id: string }[] }).modules.map((m) => m.id)).toContain("ad-dns");
  });

  it("refuse une liaison manuelle à un viewer (403, hook global sur les méthodes mutantes)", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/service-modules/bindings",
      cookies: cookieFor(["viewer"]),
      payload: { nodeId: "nutanix-vm:uuid-3cx", moduleId: "ad-dns" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuse un module inconnu avec 400 plutôt que d'enregistrer une liaison morte", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "PUT",
      url: "/api/service-modules/bindings",
      cookies: cookieFor(["operator"]),
      payload: { nodeId: "nutanix-vm:uuid-3cx", moduleId: "module-inexistant" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("persiste puis retire une liaison manuelle", async () => {
    app = buildServer();
    const put = await app.inject({
      method: "PUT",
      url: "/api/service-modules/bindings",
      cookies: cookieFor(["operator"]),
      payload: { nodeId: "nutanix-vm:uuid-3cx", moduleId: "ad-dns" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ nodeId: "nutanix-vm:uuid-3cx", moduleId: "ad-dns", boundBy: "demo" });

    const list = await app.inject({ method: "GET", url: "/api/service-modules/bindings", cookies: cookieFor(["viewer"]) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { bindings: { nodeId: string; origin: string }[] }).bindings).toContainEqual({
      nodeId: "nutanix-vm:uuid-3cx",
      moduleId: "ad-dns",
      origin: "manual",
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/service-modules/bindings/${encodeURIComponent("nutanix-vm:uuid-3cx")}`,
      cookies: cookieFor(["operator"]),
    });
    expect(del.statusCode).toBe(200);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/service-modules/bindings/${encodeURIComponent("nutanix-vm:uuid-3cx")}`,
      cookies: cookieFor(["operator"]),
    });
    expect(again.statusCode).toBe(404);
  });

  it("404 sur le snapshot d'un module inconnu", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/service-modules/module-inexistant/snapshot",
      cookies: cookieFor(["viewer"]),
    });
    expect(response.statusCode).toBe(404);
  });

  it("renvoie un snapshot à la forme générique pour un module connu", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/service-modules/ad-dns/snapshot", cookies: cookieFor(["viewer"]) });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json() as Record<string, unknown>;
    expect(snapshot).toHaveProperty("moduleId", "ad-dns");
    expect(snapshot).toHaveProperty("generatedAt");
    expect(Array.isArray(snapshot.summary)).toBe(true);
    expect(Array.isArray(snapshot.entities)).toBe(true);
    expect(Array.isArray(snapshot.relations)).toBe(true);
  });
});
