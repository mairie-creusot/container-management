/**
 * Intégration HYCU (contrôleur de sauvegarde des VMs Nutanix) — API REST `/rest/v1.0` sur :8443,
 * Basic Auth, HTTPS interne à certificat auto-signé (config.hycu.tlsRejectUnauthorized, même
 * périmètre limité que Nutanix). LECTURE SEULE STRICTE : ce module n'émet QUE des GET — aucune
 * mutation (backup/restore/policy/target) n'est implémentée, ni ne doit l'être dans ce fichier
 * sans une mission explicite : l'appliance réelle protège la production de la mairie.
 *
 * Sources des formes de réponses — honnêteté totale sur confirmé vs supposé :
 *  - CONFIRMÉ par le wrapper CLI tusc/hycu (https://github.com/tusc/hycu, scripts cités champ
 *    par champ dans test/hycu.test.ts) : enveloppe { entities: [], metadata: { totalEntityCount } },
 *    pagination ?pageSize=&pageNumber= (démarre à 1, search_backups.py), /vms (uuid, vmName,
 *    protectionGroupUuid), /policies (uuid, name), /targets (name, totalSizeInBytes,
 *    freeSizeInBytes, totalUtilizationPct), /jobs (status: EXECUTING/OK/WARNING/ERROR),
 *    /events (severity: ERROR/WARNING).
 *  - CONFIRMÉ en conditions réelles le 18/08/2026 sur l'appliance 172.20.0.100:8443 (v5.2.1-1025,
 *    SANS identifiants — GET non authentifiés uniquement) : /rest/v1.0/{vms,policies,targets,
 *    jobs,events,users} répondent 401 (chemins réels), /rest/v1.0/{dashboard,version} 404
 *    (n'existent PAS — d'où un résumé CALCULÉ côté QUAI plutôt qu'un endpoint dashboard supposé).
 *  - CONFIRMÉ depuis contre le vrai contrôleur : `externalId` (uuid de la VM côté hyperviseur) est
 *    la clé de rapprochement avec Nutanix, et le champ de conformité s'appelle `compliancyStatus`
 *    (et non `complianceStatus`, nom supposé de la première implémentation, gardé en repli).
 *  - SUPPOSÉ (typé optionnel, mappé seulement si présent, jamais inventé) : statut de protection
 *    et dernier backup par VM, métadonnées de jobs/events au-delà de status/severity — à confirmer
 *    lors de la première connexion authentifiée réelle.
 *
 * Gardes identiques à nutanix.ts : jamais configuré → null/[] (aucun jeu de démonstration HYCU) ;
 * configuré mais injoignable → [] + lastKnownHycuPoll() pour que l'UI distingue "vide" de "panne".
 */

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { config } from "../config.js";
import { loadHycuPluginConfig } from "../plugins/hycu/config.js";
import type { SetupHycuConfig } from "./setupStore.js";
import type { HycuEvent, HycuJob, HycuPolicy, HycuStatusSummary, HycuTarget, HycuVm, HycuVmProtectionState } from "../types.js";

/** Config HYCU effective si complète, sinon `null` — garde "jamais configuré" + valeur déjà
 * déchiffrée, même rôle exact que nutanix.ts#loadNutanixConfig. Depuis la migration en greffon,
 * la source est le stockage générique des intégrations (plugins/hycu/config.ts, qui reprend au
 * passage une configuration écrite avant la migration dans le champ typé `hycu`). */
async function loadHycuConfig(): Promise<SetupHycuConfig | null> {
  const effective = await loadHycuPluginConfig();
  if (!effective?.url || !effective.username || !effective.password) return null;
  return effective;
}

function normalizedBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * GET générique vers l'API REST HYCU — `node:https` plutôt que `fetch` pour désactiver la
 * vérification TLS uniquement pour cette connexion (config.hycu.tlsRejectUnauthorized), même
 * mécanisme exact que nutanix.ts#nutanixPost. Basic Auth (mécanisme confirmé par tusc/hycu :
 * `Authorization: Basic base64(user:pass)`, list_vm_backups_by_policy.sh).
 */
async function hycuGet<T>(url: string, path: string, username: string, password: string): Promise<{ status: number; data: T | null; raw: string }> {
  const target = new URL(path.replace(/^\//, ""), normalizedBaseUrl(url));
  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
        rejectUnauthorized: config.hycu.tlsRejectUnauthorized,
        timeout: config.hycu.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          try {
            resolve({ status, data: raw ? (JSON.parse(raw) as T) : null, raw });
          } catch (err) {
            reject(new Error(`HYCU API returned invalid JSON for GET ${path}: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`HYCU API request GET ${path} timed out after ${config.hycu.requestTimeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

// --- Formes (partielles) des réponses /rest/v1.0 — seuls les champs utilisés ici. Voir en-tête
// de fichier pour la provenance exacte (tusc/hycu) et le statut confirmé/supposé de chacun. ---

/** Enveloppe commune { entities, metadata.totalEntityCount } — confirmée par tusc/hycu
 * (search_backups.py) et cohérente avec le 401 réel observé ({ version, metadata, message }). */
interface HycuListResponse<E> {
  entities?: E[];
  metadata?: { totalEntityCount?: number };
}

/**
 * uuid/vmName/protectionGroupUuid confirmés (tusc/hycu) ; le reste supposé (voir en-tête), à deux
 * exceptions près CONFIRMÉES depuis contre le vrai contrôleur :
 *  - `externalId` : uuid de la VM côté hyperviseur — la clé de rapprochement avec Nutanix (`uuid`
 *    reste l'identifiant interne de l'objet HYCU, conservé tel quel) ;
 *  - `compliancyStatus` : le champ de conformité réel. `complianceStatus` (nom supposé de la
 *    première implémentation) est gardé en repli, jamais prioritaire.
 */
interface HycuVmEntity {
  uuid?: string;
  externalId?: string;
  vmName?: string;
  protectionGroupUuid?: string | null;
  protectionStatus?: string;
  compliancyStatus?: string;
  complianceStatus?: string;
  lastBackupInMillis?: number;
  status?: string;
}

interface HycuPolicyEntity {
  uuid?: string;
  name?: string;
}

/** name/totalSizeInBytes/freeSizeInBytes/totalUtilizationPct confirmés (get_target_pct.py/.sh) ;
 * uuid confirmé indirectement (get_target_pct.sh interroge /targets/$Target_UUID) ; type supposé. */
interface HycuTargetEntity {
  uuid?: string;
  name?: string;
  type?: string;
  totalSizeInBytes?: number;
  freeSizeInBytes?: number;
  totalUtilizationPct?: number;
}

/** status confirmé (get_error_warn.py, search_backups.py : EXECUTING/OK/WARNING/ERROR) ;
 * le reste supposé, mappé seulement si présent. */
interface HycuJobEntity {
  uuid?: string;
  name?: string;
  type?: string;
  status?: string;
  startTimeInMillis?: number;
  endTimeInMillis?: number;
}

/** severity confirmé (get_error_warn.sh : ERROR/WARNING) ; le reste supposé. */
interface HycuEventEntity {
  uuid?: string;
  severity?: string;
  message?: string;
  category?: string;
  createdInMillis?: number;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 20; // garde-fou : jamais une boucle infinie si totalEntityCount est incohérent

/**
 * Liste paginée complète — mécanisme exact de tusc/hycu#search_backups.py : pageNumber démarre
 * à 1, s'arrête quand toutes les entités annoncées par metadata.totalEntityCount sont récupérées
 * (ou qu'une page revient vide/incomplète — jamais une boucle infinie sur une réponse inattendue).
 */
async function hycuListAll<E>(effective: SetupHycuConfig, resource: string): Promise<E[]> {
  const items: E[] = [];
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const sep = resource.includes("?") ? "&" : "?";
    const result = await hycuGet<HycuListResponse<E>>(
      effective.url,
      `/rest/v1.0/${resource}${sep}pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}`,
      effective.username,
      effective.password,
    );
    if (result.status < 200 || result.status >= 300 || !result.data) {
      throw new Error(`HYCU API GET /rest/v1.0/${resource} failed with status ${result.status}: ${result.raw.slice(0, 300)}`);
    }
    const entities = result.data.entities ?? [];
    items.push(...entities);
    const total = result.data.metadata?.totalEntityCount;
    if (typeof total === "number" && items.length >= total) break;
    if (entities.length < PAGE_SIZE) break;
  }
  return items;
}

/** true si HYCU a été explicitement configuré (URL + identifiants complets) — pour le watchdog
 * et l'UI, même principe que isNutanixConfigured. */
export async function isHycuConfigured(): Promise<boolean> {
  return (await loadHycuConfig()) !== null;
}

/** Sonde de joignabilité (config persistée) — ne jamais appeler sans isHycuConfigured() d'abord. */
export async function isHycuReachable(): Promise<boolean> {
  const effective = await loadHycuConfig();
  if (!effective) return false;
  const result = await testHycuConnection(effective.url, effective.username, effective.password);
  return result.ok;
}

/**
 * Teste une config HYCU candidate (pas encore persistée) sans jamais modifier l'état applicatif —
 * GET /rest/v1.0/vms?pageSize=1 (lecture seule, léger). Chemin CONFIRMÉ en conditions réelles le
 * 18/08/2026 (401 sans identifiants sur l'appliance réelle — donc le chemin existe et un 401 ici
 * signifie précisément "identifiants refusés", distingué de "injoignable").
 */
export async function testHycuConnection(
  url: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; message: string; vmCount?: number }> {
  if (!url || !username || !password) {
    return { ok: false, message: "url, username et password sont requis" };
  }
  try {
    const result = await hycuGet<HycuListResponse<HycuVmEntity>>(url, "/rest/v1.0/vms?pageSize=1&pageNumber=1", username, password);
    if (result.status === 401) {
      return { ok: false, message: "HYCU a refusé les identifiants (401)" };
    }
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, message: `HYCU a répondu avec le statut ${result.status}: ${result.raw.slice(0, 200)}` };
    }
    const vmCount = result.data?.metadata?.totalEntityCount ?? result.data?.entities?.length ?? 0;
    return { ok: true, message: "Le contrôleur HYCU est joignable", vmCount };
  } catch (err) {
    return { ok: false, message: `Contrôleur HYCU injoignable : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Dernier essai RÉEL de poll HYCU — en mémoire process uniquement, même rôle exact que
 * nutanix.ts#NutanixPollOutcome : distinguer côté UI "liste vide" de "appliance injoignable". */
export interface HycuPollOutcome {
  reachable: boolean;
  at: string; // ISO 8601
}
let lastPollOutcome: HycuPollOutcome | null = null;
export function lastKnownHycuPoll(): HycuPollOutcome | null {
  return lastPollOutcome;
}

function recordPoll(reachable: boolean): void {
  lastPollOutcome = { reachable, at: new Date().toISOString() };
}

/** VM HYCU enrichie de `externalId` (uuid hyperviseur) : la clé de rapprochement Nutanix, portée
 * ici plutôt que dans le type public `HycuVm` — la page Sauvegardes n'en a aucun usage. */
export interface HycuVmWithExternalId extends HycuVm {
  externalId?: string;
}

function mapVmEntity(entity: HycuVmEntity, policyNameByUuid: Map<string, string>): HycuVmWithExternalId {
  const protectionGroupUuid = entity.protectionGroupUuid ?? undefined;
  const policyName = protectionGroupUuid ? policyNameByUuid.get(protectionGroupUuid) : undefined;
  // Champ réel d'abord, ancien nom supposé en repli — jamais l'inverse.
  const compliancy = entity.compliancyStatus ?? entity.complianceStatus;
  return {
    uuid: entity.uuid ?? "unknown-vm",
    ...(entity.externalId ? { externalId: entity.externalId } : {}),
    vmName: entity.vmName ?? "VM sans nom",
    ...(protectionGroupUuid ? { protectionGroupUuid } : {}),
    ...(policyName ? { policyName } : {}),
    ...(entity.protectionStatus ? { protectionStatus: entity.protectionStatus } : {}),
    ...(compliancy ? { complianceStatus: compliancy } : {}),
    ...(typeof entity.lastBackupInMillis === "number" ? { lastBackupInMillis: entity.lastBackupInMillis } : {}),
    ...(entity.status ? { status: entity.status } : {}),
  };
}

/**
 * VMs vues par HYCU, avec le nom de leur policy résolu par jointure /policies (UNE requête par
 * poll, jamais un appel par VM). [] si jamais configuré, [] si configuré mais injoignable —
 * jamais de fausses VMs.
 */
export async function getHycuVms(): Promise<HycuVm[]> {
  const effective = await loadHycuConfig();
  if (!effective) return [];
  try {
    const [vms, policies] = await Promise.all([
      hycuListAll<HycuVmEntity>(effective, "vms"),
      hycuListAll<HycuPolicyEntity>(effective, "policies"),
    ]);
    const policyNameByUuid = new Map<string, string>();
    for (const p of policies) {
      if (p.uuid && p.name) policyNameByUuid.set(p.uuid, p.name);
    }
    recordPoll(true);
    return vms.map((v) => mapVmEntity(v, policyNameByUuid));
  } catch {
    recordPoll(false);
    return [];
  }
}

/**
 * Policies HYCU avec le nombre de VMs assignées, CALCULÉ côté QUAI (VMs dont protectionGroupUuid
 * === uuid de la policy — mécanisme exact de tusc/hycu#list_vm_backups_by_policy.sh), jamais lu
 * d'un champ supposé. [] si jamais configuré/injoignable.
 */
export async function getHycuPolicies(): Promise<HycuPolicy[]> {
  const effective = await loadHycuConfig();
  if (!effective) return [];
  try {
    const [policies, vms] = await Promise.all([
      hycuListAll<HycuPolicyEntity>(effective, "policies"),
      hycuListAll<HycuVmEntity>(effective, "vms"),
    ]);
    const vmCountByPolicyUuid = new Map<string, number>();
    for (const vm of vms) {
      if (!vm.protectionGroupUuid) continue;
      vmCountByPolicyUuid.set(vm.protectionGroupUuid, (vmCountByPolicyUuid.get(vm.protectionGroupUuid) ?? 0) + 1);
    }
    recordPoll(true);
    return policies
      .filter((p): p is HycuPolicyEntity & { uuid: string } => Boolean(p.uuid))
      .map((p) => ({ uuid: p.uuid, name: p.name ?? p.uuid, vmCount: vmCountByPolicyUuid.get(p.uuid) ?? 0 }));
  } catch {
    recordPoll(false);
    return [];
  }
}

function mapTargetEntity(entity: HycuTargetEntity): HycuTarget {
  const total = typeof entity.totalSizeInBytes === "number" ? entity.totalSizeInBytes : undefined;
  const free = typeof entity.freeSizeInBytes === "number" ? entity.freeSizeInBytes : undefined;
  // used = total - free : calcul exact de tusc/hycu#get_target_pct.py — dérivé, jamais inventé.
  const used = total !== undefined && free !== undefined ? total - free : undefined;
  const pct =
    typeof entity.totalUtilizationPct === "number"
      ? entity.totalUtilizationPct
      : used !== undefined && total !== undefined && total > 0
        ? (used / total) * 100
        : undefined;
  return {
    ...(entity.uuid ? { uuid: entity.uuid } : {}),
    name: entity.name ?? "target sans nom",
    ...(entity.type ? { type: entity.type } : {}),
    ...(total !== undefined ? { totalSizeInBytes: total } : {}),
    ...(free !== undefined ? { freeSizeInBytes: free } : {}),
    ...(used !== undefined ? { usedSizeInBytes: used } : {}),
    ...(pct !== undefined ? { utilizationPct: pct } : {}),
  };
}

/** Targets de sauvegarde (nom, capacité/utilisation) — [] si jamais configuré/injoignable. */
export async function getHycuTargets(): Promise<HycuTarget[]> {
  const effective = await loadHycuConfig();
  if (!effective) return [];
  try {
    const targets = await hycuListAll<HycuTargetEntity>(effective, "targets");
    recordPoll(true);
    return targets.map(mapTargetEntity);
  } catch {
    recordPoll(false);
    return [];
  }
}

const RECENT_JOBS_PAGE_SIZE = 50;

/**
 * Jobs récents — UNE page (pageSize=50, même approche que tusc/hycu#get_error_warn.py qui lit
 * les 30 jobs les plus récents sur /jobs) : aucun paramètre de tri n'est envoyé (orderBy n'est
 * confirmé par tusc/hycu que pour /vms/{uuid}/backups, jamais pour /jobs — on ne suppose pas un
 * query param qui pourrait être refusé). Lève en cas d'échec (les appelants publics retombent
 * sur [] ; getHycuStatus doit VOIR l'échec plutôt que compter des jobs à zéro).
 */
async function fetchRecentJobs(effective: SetupHycuConfig): Promise<HycuJob[]> {
  const result = await hycuGet<HycuListResponse<HycuJobEntity>>(
    effective.url,
    `/rest/v1.0/jobs?pageSize=${RECENT_JOBS_PAGE_SIZE}&pageNumber=1`,
    effective.username,
    effective.password,
  );
  if (result.status < 200 || result.status >= 300 || !result.data) {
    throw new Error(`HYCU API GET /rest/v1.0/jobs failed with status ${result.status}`);
  }
  return (result.data.entities ?? [])
    .filter((j): j is HycuJobEntity & { status: string } => Boolean(j.status))
    .map((j) => ({
      ...(j.uuid ? { uuid: j.uuid } : {}),
      ...(j.name ? { name: j.name } : {}),
      ...(j.type ? { type: j.type } : {}),
      status: j.status,
      ...(typeof j.startTimeInMillis === "number" ? { startTimeInMillis: j.startTimeInMillis } : {}),
      ...(typeof j.endTimeInMillis === "number" ? { endTimeInMillis: j.endTimeInMillis } : {}),
    }));
}

/** Jobs récents — [] si jamais configuré/injoignable (voir fetchRecentJobs). */
export async function getHycuJobs(): Promise<HycuJob[]> {
  const effective = await loadHycuConfig();
  if (!effective) return [];
  try {
    const jobs = await fetchRecentJobs(effective);
    recordPoll(true);
    return jobs;
  } catch {
    recordPoll(false);
    return [];
  }
}

const RECENT_EVENTS_PAGE_SIZE = 50;

/** Événements récents — même approche qu'getHycuJobs (une page, pas de tri supposé). [] si
 * jamais configuré/injoignable. */
export async function getHycuEvents(): Promise<HycuEvent[]> {
  const effective = await loadHycuConfig();
  if (!effective) return [];
  try {
    const result = await hycuGet<HycuListResponse<HycuEventEntity>>(
      effective.url,
      `/rest/v1.0/events?pageSize=${RECENT_EVENTS_PAGE_SIZE}&pageNumber=1`,
      effective.username,
      effective.password,
    );
    if (result.status < 200 || result.status >= 300 || !result.data) {
      throw new Error(`HYCU API GET /rest/v1.0/events failed with status ${result.status}`);
    }
    recordPoll(true);
    return (result.data.entities ?? [])
      .filter((e): e is HycuEventEntity & { severity: string } => Boolean(e.severity))
      .map((e) => ({
        ...(e.uuid ? { uuid: e.uuid } : {}),
        severity: e.severity,
        ...(e.message ? { message: e.message } : {}),
        ...(e.category ? { category: e.category } : {}),
        ...(typeof e.createdInMillis === "number" ? { createdInMillis: e.createdInMillis } : {}),
      }));
  } catch {
    recordPoll(false);
    return [];
  }
}

const JOB_STATUS_ERROR = "ERROR";

/** Libellés de conformité considérés SAINS — même convention exacte que la page Sauvegardes
 * (apps/web/src/features/hycu/HycuPage.tsx#COMPLIANT_VALUES) : `complianceStatus` est un champ
 * supposé, une valeur inconnue vaut donc "non conforme" plutôt qu'un silence rassurant. */
const COMPLIANT_VALUES = new Set(["COMPLIANT", "OK", "GREEN", "PROTECTED"]);

/**
 * État de protection d'UNE VM à partir des SEULES données réellement renvoyées (voir
 * types.ts#HycuVmProtectionState). `lastBackupFieldPresent` vaut true quand au moins une VM du
 * MÊME poll porte `lastBackupInMillis` : sans cette preuve que l'API la renseigne, une date
 * absente n'autorise jamais à conclure "jamais sauvegardée".
 */
export function hycuVmProtectionState(vm: HycuVm, lastBackupFieldPresent: boolean): HycuVmProtectionState {
  if (!vm.protectionGroupUuid) return "unprotected";
  if (vm.complianceStatus && !COMPLIANT_VALUES.has(vm.complianceStatus.toUpperCase())) return "non-compliant";
  if (lastBackupFieldPresent && typeof vm.lastBackupInMillis !== "number") return "never-backed-up";
  return "protected";
}

/** Instantané pour le graphe de topologie — UN SEUL poll pour le nœud HYCU, ses compteurs et les
 * arêtes de protection (jamais getHycuStatus + getHycuVms, qui rappelleraient /vms et /policies). */
export interface HycuTopologySnapshot {
  url: string;
  reachable: boolean;
  /** VMs vues par HYCU, policy résolue — [] si injoignable. `externalId` (uuid hyperviseur) est
   * porté quand l'appliance le renseigne : c'est la clé de rapprochement avec Nutanix. */
  vms: HycuVmWithExternalId[];
  /** Voir hycuVmProtectionState ci-dessus — false si injoignable/aucune VM n'expose la date. */
  lastBackupFieldPresent: boolean;
  /** Compteurs réels du poll — absents si injoignable, jamais des zéros de remplissage. */
  counts?: { vms: number; protectedVms: number; policies: number; targets: number; recentJobs: number; failedJobs: number };
}

/** `null` si HYCU n'a JAMAIS été configuré (aucun nœud dans le graphe) ; `reachable: false` si
 * configuré mais injoignable (nœud honnêtement "stopped", sans compteur). LECTURE SEULE. */
export async function getHycuTopologySnapshot(): Promise<HycuTopologySnapshot | null> {
  const effective = await loadHycuConfig();
  if (!effective) return null;
  try {
    const [vms, policies, targets, jobs] = await Promise.all([
      hycuListAll<HycuVmEntity>(effective, "vms"),
      hycuListAll<HycuPolicyEntity>(effective, "policies"),
      hycuListAll<HycuTargetEntity>(effective, "targets"),
      fetchRecentJobs(effective),
    ]);
    const policyNameByUuid = new Map<string, string>();
    for (const p of policies) {
      if (p.uuid && p.name) policyNameByUuid.set(p.uuid, p.name);
    }
    const mapped = vms.map((v) => mapVmEntity(v, policyNameByUuid));
    recordPoll(true);
    return {
      url: effective.url,
      reachable: true,
      vms: mapped,
      lastBackupFieldPresent: mapped.some((v) => typeof v.lastBackupInMillis === "number"),
      counts: {
        vms: mapped.length,
        protectedVms: mapped.filter((v) => Boolean(v.protectionGroupUuid)).length,
        policies: policies.length,
        targets: targets.length,
        recentJobs: jobs.length,
        failedJobs: jobs.filter((j) => j.status.toUpperCase() === JOB_STATUS_ERROR).length,
      },
    };
  } catch {
    recordPoll(false);
    return { url: effective.url, reachable: false, vms: [], lastBackupFieldPresent: false };
  }
}

/**
 * Résumé dashboard CALCULÉ côté QUAI à partir des listes réelles (/rest/v1.0/dashboard n'existe
 * PAS — 404 confirmé en conditions réelles, voir en-tête) :
 *  - vms.protectedCount = VMs avec un protectionGroupUuid (assignées à une policy) — champ
 *    confirmé, calcul honnête ; le % protection affiché par le dashboard HYCU réel reste à
 *    rapprocher de ce calcul lors de la première connexion authentifiée.
 *  - jobs.byStatus = comptage brut des `status` réels (EXECUTING/OK/WARNING/ERROR...), jamais
 *    une taxonomie inventée.
 *  - targets = sommes des capacités réelles.
 * `{ configured: false }` si jamais configuré ; `{ configured: true, reachable: false }` si
 * injoignable — blocs absents plutôt que des zéros inventés.
 */
export async function getHycuStatus(): Promise<HycuStatusSummary> {
  const effective = await loadHycuConfig();
  if (!effective) return { configured: false };
  try {
    const [vms, policies, targets, jobs] = await Promise.all([
      hycuListAll<HycuVmEntity>(effective, "vms"),
      hycuListAll<HycuPolicyEntity>(effective, "policies"),
      hycuListAll<HycuTargetEntity>(effective, "targets"),
      fetchRecentJobs(effective),
    ]);
    const protectedCount = vms.filter((v) => Boolean(v.protectionGroupUuid)).length;
    const byStatus: Record<string, number> = {};
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }
    const mappedTargets = targets.map(mapTargetEntity);
    const totalSizeInBytes = mappedTargets.reduce((sum, t) => sum + (t.totalSizeInBytes ?? 0), 0);
    const usedSizeInBytes = mappedTargets.reduce((sum, t) => sum + (t.usedSizeInBytes ?? 0), 0);
    recordPoll(true);
    return {
      configured: true,
      reachable: true,
      vms: { total: vms.length, protectedCount },
      policies: { count: policies.length },
      targets: { count: targets.length, totalSizeInBytes, usedSizeInBytes },
      jobs: { total: jobs.length, byStatus },
    };
  } catch {
    recordPoll(false);
    return { configured: true, reachable: false };
  }
}
