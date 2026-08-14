import { describe, expect, it } from "vitest";

/**
 * Tests du moteur générique de diagnostic des échecs de déploiement (mission "un systeme si le
 * build echoue... generer un rapport visible et claire", 14/08/2026) —
 * apps/api/src/services/deploymentDiagnostics.ts. Fonction PURE testée directement.
 */
const { diagnoseDeploymentFailure } = await import("../src/services/deploymentDiagnostics.js");

describe("diagnoseDeploymentFailure — en-tête manquant pour compiler une extension", () => {
  it("reconnaît le cas RÉEL ldap.h (mairie-creusot/formulaire_hotline, 14/08/2026)", () => {
    const log = `
$ docker build -t quai-gh/mairie-creusot-formulaire-hotline:abcd1234 .
Step 5/12 : RUN docker-php-ext-install pdo_mysql ldap zip
checking for ldap.h... not found
configure: error: Cannot find ldap.h
The command '/bin/sh -c docker-php-ext-install pdo_mysql ldap zip' returned a non-zero code: 5
`;
    const diagnostics = diagnoseDeploymentFailure(log);
    const headerDiag = diagnostics.find((d) => d.category === "missing-header");
    expect(headerDiag).toBeDefined();
    expect(headerDiag!.title).toContain("ldap.h");
    expect(headerDiag!.suggestedAction).toContain("openldap-dev");
    expect(headerDiag!.evidence).toContain("ldap.h");
  });

  it("reconnaît la forme 'fatal error: X.h: No such file or directory' et suggère un paquet -dev pour un header inconnu", () => {
    const log = "In file included from ext.c:1:\nfatal error: totally-unknown-lib.h: No such file or directory\ncompilation terminated.";
    const diagnostics = diagnoseDeploymentFailure(log);
    const headerDiag = diagnostics.find((d) => d.category === "missing-header");
    expect(headerDiag).toBeDefined();
    expect(headerDiag!.title).toContain("totally-unknown-lib.h");
    expect(headerDiag!.suggestedAction).toMatch(/-dev/);
  });
});

describe("diagnoseDeploymentFailure — dépendances (composer/npm/pip)", () => {
  it("composer : paquet introuvable, nom extrait", () => {
    const log = "Your requirements could not be resolved to an installable set of packages.\n  Problem 1\n    - Could not find package acme/inexistant.";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "missing-dependency")).toBe(true);
  });

  it("npm : paquet 404", () => {
    const log = "npm ERR! code E404\nnpm ERR! 404 'left-pad-inexistant' is not in this registry.";
    const diagnostics = diagnoseDeploymentFailure(log);
    const dep = diagnostics.find((d) => d.category === "missing-dependency");
    expect(dep).toBeDefined();
    expect(dep!.title).toContain("left-pad-inexistant");
  });

  it("pip : version introuvable", () => {
    const log = "ERROR: Could not find a version that satisfies the requirement flask-inexistant==99.0";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "missing-dependency")).toBe(true);
  });
});

describe("diagnoseDeploymentFailure — image introuvable/non autorisée", () => {
  it("pull access denied", () => {
    const log = "Error response from daemon: pull access denied for ghcr.io/mairie-creusot/prive, repository does not exist or may require 'docker login'";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "image-not-found")).toBe(true);
  });

  it("manifest not found", () => {
    const log = "Error: manifest for nginx:99.99-inexistant not found: manifest unknown";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "image-not-found")).toBe(true);
  });
});

describe("diagnoseDeploymentFailure — erreur de syntaxe YAML/HCL", () => {
  it("YAML compose invalide", () => {
    const log = "YAMLException: bad indentation of a mapping entry at line 5, column 3";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "syntax-error")).toBe(true);
  });
});

describe("diagnoseDeploymentFailure — dépendance de service compose en échec", () => {
  it("reconnaît le cas RÉEL rencontré (mairie-creusot/formulaire_hotline, 14/08/2026 : service 'db' MySQL en erreur, healthcheck jamais atteint)", () => {
    const log = `
 Container quai-gh-mairie-creusot-formulaire_hotline-cee29ce6-db-1  Starting
 Container quai-gh-mairie-creusot-formulaire_hotline-cee29ce6-db-1  Started
 Container quai-gh-mairie-creusot-formulaire_hotline-cee29ce6-db-1  Waiting
dependency failed to start: container quai-gh-mairie-creusot-formulaire_hotline-cee29ce6-db-1 exited (1)
 Container quai-gh-mairie-creusot-formulaire_hotline-cee29ce6-db-1  Error
`;
    const diagnostics = diagnoseDeploymentFailure(log);
    const dep = diagnostics.find((d) => d.category === "dependency-failed");
    expect(dep).toBeDefined();
    expect(dep!.title).toContain("db-1");
    expect(dep!.suggestedAction).toMatch(/logs/i);
  });
});

describe("diagnoseDeploymentFailure — cas limites déjà gérés en amont (port/config)", () => {
  it("reconnaît quand même un conflit de port s'il atteint ce diagnostic", () => {
    const log = "Bind for 0.0.0.0:5432 failed: port is already allocated";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "port-conflict")).toBe(true);
  });

  it("reconnaît quand même une configuration manquante s'il atteint ce diagnostic", () => {
    const log = "Configuration requise avant de déployer : 2 variable(s) d'environnement manquante(s) — FOO, BAR.";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.some((d) => d.category === "missing-config")).toBe(true);
  });
});

describe("diagnoseDeploymentFailure — repli honnête (jamais un diagnostic inventé)", () => {
  it("aucun motif connu -> UN diagnostic 'unknown' explicite, jamais []", () => {
    const log = "quelque chose d'inattendu et complètement hors de tout motif connu s'est produit";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.category).toBe("unknown");
    expect(diagnostics[0]!.suggestedAction).toMatch(/journal complet/i);
  });

  it("log vide -> toujours au moins un diagnostic", () => {
    expect(diagnoseDeploymentFailure("")).toHaveLength(1);
  });
});

describe("diagnoseDeploymentFailure — plusieurs motifs dans le même log", () => {
  it("combine en-tête manquant ET repli si un second motif inconnu suit (liste, pas juste le premier)", () => {
    const log = "fatal error: ldap.h: No such file or directory\nErrorless unrelated line";
    const diagnostics = diagnoseDeploymentFailure(log);
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics[0]!.category).toBe("missing-header");
  });
});
