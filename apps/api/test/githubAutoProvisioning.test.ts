import { describe, expect, it } from "vitest";

/**
 * Tests des 3 mécanismes génériques de résolution automatique de configuration (mission "faire
 * fonctionner RÉELLEMENT le déploiement formulaire_hotline", 14/08/2026) — apps/api/src/services/github.ts.
 * Fonctions PURES testées directement, même pattern que test/githubEnvConfig.test.ts.
 */
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const github = await import("../src/services/github.js");

describe("composeInterpolatedVarName — extraction ${VAR}/${VAR:-defaut} d'une valeur compose", () => {
  it("forme simple ${VAR}", () => {
    expect(github.composeInterpolatedVarName("${DB_PASS}")).toBe("DB_PASS");
  });
  it("forme avec défaut ${VAR:-defaut}", () => {
    expect(github.composeInterpolatedVarName("${DB_PASS:-hotline-pass}")).toBe("DB_PASS");
  });
  it("forme avec défaut sans deux-points ${VAR-defaut}", () => {
    expect(github.composeInterpolatedVarName("${DB_PASS-hotline-pass}")).toBe("DB_PASS");
  });
  it("valeur littérale (pas une interpolation) -> undefined", () => {
    expect(github.composeInterpolatedVarName("hotline-pass")).toBeUndefined();
  });
  it("valeur non-string -> undefined", () => {
    expect(github.composeInterpolatedVarName(42)).toBeUndefined();
    expect(github.composeInterpolatedVarName(null)).toBeUndefined();
  });
});

describe("isDbCredentialProvisionable — auto-provisioning DB_PASS (bug réel formulaire_hotline)", () => {
  it("service 'db' image mysql référençant ${DB_PASS} -> provisionnable (cas réel formulaire_hotline)", () => {
    const composeDoc = {
      services: {
        app: { build: "." },
        db: {
          image: "mysql:8.0",
          environment: {
            MYSQL_ROOT_PASSWORD: "${DB_ROOT_PASS:-rootpass}",
            MYSQL_PASSWORD: "${DB_PASS:-hotline-pass}",
          },
        },
      },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "DB_PASS")).toBe(true);
    expect(github.isDbCredentialProvisionable(composeDoc, "DB_ROOT_PASS")).toBe(true);
  });

  it("service nommé 'database' avec image mariadb, forme liste de environment", () => {
    const composeDoc = {
      services: {
        database: { image: "mariadb:10", environment: ["MARIADB_PASSWORD=${DATABASE_PASSWORD}"] },
      },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "DATABASE_PASSWORD")).toBe(true);
  });

  it("service postgres reconnu par l'image même avec un nom de service quelconque", () => {
    const composeDoc = {
      services: { pg: { image: "postgres:16", environment: { POSTGRES_PASSWORD: "${PG_PASS}" } } },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "PG_PASS")).toBe(true);
  });

  it("clé non référencée par AUCUN service producteur -> jamais provisionnée (pas de preuve)", () => {
    const composeDoc = {
      services: { db: { image: "mysql:8.0", environment: { MYSQL_PASSWORD: "${DB_PASS}" } } },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "SOME_OTHER_KEY")).toBe(false);
  });

  it("service dont l'image/le nom ne correspond à AUCUN moteur connu -> jamais provisionné, même s'il référence la clé", () => {
    const composeDoc = {
      services: { app: { image: "myapp:latest", environment: { DB_PASS: "${DB_PASS}" } } },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "DB_PASS")).toBe(false);
  });

  it("valeur LITTÉRALE (pas une interpolation) chez le producteur -> jamais provisionné (rien à générer, déjà fixé par l'auteur)", () => {
    const composeDoc = {
      services: { db: { image: "mysql:8.0", environment: { MYSQL_PASSWORD: "un-mot-de-passe-fixe" } } },
    };
    expect(github.isDbCredentialProvisionable(composeDoc, "DB_PASS")).toBe(false);
  });

  it("compose sans services / undefined -> false, jamais une exception", () => {
    expect(github.isDbCredentialProvisionable(undefined, "DB_PASS")).toBe(false);
    expect(github.isDbCredentialProvisionable({}, "DB_PASS")).toBe(false);
  });
});

describe("generateStrongSecret — mot de passe fort généré côté serveur", () => {
  it("génère une valeur suffisamment longue et jamais deux fois la même", () => {
    const a = github.generateStrongSecret();
    const b = github.generateStrongSecret();
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).not.toBe(b);
  });
});

describe("adminSeedSuggestion — seeder générique de compte admin par défaut", () => {
  it("clé email admin -> suggestion dérivée du nom du dépôt", () => {
    expect(github.adminSeedSuggestion("ADMIN_DEFAULT_EMAIL", "formulaire_hotline")).toBe("admin@formulaire-hotline.local");
    expect(github.adminSeedSuggestion("ADMIN_EMAIL", "MonRepo")).toBe("admin@monrepo.local");
  });

  it("clé mot de passe admin -> suggestion générée FORTE (jamais 'changeme'/'simple')", () => {
    const suggestion = github.adminSeedSuggestion("ADMIN_DEFAULT_PASS", "formulaire_hotline");
    expect(suggestion).toBeDefined();
    expect(suggestion!.length).toBeGreaterThanOrEqual(24);
    expect(suggestion).not.toMatch(/changeme|password|simple|123/i);
  });

  it("variantes reconnues : DEFAULT_ADMIN_*, SEED_ADMIN_*, ADMIN_PASSWORD", () => {
    expect(github.adminSeedSuggestion("DEFAULT_ADMIN_EMAIL", "repo")).toBeDefined();
    expect(github.adminSeedSuggestion("SEED_ADMIN_PASSWORD", "repo")).toBeDefined();
    expect(github.adminSeedSuggestion("ADMIN_PASSWORD", "repo")).toBeDefined();
  });

  it("clé qui ne ressemble à AUCUN motif de seed admin -> undefined, jamais une suggestion inventée", () => {
    expect(github.adminSeedSuggestion("DB_PASS", "repo")).toBeUndefined();
    expect(github.adminSeedSuggestion("SMTP_PASSWORD", "repo")).toBeUndefined();
    expect(github.adminSeedSuggestion("SOME_RANDOM_KEY", "repo")).toBeUndefined();
  });
});

describe("buildEnvRequirements + auto-résolutions combinées — scénario réel formulaire_hotline", () => {
  it("DB_PASS provisionnable + ADMIN_DEFAULT_PASS suggéré + SMTP_PASSWORD reste réellement bloquant", async () => {
    const composeDoc = {
      services: {
        app: { build: ".", env_file: ".env" },
        db: {
          image: "mysql:8.0",
          environment: { MYSQL_ROOT_PASSWORD: "${DB_ROOT_PASS:-rootpass}", MYSQL_PASSWORD: "${DB_PASS:-hotline-pass}" },
        },
      },
    };
    const envExampleDefaults = new Map<string, string | undefined>([
      ["DB_HOST", "localhost"],
      ["DB_PASS", undefined], // vide dans .env.example -> aucun défaut utilisable
      ["SMTP_PASSWORD", undefined],
      ["ADMIN_DEFAULT_PASS", undefined], // "changeme" -> placeholder, aucun défaut utilisable
      ["ADMIN_DEFAULT_EMAIL", undefined],
    ]);
    const { envVars, missingRequiredKeys } = await github.buildEnvRequirements({
      composeDoc,
      envExampleDefaults,
      resolvedValues: {},
      envFileExists: async () => false,
    });
    // Avant auto-résolution : tout est manquant, SAUF DB_HOST qui a un défaut légitime dans
    // .env.example ("localhost", ni sensible ni placeholder) — hasValue déjà true à ce stade.
    expect(missingRequiredKeys.sort()).toEqual(["ADMIN_DEFAULT_PASS", "ADMIN_DEFAULT_EMAIL", "DB_PASS", "SMTP_PASSWORD"].sort());

    // applyAutoResolutions n'est pas exportée (interne) — on la retrouve indirectement via
    // buildDeployConfigSchema/resolveAndWriteEnvConfig, déjà couverts par la vérification live ;
    // ici on vérifie seulement la détection amont (isDbCredentialProvisionable/adminSeedSuggestion)
    // sur les CLÉS que buildEnvRequirements a effectivement remontées comme manquantes.
    const dbPassVar = envVars.find((v) => v.key === "DB_PASS")!;
    expect(github.isDbCredentialProvisionable(composeDoc, dbPassVar.key)).toBe(true);

    const adminPassVar = envVars.find((v) => v.key === "ADMIN_DEFAULT_PASS")!;
    expect(github.adminSeedSuggestion(adminPassVar.key, "formulaire_hotline")).toBeDefined();

    const smtpVar = envVars.find((v) => v.key === "SMTP_PASSWORD")!;
    expect(github.isDbCredentialProvisionable(composeDoc, smtpVar.key)).toBe(false);
    expect(github.adminSeedSuggestion(smtpVar.key, "formulaire_hotline")).toBeUndefined();
  });
});

describe("githubEnvSecretName / saveGithubEnvValues — référence à un secret existant (secretRefs)", () => {
  it("le nom du secret multi-clé reste stable (scope repo)", () => {
    expect(github.githubEnvSecretName("Mairie-Creusot", "Formulaire_Hotline")).toBe("github-env:mairie-creusot/formulaire_hotline");
  });
});
