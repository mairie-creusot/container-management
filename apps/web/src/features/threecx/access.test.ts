import { describe, expect, it } from "vitest";
import { accessStateOf, pbxErrorHint } from "@/features/threecx/access";

/** Message RÉEL renvoyé par le PBX de la mairie sur une pagination trop large — copié tel quel. */
const ODATA_TOP_LIMIT =
  "The query specified in the URI is not valid. The limit of '100' for Top query has been exceeded. The value from the incoming request is '500'. (HTTP 400)";

describe("accessStateOf — les cinq états, jamais confondus", () => {
  it("jamais configuré", () => {
    expect(accessStateOf({ configured: false })).toBe("unconfigured");
    // Même avec un message traînant, non configuré reste non configuré.
    expect(accessStateOf({ configured: false, accessError: "peu importe" })).toBe("unconfigured");
  });

  it("PBX injoignable", () => {
    expect(accessStateOf({ configured: true, reachable: false })).toBe("unreachable");
  });

  it("refus d'accès : accessError seul produit denied", () => {
    expect(accessStateOf({ configured: true, reachable: true, accessError: "Token rejected (HTTP 401)" })).toBe("denied");
  });

  it("erreur du PBX : un 400 de validation OData ne devient JAMAIS denied", () => {
    expect(accessStateOf({ configured: true, reachable: true, pbxError: ODATA_TOP_LIMIT })).toBe("pbx-error");
  });

  it("réponse réelle : une liste vide reste ok", () => {
    expect(accessStateOf({ configured: true, reachable: true })).toBe("ok");
  });

  it("aucune réponse encore reçue", () => {
    expect(accessStateOf({ configured: true })).toBe("unknown");
  });
});

describe("pbxErrorHint — piste factuelle, jamais une hypothèse de licence", () => {
  it("400 : erreur de requête explicitement dissociée des droits et de la licence", () => {
    const hint = pbxErrorHint(ODATA_TOP_LIMIT);
    expect(hint).toContain("erreur de requête");
    expect(hint).toContain("pas un problème de droits ni de licence");
  });

  it("404 et 5xx : pistes factuelles distinctes", () => {
    expect(pbxErrorHint("HTTP 404")).toContain("n'existe pas sur ce PBX");
    expect(pbxErrorHint("Internal error (HTTP 503)")).toContain("Erreur interne du PBX");
  });

  it("aucune piste inventée quand le message ne porte pas de code HTTP", () => {
    expect(pbxErrorHint("3CX a renvoyé une réponse illisible pour GET /xapi/v1/Users")).toBeNull();
  });

  it("aucune piste ne parle de licence Enterprise", () => {
    for (const message of [ODATA_TOP_LIMIT, "HTTP 404", "HTTP 500", "HTTP 418"]) {
      expect(pbxErrorHint(message) ?? "").not.toContain("Enterprise");
    }
  });
});
