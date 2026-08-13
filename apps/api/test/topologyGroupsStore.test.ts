import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TopologyGroup } from "../src/types.js";

/**
 * CONFIG_PATH isolé (même pattern que notificationChannelsStore.test.ts/remoteEnvironments.test.ts) :
 * topologyGroupsStore.ts écrit topology-groups.json à côté de CONFIG_PATH — sans cet isolement, ces
 * tests pollueraient apps/api/data/ en développement réel.
 */
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const store = await import("../src/services/topologyGroupsStore.js");

const topologyGroupsPath = path.join(path.dirname(tmpConfigPath), "topology-groups.json");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
  await fs.rm(topologyGroupsPath, { force: true });
});

describe("topologyGroupsStore — groupes imbriqués (13/08/2026)", () => {
  it("crée un groupe contenant un autre groupe déjà existant (imbrication réelle)", async () => {
    const leaf = await store.createGroup({ label: "Feuille", nodeIds: ["container:a", "container:b"], createdBy: "yban" });
    expect(leaf.nodeIds).toEqual(["container:a", "container:b"]);

    const parent = await store.createGroup({ label: "Parent", nodeIds: [leaf.id, "container:c"], createdBy: "yban" });
    expect(parent.nodeIds).toEqual([leaf.id, "container:c"]);

    // Le sous-groupe est bien marqué "déjà membre" — impossible de le regrouper une seconde fois.
    await expect(
      store.createGroup({ label: "Doublon", nodeIds: [leaf.id, "container:d"], createdBy: "yban" }),
    ).rejects.toThrow(store.DuplicateGroupMemberError);

    await store.deleteGroup(parent.id);
    await store.deleteGroup(leaf.id);
  });

  it("refuse un groupe dont la profondeur dépasserait 5 (MaxGroupDepthExceededError)", async () => {
    // Construit une chaîne de groupes imbriqués L0 (réel) -> L1 -> L2 -> L3 -> L4 -> L5 (profondeur
    // 0,1,2,3,4 pour L0..L4 selon computeGroupDepth) puis tente L6 qui dépasserait MAX_GROUP_DEPTH=5.
    let previous = await store.createGroup({ label: "L0", nodeIds: ["container:d0a", "container:d0b"], createdBy: "yban" });
    const created: TopologyGroup[] = [previous];
    for (let level = 1; level <= 5; level++) {
      const next = await store.createGroup({ label: `L${level}`, nodeIds: [previous.id, `container:d${level}`], createdBy: "yban" });
      created.push(next);
      previous = next;
    }
    // `previous` a maintenant une profondeur de 5 (L5) — un nouveau groupe le contenant serait profondeur 6.
    await expect(
      store.createGroup({ label: "TropProfond", nodeIds: [previous.id, "container:d6"], createdBy: "yban" }),
    ).rejects.toThrow(store.MaxGroupDepthExceededError);

    for (const g of created.reverse()) await store.deleteGroup(g.id);
  });

  it("refuse un groupe dont le total de vrais nœuds transitifs dépasserait 256 (MaxGroupSizeExceededError)", async () => {
    const bigNodeIds = Array.from({ length: 257 }, (_, i) => `container:big-${i}`);
    const first = await store.createGroup({ label: "Big1", nodeIds: bigNodeIds.slice(0, 200), createdBy: "yban" });
    await expect(
      store.createGroup({ label: "Big2", nodeIds: [first.id, ...bigNodeIds.slice(200, 258)], createdBy: "yban" }),
    ).rejects.toThrow(store.MaxGroupSizeExceededError);
    await store.deleteGroup(first.id);
  });

  it("dissocier un groupe parent ne supprime pas le sous-groupe, qui redevient autonome", async () => {
    const leaf = await store.createGroup({ label: "Feuille2", nodeIds: ["container:e", "container:f"], createdBy: "yban" });
    const parent = await store.createGroup({ label: "Parent2", nodeIds: [leaf.id, "container:g"], createdBy: "yban" });

    const ok = await store.deleteGroup(parent.id);
    expect(ok).toBe(true);

    const remaining = await store.listGroups();
    expect(remaining.map((g) => g.id)).toEqual([leaf.id]);
    // leaf redevient un groupe de premier niveau : plus aucun groupe ne le référence.
    expect(remaining.some((g) => g.nodeIds.includes(leaf.id))).toBe(false);

    await store.deleteGroup(leaf.id);
  });

  describe("computeGroupDepth / resolveRealNodeIds — protections directes (fonctions pures)", () => {
    it("computeGroupDepth : 0 sans sous-groupe, 1 avec un sous-groupe direct, récursif au-delà", () => {
      const leafGroup: TopologyGroup = {
        id: "group:leaf",
        label: "leaf",
        nodeIds: ["container:x", "container:y"],
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "yban",
      };
      const groupsById = new Map([[leafGroup.id, leafGroup]]);
      expect(store.computeGroupDepth(["container:x", "container:y"], groupsById)).toBe(0);
      expect(store.computeGroupDepth([leafGroup.id, "container:z"], groupsById)).toBe(1);
    });

    it("computeGroupDepth/resolveRealNodeIds : anti-boucle infinie même sur un cycle corrompu (CyclicGroupError)", () => {
      // Simule des données corrompues (jamais atteignable via l'API réelle : un groupe ne peut
      // référencer qu'un groupe déjà existant, jamais lui-même) — la garde `visited` doit détecter
      // le cycle plutôt que de boucler indéfiniment.
      const a: TopologyGroup = {
        id: "group:a",
        label: "a",
        nodeIds: ["group:b"],
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "yban",
      };
      const b: TopologyGroup = {
        id: "group:b",
        label: "b",
        nodeIds: ["group:a"],
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "yban",
      };
      const groupsById = new Map([
        [a.id, a],
        [b.id, b],
      ]);
      expect(() => store.computeGroupDepth(["group:a"], groupsById)).toThrow(store.CyclicGroupError);
      expect(() => store.resolveRealNodeIds(["group:a"], groupsById)).toThrow(store.CyclicGroupError);
    });

    it("resolveRealNodeIds : déplie récursivement à travers plusieurs niveaux de sous-groupes", () => {
      const leaf: TopologyGroup = {
        id: "group:leaf",
        label: "leaf",
        nodeIds: ["container:x", "container:y"],
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "yban",
      };
      const mid: TopologyGroup = {
        id: "group:mid",
        label: "mid",
        nodeIds: [leaf.id, "container:z"],
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "yban",
      };
      const groupsById = new Map([
        [leaf.id, leaf],
        [mid.id, mid],
      ]);
      expect(store.resolveRealNodeIds([mid.id, "container:w"], groupsById).sort()).toEqual(
        ["container:w", "container:x", "container:y", "container:z"].sort(),
      );
    });
  });
});
