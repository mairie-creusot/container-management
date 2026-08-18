import { describe, expect, it } from "vitest";
import { languageForPath } from "./codeLanguage";

describe("languageForPath", () => {
  it("détecte les scripts shell", () => {
    expect(languageForPath("/opt/provision.sh")).toBe("shell");
    expect(languageForPath("setup.bash")).toBe("shell");
  });

  it("détecte le YAML (cloud-init inclus)", () => {
    expect(languageForPath("cloud-init.yaml")).toBe("yaml");
    expect(languageForPath("/etc/netplan/50-cloud-init.yml")).toBe("yaml");
  });

  it("détecte les Dockerfile sous leurs différentes formes", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("Dockerfile.api")).toBe("dockerfile");
    expect(languageForPath("api.dockerfile")).toBe("dockerfile");
  });

  it("détecte le HCL (Packer/Terraform)", () => {
    expect(languageForPath("template.pkr.hcl")).toBe("hcl");
    expect(languageForPath("main.tf")).toBe("hcl");
    expect(languageForPath("prod.tfvars")).toBe("hcl");
  });

  it("détecte les fichiers de configuration clé/valeur", () => {
    expect(languageForPath("/etc/app/app.conf")).toBe("properties");
    expect(languageForPath("settings.ini")).toBe("properties");
    expect(languageForPath(".env")).toBe("properties");
  });

  it("retombe sur text quand rien n'est reconnu", () => {
    expect(languageForPath("/etc/motd")).toBe("text");
    expect(languageForPath("notes.txt")).toBe("text");
    expect(languageForPath("")).toBe("text");
  });
});
