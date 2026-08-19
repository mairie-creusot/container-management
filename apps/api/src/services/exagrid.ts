/**
 * Intégration ExaGrid (appliance de sauvegarde) — SNMP v2c/v3 uniquement : ExaGrid n'expose
 * AUCUNE API REST, la seule interface programmatique réelle est l'EXAGRID-MIB (entreprise
 * 1.3.6.1.4.1.14941), celle qu'utilisent DataDog/Centreon/LibreNMS. LECTURE SEULE STRICTE :
 * ce module n'émet QUE des SNMP GET, jamais un SET (l'appliance sauvegarde la production).
 *
 * Évolution possible (HORS de ce lot) : recevoir les traps SNMP (événements poussés par
 * l'appliance) imposerait d'écouter en UDP 162, donc de modifier le mapping de ports
 * docker-compose et de redémarrer la pile — l'état ici est donc uniquement obtenu par poll.
 */

import { AuthProtocols, PrivProtocols, SecurityLevel, Version2c, Version3, createSession, createV3Session, isVarbindError } from "net-snmp";
import type { Session, User, Varbind } from "net-snmp";
import { config } from "../config.js";
import { getEffectiveExagridConfig } from "./setupStore.js";
import type { SetupExagridConfig } from "./setupStore.js";

/** Port SNMP standard (RFC 3411) — défaut proposé, toujours surchargeable par la config. */
export const DEFAULT_SNMP_PORT = 161;

/** Gigaoctet DÉCIMAL (10^9) : unité de la partie entière des couples de l'EXAGRID-MIB. */
const GIGABYTE = 1e9;

/** TimeTicks = centièmes de seconde (RFC 2578). */
const TIMETICKS_PER_SECOND = 100;

const ENTERPRISE_OID = "1.3.6.1.4.1.14941";

/**
 * Objets RELEVÉS dans l'EXAGRID-MIB officielle (librenms/mibs/exagrid) et le profil DataDog —
 * chaque grandeur d'espace est un COUPLE (gigaoctets entiers + reste en octets), scalaires lus
 * avec l'instance `.0`. Aucun OID n'est deviné ici.
 */
const OID = {
  landingConfiguredGb: `${ENTERPRISE_OID}.4.1.1.0`,
  landingConfiguredRest: `${ENTERPRISE_OID}.4.1.2.0`,
  landingAvailableGb: `${ENTERPRISE_OID}.4.1.3.0`,
  landingAvailableRest: `${ENTERPRISE_OID}.4.1.4.0`,
  retentionConfiguredGb: `${ENTERPRISE_OID}.4.2.1.0`,
  retentionConfiguredRest: `${ENTERPRISE_OID}.4.2.2.0`,
  retentionAvailableGb: `${ENTERPRISE_OID}.4.2.3.0`,
  retentionAvailableRest: `${ENTERPRISE_OID}.4.2.4.0`,
  restorableGb: `${ENTERPRISE_OID}.4.3.1.0`,
  restorableRest: `${ENTERPRISE_OID}.4.3.2.0`,
  retentionConsumedGb: `${ENTERPRISE_OID}.4.3.3.0`,
  retentionConsumedRest: `${ENTERPRISE_OID}.4.3.4.0`,
  pendingDedupGb: `${ENTERPRISE_OID}.4.4.1.0`,
  pendingDedupRest: `${ENTERPRISE_OID}.4.4.2.0`,
  pendingDedupAgeTicks: `${ENTERPRISE_OID}.4.4.3.0`,
  pendingReplicationGb: `${ENTERPRISE_OID}.4.5.1.0`,
  pendingReplicationRest: `${ENTERPRISE_OID}.4.5.2.0`,
  pendingReplicationAgeTicks: `${ENTERPRISE_OID}.4.5.3.0`,
  alarmState: `${ENTERPRISE_OID}.4.6.1.0`,
} as const;

const ALL_OIDS: string[] = Object.values(OID);

/** OID le plus léger pour prouver qu'on parle bien à un ExaGrid (branche entreprise 14941). */
const PROBE_OID = OID.alarmState;

export type ExagridSnmpVersion = "2c" | "3";
export type ExagridSecurityLevel = "noAuthNoPriv" | "authNoPriv" | "authPriv";
export type ExagridAuthProtocol = "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
export type ExagridPrivProtocol = "des" | "aes" | "aes256b" | "aes256r";

export const EXAGRID_SECURITY_LEVELS: readonly ExagridSecurityLevel[] = ["noAuthNoPriv", "authNoPriv", "authPriv"];
export const EXAGRID_AUTH_PROTOCOLS: readonly ExagridAuthProtocol[] = ["md5", "sha", "sha224", "sha256", "sha384", "sha512"];
export const EXAGRID_PRIV_PROTOCOLS: readonly ExagridPrivProtocol[] = ["des", "aes", "aes256b", "aes256r"];

/** Espace (landing ou rétention) — `usedBytes`/`usedPct` DÉRIVÉS des lectures réelles, absents
 * si l'une des lectures manque (jamais un 0 de remplissage). */
export interface ExagridCapacity {
  configuredBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  usedPct?: number;
}

export interface ExagridBackupData {
  availableForRestoreBytes?: number;
  retentionConsumedBytes?: number;
}

export interface ExagridPendingWork {
  bytes?: number;
  ageSeconds?: number;
}

/** `raw` est TOUJOURS la valeur brute de l'OID d'alarme ; `state` n'existe que pour les trois
 * valeurs définies par la MIB (1/2/3) — aucune 4e étiquette n'est inventée. */
export interface ExagridAlarm {
  raw: number;
  state?: "ok" | "warning" | "error";
}

export interface ExagridReadings {
  landing: ExagridCapacity;
  retention: ExagridCapacity;
  backupData: ExagridBackupData;
  pendingDeduplication: ExagridPendingWork;
  pendingReplication: ExagridPendingWork;
  alarm?: ExagridAlarm;
}

/** Identité NON secrète de l'appliance — jamais community/authKey/privKey. */
export interface ExagridEndpoint {
  host: string;
  port: number;
  version: ExagridSnmpVersion;
  username?: string;
  securityLevel?: ExagridSecurityLevel;
  authProtocol?: ExagridAuthProtocol;
  privProtocol?: ExagridPrivProtocol;
}

export interface ExagridStatusSummary {
  configured: boolean;
  reachable?: boolean;
  endpoint?: ExagridEndpoint;
  readings?: ExagridReadings;
  /** Motif exact quand la config persistée est inutilisable (config.json édité à la main) —
   * jamais un secret, seulement le nom du champ fautif. */
  configError?: string;
}

export type ExagridConfigStatus = { configured: false } | { configured: true; config: ExagridEndpoint };

export interface ExagridPollOutcome {
  reachable: boolean;
  at: string;
}

let lastPollOutcome: ExagridPollOutcome | null = null;

/** Dernier essai RÉEL de poll — mémoire process, même rôle que lastKnownHycuPoll : distinguer
 * "aucune donnée" de "appliance injoignable". */
export function lastKnownExagridPoll(): ExagridPollOutcome | null {
  return lastPollOutcome;
}

function recordPoll(reachable: boolean): void {
  lastPollOutcome = { reachable, at: new Date().toISOString() };
}


/** Identité publiable d'une config — construite champ par champ, jamais par spread de la config
 * complète (un spread ferait fuiter community/authKey/privKey au premier ajout de champ). */
export function toExagridEndpoint(cfg: SetupExagridConfig): ExagridEndpoint {
  return {
    host: cfg.host,
    port: cfg.port,
    version: cfg.version,
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.securityLevel ? { securityLevel: cfg.securityLevel } : {}),
    ...(cfg.authProtocol ? { authProtocol: cfg.authProtocol } : {}),
    ...(cfg.privProtocol ? { privProtocol: cfg.privProtocol } : {}),
  };
}

/** Message d'erreur amont expurgé de toute valeur secrète, avant de sortir par une route. */
function redactSecrets(message: string, cfg: SetupExagridConfig): string {
  let out = message;
  for (const secret of [cfg.community, cfg.authKey, cfg.privKey]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

/** `null` si la config est utilisable, sinon le motif exact du refus (jamais un secret). */
export function validateExagridConfig(cfg: SetupExagridConfig): string | null {
  if (!cfg.host?.trim()) return "host est requis";
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) return "port doit être un entier entre 1 et 65535";
  if (cfg.version !== "2c" && cfg.version !== "3") return 'version doit valoir "2c" ou "3"';

  if (cfg.version === "2c") {
    if (!cfg.community) return "community est requis en SNMP v2c";
    return null;
  }

  if (!cfg.username?.trim()) return "username est requis en SNMP v3";
  if (!cfg.securityLevel || !EXAGRID_SECURITY_LEVELS.includes(cfg.securityLevel)) {
    return `securityLevel est requis en SNMP v3 (${EXAGRID_SECURITY_LEVELS.join(", ")})`;
  }
  if (cfg.securityLevel !== "noAuthNoPriv") {
    if (!cfg.authProtocol || !EXAGRID_AUTH_PROTOCOLS.includes(cfg.authProtocol)) {
      return `authProtocol est requis pour le niveau ${cfg.securityLevel} (${EXAGRID_AUTH_PROTOCOLS.join(", ")})`;
    }
    if (!cfg.authKey) return `authKey est requis pour le niveau ${cfg.securityLevel}`;
  }
  if (cfg.securityLevel === "authPriv") {
    if (!cfg.privProtocol || !EXAGRID_PRIV_PROTOCOLS.includes(cfg.privProtocol)) {
      return `privProtocol est requis pour le niveau authPriv (${EXAGRID_PRIV_PROTOCOLS.join(", ")})`;
    }
    if (!cfg.privKey) return "privKey est requis pour le niveau authPriv";
  }
  return null;
}

const SECURITY_LEVELS: Record<ExagridSecurityLevel, SecurityLevel> = {
  noAuthNoPriv: SecurityLevel.noAuthNoPriv,
  authNoPriv: SecurityLevel.authNoPriv,
  authPriv: SecurityLevel.authPriv,
};

const AUTH_PROTOCOLS: Record<ExagridAuthProtocol, AuthProtocols> = {
  md5: AuthProtocols.md5,
  sha: AuthProtocols.sha,
  sha224: AuthProtocols.sha224,
  sha256: AuthProtocols.sha256,
  sha384: AuthProtocols.sha384,
  sha512: AuthProtocols.sha512,
};

const PRIV_PROTOCOLS: Record<ExagridPrivProtocol, PrivProtocols> = {
  des: PrivProtocols.des,
  aes: PrivProtocols.aes,
  aes256b: PrivProtocols.aes256b,
  aes256r: PrivProtocols.aes256r,
};

function buildV3User(cfg: SetupExagridConfig): User {
  const level = SECURITY_LEVELS[cfg.securityLevel ?? "noAuthNoPriv"];
  return {
    name: cfg.username ?? "",
    level,
    ...(cfg.authProtocol ? { authProtocol: AUTH_PROTOCOLS[cfg.authProtocol] } : {}),
    ...(cfg.authKey ? { authKey: cfg.authKey } : {}),
    ...(cfg.privProtocol ? { privProtocol: PRIV_PROTOCOLS[cfg.privProtocol] } : {}),
    ...(cfg.privKey ? { privKey: cfg.privKey } : {}),
  };
}

function openSession(cfg: SetupExagridConfig): Session {
  const common = {
    port: cfg.port,
    transport: "udp4" as const,
    timeout: config.exagrid.requestTimeoutMs,
    retries: config.exagrid.retries,
  };
  if (cfg.version === "3") {
    return createV3Session(cfg.host, buildV3User(cfg), { ...common, version: Version3 });
  }
  return createSession(cfg.host, cfg.community ?? "", { ...common, version: Version2c });
}

/** SNMP GET (jamais SET) — une seule requête pour tous les OIDs demandés. */
async function snmpGet(cfg: SetupExagridConfig, oids: string[]): Promise<Varbind[]> {
  const session = openSession(cfg);
  try {
    return await new Promise<Varbind[]>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      session.on("error", fail);
      session.get(oids, (error, varbinds) => {
        if (error) return fail(error);
        if (settled) return;
        settled = true;
        resolve(varbinds ?? []);
      });
    });
  } finally {
    session.close();
  }
}

/** Valeurs numériques réellement lues — un varbind en erreur (noSuchObject/noSuchInstance) est
 * OMIS, jamais converti en 0. */
function numbersByOid(varbinds: Varbind[]): Map<string, number> {
  const byOid = new Map<string, number>();
  for (const varbind of varbinds) {
    if (isVarbindError(varbind)) continue;
    const value = varbind.value;
    if (typeof value === "number" && Number.isFinite(value)) byOid.set(varbind.oid, value);
    else if (typeof value === "bigint") byOid.set(varbind.oid, Number(value));
  }
  return byOid;
}

/** Recompose la valeur EXACTE en octets d'un couple (gigaoctets entiers, reste en octets).
 * Les DEUX moitiés sont exigées : sans elles la valeur serait fausse, pas approximative. */
function bytesFromPair(byOid: Map<string, number>, wholeOid: string, restOid: string): number | undefined {
  const whole = byOid.get(wholeOid);
  const rest = byOid.get(restOid);
  if (whole === undefined || rest === undefined) return undefined;
  return whole * GIGABYTE + rest;
}

function buildCapacity(configuredBytes: number | undefined, availableBytes: number | undefined): ExagridCapacity {
  const usedBytes =
    configuredBytes !== undefined && availableBytes !== undefined && availableBytes <= configuredBytes
      ? configuredBytes - availableBytes
      : undefined;
  const usedPct = usedBytes !== undefined && configuredBytes !== undefined && configuredBytes > 0 ? (usedBytes / configuredBytes) * 100 : undefined;
  return {
    ...(configuredBytes !== undefined ? { configuredBytes } : {}),
    ...(availableBytes !== undefined ? { availableBytes } : {}),
    ...(usedBytes !== undefined ? { usedBytes } : {}),
    ...(usedPct !== undefined ? { usedPct } : {}),
  };
}

function buildPendingWork(bytes: number | undefined, ticks: number | undefined): ExagridPendingWork {
  return {
    ...(bytes !== undefined ? { bytes } : {}),
    ...(ticks !== undefined ? { ageSeconds: ticks / TIMETICKS_PER_SECOND } : {}),
  };
}

/** 1 = aucune alarme, 2 = avertissement, 3 = erreur (EXAGRID-MIB) ; toute autre valeur reste
 * brute, sans étiquette inventée. */
export function mapExagridAlarm(raw: number): ExagridAlarm {
  if (raw === 1) return { raw, state: "ok" };
  if (raw === 2) return { raw, state: "warning" };
  if (raw === 3) return { raw, state: "error" };
  return { raw };
}

/** Projection des varbinds bruts en lectures nommées — exportée pour être testée sans réseau. */
export function readingsFromVarbinds(varbinds: Varbind[]): ExagridReadings {
  const byOid = numbersByOid(varbinds);
  const alarmRaw = byOid.get(OID.alarmState);
  const availableForRestoreBytes = bytesFromPair(byOid, OID.restorableGb, OID.restorableRest);
  const retentionConsumedBytes = bytesFromPair(byOid, OID.retentionConsumedGb, OID.retentionConsumedRest);
  return {
    landing: buildCapacity(
      bytesFromPair(byOid, OID.landingConfiguredGb, OID.landingConfiguredRest),
      bytesFromPair(byOid, OID.landingAvailableGb, OID.landingAvailableRest),
    ),
    retention: buildCapacity(
      bytesFromPair(byOid, OID.retentionConfiguredGb, OID.retentionConfiguredRest),
      bytesFromPair(byOid, OID.retentionAvailableGb, OID.retentionAvailableRest),
    ),
    backupData: {
      ...(availableForRestoreBytes !== undefined ? { availableForRestoreBytes } : {}),
      ...(retentionConsumedBytes !== undefined ? { retentionConsumedBytes } : {}),
    },
    pendingDeduplication: buildPendingWork(
      bytesFromPair(byOid, OID.pendingDedupGb, OID.pendingDedupRest),
      byOid.get(OID.pendingDedupAgeTicks),
    ),
    pendingReplication: buildPendingWork(
      bytesFromPair(byOid, OID.pendingReplicationGb, OID.pendingReplicationRest),
      byOid.get(OID.pendingReplicationAgeTicks),
    ),
    ...(alarmRaw !== undefined ? { alarm: mapExagridAlarm(alarmRaw) } : {}),
  };
}

/** Poll unique de TOUS les OIDs de l'EXAGRID-MIB — lève si l'appliance ne répond pas. */
export async function pollExagrid(cfg: SetupExagridConfig): Promise<ExagridReadings> {
  return readingsFromVarbinds(await snmpGet(cfg, ALL_OIDS));
}

/** true si ExaGrid a été explicitement configuré (même critère que GET /api/exagrid/config). */
export async function isExagridConfigured(): Promise<boolean> {
  return (await getEffectiveExagridConfig()) !== null;
}

export interface ExagridConnectionTest {
  ok: boolean;
  message: string;
  alarm?: ExagridAlarm;
}

/**
 * Teste une config candidate (pas encore persistée) sans modifier l'état applicatif — un seul
 * GET sur l'OID d'alarme : joignable, identifiants acceptés ET branche entreprise 14941 servie.
 */
export async function testExagridConnection(cfg: SetupExagridConfig): Promise<ExagridConnectionTest> {
  const invalid = validateExagridConfig(cfg);
  if (invalid) return { ok: false, message: invalid };
  try {
    const varbinds = await snmpGet(cfg, [PROBE_OID]);
    const probe = varbinds.find((v) => v.oid === PROBE_OID) ?? varbinds[0];
    if (!probe || isVarbindError(probe)) {
      return { ok: false, message: `L'hôte répond en SNMP mais ne sert pas l'EXAGRID-MIB (${PROBE_OID}) : ce n'est pas un ExaGrid, ou la MIB n'est pas exposée à cet utilisateur` };
    }
    const raw = typeof probe.value === "bigint" ? Number(probe.value) : probe.value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, message: `L'OID d'état d'alarme ${PROBE_OID} a renvoyé une valeur non numérique` };
    }
    return { ok: true, message: "L'appliance ExaGrid répond en SNMP", alarm: mapExagridAlarm(raw) };
  } catch (err) {
    const detail = redactSecrets(err instanceof Error ? err.message : String(err), cfg);
    return { ok: false, message: `Appliance ExaGrid injoignable : ${detail}` };
  }
}

/** Sonde de joignabilité de la config PERSISTÉE — false si jamais configurée. */
export async function isExagridReachable(): Promise<boolean> {
  const effective = await getEffectiveExagridConfig();
  if (!effective) return false;
  return (await testExagridConnection(effective)).ok;
}

/**
 * État complet pour GET /api/exagrid/status : `{ configured: false }` si jamais configuré,
 * `{ configured: true, reachable: false }` si injoignable (aucune capacité inventée).
 */
export async function getExagridStatus(): Promise<ExagridStatusSummary> {
  const effective = await getEffectiveExagridConfig();
  if (!effective) return { configured: false };
  const endpoint = toExagridEndpoint(effective);
  // Config persistée devenue inutilisable : jamais de poll à l'aveugle, et jamais un
  // "non configuré" qui contredirait GET /api/exagrid/config.
  const configError = validateExagridConfig(effective);
  if (configError) return { configured: true, reachable: false, endpoint, configError };
  try {
    const readings = await pollExagrid(effective);
    recordPoll(true);
    return { configured: true, reachable: true, endpoint, readings };
  } catch {
    recordPoll(false);
    return { configured: true, reachable: false, endpoint };
  }
}
