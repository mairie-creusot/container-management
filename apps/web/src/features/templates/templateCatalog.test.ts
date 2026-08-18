import { describe, expect, it } from "vitest";
import {
  TEMPLATE_BASE_OPTIONS,
  TEMPLATE_COMPONENTS,
  TEMPLATE_KIND_LABEL,
  TEMPLATE_STATUS_LABEL,
  VM_DEPLOY_DEFAULTS,
  defaultComponents,
  isValidGuestAccount,
  isValidVmName,
  normalizeComponents,
  nutanixTaskOutcome,
  nutanixTaskPercent,
  templateBaseOption,
} from "./templateCatalog";
import type { ImageTemplateKind } from "@/types";

// Verrouille la logique PURE de la fabrique de templates (catalogue, validation, statut de tâche
// Prism) — le contrat de types (ImageTemplate...) est figé, les deux backends codent contre lui.

describe("catalogue des bases", () => {
  it("les 3 kinds du contrat sont proposés, chacun une seule fois", () => {
    const kinds = TEMPLATE_BASE_OPTIONS.map((o) => o.kind).sort();
    expect(kinds).toEqual(["container-alpine", "container-scratch", "vm-ubuntu"]);
  });

  it("vm-ubuntu : versions figées 24.04/26.04 (jamais de saisie libre), défaut 24.04", () => {
    const option = templateBaseOption("vm-ubuntu");
    expect(option.baseVersions).toEqual(["24.04", "26.04"]);
    expect(option.defaultBaseVersion).toBe("24.04");
    expect(option.baseVersionEditable).toBe(false);
    expect(option.target).toBe("vm");
  });

  it("container-alpine : tag libre (défaut 3.20) ; container-scratch : version figée", () => {
    const alpine = templateBaseOption("container-alpine");
    expect(alpine.baseVersionEditable).toBe(true);
    expect(alpine.defaultBaseVersion).toBe("3.20");
    const scratch = templateBaseOption("container-scratch");
    expect(scratch.baseVersionEditable).toBe(false);
    expect(scratch.target).toBe("container");
  });

  it("chaque kind a des libellés de statut/kind complets (records totaux, ancrés ici)", () => {
    for (const kind of Object.keys(TEMPLATE_COMPONENTS) as ImageTemplateKind[]) {
      expect(TEMPLATE_KIND_LABEL[kind]).toBeTruthy();
    }
    expect(Object.keys(TEMPLATE_STATUS_LABEL).sort()).toEqual(["building", "draft", "error", "ready"]);
  });
});

describe("composants", () => {
  it("vm-ubuntu : Docker + Compose REQUIS (contrat mission), toujours inclus même décochés", () => {
    const required = TEMPLATE_COMPONENTS["vm-ubuntu"].filter((c) => c.required).map((c) => c.id);
    expect(required).toEqual(["docker", "docker-compose"]);
    expect(normalizeComponents("vm-ubuntu", [])).toContain("docker");
    expect(normalizeComponents("vm-ubuntu", [])).toContain("docker-compose");
  });

  it("normalizeComponents : ids inconnus écartés, ordre stable = ordre du catalogue", () => {
    expect(normalizeComponents("container-alpine", ["curl", "inconnu", "ca-certificates"])).toEqual(["ca-certificates", "curl"]);
    expect(normalizeComponents("container-scratch", ["inconnu"])).toEqual([]);
  });

  it("defaultComponents : cases cochées par défaut + requis", () => {
    expect(defaultComponents("vm-ubuntu")).toEqual(["docker", "docker-compose", "qemu-guest-agent", "openssh-server"]);
    expect(defaultComponents("container-alpine")).toEqual(["ca-certificates"]);
    expect(defaultComponents("container-scratch")).toEqual([]);
  });
});

describe("validation du déploiement en VM", () => {
  it("nom de VM/hostname : alphanumérique + tirets, 63 max, jamais de tiret en tête/queue", () => {
    expect(isValidVmName("app-prod-01")).toBe(true);
    expect(isValidVmName("a")).toBe(true);
    expect(isValidVmName("-app")).toBe(false);
    expect(isValidVmName("app-")).toBe(false);
    expect(isValidVmName("app prod")).toBe(false);
    expect(isValidVmName("app_prod")).toBe(false);
    expect(isValidVmName("a".repeat(63))).toBe(true);
    expect(isValidVmName("a".repeat(64))).toBe(false);
    expect(isValidVmName("")).toBe(false);
  });

  it("compte invité : username POSIX + mot de passe OU clé SSH (au moins l'un des deux)", () => {
    expect(isValidGuestAccount("admin", "secret", "")).toBe(true);
    expect(isValidGuestAccount("admin", "", "ssh-ed25519 AAAA")).toBe(true);
    expect(isValidGuestAccount("admin", "", "")).toBe(false);
    expect(isValidGuestAccount("Admin", "secret", "")).toBe(false); // majuscule interdite
    expect(isValidGuestAccount("1admin", "secret", "")).toBe(false); // commence par un chiffre
    expect(isValidGuestAccount("", "secret", "")).toBe(false);
  });

  it("défauts raisonnables pré-remplis (mission « prêt en 2 min »)", () => {
    expect(VM_DEPLOY_DEFAULTS).toEqual({ numVcpus: 2, numCoresPerVcpu: 1, memoryMib: 4096, diskSizeGib: 50 });
  });
});

describe("statut de tâche Prism Central", () => {
  it("SUCCEEDED/FAILED (et variantes, casse ignorée) -> issue ; statut inconnu -> reste running (le poll continue)", () => {
    expect(nutanixTaskOutcome({ uuid: "t", status: "SUCCEEDED" })).toBe("succeeded");
    expect(nutanixTaskOutcome({ uuid: "t", status: "succeeded" })).toBe("succeeded");
    expect(nutanixTaskOutcome({ uuid: "t", status: "FAILED" })).toBe("failed");
    expect(nutanixTaskOutcome({ uuid: "t", status: "ABORTED" })).toBe("failed");
    expect(nutanixTaskOutcome({ uuid: "t", status: "RUNNING" })).toBe("running");
    expect(nutanixTaskOutcome({ uuid: "t", status: "QUEUED" })).toBe("running");
    expect(nutanixTaskOutcome({ uuid: "t", status: "STATUT_JAMAIS_VU" })).toBe("running");
  });

  it("pourcentage : borné 0..100, 100 si réussi sans pourcentage, 0 sinon (jamais inventé)", () => {
    expect(nutanixTaskPercent({ uuid: "t", status: "RUNNING", percentageComplete: 42 })).toBe(42);
    expect(nutanixTaskPercent({ uuid: "t", status: "RUNNING", percentageComplete: 140 })).toBe(100);
    expect(nutanixTaskPercent({ uuid: "t", status: "RUNNING", percentageComplete: -5 })).toBe(0);
    expect(nutanixTaskPercent({ uuid: "t", status: "SUCCEEDED" })).toBe(100);
    expect(nutanixTaskPercent({ uuid: "t", status: "RUNNING" })).toBe(0);
  });
});
