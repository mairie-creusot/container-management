import { describe, expect, it } from "vitest";
import {
  parseListeningSockets,
  parseProcStat,
  parseProcStatusUid,
  parseSocketInodeFromFdTarget,
  resolveUsernameFromPasswd,
} from "../src/services/containerInternals.js";

describe("parseProcStat", () => {
  // Ligne réelle de /proc/1/stat pour un process PID 1 "node" — cas simple, comm sans espace.
  it("parses a simple /proc/<pid>/stat line", () => {
    const line =
      "1 (node) S 0 1 1 0 -1 4194560 21393 0 0 0 11 12 0 0 20 0 8 0 1234567 12345678 561 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0";
    const parsed = parseProcStat(line);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      pid: 1,
      comm: "node",
      state: "S",
      ppid: 0,
      utimeTicks: 11,
      stimeTicks: 12,
      starttimeTicks: 1234567,
    });
  });

  // Cas explicitement signalé par man 5 proc : `comm` peut contenir des espaces ET des
  // parenthèses (ex: cmdline lancé avec des arguments visibles dans /proc/<pid>/comm tronqué,
  // ou un nom de process arbitraire) — le parsing doit localiser la PREMIÈRE '(' et la DERNIÈRE
  // ')', jamais découper naïvement sur le premier/dernier espace.
  it("parses comm containing spaces and parentheses without corrupting field offsets", () => {
    const line =
      "42 (node --inspect (debug)) R 7 42 42 0 -1 4194304 100 0 0 0 55 66 0 0 20 0 4 0 987654 20480000 900 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0";
    const parsed = parseProcStat(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.comm).toBe("node --inspect (debug)");
    expect(parsed?.state).toBe("R");
    expect(parsed?.ppid).toBe(7);
    expect(parsed?.utimeTicks).toBe(55);
    expect(parsed?.stimeTicks).toBe(66);
    expect(parsed?.starttimeTicks).toBe(987654);
  });

  it("returns null for an empty line", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("   ")).toBeNull();
  });

  it("returns null when parentheses are missing (malformed line)", () => {
    expect(parseProcStat("1 node S 0 1")).toBeNull();
  });

  it("returns null when there are too few fields after comm (truncated/corrupted read)", () => {
    expect(parseProcStat("1 (node) S 0 1 1")).toBeNull();
  });
});

describe("parseProcStatusUid", () => {
  it("extracts the real uid (first of the four Uid: values)", () => {
    expect(parseProcStatusUid("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n")).toBe(1000);
  });

  it("returns undefined when the Uid: line is absent", () => {
    expect(parseProcStatusUid("Name:\tnode\n")).toBeUndefined();
  });
});

describe("resolveUsernameFromPasswd", () => {
  const passwd = "root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000:node:/home/node:/bin/sh\n";

  it("resolves a known uid to its username", () => {
    expect(resolveUsernameFromPasswd(passwd, 1000)).toBe("node");
    expect(resolveUsernameFromPasswd(passwd, 0)).toBe("root");
  });

  it("returns undefined for an uid absent from /etc/passwd (never a fabricated name)", () => {
    expect(resolveUsernameFromPasswd(passwd, 9999)).toBeUndefined();
  });
});

describe("parseListeningSockets", () => {
  // Ligne réelle de /proc/net/tcp : port 8080 (0x1F90) en LISTEN (st=0A), inode 12345.
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const listenLine =
    "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";
  // Connexion établie (st=01) : ne doit JAMAIS être remontée, seul LISTEN nous intéresse ici.
  const establishedLine =
    "   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 67890 1 0000000000000000 100 0 0 10 0";

  it("extracts only LISTEN sockets (st=0A) and decodes the hex port to decimal", () => {
    const sockets = parseListeningSockets(`${header}\n${listenLine}\n${establishedLine}\n`);
    expect(sockets).toEqual([{ port: 8080, inode: "12345" }]);
  });

  it("returns an empty list for empty/header-only input", () => {
    expect(parseListeningSockets("")).toEqual([]);
    expect(parseListeningSockets(header)).toEqual([]);
  });
});

describe("parseSocketInodeFromFdTarget", () => {
  it("extracts the inode from a socket fd symlink target", () => {
    expect(parseSocketInodeFromFdTarget("socket:[12345]")).toBe("12345");
  });

  it("returns undefined for a non-socket fd target (regular file, pipe...)", () => {
    expect(parseSocketInodeFromFdTarget("/var/log/app.log")).toBeUndefined();
    expect(parseSocketInodeFromFdTarget("pipe:[6789]")).toBeUndefined();
  });
});
