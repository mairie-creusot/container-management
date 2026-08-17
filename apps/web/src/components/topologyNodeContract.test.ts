import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  CAPABILITY_DEFS,
  IAC_ENGINE_CONTRACT,
  NODE_CONTRACT,
  NODE_KINDS,
  buildNodeMenuItems,
} from "./topologyNodeContract";
import { buildTopologyEdges, computeNodeResourceAlerts } from "./topologyGraphShared";
import type { IacEngine, TopologyEdge, TopologyNode, TopologyNodeKind } from "@/types";

/**
 * Verrouille le CONTRAT générique des nœuds (topologyNodeContract.tsx, migration du 17/08/2026) :
 * chaque kind a une entrée complète, les conventions transverses (TARGET = Left / SOURCE = Right,
 * capacités symétriques) sont des invariants testés — plus jamais un kind ajouté "à moitié" (ports
 * oubliés = arêtes invisibles, bug réel du 14/08/2026 ; ports Top/Bottom = incohérence visuelle,
 * bug réel du 17/08/2026) — et les moteurs génériques (buildTopologyEdges/
 * computeNodeResourceAlerts/buildNodeMenuItems) rendent EXACTEMENT ce que rendait le code par-kind
 * dispersé qu'ils remplacent (zéro changement visuel/fonctionnel, mission Phase 1).
 */

/** Totalité vérifiée PAR LE COMPILATEUR : ajouter un kind à TopologyNodeKind (types.ts) sans
 * l'ajouter ici (et donc sans se poser la question de son contrat) casse la compilation. */
const ALL_KINDS_RECORD: Record<TopologyNodeKind, true> = {
  container: true,
  volume: true,
  network: true,
  "nutanix-vm": true,
  "ad-server": true,
  host: true,
  "cron-job": true,
  backup: true,
  "iac-workspace": true,
  "gitops-source": true,
  "automation-trigger": true,
  "automation-condition": true,
  "automation-action": true,
};
const ALL_KINDS = Object.keys(ALL_KINDS_RECORD).sort() as TopologyNodeKind[];

function node(kind: TopologyNodeKind, overrides: Partial<TopologyNode> = {}): TopologyNode {
  return { id: `${kind}:x1`, kind, label: "x1", subtitle: "sub", status: "running", ...overrides };
}

describe("NODE_CONTRACT — totalité et conventions transverses", () => {
  it("chaque kind du graphe a une entrée dans le registre (aucun oublié, aucun en trop)", () => {
    expect([...NODE_KINDS].sort()).toEqual(ALL_KINDS);
  });

  it("convention de ports : TARGET = Left, SOURCE = Right — pour TOUS les kinds, jamais Top/Bottom (bug réel du 17/08/2026)", () => {
    for (const kind of NODE_KINDS) {
      for (const port of NODE_CONTRACT[kind].ports) {
        const expected = port.handleType === "target" ? Position.Left : Position.Right;
        expect(port.position, `${kind}/${port.id}`).toBe(expected);
      }
    }
  });

  it("ids de port uniques au sein d'un même kind (contrainte React Flow : un Handle par id)", () => {
    for (const kind of NODE_KINDS) {
      const ids = NODE_CONTRACT[kind].ports.map((p) => p.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
    }
  });

  it("capacités symétriques : linksTo(linksTo(c)) === c pour toute capacité", () => {
    for (const [capability, def] of Object.entries(CAPABILITY_DEFS)) {
      expect(CAPABILITY_DEFS[def.linksTo].linksTo, capability).toBe(capability);
    }
  });

  it("un kind jamais connectable déclare EXPLICITEMENT ports: [] (jamais une absence implicite)", () => {
    for (const kind of ["ad-server", "iac-workspace", "cron-job", "backup", "gitops-source"] as const) {
      expect(NODE_CONTRACT[kind].ports).toEqual([]);
    }
  });

  it("nœuds d'automatisation : ports désormais déclarés (trigger = sortie seule, action = entrée seule, condition = les deux)", () => {
    expect(NODE_CONTRACT["automation-trigger"].ports.map((p) => p.id)).toEqual(["automation-out"]);
    expect(NODE_CONTRACT["automation-action"].ports.map((p) => p.id)).toEqual(["automation-in"]);
    expect(NODE_CONTRACT["automation-condition"].ports.map((p) => p.id)).toEqual(["automation-out", "automation-in"]);
  });

  it("nutanix-vm garde son unique port cible \"hosted-by\" et host ses deux ports (bug réel du 14/08/2026 : ports absents = arêtes invisibles)", () => {
    expect(NODE_CONTRACT["nutanix-vm"].ports.map((p) => p.id)).toEqual(["hosted-by"]);
    expect(NODE_CONTRACT.host.ports.map((p) => p.id)).toEqual(["hosted-by", "hosts"]);
  });
});

describe("edgeHealth générique — mêmes résultats que l'ancien code par-kind", () => {
  it("arête network : couleur du conteneur, pointillé selon le port publié — identique à l'ancien chemin edgeContainerNode", () => {
    const container = node("container", { id: "container:c1", healthStatus: "healthy" });
    const net = node("network", { id: "network:n1" });
    const nodesById = new Map([
      [container.id, container],
      [net.id, net],
    ]);
    const withPort: TopologyEdge[] = [
      { id: "net:c1:n1", source: container.id, target: net.id, kind: "network", ports: [{ protocol: "tcp", privatePort: 80, publicPort: 8080 }] },
    ];
    const [confirmed] = buildTopologyEdges(withPort, nodesById);
    expect(confirmed?.data).toMatchObject({ state: "healthy", hasPublishedPort: true });
    expect((confirmed?.style as { strokeDasharray?: string })?.strokeDasharray).toBeUndefined();

    const withoutPort: TopologyEdge[] = [{ id: "net:c1:n1", source: container.id, target: net.id, kind: "network" }];
    const [unconfirmed] = buildTopologyEdges(withoutPort, nodesById);
    expect(unconfirmed?.data).toMatchObject({ state: "healthy", hasPublishedPort: false });
    expect(unconfirmed?.style).toMatchObject({ strokeDasharray: "4 4" });
  });

  it("arête mount : structurelle, toujours pleine — seule la couleur bouge (conteneur arrêté = gris, jamais de tirets)", () => {
    const container = node("container", { id: "container:c1", status: "stopped" });
    const volume = node("volume", { id: "volume:v1" });
    const nodesById = new Map([
      [container.id, container],
      [volume.id, volume],
    ]);
    const edges: TopologyEdge[] = [{ id: "mount:c1:v1", source: volume.id, target: container.id, kind: "mount", readOnly: false }];
    const [edge] = buildTopologyEdges(edges, nodesById);
    expect(edge?.data).toMatchObject({ state: "stopped" });
    expect(edge?.style).not.toHaveProperty("strokeDasharray");
    expect(edge?.type).toBe("mountFlow");
  });

  it("propagation automation-flow : le statut du déclencheur colore trigger->condition ET condition->action (héritage), motif \"2 4\" fixe", () => {
    const trigger = node("automation-trigger", { id: "automation-trigger:t1", automationLastStatus: "ok" });
    const condition = node("automation-condition", { id: "automation-condition:c1", status: "neutral" });
    const action = node("automation-action", { id: "automation-action:a1", status: "neutral" });
    const nodesById = new Map([
      [trigger.id, trigger],
      [condition.id, condition],
      [action.id, action],
    ]);
    const edges: TopologyEdge[] = [
      { id: "automation-flow:e1", source: trigger.id, target: condition.id, kind: "automation-flow" },
      { id: "automation-flow:e2", source: condition.id, target: action.id, kind: "automation-flow" },
    ];
    const [first, second] = buildTopologyEdges(edges, nodesById);
    expect(first?.data).toMatchObject({ state: "healthy" });
    expect(first?.style).toMatchObject({ strokeDasharray: "2 4" });
    expect(second?.data).toMatchObject({ state: "healthy" }); // hérité du déclencheur amont, jamais "aucun signal"
    expect(second?.style).toMatchObject({ strokeDasharray: "2 4" });
  });

  it("propagation automation-flow : \"failing\" -> rouge, \"unknown\"/jamais évalué -> gris \"none\"", () => {
    const failing = node("automation-trigger", { id: "automation-trigger:t1", automationLastStatus: "failing" });
    const fresh = node("automation-trigger", { id: "automation-trigger:t2" }); // automationLastStatus absent = unknown
    const action1 = node("automation-action", { id: "automation-action:a1", status: "neutral" });
    const action2 = node("automation-action", { id: "automation-action:a2", status: "neutral" });
    const nodesById = new Map([
      [failing.id, failing],
      [fresh.id, fresh],
      [action1.id, action1],
      [action2.id, action2],
    ]);
    const edges: TopologyEdge[] = [
      { id: "automation-flow:e1", source: failing.id, target: action1.id, kind: "automation-flow" },
      { id: "automation-flow:e2", source: fresh.id, target: action2.id, kind: "automation-flow" },
    ];
    const [failingEdge, freshEdge] = buildTopologyEdges(edges, nodesById);
    expect(failingEdge?.data).toMatchObject({ state: "unhealthy" });
    expect(freshEdge?.data).toMatchObject({ state: "none" });
  });

  it("iac-workspace : santé déclarée sur la MÊME palette depuis iacLastRunStatus (jamais appelée par une arête aujourd'hui — aucune arête serveur ne touche ce kind, prêt pour la Phase 2)", () => {
    const edgeHealth = NODE_CONTRACT["iac-workspace"].edgeHealth;
    expect(edgeHealth).not.toBeNull();
    const ctx = { edgeKind: "hosts" as const, role: "target" as const, hasPublishedPort: false, automationUpstreamStatus: "unknown" as const };
    expect(edgeHealth!(node("iac-workspace", { iacLastRunStatus: "success" }), ctx)).toMatchObject({ state: "healthy" });
    expect(edgeHealth!(node("iac-workspace", { iacLastRunStatus: "failed" }), ctx)).toMatchObject({ state: "unhealthy" });
    expect(edgeHealth!(node("iac-workspace", { iacLastRunStatus: "running" }), ctx)).toMatchObject({ state: "starting" });
    expect(edgeHealth!(node("iac-workspace", { iacLastRunStatus: null }), ctx)).toMatchObject({ state: "none" });
  });
});

describe("resourceAlerts générique — seuils déclarés par kind, mêmes règles qu'avant", () => {
  it("conteneur running au-dessus du seuil CPU -> alerte \"cpu\" ; arrêté -> jamais d'alerte", () => {
    expect(computeNodeResourceAlerts(node("container", { cpuPercent: 95 })).map((a) => a.key)).toEqual(["cpu"]);
    expect(computeNodeResourceAlerts(node("container", { cpuPercent: 95, status: "stopped" }))).toEqual([]);
    expect(computeNodeResourceAlerts(node("container", { cpuPercent: 50 }))).toEqual([]);
  });

  it("alerte mémoire UNIQUEMENT quand une vraie limite existe (jamais un seuil absolu inventé)", () => {
    const overLimit = node("container", { memBytes: 950, memoryLimitBytes: 1000 });
    expect(computeNodeResourceAlerts(overLimit).map((a) => a.key)).toEqual(["memory"]);
    const noLimit = node("container", { memBytes: 950 });
    expect(computeNodeResourceAlerts(noLimit)).toEqual([]);
  });

  it("un kind qui déclare resourceAlerts: null ne produit JAMAIS d'alerte, même avec des métriques posées par erreur", () => {
    expect(NODE_CONTRACT["nutanix-vm"].resourceAlerts).toBeNull();
    expect(computeNodeResourceAlerts(node("nutanix-vm", { cpuPercent: 99, memBytes: 999, memoryLimitBytes: 1000 }))).toEqual([]);
  });
});

describe("buildNodeMenuItems — la liste vit dans le contrat, les callbacks chez l'appelant", () => {
  /** Table complète de handlers factices — l'identité du callback n'importe pas ici, seuls
   * libellés/ordre/danger/visibilité sont verrouillés. */
  function allHandlers() {
    const calls: string[] = [];
    const handlers: Record<string, () => void> = {};
    for (const id of [
      "container-stop",
      "container-start",
      "container-restart",
      "container-rename",
      "container-connect-network",
      "container-remove",
      "nutanix-vm-stop",
      "nutanix-vm-restart",
      "nutanix-vm-start",
      "volume-remove",
      "network-remove",
      "automation-node-remove",
    ]) {
      handlers[id] = () => calls.push(id);
    }
    return { handlers, calls };
  }

  it("conteneur running : Arrêter/Redémarrer/Renommer/Connecter/Supprimer — même liste, même ordre qu'avant la migration", () => {
    const { handlers } = allHandlers();
    const items = buildNodeMenuItems(node("container"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Arrêter", "Redémarrer", "Renommer", "Connecter à un network…", "Supprimer"]);
    expect(items.find((i) => i.label === "Supprimer")?.danger).toBe(true);
    expect(items.find((i) => i.label === "Arrêter")?.danger).toBeUndefined();
  });

  it("conteneur non-running : Démarrer remplace Arrêter (même règle `status === \"running\"` qu'avant)", () => {
    const { handlers } = allHandlers();
    const items = buildNodeMenuItems(node("container", { status: "stopped" }), handlers);
    expect(items.map((i) => i.label)).toEqual(["Démarrer", "Redémarrer", "Renommer", "Connecter à un network…", "Supprimer"]);
  });

  it("handlers PARTIELS (cas TopologySubGraphPanel) : les actions sans callback sont omises, jamais un item mort", () => {
    const { handlers } = allHandlers();
    delete handlers["container-rename"];
    delete handlers["container-connect-network"];
    const items = buildNodeMenuItems(node("container"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Arrêter", "Redémarrer", "Supprimer"]);
  });

  it("VM Nutanix : running -> Arrêter/Redémarrer, stopped -> Démarrer, neutral -> RIEN, jamais de Supprimer rapide (réservé au panneau de détail)", () => {
    const { handlers } = allHandlers();
    expect(buildNodeMenuItems(node("nutanix-vm"), handlers).map((i) => i.label)).toEqual(["Arrêter", "Redémarrer"]);
    expect(buildNodeMenuItems(node("nutanix-vm", { status: "stopped" }), handlers).map((i) => i.label)).toEqual(["Démarrer"]);
    expect(buildNodeMenuItems(node("nutanix-vm", { status: "neutral" }), handlers)).toEqual([]);
  });

  it("network : Supprimer masqué pour les networks Docker par défaut (bridge/host/none), présent sinon", () => {
    const { handlers } = allHandlers();
    expect(buildNodeMenuItems(node("network", { label: "bridge" }), handlers)).toEqual([]);
    expect(buildNodeMenuItems(node("network", { label: "quai-app-net" }), handlers).map((i) => i.label)).toEqual(["Supprimer"]);
  });

  it("kinds sans action de cycle de vie (host/ad-server/cron-job/backup/gitops-source) : liste vide EXPLICITE", () => {
    const { handlers } = allHandlers();
    for (const kind of ["host", "ad-server", "cron-job", "backup", "gitops-source"] as const) {
      expect(buildNodeMenuItems(node(kind), handlers), kind).toEqual([]);
    }
  });

  it("iac-workspace : déclinaison par moteur via IAC_ENGINE_CONTRACT — les 3 moteurs déclarés, aucune action aujourd'hui (Phase 1, les runs se pilotent depuis le panneau de détail)", () => {
    const { handlers } = allHandlers();
    const engines: IacEngine[] = ["tofu", "ansible", "packer"];
    expect(Object.keys(IAC_ENGINE_CONTRACT).sort()).toEqual([...engines].sort());
    for (const engine of engines) {
      expect(buildNodeMenuItems(node("iac-workspace", { iacEngine: engine }), handlers), engine).toEqual([]);
    }
    // Moteur absent (jamais censé arriver, l'API renvoie toujours iacEngine) : aucune action
    // inventée, jamais un plantage.
    expect(buildNodeMenuItems(node("iac-workspace"), handlers)).toEqual([]);
  });

  it("nœuds d'automatisation : Supprimer (danger) pour les trois kinds", () => {
    const { handlers } = allHandlers();
    for (const kind of ["automation-trigger", "automation-condition", "automation-action"] as const) {
      const items = buildNodeMenuItems(node(kind, { status: "neutral" }), handlers);
      expect(items.map((i) => i.label), kind).toEqual(["Supprimer"]);
      expect(items[0]?.danger, kind).toBe(true);
    }
  });
});
