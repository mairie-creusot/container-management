import { beforeEach, describe, expect, it } from "vitest";
import { listExagridTraps, parseSnmpV2Trap, recordTrap, resetExagridTrapsForTests } from "../src/services/exagridTraps.js";

/** Encodage BER minimal, uniquement pour fabriquer des paquets de test réalistes. */
function tlv(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  const lenBytes = [];
  let len = content.length;
  while (len > 0) {
    lenBytes.unshift(len & 0xff);
    len >>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | lenBytes.length, ...lenBytes]), content]);
}
const int = (v: number) => tlv(0x02, Buffer.from(v > 0xff ? [v >> 8, v & 0xff] : [v]));
const str = (v: string) => tlv(0x04, Buffer.from(v, "utf8"));
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    if (part < 128) bytes.push(part);
    else {
      const chunks = [];
      let v = part;
      while (v > 0) {
        chunks.unshift(v & 0x7f);
        v >>= 7;
      }
      for (let i = 0; i < chunks.length - 1; i += 1) chunks[i]! |= 0x80;
      bytes.push(...chunks);
    }
  }
  return tlv(0x06, Buffer.from(bytes));
}
const varbind = (o: string, value: Buffer) => tlv(0x30, Buffer.concat([oid(o), value]));

function trapPacket(community: string, extra: Buffer[] = []): Buffer {
  const varbinds = tlv(
    0x30,
    Buffer.concat([
      varbind("1.3.6.1.2.1.1.3.0", tlv(0x43, Buffer.from([0x00, 0x0f, 0x42, 0x40]))), // uptime = 1 000 000 centièmes
      varbind("1.3.6.1.6.3.1.1.4.1.0", oid("1.3.6.1.4.1.14941.1.2")),
      ...extra,
    ]),
  );
  const pdu = tlv(0xa7, Buffer.concat([int(1), int(0), int(0), varbinds]));
  return tlv(0x30, Buffer.concat([int(1), str(community), pdu]));
}

describe("traps SNMP ExaGrid", () => {
  beforeEach(() => resetExagridTrapsForTests());

  it("décode un trap v2c réel : notification, uptime et variables de l'appliance", () => {
    const packet = trapPacket("mairie", [varbind("1.3.6.1.4.1.14941.3.1", str("Replication behind schedule"))]);

    const parsed = parseSnmpV2Trap(packet, "mairie");

    expect(parsed).not.toBeNull();
    expect(parsed?.trapOid).toBe("1.3.6.1.4.1.14941.1.2");
    expect(parsed?.uptimeSeconds).toBe(10_000);
    // Les deux varbinds protocolaires ne sont pas des données de l'appliance : ils n'apparaissent pas.
    expect(parsed?.varbinds).toEqual([{ oid: "1.3.6.1.4.1.14941.3.1", value: "Replication behind schedule" }]);
  });

  it("refuse un paquet dont la communauté ne correspond pas (le port est ouvert sur le réseau)", () => {
    expect(parseSnmpV2Trap(trapPacket("autre-chose"), "mairie")).toBeNull();
  });

  it("accepte n'importe quelle communauté quand aucune n'est configurée", () => {
    expect(parseSnmpV2Trap(trapPacket("public"))).not.toBeNull();
  });

  it("ne lève jamais sur un paquet corrompu, tronqué ou étranger au protocole", () => {
    expect(parseSnmpV2Trap(Buffer.from("n'importe quoi"))).toBeNull();
    expect(parseSnmpV2Trap(Buffer.alloc(0))).toBeNull();
    expect(parseSnmpV2Trap(trapPacket("x").subarray(0, 12))).toBeNull();
    // Longueur BER annoncée au-delà du paquet : rejet, jamais une lecture hors limites.
    expect(parseSnmpV2Trap(Buffer.from([0x30, 0x7f, 0x02, 0x01, 0x01]))).toBeNull();
  });

  it("ignore un paquet qui n'est pas un trap (une réponse GET n'a rien à faire ici)", () => {
    const getResponse = tlv(0x30, Buffer.concat([int(1), str("mairie"), tlv(0xa2, Buffer.concat([int(1), int(0), int(0), tlv(0x30, Buffer.alloc(0))]))]));
    expect(parseSnmpV2Trap(getResponse, "mairie")).toBeNull();
  });

  it("conserve les traps du plus récent au plus ancien, sans croissance illimitée", () => {
    for (let i = 0; i < 250; i += 1) {
      recordTrap({ receivedAt: new Date(i).toISOString(), source: "172.20.0.101", varbinds: [{ oid: "1.2", value: String(i) }] });
    }
    const traps = listExagridTraps();
    expect(traps).toHaveLength(200);
    expect(traps[0]?.varbinds[0]?.value).toBe("249");
  });
});
