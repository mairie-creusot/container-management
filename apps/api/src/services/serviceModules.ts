/**
 * MODULES MÉTIER PAR NŒUD — registre générique (19/08/2026).
 *
 * Un "module" est la vue métier d'un service réel porté par un nœud du graphe (3CX sur la VM
 * HDV3CX, AD/DNS sur le contrôleur de domaine, DHCP, GLPI…). Le graphe QUAI sait déjà OÙ tourne
 * une ressource ; un module dit CE QU'ELLE FAIT, sous une forme unique et sérialisable.
 *
 * Pourquoi UNE seule forme (`ServiceModuleSnapshot`) plutôt qu'un panneau par intégration : ce
 * mécanisme doit rester utile pour des métiers qu'on n'a pas encore intégrés, et surtout rester
 * lisible par une MACHINE (objectif déclaré : brancher Ollama dessus, qui reçoit le graphe entier
 * comme contexte). Trois primitives suffisent à décrire aussi bien un annuaire DNS qu'un
 * autocommutateur téléphonique :
 *   - `summary`  : les quelques chiffres/états qu'un humain (ou un LLM) lit en premier ;
 *   - `entities` : les objets du service (une zone DNS, un enregistrement A, un poste
 *                  téléphonique, une file d'attente, un utilisateur AD…) — `kind` est une chaîne
 *                  LIBRE propre au module, jamais une énumération globale à étendre ;
 *   - `relations`: ce qui relie deux entités (une zone contient un enregistrement, un poste
 *                  APPELLE un autre poste). Une relation porte un `state` : c'est lui qui permet à
 *                  un appel EN COURS d'être rendu comme une arête animée, exactement comme une
 *                  arête "healthy" du graphe principal.
 *
 * Point d'accroche "3cx" (client livré séparément, routes GET /api/3cx/{status,active-calls,
 * extensions,queues}) — la forme ci-dessus le décrit sans contorsion :
 *   entity  { id: "ext:201", kind: "extension", label: "201 — Accueil", status: "ok",
 *             details: { état: "Talking", terminal: "Yealink T54W" } }
 *   entity  { id: "queue:800", kind: "queue", label: "File Standard", details: { agents: 4 } }
 *   relation{ id: "call:8821", source: "ext:201", target: "ext:305", kind: "call",
 *             label: "00:42", state: "active" }   // arête animée = appel en cours
 * Pour le brancher : écrire `threeCxModuleProvider` sur le même patron que `adDnsModuleProvider`
 * ci-dessous et l'ajouter à SERVICE_MODULE_PROVIDERS — rien d'autre à toucher, ni côté routes ni
 * côté frontend. Le client réel existe déjà (services/threecx.ts) : `isThreecxConfigured()` pour
 * `isConfigured`, l'hôte de sa configuration pour `configuredHosts` (c'est lui qui déclenchera la
 * liaison automatique vers la VM HDV3CX), et `getThreecxExtensions()`/`getThreecxQueues()`/
 * `getThreecxActiveCalls()`/`getThreecxStatus()` pour `getSnapshot`.
 *
 * RÈGLE ABSOLUE, identique au reste de QUAI : jamais de donnée inventée. Un module non configuré
 * renvoie `status: "not-configured"` avec ses listes VIDES (jamais des exemples de démonstration),
 * un module configuré mais dont la source ne répond pas renvoie "unreachable" avec le message
 * réel. LECTURE SEULE stricte : aucun fournisseur n'expose de mutation.
 */

import { promises as dnsPromises, Resolver } from "node:dns";
import { isIPv4 } from "node:net";
import { getEffectiveAdDnsConfig, getEffectiveThreecxConfig } from "./setupStore.js";
import { getThreecxActiveCalls, getThreecxExtensions, getThreecxQueues, getThreecxStatus, isThreecxConfigured } from "./threecx.js";
import { lastKnownDnsSync, listRoutes } from "./reverseProxy.js";
import { getManualBinding, listManualBindings } from "./serviceBindingsStore.js";
import type { TopologyNode } from "../types.js";

// --- La forme générique ---------------------------------------------------------------------------

/** Teinte d'une ligne de synthèse — mêmes variantes que .topology-badge côté web. */
export type ServiceModuleTone = "ok" | "warning" | "critical" | "neutral";

/** État d'une entité, projeté côté web sur la MÊME palette que les nœuds du graphe. */
export type ServiceModuleEntityStatus = "ok" | "warning" | "critical" | "unknown";

/** État d'une relation — "active" est ce qui rend une arête ANIMÉE (appel en cours, flux vivant). */
export type ServiceModuleRelationState = "active" | "idle" | "failed" | "unknown";

export interface ServiceModuleSummaryItem {
  label: string;
  value: string;
  tone?: ServiceModuleTone;
}

export interface ServiceModuleEntity {
  /** Unique DANS le module (jamais un id de TopologyNode) — cible des relations. */
  id: string;
  /** Catégorie propre au module ("dns-zone", "dns-record", "extension", "call-queue"…). */
  kind: string;
  label: string;
  subtitle?: string;
  status?: ServiceModuleEntityStatus;
  /** Paires clé/valeur RÉELLES, affichées telles quelles et directement exploitables par un LLM. */
  details?: Record<string, string | number>;
}

export interface ServiceModuleRelation {
  id: string;
  /** ServiceModuleEntity#id — une relation dont un bout est inconnu est ignorée côté rendu. */
  source: string;
  target: string;
  /** Catégorie propre au module ("contains", "call", "forwards-to"…). */
  kind: string;
  label?: string;
  state?: ServiceModuleRelationState;
}

/** "ready" = données réelles ; "not-configured" = intégration jamais configurée ; "unreachable" =
 * configurée mais la source n'a pas répondu — jamais un repli silencieux sur des données vides. */
export type ServiceModuleStatus = "ready" | "not-configured" | "unreachable";

export interface ServiceModuleSnapshot {
  moduleId: string;
  generatedAt: string;
  status: ServiceModuleStatus;
  /** Explication honnête quand `status` n'est pas "ready" (ou avertissement partiel sinon). */
  message?: string;
  summary: ServiceModuleSummaryItem[];
  entities: ServiceModuleEntity[];
  relations: ServiceModuleRelation[];
}

export interface ServiceModuleProvider {
  id: string;
  label: string;
  /** Une phrase : ce que ce module montre réellement (affichée dans le sélecteur de liaison). */
  description: string;
  isConfigured(): Promise<boolean>;
  /**
   * Hôtes RÉELLEMENT configurés pour cette intégration (nom DNS et/ou IP) — seule base admise de la
   * liaison AUTOMATIQUE (voir resolveAutomaticBindings). `[]` tant que rien n'est configuré.
   */
  configuredHosts(): Promise<string[]>;
  getSnapshot(): Promise<ServiceModuleSnapshot>;
}

/** Ce que GET /api/service-modules expose (le registre, sans les données). */
export interface ServiceModuleDescriptor {
  id: string;
  label: string;
  description: string;
  configured: boolean;
}

// --- Liaisons nœud <-> module ---------------------------------------------------------------------

export interface ServiceModuleBinding {
  nodeId: string;
  moduleId: string;
  /** "manual" = posée par un operator/admin ; "automatic" = correspondance VÉRIFIÉE, recalculée. */
  origin: "manual" | "automatic";
  /** origin "automatic" : la preuve exacte de la correspondance (nom ou IP réelle qui a matché). */
  matchedOn?: string;
}

/** Identité VÉRIFIABLE d'un nœud du graphe — le strict nécessaire au rapprochement automatique. */
export interface NodeIdentity {
  id: string;
  label: string;
  /** IP(s) RÉELLES rapportées par la plateforme (jamais devinées) — voir nodeIdentity ci-dessous. */
  ips: string[];
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Premier label d'un FQDN ("hdv3cx.lecreusot.priv" -> "hdv3cx") — une VM porte souvent son nom
 * court là où l'intégration est configurée avec son nom complet. */
function shortName(host: string): string {
  return normalizeHost(host).split(".")[0] ?? "";
}

/**
 * Identité vérifiable d'un TopologyNode. Les IP ne viennent QUE de sources qui les rapportent
 * réellement (Prism Central pour une VM Nutanix : `nutanixNetworks[].ips`) — aucune IP n'est
 * déduite d'un sous-titre ou d'un libellé, sous peine de lier un module au mauvais nœud.
 */
export function nodeIdentity(node: TopologyNode): NodeIdentity {
  const ips = (node.nutanixNetworks ?? []).flatMap((nic) => nic.ips ?? []).filter((ip) => isIPv4(ip));
  return { id: node.id, label: node.label, ips };
}

/**
 * Liaisons AUTOMATIQUES : un module dont l'hôte configuré correspond RÉELLEMENT à un nœud.
 *
 * Trois correspondances admises, toutes vérifiables — jamais une supposition :
 *  1. l'hôte configuré est une IPv4 et cette IP est l'une des IP réelles du nœud ;
 *  2. le libellé du nœud est exactement l'hôte configuré (comparaison insensible à la casse) ;
 *  3. le libellé du nœud est exactement le nom COURT de l'hôte configuré, ou l'inverse
 *     (« HDV3CX » vs « hdv3cx.lecreusot.priv ») — toujours une égalité de label DNS entier,
 *     jamais une sous-chaîne : "dc01" ne matchera jamais "dc01-old".
 *
 * AMBIGUÏTÉ = AUCUNE LIAISON : si deux nœuds correspondent au même module (deux VMs homonymes sur
 * deux clusters, par exemple), rien n'est lié automatiquement — l'utilisateur tranche par une
 * liaison manuelle. Une liaison manuelle existante prime toujours (voir mergeBindings).
 */
export function resolveAutomaticBindings(
  nodes: NodeIdentity[],
  hostsByModule: Record<string, string[]>,
): ServiceModuleBinding[] {
  const bindings: ServiceModuleBinding[] = [];
  for (const [moduleId, hosts] of Object.entries(hostsByModule)) {
    const matches = new Map<string, string>(); // nodeId -> preuve
    for (const rawHost of hosts) {
      const host = normalizeHost(rawHost);
      if (!host) continue;
      const hostShort = shortName(host);
      const hostIsIp = isIPv4(host);
      for (const node of nodes) {
        const label = normalizeHost(node.label);
        const matched = hostIsIp
          ? node.ips.some((ip) => ip === host)
            ? host
            : null
          : label === host || label === hostShort || shortName(label) === hostShort
            ? rawHost
            : null;
        if (matched) matches.set(node.id, matched);
      }
    }
    if (matches.size !== 1) continue; // 0 = rien de vérifiable ; >1 = ambigu, on ne devine pas
    const [nodeId, matchedOn] = [...matches.entries()][0]!;
    bindings.push({ nodeId, moduleId, origin: "automatic", matchedOn });
  }
  return bindings;
}

/** Liaisons manuelles PRIORITAIRES sur les automatiques pour un même nœud (l'utilisateur tranche). */
export function mergeBindings(manual: ServiceModuleBinding[], automatic: ServiceModuleBinding[]): ServiceModuleBinding[] {
  const byNodeId = new Map<string, ServiceModuleBinding>();
  for (const binding of automatic) byNodeId.set(binding.nodeId, binding);
  for (const binding of manual) byNodeId.set(binding.nodeId, binding);
  return [...byNodeId.values()];
}

// --- Module "ad-dns" (premier fournisseur RÉEL) ---------------------------------------------------

/** Budget total (ms) de la vérification DNS live ci-dessous — un module ne doit jamais faire
 * traîner une réponse d'API : au-delà, les enregistrements restent honnêtement "non vérifiés". */
const DNS_PROBE_TIMEOUT_MS = 2500;
/** Plafond d'enregistrements réellement interrogés en direct (une zone peut en compter des
 * milliers ; QUAI n'en connaît qu'un sous-ensemble, mais la garde reste explicite). */
const DNS_PROBE_MAX_RECORDS = 25;

/** Ce que la sonde DNS live rend pour un nom : ses A réels, ou `null` = non vérifiable. */
export type DnsProbeResult = Map<string, string[] | null>;

/**
 * Interroge le DNS AD LUI-MÊME (le KDC est le contrôleur de domaine, donc le serveur DNS de la
 * zone) pour les noms donnés — LECTURE SEULE stricte (requêtes A, jamais une mise à jour
 * dynamique : `nsupdate` reste le seul chemin d'écriture et n'est pas appelé ici).
 *
 * `Resolver#setServers` n'accepte que des adresses IP : le KDC est donc d'abord résolu par le
 * résolveur SYSTÈME (une IPv4 passe telle quelle). Tout échec renvoie une carte de `null` — un
 * "non vérifié" honnête, jamais un "absent" qui laisserait croire que l'enregistrement n'existe pas.
 */
async function probeDnsRecords(kdcHost: string, names: string[]): Promise<DnsProbeResult> {
  const result: DnsProbeResult = new Map(names.map((name) => [name, null]));
  if (names.length === 0) return result;
  try {
    const server = isIPv4(kdcHost) ? kdcHost : (await dnsPromises.lookup(kdcHost, { family: 4 })).address;
    const resolver = new Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 });
    resolver.setServers([server]);
    await Promise.all(
      names.slice(0, DNS_PROBE_MAX_RECORDS).map(
        (name) =>
          new Promise<void>((resolve) => {
            resolver.resolve4(name, (err, addresses) => {
              if (!err) result.set(name, addresses);
              resolve();
            });
          }),
      ),
    );
  } catch {
    // KDC non résolvable depuis QUAI : tout reste "non vérifié" (voir JSDoc).
  }
  return result;
}

/** Injectable pour les tests — la sonde réelle par défaut. */
export interface AdDnsModuleDeps {
  probe: (kdcHost: string, names: string[]) => Promise<DnsProbeResult>;
}

const DEFAULT_AD_DNS_DEPS: AdDnsModuleDeps = { probe: probeDnsRecords };

function summaryToneForSync(status: "synced" | "failed" | undefined): ServiceModuleTone {
  if (status === "synced") return "ok";
  if (status === "failed") return "critical";
  return "neutral";
}

/**
 * Instantané RÉEL du module AD/DNS, assemblé à partir des sources déjà en place — aucune nouvelle
 * intégration, aucune donnée fabriquée :
 *  - la configuration AD réellement enregistrée (setupStore.ts : realm/KDC/zone/compte/IP cible) ;
 *  - les routes de reverse proxy réellement créées (reverseProxy.ts) : ce sont EXACTEMENT les
 *    enregistrements `A` que QUAI pousse dans la zone, avec le résultat de leur dernière
 *    synchronisation (`dnsSync`) ;
 *  - une vérification DNS live, en lecture seule, contre le contrôleur de domaine lui-même.
 *
 * Le graphe rendu : serveur AD -> zone -> un enregistrement par sous-domaine. Un enregistrement
 * dont la résolution live ne renvoie PAS l'IP cible configurée ressort en "warning" avec les deux
 * valeurs affichées côte à côte — le désaccord est une information, jamais masqué.
 */
export async function buildAdDnsSnapshot(deps: AdDnsModuleDeps = DEFAULT_AD_DNS_DEPS): Promise<ServiceModuleSnapshot> {
  const generatedAt = new Date().toISOString();
  const cfg = await getEffectiveAdDnsConfig();
  if (!cfg) {
    return {
      moduleId: "ad-dns",
      generatedAt,
      status: "not-configured",
      message:
        "Intégration Active Directory / DNS non configurée — renseignez realm, KDC, zone et compte de service dans les Réglages.",
      summary: [],
      entities: [],
      relations: [],
    };
  }

  const zone = normalizeHost(cfg.zone);
  const routes = await listRoutes();
  const zoneRoutes = routes.filter((route) => {
    const sub = normalizeHost(route.subdomain);
    return sub === zone || sub.endsWith(`.${zone}`);
  });
  const probed = await deps.probe(cfg.kdcHost, zoneRoutes.map((route) => normalizeHost(route.subdomain)));
  const probeUsable = [...probed.values()].some((value) => value !== null);
  const lastSync = lastKnownDnsSync();

  const serverId = `server:${normalizeHost(cfg.kdcHost)}`;
  const zoneId = `zone:${zone}`;

  const entities: ServiceModuleEntity[] = [
    {
      id: serverId,
      kind: "dns-server",
      label: cfg.kdcHost,
      subtitle: `Contrôleur de domaine ${cfg.realm.toUpperCase()}`,
      status: lastSync ? (lastSync.status === "synced" ? "ok" : "critical") : "unknown",
      details: {
        Realm: cfg.realm.toUpperCase(),
        "Compte de service": cfg.serviceAccount,
        "Mise à jour dynamique": "GSS-TSIG (kinit + nsupdate -g)",
        ...(lastSync ? { "Dernière synchro": lastSync.at } : {}),
        ...(lastSync?.message ? { "Message dernière synchro": lastSync.message } : {}),
      },
    },
    {
      id: zoneId,
      kind: "dns-zone",
      label: zone,
      subtitle: `${zoneRoutes.length} enregistrement${zoneRoutes.length > 1 ? "s" : ""} géré${zoneRoutes.length > 1 ? "s" : ""} par QUAI`,
      status: "ok",
      details: { "IP cible des enregistrements A": cfg.targetIp, "Enregistrements gérés": zoneRoutes.length },
    },
  ];

  const relations: ServiceModuleRelation[] = [
    { id: `serves:${zoneId}`, source: serverId, target: zoneId, kind: "serves", label: "zone servie", state: "idle" },
  ];

  for (const route of zoneRoutes) {
    const name = normalizeHost(route.subdomain);
    const recordId = `record:${route.id}`;
    const resolved = probed.get(name) ?? null;
    const matchesTarget = resolved ? resolved.includes(cfg.targetIp) : null;
    const status: ServiceModuleEntityStatus =
      route.dnsSync?.status === "failed"
        ? "critical"
        : matchesTarget === false
          ? "warning"
          : matchesTarget === true
            ? "ok"
            : route.dnsSync?.status === "synced"
              ? "ok"
              : "unknown";
    entities.push({
      id: recordId,
      kind: "dns-record",
      label: name,
      subtitle: `A → ${cfg.targetIp}`,
      status,
      details: {
        Type: "A",
        Cible: cfg.targetIp,
        "Résolution live": resolved ? (resolved.length > 0 ? resolved.join(", ") : "aucune réponse") : "non vérifiée",
        "Dernière synchro QUAI": route.dnsSync ? `${route.dnsSync.status} · ${route.dnsSync.at}` : "jamais tentée",
        ...(route.dnsSync?.message ? { "Message de synchro": route.dnsSync.message } : {}),
        ...(route.targetContainerId ? { "Conteneur cible": route.targetContainerId } : {}),
        ...(route.targetHost ? { "Hôte cible": route.targetHost } : {}),
        "Port cible": route.targetPort,
      },
    });
    relations.push({
      id: `contains:${route.id}`,
      source: zoneId,
      target: recordId,
      kind: "contains",
      label: "A",
      state: status === "critical" ? "failed" : status === "ok" ? "active" : "unknown",
    });
  }

  const syncedCount = zoneRoutes.filter((route) => route.dnsSync?.status === "synced").length;
  const failedCount = zoneRoutes.filter((route) => route.dnsSync?.status === "failed").length;
  const summary: ServiceModuleSummaryItem[] = [
    { label: "Contrôleur de domaine", value: cfg.kdcHost },
    { label: "Realm", value: cfg.realm.toUpperCase() },
    { label: "Zone DNS", value: zone },
    { label: "Enregistrements gérés", value: String(zoneRoutes.length) },
    { label: "Synchronisés", value: String(syncedCount), tone: syncedCount > 0 ? "ok" : "neutral" },
    ...(failedCount > 0 ? [{ label: "En échec", value: String(failedCount), tone: "critical" as ServiceModuleTone }] : []),
    {
      label: "Dernière synchro",
      value: lastSync ? `${lastSync.status} · ${lastSync.at}` : "aucune depuis le démarrage",
      tone: summaryToneForSync(lastSync?.status),
    },
    {
      label: "Vérification DNS live",
      value: zoneRoutes.length === 0 ? "aucun enregistrement à vérifier" : probeUsable ? "réussie" : "indisponible",
      tone: zoneRoutes.length === 0 ? "neutral" : probeUsable ? "ok" : "warning",
    },
  ];

  return {
    moduleId: "ad-dns",
    generatedAt,
    status: "ready",
    ...(zoneRoutes.length > 0 && !probeUsable
      ? {
          message:
            "Le DNS du contrôleur de domaine n'a pas répondu depuis QUAI — les enregistrements sont affichés d'après la configuration et la dernière synchronisation réelles, sans vérification live.",
        }
      : {}),
    summary,
    entities,
    relations,
  };
}

export const adDnsModuleProvider: ServiceModuleProvider = {
  id: "ad-dns",
  label: "Active Directory / DNS",
  description: "Contrôleur de domaine, zone DNS et enregistrements A réellement poussés par QUAI (lecture seule).",
  isConfigured: async () => (await getEffectiveAdDnsConfig()) !== null,
  // Le KDC configuré EST le contrôleur de domaine : son nom rattache le module à la VM Nutanix qui
  // le porte réellement (règle 3 de resolveAutomaticBindings, nom court ou FQDN). Tant que le
  // graphe portait EN PLUS un nœud "ad-server" étiqueté avec ce même hostname, deux nœuds
  // correspondaient et la liaison restait ambiguë donc inexistante — ce nœud a été retiré le
  // 24/08/2026 (services/topology.ts).
  configuredHosts: async () => {
    const cfg = await getEffectiveAdDnsConfig();
    return cfg ? [cfg.kdcHost] : [];
  },
  getSnapshot: () => buildAdDnsSnapshot(),
};

// --- Module 3CX : postes et files en entités, appels en cours en RELATIONS actives ----------------

function threecxExtensionEntityId(number: string): string {
  return `ext:${number}`;
}

/** Un appel relie deux entités : ses participants quand ils correspondent à des postes connus,
 * sinon une entité "externe" créée pour ce numéro (un numéro RTC n'est pas un poste). */
async function buildThreecxSnapshot(): Promise<ServiceModuleSnapshot> {
  const generatedAt = new Date().toISOString();
  const status = await getThreecxStatus();
  if (!status.configured) {
    return {
      moduleId: "3cx",
      generatedAt,
      status: "not-configured",
      message: "Intégration 3CX non configurée — renseignez l'URL du PBX, le ClientID et la clé API dans les Réglages.",
      summary: [],
      entities: [],
      relations: [],
    };
  }
  // `pbxError` compte autant qu'un refus d'accès : sans lui, une erreur de requête donnerait un
  // module "prêt" avec zéro entité — exactement l'affichage silencieux qu'on refuse.
  if (status.reachable === false || status.accessError || status.pbxError) {
    return {
      moduleId: "3cx",
      generatedAt,
      status: "unreachable",
      // Message BRUT du PBX — jamais reformulé.
      message: status.accessError ?? status.pbxError ?? "PBX 3CX injoignable au dernier relevé.",
      summary: [],
      entities: [],
      relations: [],
    };
  }

  const [extensions, queues, calls] = await Promise.all([getThreecxExtensions(), getThreecxQueues(), getThreecxActiveCalls()]);
  const entities: ServiceModuleEntity[] = [];
  const knownNumbers = new Set<string>();

  for (const ext of extensions.items) {
    knownNumbers.add(ext.number);
    const label = ext.displayName ? `${ext.number} — ${ext.displayName}` : ext.number;
    entities.push({
      id: threecxExtensionEntityId(ext.number),
      kind: "extension",
      label,
      ...(ext.currentProfileName ? { subtitle: ext.currentProfileName } : {}),
      status: ext.registered === true ? "ok" : ext.registered === false ? "warning" : "unknown",
      details: {
        Numéro: ext.number,
        ...(ext.displayName ? { Nom: ext.displayName } : {}),
        ...(ext.registered !== undefined ? { Joignable: ext.registered ? "oui" : "non" } : {}),
        ...(ext.currentProfileName ? { Présence: ext.currentProfileName } : {}),
        ...(ext.queueStatus ? { "File d'attente": ext.queueStatus } : {}),
      },
    });
  }

  for (const queue of queues.items) {
    entities.push({
      id: `queue:${queue.number}`,
      kind: "queue",
      label: queue.name ? `${queue.number} — ${queue.name}` : queue.number,
      subtitle: "File d'attente",
      status: queue.registered === true ? "ok" : "unknown",
      details: {
        Numéro: queue.number,
        ...(queue.pollingStrategy ? { Distribution: queue.pollingStrategy } : {}),
        ...(queue.maxCallersInQueue !== undefined ? { "Appelants max": queue.maxCallersInQueue } : {}),
      },
    });
  }

  const relations: ServiceModuleRelation[] = [];
  for (const call of calls.items) {
    const caller = call.participants.find((p) => p.direction === "caller");
    const callee = call.participants.find((p) => p.direction === "callee");
    if (!caller || !callee) continue;
    for (const participant of [caller, callee]) {
      if (knownNumbers.has(participant.number)) continue;
      knownNumbers.add(participant.number);
      entities.push({
        id: threecxExtensionEntityId(participant.number),
        kind: "external",
        label: participant.name ? `${participant.number} — ${participant.name}` : participant.number,
        subtitle: "Correspondant externe",
        status: "unknown",
        details: { Numéro: participant.number },
      });
    }
    relations.push({
      id: `call:${call.id}`,
      source: threecxExtensionEntityId(caller.number),
      target: threecxExtensionEntityId(callee.number),
      kind: "call",
      ...(call.status ? { label: call.status } : {}),
      // Un appel en cours EST un flux vivant : "active" -> arête animée sur la palette du graphe.
      state: "active",
    });
  }

  const summary: ServiceModuleSummaryItem[] = [
    { label: "Appels en cours", value: String(calls.items.length), tone: calls.items.length > 0 ? "ok" : "neutral" },
    {
      label: "Postes joignables",
      value: `${extensions.items.filter((e) => e.registered === true).length} / ${extensions.items.length}`,
    },
    { label: "Files d'attente", value: String(queues.items.length) },
    ...(status.system?.version ? [{ label: "Version", value: status.system.version } as ServiceModuleSummaryItem] : []),
  ];

  return { moduleId: "3cx", generatedAt, status: "ready", summary, entities, relations };
}

export const threecxModuleProvider: ServiceModuleProvider = {
  id: "3cx",
  label: "Téléphonie 3CX",
  description: "Postes, files d'attente et appels en cours du PBX (lecture seule) — un appel est une arête vivante.",
  isConfigured: () => isThreecxConfigured(),
  configuredHosts: async () => {
    const cfg = await getEffectiveThreecxConfig();
    if (!cfg?.baseUrl) return [];
    try {
      return [new URL(cfg.baseUrl).hostname];
    } catch {
      return [];
    }
  },
  getSnapshot: () => buildThreecxSnapshot(),
};

// --- Le registre ----------------------------------------------------------------------------------

/** Ajouter un module = ajouter UNE entrée ici (voir le patron "3cx" documenté en tête de fichier). */
export const SERVICE_MODULE_PROVIDERS: ServiceModuleProvider[] = [adDnsModuleProvider, threecxModuleProvider];

export function getServiceModuleProvider(moduleId: string): ServiceModuleProvider | undefined {
  return SERVICE_MODULE_PROVIDERS.find((provider) => provider.id === moduleId);
}

export async function listServiceModules(): Promise<ServiceModuleDescriptor[]> {
  return Promise.all(
    SERVICE_MODULE_PROVIDERS.map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      configured: await provider.isConfigured(),
    })),
  );
}

/** Hôtes configurés de TOUS les modules — entrée de resolveAutomaticBindings. */
export async function configuredHostsByModule(): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const provider of SERVICE_MODULE_PROVIDERS) {
    const hosts = await provider.configuredHosts();
    if (hosts.length > 0) result[provider.id] = hosts;
  }
  return result;
}

/**
 * Toutes les liaisons effectives — manuelles (persistées) + automatiques (recalculées depuis les
 * nœuds RÉELS du graphe). Une liaison manuelle vers un module retiré du registre est ignorée
 * plutôt que renvoyée : le frontend n'affichera jamais une pastille pour un module inexistant.
 */
export async function listEffectiveBindings(nodes: TopologyNode[]): Promise<ServiceModuleBinding[]> {
  const manualStored = await listManualBindings();
  const manual: ServiceModuleBinding[] = manualStored
    .filter((binding) => getServiceModuleProvider(binding.moduleId) !== undefined)
    .map((binding) => ({ nodeId: binding.nodeId, moduleId: binding.moduleId, origin: "manual" }));
  const automatic = resolveAutomaticBindings(nodes.map(nodeIdentity), await configuredHostsByModule());
  return mergeBindings(manual, automatic);
}

/** Liaison effective d'UN nœud précis — même règle de priorité que listEffectiveBindings. */
export async function effectiveBindingFor(nodeId: string, nodes: TopologyNode[]): Promise<ServiceModuleBinding | null> {
  const manual = await getManualBinding(nodeId);
  if (manual && getServiceModuleProvider(manual.moduleId)) {
    return { nodeId, moduleId: manual.moduleId, origin: "manual" };
  }
  const automatic = resolveAutomaticBindings(nodes.map(nodeIdentity), await configuredHostsByModule());
  return automatic.find((binding) => binding.nodeId === nodeId) ?? null;
}
