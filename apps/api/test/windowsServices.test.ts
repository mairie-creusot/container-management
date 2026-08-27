import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * SERVICES WINDOWS lus par WinRM (services/winrm.ts + services/windowsServices.ts).
 *
 * Aucun Windows n'est joint : un faux `curl` et un faux `kinit` sont placés en tête de PATH. Le faux
 * curl rejoue de VRAIES réponses WS-Management (mêmes espaces de noms, même pagination Enumerate/
 * Pull, mêmes Fault) et NOTE ses arguments — c'est ce témoin qui vérifie la propriété qui compte :
 * l'identité vient du TICKET (KRB5CCNAME) et jamais d'un mot de passe passé à curl.
 */
const tmpDir = path.join(os.tmpdir(), `quai-winrm-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const binDir = path.join(tmpDir, "bin");
const curlWitness = path.join(tmpDir, "curl-witness.txt");
const responseDir = path.join(tmpDir, "responses");
fsSync.mkdirSync(binDir, { recursive: true });
fsSync.mkdirSync(responseDir, { recursive: true });

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "2".repeat(64);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.QUAI_TEST_CURL_WITNESS = curlWitness;
process.env.QUAI_TEST_RESPONSE_DIR = responseDir;

fsSync.writeFileSync(
  path.join(binDir, "kinit"),
  ['#!/bin/sh', 'cat > /dev/null', 'printf "faux-ticket" > "${KRB5CCNAME#FILE:}"', "exit 0", ""].join("\n"),
  { mode: 0o755 },
);

/**
 * Faux `curl` : consigne ses arguments et l'enveloppe reçue, puis rend la réponse préparée pour
 * l'appel courant (fichier `1`, `2`, …) — ce qui permet de rejouer une pagination réelle.
 */
fsSync.writeFileSync(
  path.join(binDir, "curl"),
  [
    "#!/bin/sh",
    'body="$(cat)"',
    'printf "args=%s ccache=%s body=%s\\n" "$*" "$KRB5CCNAME" "$body" >> "$QUAI_TEST_CURL_WITNESS"',
    'n=$(cat "$QUAI_TEST_RESPONSE_DIR/counter" 2>/dev/null || echo 0)',
    "n=$((n+1))",
    'printf "%s" "$n" > "$QUAI_TEST_RESPONSE_DIR/counter"',
    'code_file="$QUAI_TEST_RESPONSE_DIR/$n.code"',
    'if [ -f "$code_file" ]; then exit "$(cat "$code_file")"; fi',
    'if [ -f "$QUAI_TEST_RESPONSE_DIR/$n.xml" ]; then cat "$QUAI_TEST_RESPONSE_DIR/$n.xml"; exit 0; fi',
    "exit 7",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const { establishTicket, destroyAllTickets } = await import("../src/services/kerberosSession.js");
const { controlWindowsService, listWindowsServices } = await import("../src/services/windowsServices.js");
const { extractInstances } = await import("../src/services/winrm.js");
const { setAdDnsConfig, clearAdDnsConfig } = await import("../src/services/setupStore.js");

/** Forme RÉELLE d'une réponse WS-Management pour Win32_Service (préfixes et espaces de noms inclus). */
function servicesResponse(services: { name: string; display: string; state: string }[], context?: string): string {
  const items = services
    .map(
      (service) =>
        `<p:Win32_Service xsi:type="p:Win32_Service_Type">` +
        `<p:Name>${service.name}</p:Name>` +
        `<p:DisplayName>${service.display}</p:DisplayName>` +
        `<p:State>${service.state}</p:State>` +
        `<p:StartMode>Auto</p:StartMode>` +
        `<p:StartName>LocalSystem</p:StartName>` +
        `<p:Description>Service &amp; test</p:Description>` +
        `</p:Win32_Service>`,
    )
    .join("");
  const contextTag = context ? `<wsen:EnumerationContext>${context}</wsen:EnumerationContext>` : "";
  return (
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsen="http://schemas.xmlsoap.org/ws/2004/09/enumeration" ` +
    `xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/Win32_Service" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<s:Body><wsen:EnumerateResponse>${contextTag}<wsman:Items xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">${items}</wsman:Items>` +
    `</wsen:EnumerateResponse></s:Body></s:Envelope>`
  );
}

function planResponses(entries: (string | { exitCode: number })[]): void {
  for (const name of fsSync.readdirSync(responseDir)) fsSync.rmSync(path.join(responseDir, name));
  entries.forEach((entry, index) => {
    const slot = index + 1;
    if (typeof entry === "string") fsSync.writeFileSync(path.join(responseDir, `${slot}.xml`), entry, "utf-8");
    else fsSync.writeFileSync(path.join(responseDir, `${slot}.code`), String(entry.exitCode), "utf-8");
  });
}

function curlLines(): string[] {
  try {
    return fsSync.readFileSync(curlWitness, "utf-8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

const AD = {
  realm: "lecreusot.priv",
  kdcHost: "hdvad1.lecreusot.priv",
  zone: "lecreusot.priv",
  serviceAccount: "svc-quai-dns",
  password: "mot-de-passe-service",
  targetIp: "10.0.0.10",
};

const USER_PASSWORD = "MotDePasseUtilisateur!2026";

beforeEach(async () => {
  await fs.rm(curlWitness, { force: true });
  await setAdDnsConfig(AD);
  await establishTicket("ybanas", USER_PASSWORD);
});

afterEach(async () => {
  await destroyAllTickets();
  await clearAdDnsConfig();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("lecture des services réels", () => {
  it("rend les services de la machine, ce qui tourne en premier", async () => {
    planResponses([
      servicesResponse([
        { name: "Spooler", display: "Spouleur d'impression", state: "Stopped" },
        { name: "DNS", display: "Serveur DNS", state: "Running" },
      ]),
    ]);

    const outcome = await listWindowsServices("hdvad1.lecreusot.priv", "ybanas");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;

    expect(outcome.services.map((s) => s.name)).toEqual(["DNS", "Spooler"]);
    expect(outcome.services[0]).toMatchObject({
      displayName: "Serveur DNS",
      status: "running",
      startMode: "Auto",
      account: "LocalSystem",
      description: "Service & test",
    });
    expect(outcome.services[1]?.status).toBe("stopped");
  });

  it("l'identité vient du TICKET, jamais d'un mot de passe passé à curl", async () => {
    planResponses([servicesResponse([{ name: "DNS", display: "Serveur DNS", state: "Running" }])]);
    await listWindowsServices("hdvad1.lecreusot.priv", "ybanas");

    const line = curlLines()[0] ?? "";
    expect(line).toContain("--negotiate");
    expect(line).toContain("--user :");
    expect(line).toContain("ccache=FILE:");
    expect(line).not.toContain(USER_PASSWORD);
  });

  it("parle HTTPS sur le port WinRM sécurisé — en HTTP simple, WinRM refuserait l'échange", async () => {
    planResponses([servicesResponse([])]);
    await listWindowsServices("hdvad1.lecreusot.priv", "ybanas");

    expect(curlLines()[0]).toContain("https://hdvad1.lecreusot.priv:5986/wsman");
  });

  it("suit la pagination Enumerate/Pull jusqu'au bout", async () => {
    planResponses([
      servicesResponse([{ name: "A", display: "A", state: "Running" }], "ctx-1"),
      servicesResponse([{ name: "B", display: "B", state: "Running" }], "ctx-2"),
      servicesResponse([{ name: "C", display: "C", state: "Running" }]),
    ]);

    const outcome = await listWindowsServices("srv.lecreusot.priv", "ybanas");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.services.map((s) => s.name)).toEqual(["A", "B", "C"]);
    expect(outcome.truncated).toBe(false);
    expect(curlLines()).toHaveLength(3);
  });

  it("un état que Windows rapporte sans équivalent ne devient jamais « arrêté »", async () => {
    planResponses([servicesResponse([{ name: "X", display: "X", state: "Start Pending" }])]);
    const outcome = await listWindowsServices("srv.lecreusot.priv", "ybanas");
    if (outcome.status !== "ready") throw new Error(outcome.message);
    expect(outcome.services[0]?.status).toBe("unknown");
  });
});

describe("chaque échec dit ce qui s'est réellement passé", () => {
  it("sans ticket : on le dit, on ne prétend pas que la machine n'a aucun service", async () => {
    await destroyAllTickets();
    const outcome = await listWindowsServices("srv.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("no-ticket");
    if (outcome.status === "ready") return;
    expect(outcome.message).toContain("reconnectez-vous");
  });

  it("machine injoignable : état explicite, avec le port réellement tenté", async () => {
    planResponses([{ exitCode: 7 }]);
    const outcome = await listWindowsServices("eteinte.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("unreachable");
    if (outcome.status === "ready") return;
    expect(outcome.message).toContain("5986");
  });

  it("certificat non validé : le motif pointe l'autorité de confiance, pas un « échec réseau »", async () => {
    planResponses([{ exitCode: 60 }]);
    const outcome = await listWindowsServices("srv.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "ready") return;
    expect(outcome.message).toContain("autorité de confiance");
  });

  it("droits insuffisants côté Windows : le message du SERVEUR remonte tel quel", async () => {
    planResponses([
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Reason>` +
        `<s:Text xml:lang="fr-FR">Access is denied.</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`,
    ]);
    const outcome = await listWindowsServices("srv.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("denied");
    if (outcome.status === "ready") return;
    expect(outcome.message).toBe("Access is denied.");
  });

  it("un hôte vide n'est jamais interrogé", async () => {
    planResponses([]);
    const outcome = await listWindowsServices("   ", "ybanas");
    expect(outcome.status).toBe("failed");
    expect(curlLines()).toEqual([]);
  });
});

/** Réponse d'invocation de méthode Win32_Service, forme réelle. */
function invokeResponse(returnValue: number, method = "StartService"): string {
  return (
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Body><p:${method}_OUTPUT xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/Win32_Service">` +
    `<p:ReturnValue>${returnValue}</p:ReturnValue></p:${method}_OUTPUT></s:Body></s:Envelope>`
  );
}

describe("démarrer / arrêter un service — la mutation", () => {
  it("vise l'instance EXACTE par son sélecteur, jamais la classe entière", async () => {
    // Après l'action, l'état est relu : deux appels, l'invocation puis l'énumération.
    planResponses([invokeResponse(0), servicesResponse([])]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("done");
    const body = curlLines()[0] ?? "";
    expect(body).toContain("<w:Selector Name=\"Name\">Spooler</w:Selector>");
    expect(body).toContain("Win32_Service/StartService");
  });

  it("arrêter appelle StopService, pas StartService", async () => {
    planResponses([invokeResponse(0, "StopService")]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "stop", "ybanas");

    expect(outcome.status).toBe("done");
    expect(curlLines()[0]).toContain("Win32_Service/StopService");
  });

  it("droits insuffisants côté Windows : refus explicite, jamais un succès", async () => {
    planResponses([invokeResponse(2)]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("denied");
    if (outcome.status === "done") return;
    expect(outcome.message).toContain("n'a pas le droit");
  });

  it("un code documenté est traduit fidèlement — « déjà démarré » n'est pas un succès", async () => {
    planResponses([invokeResponse(10)]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "done") return;
    expect(outcome.message).toContain("déjà en cours d'exécution");
  });

  it("un code INCONNU est rendu tel quel, jamais interprété au hasard", async () => {
    planResponses([invokeResponse(4242)]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "done") return;
    expect(outcome.message).toContain("4242");
  });

  it("sans code de retour, l'état réel est déclaré INCONNU plutôt que supposé", async () => {
    planResponses([
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><p:StartService_OUTPUT/></s:Body></s:Envelope>`,
    ]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "done") return;
    expect(outcome.message).toContain("inconnu");
  });

  it("sans ticket, rien n'est tenté sur la machine", async () => {
    await destroyAllTickets();
    planResponses([]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "Spooler", "start", "ybanas");

    expect(outcome.status).toBe("no-ticket");
    expect(curlLines()).toEqual([]);
  });

  it("un nom de service vide n'est jamais envoyé", async () => {
    planResponses([]);
    const outcome = await controlWindowsService("srv.lecreusot.priv", "   ", "start", "ybanas");

    expect(outcome.status).toBe("failed");
    expect(curlLines()).toEqual([]);
  });
});

describe("lecture des instances WS-Management", () => {
  it("décode les entités XML et écarte ENTIÈREMENT un champ composite", () => {
    // Un champ à sous-éléments est ignoré en bloc — ni aplati en texte, ni récolté à moitié par ses
    // enfants : une valeur reconstituée serait pire qu'une valeur absente.
    const xml =
      `<p:Win32_Service><p:Name>A &amp; B</p:Name><p:Nested><p:Inner>x</p:Inner></p:Nested></p:Win32_Service>`;
    expect(extractInstances(xml, "Win32_Service")).toEqual([{ Name: "A & B" }]);
  });

  it("une réponse sans instance rend une liste vide, jamais une instance inventée", () => {
    expect(extractInstances("<s:Envelope><s:Body/></s:Envelope>", "Win32_Service")).toEqual([]);
  });
});
