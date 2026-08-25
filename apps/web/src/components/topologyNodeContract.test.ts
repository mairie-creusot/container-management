import { afterEach, describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  CAPABILITY_DEFS,
  CAPABILITY_PORT_META,
  CONNECTION_ACTIONS,
  HOST_KIND_CONTRACT,
  IAC_ENGINE_CONTRACT,
  NODE_CONTRACT,
  NODE_KINDS,
  UNKNOWN_NODE_CONTRACT,
  buildNodeMenuItems,
  capabilityPairKey,
  hycuProtectionBadge,
  isNodeKindRegistered,
  mapNodeContract,
  nodeContractFor,
  nodeContractRefusal,
  nodeContractSource,
  nodeIcon,
  nodeMinimapColor,
  quickLifecycleActions,
  registerNodeContract,
  registeredNodeKinds,
  unregisterNodeContract,
  validateNodeContract,
  type CapabilityId,
  type NodeContract,
  type NodeMenuActionSpec,
} from "./topologyNodeContract";
import { buildTopologyEdges, computeNodeResourceAlerts } from "./topologyGraphShared";
import type { IacEngine, TopologyEdge, TopologyHostKind, TopologyNode, TopologyNodeKind } from "@/types";

/**
 * Verrouille le CONTRAT générique des nœuds (topologyNodeContract.tsx, migration du 17/08/2026) :
 * chaque kind a une entrée complète, les conventions transverses (TARGET = Left / SOURCE = Right,
 * capacités symétriques) sont des invariants testés — plus jamais un kind ajouté "à moitié" (ports
 * oubliés = arêtes invisibles, bug réel du 14/08/2026 ; ports Top/Bottom = incohérence visuelle,
 * bug réel du 17/08/2026) — et les moteurs génériques (buildTopologyEdges/
 * computeNodeResourceAlerts/buildNodeMenuItems) rendent EXACTEMENT ce que rendait le code par-kind
 * dispersé qu'ils remplacent (zéro changement visuel/fonctionnel, mission Phase 1).
 *
 * Phase 3 (25/08/2026) : le registre est OUVERT à l'exécution (topologyNodeRegistry.tsx). Les blocs
 * de fin de fichier verrouillent ce qui remplace la totalité perdue côté compilateur —
 * enregistrement d'un type par un greffon, REFUS d'un contrat incomplet, repli "type inconnu" — et
 * la PARITÉ des types du cœur (mêmes ports, mêmes menus, mêmes couleurs, mêmes colonnes qu'avant).
 */

/** Totalité vérifiée PAR LE COMPILATEUR : ajouter un kind à TopologyNodeKind (types.ts) sans
 * l'ajouter ici (et donc sans se poser la question de son contrat) casse la compilation. */
const ALL_KINDS_RECORD: Record<TopologyNodeKind, true> = {
  container: true,
  volume: true,
  "nutanix-vm": true,
  host: true,
  "cron-job": true,
  backup: true,
  "iac-workspace": true,
  "gitops-source": true,
  "automation-trigger": true,
  "automation-condition": true,
  "automation-action": true,
  "image-template": true,
  "hycu-appliance": true,
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
    for (const kind of ["iac-workspace", "cron-job", "backup", "gitops-source"] as const) {
      expect(NODE_CONTRACT[kind].ports).toEqual([]);
    }
  });

  it("image-template : ports d'artefact (entrée cible à gauche, sortie source à droite — arêtes uses-artifact)", () => {
    expect(NODE_CONTRACT["image-template"].ports.map((p) => ({ id: p.id, handleType: p.handleType }))).toEqual([
      { id: "artifact-in", handleType: "target" },
      { id: "artifact-out", handleType: "source" },
    ]);
  });

  it("nœuds d'automatisation : ports désormais déclarés (trigger = sortie seule, action = entrée seule, condition = les deux)", () => {
    expect(NODE_CONTRACT["automation-trigger"].ports.map((p) => p.id)).toEqual(["automation-out"]);
    expect(NODE_CONTRACT["automation-action"].ports.map((p) => p.id)).toEqual(["automation-in"]);
    expect(NODE_CONTRACT["automation-condition"].ports.map((p) => p.id)).toEqual(["automation-out", "automation-in"]);
  });

  it("nutanix-vm : entrée d'hébergement à GAUCHE, sortie de sauvegarde à DROITE (le lien part de la VM vers HYCU)", () => {
    expect(NODE_CONTRACT["nutanix-vm"].ports.map((p) => ({ id: p.id, handleType: p.handleType, position: p.position }))).toEqual([
      { id: "hosted-by", handleType: "target", position: Position.Left },
      { id: "protection-out", handleType: "source", position: Position.Right },
    ]);
    expect(NODE_CONTRACT.host.ports.map((p) => p.id)).toEqual(["hosted-by", "hosts"]);
  });

  it("hycu-appliance : uniquement des ENTRÉES à gauche — l'appliance reçoit les sauvegardes, elle n'en émet pas", () => {
    const ports = NODE_CONTRACT["hycu-appliance"].ports;
    expect(ports.map((p) => ({ id: p.id, handleType: p.handleType }))).toEqual([
      { id: "hosted-by", handleType: "target" },
      { id: "protected-by", handleType: "target" },
    ]);
    expect(ports.every((p) => p.position === Position.Left)).toBe(true);
  });

  it("HYCU est en LECTURE SEULE : ses ports ne sont jamais interactifs et son menu ne propose aucune mutation", () => {
    expect(CAPABILITY_DEFS["protection-out"].interactive).toBe(false);
    expect(CAPABILITY_DEFS["protection-out"].infoMessage).toBeTruthy();
    expect(CAPABILITY_DEFS["protected-by"].interactive).toBe(false);
    const labels = buildNodeMenuItems(node("hycu-appliance"), {
      "hycu-open-page": () => {},
      "hycu-view-jobs": () => {},
      "hycu-configure": () => {},
    }).map((i) => i.label);
    expect(labels).toEqual(["Ouvrir la page Sauvegardes", "Voir les jobs", "Configurer…"]);
    expect(labels.some((l) => /sauvegarder|lancer|restaurer|supprimer/i.test(l))).toBe(false);
  });

  it("menu HYCU sans handler \"Configurer\" (non-admin) : l'entrée disparaît, jamais un item mort", () => {
    const labels = buildNodeMenuItems(node("hycu-appliance"), { "hycu-open-page": () => {}, "hycu-view-jobs": () => {} }).map(
      (i) => i.label,
    );
    expect(labels).toEqual(["Ouvrir la page Sauvegardes", "Voir les jobs"]);
  });

  it("badge de protection HYCU : rien tant que HYCU ne dit rien de la VM, sinon l'état réel rapporté", () => {
    expect(hycuProtectionBadge(node("nutanix-vm"))).toBeNull();
    expect(hycuProtectionBadge(node("nutanix-vm", { hycuProtection: "protected" }))?.label).toBe("Protégée");
    expect(hycuProtectionBadge(node("nutanix-vm", { hycuProtection: "non-compliant" }))?.tone).toBe("critical");
    expect(hycuProtectionBadge(node("nutanix-vm", { hycuProtection: "never-backed-up" }))?.label).toBe("Jamais sauvegardée");
    expect(hycuProtectionBadge(node("nutanix-vm", { hycuProtection: "unprotected" }))?.label).toBe("Non protégée");
  });

  it("arête \"protects\" : part de la VM (droite) vers HYCU (gauche), couleur portée par la VM source", () => {
    const hycu = node("hycu-appliance", { id: "hycu-appliance:main" });
    const vm = node("nutanix-vm", { id: "nutanix-vm:uuid-1", hycuProtection: "protected" });
    const nodesById = new Map([
      [hycu.id, hycu],
      [vm.id, vm],
    ]);
    const edges: TopologyEdge[] = [{ id: "protects:h1:nutanix-vm:uuid-1", source: vm.id, target: hycu.id, kind: "protects" }];
    const [edge] = buildTopologyEdges(edges, nodesById);
    expect(edge).toMatchObject({ sourceHandle: "protection-out", targetHandle: "protected-by" });
    expect(edge?.data?.state).toBe("healthy");
    // Jamais animée : une sauvegarde est périodique, pas un flux continu.
    expect(edge?.animated).toBe(false);
  });

  it("arête \"protects\" d'une VM jamais sauvegardée : orange + tirets fins, jamais rouge (ce n'est pas une panne)", () => {
    const hycu = node("hycu-appliance", { id: "hycu-appliance:main" });
    const vm = node("nutanix-vm", { id: "nutanix-vm:uuid-2", hycuProtection: "never-backed-up" });
    const nodesById = new Map([
      [hycu.id, hycu],
      [vm.id, vm],
    ]);
    const [edge] = buildTopologyEdges(
      [{ id: "protects:h2:nutanix-vm:uuid-2", source: vm.id, target: hycu.id, kind: "protects" }],
      nodesById,
    );
    expect(edge?.data?.state).toBe("starting");
    expect(edge?.style?.strokeDasharray).toBe("4 4");
  });

  it("container : plus de port \"network\" (24/08/2026, un réseau n'est plus un nœud) — seulement volume-mount + hosted-by", () => {
    expect(NODE_CONTRACT.container.ports.map((p) => p.id)).toEqual(["volume-mount", "hosted-by"]);
  });

  it("aucune capacité \"network\"/\"attach\" ne subsiste : plus aucun Handle du graphe ne viserait un réseau", () => {
    const capabilities = Object.keys(CAPABILITY_DEFS);
    expect(capabilities).not.toContain("network");
    expect(capabilities).not.toContain("attach");
    const portCapabilities = NODE_KINDS.flatMap((kind) => NODE_CONTRACT[kind].ports.map((p) => String(p.capability)));
    expect(portCapabilities).not.toContain("network");
    expect(portCapabilities).not.toContain("attach");
  });
});

describe("CONNECTION_ACTIONS — câblage manuel au fil (vague 3)", () => {
  it("chaque paire déclarée relie deux capacités réellement compatibles (linksTo) et toutes deux interactives", () => {
    const entries = Object.entries(CONNECTION_ACTIONS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, action] of entries) {
      const [source, target] = key.split("->") as [CapabilityId, CapabilityId];
      expect(CAPABILITY_DEFS[source].linksTo, key).toBe(target);
      expect(CAPABILITY_DEFS[source].interactive, key).toBe(true);
      expect(CAPABILITY_DEFS[target].interactive, key).toBe(true);
      expect(action, key).toBeTruthy();
    }
  });

  it("table complète : toute capacité SOURCE interactive non-automation a son action ; automation (chemin dédié) et paires non interactives jamais dans la table", () => {
    for (const [capability, def] of Object.entries(CAPABILITY_DEFS) as [CapabilityId, (typeof CAPABILITY_DEFS)[CapabilityId]][]) {
      const isSourceSide = CAPABILITY_PORT_META[capability].handleType === "source";
      const isAutomation = capability === "automation-out" || capability === "automation-in";
      const key = capabilityPairKey(capability, def.linksTo);
      if (isSourceSide && def.interactive && !isAutomation) {
        expect(CONNECTION_ACTIONS[key], capability).toBeDefined();
      } else {
        expect(CONNECTION_ACTIONS[key], capability).toBeUndefined();
      }
    }
  });

  it("paire réelle verrouillée : volume->conteneur ouvre le montage confirmé — la connexion réseau n'est PLUS un fil (elle vit dans le ＋/le menu du conteneur)", () => {
    expect(CONNECTION_ACTIONS["provide->volume-mount"]).toBe("mount-volume-on-container");
    expect(Object.keys(CONNECTION_ACTIONS)).toHaveLength(1);
  });

  it("provide/volume-mount désormais interactives (fil -> popover), hosts/hosted-by restent non interactives avec message d'info", () => {
    expect(CAPABILITY_DEFS.provide.interactive).toBe(true);
    expect(CAPABILITY_DEFS["volume-mount"].interactive).toBe(true);
    expect(CAPABILITY_DEFS.hosts.interactive).toBe(false);
    expect(CAPABILITY_DEFS.hosts.infoMessage).toBeTruthy();
    expect(CAPABILITY_DEFS["hosted-by"].interactive).toBe(false);
    expect(CAPABILITY_DEFS["hosted-by"].infoMessage).toBeTruthy();
  });
});

describe("HOST_KIND_CONTRACT — déclinaison par hostKind du kind \"host\"", () => {
  const ALL_HOST_KINDS_RECORD: Record<TopologyHostKind, true> = {
    "quai-master": true,
    "docker-env": true,
    "nutanix-cluster": true,
    "nutanix-host": true,
    "remote-docker": true,
    lxc: true,
  };

  it("chaque hostKind a une entrée (totalité garantie par le compilateur, ancrée ici)", () => {
    expect(Object.keys(HOST_KIND_CONTRACT).sort()).toEqual(Object.keys(ALL_HOST_KINDS_RECORD).sort());
  });

  it("le master QUAI a une icône et une couleur MiniMap DISTINCTES du kind host générique ; les hostKind sans déclinaison retombent sur celles du kind", () => {
    const master = node("host", { hostKind: "quai-master" });
    expect(nodeMinimapColor(master)).not.toBe(NODE_CONTRACT.host.minimapColor);
    expect(nodeIcon(master)).not.toBe(NODE_CONTRACT.host.icon);
    const cluster = node("host", { hostKind: "nutanix-cluster" });
    expect(nodeMinimapColor(cluster)).toBe(NODE_CONTRACT.host.minimapColor);
    expect(nodeIcon(cluster)).toBe(NODE_CONTRACT.host.icon);
    expect(nodeMinimapColor(node("container"))).toBe(NODE_CONTRACT.container.minimapColor);
  });

  it("menu du master : \"Ajouter un environnement…\" uniquement ; \"docker-env\" n'a aucune action", () => {
    const handlers = { "host-add-environment": () => {} };
    expect(buildNodeMenuItems(node("host", { hostKind: "quai-master" }), handlers).map((i) => i.label)).toEqual([
      "Ajouter un environnement…",
    ]);
    expect(buildNodeMenuItems(node("host", { hostKind: "docker-env" }), handlers)).toEqual([]);
  });
});

describe("buildTopologyEdges — ancrage des arêtes sur le port du contrat correspondant à leur kind", () => {
  it("arête \"hosts\" Docker local -> conteneur : sourceHandle \"hosts\", targetHandle \"hosted-by\" (jamais le port volume-mount)", () => {
    const local = node("host", { id: "host:docker-local", hostKind: "docker-env" });
    const container = node("container", { id: "container:c1" });
    const nodesById = new Map([
      [local.id, local],
      [container.id, container],
    ]);
    const edges: TopologyEdge[] = [{ id: "hosts:docker-local:c1", source: local.id, target: container.id, kind: "hosts" }];
    const [edge] = buildTopologyEdges(edges, nodesById);
    expect(edge).toMatchObject({ sourceHandle: "hosts", targetHandle: "hosted-by" });
  });

  it("arête \"mount\" volume -> conteneur : reste ancrée sur provide/volume-mount malgré le nouveau port hosted-by", () => {
    const volume = node("volume", { id: "volume:v1" });
    const container = node("container", { id: "container:c1" });
    const nodesById = new Map([
      [volume.id, volume],
      [container.id, container],
    ]);
    const edges: TopologyEdge[] = [{ id: "mount:c1:v1", source: volume.id, target: container.id, kind: "mount" }];
    const [edge] = buildTopologyEdges(edges, nodesById);
    expect(edge).toMatchObject({ sourceHandle: "provide", targetHandle: "volume-mount" });
  });

  it("un handle déjà fixé par l'appelant (arête redirigée vers un groupe) reste prioritaire ; une extrémité inconnue (id de groupe) reste sans handle", () => {
    const volume = node("volume", { id: "volume:v1" });
    const nodesById = new Map([[volume.id, volume]]);
    const edges: (TopologyEdge & { targetHandle?: string })[] = [
      { id: "mount:g1:v1", source: volume.id, target: "group:g1", kind: "mount", targetHandle: "volume-mount" },
      { id: "mount:g2:v1", source: volume.id, target: "group:g2", kind: "mount" },
    ];
    const [redirected, unknownTarget] = buildTopologyEdges(edges, nodesById);
    expect(redirected).toMatchObject({ sourceHandle: "provide", targetHandle: "volume-mount" });
    expect(unknownTarget?.sourceHandle).toBe("provide");
    expect(unknownTarget?.targetHandle).toBeUndefined();
  });
});

describe("edgeHealth générique — mêmes résultats que l'ancien code par-kind", () => {
  it("arête \"hosts\" Docker local -> conteneur : couleur du conteneur, jamais de pointillé (relation structurelle)", () => {
    const container = node("container", { id: "container:c1", healthStatus: "healthy" });
    const local = node("host", { id: "host:docker-local", hostKind: "docker-env" });
    const nodesById = new Map([
      [container.id, container],
      [local.id, local],
    ]);
    const [edge] = buildTopologyEdges(
      [{ id: "hosts:docker-local:c1", source: local.id, target: container.id, kind: "hosts" }],
      nodesById,
    );
    expect(edge?.data).toMatchObject({ state: "healthy" });
    expect((edge?.style as { strokeDasharray?: string })?.strokeDasharray).toBeUndefined();
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
    const ctx = { edgeKind: "hosts" as const, role: "target" as const, automationUpstreamStatus: "unknown" as const };
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
      "nutanix-vm-add-disk",
      "nutanix-vm-add-nic",
      "nutanix-vm-edit-compute",
      "volume-mount-on-container",
      "volume-remove",
      "automation-node-remove",
    ]) {
      handlers[id] = () => calls.push(id);
    }
    return { handlers, calls };
  }

  it("conteneur running : Arrêter/Redémarrer/Renommer/Connecter/Supprimer — même liste, même ordre qu'avant la migration", () => {
    const { handlers } = allHandlers();
    const items = buildNodeMenuItems(node("container"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Arrêter", "Redémarrer", "Renommer", "Connecter à un réseau…", "Supprimer"]);
    expect(items.find((i) => i.label === "Supprimer")?.danger).toBe(true);
    expect(items.find((i) => i.label === "Arrêter")?.danger).toBeUndefined();
  });

  it("conteneur non-running : Démarrer remplace Arrêter (même règle `status === \"running\"` qu'avant)", () => {
    const { handlers } = allHandlers();
    const items = buildNodeMenuItems(node("container", { status: "stopped" }), handlers);
    expect(items.map((i) => i.label)).toEqual(["Démarrer", "Redémarrer", "Renommer", "Connecter à un réseau…", "Supprimer"]);
  });

  it("handlers PARTIELS (cas TopologySubGraphPanel) : les actions sans callback sont omises, jamais un item mort", () => {
    const { handlers } = allHandlers();
    delete handlers["container-rename"];
    delete handlers["container-connect-network"];
    const items = buildNodeMenuItems(node("container"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Arrêter", "Redémarrer", "Supprimer"]);
  });

  it("VM Nutanix : running -> Arrêter/Redémarrer, stopped -> Démarrer, jamais de Supprimer rapide (réservé au panneau de détail) ; entrées matérielles TOUJOURS présentes (18/08/2026)", () => {
    const { handlers } = allHandlers();
    const hardware = ["Ajouter un disque…", "Ajouter une carte réseau…", "vCPU / Mémoire…"];
    expect(buildNodeMenuItems(node("nutanix-vm"), handlers).map((i) => i.label)).toEqual(["Arrêter", "Redémarrer", ...hardware]);
    expect(buildNodeMenuItems(node("nutanix-vm", { status: "stopped" }), handlers).map((i) => i.label)).toEqual(["Démarrer", ...hardware]);
    // power_state inconnu ("neutral") : aucune action de cycle de vie, mais la configuration
    // matérielle reste proposée (un refus réel éventuel de Prism remonte tel quel).
    expect(buildNodeMenuItems(node("nutanix-vm", { status: "neutral" }), handlers).map((i) => i.label)).toEqual(hardware);
    // Aucune entrée matérielle n'est marquée danger (la confirmation vit dans les popovers).
    for (const item of buildNodeMenuItems(node("nutanix-vm"), handlers)) expect(item.danger).toBeUndefined();
  });

  it("volume : Monter sur un conteneur… (Phase 2) puis Supprimer (danger) — le montage n'est jamais marqué danger ici, l'avertissement/la confirmation vivent dans le popover (MountVolumePopover)", () => {
    const { handlers } = allHandlers();
    const items = buildNodeMenuItems(node("volume"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Monter sur un conteneur…", "Supprimer"]);
    expect(items.find((i) => i.label === "Supprimer")?.danger).toBe(true);
    expect(items.find((i) => i.label === "Monter sur un conteneur…")?.danger).toBeUndefined();
  });

  it("volume dans le sous-graphe (handler de montage volontairement absent) : seule Supprimer reste — jamais un item mort", () => {
    const { handlers } = allHandlers();
    delete handlers["volume-mount-on-container"];
    const items = buildNodeMenuItems(node("volume"), handlers);
    expect(items.map((i) => i.label)).toEqual(["Supprimer"]);
  });

  it("kinds sans action de cycle de vie (host/cron-job/backup/gitops-source) : liste vide EXPLICITE", () => {
    const { handlers } = allHandlers();
    for (const kind of ["host", "cron-job", "backup", "gitops-source"] as const) {
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

  it("quickLifecycleActions (boutons directs au survol, 18/08/2026) : même grille d'état que le menu, jamais de suppression, [] pour tout autre kind", () => {
    // Conteneur : running -> stop/restart, tout le reste -> start (même règle que son menu).
    expect(quickLifecycleActions(node("container"))).toEqual(["stop", "restart"]);
    expect(quickLifecycleActions(node("container", { status: "stopped" }))).toEqual(["start"]);
    expect(quickLifecycleActions(node("container", { status: "neutral" }))).toEqual(["start"]);
    // VM Nutanix : nuance "neutral" (power_state inconnu) -> RIEN, comme son menu.
    expect(quickLifecycleActions(node("nutanix-vm"))).toEqual(["stop", "restart"]);
    expect(quickLifecycleActions(node("nutanix-vm", { status: "stopped" }))).toEqual(["start"]);
    expect(quickLifecycleActions(node("nutanix-vm", { status: "neutral" }))).toEqual([]);
    // Jamais sur un autre kind (volume/host/automation... n'ont pas de cycle de vie pilotable ici).
    for (const kind of ["volume", "host", "iac-workspace", "automation-trigger"] as const) {
      expect(quickLifecycleActions(node(kind)), kind).toEqual([]);
    }
  });

  it("image-template : actions conditionnées à l'état réel du template (artifact/statut), Supprimer en danger", () => {
    const handlers: Record<string, () => void> = {};
    for (const id of [
      "image-template-build",
      "image-template-view-builds",
      "image-template-deploy-vm",
      "image-template-create-container",
      "image-template-remove",
    ]) {
      handlers[id] = () => {};
    }
    // Sans artifact : jamais de "Déployer en VM"/"Créer un conteneur" (rien de construit à déployer).
    expect(buildNodeMenuItems(node("image-template", { templateStatus: "draft" }), handlers).map((i) => i.label)).toEqual([
      "Construire",
      "Voir les builds",
      "Supprimer",
    ]);
    // Build en cours : "Construire" masqué (jamais deux builds concurrents proposés depuis le menu).
    expect(buildNodeMenuItems(node("image-template", { templateStatus: "building" }), handlers).map((i) => i.label)).toEqual([
      "Voir les builds",
      "Supprimer",
    ]);
    // Artifact Nutanix -> Déployer en VM ; artifact Docker -> Créer un conteneur (jamais les deux).
    const nutanixReady = node("image-template", { templateStatus: "ready", templateArtifactType: "nutanix-image" });
    expect(buildNodeMenuItems(nutanixReady, handlers).map((i) => i.label)).toEqual([
      "Construire",
      "Voir les builds",
      "Déployer en VM…",
      "Supprimer",
    ]);
    const dockerReady = node("image-template", { templateStatus: "ready", templateArtifactType: "docker-image" });
    expect(buildNodeMenuItems(dockerReady, handlers).map((i) => i.label)).toEqual([
      "Construire",
      "Voir les builds",
      "Créer un conteneur…",
      "Supprimer",
    ]);
    expect(buildNodeMenuItems(dockerReady, handlers).find((i) => i.label === "Supprimer")?.danger).toBe(true);
    // Aucun bouton rapide de cycle de vie sur la carte (pas un conteneur/VM).
    expect(quickLifecycleActions(node("image-template"))).toEqual([]);
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

// --- Registre ouvert à l'exécution (Phase 3, 25/08/2026) ----------------------------------------

/** Contrat VALIDE minimal tel qu'un greffon l'enregistrerait — base des cas de refus ci-dessous,
 * dont chacun n'invalide qu'un seul aspect à la fois. */
function pluginContract(): NodeContract {
  return {
    icon: NODE_CONTRACT.container.icon,
    minimapColor: "#7c3aed",
    defaultColumnX: 5440,
    ports: [
      { id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "Hébergé par", colorToken: "host" },
    ],
    edgeHealth: null,
    automationStatusSeed: null,
    resourceAlerts: null,
    menuItems: [],
    quickActions: [],
  };
}

const PLUGIN_KIND = "proxmox-vm" as TopologyNodeKind;

describe("registre de contrats — un greffon enregistre son propre type de nœud", () => {
  afterEach(() => {
    unregisterNodeContract(PLUGIN_KIND);
  });

  it("type enregistré : ports, menu et boutons rapides fonctionnent exactement comme pour un type du cœur", () => {
    const contract: NodeContract = {
      ...pluginContract(),
      menuItems: [
        { id: "proxmox-vm-start", label: "Démarrer", when: { field: "status", equals: ["stopped"] } },
        { id: "proxmox-vm-remove", label: "Supprimer", severity: "destructive" },
      ],
      quickActions: [{ action: "start", when: { field: "status", equals: ["stopped"] } }],
    };
    expect(registerNodeContract(PLUGIN_KIND, contract, "greffon proxmox")).toEqual({ ok: true });
    expect(isNodeKindRegistered(PLUGIN_KIND)).toBe(true);
    expect(nodeContractSource(PLUGIN_KIND)).toBe("greffon proxmox");
    expect(registeredNodeKinds()).toContain(PLUGIN_KIND);
    expect(nodeContractFor(PLUGIN_KIND)).toBe(contract);

    const handlers = { "proxmox-vm-start": () => {}, "proxmox-vm-remove": () => {} };
    const stopped = node(PLUGIN_KIND, { status: "stopped" });
    expect(nodeContractFor(stopped.kind).ports.map((p) => p.id)).toEqual(["hosted-by"]);
    const items = buildNodeMenuItems(stopped, handlers);
    expect(items.map((i) => i.label)).toEqual(["Démarrer", "Supprimer"]);
    expect(items[1]?.danger).toBe(true);
    expect(quickLifecycleActions(stopped)).toEqual(["start"]);

    const running = node(PLUGIN_KIND, { status: "running" });
    expect(buildNodeMenuItems(running, handlers).map((i) => i.label)).toEqual(["Supprimer"]);
    expect(quickLifecycleActions(running)).toEqual([]);
  });

  it("le retrait d'un greffon fait retomber son type sur le repli, jamais sur un contrat fantôme", () => {
    registerNodeContract(PLUGIN_KIND, pluginContract(), "greffon proxmox");
    expect(unregisterNodeContract(PLUGIN_KIND)).toBe(true);
    expect(isNodeKindRegistered(PLUGIN_KIND)).toBe(false);
    expect(nodeContractFor(PLUGIN_KIND)).toBe(UNKNOWN_NODE_CONTRACT);
  });

  it("contrat incomplet REFUSÉ avec un message explicite : icône, couleur de MiniMap et libellé de port obligatoires", () => {
    const invalid = {
      ...pluginContract(),
      icon: undefined,
      minimapColor: "   ",
      ports: [{ id: "hosted-by", capability: "hosted-by", handleType: "target", position: Position.Left, label: "", colorToken: "host" }],
    } as unknown as NodeContract;
    const result = registerNodeContract(PLUGIN_KIND, invalid, "greffon bancal");
    if (result.ok) throw new Error("un contrat incomplet ne doit jamais être accepté");
    expect(result.issues.map((issue) => issue.field)).toEqual(["icon", "minimapColor", "ports[0].label"]);
    expect(result.message).toContain("REFUSÉ");
    expect(result.message).toContain("greffon bancal");
    // Refusé = non enregistré : le nœud correspondant retombe sur le repli, jamais sur un contrat
    // à moitié rempli qui casserait le rendu plus tard.
    expect(isNodeKindRegistered(PLUGIN_KIND)).toBe(false);
    expect(nodeContractFor(PLUGIN_KIND)).toBe(UNKNOWN_NODE_CONTRACT);
    expect(nodeContractRefusal(PLUGIN_KIND)).toContain("icon manquante");
  });

  it("champs structurels manquants : ports/edgeHealth/menuItems/quickActions doivent être déclarés EXPLICITEMENT", () => {
    const issues = validateNodeContract("proxmox-host", { icon: NODE_CONTRACT.host.icon, minimapColor: "#7c3aed", defaultColumnX: 5440 });
    expect(issues.map((issue) => issue.field)).toEqual(["ports", "edgeHealth", "automationStatusSeed", "resourceAlerts", "menuItems", "quickActions"]);
  });

  it("ports hors convention : position Top, capacité inconnue, couleur inconnue et id dupliqué sont REFUSÉS (le bug du 17/08/2026 ne peut plus revenir par un greffon)", () => {
    const issues = validateNodeContract("proxmox-host", {
      ...pluginContract(),
      ports: [
        { id: "p1", capability: "hosted-by", handleType: "target", position: Position.Top, label: "Entrée", colorToken: "host" },
        { id: "p1", capability: "teleport", handleType: "source", position: Position.Right, label: "Sortie", colorToken: "rose" },
      ],
    });
    expect(issues.map((issue) => issue.field)).toEqual(["ports[0].position", "ports[1].id", "ports[1].capability", "ports[1].colorToken"]);
  });

  it("action sans libellé ou au niveau de danger inventé : REFUSÉE", () => {
    const issues = validateNodeContract("proxmox-host", {
      ...pluginContract(),
      menuItems: [{ id: "proxmox-host-nuke", severity: "apocalyptique" }],
    });
    expect(issues.map((issue) => issue.field)).toEqual(["menuItems[0].label", "menuItems[0].severity"]);
  });

  it("un greffon ne peut ni remplacer ni casser un type du cœur", () => {
    const result = registerNodeContract("container", pluginContract(), "greffon pirate");
    if (result.ok) throw new Error("un type du cœur ne doit jamais être remplaçable");
    expect(result.message).toContain("déjà enregistré par cœur");
    expect(nodeContractFor("container")).toBe(NODE_CONTRACT.container);
    // Le contrat en place reste sain : aucun refus mémorisé pour lui.
    expect(nodeContractRefusal("container")).toBeUndefined();
    expect(unregisterNodeContract("container")).toBe(false);
    expect(isNodeKindRegistered("container")).toBe(true);
  });

  it("kind mal formé : REFUSÉ (même convention que permissions.graphNodeKinds d'un manifeste de greffon)", () => {
    expect(validateNodeContract("Proxmox VM", pluginContract()).map((issue) => issue.field)).toEqual(["kind"]);
    expect(validateNodeContract("proxmox-vm", pluginContract())).toEqual([]);
  });
});

describe("type de nœud inconnu — repli honnête, jamais une disparition silencieuse", () => {
  const GHOST = "kind-jamais-declare" as TopologyNodeKind;

  it("nodeContractFor rend le contrat de repli, jamais undefined", () => {
    expect(isNodeKindRegistered(GHOST)).toBe(false);
    expect(nodeContractFor(GHOST)).toBe(UNKNOWN_NODE_CONTRACT);
    expect(UNKNOWN_NODE_CONTRACT.ports).toEqual([]);
    expect(UNKNOWN_NODE_CONTRACT.minimapColor).toBeTruthy();
  });

  it("aucun port, aucune action, aucune alerte — mais le nœud reste affichable", () => {
    const ghost = node(GHOST, { cpuPercent: 99, memBytes: 999, memoryLimitBytes: 1000 });
    expect(buildNodeMenuItems(ghost, { "container-stop": () => {} })).toEqual([]);
    expect(quickLifecycleActions(ghost)).toEqual([]);
    expect(computeNodeResourceAlerts(ghost)).toEqual([]);
    expect(nodeIcon(ghost)).toBe(UNKNOWN_NODE_CONTRACT.icon);
    expect(nodeMinimapColor(ghost)).toBe(UNKNOWN_NODE_CONTRACT.minimapColor);
  });

  it("les tables historiques indexées par kind rendent le repli au lieu de undefined (position NaN, <Icon /> sur undefined)", () => {
    expect(NODE_CONTRACT[GHOST]).toBe(UNKNOWN_NODE_CONTRACT);
    const columns = mapNodeContract((contract) => contract.defaultColumnX);
    expect(columns[GHOST]).toBe(UNKNOWN_NODE_CONTRACT.defaultColumnX);
    expect(Number.isFinite(columns[GHOST])).toBe(true);
    // Compteur de ligne par kind (TopologyGraph.tsx#columnCounters) : incrémentable même pour un
    // kind hors table, sans jamais produire NaN.
    const counters = mapNodeContract(() => 0);
    expect(counters[GHOST]++).toBe(0);
    expect(counters[GHOST]).toBe(1);
  });

  it("une arête touchant un nœud de type inconnu reste dessinée, ancrée sur le port de l'extrémité connue", () => {
    const ghost = node(GHOST, { id: "kind-jamais-declare:1" });
    const container = node("container", { id: "container:c1" });
    const nodesById = new Map([
      [ghost.id, ghost],
      [container.id, container],
    ]);
    const [edge] = buildTopologyEdges([{ id: "hosts:ghost:c1", source: ghost.id, target: container.id, kind: "hosts" }], nodesById);
    expect(edge?.sourceHandle).toBeUndefined();
    expect(edge?.targetHandle).toBe("hosted-by");
    // La santé vient de l'extrémité connue (le conteneur), le type inconnu n'en invente aucune.
    expect(edge?.data?.state).toBe("none");
  });
});

describe("parité des types du cœur après ouverture du registre", () => {
  it("les types du cœur sont tous enregistrés PAR le cœur et résolus vers exactement le même contrat qu'avant", () => {
    for (const kind of NODE_KINDS) {
      expect(isNodeKindRegistered(kind), kind).toBe(true);
      expect(nodeContractSource(kind), kind).toBe("cœur");
      expect(nodeContractFor(kind), kind).toBe(NODE_CONTRACT[kind]);
    }
  });

  it("couleurs de MiniMap inchangées (valeurs verrouillées, cohérentes avec topology.css)", () => {
    expect({ ...mapNodeContract((contract) => contract.minimapColor) }).toEqual({
      container: "#3b6fef",
      volume: "#f5a524",
      "nutanix-vm": "#22c55e",
      host: "#14b8a6",
      "cron-job": "#facc15",
      backup: "#0ea5e9",
      "iac-workspace": "#f97316",
      "gitops-source": "#f43f5e",
      "automation-trigger": "#dc2626",
      "automation-condition": "#64748b",
      "automation-action": "#84cc16",
      "image-template": "#22d3ee",
      "hycu-appliance": "#ec4899",
    });
  });

  it("colonnes par défaut inchangées", () => {
    expect({ ...mapNodeContract((contract) => contract.defaultColumnX) }).toEqual({
      volume: 0,
      container: 340,
      "nutanix-vm": 1020,
      host: 1700,
      "iac-workspace": 2040,
      "cron-job": 2380,
      backup: 2720,
      "gitops-source": 3060,
      "automation-trigger": 3400,
      "automation-condition": 3740,
      "automation-action": 4080,
      "image-template": 4420,
      "hycu-appliance": 4760,
    });
  });

  it("niveau de danger : les SEULES entrées destructives du cœur restent les \"Supprimer\" (aucune promotion/rétrogradation par la migration)", () => {
    const destructive: string[] = [];
    for (const kind of NODE_KINDS) {
      const specs = NODE_CONTRACT[kind].menuItems;
      const resolved = typeof specs === "function" ? specs(node(kind)) : specs;
      for (const spec of resolved) if (spec.severity === "destructive") destructive.push(`${kind}:${spec.label}`);
    }
    expect(destructive.sort()).toEqual([
      "automation-action:Supprimer",
      "automation-condition:Supprimer",
      "automation-trigger:Supprimer",
      "container:Supprimer",
      "image-template:Supprimer",
      "volume:Supprimer",
    ]);
  });

  it("conditions déclaratives : elles rendent EXACTEMENT les mêmes menus que les prédicats d'avant, pour chaque état réel", () => {
    const handlers: Record<string, () => void> = {};
    for (const spec of NODE_CONTRACT.container.menuItems as NodeMenuActionSpec[]) handlers[spec.id] = () => {};
    for (const spec of NODE_CONTRACT["nutanix-vm"].menuItems as NodeMenuActionSpec[]) handlers[spec.id] = () => {};
    expect(buildNodeMenuItems(node("container"), handlers).map((i) => i.label)).toEqual([
      "Arrêter",
      "Redémarrer",
      "Renommer",
      "Connecter à un réseau…",
      "Attacher (stockage, réseau, variable)…",
      "Supprimer",
    ]);
    expect(buildNodeMenuItems(node("container", { status: "restarting" }), handlers).map((i) => i.label)[0]).toBe("Démarrer");
    expect(buildNodeMenuItems(node("container", { status: "neutral" }), handlers).map((i) => i.label)[0]).toBe("Démarrer");
    expect(buildNodeMenuItems(node("nutanix-vm", { status: "neutral" }), handlers).map((i) => i.label)).toEqual([
      "Ajouter un disque…",
      "Ajouter une carte réseau…",
      "vCPU / Mémoire…",
    ]);
  });

  it("menu du kind \"host\" : la liste déclarative rend les mêmes entrées que la cascade sur hostKind qu'elle remplace", () => {
    const handlers = { "host-add-environment": () => {} };
    expect(buildNodeMenuItems(node("host", { hostKind: "quai-master" }), handlers).map((i) => i.label)).toEqual(["Ajouter un environnement…"]);
    expect(buildNodeMenuItems(node("host", { hostKind: "nutanix-cluster" }), handlers).map((i) => i.label)).toEqual([
      "Ajouter un environnement…",
      "Créer une VM ici — bientôt",
    ]);
    expect(buildNodeMenuItems(node("host", { hostKind: "nutanix-host" }), handlers).map((i) => i.label)).toEqual(["Créer une VM ici — bientôt"]);
    expect(buildNodeMenuItems(node("host", { hostKind: "remote-docker" }), handlers)).toEqual([]);
    expect(buildNodeMenuItems(node("host"), handlers)).toEqual([]);
    // Entrée désactivée : présente mais sans action, comme avant.
    const cluster = buildNodeMenuItems(node("host", { hostKind: "nutanix-cluster" }), handlers);
    expect(cluster.find((i) => i.label === "Créer une VM ici — bientôt")?.disabled).toBe(true);
  });
});

describe("actions Nutanix dans la forme déclarative", () => {
  const NUTANIX_KIND = "nutanix-vm-declared" as TopologyNodeKind;
  /** Les six actions citées par la mission, déclarées SANS aucune closure : telle quelle, cette
   * liste pourrait venir d'un manifeste de greffon (JSON). */
  const NUTANIX_ACTIONS: NodeMenuActionSpec[] = [
    { id: "nutanix-vm-start", label: "Démarrer", when: { field: "status", equals: ["stopped"] } },
    { id: "nutanix-vm-stop", label: "Arrêter", severity: "caution", when: { field: "status", equals: ["running"] } },
    { id: "nutanix-vm-restart", label: "Redémarrer", severity: "caution", when: { field: "status", equals: ["running"] } },
    { id: "nutanix-vm-add-disk", label: "Ajouter un disque…" },
    { id: "nutanix-vm-add-nic", label: "Ajouter une carte réseau…" },
    { id: "nutanix-vm-remove", label: "Supprimer", severity: "destructive" },
  ];

  afterEach(() => {
    unregisterNodeContract(NUTANIX_KIND);
  });

  it("les six actions s'expriment intégralement en données et rendent le bon menu pour chaque power_state réel", () => {
    const registration = registerNodeContract(
      NUTANIX_KIND,
      { ...pluginContract(), menuItems: NUTANIX_ACTIONS, quickActions: NODE_CONTRACT["nutanix-vm"].quickActions },
      "greffon nutanix",
    );
    expect(registration).toEqual({ ok: true });
    const handlers: Record<string, () => void> = {};
    for (const spec of NUTANIX_ACTIONS) handlers[spec.id] = () => {};
    const hardware = ["Ajouter un disque…", "Ajouter une carte réseau…", "Supprimer"];
    expect(buildNodeMenuItems(node(NUTANIX_KIND, { status: "running" }), handlers).map((i) => i.label)).toEqual([
      "Arrêter",
      "Redémarrer",
      ...hardware,
    ]);
    expect(buildNodeMenuItems(node(NUTANIX_KIND, { status: "stopped" }), handlers).map((i) => i.label)).toEqual(["Démarrer", ...hardware]);
    // power_state inconnu : aucune action de cycle de vie, la configuration matérielle reste là.
    expect(buildNodeMenuItems(node(NUTANIX_KIND, { status: "neutral" }), handlers).map((i) => i.label)).toEqual(hardware);
    // Boutons rapides repris tels quels du contrat du cœur : même grille d'état.
    expect(quickLifecycleActions(node(NUTANIX_KIND, { status: "running" }))).toEqual(["stop", "restart"]);
    expect(quickLifecycleActions(node(NUTANIX_KIND, { status: "neutral" }))).toEqual([]);
  });

  it("niveau de danger : seule la suppression se présente en rouge — \"caution\" reste rendu comme une action neutre (aucun changement visuel)", () => {
    registerNodeContract(NUTANIX_KIND, { ...pluginContract(), menuItems: NUTANIX_ACTIONS }, "greffon nutanix");
    const handlers: Record<string, () => void> = {};
    for (const spec of NUTANIX_ACTIONS) handlers[spec.id] = () => {};
    const items = buildNodeMenuItems(node(NUTANIX_KIND, { status: "running" }), handlers);
    expect(items.find((i) => i.label === "Supprimer")?.danger).toBe(true);
    expect(items.find((i) => i.label === "Arrêter")?.danger).toBeUndefined();
    expect(items.find((i) => i.label === "Ajouter un disque…")?.danger).toBeUndefined();
  });
});
