import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPE_LABEL,
  ISO_OS_FAMILIES,
  ISO_OS_FAMILY_LABEL,
  ISO_OS_FAMILY_PACKAGE_DISTRO,
  MKOSI_DEFAULT_RELEASE,
  MKOSI_DISTROS,
  STEP_TYPES,
  STEP_TYPE_LABEL,
  TEMPLATE_BASE_TYPE_LABEL,
  TEMPLATE_STATUS_LABEL,
  VM_DEPLOY_DEFAULTS,
  baseError,
  baseIsBuildable,
  baseSupportsSteps,
  createStep,
  defaultBase,
  isIsoImage,
  isUnattendedIso,
  isoInstallMode,
  isAbsolutePosixPath,
  isValidFileMode,
  isValidGuestAccount,
  isValidPackageName,
  isValidVmName,
  moveStep,
  nutanixTaskOutcome,
  nutanixTaskPercent,
  parsePackagesInput,
  recipeSummary,
  stepError,
  stepSummary,
  templateBaseLabel,
} from "./templateCatalog";
import type { TemplateStep } from "@/types";

// Verrouille la logique PURE du studio de templates (bases, étapes, validations, statut de tâche
// Prism) — le contrat de types v2 (TemplateBase/TemplateStep...) est figé, le backend code contre lui.

describe("bases de recette", () => {
  it("les 4 types de base du contrat ont un libellé et un défaut du bon type", () => {
    for (const type of ["cloud-image", "container", "mkosi", "iso"] as const) {
      expect(TEMPLATE_BASE_TYPE_LABEL[type]).toBeTruthy();
      expect(defaultBase(type).type).toBe(type);
    }
    for (const type of ["cloud-image", "container", "mkosi"] as const) expect(baseError(defaultBase(type))).toBeNull();
    // iso : le défaut est invalide tant qu'aucun ISO du catalogue n'est choisi — rien n'est inventé.
    expect(baseError(defaultBase("iso"))).not.toBeNull();
  });

  it("templateBaseLabel : résumé lisible pour chaque type", () => {
    expect(templateBaseLabel({ type: "cloud-image", distro: "debian", version: "12" })).toBe("VM cloud-image debian 12");
    expect(templateBaseLabel({ type: "container", image: "scratch" })).toBe("Conteneur scratch");
    expect(templateBaseLabel({ type: "mkosi", distro: "arch", release: "rolling" })).toBe("mkosi arch rolling");
    expect(templateBaseLabel({ type: "iso", imageUuid: "" })).toBe("ISO (à choisir)");
    expect(templateBaseLabel({ type: "iso", imageUuid: "abc-123" })).toBe("ISO abc-123");
    expect(templateBaseLabel({ type: "iso", imageUuid: "abc-123", install: "manual" })).toBe("ISO abc-123");
    expect(templateBaseLabel({ type: "iso", imageUuid: "abc-123", install: "unattended", osFamily: "rhel" })).toBe(
      "ISO automatisé abc-123 — RHEL / Rocky / Alma",
    );
  });

  it("baseError : distro/version/image/release/imageUuid exigées, imageUrl http(s) si renseignée", () => {
    expect(baseError({ type: "cloud-image", distro: "", version: "12" })).not.toBeNull();
    expect(baseError({ type: "cloud-image", distro: "debian", version: " " })).not.toBeNull();
    expect(baseError({ type: "cloud-image", distro: "debian", version: "12", imageUrl: "ftp://x" })).not.toBeNull();
    expect(baseError({ type: "cloud-image", distro: "debian", version: "12", imageUrl: "https://cloud.debian.org/x.qcow2" })).toBeNull();
    expect(baseError({ type: "container", image: "" })).not.toBeNull();
    expect(baseError({ type: "container", image: "scratch" })).toBeNull();
    expect(baseError({ type: "mkosi", distro: "debian", release: "" })).not.toBeNull();
    expect(baseError({ type: "iso", imageUuid: "" })).not.toBeNull();
    expect(baseError({ type: "iso", imageUuid: "abc-123" })).toBeNull();
    // Installation automatisée : la famille d'OS est REQUISE (elle pilote preseed/kickstart).
    expect(baseError({ type: "iso", imageUuid: "abc-123", install: "unattended" })).not.toBeNull();
    expect(baseError({ type: "iso", imageUuid: "abc-123", install: "unattended", osFamily: "ubuntu" })).toBeNull();
  });

  it("iso manuel : jamais de build ni d'étapes de provisioning (l'OS n'est pas encore installé)", () => {
    // `install` absent = "manual" (contrat) : comportement historique strictement inchangé.
    expect(isoInstallMode({ type: "iso", imageUuid: "abc" })).toBe("manual");
    expect(baseIsBuildable({ type: "iso", imageUuid: "abc" })).toBe(false);
    expect(baseSupportsSteps({ type: "iso", imageUuid: "abc" })).toBe(false);
    expect(baseIsBuildable({ type: "iso", imageUuid: "abc", install: "manual" })).toBe(false);
    expect(baseSupportsSteps({ type: "iso", imageUuid: "abc", install: "manual" })).toBe(false);
    expect(isUnattendedIso({ type: "iso", imageUuid: "abc" })).toBe(false);
    for (const type of ["cloud-image", "container", "mkosi"] as const) {
      expect(baseIsBuildable(defaultBase(type))).toBe(true);
      expect(baseSupportsSteps(defaultBase(type))).toBe(true);
    }
  });

  it("iso automatisé : étapes et build autorisés, comme une base cloud-image", () => {
    const unattended = { type: "iso", imageUuid: "abc", install: "unattended", osFamily: "debian" } as const;
    expect(isoInstallMode(unattended)).toBe("unattended");
    expect(isUnattendedIso(unattended)).toBe(true);
    expect(baseIsBuildable(unattended)).toBe(true);
    expect(baseSupportsSteps(unattended)).toBe(true);
    // Défaut du studio : mode automatisé (recommandé), ISO encore à choisir donc base invalide.
    expect(defaultBase("iso")).toEqual({ type: "iso", imageUuid: "", install: "unattended", osFamily: "debian" });
    expect(baseError(defaultBase("iso"))).not.toBeNull();
    // Les 3 familles du contrat ont un libellé et une distro de recherche de paquets réellement indexée.
    expect([...ISO_OS_FAMILIES]).toEqual(["debian", "ubuntu", "rhel"]);
    for (const f of ISO_OS_FAMILIES) {
      expect(ISO_OS_FAMILY_LABEL[f]).toBeTruthy();
      expect(ISO_OS_FAMILY_PACKAGE_DISTRO[f]).toBeTruthy();
    }
    expect(ISO_OS_FAMILY_PACKAGE_DISTRO.rhel).toBe("fedora");
  });

  it("isIsoImage : imageType contenant ISO (casse ignorée), jamais deviné sans type", () => {
    expect(isIsoImage({ uuid: "a", name: "debian.iso", imageType: "ISO_IMAGE" })).toBe(true);
    expect(isIsoImage({ uuid: "b", name: "x", imageType: "iso" })).toBe(true);
    expect(isIsoImage({ uuid: "c", name: "disk", imageType: "DISK_IMAGE" })).toBe(false);
    expect(isIsoImage({ uuid: "d", name: "sans-type.iso" })).toBe(false);
  });

  it("mkosi : chaque distro du contrat a une release par défaut", () => {
    expect([...MKOSI_DISTROS]).toEqual(["debian", "ubuntu", "fedora", "arch"]);
    for (const d of MKOSI_DISTROS) expect(MKOSI_DEFAULT_RELEASE[d]).toBeTruthy();
  });
});

describe("étapes de recette", () => {
  it("les 6 types d'étape du contrat sont proposés, chacun avec un libellé et une étape vierge du bon type", () => {
    expect(STEP_TYPES).toEqual(["packages", "script", "file", "artifact", "user", "service"]);
    for (const t of STEP_TYPES) {
      expect(STEP_TYPE_LABEL[t]).toBeTruthy();
      expect(createStep(t).type).toBe(t);
    }
  });

  it("une étape vierge est signalée invalide (rien n'est envoyé à moitié rempli)", () => {
    for (const t of STEP_TYPES) expect(stepError(createStep(t))).not.toBeNull();
  });

  it("stepError : étapes complètes valides", () => {
    expect(stepError({ type: "packages", packages: ["python3", "ca-certificates"] })).toBeNull();
    expect(stepError({ type: "script", content: "#!/bin/sh\necho ok" })).toBeNull();
    expect(stepError({ type: "file", path: "/etc/motd", content: "hello", mode: "644" })).toBeNull();
    expect(stepError({ type: "artifact", templateId: "t1", destPath: "/opt/app.tar" })).toBeNull();
    expect(stepError({ type: "user", username: "deploy", sudo: true })).toBeNull();
    expect(stepError({ type: "user", username: "deploy", sudo: true, passwordSecretName: "vm-root" })).toBeNull();
    expect(stepError({ type: "service", name: "nginx", enable: true })).toBeNull();
  });

  it("stepError : chemins absolus exigés pour file.path et artifact.destPath", () => {
    expect(stepError({ type: "file", path: "etc/motd", content: "x" })).not.toBeNull();
    expect(stepError({ type: "artifact", templateId: "t1", destPath: "opt/app" })).not.toBeNull();
  });

  it("moveStep : échange deux étapes, retourne le tableau intact hors bornes", () => {
    const steps: TemplateStep[] = [
      { type: "script", content: "a" },
      { type: "script", content: "b" },
    ];
    expect(moveStep(steps, 0, 1).map((s) => (s.type === "script" ? s.content : ""))).toEqual(["b", "a"]);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 1, 1)).toBe(steps);
  });

  it("stepSummary/recipeSummary : résumés courts, jamais de contenu inventé", () => {
    expect(stepSummary({ type: "packages", packages: ["python3"] })).toBe("python3");
    expect(stepSummary({ type: "script", content: "#!/bin/sh\napt-get update" })).toBe("#!/bin/sh");
    expect(stepSummary({ type: "user", username: "deploy", sudo: true })).toBe("deploy (sudo)");
    // Mot de passe : seul le NOM du secret QUAI apparaît, jamais sa valeur.
    expect(stepSummary({ type: "user", username: "deploy", sudo: true, passwordSecretName: "vm-root" })).toBe(
      "deploy (sudo) · secret vm-root",
    );
    expect(recipeSummary([])).toBe("Recette vide (base nue)");
    expect(recipeSummary([{ type: "script", content: "x" }])).toBe("1 étape : script");
    expect(
      recipeSummary([
        { type: "packages", packages: ["python3"] },
        { type: "packages", packages: ["curl"] },
        { type: "script", content: "x" },
      ]),
    ).toBe("3 étapes : paquets, script");
  });
});

describe("validations élémentaires", () => {
  it("isValidPackageName : noms plausibles acceptés, espaces/vides refusés", () => {
    expect(isValidPackageName("python3")).toBe(true);
    expect(isValidPackageName("libssl-dev")).toBe(true);
    expect(isValidPackageName("g++")).toBe(true);
    expect(isValidPackageName("pkg avec espace")).toBe(false);
    expect(isValidPackageName("")).toBe(false);
    expect(isValidPackageName("-lead")).toBe(false);
  });

  it("isAbsolutePosixPath : / en tête exigé, backslash/espaces en bord refusés", () => {
    expect(isAbsolutePosixPath("/etc/motd")).toBe(true);
    expect(isAbsolutePosixPath("etc/motd")).toBe(false);
    expect(isAbsolutePosixPath("/")).toBe(false);
    expect(isAbsolutePosixPath("C:\\temp")).toBe(false);
    expect(isAbsolutePosixPath(" /etc/motd")).toBe(false);
  });

  it("isValidFileMode : octal 3-4 chiffres", () => {
    expect(isValidFileMode("644")).toBe(true);
    expect(isValidFileMode("0755")).toBe(true);
    expect(isValidFileMode("999")).toBe(false);
    expect(isValidFileMode("rw-")).toBe(false);
  });

  it("parsePackagesInput : découpe espaces/virgules/retours ligne, sans doublons ni vides", () => {
    expect(parsePackagesInput("python3, curl\n ca-certificates python3")).toEqual(["python3", "curl", "ca-certificates"]);
    expect(parsePackagesInput("  ,, ")).toEqual([]);
  });
});

describe("libellés partagés", () => {
  it("statuts et types d'artifact complets (raw-image mkosi compris)", () => {
    expect(Object.keys(TEMPLATE_STATUS_LABEL).sort()).toEqual(["building", "draft", "error", "ready"]);
    expect(Object.keys(ARTIFACT_TYPE_LABEL).sort()).toEqual(["docker-image", "nutanix-image", "raw-image"]);
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
