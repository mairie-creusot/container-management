import { describe, expect, it } from "vitest";
import { formSchemaFromManifest } from "@/components/formSchemaFromManifest";
import type { SchemaField } from "@/components/SchemaForm";
import {
  initialValuesFrom,
  normalizePluginConfigPayload,
  normalizePluginTestPayload,
  presenceFlagName,
  storedSecretsFrom,
  visibleInStoredConfig,
} from "@/features/plugins/pluginConfigModel";

interface ManifestFixture {
  configSchema: Record<string, unknown>;
  secretFields: string[];
}

/* Manifestes RÉELS des quatre greffons — copies de apps/api/src/plugins/<id>/index.ts, exactement
   ce que GET /api/plugins renvoie. Rien n'est simplifié : c'est de là que sortent les formulaires. */

const NUTANIX: ManifestFixture = {
  configSchema: {
    type: "object",
    title: "Nutanix Prism Central",
    properties: {
      prismCentralUrl: {
        type: "string",
        title: "URL Prism Central",
        description:
          "Adresse de Prism Central, port compris — QUAI ajoute lui-même les chemins d'API (v3 et Prism Element v2.0).",
        examples: ["https://prism.lecreusot.fr:9440"],
      },
      username: {
        type: "string",
        title: "Utilisateur",
        description: "Compte Prism Central utilisé pour toutes les requêtes, lectures comme actions sur les VMs.",
      },
      password: {
        type: "string",
        title: "Mot de passe",
        description: "Laisser vide lors d'une modification conserve le mot de passe déjà enregistré.",
      },
    },
    required: ["prismCentralUrl", "username", "password"],
    additionalProperties: false,
  },
  secretFields: ["password"],
};

const HYCU: ManifestFixture = {
  configSchema: {
    type: "object",
    title: "Contrôleur de sauvegarde (HYCU)",
    properties: {
      url: {
        type: "string",
        title: "URL du contrôleur HYCU",
        description: "Adresse de l'API REST du contrôleur — QUAI ajoute lui-même le préfixe /rest/v1.0.",
        examples: ["https://172.20.0.100:8443"],
      },
      username: {
        type: "string",
        title: "Utilisateur",
        description: "Compte HYCU en lecture : QUAI n'émet que des GET, aucune sauvegarde ni restauration.",
      },
      password: { type: "string", title: "Mot de passe" },
    },
    required: ["url", "username", "password"],
    additionalProperties: false,
  },
  secretFields: ["password"],
};

const THREECX: ManifestFixture = {
  configSchema: {
    type: "object",
    title: "PBX 3CX",
    properties: {
      baseUrl: {
        type: "string",
        title: "URL de base du PBX",
        description:
          "Adresse du PBX sans le suffixe /xapi/v1 — QUAI l'ajoute lui-même, ainsi que le chemin d'authentification.",
        examples: ["https://pbx.exemple.fr:5001"],
      },
      authMode: {
        type: "string",
        title: "Comment QUAI s'authentifie auprès du PBX",
        enum: ["client-credentials", "user"],
        enumLabels: [
          "ClientID et clé API (point de routage)",
          "Identifiant et mot de passe (extension propriétaire système)",
        ],
        default: "client-credentials",
      },
      clientId: {
        type: "string",
        title: "ClientID — DN du point de routage",
        description:
          "Point de routage créé dans Admin Console → Integrations > API, option « XAPI Access Enabled » activée.",
        showIf: { field: "authMode", equals: "client-credentials" },
      },
      clientSecret: {
        type: "string",
        title: "Clé API",
        showIf: { field: "authMode", equals: "client-credentials" },
      },
      username: {
        type: "string",
        title: "Identifiant (extension avec droits propriétaire système)",
        description:
          "Extension du PBX disposant des droits d'administration système : sans eux, le jeton est délivré mais le XAPI refuse les requêtes.",
        showIf: { field: "authMode", equals: "user" },
      },
      password: {
        type: "string",
        title: "Mot de passe",
        showIf: { field: "authMode", equals: "user" },
      },
      tlsRejectUnauthorized: {
        type: "boolean",
        title: "Vérifier le certificat TLS du PBX",
        description:
          "À laisser activé : un 3CX publié sous son FQDN présente un certificat valide. Ne le désactivez que pour un PBX joint par une adresse interne avec un certificat auto-signé.",
        default: true,
      },
    },
    required: ["baseUrl", "clientId", "clientSecret", "username", "password"],
    additionalProperties: false,
  },
  secretFields: ["clientSecret", "password"],
};

const GLPI: ManifestFixture = {
  configSchema: {
    type: "object",
    title: "Assistance GLPI",
    properties: {
      apiUrl: {
        type: "string",
        title: "URL de l'API GLPI",
        description:
          "L'URL doit contenir « apirest.php » : sans ce suffixe la requête tombe sur la racine web de GLPI, qui répond 403.",
        examples: ["http://serveur-glpi/apirest.php"],
      },
      appToken: {
        type: "string",
        title: "app_token",
        description:
          "Jeton d'application de l'instance GLPI — toujours requis, quel que soit le mode d'authentification.",
      },
      authMode: {
        type: "string",
        title: "Mode d'authentification",
        description:
          "Les deux modes sont acceptés par GLPI. Un jeton utilisateur déjà enregistré garde la priorité sur un compte de service saisi ensuite.",
        enum: ["user-token", "credentials"],
        enumLabels: ["Jeton utilisateur (user_token)", "Compte de service (login et mot de passe)"],
        default: "user-token",
      },
      userToken: { type: "string", title: "user_token", showIf: { field: "authMode", equals: "user-token" } },
      username: {
        type: "string",
        title: "Compte de service GLPI",
        showIf: { field: "authMode", equals: "credentials" },
      },
      password: { type: "string", title: "Mot de passe", showIf: { field: "authMode", equals: "credentials" } },
    },
    required: ["apiUrl", "appToken", "userToken", "username", "password"],
    additionalProperties: false,
  },
  secretFields: ["appToken", "userToken", "password"],
};

function convert(fixture: ManifestFixture): SchemaField[] {
  const result = formSchemaFromManifest(fixture.configSchema, fixture.secretFields);
  if (!result.ok) throw new Error(`Manifeste non convertible : ${result.problems.join(" | ")}`);
  return result.schema.fields;
}

function labelOf(fields: SchemaField[], name: string): string | undefined {
  return fields.find((field) => field.name === name)?.label;
}

function secretNames(fields: SchemaField[]): string[] {
  return fields.filter((field) => field.type === "string" && field.format === "password").map((field) => field.name);
}

describe("manifeste → formulaire : les quatre greffons réels", () => {
  it("Nutanix : les trois champs du formulaire, mot de passe en secret", () => {
    const fields = convert(NUTANIX);
    expect(fields.map((field) => field.name)).toEqual(["prismCentralUrl", "username", "password"]);
    expect(labelOf(fields, "prismCentralUrl")).toBe("URL Prism Central");
    expect(secretNames(fields)).toEqual(["password"]);
    expect(fields.every((field) => field.required === true)).toBe(true);
  });

  it("HYCU : les trois champs du formulaire, mot de passe en secret", () => {
    const fields = convert(HYCU);
    expect(fields.map((field) => field.name)).toEqual(["url", "username", "password"]);
    expect(labelOf(fields, "url")).toBe("URL du contrôleur HYCU");
    expect(secretNames(fields)).toEqual(["password"]);
  });

  it("3CX : la bascule de mode, ses deux couples d'identifiants et la case TLS", () => {
    const fields = convert(THREECX);
    expect(fields.map((field) => field.name)).toEqual([
      "baseUrl",
      "authMode",
      "clientId",
      "clientSecret",
      "username",
      "password",
      "tlsRejectUnauthorized",
    ]);
    expect(secretNames(fields)).toEqual(["clientSecret", "password"]);
    const mode = fields.find((field) => field.name === "authMode");
    expect(mode !== undefined && mode.type === "enum" ? mode.options.map((option) => option.label) : []).toEqual([
      "ClientID et clé API (point de routage)",
      "Identifiant et mot de passe (extension propriétaire système)",
    ]);
    const tls = fields.find((field) => field.name === "tlsRejectUnauthorized");
    expect(tls !== undefined && tls.type === "boolean" ? tls.default : null).toBe(true);
  });

  it("GLPI : app_token toujours visible, identifiants conditionnés au mode", () => {
    const fields = convert(GLPI);
    expect(fields.map((field) => field.name)).toEqual([
      "apiUrl",
      "appToken",
      "authMode",
      "userToken",
      "username",
      "password",
    ]);
    expect(secretNames(fields)).toEqual(["appToken", "userToken", "password"]);
    expect(fields.find((field) => field.name === "appToken")?.showIf).toBeUndefined();
    expect(fields.find((field) => field.name === "userToken")?.showIf).toEqual({
      field: "authMode",
      equals: "user-token",
    });
  });
});

describe("storedSecretsFrom — les booléens hasX de la vue sûre", () => {
  it("le nom du drapeau est celui du serveur (setupStore#presenceFlagName)", () => {
    expect(presenceFlagName("password")).toBe("hasPassword");
    expect(presenceFlagName("appToken")).toBe("hasAppToken");
    expect(presenceFlagName("clientSecret")).toBe("hasClientSecret");
  });

  it("GLPI : seuls les secrets réellement enregistrés sont annoncés comme conservables", () => {
    const config = { apiUrl: "http://glpi/apirest.php", authMode: "user-token", hasAppToken: true, hasUserToken: true };
    expect(storedSecretsFrom(GLPI.secretFields, config)).toEqual(["appToken", "userToken"]);
  });

  it("un drapeau absent ou faux ne promet aucun secret", () => {
    expect(storedSecretsFrom(["password"], { hasPassword: false })).toEqual([]);
    expect(storedSecretsFrom(["password"], {})).toEqual([]);
    expect(storedSecretsFrom(["password"], { hasPassword: "oui" })).toEqual([]);
  });

  it("une valeur de secret qui traînerait dans la configuration n'en fait pas un secret enregistré", () => {
    expect(storedSecretsFrom(["password"], { password: "hunter2" })).toEqual([]);
  });
});

describe("initialValuesFrom — ce que le formulaire réaffiche", () => {
  it("3CX : URL, mode et case TLS repris, aucun secret pré-rempli", () => {
    const fields = convert(THREECX);
    const values = initialValuesFrom(fields, {
      baseUrl: "https://pbx.exemple.fr:5001",
      authMode: "user",
      username: "sysadmin",
      hasPassword: true,
      tlsRejectUnauthorized: false,
    });
    expect(values).toEqual({
      baseUrl: "https://pbx.exemple.fr:5001",
      authMode: "user",
      username: "sysadmin",
      tlsRejectUnauthorized: false,
    });
    expect(values["password"]).toBeUndefined();
    expect(values["clientSecret"]).toBeUndefined();
  });

  it("un secret laissé en clair dans la configuration n'est jamais repris", () => {
    const fields = convert(NUTANIX);
    const values = initialValuesFrom(fields, { prismCentralUrl: "https://prism:9440", password: "hunter2" });
    expect(values).toEqual({ prismCentralUrl: "https://prism:9440" });
  });

  it("une valeur du mauvais type est ignorée plutôt que convertie de force", () => {
    const fields = convert(HYCU);
    expect(initialValuesFrom(fields, { url: 8443, username: null })).toEqual({});
  });
});

describe("visibleInStoredConfig — récapitulatif du mode réellement enregistré", () => {
  it("GLPI en mode jeton : les champs du compte de service n'y figurent pas", () => {
    const fields = convert(GLPI);
    const config = { apiUrl: "http://glpi/apirest.php", authMode: "user-token" };
    const shown = fields.filter((field) => visibleInStoredConfig(field, config)).map((field) => field.name);
    expect(shown).toEqual(["apiUrl", "appToken", "authMode", "userToken"]);
  });

  it("3CX en mode ClientID : ni identifiant ni mot de passe d'extension", () => {
    const fields = convert(THREECX);
    const config = { baseUrl: "https://pbx:5001", authMode: "client-credentials" };
    const shown = fields.filter((field) => visibleInStoredConfig(field, config)).map((field) => field.name);
    expect(shown).toEqual(["baseUrl", "authMode", "clientId", "clientSecret", "tlsRejectUnauthorized"]);
  });
});

describe("normalisation des réponses des routes génériques", () => {
  it("la vue sûre est reprise telle quelle", () => {
    expect(
      normalizePluginConfigPayload({ configured: true, enabled: false, config: { url: "https://hycu", hasPassword: true } }),
    ).toEqual({ configured: true, enabled: false, config: { url: "https://hycu", hasPassword: true } });
  });

  it("un corps sans `configured` est inexploitable : null, jamais un état supposé", () => {
    expect(normalizePluginConfigPayload({ enabled: true, config: {} })).toBeNull();
    expect(normalizePluginConfigPayload(null)).toBeNull();
    expect(normalizePluginConfigPayload({ error: "Greffon inconnu" })).toBeNull();
  });

  it("`config` manquante vaut une configuration vide, pas une configuration inventée", () => {
    expect(normalizePluginConfigPayload({ configured: false, enabled: true })?.config).toEqual({});
  });

  it("résultat de test : { ok, message } ou rien", () => {
    expect(normalizePluginTestPayload({ ok: true, message: "PBX joint" })).toEqual({ ok: true, message: "PBX joint" });
    expect(normalizePluginTestPayload({ ok: false })).toEqual({ ok: false, message: "" });
    expect(normalizePluginTestPayload({ message: "?" })).toBeNull();
  });
});
