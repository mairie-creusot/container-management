/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SchemaForm, { type FormSchema } from "./SchemaForm";
import { formSchemaFromManifest } from "./formSchemaFromManifest";

// Même branchement que SchemaForm.test.tsx : ni `globals` ni jsdom par défaut dans ce paquet.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

interface ManifestFixture {
  configSchema: Record<string, unknown>;
  secretFields: string[];
}

/**
 * Manifeste RÉEL du greffon 3CX — copie de apps/api/src/plugins/threecx/index.ts, exactement ce que
 * GET /api/plugins renvoie. Il décrit le formulaire de features/threecx/ThreecxConfigSection.tsx :
 * libellés, aides, exemples et bascule de mode repris tels quels, rien n'est inventé.
 */
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

/** Manifeste RÉEL du greffon GLPI — copie de apps/api/src/plugins/glpi/index.ts. Il décrit le
 * formulaire de features/glpi/GlpiConfigSection.tsx : app_token toujours visible, bascule de mode
 * libellée en clair, identifiants de chaque mode conditionnels. */
const GLPI: ManifestFixture = {
  configSchema: {
    type: "object",
    properties: {
      apiUrl: {
        type: "string",
        title: "URL de l'API GLPI",
        examples: ["http://serveur-glpi/apirest.php"],
      },
      appToken: { type: "string", title: "app_token" },
      authMode: {
        type: "string",
        title: "Mode d'authentification",
        enum: ["user-token", "credentials"],
        enumLabels: ["Jeton utilisateur (user_token)", "Compte de service (login et mot de passe)"],
        default: "user-token",
      },
      userToken: {
        type: "string",
        title: "user_token",
        showIf: { field: "authMode", equals: "user-token" },
      },
      username: {
        type: "string",
        title: "Compte de service GLPI",
        showIf: { field: "authMode", equals: "credentials" },
      },
      password: {
        type: "string",
        title: "Mot de passe",
        showIf: { field: "authMode", equals: "credentials" },
      },
    },
    required: ["apiUrl", "appToken", "userToken", "username", "password"],
  },
  secretFields: ["appToken", "userToken", "password"],
};

/** Manifeste du formulaire RÉEL de features/certificates/CertificateAuthorityForm.tsx. */
const CERTIFICATES: ManifestFixture = {
  configSchema: {
    type: "object",
    properties: {
      caUrl: {
        type: "string",
        title: "URL du site d'inscription web (certsrv)",
        examples: ["https://ca.lecreusot.priv/certsrv"],
      },
      template: { type: "string", title: "Modèle de certificat", default: "WebServer" },
      accountSource: {
        type: "string",
        title: "Compte présenté à l'autorité",
        enum: ["directory", "dedicated"],
        default: "directory",
      },
      username: {
        type: "string",
        title: "Compte dédié (droit « Inscrire » sur le modèle)",
        examples: ["LECREUSOT\\svc-quai-pki"],
        showIf: { field: "accountSource", equals: "dedicated" },
      },
      password: {
        type: "string",
        title: "Mot de passe",
        showIf: { field: "accountSource", equals: "dedicated" },
      },
      renewBeforeDays: {
        type: "number",
        title: "Renouveler combien de jours avant expiration",
        minimum: 1,
        examples: [30],
      },
      autoEnroll: {
        type: "boolean",
        title: "Demander automatiquement un certificat pour chaque nouveau sous-domaine publié",
        default: true,
      },
    },
    required: ["caUrl", "template", "username", "password"],
  },
  secretFields: ["password"],
};

/**
 * Manifeste RÉEL du greffon Nutanix — copie de apps/api/src/plugins/nutanix/index.ts. Il décrit le
 * formulaire de features/clusters/NutanixConfigSection.tsx : trois champs, aucun mode, le mot de
 * passe déduit de secretFields.
 */
const NUTANIX: ManifestFixture = {
  configSchema: {
    type: "object",
    title: "Nutanix Prism Central",
    properties: {
      prismCentralUrl: {
        type: "string",
        title: "URL Prism Central",
        description: "Adresse de Prism Central, port compris — QUAI ajoute lui-même les chemins d'API (v3 et Prism Element v2.0).",
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

function adapt(fixture: ManifestFixture): FormSchema {
  const result = formSchemaFromManifest(fixture.configSchema, fixture.secretFields);
  if (!result.ok) throw new Error(`manifeste refusé : ${result.problems.join(" ; ")}`);
  return result.schema;
}

function refusal(configSchema: unknown, secretFields: unknown = []): string[] {
  const result = formSchemaFromManifest(configSchema, secretFields);
  expect(result.ok, "conversion acceptée alors qu'un refus était attendu").toBe(false);
  return result.ok ? [] : result.problems;
}

function input(matcher: RegExp | string): HTMLInputElement {
  return screen.getByLabelText(matcher) as HTMLInputElement;
}

/** Schéma d'objet minimal, à tordre propriété par propriété dans les tests de refus. */
function schemaWith(properties: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "object", properties, ...extra };
}

describe("adaptateur — 3CX", () => {
  it("produit les champs du formulaire réel, dans l'ordre du schéma", () => {
    const schema = adapt(THREECX);
    expect(schema.fields.map((field) => field.name)).toEqual([
      "baseUrl",
      "authMode",
      "clientId",
      "clientSecret",
      "username",
      "password",
      "tlsRejectUnauthorized",
    ]);
    expect(schema.fields.map((field) => field.type)).toEqual([
      "string",
      "enum",
      "string",
      "string",
      "string",
      "string",
      "boolean",
    ]);

    const [baseUrl, authMode, , clientSecret] = schema.fields;
    expect(baseUrl).toMatchObject({ label: "URL de base du PBX", required: true, placeholder: "https://pbx.exemple.fr:5001" });
    // enumLabels : le choix s'affiche en clair, jamais la valeur brute « client-credentials ».
    expect(authMode).toMatchObject({
      type: "enum",
      default: "client-credentials",
      options: [
        { value: "client-credentials", label: "ClientID et clé API (point de routage)" },
        { value: "user", label: "Identifiant et mot de passe (extension propriétaire système)" },
      ],
    });
    // Secret déduit de secretFields, jamais du schéma : format password et aucune valeur transportée.
    expect(clientSecret).toEqual({
      name: "clientSecret",
      label: "Clé API",
      type: "string",
      format: "password",
      required: true,
      showIf: { field: "authMode", equals: "client-credentials" },
    });
  });

  it("rend la bascule jeton / compte de service comme le formulaire d'origine", () => {
    render(<SchemaForm schema={adapt(THREECX)} onSubmit={() => undefined} />);

    expect(input("URL de base du PBX").required).toBe(true);
    expect(input("ClientID — DN du point de routage")).toBeTruthy();
    expect(input("Clé API").getAttribute("type")).toBe("password");
    expect(screen.queryByLabelText("Identifiant (extension avec droits propriétaire système)")).toBeNull();
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
    expect(input(/Vérifier le certificat TLS du PBX/).checked).toBe(true);

    const mode = screen.getByLabelText("Comment QUAI s'authentifie auprès du PBX");
    expect([...mode.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "ClientID et clé API (point de routage)",
      "Identifiant et mot de passe (extension propriétaire système)",
    ]);

    fireEvent.change(mode, { target: { value: "user" } });

    expect(screen.queryByLabelText("ClientID — DN du point de routage")).toBeNull();
    expect(screen.queryByLabelText("Clé API")).toBeNull();
    expect(input("Identifiant (extension avec droits propriétaire système)")).toBeTruthy();
    expect(input("Mot de passe").getAttribute("type")).toBe("password");
  });
});

describe("adaptateur — GLPI", () => {
  it("garde l'app_token toujours visible et n'affiche que les champs du mode choisi", () => {
    const schema = adapt(GLPI);
    expect(schema.fields.map((field) => field.name)).toEqual([
      "apiUrl",
      "appToken",
      "authMode",
      "userToken",
      "username",
      "password",
    ]);
    expect(schema.fields.filter((field) => field.showIf !== undefined).map((field) => field.name)).toEqual([
      "userToken",
      "username",
      "password",
    ]);

    render(<SchemaForm schema={schema} onSubmit={() => undefined} />);

    expect(input("app_token").getAttribute("type")).toBe("password");
    expect(input("user_token").getAttribute("type")).toBe("password");
    expect(screen.queryByLabelText("Compte de service GLPI")).toBeNull();

    fireEvent.change(screen.getByLabelText("Mode d'authentification"), { target: { value: "credentials" } });

    expect(screen.queryByLabelText("user_token")).toBeNull();
    expect(input("Compte de service GLPI")).toBeTruthy();
    expect(input("Mot de passe").getAttribute("type")).toBe("password");
    // app_token ne dépend d'aucun mode : il reste là dans les deux cas.
    expect(input("app_token")).toBeTruthy();
  });

  it("affiche les modes d'authentification en clair, jamais la valeur brute", () => {
    render(<SchemaForm schema={adapt(GLPI)} onSubmit={() => undefined} />);
    const options = [...(screen.getByLabelText("Mode d'authentification") as HTMLSelectElement).options];
    expect(options.map((option) => option.value)).toEqual(["user-token", "credentials"]);
    expect(options.map((option) => option.textContent)).toEqual([
      "Jeton utilisateur (user_token)",
      "Compte de service (login et mot de passe)",
    ]);
  });

  it("faute de libellé d'option dans le manifeste, la valeur d'énumération sert de libellé", () => {
    const properties = GLPI.configSchema.properties as Record<string, unknown>;
    const sansLibelles: ManifestFixture = {
      ...GLPI,
      configSchema: {
        ...GLPI.configSchema,
        properties: {
          ...properties,
          authMode: { type: "string", title: "Mode d'authentification", enum: ["user-token", "credentials"], default: "user-token" },
        },
      },
    };
    render(<SchemaForm schema={adapt(sansLibelles)} onSubmit={() => undefined} />);
    const options = [...(screen.getByLabelText("Mode d'authentification") as HTMLSelectElement).options];
    expect(options.map((option) => option.textContent)).toEqual(["user-token", "credentials"]);
  });
});

describe("adaptateur — AD CS", () => {
  it("produit le nombre borné, la case à cocher et les champs du compte dédié", () => {
    const schema = adapt(CERTIFICATES);
    expect(schema.fields.map((field) => field.name)).toEqual([
      "caUrl",
      "template",
      "accountSource",
      "username",
      "password",
      "renewBeforeDays",
      "autoEnroll",
    ]);

    render(<SchemaForm schema={schema} onSubmit={() => undefined} />);

    expect(input("Modèle de certificat").value).toBe("WebServer");
    const renew = input("Renouveler combien de jours avant expiration");
    expect(renew.getAttribute("type")).toBe("number");
    expect(renew.getAttribute("min")).toBe("1");
    expect(renew.getAttribute("placeholder")).toBe("30");
    expect(input("Demander automatiquement un certificat pour chaque nouveau sous-domaine publié").checked).toBe(true);

    expect(screen.queryByLabelText("Compte dédié (droit « Inscrire » sur le modèle)")).toBeNull();
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();

    fireEvent.change(screen.getByLabelText("Compte présenté à l'autorité"), { target: { value: "dedicated" } });

    const dedicated = input("Compte dédié (droit « Inscrire » sur le modèle)");
    expect(dedicated.required).toBe(true);
    expect(dedicated.getAttribute("placeholder")).toBe("LECREUSOT\\svc-quai-pki");
    expect(input("Mot de passe").getAttribute("type")).toBe("password");
  });
});

describe("adaptateur — Nutanix", () => {
  it("produit les trois champs du formulaire réel, mot de passe masqué et requis", () => {
    const schema = adapt(NUTANIX);
    expect(schema.fields.map((field) => field.name)).toEqual(["prismCentralUrl", "username", "password"]);
    expect(schema.fields.map((field) => field.type)).toEqual(["string", "string", "string"]);

    const [prismCentralUrl, , password] = schema.fields;
    expect(prismCentralUrl).toMatchObject({
      label: "URL Prism Central",
      required: true,
      placeholder: "https://prism.lecreusot.fr:9440",
    });
    expect(password).toEqual({
      name: "password",
      label: "Mot de passe",
      help: "Laisser vide lors d'une modification conserve le mot de passe déjà enregistré.",
      type: "string",
      format: "password",
      required: true,
    });
  });

  it("rend le formulaire d'origine : aucun champ conditionnel, aucune valeur pré-remplie", () => {
    render(<SchemaForm schema={adapt(NUTANIX)} onSubmit={() => undefined} />);

    expect(input("URL Prism Central").required).toBe(true);
    expect(input("Utilisateur").required).toBe(true);
    expect(input("Mot de passe").getAttribute("type")).toBe("password");
    expect(input("Mot de passe").value).toBe("");
  });
});

describe("adaptateur — refus explicites", () => {
  it("refuse un schéma qui n'est pas un objet, ou sans propriété", () => {
    expect(refusal({ type: "string" }).join(" ")).toContain('"type": "object"');
    expect(refusal(schemaWith({})).join(" ")).toContain("aucune propriété");
  });

  it("refuse une propriété imbriquée, un tableau et un type absent", () => {
    expect(refusal(schemaWith({ proxy: { type: "object", properties: { host: { type: "string" } } } })).join(" ")).toContain(
      "« object »",
    );
    expect(refusal(schemaWith({ hosts: { type: "array", items: { type: "string" } } })).join(" ")).toContain("« array »");
    expect(refusal(schemaWith({ baseUrl: { title: "URL" } })).join(" ")).toContain("« type » manquant");
  });

  it("refuse ce que le formulaire ne saurait pas faire respecter", () => {
    expect(refusal(schemaWith({ jours: { type: "integer" } })).join(" ")).toContain("integer");
    expect(refusal(schemaWith({ code: { type: "string", pattern: "^[A-Z]+$" } })).join(" ")).toContain("pattern");
    expect(refusal(schemaWith({ code: { type: "string", maxLength: 12 } })).join(" ")).toContain("maxLength");
    expect(refusal(schemaWith({ code: { type: "string", minLength: 8 } })).join(" ")).toContain("minLength");
    expect(refusal(schemaWith({ mode: { type: "string", const: "fixe" } })).join(" ")).toContain("const");
    expect(refusal(schemaWith({ port: { type: "string", minimum: 1 } })).join(" ")).toContain("number");
  });

  it("accepte minLength 1 sur un champ requis, le refuse sur un champ facultatif", () => {
    const properties = { label: { type: "string", title: "Étiquette", minLength: 1 } };
    expect(formSchemaFromManifest(schemaWith(properties, { required: ["label"] }), []).ok).toBe(true);
    expect(refusal(schemaWith(properties)).join(" ")).toContain("configSchema.required");
  });

  it("refuse un mot-clé inconnu plutôt que de l'ignorer silencieusement", () => {
    const problems = refusal(schemaWith({ mode: { type: "string", writeOnly: true } }));
    expect(problems.join(" ")).toContain("writeOnly");
  });

  it("libelle les options depuis enumLabels, et refuse une correspondance incomplète", () => {
    const schema = adapt({
      configSchema: schemaWith({ mode: { type: "string", enum: ["user-token", "credentials"], enumLabels: ["Jeton utilisateur", "Compte de service"] } }),
      secretFields: [],
    });
    const field = schema.fields[0];
    expect(field?.type === "enum" ? field.options : []).toEqual([
      { value: "user-token", label: "Jeton utilisateur" },
      { value: "credentials", label: "Compte de service" },
    ]);
    // Sans libellés, la valeur brute fait office de libellé — jamais un libellé inventé.
    const brut = adapt({ configSchema: schemaWith({ mode: { type: "string", enum: ["a"] } }), secretFields: [] }).fields[0];
    expect(brut?.type === "enum" ? brut.options : []).toEqual([{ value: "a", label: "a" }]);
    expect(refusal(schemaWith({ mode: { type: "string", enum: ["a", "b"], enumLabels: ["A"] } })).join(" ")).toContain("libellés");
  });

  it("refuse un secret qui n'est pas un texte, un champ password hors secretFields et un secret inconnu", () => {
    expect(refusal(schemaWith({ port: { type: "number" } }), ["port"]).join(" ")).toContain("« string »");
    expect(refusal(schemaWith({ token: { type: "string", format: "password" } })).join(" ")).toContain("secretFields");
    expect(refusal(schemaWith({ token: { type: "string" } }), ["proxy.token"]).join(" ")).toContain("imbriqué");
  });

  it("refuse une case à cocher déclarée requise", () => {
    const schema = schemaWith({ tls: { type: "boolean", title: "TLS" } }, { required: ["tls"] });
    expect(refusal(schema).join(" ")).toContain("case à cocher");
  });

  it("refuse une condition incohérente, exactement comme le formulaire", () => {
    const chained = schemaWith({
      mode: { type: "string", title: "Mode", enum: ["a", "b"], default: "a" },
      premier: { type: "string", title: "Premier", showIf: { field: "mode", equals: "a" } },
      second: { type: "string", title: "Second", showIf: { field: "premier", equals: "x" } },
    });
    expect(refusal(chained).join(" ")).toContain("chaîne");

    const unknownTarget = schemaWith({ token: { type: "string", title: "Jeton", showIf: { field: "absent", equals: "a" } } });
    expect(refusal(unknownTarget).join(" ")).toContain("absent");

    const wrongValue = schemaWith({
      mode: { type: "string", title: "Mode", enum: ["a", "b"], default: "a" },
      token: { type: "string", title: "Jeton", showIf: { field: "mode", equals: "c" } },
    });
    expect(refusal(wrongValue).join(" ")).toContain("option déclarée");
  });

  it("liste TOUS les motifs d'un coup plutôt que le premier", () => {
    const problems = refusal(schemaWith({ a: { type: "array" }, b: { type: "integer" } }));
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
