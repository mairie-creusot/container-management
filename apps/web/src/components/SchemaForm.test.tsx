/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SchemaForm, {
  buildSubmission,
  redactSecrets,
  validateSchema,
  type FormSchema,
  type SchemaValues,
} from "./SchemaForm";

// La configuration de test du web n'active ni `globals` ni jsdom par défaut : l'environnement est
// choisi par le docblock ci-dessus, et l'auto-nettoyage de @testing-library doit être branché ici.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

/** Décalque du vrai formulaire 3CX : bascule jeton / compte de service, un secret par mode. */
const THREECX_LIKE: FormSchema = {
  fields: [
    {
      name: "baseUrl",
      type: "string",
      label: "URL de base du PBX",
      required: true,
      placeholder: "https://pbx.exemple.fr:5001",
    },
    {
      name: "authMode",
      type: "enum",
      label: "Mode d'authentification",
      default: "client-credentials",
      options: [
        { value: "client-credentials", label: "ClientID et clé API" },
        { value: "user", label: "Identifiant et mot de passe" },
      ],
    },
    {
      name: "clientId",
      type: "string",
      label: "ClientID",
      required: true,
      showIf: { field: "authMode", equals: "client-credentials" },
    },
    {
      name: "clientSecret",
      type: "string",
      format: "password",
      label: "Clé API",
      required: true,
      showIf: { field: "authMode", equals: "client-credentials" },
    },
    {
      name: "username",
      type: "string",
      label: "Identifiant",
      required: true,
      showIf: { field: "authMode", equals: "user" },
    },
    {
      name: "password",
      type: "string",
      format: "password",
      label: "Mot de passe",
      required: true,
      showIf: { field: "authMode", equals: "user" },
    },
    { name: "tlsRejectUnauthorized", type: "boolean", label: "Vérifier le certificat TLS du PBX", default: true },
  ],
};

/** Décalque du vrai formulaire AD CS : un nombre borné, une case à cocher, un secret optionnel. */
const CERTIFICATES_LIKE: FormSchema = {
  fields: [
    { name: "caUrl", type: "string", label: "URL du site d'inscription web", required: true },
    {
      name: "renewBeforeDays",
      type: "number",
      label: "Renouveler combien de jours avant expiration",
      default: 30,
      min: 1,
      max: 365,
      help: "Marge appliquée avant la date d'expiration du certificat.",
    },
    { name: "autoEnroll", type: "boolean", label: "Émission automatique des sous-domaines", default: true },
    {
      name: "accountSource",
      type: "enum",
      label: "Compte présenté à l'autorité",
      default: "directory",
      options: [
        { value: "directory", label: "Compte de l'annuaire" },
        { value: "dedicated", label: "Compte dédié" },
      ],
    },
    { name: "password", type: "string", format: "password", label: "Mot de passe du compte dédié" },
  ],
};

function collector() {
  const calls: SchemaValues[] = [];
  return { calls, handler: (values: SchemaValues) => void calls.push(values) };
}

function formOf(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector("form");
  if (!form) throw new Error("aucun formulaire rendu");
  return form;
}

function input(matcher: RegExp | string): HTMLInputElement {
  return screen.getByLabelText(matcher) as HTMLInputElement;
}

describe("SchemaForm — rendu des types de champs supportés", () => {
  it("rend un contrôle adapté pour string, number, boolean, enum et le format password", () => {
    const { calls, handler } = collector();
    render(<SchemaForm schema={CERTIFICATES_LIKE} onSubmit={handler} />);
    expect(calls).toHaveLength(0);

    const text = input("URL du site d'inscription web");
    expect(text.tagName).toBe("INPUT");
    expect(text.getAttribute("type")).toBeNull();
    expect(text.required).toBe(true);

    const number = input("Renouveler combien de jours avant expiration");
    expect(number.getAttribute("type")).toBe("number");
    expect(number.getAttribute("min")).toBe("1");
    expect(number.getAttribute("max")).toBe("365");
    expect(number.value).toBe("30");

    const checkbox = input("Émission automatique des sous-domaines");
    expect(checkbox.getAttribute("type")).toBe("checkbox");
    expect(checkbox.checked).toBe(true);

    const select = screen.getByLabelText("Compte présenté à l'autorité") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("directory");
    expect(select.querySelectorAll("option")).toHaveLength(2);

    const secret = input("Mot de passe du compte dédié");
    expect(secret.getAttribute("type")).toBe("password");
    expect(secret.getAttribute("autocomplete")).toBe("new-password");

    expect(screen.getByText("Marge appliquée avant la date d'expiration du certificat.")).toBeTruthy();
  });

  it("un enum sans valeur par défaut propose un choix vide plutôt qu'une sélection inventée", () => {
    const schema: FormSchema = {
      fields: [
        {
          name: "transport",
          type: "enum",
          label: "Transport",
          required: true,
          options: [
            { value: "tcp", label: "TCP + TLS" },
            { value: "ssh", label: "SSH" },
          ],
        },
      ],
    };
    const { handler } = collector();
    render(<SchemaForm schema={schema} onSubmit={handler} />);

    const select = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.querySelectorAll("option")).toHaveLength(3);
    expect((screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SchemaForm — champ conditionnel", () => {
  it("n'affiche les champs d'un mode que lorsque ce mode est choisi (bascule 3CX jeton / compte)", () => {
    const { handler } = collector();
    render(<SchemaForm schema={THREECX_LIKE} onSubmit={handler} />);

    expect(screen.getByLabelText("ClientID")).toBeTruthy();
    expect(screen.getByLabelText("Clé API")).toBeTruthy();
    expect(screen.queryByLabelText("Identifiant")).toBeNull();
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();

    fireEvent.change(screen.getByLabelText("Mode d'authentification"), { target: { value: "user" } });

    expect(screen.queryByLabelText("ClientID")).toBeNull();
    expect(screen.queryByLabelText("Clé API")).toBeNull();
    expect(screen.getByLabelText("Identifiant")).toBeTruthy();
    expect(screen.getByLabelText("Mot de passe")).toBeTruthy();
  });

  it("ne soumet jamais les champs du mode masqué, et efface le secret de l'autre mode", async () => {
    const { calls, handler } = collector();
    const { container } = render(<SchemaForm schema={THREECX_LIKE} onSubmit={handler} />);

    fireEvent.change(input("URL de base du PBX"), { target: { value: "https://pbx.exemple.fr:5001" } });
    fireEvent.change(input("ClientID"), { target: { value: "quai-routing-point" } });
    fireEvent.change(input("Clé API"), { target: { value: "cle-api-3cx" } });

    fireEvent.change(screen.getByLabelText("Mode d'authentification"), { target: { value: "user" } });
    fireEvent.change(input("Identifiant"), { target: { value: "1000" } });
    fireEvent.change(input("Mot de passe"), { target: { value: "motdepasse-extension" } });

    fireEvent.submit(formOf(container));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toEqual({
      baseUrl: "https://pbx.exemple.fr:5001",
      authMode: "user",
      username: "1000",
      password: "motdepasse-extension",
      tlsRejectUnauthorized: true,
    });

    // Retour au mode ClientID : la clé API saisie plus tôt ne traîne plus dans le champ.
    fireEvent.change(screen.getByLabelText("Mode d'authentification"), { target: { value: "client-credentials" } });
    expect(input("Clé API").value).toBe("");
    expect(input("ClientID").value).toBe("quai-routing-point");
  });
});

describe("SchemaForm — secrets", () => {
  it("ne pré-remplit jamais un secret, même si le parent en fournit un dans initialValues", () => {
    const { handler } = collector();
    render(
      <SchemaForm
        schema={THREECX_LIKE}
        onSubmit={handler}
        initialValues={{ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-rp", clientSecret: "NE-DOIT-PAS-FUITER" }}
        storedSecrets={["clientSecret"]}
      />,
    );

    expect(input(/^Clé API/).value).toBe("");
    expect(document.body.textContent).not.toContain("NE-DOIT-PAS-FUITER");
    expect(input("ClientID").value).toBe("quai-rp");
  });

  it("dit que le champ vide conserve la valeur enregistrée, et omet la clé de la soumission", async () => {
    const { calls, handler } = collector();
    const { container } = render(
      <SchemaForm
        schema={THREECX_LIKE}
        onSubmit={handler}
        initialValues={{ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-rp" }}
        storedSecrets={["clientSecret"]}
      />,
    );

    expect(screen.getByText(/Clé API \(laisser vide pour conserver l'existant\)/)).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.submit(formOf(container));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).not.toHaveProperty("clientSecret");
    expect(calls[0]).toEqual({
      baseUrl: "https://pbx.exemple.fr:5001",
      authMode: "client-credentials",
      clientId: "quai-rp",
      tlsRejectUnauthorized: true,
    });
  });

  it("sans secret enregistré, le champ secret reste obligatoire et bloque l'enregistrement", () => {
    const { handler } = collector();
    render(
      <SchemaForm
        schema={THREECX_LIKE}
        onSubmit={handler}
        initialValues={{ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-rp" }}
      />,
    );

    expect(screen.queryByText(/laisser vide pour conserver l'existant/)).toBeNull();
    expect(input("Clé API").hasAttribute("required")).toBe(true);
    expect((screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("efface les secrets saisis une fois l'enregistrement accepté", async () => {
    const { calls, handler } = collector();
    const { container } = render(
      <SchemaForm
        schema={THREECX_LIKE}
        onSubmit={handler}
        initialValues={{ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-rp" }}
      />,
    );

    fireEvent.change(input("Clé API"), { target: { value: "cle-api-3cx" } });
    fireEvent.submit(formOf(container));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(input(/^Clé API/).value).toBe(""));
  });

  it("aucun secret saisi ne subsiste dans le message d'erreur affiché", () => {
    const { handler } = collector();
    render(
      <SchemaForm
        schema={THREECX_LIKE}
        onSubmit={handler}
        error={"Le PBX a refusé la clé API cle-api-3cx (401)."}
        initialValues={{ baseUrl: "https://pbx.exemple.fr:5001", clientId: "quai-rp" }}
      />,
    );

    fireEvent.change(input("Clé API"), { target: { value: "cle-api-3cx" } });
    const banner = screen.getByRole("alert");
    expect(banner.textContent).not.toContain("cle-api-3cx");
    expect(banner.textContent).toContain("•••");
  });
});

describe("SchemaForm — champs requis", () => {
  it("garde l'enregistrement inactif tant qu'un champ requis visible manque", () => {
    const { calls, handler } = collector();
    const { container } = render(<SchemaForm schema={THREECX_LIKE} onSubmit={handler} />);

    const submit = screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/Champs à renseigner avant d'enregistrer/).textContent).toContain("URL de base du PBX");

    // Même en forçant la soumission, rien n'est envoyé.
    fireEvent.submit(formOf(container));
    expect(calls).toHaveLength(0);

    fireEvent.change(input("URL de base du PBX"), { target: { value: "https://pbx.exemple.fr:5001" } });
    fireEvent.change(input("ClientID"), { target: { value: "quai-rp" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(input("Clé API"), { target: { value: "cle-api-3cx" } });
    expect(submit.disabled).toBe(false);
  });

  it("un nombre hors des bornes déclarées bloque aussi l'enregistrement", () => {
    const { handler } = collector();
    render(<SchemaForm schema={CERTIFICATES_LIKE} onSubmit={handler} />);

    fireEvent.change(input("URL du site d'inscription web"), { target: { value: "https://ca.exemple/certsrv" } });
    const submit = screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.change(input("Renouveler combien de jours avant expiration"), { target: { value: "900" } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/maximum 365/)).toBeTruthy();
  });

  it("le bouton de test partage la même condition de validité que l'enregistrement", () => {
    const { calls, handler } = collector();
    const tester = collector();
    render(<SchemaForm schema={CERTIFICATES_LIKE} onSubmit={handler} onTest={tester.handler} />);

    const button = screen.getByRole("button", { name: "Tester la connexion" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input("URL du site d'inscription web"), { target: { value: "https://ca.exemple/certsrv" } });
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(tester.calls).toHaveLength(1);
    expect(tester.calls[0]).toEqual({
      caUrl: "https://ca.exemple/certsrv",
      renewBeforeDays: 30,
      autoEnroll: true,
      accountSource: "directory",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("SchemaForm — schéma non supporté", () => {
  function renderInvalid(schema: unknown) {
    const { handler } = collector();
    return render(<SchemaForm schema={schema as FormSchema} onSubmit={handler} />);
  }

  it("refuse explicitement un type hors du sous-ensemble, sans rendre le moindre champ", () => {
    renderInvalid({
      fields: [
        { name: "caUrl", type: "string", label: "URL" },
        { name: "tags", type: "array", label: "Étiquettes" },
      ],
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("n'est pas supporté");
    expect(alert.textContent).toContain("« array »");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("URL")).toBeNull();
  });

  it("refuse un objet imbriqué, une dépendance en chaîne et un secret pré-rempli", () => {
    renderInvalid({
      fields: [
        { name: "tls", type: "object", label: "TLS" },
        { name: "mode", type: "enum", label: "Mode", options: [{ value: "a", label: "A" }] },
        { name: "un", type: "string", label: "Un", showIf: { field: "mode", equals: "a" } },
        { name: "deux", type: "string", label: "Deux", showIf: { field: "un", equals: "x" } },
        { name: "secret", type: "string", format: "password", label: "Secret", default: "abc" },
      ],
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("« object »");
    expect(alert.textContent).toContain("dépendance en chaîne non supportée");
    expect(alert.textContent).toContain("un champ secret ne peut pas déclarer de valeur par défaut");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("validateSchema", () => {
  it("accepte les schémas décalqués des formulaires réels", () => {
    expect(validateSchema(THREECX_LIKE)).toEqual([]);
    expect(validateSchema(CERTIFICATES_LIKE)).toEqual([]);
  });

  it("refuse ce qui n'est pas un schéma exploitable", () => {
    expect(validateSchema(null)).toHaveLength(1);
    expect(validateSchema({})).toHaveLength(1);
    expect(validateSchema({ fields: [] })).toHaveLength(1);
    expect(validateSchema({ fields: [{ type: "string", label: "Sans nom" }] })).toHaveLength(1);
  });

  it("refuse les incohérences de champ une par une", () => {
    const problems = validateSchema({
      fields: [
        { name: "a", type: "string", label: "" },
        { name: "a", type: "string", label: "Doublon" },
        { name: "b", type: "number", label: "B", default: "trente" },
        { name: "c", type: "boolean", label: "C", required: true },
        { name: "d", type: "enum", label: "D", options: [] },
        { name: "e", type: "number", label: "E", format: "password" },
        { name: "f", type: "string", label: "F", showIf: { field: "inconnu", equals: "x" } },
        { name: "g", type: "string", label: "G", showIf: { field: "g", equals: "x" } },
      ],
    });

    expect(problems.some((p) => p.includes("« label » manquant"))).toBe(true);
    expect(problems.some((p) => p.includes("déclaré plusieurs fois"))).toBe(true);
    expect(problems.some((p) => p.includes("la valeur par défaut doit être un nombre"))).toBe(true);
    expect(problems.some((p) => p.includes("n'a pas de sens sur une case à cocher"))).toBe(true);
    expect(problems.some((p) => p.includes("tableau « options » non vide"))).toBe(true);
    expect(problems.some((p) => p.includes("n'existe que sur un champ « string »"))).toBe(true);
    expect(problems.some((p) => p.includes("qui n'est pas déclaré"))).toBe(true);
    expect(problems.some((p) => p.includes("ne peut pas dépendre du champ lui-même"))).toBe(true);
  });

  it("refuse une condition dont la valeur n'existe pas dans l'enum contrôleur", () => {
    const problems = validateSchema({
      fields: [
        { name: "mode", type: "enum", label: "Mode", options: [{ value: "v2c", label: "v2c" }] },
        { name: "engine", type: "string", label: "Moteur", showIf: { field: "mode", equals: "v3" } },
      ],
    });
    expect(problems.some((p) => p.includes("n'est pas une option déclarée"))).toBe(true);
  });
});

describe("redactSecrets et buildSubmission", () => {
  it("masque une valeur secrète présente telle quelle dans un message", () => {
    expect(redactSecrets("échec avec MonMotDePasse", ["MonMotDePasse"])).toBe("échec avec •••");
    expect(redactSecrets("échec avec MonMotDePasse", ["  MonMotDePasse  "])).toBe("échec avec •••");
  });

  it("laisse le message intact quand rien de secret n'y figure, ou qu'il est trop court pour être masqué sûrement", () => {
    expect(redactSecrets("échec de connexion", ["MonMotDePasse"])).toBe("échec de connexion");
    expect(redactSecrets("échec ab", ["ab"])).toBe("échec ab");
  });

  it("omet les champs vides et convertit les nombres", () => {
    expect(
      buildSubmission(CERTIFICATES_LIKE.fields, {
        caUrl: "https://ca.exemple/certsrv",
        renewBeforeDays: "45",
        autoEnroll: false,
        accountSource: "dedicated",
        password: "   ",
      }),
    ).toEqual({
      caUrl: "https://ca.exemple/certsrv",
      renewBeforeDays: 45,
      autoEnroll: false,
      accountSource: "dedicated",
    });
  });
});
