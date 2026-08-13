/**
 * Inspection RÉELLE des processus internes d'un conteneur, depuis SON PROPRE point de vue.
 *
 * POURQUOI CE FICHIER EXISTE (ne pas fusionner dans docker.ts) : `docker top` (voir
 * services/docker.ts#getContainerProcesses) retourne des PID côté HÔTE — c'est ce que le NOYAU
 * hôte voit, pas ce que le conteneur voit de lui-même. Un conteneur tourne dans son propre
 * namespace PID (`ns/pid`), isolé de l'hôte ET des autres conteneurs : même avec le socket Docker
 * monté, `/proc/<pid_hôte>` n'est PAS accessible depuis l'API (vérifié en direct : `ls
 * /proc/<pid_vu_par_docker_top>` depuis le conteneur API échoue avec "No such file or directory").
 * Les PID hôte de `docker top` sont donc INUTILISABLES pour un futur `docker exec <container>
 * kill <pid>` ou pour lire `/proc/<pid>/...` depuis l'INTÉRIEUR du conteneur cible.
 *
 * SEULE approche fiable : un VRAI `docker exec <container> sh -c "..."` (dockerode
 * `container.exec()`, exactement le même mécanisme que services/docker.ts#openContainerConsole/
 * services/cronJobsScheduler.ts#runCommandInContainer — jamais réinventé ici) qui lit DIRECTEMENT
 * `/proc/<pid>/{stat,status,fd/*}` DEPUIS L'INTÉRIEUR du conteneur cible : ces PID sont alors dans
 * SA PROPRE numérotation, la SEULE utilisable pour agir dessus ensuite. `ps` n'est volontairement
 * jamais utilisé (souvent absent des images minimales, vérifié en direct sur un conteneur réel de
 * ce dépôt) : uniquement des lectures brutes de /proc, disponibles dès qu'un shell POSIX existe.
 *
 * FORMAT DE /proc/<pid>/stat (`man 5 proc`) : `pid (comm) state ppid ... utime stime ...
 * starttime ...` — `comm` peut contenir espaces/parenthèses (ex: "(node --inspect)"), donc jamais
 * découpé naïvement par espace : on localise la PREMIÈRE '(' et la DERNIÈRE ')' pour l'isoler ;
 * les champs numériques après la dernière ')' se comptent alors depuis 0 : state=0, ppid=1,
 * utime=11, stime=12, starttime=19 (vérifié manuellement contre `man 5 proc` — pas une simple
 * copie de convention supposée).
 *
 * CLK_TCK (ticks/seconde, pour convertir utime/stime/starttime en secondes) : lu RÉELLEMENT via
 * `getconf CLK_TCK` DANS le conteneur cible à chaque appel plutôt que supposé 100 en dur (quasi
 * toujours vrai sur Linux mais jamais garanti).
 *
 * Âge réel d'un process = uptime système (1er nombre de /proc/uptime, LU DANS LE CONTENEUR CIBLE)
 * - (starttime en ticks / CLK_TCK).
 *
 * Utilisateur : premier uid de `Uid:` (`/proc/<pid>/status`, le "real uid") ; résolu en nom si
 * `/etc/passwd` est lisible dans le conteneur cible (best-effort — sinon l'uid brut, jamais un nom
 * inventé).
 *
 * Ports en LISTEN par process : `/proc/net/tcp`/`/proc/net/tcp6` (colonne `st`, "0A" = LISTEN,
 * colonne `inode`) croisés avec `/proc/<pid>/fd/*` (readlink -> "socket:[<inode>]") — croisement
 * RÉEL fait dans le conteneur cible, jamais deviné. Le port est encodé en hexadécimal dans
 * `local_address` ("host:port"), décodé ici en décimal.
 */

import { PassThrough } from "node:stream";
import { getClient, isDockerReachable } from "./docker.js";
import type { ContainerProcessDetail, ContainerProcessDetailList } from "../types.js";

// ---------------------------------------------------------------------------------------
// Parsing pur (sans I/O) — testé isolément (voir test/containerInternals.test.ts), le format
// exact de /proc étant justement le point le plus facile à se tromper silencieusement dessus.
// ---------------------------------------------------------------------------------------

export interface ParsedProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utimeTicks: number;
  stimeTicks: number;
  starttimeTicks: number;
}

/**
 * Parse une ligne brute de /proc/<pid>/stat — voir en-tête de fichier pour les indices de champs.
 * `null` si la ligne est vide/malformée (process disparu entre l'énumération et la lecture, par
 * exemple) : jamais une entrée à moitié fabriquée.
 */
export function parseProcStat(line: string): ParsedProcStat | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const firstParen = trimmed.indexOf("(");
  const lastParen = trimmed.lastIndexOf(")");
  if (firstParen === -1 || lastParen === -1 || lastParen < firstParen) return null;

  const pid = Number(trimmed.slice(0, firstParen).trim());
  const comm = trimmed.slice(firstParen + 1, lastParen);
  const rest = trimmed.slice(lastParen + 1).trim();
  const fields = rest.split(/\s+/);
  // Champs comptés depuis 0 APRÈS comm : state=0, ppid=1, utime=11, stime=12, starttime=19.
  if (fields.length < 20) return null;

  const state = fields[0]!;
  const ppid = Number(fields[1]);
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  const starttimeTicks = Number(fields[19]);

  if (
    !Number.isFinite(pid) ||
    !Number.isFinite(ppid) ||
    !Number.isFinite(utimeTicks) ||
    !Number.isFinite(stimeTicks) ||
    !Number.isFinite(starttimeTicks)
  ) {
    return null;
  }

  return { pid, comm, state, ppid, utimeTicks, stimeTicks, starttimeTicks };
}

/** Premier uid de la ligne `Uid:` de /proc/<pid>/status (le "real uid") — `undefined` si absente/illisible. */
export function parseProcStatusUid(statusContent: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(statusContent);
  if (!match) return undefined;
  const uid = Number(match[1]);
  return Number.isFinite(uid) ? uid : undefined;
}

/** Résout un uid en nom d'utilisateur depuis le contenu brut de /etc/passwd — `undefined` si
 * l'uid n'y figure pas (compte supprimé, uid arbitraire...). Best-effort, jamais un nom inventé. */
export function resolveUsernameFromPasswd(passwdContent: string, uid: number): string | undefined {
  for (const line of passwdContent.split("\n")) {
    const fields = line.split(":");
    // Format /etc/passwd : name:passwd:uid:gid:gecos:home:shell
    if (fields.length >= 3 && Number(fields[2]) === uid) return fields[0];
  }
  return undefined;
}

export interface ListeningSocket {
  port: number;
  inode: string;
}

/** Parse /proc/net/tcp ou /proc/net/tcp6 — ne garde QUE les sockets en LISTEN (st = "0A"), les
 * seules pertinentes pour "quel PID écoute quel port". Ignore la ligne d'en-tête ("sl ..."). */
export function parseListeningSockets(procNetTcpContent: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const rawLine of procNetTcpContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("sl")) continue;
    const cols = line.split(/\s+/);
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
    if (cols.length < 10) continue;
    const localAddress = cols[1];
    const state = cols[3];
    const inode = cols[9];
    if (state !== "0A" || !localAddress || !inode) continue; // 0A = TCP_LISTEN (voir include/net/tcp_states.h)
    const portHex = localAddress.split(":")[1];
    if (!portHex) continue;
    const port = Number.parseInt(portHex, 16);
    if (!Number.isFinite(port)) continue;
    sockets.push({ port, inode });
  }
  return sockets;
}

/** Extrait l'inode d'une cible `readlink` de /proc/<pid>/fd/N — `undefined` si ce fd n'est pas un socket. */
export function parseSocketInodeFromFdTarget(target: string): string | undefined {
  const match = /^socket:\[(\d+)\]$/.exec(target.trim());
  return match?.[1];
}

// ---------------------------------------------------------------------------------------
// Exécution réelle dans le conteneur cible.
// ---------------------------------------------------------------------------------------

/**
 * Script exécuté DANS le conteneur cible en un seul `docker exec` (même esprit que
 * services/docker.ts#LIST_DIR_SCRIPT : un aller-retour, une sortie structurée par marqueurs plutôt
 * que N exec séparés). `exit 0` explicite en fin de script : un process qui disparaît en cours de
 * scan (course normale) ne doit jamais faire échouer tout le relevé, seul un `sh` absent ou une
 * erreur d'exécution réelle du shell lui-même doit produire un code de sortie non-zéro.
 */
const PROCESS_DETAILS_SCRIPT = `echo "CLKTCK $(getconf CLK_TCK 2>/dev/null)"
echo "UPTIME $(cat /proc/uptime 2>/dev/null)"
echo "BEGIN_PASSWD"
cat /etc/passwd 2>/dev/null
echo "END_PASSWD"
echo "BEGIN_NET_TCP"
cat /proc/net/tcp 2>/dev/null
echo "END_NET_TCP"
echo "BEGIN_NET_TCP6"
cat /proc/net/tcp6 2>/dev/null
echo "END_NET_TCP6"
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  stat_line=$(cat /proc/$pid/stat 2>/dev/null) || continue
  [ -n "$stat_line" ] || continue
  echo "BEGIN_PID $pid"
  echo "STAT $stat_line"
  uid_line=$(grep '^Uid:' /proc/$pid/status 2>/dev/null)
  echo "UID_LINE $uid_line"
  for fd in /proc/$pid/fd/*; do
    [ -e "$fd" ] || continue
    target=$(readlink "$fd" 2>/dev/null)
    case "$target" in
      socket:*) echo "FD_SOCKET $target" ;;
    esac
  done
  echo "END_PID $pid"
done
exit 0
`;

interface RawExecOutput {
  stdout: string;
  exitCode: number | null;
}

/**
 * Lance PROCESS_DETAILS_SCRIPT dans le conteneur `containerId` — même mécanisme dockerode que
 * services/docker.ts#openContainerConsole/services/cronJobsScheduler.ts#runCommandInContainer
 * (container.exec + exec.start, Tty:false + démultiplexage stdout/stderr via docker.modem.
 * demuxStream). `sh` bare (pas "/bin/sh" en dur) : laisse Docker le résoudre via PATH comme le
 * ferait `docker exec <container> sh -c ...` en CLI, plus robuste qu'un chemin absolu supposé
 * (busybox n'est pas toujours à /bin/sh selon l'image) — absent du PATH -> le démon échoue
 * l'exec lui-même (catché ci-dessous) ou renvoie un code de sortie 127 ("command not found"),
 * les deux traduits en `shellAvailable: false`, jamais une exception qui masquerait ce cas très
 * normal (image "distroless"/scratch).
 */
async function execProcessDetailsScript(containerId: string): Promise<RawExecOutput> {
  const docker = await getClient();
  if (!(await isDockerReachable(docker))) {
    throw new Error("Docker daemon is not reachable");
  }
  const container = docker.getContainer(containerId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await container.inspect();
  if (info?.State?.Status !== "running") {
    throw new Error(`Container "${containerId}" is not running (state: ${info?.State?.Status ?? "unknown"})`);
  }

  const exec = await container.exec({
    Cmd: ["sh", "-c", PROCESS_DETAILS_SCRIPT],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream: NodeJS.ReadableStream = await exec.start({ hijack: true, Tty: false });
  const stdoutChunks: Buffer[] = [];
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough(); // stderr avalé volontairement : les erreurs `cat`/`readlink`
  // individuelles sur des process qui disparaissent en cours de scan sont attendues et sans intérêt.
  stdoutSink.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);

  await new Promise<void>((resolve) => {
    stream.once("end", () => resolve());
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspectResult: any = await exec.inspect();
  const exitCode: number | null = typeof inspectResult?.ExitCode === "number" ? inspectResult.ExitCode : null;
  return { stdout: Buffer.concat(stdoutChunks).toString("utf8"), exitCode };
}

/** Code de sortie POSIX standard "command not found" — Docker le renvoie quand `sh` n'existe pas
 * dans l'image cible (ni via un chemin absolu, ni résolu par PATH), sans lever d'exception. */
const EXIT_CODE_COMMAND_NOT_FOUND = 127;

/**
 * Parse la sortie structurée de PROCESS_DETAILS_SCRIPT ci-dessus. Reconstruit, par pid, sa ligne
 * stat + son premier uid + les inodes socket de ses fd — puis résout listenPorts en croisant avec
 * les sockets en LISTEN de /proc/net/tcp[6]. Best-effort par entrée (une ligne malformée n'écarte
 * que CETTE entrée, jamais tout le relevé) mais jamais de donnée fabriquée.
 */
function parseProcessDetailsOutput(stdout: string): ContainerProcessDetail[] {
  const lines = stdout.split("\n");

  let clkTck = 100; // repli seulement si `getconf CLK_TCK` n'a rien renvoyé (jamais supposé à l'avance ailleurs)
  let uptimeSeconds: number | undefined;
  const passwdLines: string[] = [];
  const netTcpLines: string[] = [];
  const netTcp6Lines: string[] = [];

  type PidAccumulator = { statLine?: string; uidLine?: string; socketInodes: string[] };
  const pidBlocks = new Map<number, PidAccumulator>();

  let section: "none" | "passwd" | "nettcp" | "nettcp6" | "pid" = "none";
  let currentPid: number | undefined;

  for (const rawLine of lines) {
    if (rawLine.startsWith("CLKTCK ")) {
      const value = Number(rawLine.slice("CLKTCK ".length).trim());
      if (Number.isFinite(value) && value > 0) clkTck = value;
      continue;
    }
    if (rawLine.startsWith("UPTIME ")) {
      const first = rawLine.slice("UPTIME ".length).trim().split(/\s+/)[0];
      const value = Number(first);
      if (Number.isFinite(value)) uptimeSeconds = value;
      continue;
    }
    if (rawLine === "BEGIN_PASSWD") {
      section = "passwd";
      continue;
    }
    if (rawLine === "END_PASSWD") {
      section = "none";
      continue;
    }
    if (rawLine === "BEGIN_NET_TCP") {
      section = "nettcp";
      continue;
    }
    if (rawLine === "END_NET_TCP") {
      section = "none";
      continue;
    }
    if (rawLine === "BEGIN_NET_TCP6") {
      section = "nettcp6";
      continue;
    }
    if (rawLine === "END_NET_TCP6") {
      section = "none";
      continue;
    }
    if (rawLine.startsWith("BEGIN_PID ")) {
      const pid = Number(rawLine.slice("BEGIN_PID ".length).trim());
      if (Number.isFinite(pid)) {
        currentPid = pid;
        pidBlocks.set(pid, { socketInodes: [] });
      }
      section = "pid";
      continue;
    }
    if (rawLine.startsWith("END_PID")) {
      currentPid = undefined;
      section = "none";
      continue;
    }

    if (section === "passwd") {
      passwdLines.push(rawLine);
    } else if (section === "nettcp") {
      netTcpLines.push(rawLine);
    } else if (section === "nettcp6") {
      netTcp6Lines.push(rawLine);
    } else if (section === "pid" && currentPid !== undefined) {
      const block = pidBlocks.get(currentPid);
      if (!block) continue;
      if (rawLine.startsWith("STAT ")) {
        block.statLine = rawLine.slice("STAT ".length);
      } else if (rawLine.startsWith("UID_LINE ")) {
        block.uidLine = rawLine.slice("UID_LINE ".length);
      } else if (rawLine.startsWith("FD_SOCKET ")) {
        const inode = parseSocketInodeFromFdTarget(rawLine.slice("FD_SOCKET ".length));
        if (inode) block.socketInodes.push(inode);
      }
    }
  }

  const passwdContent = passwdLines.join("\n");
  const listeningSockets = [...parseListeningSockets(netTcpLines.join("\n")), ...parseListeningSockets(netTcp6Lines.join("\n"))];
  const listenPortByInode = new Map<string, number[]>();
  for (const socket of listeningSockets) {
    const existing = listenPortByInode.get(socket.inode);
    if (existing) existing.push(socket.port);
    else listenPortByInode.set(socket.inode, [socket.port]);
  }

  const results: ContainerProcessDetail[] = [];
  for (const [, block] of pidBlocks) {
    if (!block.statLine) continue;
    const parsed = parseProcStat(block.statLine);
    if (!parsed) continue;

    const uid = block.uidLine ? parseProcStatusUid(block.uidLine) : undefined;
    const user = uid !== undefined ? (resolveUsernameFromPasswd(passwdContent, uid) ?? String(uid)) : "?";

    const cpuTimeMs = ((parsed.utimeTicks + parsed.stimeTicks) / clkTck) * 1000;
    const ageSeconds = uptimeSeconds !== undefined ? Math.max(0, uptimeSeconds - parsed.starttimeTicks / clkTck) : 0;

    const listenPortsSet = new Set<number>();
    for (const inode of block.socketInodes) {
      for (const port of listenPortByInode.get(inode) ?? []) listenPortsSet.add(port);
    }
    const listenPorts = listenPortsSet.size > 0 ? [...listenPortsSet].sort((a, b) => a - b) : undefined;

    results.push({
      pid: parsed.pid,
      ppid: parsed.ppid,
      user,
      command: parsed.comm,
      state: parsed.state,
      cpuTimeMs: Math.round(cpuTimeMs),
      ageSeconds: Math.round(ageSeconds),
      ...(listenPorts ? { listenPorts } : {}),
    });
  }

  results.sort((a, b) => b.cpuTimeMs - a.cpuTimeMs);
  return results;
}

/**
 * Processus RÉELS d'un conteneur, vus DEPUIS L'INTÉRIEUR de ce conteneur (voir en-tête de
 * fichier). Ne masque JAMAIS un échec par une liste vide : lève si le démon est injoignable, si le
 * conteneur n'existe pas/n'est pas démarré, ou si le script échoue pour une raison RÉELLE autre
 * que "shell absent" (code de sortie non-zéro ≠ 127) — `shellAvailable: false` est le SEUL cas où
 * une liste vide est un résultat normal et honnête (image sans aucun shell POSIX).
 */
export async function getContainerProcessDetails(id: string): Promise<ContainerProcessDetailList> {
  let raw: RawExecOutput;
  try {
    raw = await execProcessDetailsScript(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Docker peut refuser de créer/démarrer l'exec lui-même quand la commande est introuvable
    // (selon le runtime, cf. en-tête de execProcessDetailsScript) — mêmes textes qu'observés avec
    // dockerode/containerd pour "sh": executable file not found.
    if (/executable file not found|no such file or directory/i.test(message) && /sh/i.test(message)) {
      return { processes: [], shellAvailable: false };
    }
    throw err;
  }

  if (raw.exitCode === EXIT_CODE_COMMAND_NOT_FOUND) {
    return { processes: [], shellAvailable: false };
  }
  if (raw.exitCode !== 0 && raw.exitCode !== null) {
    throw new Error(`Process inspection script exited with code ${raw.exitCode} in container "${id}"`);
  }

  return { processes: parseProcessDetailsOutput(raw.stdout), shellAvailable: true };
}
