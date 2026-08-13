import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// CONFIG_PATH isolé, même pattern que containers.test.ts/containerLogs.test.ts : aucun de ces
// tests n'écrit dans config.json, mais l'isoler préventivement évite toute pollution du fichier
// de dev réel.
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { config } = await import("../src/config.js");
const { signSessionToken } = await import("../src/services/session.js");
const { getClient, isDockerReachable, readContainerFileHexdump } = await import("../src/services/docker.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const FAKE_CONTAINER_ID = "fakehexdump00000000000000000000000000000000000000000000000000";

function hexdumpUrl(id: string, query: Record<string, string>): string {
  return `/api/containers/${id}/files/hexdump?${new URLSearchParams(query)}`;
}

// ---------------------------------------------------------------------------------------
// Validation de rôle (admin uniquement, PAS operator/viewer — voir routes/containers.ts#
// rejectIfNotAdmin) et de chemin (".." / non-absolu -> 400, JAMAIS exécuté, voir plus bas) — ne
// requiert PAS de démon Docker réel : ces requêtes échouent toutes AVANT le moindre appel
// dockerode (403 sur le rôle en tout premier, ou 400 sur la validation du chemin qui a lieu en
// tout début de services/docker.ts#readContainerFileHexdump, avant requireReachableClient()).
// ---------------------------------------------------------------------------------------
describe("GET /api/containers/:id/files/hexdump — rôles et validation (aucun appel Docker requis)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: hexdumpUrl(FAKE_CONTAINER_ID, { path: "/etc/hostname" }) });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a viewer (read-only role) with 403 — admin uniquement, plus strict que /processes", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["viewer"] });
    const response = await app.inject({
      method: "GET",
      url: hexdumpUrl(FAKE_CONTAINER_ID, { path: "/etc/hostname" }),
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("admin") });
  });

  // operator suffit pour /api/console (shell interactif complet) et pour start/stop/restart,
  // mais PAS pour lire du contenu binaire arbitraire — vérifie explicitement la distinction
  // documentée en tête de routes/containers.ts (même sensibilité que /api/secrets/:id/reveal).
  it("rejects an operator (privileged for mutations, but not admin) with 403", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["operator"] });
    const response = await app.inject({
      method: "GET",
      url: hexdumpUrl(FAKE_CONTAINER_ID, { path: "/etc/hostname" }),
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing path with 400 (admin role)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: `/api/containers/${FAKE_CONTAINER_ID}/files/hexdump`,
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(400);
  });

  // Le cœur de la règle de sécurité : un chemin contenant ".." doit être rejeté en 400 par la
  // validation elle-même (services/docker.ts#assertValidAbsoluteFilePath), AVANT tout appel
  // dockerode — FAKE_CONTAINER_ID n'existe pas et le démon local n'a aucune raison d'être
  // sollicité pour un tel id, donc un 400 (plutôt qu'un 404/502 "no such container") prouve que
  // la requête n'a JAMAIS atteint Docker.
  it('rejects a path containing ".." with 400, never reaching Docker (admin role)', async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: hexdumpUrl(FAKE_CONTAINER_ID, { path: "/etc/../../root/.ssh/id_rsa" }),
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('".."') });
  });

  it("rejects a non-absolute path with 400, never reaching Docker (admin role)", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo", displayName: "Demo User", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: hexdumpUrl(FAKE_CONTAINER_ID, { path: "etc/hostname" }),
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("absolute path") });
  });

  // Même garde-fou testé directement au niveau service (pas seulement via la route HTTP) —
  // readContainerFileHexdump rejette AVANT tout appel à getClient()/requireReachableClient(),
  // vérifié ici en observant que l'erreur revient quasi immédiatement même si aucun conteneur
  // FAKE_CONTAINER_ID n'existe et qu'aucun mock Docker n'est en place.
  it("service function itself rejects \"..\" synchronously, before any Docker call", async () => {
    await expect(readContainerFileHexdump(FAKE_CONTAINER_ID, "/var/../../etc/shadow")).rejects.toThrow(/\.\./);
  });

  it("service function itself rejects a non-absolute path, before any Docker call", async () => {
    await expect(readContainerFileHexdump(FAKE_CONTAINER_ID, "relative/path")).rejects.toThrow(/absolute path/);
  });

  it("service function itself rejects a non-positive length, before any Docker call", async () => {
    await expect(readContainerFileHexdump(FAKE_CONTAINER_ID, "/etc/hostname", 0, 0)).rejects.toThrow(/length/);
  });
});

// ---------------------------------------------------------------------------------------
// Vérification RÉELLE contre un démon Docker réel (skip proprement si injoignable — même esprit
// que le reste du dépôt, qui retombe sur des données de démo quand Docker n'est pas disponible :
// ces tests ne doivent jamais faire échouer la suite dans un environnement sans Docker, mais
// DOIVENT s'exécuter réellement dès qu'un démon répond, comme demandé). Conteneur alpine
// éphémère avec un fichier de contenu CONNU écrit par CE TEST (jamais un fichier "supposé"
// présent dans une image tierce) : la comparaison octet-par-octet ci-dessous porte sur un
// contenu entièrement contrôlé, donc vérifiable sans aucune donnée inventée.
// ---------------------------------------------------------------------------------------
let dockerReachable = false;
try {
  const docker = await getClient();
  dockerReachable = await isDockerReachable(docker);
} catch {
  dockerReachable = false;
}

describe.skipIf(!dockerReachable)("readContainerFileHexdump — vérification réelle octet par octet (Docker requis)", () => {
  // Motif ASCII simple (pas de guillemets/backticks/$ — traverse un Env Docker puis `printf '%s'`
  // sans aucune réinterprétation shell supplémentaire) répété pour dépasser HEXDUMP_MAX_LENGTH
  // (8192 octets, voir services/docker.ts) et exercer le plafonnement réel, pas seulement le cas
  // "petit fichier".
  const FIXTURE_UNIT = "QuaiHexdumpFixture0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  const FIXTURE_CONTENT = FIXTURE_UNIT.repeat(200); // 200 * 58 = 11600 octets > 8192 (plafond dur)
  const FIXTURE_BUFFER = Buffer.from(FIXTURE_CONTENT, "utf8");
  const FIXTURE_PATH = "/tmp/quai-hexdump-fixture.bin";

  // Second fichier, volontairement PLUS PETIT que HEXDUMP_MAX_LENGTH (8192) — nécessaire pour
  // tester `truncated: false` : avec FIXTURE_CONTENT ci-dessus (11600 octets), le plafond dur
  // rend `truncated: true` inévitable quelle que soit la longueur demandée, donc ce cas exige
  // son propre petit fichier.
  const SMALL_FIXTURE_CONTENT = FIXTURE_UNIT; // 58 octets
  const SMALL_FIXTURE_BUFFER = Buffer.from(SMALL_FIXTURE_CONTENT, "utf8");
  const SMALL_FIXTURE_PATH = "/tmp/quai-hexdump-fixture-small.bin";

  let containerId: string | undefined;

  beforeAll(async () => {
    const docker = await getClient();
    const container = await docker.createContainer({
      Image: "alpine:3.19",
      Cmd: [
        "/bin/sh",
        "-c",
        `printf '%s' "$FIXTURE_CONTENT" > ${FIXTURE_PATH} && printf '%s' "$SMALL_FIXTURE_CONTENT" > ${SMALL_FIXTURE_PATH} && sleep 300`,
      ],
      Env: [`FIXTURE_CONTENT=${FIXTURE_CONTENT}`, `SMALL_FIXTURE_CONTENT=${SMALL_FIXTURE_CONTENT}`],
      Tty: false,
      HostConfig: { AutoRemove: false },
    });
    containerId = container.id;
    await container.start();
    // Laisse le temps au script de démarrage (printf) de s'exécuter avant le premier test —
    // quasi instantané, mais on attend explicitement plutôt que de supposer un ordre de course.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 60_000);

  afterAll(async () => {
    if (!containerId) return;
    const docker = await getClient();
    try {
      await docker.getContainer(containerId).remove({ force: true });
    } catch {
      // déjà supprimé / jamais démarré : rien à faire.
    }
  });

  it("returns the exact byte-for-byte content for a full small-window read (offset=0, length < file size)", async () => {
    const dump = await readContainerFileHexdump(containerId!, FIXTURE_PATH, 0, 100);
    expect(dump.path).toBe(FIXTURE_PATH);
    expect(dump.sizeBytes).toBe(FIXTURE_BUFFER.length);
    expect(dump.offset).toBe(0);
    expect(dump.length).toBe(100);
    expect(dump.truncated).toBe(true); // 100 < sizeBytes (11600)
    // Comparaison RÉELLE, pas juste "la requête a réussi" : les octets renvoyés doivent
    // correspondre EXACTEMENT aux 100 premiers octets du fichier tel qu'écrit ci-dessus.
    expect(dump.bytes).toBe(FIXTURE_BUFFER.subarray(0, 100).toString("hex"));
  });

  it("returns the exact byte-for-byte content for a mid-file offset window", async () => {
    const offset = 4000;
    const length = 256;
    const dump = await readContainerFileHexdump(containerId!, FIXTURE_PATH, offset, length);
    expect(dump.offset).toBe(offset);
    expect(dump.bytes).toBe(FIXTURE_BUFFER.subarray(offset, offset + length).toString("hex"));
  });

  // Plafonnement RÉEL (pas seulement documenté) : demander explicitement plus que
  // HEXDUMP_MAX_LENGTH (8192) doit être plafonné SILENCIEUSEMENT (jamais un 400/erreur) mais le
  // dump renvoyé doit refléter honnêtement ce plafonnement via `truncated`/`length`.
  it("silently caps length at the hard maximum (8192) instead of failing, and reports it honestly via `truncated`", async () => {
    const requestedLength = 20_000; // très supérieur au plafond et à la taille du fichier
    const dump = await readContainerFileHexdump(containerId!, FIXTURE_PATH, 0, requestedLength);
    expect(dump.length).toBe(8192); // plafonné, jamais 20000 ni la taille totale du fichier
    expect(dump.truncated).toBe(true);
    expect(dump.bytes).toBe(FIXTURE_BUFFER.subarray(0, 8192).toString("hex"));
  });

  it("reports truncated: false when the entire (small) file fits within the requested window", async () => {
    const dump = await readContainerFileHexdump(containerId!, SMALL_FIXTURE_PATH, 0, SMALL_FIXTURE_BUFFER.length + 1000);
    expect(dump.sizeBytes).toBe(SMALL_FIXTURE_BUFFER.length);
    expect(dump.truncated).toBe(false);
    expect(dump.length).toBe(SMALL_FIXTURE_BUFFER.length);
    expect(dump.bytes).toBe(SMALL_FIXTURE_BUFFER.toString("hex"));
  });

  it("rejects hexdumping a directory with a clear error (never fabricates bytes)", async () => {
    await expect(readContainerFileHexdump(containerId!, "/tmp")).rejects.toThrow(/directory/i);
  });

  it("rejects a file that does not exist with a clear \"not found\" error", async () => {
    await expect(readContainerFileHexdump(containerId!, "/tmp/does-not-exist-quai.bin")).rejects.toThrow(/not found/i);
  });

  // Bout-en-bout via la route HTTP réelle (admin token), pas seulement le service — vérifie que
  // le câblage route -> service -> réponse JSON restitue bien les mêmes octets.
  it("GET /api/containers/:id/files/hexdump (admin) returns the same bytes end-to-end over HTTP", async () => {
    app = buildServer();
    const token = signSessionToken({ username: "demo-admin", displayName: "Demo Admin", roles: ["admin"] });
    const response = await app.inject({
      method: "GET",
      url: hexdumpUrl(containerId!, { path: FIXTURE_PATH, offset: "0", length: "64" }),
      cookies: { [config.session.cookieName]: token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bytes).toBe(FIXTURE_BUFFER.subarray(0, 64).toString("hex"));
    expect(body.truncated).toBe(true);
  });
});
