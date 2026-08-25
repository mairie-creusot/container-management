/**
 * Réception des traps SNMP émis par l'appliance ExaGrid (Configuration > SNMP Traps du côté
 * appliance, qui pousse vers `<hôte QUAI>:162`). Complément — pas remplacement — du poll de
 * services/exagrid.ts : un trap est un ÉVÉNEMENT, il ne porte jamais l'état d'occupation ni le
 * taux de déduplication. Sur les appliances dont l'agent SNMP interrogeable n'est pas activé,
 * c'est néanmoins la SEULE donnée réelle disponible (constaté le 24/08/2026).
 *
 * Décodage BER fait ici plutôt que délégué : la bibliothèque net-snmp du projet sert à émettre
 * des GET, sa surface "receiver" varie d'une version à l'autre, et un décodeur maison de ~100
 * lignes est entièrement testable hors réseau (voir test/exagridTraps.test.ts).
 *
 * LECTURE SEULE : ce module ne répond jamais à l'émetteur, il ne fait qu'écouter.
 */

import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";

/** Une variable d'un trap, telle que reçue — jamais réinterprétée. */
export interface TrapVarbind {
  oid: string;
  /** Valeur lisible ; les chaînes non imprimables sont rendues en hexadécimal. */
  value: string;
}

export interface ExagridTrap {
  /** Horodatage de RÉCEPTION (l'appliance n'envoie qu'un uptime relatif, jamais une date). */
  receivedAt: string;
  /** Adresse réelle de l'émetteur, telle que vue par la pile réseau. */
  source: string;
  /** OID de la notification (varbind snmpTrapOID.0) — absent si le trap n'en portait pas. */
  trapOid?: string;
  /** Uptime de l'agent au moment de l'émission, en secondes. */
  uptimeSeconds?: number;
  varbinds: TrapVarbind[];
}

const SNMP_TRAP_V2_TAG = 0xa7;
const SYS_UPTIME_OID = "1.3.6.1.2.1.1.3.0";
const SNMP_TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0";

class BerReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  /** Lit un TLV et renvoie son tag + son contenu. Lève si la longueur déborde du tampon. */
  read(): { tag: number; content: Buffer } {
    if (this.offset + 2 > this.buf.length) throw new Error("BER tronqué");
    const tag = this.buf[this.offset]!;
    let length = this.buf[this.offset + 1]!;
    this.offset += 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count === 0 || count > 4 || this.offset + count > this.buf.length) throw new Error("BER : longueur invalide");
      length = 0;
      for (let i = 0; i < count; i += 1) length = (length << 8) | this.buf[this.offset + i]!;
      this.offset += count;
    }
    if (this.offset + length > this.buf.length) throw new Error("BER : longueur au-delà du paquet");
    const content = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return { tag, content };
  }
}

function readInteger(content: Buffer): number {
  let value = 0;
  for (const byte of content) value = value * 256 + byte;
  return value;
}

function readOid(content: Buffer): string {
  if (content.length === 0) return "";
  const first = content[0]!;
  const parts = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (let i = 1; i < content.length; i += 1) {
    const byte = content[i]!;
    current = current * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  return parts.join(".");
}

/** Rend une valeur lisible sans jamais prétendre l'interpréter : texte si imprimable, sinon hex. */
function readValue(tag: number, content: Buffer): string {
  if (tag === 0x06) return readOid(content);
  if (tag === 0x02 || tag === 0x41 || tag === 0x42 || tag === 0x43 || tag === 0x46) return String(readInteger(content));
  if (tag === 0x40 && content.length === 4) return Array.from(content).join(".");
  if (tag === 0x05) return "";
  const text = content.toString("utf8");
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\r\n\t]*$/.test(text) ? text : `0x${content.toString("hex")}`;
}

/**
 * Décode un paquet SNMP v2c de type trap. Renvoie `null` — jamais d'exception — pour tout paquet
 * qui n'est pas un trap v2c exploitable ou dont la communauté ne correspond pas : le port est
 * ouvert sur le réseau, n'importe quoi peut y arriver.
 */
export function parseSnmpV2Trap(packet: Buffer, expectedCommunity?: string): Omit<ExagridTrap, "receivedAt" | "source"> | null {
  try {
    const outer = new BerReader(packet).read();
    if (outer.tag !== 0x30) return null;
    const body = new BerReader(outer.content);
    const version = body.read();
    if (version.tag !== 0x02 || readInteger(version.content) !== 1) return null; // 1 = v2c
    const community = body.read();
    if (community.tag !== 0x04) return null;
    if (expectedCommunity && community.content.toString("utf8") !== expectedCommunity) return null;

    const pdu = body.read();
    if (pdu.tag !== SNMP_TRAP_V2_TAG) return null;
    const pduReader = new BerReader(pdu.content);
    pduReader.read(); // request-id
    pduReader.read(); // error-status
    pduReader.read(); // error-index
    const varbindList = pduReader.read();
    if (varbindList.tag !== 0x30) return null;

    const varbinds: TrapVarbind[] = [];
    const listReader = new BerReader(varbindList.content);
    while (!listReader.done) {
      const entry = listReader.read();
      if (entry.tag !== 0x30) continue;
      const entryReader = new BerReader(entry.content);
      const oidField = entryReader.read();
      if (oidField.tag !== 0x06) continue;
      const valueField = entryReader.read();
      varbinds.push({ oid: readOid(oidField.content), value: readValue(valueField.tag, valueField.content) });
    }

    const uptime = varbinds.find((v) => v.oid === SYS_UPTIME_OID);
    const trapOid = varbinds.find((v) => v.oid === SNMP_TRAP_OID);
    return {
      ...(trapOid ? { trapOid: trapOid.value } : {}),
      ...(uptime ? { uptimeSeconds: Math.round(Number(uptime.value) / 100) } : {}),
      // Les deux varbinds protocolaires ci-dessus ne sont pas des données de l'appliance.
      varbinds: varbinds.filter((v) => v.oid !== SYS_UPTIME_OID && v.oid !== SNMP_TRAP_OID),
    };
  } catch {
    return null;
  }
}

/** Fenêtre glissante en mémoire — un trap est un événement, pas un état à conserver durablement. */
const MAX_TRAPS = 200;
let received: ExagridTrap[] = [];
let socket: Socket | null = null;

export function recordTrap(trap: ExagridTrap): void {
  received = [trap, ...received].slice(0, MAX_TRAPS);
}

/** Traps reçus, du plus récent au plus ancien. */
export function listExagridTraps(): ExagridTrap[] {
  return received;
}

export function resetExagridTrapsForTests(): void {
  received = [];
}

/**
 * Ouvre l'écoute UDP. Le port par défaut est volontairement > 1024 : l'API tourne sous un
 * utilisateur non root, incapable de se lier au 162 — c'est docker-compose qui publie
 * `162/udp` de l'hôte vers ce port. Ne lève jamais : une écoute impossible ne doit pas
 * empêcher l'API de démarrer.
 */
export async function startExagridTrapReceiver(port: number, community?: string): Promise<boolean> {
  if (socket) return true;
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (packet, remote) => {
      const parsed = parseSnmpV2Trap(packet, community);
      if (!parsed) return;
      recordTrap({ receivedAt: new Date().toISOString(), source: remote.address, ...parsed });
    });
    sock.on("error", (err) => {
      console.warn(`[exagrid] écoute des traps impossible sur le port ${port} : ${err.message}`);
      sock.close();
      socket = null;
      resolve(false);
    });
    sock.bind(port, () => {
      socket = sock;
      resolve(true);
    });
  });
}

export function stopExagridTrapReceiver(): void {
  socket?.close();
  socket = null;
}
