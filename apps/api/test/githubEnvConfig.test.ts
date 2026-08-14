import { describe, expect, it } from "vitest";

/**
 * Tests de la détection/résolution des variables d'environnement manquantes (cf. mission "fichier
 * .env manquant au déploiement" — apps/api/src/services/github.ts). Corrige un bug réel constaté
 * le 14/08/2026 sur mairie-creusot/formulaire_hotline : un docker-compose.yml référençant un .env
 * absent du clone frais faisait échouer platement `docker compose up` au lieu d'une détection
 * propre AVANT l'échec. Fonctions PURES testées directement (aucun réseau, aucun clone), même
 * pattern que test/github.test.ts.
 */
process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY ?? "9".repeat(64);

const github = await import("../src/services/github.js");

describe("looksSensitiveEnvKey — heuristique sur le NOM de la clé", () => {
  it.each(["DATABASE_PASSWORD", "API_KEY", "STRIPE_SECRET", "SESSION_TOKEN", "SMTP_PASSWORD", "DATABASE_URL", "PRIVATE_KEY"])(
    "%s est considérée sensible (champ masqué)",
    (key) => {
      expect(github.looksSensitiveEnvKey(key)).toBe(true);
    },
  );

  it.each(["PORT", "NODE_ENV", "APP_NAME", "LOG_LEVEL", "TZ"])("%s n'est PAS considérée sensible", (key) => {
    expect(github.looksSensitiveEnvKey(key)).toBe(false);
  });
});

describe("looksLikePlaceholderEnvValue — jamais un placeholder utilisé comme vrai défaut", () => {
  it.each(["", "changeme", "CHANGE_ME", "xxx", "<votre-clé-ici>", "your-api-key-here", "placeholder", "todo"])(
    '"%s" est un placeholder (jamais utilisé comme défaut)',
    (value) => {
      expect(github.looksLikePlaceholderEnvValue(value)).toBe(true);
    },
  );

  it.each(["3000", "production", "https://api.example.com", "app-name"])('"%s" est une vraie valeur utilisable', (value) => {
    expect(github.looksLikePlaceholderEnvValue(value)).toBe(false);
  });
});

describe("parseEnvExampleDefaults — .env.example comme liste de référence", () => {
  it("retient une valeur non-sensible et non-placeholder comme défaut légitime", () => {
    const defaults = github.parseEnvExampleDefaults("PORT=3000\nNODE_ENV=production\n# commentaire\n");
    expect(defaults.get("PORT")).toBe("3000");
    expect(defaults.get("NODE_ENV")).toBe("production");
  });

  it("ne retient JAMAIS une valeur pour une clé sensible, même remplie", () => {
    const defaults = github.parseEnvExampleDefaults("DATABASE_PASSWORD=hunter2\n");
    expect(defaults.has("DATABASE_PASSWORD")).toBe(true);
    expect(defaults.get("DATABASE_PASSWORD")).toBeUndefined();
  });

  it("ne retient JAMAIS un placeholder comme défaut", () => {
    const defaults = github.parseEnvExampleDefaults("API_URL=changeme\n");
    expect(defaults.get("API_URL")).toBeUndefined();
  });

  it("retire les guillemets englobants et ignore les lignes mal formées", () => {
    const defaults = github.parseEnvExampleDefaults('APP_NAME="mon app"\nceci n\'est pas une ligne valide\nEMPTY_LINE_ABOVE=1\n');
    expect(defaults.get("APP_NAME")).toBe("mon app");
    expect(defaults.get("EMPTY_LINE_ABOVE")).toBe("1");
  });
});

describe("composeEnvFilePaths / composeEnvironmentMissingKeys — env_file/environment compose", () => {
  it("accepte la forme courte (chaîne unique) de env_file", () => {
    expect(github.composeEnvFilePaths({ env_file: ".env" })).toEqual([".env"]);
  });

  it("accepte la forme liste et la forme longue { path } de env_file", () => {
    expect(github.composeEnvFilePaths({ env_file: [".env", { path: ".env.local" }] })).toEqual([".env", ".env.local"]);
  });

  it("aucun env_file -> []", () => {
    expect(github.composeEnvFilePaths({})).toEqual([]);
  });

  it("clé 'KEY:' sans valeur (map YAML) -> remontée comme manquante", () => {
    expect(github.composeEnvironmentMissingKeys({ environment: { DATABASE_URL: null, PORT: "3000" } })).toEqual(["DATABASE_URL"]);
  });

  it("forme liste 'KEY' seule (sans '=') -> remontée comme manquante ; 'KEY=valeur' jamais", () => {
    expect(github.composeEnvironmentMissingKeys({ environment: ["DATABASE_URL", "PORT=3000"] })).toEqual(["DATABASE_URL"]);
  });
});

describe("parseDockerfileArgsWithoutDefault — ARG Dockerfile sans valeur par défaut", () => {
  it("ARG sans '=' -> remonté ; ARG avec valeur par défaut -> jamais", () => {
    const args = github.parseDockerfileArgsWithoutDefault("FROM node:20\nARG NODE_ENV=production\nARG API_KEY\nARG PORT=3000\n");
    expect(args).toEqual(["API_KEY"]);
  });

  it("aucun ARG -> []", () => {
    expect(github.parseDockerfileArgsWithoutDefault("FROM node:20\nRUN echo hello\n")).toEqual([]);
  });
});

describe("buildEnvRequirements — cœur de la détection (bug réel formulaire_hotline)", () => {
  it("env_file référencé mais ABSENT du dépôt, sans .env.example : limite honnête (unresolvableEnvFile), aucun champ inventé", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { env_file: ".env" } } },
      envExampleDefaults: new Map(),
      resolvedValues: {},
      envFileExists: async () => false,
    });
    expect(result.envVars).toEqual([]);
    expect(result.missingRequiredKeys).toEqual([]);
    expect(result.unresolvableEnvFile).toBe(".env");
  });

  it("env_file référencé et ABSENT, mais .env.example présent : les clés du .env.example deviennent requises", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { env_file: ".env" } } },
      envExampleDefaults: new Map([["DATABASE_URL", undefined], ["PORT", "3000"]]),
      resolvedValues: {},
      envFileExists: async () => false,
    });
    expect(result.missingRequiredKeys).toEqual(["DATABASE_URL"]); // PORT a un défaut légitime -> pas manquant
    const port = result.envVars.find((v) => v.key === "PORT");
    expect(port?.hasValue).toBe(true);
    const dbUrl = result.envVars.find((v) => v.key === "DATABASE_URL");
    expect(dbUrl?.hasValue).toBe(false);
    expect(dbUrl?.looksSensitive).toBe(true);
  });

  it("env_file référencé mais DÉJÀ présent dans le dépôt : rien à demander (jamais écrasé)", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { env_file: ".env" } } },
      envExampleDefaults: new Map([["DATABASE_URL", undefined]]),
      resolvedValues: {},
      envFileExists: async () => true,
    });
    expect(result.envVars).toEqual([]);
  });

  it("une clé déjà résolue par un secret stocké -> hasValue true, jamais dans missingRequiredKeys", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { env_file: ".env" } } },
      envExampleDefaults: new Map([["DATABASE_URL", undefined]]),
      resolvedValues: { DATABASE_URL: "postgres://déjà-résolu" },
      envFileExists: async () => false,
    });
    expect(result.missingRequiredKeys).toEqual([]);
    expect(result.envVars[0]?.hasValue).toBe(true);
  });

  it("clé 'environment:' littérale (valeur déjà dans le fichier) -> jamais remontée (rien à demander)", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { environment: { NODE_ENV: "production" } } } },
      envExampleDefaults: new Map(),
      resolvedValues: {},
      envFileExists: async () => false,
    });
    expect(result.envVars).toEqual([]);
  });

  it("ARG Dockerfile sans défaut -> requis, source dockerfile_arg", async () => {
    const result = await github.buildEnvRequirements({
      dockerfileContent: "FROM node:20\nARG BUILD_SECRET\n",
      envExampleDefaults: new Map(),
      resolvedValues: {},
      envFileExists: async () => false,
    });
    expect(result.missingRequiredKeys).toEqual(["BUILD_SECRET"]);
    expect(result.envVars[0]?.source).toBe("dockerfile_arg");
  });

  it("combine compose environment manquant ET ARG Dockerfile dans le même résultat", async () => {
    const result = await github.buildEnvRequirements({
      composeDoc: { services: { web: { environment: { API_TOKEN: null } } } },
      dockerfileContent: "ARG BUILD_ID\n",
      envExampleDefaults: new Map(),
      resolvedValues: {},
      envFileExists: async () => false,
    });
    expect(result.missingRequiredKeys.sort()).toEqual(["API_TOKEN", "BUILD_ID"]);
  });
});

describe("githubEnvSecretName — scope du secret au dépôt (github-env:<owner>/<repo>)", () => {
  it("minuscules, insensible à la casse d'entrée", () => {
    expect(github.githubEnvSecretName("Mairie-Creusot", "Formulaire_Hotline")).toBe("github-env:mairie-creusot/formulaire_hotline");
  });
});

describe("applyComposeHostPortOverrides — port hôte précis demandé par l'utilisateur", () => {
  it("réécrit le premier port du service ciblé", () => {
    const doc = { services: { web: { ports: ["3000:3000"] } } };
    github.applyComposeHostPortOverrides(doc, { web: 8080 });
    expect(doc.services.web.ports).toEqual(["8080:3000"]);
  });

  it("ignore silencieusement un service inconnu ou sans port déclaré", () => {
    const doc = { services: { web: { ports: ["3000:3000"] } } };
    github.applyComposeHostPortOverrides(doc, { db: 5432 });
    expect(doc.services.web.ports).toEqual(["3000:3000"]);
  });
});
