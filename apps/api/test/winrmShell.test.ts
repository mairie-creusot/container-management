import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * EXÉCUTION DE POWERSHELL À DISTANCE (services/winrmShell.ts) et détection des rôles installés.
 *
 * Aucun Windows n'est joint : un faux `curl` rejoue les quatre échanges RÉELS du protocole Shell de
 * WS-Management (Create → Command → Receive → Delete), flux en base64 compris, et consigne chaque
 * enveloppe reçue. C'est ce témoin qui vérifie les propriétés qui comptent : le script part en
 * `-EncodedCommand`, et le shell est TOUJOURS refermé — y compris quand la commande a échoué.
 */
const tmpDir = path.join(os.tmpdir(), `quai-psh-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const binDir = path.join(tmpDir, "bin");
const witness = path.join(tmpDir, "curl-witness.txt");
const responseDir = path.join(tmpDir, "responses");
fsSync.mkdirSync(binDir, { recursive: true });
fsSync.mkdirSync(responseDir, { recursive: true });

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "1".repeat(64);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.QUAI_TEST_CURL_WITNESS = witness;
process.env.QUAI_TEST_RESPONSE_DIR = responseDir;

fsSync.writeFileSync(
  path.join(binDir, "kinit"),
  ["#!/bin/sh", "cat > /dev/null", 'printf "faux-ticket" > "${KRB5CCNAME#FILE:}"', "exit 0", ""].join("\n"),
  { mode: 0o755 },
);
fsSync.writeFileSync(
  path.join(binDir, "curl"),
  [
    "#!/bin/sh",
    'body="$(cat)"',
    'printf "%s\\n===\\n" "$body" >> "$QUAI_TEST_CURL_WITNESS"',
    'n=$(cat "$QUAI_TEST_RESPONSE_DIR/counter" 2>/dev/null || echo 0)',
    "n=$((n+1))",
    'printf "%s" "$n" > "$QUAI_TEST_RESPONSE_DIR/counter"',
    'if [ -f "$QUAI_TEST_RESPONSE_DIR/$n.xml" ]; then cat "$QUAI_TEST_RESPONSE_DIR/$n.xml"; exit 0; fi',
    'if [ -f "$QUAI_TEST_RESPONSE_DIR/last.xml" ]; then cat "$QUAI_TEST_RESPONSE_DIR/last.xml"; exit 0; fi',
    "exit 7",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const { establishTicket, destroyAllTickets, ticketFor } = await import("../src/services/kerberosSession.js");
const { runPowerShell, runPowerShellJson, psLiteral } = await import("../src/services/winrmShell.js");
const { listWindowsRoles } = await import("../src/services/windowsRoles.js");
const { setAdDnsConfig, clearAdDnsConfig } = await import("../src/services/setupStore.js");

const SHELL_NS = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell";

const CREATE_OK =
  `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">` +
  `<s:Body><w:Selector Name="ShellId">SHELL-42</w:Selector></s:Body></s:Envelope>`;
const COMMAND_OK =
  `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="${SHELL_NS}">` +
  `<s:Body><rsp:CommandResponse><rsp:CommandId>CMD-7</rsp:CommandId></rsp:CommandResponse></s:Body></s:Envelope>`;

function receive(streams: { stdout?: string; stderr?: string }, done: boolean, exitCode = 0): string {
  const chunks: string[] = [];
  if (streams.stdout !== undefined) {
    chunks.push(`<rsp:Stream Name="stdout" CommandId="CMD-7">${Buffer.from(streams.stdout, "utf-8").toString("base64")}</rsp:Stream>`);
  }
  if (streams.stderr !== undefined) {
    chunks.push(`<rsp:Stream Name="stderr" CommandId="CMD-7">${Buffer.from(streams.stderr, "utf-8").toString("base64")}</rsp:Stream>`);
  }
  const state = done
    ? `<rsp:CommandState CommandId="CMD-7" State="${SHELL_NS}/CommandState/Done"><rsp:ExitCode>${exitCode}</rsp:ExitCode></rsp:CommandState>`
    : `<rsp:CommandState CommandId="CMD-7" State="${SHELL_NS}/CommandState/Running"/>`;
  return (
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="${SHELL_NS}">` +
    `<s:Body><rsp:ReceiveResponse>${chunks.join("")}${state}</rsp:ReceiveResponse></s:Body></s:Envelope>`
  );
}

const DELETE_OK = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>`;

function planResponses(entries: string[]): void {
  for (const name of fsSync.readdirSync(responseDir)) fsSync.rmSync(path.join(responseDir, name));
  entries.forEach((xml, index) => fsSync.writeFileSync(path.join(responseDir, `${index + 1}.xml`), xml, "utf-8"));
  // Tout appel au-delà du plan (le Delete final, par exemple) reçoit une réponse neutre.
  fsSync.writeFileSync(path.join(responseDir, "last.xml"), DELETE_OK, "utf-8");
}

function envelopes(): string[] {
  try {
    return fsSync.readFileSync(witness, "utf-8").split("\n===\n").filter((entry) => entry.trim() !== "");
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

beforeEach(async () => {
  await fs.rm(witness, { force: true });
  await setAdDnsConfig(AD);
  await establishTicket("ybanas", "MotDePasse!2026");
});

afterEach(async () => {
  await destroyAllTickets();
  await clearAdDnsConfig();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("psLiteral — le seul chemin par lequel une valeur entre dans un script", () => {
  it("produit une chaîne à guillemets simples, où rien n'est interprété", () => {
    expect(psLiteral("Spooler")).toBe("'Spooler'");
    // `$`, backtick et sous-expression sont INERTES entre guillemets simples en PowerShell.
    expect(psLiteral("$(Remove-Item C:\\)")).toBe("'$(Remove-Item C:\\)'");
  });

  it("neutralise l'apostrophe en la doublant — la seule évasion possible", () => {
    expect(psLiteral("a'; Remove-Item C:\\ #")).toBe("'a''; Remove-Item C:\\ #'");
  });
});

describe("exécution d'un script", () => {
  it("ouvre un shell, envoie le script en -EncodedCommand, lit la sortie, referme", async () => {
    planResponses([CREATE_OK, COMMAND_OK, receive({ stdout: "bonjour" }, true, 0), DELETE_OK]);
    const ticket = (await ticketFor("ybanas"))!;

    const result = await runPowerShell("srv.lecreusot.priv", "Write-Output 'bonjour'", ticket);
    expect(result.ok, result.ok ? "" : result.failure.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("bonjour");
    expect(result.value.exitCode).toBe(0);

    const sent = envelopes();
    expect(sent).toHaveLength(4);
    // Le script ne traverse JAMAIS la ligne de commande en clair : il part encodé.
    expect(sent[1]).toContain("-EncodedCommand");
    const encoded = /<rsp:Arguments>([A-Za-z0-9+/=]{16,})<\/rsp:Arguments>/.exec(sent[1] ?? "")?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'bonjour'");
    // Et le shell est refermé.
    expect(sent[3]).toContain("Delete");
    expect(sent[3]).toContain("SHELL-42");
  });

  it("assemble une sortie rendue en plusieurs morceaux", async () => {
    planResponses([
      CREATE_OK,
      COMMAND_OK,
      receive({ stdout: "pre" }, false),
      receive({ stdout: "mier" }, true, 0),
      DELETE_OK,
    ]);
    const ticket = (await ticketFor("ybanas"))!;

    const result = await runPowerShell("srv.lecreusot.priv", "Write-Output 'premier'", ticket);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.stdout).toBe("premier");
  });

  it("referme le shell MÊME quand la commande échoue — un shell orphelin consomme un quota", async () => {
    planResponses([CREATE_OK, COMMAND_OK, receive({ stderr: "boum" }, true, 1), DELETE_OK]);
    const ticket = (await ticketFor("ybanas"))!;

    const result = await runPowerShellJson("srv.lecreusot.priv", "throw 'boum'", ticket);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Le message de PowerShell est rendu tel quel.
    expect(result.failure.message).toBe("boum");
    expect(envelopes().at(-1)).toContain("Delete");
  });
});

describe("lecture JSON — les formes réelles de ConvertTo-Json", () => {
  async function readJson(stdout: string) {
    planResponses([CREATE_OK, COMMAND_OK, receive({ stdout }, true, 0), DELETE_OK]);
    const ticket = (await ticketFor("ybanas"))!;
    return runPowerShellJson<{ Name?: string }>("srv.lecreusot.priv", "Get-Truc", ticket);
  }

  it("un objet SEUL devient un tableau — ConvertTo-Json ne met pas de crochets à un élément unique", async () => {
    const result = await readJson('{"Name":"DHCP"}');
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value).toEqual([{ Name: "DHCP" }]);
  });

  it("une sortie VIDE est une liste vide, jamais une erreur", async () => {
    const result = await readJson("   ");
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value).toEqual([]);
  });

  it("une sortie qui n'est pas du JSON est refusée, avec ce que la machine a réellement dit", async () => {
    const result = await readJson("Le terme « Get-Truc » n'est pas reconnu");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("n'est pas reconnu");
  });
});

describe("rôles installés — ce qui décide des onglets", () => {
  async function roles(stdout: string, exitCode = 0) {
    planResponses([CREATE_OK, COMMAND_OK, receive({ stdout }, true, exitCode), DELETE_OK]);
    return listWindowsRoles("srv.lecreusot.priv", "ybanas");
  }

  it("ne retient que les rôles installés et les rattache à leur onglet", async () => {
    const outcome = await roles('[{"Name":"DHCP","DisplayName":"Serveur DHCP"},{"Name":"Print-Services","DisplayName":"Impression"}]');
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;

    expect(outcome.roles.map((role) => role.name)).toEqual(["Print-Services", "DHCP"]);
    expect(outcome.roles.find((role) => role.name === "DHCP")?.tab).toBe("dhcp");
    // Un rôle sans onglet reste LISTÉ : il existe, même si QUAI ne sait pas encore le présenter.
    expect(outcome.roles.find((role) => role.name === "Print-Services")?.tab).toBeUndefined();
  });

  it("un Windows client (sans Get-WindowsFeature) n'est pas une panne, c'est une réponse", async () => {
    planResponses([
      CREATE_OK,
      COMMAND_OK,
      receive({ stderr: "Le terme « Get-WindowsFeature » n'est pas reconnu" }, true, 1),
      DELETE_OK,
    ]);
    const outcome = await listWindowsRoles("poste.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("not-a-server");
    if (outcome.status === "ready") return;
    expect(outcome.message).toContain("Windows Server");
  });

  it("sans ticket, la machine n'est jamais interrogée", async () => {
    await destroyAllTickets();
    planResponses([]);
    const outcome = await listWindowsRoles("srv.lecreusot.priv", "ybanas");

    expect(outcome.status).toBe("no-ticket");
    expect(envelopes()).toEqual([]);
  });
});
