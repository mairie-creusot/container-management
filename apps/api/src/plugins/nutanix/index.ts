/**
 * Greffon Nutanix (Prism Central) — MUTANT et HIÉRARCHIQUE, contrairement à 3CX. Ce fichier ne
 * réimplémente rien : services/nutanix.ts porte tout le savoir-faire réel (v3 en lecture, repli
 * Prism Element v2.0 sur un 405 REQUEST_NOT_SUPPORTED, unités de statistiques prouvées
 * arithmétiquement), plugins/nutanix/graph.ts porte la hiérarchie cluster -> hôte -> VM.
 *
 * MANQUES DU CONTRAT constatés en migrant cette intégration (rien n'est contourné ici) :
 *  1. `permissions.network` ne sait pas désigner l'hôte SAISI (`prismCentralUrl`) : déclaré `[]`.
 *  2. COMBLÉ (contrat 1.1, voir ACTION_SPECS plus bas) : une action décrit désormais son entrée,
 *     son niveau de danger, sa confirmation et le nœud qu'elle vise. Reste hors de portée du
 *     sous-ensemble de schéma : une entrée IMBRIQUÉE (`vm.create` et son `guestCustomization`) et
 *     la règle « au moins l'un des trois champs » de `vm.update-compute`.
 *  3. Le téléversement d'image (flux binaire) et la console VNC (WebSocket bidirectionnel) ne
 *     sont PAS exprimables en `(input: unknown) => Promise<unknown>` : ils restent hors `actions`,
 *     servis par routes/nutanix.ts.
 *  4. `PluginGraphNode` n'a qu'un `kind` : le couple (kind "host", hostKind "nutanix-cluster" /
 *     "nutanix-host") devient deux kinds distincts, et `details` (chaînes/nombres) ne transporte
 *     ni les disques, ni les cartes réseau, ni le booléen de placement confirmé.
 *  5. `PluginGraphAttachment` n'a ni `networkId`, ni `ipAddress`, ni `vlanId` : les tiroirs réseau
 *     d'une VM y perdent le VLAN, l'IP réelle et le rapprochement entre VMs d'un même subnet.
 *  6. Aucune arête ne peut se déclarer "non confirmée" : la nuance placement live / dernier hôte
 *     déclaré (vert plein vs pointillé) n'existe pas dans `PluginGraphEdge`.
 *  7. `PluginTestResult` perd le nombre de VMs réellement comptées par le test de connexion.
 *  8. Rien ne décrit le rattachement au nœud MASTER : c'est services/topology.ts qui sait qu'un
 *     nœud "nutanix-cluster" est un ENVIRONNEMENT.
 */

import type { Plugin, PluginActionSpec, PluginGraphContribution, PluginTestResult, ServiceModuleSnapshot } from "@quai/plugin-contract";
import type { ServiceModuleEntity, ServiceModuleEntityStatus, ServiceModuleRelation } from "@quai/plugin-contract";
import {
  addNutanixVmDisk,
  addNutanixVmNic,
  createNutanixImage,
  createNutanixVm,
  deleteNutanixVm,
  getNutanixClusters,
  getNutanixHosts,
  getNutanixVms,
  lastKnownNutanixPoll,
  migrateNutanixVm,
  NutanixActionError,
  NUTANIX_DISK_MAX_SIZE_MIB,
  NUTANIX_DISK_MIN_SIZE_MIB,
  NUTANIX_MAX_CORES_PER_VCPU,
  NUTANIX_MAX_MEMORY_MIB,
  NUTANIX_MAX_VCPUS,
  NUTANIX_MIN_MEMORY_MIB,
  restartNutanixVm,
  startNutanixVm,
  stopNutanixVm,
  testNutanixConnection,
  updateNutanixVmCompute,
} from "../../services/nutanix.js";
import type { NutanixCreateVmInput, NutanixGuestCustomizationInput } from "../../services/nutanix.js";
import type { NutanixVm } from "../../types.js";
import {
  nutanixConfigStore,
  NUTANIX_PLUGIN_ID,
  NUTANIX_SECRET_FIELDS,
  parseNutanixConfig,
  readNutanixConfigCandidate,
} from "./config.js";
import { NUTANIX_GRAPH_NODE_KINDS, nutanixGraphContribution } from "./graph.js";

const NOT_CONFIGURED_MESSAGE =
  "Intégration Nutanix non configurée — renseignez l'URL de Prism Central, l'utilisateur et le mot de passe dans les Réglages.";

/** Chaque clé est une action de `actions` ci-dessous : le contrat impose l'égalité des deux listes. */
const AUDIT_LABELS: Record<string, string> = {
  "vm.start": "Démarrer une VM Nutanix",
  "vm.stop": "Arrêter (ACPI) une VM Nutanix",
  "vm.restart": "Redémarrer (ACPI) une VM Nutanix",
  "vm.delete": "Supprimer définitivement une VM Nutanix",
  "vm.migrate": "Migrer à chaud une VM Nutanix vers un autre hôte",
  "vm.add-disk": "Ajouter un disque à une VM Nutanix",
  "vm.add-nic": "Ajouter une carte réseau à une VM Nutanix",
  "vm.update-compute": "Modifier vCPU/mémoire d'une VM Nutanix",
  "vm.create": "Créer une VM Nutanix",
  "image.create": "Ajouter une image au catalogue Nutanix depuis une URL",
};

/**
 * DESCRIPTION des actions (contrat 1.1) — entrée, danger, confirmation, rattachement au graphe.
 * Les bornes sont celles que services/nutanix.ts fait RÉELLEMENT respecter (constantes importées,
 * jamais recopiées) ; le service reste seul juge, ce schéma ne fait que les rendre visibles du
 * socle et déductibles en formulaire.
 *
 * `servedByCore` sur chaque action de VM : l'écran actuel les sert déjà, avec plus que ne saurait
 * en faire un formulaire générique — état "action en cours" et convergence d'alimentation pour
 * démarrer/arrêter/redémarrer, liste RÉELLE des subnets pour la carte réseau, confirmation par
 * saisie du nom pour la suppression. Elles passent donc par la voie générique côté SERVEUR (route,
 * validation, audit) sans rien changer à l'écran, exactement comme demandé.
 *
 * `vm.create` n'est PAS décrite : son entrée porte un objet imbriqué (`guestCustomization`, avec un
 * mot de passe cloud-init) que le sous-ensemble de schéma ne sait ni décrire à plat ni protéger.
 * Elle reste exécutable, entrée transmise telle quelle, comme avant.
 */
const ACTION_SPECS: Record<string, PluginActionSpec> = {
  "vm.start": {
    severity: "safe",
    target: { nodeKind: "nutanix-vm", field: "uuid", when: [{ field: "status", equals: ["stopped"] }], servedByCore: "nutanix-vm-start" },
  },
  "vm.stop": {
    severity: "caution",
    confirm: {
      title: "Arrêter la VM",
      message: `Confirmer l'arrêt GRACIEUX (ACPI) de "{cible}" ? Les services qu'elle héberge seront interrompus.`,
      confirmLabel: "Arrêter",
    },
    target: { nodeKind: "nutanix-vm", field: "uuid", when: [{ field: "status", equals: ["running"] }], servedByCore: "nutanix-vm-stop" },
  },
  "vm.restart": {
    severity: "caution",
    confirm: {
      title: "Redémarrer la VM",
      message: `Confirmer le redémarrage GRACIEUX de "{cible}" ? Les services qu'elle héberge seront brièvement interrompus.`,
      confirmLabel: "Redémarrer",
    },
    target: { nodeKind: "nutanix-vm", field: "uuid", when: [{ field: "status", equals: ["running"] }], servedByCore: "nutanix-vm-restart" },
  },
  "vm.delete": {
    severity: "destructive",
    confirm: {
      title: "Supprimer cette VM",
      message: `Confirmer la suppression définitive de "{cible}" ? Cette action est irréversible et détruit réellement la VM sur Prism Central.`,
      confirmLabel: "Supprimer définitivement",
      retype: true,
    },
    // Absente du menu du graphe DEPUIS TOUJOURS : la confirmation lourde vit dans le panneau de
    // détail, seule source de vérité de l'action la plus destructrice du dépôt.
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "panneau de détail du nœud (saisie du nom de la VM)" },
  },
  "vm.migrate": {
    severity: "caution",
    input: {
      type: "object",
      properties: {
        targetHostUuid: {
          type: "string",
          title: "Hôte de destination",
          description: "UUID d'un autre hôte AHV du MÊME cluster — Prism refuse toute autre destination.",
        },
      },
      required: ["targetHostUuid"],
    },
    // Migration à chaud : elle se déclenche en faisant GLISSER la VM sur un hôte du graphe, geste
    // qui désigne l'hôte de destination bien mieux qu'un UUID à saisir.
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "glisser-déposer d'une VM sur un hôte du graphe" },
  },
  "vm.add-disk": {
    severity: "caution",
    input: {
      type: "object",
      properties: {
        sizeMib: {
          type: "number",
          title: "Taille du disque (Mio)",
          description: `De ${NUTANIX_DISK_MIN_SIZE_MIB} Mio (1 Gio) à ${NUTANIX_DISK_MAX_SIZE_MIB} Mio (2 Tio) — garde-fou QUAI, entier attendu.`,
          minimum: NUTANIX_DISK_MIN_SIZE_MIB,
          maximum: NUTANIX_DISK_MAX_SIZE_MIB,
        },
      },
      required: ["sizeMib"],
    },
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "nutanix-vm-add-disk" },
  },
  "vm.add-nic": {
    severity: "caution",
    input: {
      type: "object",
      properties: {
        subnetUuid: {
          type: "string",
          title: "Subnet / VLAN",
          description: "UUID d'un subnet réel du cluster (GET /api/nutanix/subnets).",
        },
      },
      required: ["subnetUuid"],
    },
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "nutanix-vm-add-nic" },
  },
  "vm.update-compute": {
    severity: "caution",
    // Les trois champs sont facultatifs, mais le service en exige AU MOINS UN — règle que le
    // sous-ensemble de schéma ne sait pas exprimer, arbitrée par updateNutanixVmCompute seul.
    input: {
      type: "object",
      properties: {
        numVcpus: { type: "number", title: "vCPU (sockets)", minimum: 1, maximum: NUTANIX_MAX_VCPUS },
        numCoresPerVcpu: { type: "number", title: "Cœurs par vCPU", minimum: 1, maximum: NUTANIX_MAX_CORES_PER_VCPU },
        memoryMib: {
          type: "number",
          title: "Mémoire (Mio)",
          minimum: NUTANIX_MIN_MEMORY_MIB,
          maximum: NUTANIX_MAX_MEMORY_MIB,
        },
      },
    },
    target: { nodeKind: "nutanix-vm", field: "uuid", servedByCore: "nutanix-vm-edit-compute" },
  },
  "image.create": {
    severity: "safe",
    // Aucun nœud du graphe : le catalogue d'images vit dans la page Environnements.
    input: {
      type: "object",
      properties: {
        name: { type: "string", title: "Nom de l'image" },
        sourceUri: {
          type: "string",
          title: "URL source",
          description: "Adresse depuis laquelle Prism Central télécharge lui-même l'image.",
          examples: ["https://exemple.fr/debian-13.qcow2"],
        },
      },
      required: ["name", "sourceUri"],
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** uuid de la VM visée — 400 explicite, jamais une action jouée sur une cible devinée. */
function requireVmUuid(input: unknown): string {
  const uuid = isRecord(input) ? str(input.uuid) : undefined;
  if (!uuid) throw new NutanixActionError("uuid (identifiant de la VM) is required", 400);
  return uuid;
}

function requireField(input: unknown, field: string): string {
  const value = isRecord(input) ? str(input[field]) : undefined;
  if (!value) throw new NutanixActionError(`${field} is required`, 400);
  return value;
}

/** Lecture de la personnalisation cloud-init — SECRET (mot de passe/clé) : jamais journalisée. */
function readGuestCustomization(raw: unknown): NutanixGuestCustomizationInput | undefined {
  if (!isRecord(raw)) return undefined;
  const username = str(raw.username);
  if (!username) throw new NutanixActionError("guestCustomization.username is required when guestCustomization is provided", 400);
  const hostname = str(raw.hostname);
  const password = typeof raw.password === "string" ? raw.password : undefined;
  const sshAuthorizedKey = typeof raw.sshAuthorizedKey === "string" ? raw.sshAuthorizedKey : undefined;
  return {
    username,
    ...(hostname !== undefined ? { hostname } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(sshAuthorizedKey !== undefined ? { sshAuthorizedKey } : {}),
  };
}

/** Forme d'entrée de `vm.create` — les VALEURS (bornes, exclusivité image/ISO) restent arbitrées
 * par createNutanixVm, seule source de vérité de ces règles. */
function readCreateVmInput(input: unknown): NutanixCreateVmInput {
  const raw = isRecord(input) ? input : {};
  const name = str(raw.name);
  const subnetUuid = str(raw.subnetUuid);
  if (!name || !subnetUuid) throw new NutanixActionError("name and subnetUuid are required", 400);
  const numVcpus = num(raw.numVcpus);
  const memoryMib = num(raw.memoryMib);
  if (numVcpus === undefined || memoryMib === undefined) {
    throw new NutanixActionError("numVcpus and memoryMib (numbers) are required", 400);
  }
  const imageUuid = str(raw.imageUuid);
  const isoImageUuid = str(raw.isoImageUuid);
  const numCoresPerVcpu = num(raw.numCoresPerVcpu);
  const diskSizeMib = num(raw.diskSizeMib);
  const guestCustomization = readGuestCustomization(raw.guestCustomization);
  return {
    name,
    subnetUuid,
    numVcpus,
    memoryMib,
    ...(imageUuid !== undefined ? { imageUuid } : {}),
    ...(isoImageUuid !== undefined ? { isoImageUuid } : {}),
    ...(numCoresPerVcpu !== undefined ? { numCoresPerVcpu } : {}),
    ...(diskSizeMib !== undefined ? { diskSizeMib } : {}),
    ...(guestCustomization !== undefined ? { guestCustomization } : {}),
  };
}

function notConfiguredSnapshot(): ServiceModuleSnapshot {
  return {
    moduleId: NUTANIX_PLUGIN_ID,
    generatedAt: new Date().toISOString(),
    status: "not-configured",
    message: NOT_CONFIGURED_MESSAGE,
    summary: [],
    entities: [],
    relations: [],
  };
}

/** Une VM éteinte n'est PAS en faute (même règle que "stopped" != "unhealthy" côté conteneurs) :
 * seul un vrai `status.state === "ERROR"` de Prism Central est "critical". */
function vmEntityStatus(vm: NutanixVm): ServiceModuleEntityStatus {
  if (vm.apiError) return "critical";
  return vm.powerState === "on" ? "ok" : "unknown";
}

export const nutanixPlugin: Plugin = {
  manifest: {
    id: NUTANIX_PLUGIN_ID,
    name: "Virtualisation Nutanix",
    version: "1.0.0",
    coreApi: "^1.0",
    // Le formulaire de apps/web/src/features/clusters/NutanixConfigSection.tsx, champ pour champ.
    configSchema: {
      type: "object",
      title: "Nutanix Prism Central",
      properties: {
        prismCentralUrl: {
          type: "string",
          title: "URL Prism Central",
          description: "Adresse de Prism Central, port compris — QUAI ajoute lui-même les chemins d'API (v3 et Prism Element v2.0).",
          examples: ["https://prism.lecreusot.fr:9440"],
        },
        username: {
          type: "string",
          title: "Utilisateur",
          description: "Compte Prism Central utilisé pour toutes les requêtes, lectures comme actions sur les VMs.",
        },
        password: {
          type: "string",
          title: "Mot de passe",
          description: "Laisser vide lors d'une modification conserve le mot de passe déjà enregistré.",
        },
      },
      required: ["prismCentralUrl", "username", "password"],
      additionalProperties: false,
    },
    secretFields: [...NUTANIX_SECRET_FIELDS],
    permissions: {
      // Aucun hôte fixe : Prism Central joint est celui de `prismCentralUrl`, saisi par l'admin
      // (voir manque n°1 en tête de fichier).
      network: [],
      mutates: true,
      graphNodeKinds: [...NUTANIX_GRAPH_NODE_KINDS],
    },
    auditLabels: AUDIT_LABELS,
    actions: ACTION_SPECS,
  },

  configStore: nutanixConfigStore,

  async test(config: unknown): Promise<PluginTestResult> {
    const { prismCentralUrl, username, password } = readNutanixConfigCandidate(config);
    // testNutanixConnection refuse lui-même une configuration incomplète et teste RÉELLEMENT
    // Prism Central sans rien persister. `vmCount` est perdu ici (manque n°7).
    const result = await testNutanixConnection(prismCentralUrl ?? "", username ?? "", password ?? "");
    return { ok: result.ok, message: result.message };
  },

  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    if (!parseNutanixConfig(config)) return notConfiguredSnapshot();

    // Les services lisent eux-mêmes la configuration STOCKÉE : `config` dit si le greffon est
    // configuré, il ne sert jamais à joindre une autre instance que celle enregistrée.
    const [vms, clusters, hosts] = await Promise.all([getNutanixVms(), getNutanixClusters(), getNutanixHosts()]);
    const generatedAt = new Date().toISOString();
    const poll = lastKnownNutanixPoll();

    // getNutanixVms() vient d'enregistrer le résultat RÉEL de cet essai : un échec est rapporté
    // comme tel, jamais comme un inventaire vide.
    if (poll && !poll.reachable) {
      return {
        moduleId: NUTANIX_PLUGIN_ID,
        generatedAt,
        status: "unreachable",
        message: `Prism Central n'a pas répondu lors du dernier essai (${poll.at}).`,
        summary: [],
        entities: [],
        relations: [],
      };
    }

    const poweredOn = vms.filter((vm) => vm.powerState === "on").length;
    const inError = vms.filter((vm) => vm.apiError).length;

    const entities: ServiceModuleEntity[] = [
      ...clusters.map((cluster) => ({
        id: cluster.uuid,
        kind: "cluster",
        label: cluster.name,
        status: "ok" as const,
      })),
      ...hosts.map((host) => {
        const details: Record<string, string | number> = {};
        if (host.cpuModel) details["Processeur"] = host.cpuModel;
        if (typeof host.numCpuCores === "number") details["Cœurs"] = host.numCpuCores;
        if (typeof host.memoryCapacityMib === "number") details["Mémoire (Mio)"] = host.memoryCapacityMib;
        if (host.hypervisorFullName) details["Hyperviseur"] = host.hypervisorFullName;
        return {
          id: host.id,
          kind: "host",
          label: host.name,
          status: "ok" as const,
          ...(Object.keys(details).length > 0 ? { details } : {}),
        };
      }),
      ...vms.map((vm) => {
        const details: Record<string, string | number> = {
          "État d'alimentation": vm.powerState,
          vCPU: vm.numVcpus,
          "Mémoire (Mio)": vm.memoryMib,
        };
        if (vm.hostName) details["Hôte physique"] = vm.hostName;
        if (vm.apiErrorMessage) details["Erreur Prism Central"] = vm.apiErrorMessage;
        return {
          id: vm.id,
          kind: "vm",
          label: vm.name,
          subtitle: vm.cluster,
          status: vmEntityStatus(vm),
          details,
        };
      }),
    ];

    const knownClusterUuids = new Set(clusters.map((c) => c.uuid));
    const knownHostUuids = new Set(hosts.map((h) => h.id));
    const relations: ServiceModuleRelation[] = [];
    for (const host of hosts) {
      if (!host.clusterUuid || !knownClusterUuids.has(host.clusterUuid)) continue;
      relations.push({ id: `hosts:${host.clusterUuid}:${host.id}`, source: host.clusterUuid, target: host.id, kind: "hosts" });
    }
    for (const vm of vms) {
      if (vm.hostUuid && knownHostUuids.has(vm.hostUuid)) {
        relations.push({ id: `hosts:${vm.hostUuid}:${vm.id}`, source: vm.hostUuid, target: vm.id, kind: "hosts" });
      } else if (vm.clusterUuid && knownClusterUuids.has(vm.clusterUuid)) {
        relations.push({ id: `hosts:${vm.clusterUuid}:${vm.id}`, source: vm.clusterUuid, target: vm.id, kind: "hosts" });
      }
    }

    return {
      moduleId: NUTANIX_PLUGIN_ID,
      generatedAt,
      status: "ready",
      summary: [
        { label: "Clusters", value: String(clusters.length), tone: "neutral" },
        { label: "Hôtes physiques", value: String(hosts.length), tone: "neutral" },
        { label: "VMs", value: String(vms.length), tone: "neutral" },
        { label: "VMs allumées", value: `${poweredOn} / ${vms.length}`, tone: "ok" },
        ...(inError > 0 ? [{ label: "VMs en erreur", value: String(inError), tone: "critical" as const }] : []),
      ],
      entities,
      relations,
    };
  },

  async graph(_config: unknown): Promise<PluginGraphContribution> {
    return await nutanixGraphContribution();
  },

  actions: {
    "vm.start": async (input: unknown) => await startNutanixVm(requireVmUuid(input)),
    "vm.stop": async (input: unknown) => await stopNutanixVm(requireVmUuid(input)),
    "vm.restart": async (input: unknown) => await restartNutanixVm(requireVmUuid(input)),
    "vm.delete": async (input: unknown) => await deleteNutanixVm(requireVmUuid(input)),
    "vm.migrate": async (input: unknown) => await migrateNutanixVm(requireVmUuid(input), requireField(input, "targetHostUuid")),
    "vm.add-disk": async (input: unknown) => {
      const uuid = requireVmUuid(input);
      const sizeMib = isRecord(input) ? num(input.sizeMib) : undefined;
      if (sizeMib === undefined) throw new NutanixActionError("sizeMib (number, MiB) is required", 400);
      return await addNutanixVmDisk(uuid, { sizeMib });
    },
    "vm.add-nic": async (input: unknown) => await addNutanixVmNic(requireVmUuid(input), { subnetUuid: requireField(input, "subnetUuid") }),
    "vm.update-compute": async (input: unknown) => {
      const uuid = requireVmUuid(input);
      const raw = isRecord(input) ? input : {};
      const numVcpus = num(raw.numVcpus);
      const numCoresPerVcpu = num(raw.numCoresPerVcpu);
      const memoryMib = num(raw.memoryMib);
      return await updateNutanixVmCompute(uuid, {
        ...(numVcpus !== undefined ? { numVcpus } : {}),
        ...(numCoresPerVcpu !== undefined ? { numCoresPerVcpu } : {}),
        ...(memoryMib !== undefined ? { memoryMib } : {}),
      });
    },
    "vm.create": async (input: unknown) => await createNutanixVm(readCreateVmInput(input)),
    "image.create": async (input: unknown) =>
      await createNutanixImage({ name: requireField(input, "name"), sourceUri: requireField(input, "sourceUri") }),
  },
};
