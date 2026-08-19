/**
 * Réconciliation d'inventaire QUAI <-> GLPI (CMDB) — construit PAR-DESSUS le client GLPI de base
 * (services/glpi.ts, livré en parallèle) sans jamais le modifier.
 *
 * Provenance des formes GLPI utilisées ici — API REST officielle `apirest.php` de GLPI 10
 * (CONFIRMÉ par la documentation publique, PAS encore vérifié sur l'instance réelle 172.16.8.22 :
 * l'app_token n'a pas été saisi, aucune requête réelle n'a été émise pendant le développement) :
 * `GET initSession` -> { session_token }, `GET <Itemtype>?range=a-b`, `POST Computer {input}`,
 * `PUT Computer/:id {input}`, `GET killSession`. Les enrichissements (ComputerVirtualMachine,
 * IPAddress, Item_OperatingSystem) sont BEST-EFFORT : indisponibles -> champ ABSENT partout, donc
 * jamais un écart (voir compareResource).
 */

import { redactSecrets } from "./glpi.js";
import { getEffectiveGlpiConfig } from "./setupStore.js";
import type { SetupGlpiConfig } from "./setupStore.js";
import { getNutanixClusters, getNutanixHosts, getNutanixVms, isNutanixConfigured, lastKnownNutanixPoll } from "./nutanix.js";
import type { NutanixHost, NutanixVm } from "../types.js";

const GLPI_TIMEOUT_MS = 8000;
const GLPI_PAGE_SIZE = 200;
const GLPI_MAX_PAGES = 50;

/** Marqueur de provenance écrit dans `comment` par POST /api/glpi/inventory/computers — seule
 * preuve VÉRIFIABLE qu'une fiche GLPI a été créée depuis QUAI (voir detectStale). */
export const QUAI_PROVENANCE_PREFIX = "QUAI-INVENTORY:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Contrat ---------------------------------------------------------------------------------

export type RealResourceKind = "nutanix-vm" | "nutanix-host";

/** Ressource RÉELLE connue de QUAI. Un champ absent = information non fournie par la source,
 * jamais une valeur par défaut fabriquée. */
export interface RealResource {
  kind: RealResourceKind;
  id: string;
  name: string;
  uuid?: string;
  serial?: string;
  /** vCPU pour une VM, cœurs physiques pour un hôte AHV. */
  vcpu?: number;
  memoryMib?: number;
  ipAddresses?: string[];
  operatingSystem?: string;
  cluster?: string;
  hostName?: string;
}

/** Fiche GLPI normalisée (objet Computer + enrichissements disponibles). */
export interface GlpiComputerRecord {
  id: number;
  name: string;
  uuid?: string;
  serial?: string;
  comment?: string;
  vcpu?: number;
  memoryMib?: number;
  ipAddresses?: string[];
  operatingSystem?: string;
  /** Nom du Computer hyperviseur portant la ligne ComputerVirtualMachine liée à cette fiche. */
  virtualizationHost?: string;
}

export type InventoryField = "name" | "uuid" | "serial" | "vcpu" | "memoryMib" | "ipAddresses" | "operatingSystem" | "host";

/** Champs réellement portés par l'objet Computer de GLPI — les seuls qu'un PATCH peut aligner. */
const FIXABLE_FIELDS: ReadonlySet<InventoryField> = new Set<InventoryField>(["name", "uuid", "serial"]);

const NOT_FIXABLE_REASON: Readonly<Record<string, string>> = {
  vcpu: "porté par ComputerVirtualMachine/Item_DeviceProcessor, pas par l'objet Computer",
  memoryMib: "porté par ComputerVirtualMachine/Item_DeviceMemory, pas par l'objet Computer",
  ipAddresses: "porté par NetworkPort/IPAddress, pas par l'objet Computer",
  operatingSystem: "porté par Item_OperatingSystem, pas par l'objet Computer",
  host: "porté par ComputerVirtualMachine (lien de virtualisation), pas par l'objet Computer",
};

export interface FieldDifference {
  field: InventoryField;
  glpiValue: string | number | string[];
  realValue: string | number | string[];
  fixable: boolean;
  reason?: string;
}

/** Champ présent d'un seul côté (ou d'aucun) — une ABSENCE, jamais un écart. */
export interface FieldAbsence {
  field: InventoryField;
  missingOn: "glpi" | "real" | "both";
}

export type MatchKey = "uuid" | "serial" | "name";

export interface MatchedPair {
  resource: RealResource;
  glpi: GlpiComputerRecord;
  matchedBy: MatchKey;
  differences: FieldDifference[];
  absences: FieldAbsence[];
}

export interface AmbiguousItem {
  resource?: RealResource;
  glpiCandidates: Array<{ id: number; name: string; uuid?: string }>;
  reason: string;
}

export type StaleScopeReason = "provenance-marker" | "glpi-virtual-machine-of-nutanix-host";

export interface StaleGlpiRecord {
  glpi: GlpiComputerRecord;
  scopeReason: StaleScopeReason;
  detail: string;
}

export interface ReconcileResult {
  missingInGlpi: RealResource[];
  drifted: MatchedPair[];
  inSync: MatchedPair[];
  staleInGlpi: StaleGlpiRecord[];
  ambiguous: AmbiguousItem[];
  outOfScopeGlpiCount: number;
}

export type EnrichmentState = "ok" | "unavailable" | "skipped";

export interface GlpiInventoryDiff extends ReconcileResult {
  generatedAt: string;
  glpi: { configured: boolean; reachable: boolean; computerCount: number; error?: string };
  nutanix: { configured: boolean; reachable: boolean; resourceCount: number };
  enrichment: { virtualMachines: EnrichmentState; ipAddresses: EnrichmentState; operatingSystems: EnrichmentState };
  counts: {
    real: number;
    glpiComputers: number;
    matched: number;
    inSync: number;
    drifted: number;
    missingInGlpi: number;
    staleInGlpi: number;
    ambiguous: number;
    outOfScopeGlpi: number;
  };
  /** true seulement si les deux inventaires ont été lus réellement — sinon aucune conclusion. */
  conclusive: boolean;
}

export class GlpiInventoryError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "GlpiInventoryError";
    this.httpStatus = httpStatus;
  }
}

// --- Configuration ---------------------------------------------------------------------------

/** Config déjà déchiffrée par setupStore.getEffectiveGlpiConfig() — même objet exact que le
 * client GLPI de base, aucune duplication de stockage. */
export type GlpiRuntimeConfig = SetupGlpiConfig;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isTruthyFlag(value: unknown): boolean {
  return value === 1 || value === true || value === "1" || value === "true";
}

/** Config effective (secrets déjà déchiffrés par setupStore) — `null` tant que GLPI n'a pas été
 * configuré OU si aucun moyen d'authentification n'est utilisable : aucune requête n'est alors
 * émise vers GLPI. */
export async function resolveGlpiConfig(): Promise<GlpiRuntimeConfig | null> {
  const cfg = await getEffectiveGlpiConfig();
  if (!cfg?.apiUrl || !cfg.appToken) return null;
  if (!cfg.userToken && !(cfg.username && cfg.password)) return null;
  return cfg;
}

// --- Client HTTP autonome (à factoriser avec services/glpi.ts) ---------------------------------

function glpiUrl(base: string, path: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${path.replace(/^\//, "")}`;
}

interface GlpiResponse {
  status: number;
  body: unknown;
  raw: string;
}

async function glpiFetch(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<GlpiResponse> {
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(GLPI_TIMEOUT_MS),
  });
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed, raw };
}

/** Session GLPI : App-Token + (user_token | Basic). Toujours refermée par killSession. */
async function glpiInitSession(cfg: GlpiRuntimeConfig): Promise<string> {
  const authorization = cfg.userToken
    ? `user_token ${cfg.userToken}`
    : cfg.username && cfg.password
      ? `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`
      : null;
  if (!authorization) {
    throw new GlpiInventoryError("GLPI est configuré sans jeton utilisateur ni identifiants — impossible d'ouvrir une session", 400);
  }

  const result = await glpiFetch(glpiUrl(cfg.apiUrl, "initSession"), "GET", { "App-Token": cfg.appToken, Authorization: authorization });
  if (result.status < 200 || result.status >= 300) {
    throw new GlpiInventoryError(`GLPI initSession a répondu ${result.status}: ${redactSecrets(result.raw.slice(0, 300), cfg)}`, 502);
  }
  const token = asString((result.body as Record<string, unknown> | null)?.["session_token"]);
  if (!token) {
    throw new GlpiInventoryError("GLPI initSession n'a pas renvoyé de session_token", 502);
  }
  return token;
}

async function glpiKillSession(cfg: GlpiRuntimeConfig, sessionToken: string): Promise<void> {
  try {
    await glpiFetch(glpiUrl(cfg.apiUrl, "killSession"), "GET", { "App-Token": cfg.appToken, "Session-Token": sessionToken });
  } catch {
    // Une session non refermée expire d'elle-même côté GLPI : jamais de quoi faire échouer l'appel.
  }
}

function sessionHeaders(cfg: GlpiRuntimeConfig, sessionToken: string): Record<string, string> {
  return { "App-Token": cfg.appToken, "Session-Token": sessionToken };
}

type GlpiRow = Record<string, unknown>;

/** Pagination `range=a-b` de l'API GLPI (200 complet / 206 partiel ; 400 ERROR_RANGE_EXCEED_TOTAL
 * quand l'offset dépasse le total, traité comme une fin de liste et non comme une panne). */
async function glpiListAll(cfg: GlpiRuntimeConfig, sessionToken: string, itemtype: string, extraQuery = ""): Promise<GlpiRow[]> {
  const rows: GlpiRow[] = [];
  for (let page = 0; page < GLPI_MAX_PAGES; page++) {
    const start = page * GLPI_PAGE_SIZE;
    const end = start + GLPI_PAGE_SIZE - 1;
    const url = glpiUrl(cfg.apiUrl, `${itemtype}?range=${start}-${end}${extraQuery}`);
    const result = await glpiFetch(url, "GET", sessionHeaders(cfg, sessionToken));
    if (result.status === 400 && result.raw.includes("ERROR_RANGE_EXCEED_TOTAL")) break;
    if (result.status < 200 || result.status >= 300) {
      throw new GlpiInventoryError(`GLPI GET ${itemtype} a répondu ${result.status}: ${redactSecrets(result.raw.slice(0, 300), cfg)}`, 502);
    }
    const page_rows = Array.isArray(result.body) ? (result.body as GlpiRow[]) : [];
    rows.push(...page_rows);
    if (page_rows.length < GLPI_PAGE_SIZE) break;
  }
  return rows;
}

// --- Lecture de l'inventaire GLPI --------------------------------------------------------------

interface GlpiSideRead {
  computers: GlpiComputerRecord[];
  enrichment: GlpiInventoryDiff["enrichment"];
}

function computerFromRow(row: GlpiRow): GlpiComputerRecord | null {
  const id = asNumber(row["id"]);
  if (id === undefined) return null;
  if (isTruthyFlag(row["is_deleted"]) || isTruthyFlag(row["is_template"])) return null;
  const name = asString(row["name"]);
  const uuid = asString(row["uuid"]);
  const serial = asString(row["serial"]);
  const comment = asString(row["comment"]);
  return {
    id,
    name: name ?? "",
    ...(uuid ? { uuid } : {}),
    ...(serial ? { serial } : {}),
    ...(comment ? { comment } : {}),
  };
}

/** Enrichissements best-effort : un itemtype refusé/absent laisse le champ ABSENT partout plutôt
 * que de faire échouer la réconciliation ou d'inventer une valeur. */
async function readGlpiSide(cfg: GlpiRuntimeConfig, sessionToken: string): Promise<GlpiSideRead> {
  const rows = await glpiListAll(cfg, sessionToken, "Computer");
  const computers = rows.map(computerFromRow).filter((c): c is GlpiComputerRecord => c !== null);
  const byId = new Map(computers.map((c) => [c.id, c]));
  const byUuid = new Map<string, GlpiComputerRecord[]>();
  for (const computer of computers) {
    if (!computer.uuid) continue;
    const key = computer.uuid.toLowerCase();
    byUuid.set(key, [...(byUuid.get(key) ?? []), computer]);
  }

  const enrichment: GlpiInventoryDiff["enrichment"] = { virtualMachines: "ok", ipAddresses: "ok", operatingSystems: "ok" };

  try {
    for (const row of await glpiListAll(cfg, sessionToken, "ComputerVirtualMachine")) {
      const uuid = asString(row["uuid"]);
      if (!uuid) continue;
      const targets = byUuid.get(uuid.toLowerCase());
      // uuid dupliqué côté GLPI : aucune attribution, on ne devine pas laquelle des fiches enrichir.
      if (!targets || targets.length !== 1) continue;
      const target = targets[0]!;
      const vcpu = asNumber(row["vcpu"]);
      const ram = asNumber(row["ram"]);
      const hostName = asString(byId.get(asNumber(row["computers_id"]) ?? -1)?.name);
      if (vcpu !== undefined && vcpu > 0) target.vcpu = vcpu;
      if (ram !== undefined && ram > 0) target.memoryMib = ram;
      if (hostName) target.virtualizationHost = hostName;
    }
  } catch {
    enrichment.virtualMachines = "unavailable";
  }

  try {
    const ipsByComputer = new Map<number, string[]>();
    for (const row of await glpiListAll(cfg, sessionToken, "IPAddress")) {
      const ip = asString(row["name"]);
      if (!ip) continue;
      const ownerId =
        row["mainitemtype"] === "Computer" ? asNumber(row["mainitems_id"]) : row["itemtype"] === "Computer" ? asNumber(row["items_id"]) : undefined;
      if (ownerId === undefined) continue;
      ipsByComputer.set(ownerId, [...(ipsByComputer.get(ownerId) ?? []), ip]);
    }
    for (const [computerId, ips] of ipsByComputer) {
      const target = byId.get(computerId);
      if (target) target.ipAddresses = ips;
    }
  } catch {
    enrichment.ipAddresses = "unavailable";
  }

  try {
    for (const row of await glpiListAll(cfg, sessionToken, "Item_OperatingSystem", "&expand_dropdowns=1")) {
      if (row["itemtype"] !== "Computer") continue;
      const target = byId.get(asNumber(row["items_id"]) ?? -1);
      // expand_dropdowns non appliqué -> l'id numérique brut n'est pas un nom d'OS, on l'ignore.
      const osName = asString(row["operatingsystems_id"]);
      if (target && osName) target.operatingSystem = osName;
    }
  } catch {
    enrichment.operatingSystems = "unavailable";
  }

  return { computers, enrichment };
}

// --- Lecture de l'inventaire réel (QUAI) -------------------------------------------------------

function vmToResource(vm: NutanixVm): RealResource {
  const ips = (vm.networks ?? []).flatMap((n) => n.ips);
  return {
    kind: "nutanix-vm",
    id: vm.id,
    name: vm.name,
    ...(UUID_RE.test(vm.id) ? { uuid: vm.id } : {}),
    ...(vm.numVcpus > 0 ? { vcpu: vm.numVcpus } : {}),
    ...(vm.memoryMib > 0 ? { memoryMib: vm.memoryMib } : {}),
    ...(ips.length > 0 ? { ipAddresses: ips } : {}),
    ...(vm.cluster ? { cluster: vm.cluster } : {}),
    ...(vm.hostName ? { hostName: vm.hostName } : {}),
  };
}

function hostToResource(host: NutanixHost, clusterNameByUuid: Map<string, string>): RealResource {
  const cluster = host.clusterUuid ? clusterNameByUuid.get(host.clusterUuid) : undefined;
  return {
    kind: "nutanix-host",
    id: host.id,
    name: host.name,
    ...(UUID_RE.test(host.id) ? { uuid: host.id } : {}),
    ...(typeof host.numCpuCores === "number" && host.numCpuCores > 0 ? { vcpu: host.numCpuCores } : {}),
    ...(typeof host.memoryCapacityMib === "number" && host.memoryCapacityMib > 0 ? { memoryMib: host.memoryCapacityMib } : {}),
    ...(host.hypervisorFullName ? { operatingSystem: host.hypervisorFullName } : {}),
    ...(cluster ? { cluster } : {}),
  };
}

export interface RealInventoryRead {
  resources: RealResource[];
  nutanixHostNames: string[];
  configured: boolean;
  reachable: boolean;
}

export async function readRealInventory(): Promise<RealInventoryRead> {
  if (!(await isNutanixConfigured())) {
    return { resources: [], nutanixHostNames: [], configured: false, reachable: false };
  }

  const [vms, hosts, clusters] = await Promise.all([getNutanixVms(), getNutanixHosts(), getNutanixClusters()]);
  const poll = lastKnownNutanixPoll();
  const reachable = poll?.reachable === true;
  const clusterNameByUuid = new Map(clusters.map((c) => [c.uuid, c.name]));
  const resources = [...vms.map(vmToResource), ...hosts.map((h) => hostToResource(h, clusterNameByUuid))];
  return { resources, nutanixHostNames: hosts.map((h) => h.name), configured: true, reachable };
}

// --- Rapprochement et comparaison --------------------------------------------------------------

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function candidateSummary(computer: GlpiComputerRecord): { id: number; name: string; uuid?: string } {
  return { id: computer.id, name: computer.name, ...(computer.uuid ? { uuid: computer.uuid } : {}) };
}

function indexBy(computers: GlpiComputerRecord[], pick: (c: GlpiComputerRecord) => string | undefined): Map<string, GlpiComputerRecord[]> {
  const index = new Map<string, GlpiComputerRecord[]>();
  for (const computer of computers) {
    const raw = pick(computer);
    if (!raw) continue;
    const key = normalized(raw);
    index.set(key, [...(index.get(key) ?? []), computer]);
  }
  return index;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map(normalized).sort();
  const right = [...b].map(normalized).sort();
  return left.every((value, i) => value === right[i]);
}

function difference(field: InventoryField, glpiValue: string | number | string[], realValue: string | number | string[]): FieldDifference {
  const fixable = FIXABLE_FIELDS.has(field);
  const reason = NOT_FIXABLE_REASON[field];
  return { field, glpiValue, realValue, fixable, ...(fixable || !reason ? {} : { reason }) };
}

function absence(field: InventoryField, hasGlpi: boolean, hasReal: boolean): FieldAbsence | null {
  if (hasGlpi && hasReal) return null;
  return { field, missingOn: !hasGlpi && !hasReal ? "both" : hasGlpi ? "real" : "glpi" };
}

/** Compare champ par champ. Un champ absent d'un côté n'est JAMAIS un écart : il est reporté
 * dans `absences`. */
export function compareResource(resource: RealResource, computer: GlpiComputerRecord): { differences: FieldDifference[]; absences: FieldAbsence[] } {
  const differences: FieldDifference[] = [];
  const absences: FieldAbsence[] = [];

  const texts: Array<[InventoryField, string | undefined, string | undefined]> = [
    ["name", asString(computer.name), asString(resource.name)],
    ["uuid", computer.uuid, resource.uuid],
    ["serial", computer.serial, resource.serial],
    ["operatingSystem", computer.operatingSystem, resource.operatingSystem],
    ["host", computer.virtualizationHost, resource.hostName],
  ];
  for (const [field, glpiValue, realValue] of texts) {
    const missing = absence(field, glpiValue !== undefined, realValue !== undefined);
    if (missing) {
      absences.push(missing);
      continue;
    }
    if (normalized(glpiValue!) !== normalized(realValue!)) differences.push(difference(field, glpiValue!, realValue!));
  }

  const numbers: Array<[InventoryField, number | undefined, number | undefined]> = [
    ["vcpu", computer.vcpu, resource.vcpu],
    ["memoryMib", computer.memoryMib, resource.memoryMib],
  ];
  for (const [field, glpiValue, realValue] of numbers) {
    const missing = absence(field, glpiValue !== undefined, realValue !== undefined);
    if (missing) {
      absences.push(missing);
      continue;
    }
    if (glpiValue !== realValue) differences.push(difference(field, glpiValue!, realValue!));
  }

  const glpiIps = computer.ipAddresses?.length ? computer.ipAddresses : undefined;
  const realIps = resource.ipAddresses?.length ? resource.ipAddresses : undefined;
  const ipMissing = absence("ipAddresses", glpiIps !== undefined, realIps !== undefined);
  if (ipMissing) absences.push(ipMissing);
  else if (!sameStringSet(glpiIps!, realIps!)) differences.push(difference("ipAddresses", glpiIps!, realIps!));

  return { differences, absences };
}

export function parseProvenanceMarker(comment: string | undefined): { kind: string; id: string } | null {
  if (!comment) return null;
  const match = new RegExp(`${QUAI_PROVENANCE_PREFIX}([a-z0-9-]+):(\\S+)`, "i").exec(comment);
  const kind = match?.[1];
  const id = match?.[2];
  return kind && id ? { kind, id } : null;
}

interface MatchOutcome {
  matched: MatchedPair[];
  missingInGlpi: RealResource[];
  ambiguous: AmbiguousItem[];
  consumedGlpiIds: Set<number>;
}

function matchResources(resources: RealResource[], computers: GlpiComputerRecord[]): MatchOutcome {
  const byUuid = indexBy(computers, (c) => c.uuid);
  const bySerial = indexBy(computers, (c) => c.serial);
  const byName = indexBy(computers, (c) => c.name);

  const realNameCounts = new Map<string, number>();
  for (const resource of resources) {
    const key = normalized(resource.name);
    realNameCounts.set(key, (realNameCounts.get(key) ?? 0) + 1);
  }

  const matched: MatchedPair[] = [];
  const missingInGlpi: RealResource[] = [];
  const ambiguous: AmbiguousItem[] = [];
  const consumedGlpiIds = new Set<number>();

  const pending: RealResource[] = [];

  // Passe 1 : uuid, puis 2 : numéro de série — clés stables, appliquées avant tout rapprochement
  // par nom pour qu'un homonyme ne vole jamais une fiche déjà identifiée de façon certaine.
  const keyPasses: Array<{ key: MatchKey; index: Map<string, GlpiComputerRecord[]>; pick: (r: RealResource) => string | undefined }> = [
    { key: "uuid", index: byUuid, pick: (r) => r.uuid },
    { key: "serial", index: bySerial, pick: (r) => r.serial },
  ];

  let queue = resources;
  for (const pass of keyPasses) {
    const next: RealResource[] = [];
    for (const resource of queue) {
      const raw = pass.pick(resource);
      if (!raw) {
        next.push(resource);
        continue;
      }
      const candidates = pass.index.get(normalized(raw)) ?? [];
      if (candidates.length === 0) {
        next.push(resource);
        continue;
      }
      if (candidates.length > 1) {
        ambiguous.push({
          resource,
          glpiCandidates: candidates.map(candidateSummary),
          reason: `${candidates.length} fiches GLPI partagent le même ${pass.key} "${raw}" — aucun appariement`,
        });
        continue;
      }
      const computer = candidates[0]!;
      if (consumedGlpiIds.has(computer.id)) {
        ambiguous.push({
          resource,
          glpiCandidates: [candidateSummary(computer)],
          reason: `la fiche GLPI #${computer.id} est déjà appariée à une autre ressource réelle — aucun appariement`,
        });
        continue;
      }
      consumedGlpiIds.add(computer.id);
      matched.push({ resource, glpi: computer, matchedBy: pass.key, ...compareResource(resource, computer) });
    }
    queue = next;
  }
  pending.push(...queue);

  // Passe 3 : nom exact ET unique des deux côtés, jamais approché.
  for (const resource of pending) {
    const key = normalized(resource.name);
    if ((realNameCounts.get(key) ?? 0) > 1) {
      ambiguous.push({
        resource,
        glpiCandidates: (byName.get(key) ?? []).map(candidateSummary),
        reason: `plusieurs ressources réelles portent le nom "${resource.name}" — nom non discriminant`,
      });
      continue;
    }
    const candidates = byName.get(key) ?? [];
    if (candidates.length === 0) {
      missingInGlpi.push(resource);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({
        resource,
        glpiCandidates: candidates.map(candidateSummary),
        reason: `${candidates.length} fiches GLPI portent le nom "${resource.name}" — aucun appariement`,
      });
      continue;
    }
    const computer = candidates[0]!;
    if (consumedGlpiIds.has(computer.id)) {
      ambiguous.push({
        resource,
        glpiCandidates: [candidateSummary(computer)],
        reason: `la fiche GLPI #${computer.id} est déjà appariée à une autre ressource réelle — aucun appariement`,
      });
      continue;
    }
    // Conflit d'identité : même nom mais uuid réels différents des deux côtés -> aucune conclusion.
    if (resource.uuid && computer.uuid && normalized(resource.uuid) !== normalized(computer.uuid)) {
      ambiguous.push({
        resource,
        glpiCandidates: [candidateSummary(computer)],
        reason: `nom identique mais uuid différents (GLPI "${computer.uuid}" vs réel "${resource.uuid}") — aucun appariement`,
      });
      continue;
    }
    consumedGlpiIds.add(computer.id);
    matched.push({ resource, glpi: computer, matchedBy: "name", ...compareResource(resource, computer) });
  }

  return { matched, missingInGlpi, ambiguous, consumedGlpiIds };
}

/** Une fiche n'est déclarée obsolète que si son appartenance au périmètre QUAI est PROUVÉE :
 * marqueur de provenance écrit par QUAI, ou lien de virtualisation GLPI vers un hôte Nutanix réel.
 * Tout le reste est compté hors périmètre, jamais signalé. */
function detectStale(
  computers: GlpiComputerRecord[],
  consumedGlpiIds: Set<number>,
  resources: RealResource[],
  nutanixHostNames: string[],
): { staleInGlpi: StaleGlpiRecord[]; outOfScopeGlpiCount: number } {
  const realIds = new Set(resources.map((r) => normalized(r.id)));
  const hostNames = new Set(nutanixHostNames.map(normalized));
  const staleInGlpi: StaleGlpiRecord[] = [];
  let outOfScopeGlpiCount = 0;

  for (const computer of computers) {
    if (consumedGlpiIds.has(computer.id)) continue;

    const marker = parseProvenanceMarker(computer.comment);
    if (marker && !realIds.has(normalized(marker.id))) {
      staleInGlpi.push({
        glpi: computer,
        scopeReason: "provenance-marker",
        detail: `fiche créée par QUAI pour ${marker.kind} ${marker.id}, cette ressource n'existe plus côté infrastructure`,
      });
      continue;
    }
    if (marker) {
      // Marqueur présent et ressource réelle toujours là, mais non appariée : c'est un cas ambigu
      // déjà remonté par matchResources, jamais une fiche obsolète.
      outOfScopeGlpiCount++;
      continue;
    }

    if (computer.virtualizationHost && hostNames.has(normalized(computer.virtualizationHost))) {
      staleInGlpi.push({
        glpi: computer,
        scopeReason: "glpi-virtual-machine-of-nutanix-host",
        detail: `GLPI la déclare VM de l'hôte Nutanix "${computer.virtualizationHost}", aucune VM réelle correspondante`,
      });
      continue;
    }

    outOfScopeGlpiCount++;
  }

  return { staleInGlpi, outOfScopeGlpiCount };
}

export function reconcileInventory(input: {
  resources: RealResource[];
  computers: GlpiComputerRecord[];
  nutanixHostNames: string[];
}): ReconcileResult {
  const { matched, missingInGlpi, ambiguous, consumedGlpiIds } = matchResources(input.resources, input.computers);
  const { staleInGlpi, outOfScopeGlpiCount } = detectStale(input.computers, consumedGlpiIds, input.resources, input.nutanixHostNames);
  return {
    missingInGlpi,
    drifted: matched.filter((pair) => pair.differences.length > 0),
    inSync: matched.filter((pair) => pair.differences.length === 0),
    staleInGlpi,
    ambiguous,
    outOfScopeGlpiCount,
  };
}

// --- État de réconciliation complet ------------------------------------------------------------

function emptyResult(): ReconcileResult {
  return { missingInGlpi: [], drifted: [], inSync: [], staleInGlpi: [], ambiguous: [], outOfScopeGlpiCount: 0 };
}

function buildDiff(
  result: ReconcileResult,
  meta: {
    glpi: GlpiInventoryDiff["glpi"];
    nutanix: GlpiInventoryDiff["nutanix"];
    enrichment: GlpiInventoryDiff["enrichment"];
    conclusive: boolean;
  },
): GlpiInventoryDiff {
  return {
    ...result,
    generatedAt: new Date().toISOString(),
    glpi: meta.glpi,
    nutanix: meta.nutanix,
    enrichment: meta.enrichment,
    conclusive: meta.conclusive,
    counts: {
      real: meta.nutanix.resourceCount,
      glpiComputers: meta.glpi.computerCount,
      matched: result.drifted.length + result.inSync.length,
      inSync: result.inSync.length,
      drifted: result.drifted.length,
      missingInGlpi: result.missingInGlpi.length,
      staleInGlpi: result.staleInGlpi.length,
      ambiguous: result.ambiguous.length,
      outOfScopeGlpi: result.outOfScopeGlpiCount,
    },
  };
}

const SKIPPED_ENRICHMENT: GlpiInventoryDiff["enrichment"] = { virtualMachines: "skipped", ipAddresses: "skipped", operatingSystems: "skipped" };

/** État de réconciliation complet. Ne conclut RIEN si l'un des deux inventaires n'a pas pu être lu
 * réellement (`conclusive: false`) : sans les VMs réelles, toute fiche GLPI paraîtrait obsolète. */
export async function getGlpiInventoryDiff(): Promise<GlpiInventoryDiff> {
  const cfg = await resolveGlpiConfig();
  if (!cfg) {
    const nutanixConfigured = await isNutanixConfigured();
    return buildDiff(emptyResult(), {
      glpi: { configured: false, reachable: false, computerCount: 0, error: "GLPI n'est pas configuré" },
      nutanix: { configured: nutanixConfigured, reachable: false, resourceCount: 0 },
      enrichment: SKIPPED_ENRICHMENT,
      conclusive: false,
    });
  }

  const real = await readRealInventory();
  if (!real.configured || !real.reachable) {
    return buildDiff(emptyResult(), {
      glpi: { configured: true, reachable: false, computerCount: 0, error: "inventaire réel indisponible, aucune comparaison tentée" },
      nutanix: { configured: real.configured, reachable: real.reachable, resourceCount: real.resources.length },
      enrichment: SKIPPED_ENRICHMENT,
      conclusive: false,
    });
  }

  let sessionToken: string | null = null;
  try {
    sessionToken = await glpiInitSession(cfg);
    const { computers, enrichment } = await readGlpiSide(cfg, sessionToken);
    const result = reconcileInventory({ resources: real.resources, computers, nutanixHostNames: real.nutanixHostNames });
    return buildDiff(result, {
      glpi: { configured: true, reachable: true, computerCount: computers.length },
      nutanix: { configured: true, reachable: true, resourceCount: real.resources.length },
      enrichment,
      conclusive: true,
    });
  } catch (err) {
    return buildDiff(emptyResult(), {
      glpi: { configured: true, reachable: false, computerCount: 0, error: err instanceof Error ? err.message : String(err) },
      nutanix: { configured: true, reachable: true, resourceCount: real.resources.length },
      enrichment: SKIPPED_ENRICHMENT,
      conclusive: false,
    });
  } finally {
    if (sessionToken) await glpiKillSession(cfg, sessionToken);
  }
}

// --- Écriture (jamais de suppression) ----------------------------------------------------------

/** Ligne de provenance + caractéristiques RÉELLES connues — uniquement des faits déjà lus. */
export function buildProvenanceComment(resource: RealResource): string {
  const facts: string[] = [];
  if (resource.vcpu !== undefined) facts.push(`${resource.vcpu} vCPU`);
  if (resource.memoryMib !== undefined) facts.push(`${resource.memoryMib} MiB`);
  if (resource.ipAddresses?.length) facts.push(`IP ${resource.ipAddresses.join(", ")}`);
  if (resource.operatingSystem) facts.push(`OS ${resource.operatingSystem}`);
  if (resource.cluster) facts.push(`cluster ${resource.cluster}`);
  if (resource.hostName) facts.push(`hôte ${resource.hostName}`);
  const marker = `${QUAI_PROVENANCE_PREFIX}${resource.kind}:${resource.id}`;
  return facts.length > 0 ? `${marker}\n${facts.join(" — ")}` : marker;
}

/** Champs envoyés à GLPI pour créer la fiche — uniquement ceux que l'objet Computer porte
 * réellement, jamais un identifiant de dropdown deviné. */
export function buildComputerCreateInput(resource: RealResource): Record<string, string> {
  return {
    name: resource.name,
    ...(resource.uuid ? { uuid: resource.uuid } : {}),
    ...(resource.serial ? { serial: resource.serial } : {}),
    comment: buildProvenanceComment(resource),
  };
}

export function buildComputerUpdateInput(computerId: number, differences: FieldDifference[], resource: RealResource): Record<string, string | number> {
  const input: Record<string, string | number> = { id: computerId };
  for (const diff of differences) {
    if (!diff.fixable) continue;
    if (diff.field === "name") input["name"] = resource.name;
    if (diff.field === "uuid" && resource.uuid) input["uuid"] = resource.uuid;
    if (diff.field === "serial" && resource.serial) input["serial"] = resource.serial;
  }
  return input;
}

interface ResolvedState {
  cfg: GlpiRuntimeConfig;
  sessionToken: string;
  real: RealInventoryRead;
  result: ReconcileResult;
}

async function openReconciledState(): Promise<ResolvedState> {
  const cfg = await resolveGlpiConfig();
  if (!cfg) throw new GlpiInventoryError("GLPI n'est pas configuré", 400);

  const real = await readRealInventory();
  if (!real.configured) throw new GlpiInventoryError("Nutanix n'est pas configuré — aucun inventaire réel à écrire dans GLPI", 400);
  if (!real.reachable) throw new GlpiInventoryError("Inventaire réel indisponible (Prism Central injoignable) — écriture refusée", 502);

  const sessionToken = await glpiInitSession(cfg);
  try {
    const { computers } = await readGlpiSide(cfg, sessionToken);
    const result = reconcileInventory({ resources: real.resources, computers, nutanixHostNames: real.nutanixHostNames });
    return { cfg, sessionToken, real, result };
  } catch (err) {
    await glpiKillSession(cfg, sessionToken);
    throw err;
  }
}

export interface CreateComputerOutcome {
  ok: true;
  computerId: number;
  input: Record<string, string>;
  resource: RealResource;
}

/** Crée la fiche GLPI d'une ressource réelle. Refuse si elle est déjà appariée (jamais de doublon)
 * ou si le rapprochement est ambigu. */
export async function createGlpiComputerForResource(resourceId: string): Promise<CreateComputerOutcome> {
  const state = await openReconciledState();
  try {
    const resource = state.real.resources.find((r) => r.id === resourceId);
    if (!resource) throw new GlpiInventoryError(`Ressource réelle "${resourceId}" introuvable dans l'inventaire QUAI`, 404);

    const alreadyMatched = [...state.result.drifted, ...state.result.inSync].find((pair) => pair.resource.id === resourceId);
    if (alreadyMatched) {
      throw new GlpiInventoryError(`La ressource "${resource.name}" est déjà rapprochée de la fiche GLPI #${alreadyMatched.glpi.id}`, 409);
    }
    const ambiguousItem = state.result.ambiguous.find((item) => item.resource?.id === resourceId);
    if (ambiguousItem) throw new GlpiInventoryError(`Rapprochement ambigu pour "${resource.name}" : ${ambiguousItem.reason}`, 409);

    const input = buildComputerCreateInput(resource);
    const response = await glpiFetch(glpiUrl(state.cfg.apiUrl, "Computer"), "POST", sessionHeaders(state.cfg, state.sessionToken), { input });
    if (response.status < 200 || response.status >= 300) {
      throw new GlpiInventoryError(`GLPI POST Computer a répondu ${response.status}: ${redactSecrets(response.raw.slice(0, 300), state.cfg)}`, 502);
    }
    const payload = Array.isArray(response.body) ? (response.body[0] as unknown) : response.body;
    const computerId = asNumber((payload as Record<string, unknown> | null)?.["id"]);
    if (computerId === undefined) throw new GlpiInventoryError("GLPI n'a pas renvoyé l'id de la fiche créée", 502);

    return { ok: true, computerId, input, resource };
  } finally {
    await glpiKillSession(state.cfg, state.sessionToken);
  }
}

export interface UpdateComputerOutcome {
  ok: true;
  computerId: number;
  input: Record<string, string | number>;
  appliedFields: InventoryField[];
  skippedFields: FieldDifference[];
}

/** Aligne sur le réel les champs dérivés que l'objet Computer de GLPI porte vraiment. Les écarts
 * non corrigeables (vCPU/RAM/IP/OS/hôte) sont renvoyés tels quels, jamais écrits ailleurs. */
export async function updateGlpiComputerForResource(computerId: number, resourceId: string, fields?: InventoryField[]): Promise<UpdateComputerOutcome> {
  const state = await openReconciledState();
  try {
    const pair = [...state.result.drifted, ...state.result.inSync].find((p) => p.resource.id === resourceId);
    if (!pair) {
      throw new GlpiInventoryError(`Aucun rapprochement certain entre la ressource "${resourceId}" et une fiche GLPI — mise à jour refusée`, 409);
    }
    if (pair.glpi.id !== computerId) {
      throw new GlpiInventoryError(`La ressource "${resourceId}" est rapprochée de la fiche GLPI #${pair.glpi.id}, pas #${computerId}`, 409);
    }

    const selected = fields?.length ? pair.differences.filter((d) => fields.includes(d.field)) : pair.differences;
    const fixable = selected.filter((d) => d.fixable);
    const skippedFields = selected.filter((d) => !d.fixable);
    if (fixable.length === 0) {
      throw new GlpiInventoryError(`Aucun écart corrigeable sur la fiche GLPI #${computerId} (les champs vCPU/RAM/IP/OS ne sont pas portés par l'objet Computer)`, 400);
    }

    const input = buildComputerUpdateInput(computerId, fixable, pair.resource);
    const response = await glpiFetch(glpiUrl(state.cfg.apiUrl, `Computer/${computerId}`), "PUT", sessionHeaders(state.cfg, state.sessionToken), { input });
    if (response.status < 200 || response.status >= 300) {
      throw new GlpiInventoryError(`GLPI PUT Computer/${computerId} a répondu ${response.status}: ${redactSecrets(response.raw.slice(0, 300), state.cfg)}`, 502);
    }

    return { ok: true, computerId, input, appliedFields: fixable.map((d) => d.field), skippedFields };
  } finally {
    await glpiKillSession(state.cfg, state.sessionToken);
  }
}
