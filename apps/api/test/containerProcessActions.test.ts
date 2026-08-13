import { describe, expect, it } from "vitest";
import { killContainerProcess, parseEnviron, parseNulSeparated, restartContainerProcess } from "../src/services/docker.js";

// Aucun mock ici (contrairement à containerProcessActionsRoutes.test.ts) — ces tests exercent le
// VRAI code de services/docker.ts, pas une doublure. Possible sans démon Docker réel pour les cas
// ci-dessous UNIQUEMENT parce que le garde-fou pid===1 (kill/restart) et les parseurs purs
// n'atteignent jamais dockerode : le garde-fou renvoie AVANT tout appel à requireReachableClient().

describe("parseNulSeparated (parsing pur de /proc/<pid>/cmdline)", () => {
  it("splits fields separated by a NUL byte, dropping only the trailing terminator", () => {
    expect(parseNulSeparated("node\x00server.js\x00--port\x008080\x00")).toEqual(["node", "server.js", "--port", "8080"]);
  });

  it("returns [] for an empty string (never [\"\"])", () => {
    expect(parseNulSeparated("")).toEqual([]);
  });

  it("preserves a genuinely empty field in the middle (not just the trailing terminator)", () => {
    expect(parseNulSeparated("cmd\x00\x00--flag\x00")).toEqual(["cmd", "", "--flag"]);
  });

  it("does not require a trailing NUL to parse correctly", () => {
    expect(parseNulSeparated("onlyarg")).toEqual(["onlyarg"]);
  });
});

describe("parseEnviron (parsing pur de /proc/<pid>/environ)", () => {
  it("splits KEY=value entries separated by NUL into a record", () => {
    expect(parseEnviron("PATH=/usr/bin\x00HOME=/root\x00")).toEqual({ PATH: "/usr/bin", HOME: "/root" });
  });

  it("keeps everything after the first '=' as the value, even if the value itself contains '='", () => {
    expect(parseEnviron("DATABASE_URL=postgres://u:p@host/db?sslmode=require\x00")).toEqual({
      DATABASE_URL: "postgres://u:p@host/db?sslmode=require",
    });
  });

  it("ignores a malformed entry without '=' rather than throwing or corrupting the result", () => {
    expect(parseEnviron("VALID=1\x00malformed\x00OTHER=2\x00")).toEqual({ VALID: "1", OTHER: "2" });
  });

  it("returns {} for an empty string", () => {
    expect(parseEnviron("")).toEqual({});
  });
});

describe("killContainerProcess — garde-fou PID 1 (services/docker.ts)", () => {
  it("never executes a kill and returns { wasPidOne: true } for pid === 1, without touching Docker", async () => {
    // Si le garde-fou n'interceptait pas AVANT tout appel Docker, cet appel lèverait "Docker
    // daemon is not reachable" (aucun démon réel dans cet environnement de test) — le fait que la
    // promesse se résolve proprement EST la preuve que rien n'a été tenté côté Docker.
    const result = await killContainerProcess("any-container-id", 1, "TERM");
    expect(result).toEqual({ wasPidOne: true });
  });

  it("also short-circuits for signal KILL on pid 1 (the guard is signal-independent)", async () => {
    const result = await killContainerProcess("any-container-id", 1, "KILL");
    expect(result).toEqual({ wasPidOne: true });
  });

  it("rejects an invalid pid (0, negative, non-integer) before the pid===1 check even runs", async () => {
    await expect(killContainerProcess("any-container-id", 0, "TERM")).rejects.toThrow(/invalid pid/i);
    await expect(killContainerProcess("any-container-id", -5, "TERM")).rejects.toThrow(/invalid pid/i);
  });
});

describe("restartContainerProcess — garde-fou PID 1 (services/docker.ts)", () => {
  it("never kills/relaunches anything and returns { wasPidOne: true } for pid === 1, without touching Docker", async () => {
    const result = await restartContainerProcess("any-container-id", 1);
    expect(result).toEqual({ wasPidOne: true });
  });

  it("rejects an invalid pid before the pid===1 check even runs", async () => {
    await expect(restartContainerProcess("any-container-id", -1)).rejects.toThrow(/invalid pid/i);
  });
});
