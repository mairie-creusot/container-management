/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import SchemaForm from "@/components/SchemaForm";
import { buildNodeMenuItems } from "@/components/topologyNodeContract";
import {
  pluginActionConfirmMessage,
  pluginActionForm,
  pluginActionsForNode,
  type ResolvedPluginAction,
} from "@/features/plugins/pluginActions";
import type { PluginActionSpec, PluginSummary } from "@/features/plugins/pluginsModel";
import type { TopologyNode } from "@/types";

// Même précaution que SchemaForm.test.tsx : ni `globals` ni jsdom par défaut dans la configuration
// de test du web — l'environnement vient du docblock, l'auto-nettoyage se branche ici.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

/**
 * Menu contextuel d'un nœud, construit à partir des actions DÉCLARÉES par les greffons
 * (PluginManifest#actions) — dérivation pure, aucun réseau.
 *
 * Verrou principal : les actions Nutanix, toutes marquées `servedByCore`, n'ajoutent RIEN au menu
 * — l'écran actuel (boutons de cycle de vie, popovers disque/carte réseau, confirmation par saisie
 * du nom) reste le seul à les servir, exactement comme avant cette passe.
 */

function summary(id: string, actions: Record<string, PluginActionSpec>, overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    manifest: {
      id,
      name: id === "nutanix" ? "Virtualisation Nutanix" : id,
      version: "1.0.0",
      coreApi: "^1.0",
      configSchema: { type: "object", properties: {} },
      secretFields: [],
      permissions: { mutates: true, graphNodeKinds: ["nutanix-vm"] },
      auditLabels: {},
      actions,
    },
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function vmNode(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return { id: "nutanix-vm:uuid-1", kind: "nutanix-vm", label: "HDVAPPLI", subtitle: "CLUSTER_AHV_HDV", status: "running", ...overrides };
}

/** Déclarations telles que le greffon Nutanix les publie : toutes servies par un écran du cœur. */
const NUTANIX_ACTIONS: Record<string, PluginActionSpec> = {
  "vm.stop": {
    severity: "caution",
    confirm: { title: "Arrêter la VM", message: `Confirmer l'arrêt de "{cible}" ?`, confirmLabel: "Arrêter" },
    target: { nodeKind: "nutanix-vm", field: "uuid", when: [{ field: "status", equals: ["running"] }], servedByCore: "nutanix-vm-stop" },
  },
  "vm.delete": {
    severity: "destructive",
    confirm: { title: "Supprimer cette VM", message: `Supprimer "{cible}" ?`, confirmLabel: "Supprimer définitivement", retype: true },
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "panneau de détail du nœud (saisie du nom de la VM)" },
  },
  "image.create": { severity: "safe", input: { type: "object", properties: { name: { type: "string" } } } },
};

/** Greffon fictif qui, LUI, propose ses propres entrées de menu. */
const DECLARED_ACTIONS: Record<string, PluginActionSpec> = {
  "vm.snapshot": {
    severity: "safe",
    input: {
      type: "object",
      properties: {
        nom: { type: "string", title: "Nom de l'instantané", examples: ["avant-migration"] },
        quiescent: { type: "boolean", title: "Figer le système de fichiers" },
      },
      required: ["nom"],
    },
    confirm: { title: "Prendre un instantané", message: `Prendre un instantané de "{cible}" ?`, confirmLabel: "Prendre" },
    target: { nodeKind: "nutanix-vm", field: "uuid", menuLabel: "Prendre un instantané…" },
  },
  "vm.purge": {
    severity: "destructive",
    target: {
      nodeKind: "nutanix-vm",
      field: "uuid",
      menuLabel: "Purger les instantanés",
      when: [{ field: "status", equals: ["stopped"] }],
    },
  },
  "cluster.rescan": { target: { nodeKind: "host", field: "uuid", menuLabel: "Re-scanner" } },
};

describe("actions de greffons proposables sur un nœud", () => {
  it("n'ajoute AUCUNE entrée pour Nutanix : chacune de ses actions est déjà servie par le cœur", () => {
    expect(pluginActionsForNode([summary("nutanix", NUTANIX_ACTIONS)], vmNode())).toEqual([]);
    expect(pluginActionsForNode([summary("nutanix", NUTANIX_ACTIONS)], vmNode({ status: "stopped" }))).toEqual([]);
  });

  it("propose les actions déclarées avec une entrée de menu, dans l'ordre du manifeste", () => {
    const actions = pluginActionsForNode([summary("demo", DECLARED_ACTIONS)], vmNode({ status: "stopped" }));
    expect(actions.map((action) => action.label)).toEqual(["Prendre un instantané…", "Purger les instantanés"]);
    expect(actions[0]).toMatchObject({ pluginId: "demo", actionId: "vm.snapshot", severity: "safe" });
    expect(actions[1]?.severity).toBe("destructive");
  });

  it("respecte la condition d'affichage sur l'état RÉEL du nœud", () => {
    // "Purger" n'est déclarée que pour une VM éteinte : allumée, elle disparaît.
    const running = pluginActionsForNode([summary("demo", DECLARED_ACTIONS)], vmNode({ status: "running" }));
    expect(running.map((action) => action.actionId)).toEqual(["vm.snapshot"]);
  });

  it("ignore un autre type de nœud, un greffon désactivé et un greffon jamais configuré", () => {
    const node = vmNode();
    expect(pluginActionsForNode([summary("demo", DECLARED_ACTIONS)], { ...node, kind: "container" })).toEqual([]);
    expect(pluginActionsForNode([summary("demo", DECLARED_ACTIONS, { enabled: false })], node)).toEqual([]);
    expect(pluginActionsForNode([summary("demo", DECLARED_ACTIONS, { configured: false })], node)).toEqual([]);
  });

  it("ignore un greffon qui ne décrit pas ses actions (contrat antérieur)", () => {
    const legacy = summary("ancien", {});
    delete legacy.manifest.actions;
    expect(pluginActionsForNode([legacy], vmNode())).toEqual([]);
  });

  it("remplace {cible} par le libellé réel du nœud, et rien d'autre", () => {
    expect(pluginActionConfirmMessage(`Supprimer "{cible}" ?`, "HDVAPPLI")).toBe(`Supprimer "HDVAPPLI" ?`);
    expect(pluginActionConfirmMessage("Aucun jeton ici", "HDVAPPLI")).toBe("Aucun jeton ici");
  });
});

describe("formulaire déduit de l'entrée déclarée", () => {
  function snapshotAction(): ResolvedPluginAction {
    const action = pluginActionsForNode([summary("demo", DECLARED_ACTIONS)], vmNode())[0];
    expect(action).toBeDefined();
    return action as ResolvedPluginAction;
  }

  it("convertit le schéma déclaré en formulaire, et le rend réellement", () => {
    const form = pluginActionForm(snapshotAction());
    expect(form !== null && form.ok, form !== null && !form.ok ? form.problems.join(" ; ") : "").toBe(true);
    if (form === null || !form.ok) return;

    expect(form.schema.fields.map((field) => field.name)).toEqual(["nom", "quiescent"]);
    render(<SchemaForm schema={form.schema} onSubmit={() => {}} submitLabel="Prendre un instantané…" />);
    expect(screen.getByLabelText(/Nom de l'instantané/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Prendre un instantané…" })).toBeDefined();
  });

  it("aucune saisie déclarée = aucun formulaire : l'action s'exécute au clic", () => {
    const purge = pluginActionsForNode([summary("demo", DECLARED_ACTIONS)], vmNode({ status: "stopped" }))[1];
    expect(purge?.input).toBeUndefined();
    expect(pluginActionForm(purge as ResolvedPluginAction)).toBeNull();
  });
});

describe("rendu du menu : actions du cœur PUIS actions déclarées", () => {
  /** Reproduit la composition de TopologyGraph#nodeMenuItems : entrées du cœur (contrat de nœud)
   * suivies des entrées déclarées par les greffons. */
  function menuItems(node: TopologyNode, plugins: PluginSummary[], onRun: (id: string) => void): ContextMenuItem[] {
    const items: ContextMenuItem[] = buildNodeMenuItems(node, {
      "nutanix-vm-stop": () => onRun("nutanix-vm-stop"),
      "nutanix-vm-restart": () => onRun("nutanix-vm-restart"),
      "nutanix-vm-start": () => onRun("nutanix-vm-start"),
      "nutanix-vm-add-disk": () => onRun("nutanix-vm-add-disk"),
      "nutanix-vm-add-nic": () => onRun("nutanix-vm-add-nic"),
      "nutanix-vm-edit-compute": () => onRun("nutanix-vm-edit-compute"),
    });
    for (const action of pluginActionsForNode(plugins, node)) {
      items.push({
        label: action.label,
        ...(action.severity === "destructive" ? { danger: true } : {}),
        onClick: () => onRun(action.actionId),
      });
    }
    return items;
  }

  it("le menu d'une VM Nutanix est INCHANGÉ quand le greffon ne fait que décrire ses actions", () => {
    const onRun = vi.fn<(id: string) => void>();
    const items = menuItems(vmNode(), [summary("nutanix", NUTANIX_ACTIONS)], onRun);
    expect(items.map((item) => item.label)).toEqual(["Arrêter", "Redémarrer", "Ajouter un disque…", "Ajouter une carte réseau…", "vCPU / Mémoire…"]);
    expect(items.some((item) => item.danger)).toBe(false);
  });

  it("une action déclarée avec son entrée de menu s'ajoute APRÈS celles du cœur, danger compris", () => {
    const onRun = vi.fn<(id: string) => void>();
    const items = menuItems(vmNode({ status: "stopped" }), [summary("demo", DECLARED_ACTIONS)], onRun);

    render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} />);
    const labels = screen.getAllByRole("menuitem").map((button) => button.textContent);
    // "Démarrer" (cœur, VM éteinte) puis les entrées matérielles du cœur, puis celles du greffon.
    expect(labels.slice(-2)).toEqual(["Prendre un instantané…", "Purger les instantanés"]);
    expect(labels).toContain("Ajouter un disque…");

    const purge = screen.getByRole("menuitem", { name: "Purger les instantanés" });
    expect(purge.className).toContain("context-menu__item--danger");
    fireEvent.click(purge);
    expect(onRun).toHaveBeenCalledWith("vm.purge");
  });
});
