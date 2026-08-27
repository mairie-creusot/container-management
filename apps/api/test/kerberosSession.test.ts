import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * TICKET KERBEROS DE SESSION (services/kerberosSession.ts) — ce qui permet d'agir sur Windows sous
 * l'identité RÉELLE de la personne connectée.
 *
 * Aucun KDC n'est joint : un faux `kinit` est placé en tête de PATH, écrit en shell, qui se comporte
 * comme le vrai (mot de passe lu sur stdin, ccache écrit, code de sortie) et NOTE ce qu'il a reçu.
 * C'est ce témoin qui permet de vérifier la propriété qui compte : le mot de passe ne passe que par
 * stdin, jamais par la ligne de commande — où il serait visible dans la liste des processus de
 * l'hôte, donc lisible par tout le monde.
 */
const tmpDir = path.join(os.tmpdir(), `quai-krb-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const binDir = path.join(tmpDir, "bin");
const witnessPath = path.join(tmpDir, "kinit-witness.txt");
fsSync.mkdirSync(binDir, { recursive: true });

process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "6".repeat(64);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.QUAI_TEST_KINIT_WITNESS = witnessPath;

/** Faux `kinit` : consigne ses arguments ET le mot de passe reçu sur stdin, puis écrit un ccache. */
function installKinit(exitCode: number): void {
  fsSync.writeFileSync(
    path.join(binDir, "kinit"),
    [
      "#!/bin/sh",
      'stdin_value="$(cat)"',
      'printf "args=%s stdin=%s ccache=%s\\n" "$*" "$stdin_value" "$KRB5CCNAME" >> "$QUAI_TEST_KINIT_WITNESS"',
      `if [ ${exitCode} -ne 0 ]; then echo "kinit: Password incorrect while getting initial credentials" >&2; exit ${exitCode}; fi`,
      'printf "faux-ticket" > "${KRB5CCNAME#FILE:}"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

installKinit(0);

const { establishTicket, ticketFor, destroyTicket, destroyAllTickets, ticketStatusFor } = await import(
  "../src/services/kerberosSession.js"
);
const { setAdDnsConfig, clearAdDnsConfig } = await import("../src/services/setupStore.js");

const AD = {
  realm: "lecreusot.priv",
  kdcHost: "hdvad1.lecreusot.priv",
  zone: "lecreusot.priv",
  serviceAccount: "svc-quai-dns",
  password: "mot-de-passe-du-compte-de-service",
  targetIp: "10.0.0.10",
};

const USER_PASSWORD = "MotDePasseDeLUtilisateur!2026";

function witnessLines(): string[] {
  try {
    return fsSync.readFileSync(witnessPath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

beforeEach(async () => {
  await fs.rm(witnessPath, { force: true });
  installKinit(0);
  await setAdDnsConfig(AD);
});

afterEach(async () => {
  await destroyAllTickets();
  await clearAdDnsConfig();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("obtention du ticket à la connexion", () => {
  it("obtient un ticket pour le principal de la personne, dans le realm configuré", async () => {
    const outcome = await establishTicket("ybanas", USER_PASSWORD);

    expect(outcome.ok, outcome.ok ? "" : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ticket.realm).toBe("LECREUSOT.PRIV");
    expect(witnessLines()[0]).toContain("args=ybanas@LECREUSOT.PRIV");
  });

  it("le mot de passe passe par STDIN, jamais par la ligne de commande", async () => {
    await establishTicket("ybanas", USER_PASSWORD);
    const line = witnessLines()[0] ?? "";

    // Sur stdin : oui. Dans les arguments : jamais — ils sont visibles dans la liste des processus.
    expect(line).toContain(`stdin=${USER_PASSWORD}`);
    expect(line.slice(0, line.indexOf("stdin="))).not.toContain(USER_PASSWORD);
  });

  it("le ticket est écrit dans le conteneur, en 0600, et jamais à côté de la configuration", async () => {
    const outcome = await establishTicket("ybanas", USER_PASSWORD);
    if (!outcome.ok) throw new Error(outcome.reason);

    const stat = await fs.stat(outcome.ticket.ccachePath);
    expect(stat.isFile()).toBe(true);
    expect(outcome.ticket.ccachePath.startsWith(os.tmpdir())).toBe(true);
    const krb5 = await fs.stat(outcome.ticket.krb5ConfigPath);
    expect(krb5.mode & 0o777).toBe(0o600);
  });

  it("une seconde connexion remplace le ticket précédent sans laisser l'ancien sur le disque", async () => {
    const first = await establishTicket("ybanas", USER_PASSWORD);
    if (!first.ok) throw new Error(first.reason);
    const second = await establishTicket("ybanas", USER_PASSWORD);
    if (!second.ok) throw new Error(second.reason);

    expect(second.ticket.ccachePath).not.toBe(first.ticket.ccachePath);
    await expect(fs.stat(first.ticket.ccachePath)).rejects.toThrow();
  });
});

describe("ce qui rend la capacité OPTIONNELLE", () => {
  it("sans domaine configuré : refus explicite, et QUAI reste utilisable", async () => {
    await clearAdDnsConfig();
    const outcome = await establishTicket("ybanas", USER_PASSWORD);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.configured).toBe(false);
    expect(outcome.reason).toContain("Active Directory");
    // Aucun kinit n'a même été tenté : rien à joindre.
    expect(witnessLines()).toEqual([]);
  });

  it("mot de passe refusé par le KDC : le motif RÉEL remonte, rien n'est gardé", async () => {
    installKinit(1);
    const outcome = await establishTicket("ybanas", "mauvais-mot-de-passe");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.configured).toBe(true);
    expect(outcome.reason).toContain("Password incorrect");
    expect(await ticketFor("ybanas")).toBeUndefined();
  });
});

describe("cycle de vie du ticket", () => {
  it("la déconnexion détruit le ticket et son répertoire", async () => {
    const outcome = await establishTicket("ybanas", USER_PASSWORD);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(await ticketFor("ybanas")).toBeDefined();

    expect(await destroyTicket("ybanas")).toBe(true);
    expect(await ticketFor("ybanas")).toBeUndefined();
    await expect(fs.stat(outcome.ticket.ccachePath)).rejects.toThrow();
    // Idempotent : se déconnecter deux fois n'est pas une erreur.
    expect(await destroyTicket("ybanas")).toBe(false);
  });

  it("un ticket périmé n'est jamais rendu, et disparaît du disque", async () => {
    const outcome = await establishTicket("ybanas", USER_PASSWORD);
    if (!outcome.ok) throw new Error(outcome.reason);

    outcome.ticket.expiresAt = Date.now() - 1;
    expect(await ticketFor("ybanas")).toBeUndefined();
    await expect(fs.stat(outcome.ticket.ccachePath)).rejects.toThrow();
  });

  it("l'état exposé dit qu'un ticket existe et jusqu'à quand, jamais où il est", async () => {
    expect(ticketStatusFor("ybanas")).toEqual({ present: false, expiresAt: null });
    await establishTicket("ybanas", USER_PASSWORD);

    const status = ticketStatusFor("ybanas");
    expect(status.present).toBe(true);
    expect(status.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(status)).not.toContain(os.tmpdir());
    expect(JSON.stringify(status)).not.toContain(USER_PASSWORD);
  });

  it("le ticket d'une personne n'est jamais rendu à une autre", async () => {
    await establishTicket("ybanas", USER_PASSWORD);
    expect(await ticketFor("mdupont")).toBeUndefined();
  });
});
