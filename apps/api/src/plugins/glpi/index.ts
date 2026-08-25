/**
 * Greffon GLPI (tickets de la Mairie du Creusot) — première intégration MUTANTE du socle : elle
 * crée des tickets, les commente, les résout et réconcilie l'inventaire. `permissions.mutates` est
 * donc `true`, et chaque action porte son libellé d'audit.
 *
 * Ce fichier ne réimplémente rien : tout le savoir-faire réel reste dans services/glpi.ts et
 * services/glpiInventory.ts (URL contenant `apirest.php`, session init/kill, `contains` + filtrage
 * exact côté QUAI sur le champ identifiant, anti-doublon par empreinte). Le périmètre d'écriture
 * exposé ici est EXACTEMENT celui de ces services : aucune suppression, aucune modification libre
 * d'un ticket existant.
 */

import type {
  Plugin,
  PluginTestResult,
  ServiceModuleSnapshot,
  ServiceModuleStatus,
  ServiceModuleSummaryItem,
} from "@quai/plugin-contract";
import {
  addGlpiFollowup,
  createGlpiTicket,
  GlpiError,
  GlpiNotConfiguredError,
  listGlpiTicketsPage,
  markGlpiTicketSolved,
  reportGlpiIncident,
  resolveGlpiIncident,
  testGlpiConnection,
} from "../../services/glpi.js";
import type { GlpiIncidentContext, GlpiIncidentKey } from "../../services/glpi.js";
import { createGlpiComputerForResource, updateGlpiComputerForResource } from "../../services/glpiInventory.js";
import type { InventoryField } from "../../services/glpiInventory.js";
import {
  glpiAuthModeOf,
  GLPI_PLUGIN_ID,
  GLPI_SECRET_FIELDS,
  isGlpiConfigComplete,
  parseGlpiConfig,
} from "./config.js";
import type { GlpiAuthMode } from "./config.js";

const NOT_CONFIGURED_MESSAGE =
  "Intégration GLPI non configurée — renseignez l'URL de apirest.php, l'app_token et le jeton utilisateur (ou le compte de service) dans les Réglages.";

/** Libellés des options du sélecteur, mot pour mot ceux de features/glpi/GlpiConfigSection.tsx. */
const AUTH_MODE_OPTION_LABELS = ["Jeton utilisateur (user_token)", "Compte de service (login et mot de passe)"];

/** Libellés de la ligne « Authentification » de la fiche, mot pour mot ceux du même écran. */
const AUTH_MODE_SUMMARY_LABELS: Record<GlpiAuthMode, string> = {
  "user-token": "Jeton utilisateur (user_token)",
  credentials: "Compte de service (login/mot de passe)",
};

/** Champs d'inventaire alignables — même liste que routes/glpiInventory.ts#KNOWN_FIELDS. */
const KNOWN_INVENTORY_FIELDS: ReadonlyArray<InventoryField> = [
  "name",
  "uuid",
  "serial",
  "vcpu",
  "memoryMib",
  "ipAddresses",
  "operatingSystem",
  "host",
];

/** Instantané SANS données : un état non « ready » s'explique, il ne se déguise jamais en listes vides. */
function snapshotOf(status: ServiceModuleStatus, message: string): ServiceModuleSnapshot {
  return {
    moduleId: GLPI_PLUGIN_ID,
    generatedAt: new Date().toISOString(),
    status,
    message,
    summary: [],
    entities: [],
    relations: [],
  };
}

/**
 * Un refus (401/403 : app_token invalide, droits insuffisants) n'est pas une panne, et une erreur
 * renvoyée par GLPI n'est pas une injoignabilité — le vocabulaire élargi permet enfin de le dire.
 */
function statusFromError(err: unknown): { status: ServiceModuleStatus; message: string } {
  if (err instanceof GlpiNotConfiguredError) return { status: "not-configured", message: NOT_CONFIGURED_MESSAGE };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GlpiError && err.status !== undefined) {
    if (err.status === 401 || err.status === 403) return { status: "denied", message };
    return { status: "failed", message };
  }
  return { status: "unreachable", message };
}

// --- Lecture stricte des entrées d'action (rien n'est deviné, rien n'est complété) ---

function record(input: unknown, action: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`Action GLPI "${action}" : un objet d'entrée est requis`);
  }
  return input as Record<string, unknown>;
}

function requiredText(input: Record<string, unknown>, key: string, action: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Action GLPI "${action}" : "${key}" est requis`);
  }
  return value.trim();
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredId(input: Record<string, unknown>, key: string, action: string): number {
  const value = input[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Action GLPI "${action}" : "${key}" doit être un identifiant entier positif`);
  }
  return parsed;
}

function optionalId(input: Record<string, unknown>, key: string, action: string): number | undefined {
  const value = input[key];
  return value === undefined || value === null ? undefined : requiredId(input, key, action);
}

/** Champs d'inventaire demandés — les inconnus sont ÉCARTÉS, jamais interprétés (comme la route). */
function optionalFields(input: Record<string, unknown>): InventoryField[] | undefined {
  const raw = input["fields"];
  if (!Array.isArray(raw)) return undefined;
  const fields = raw.filter((value): value is InventoryField => KNOWN_INVENTORY_FIELDS.includes(value as InventoryField));
  return fields.length > 0 ? fields : undefined;
}

function incidentKey(input: Record<string, unknown>, action: string): GlpiIncidentKey {
  return { resource: requiredText(input, "resource", action), alertType: requiredText(input, "alertType", action) };
}

export const glpiPlugin: Plugin = {
  manifest: {
    id: GLPI_PLUGIN_ID,
    name: "Assistance GLPI",
    version: "1.0.0",
    coreApi: "^1.0",
    // Le formulaire de apps/web/src/features/glpi/GlpiConfigSection.tsx, champ pour champ.
    configSchema: {
      type: "object",
      title: "Assistance GLPI",
      properties: {
        apiUrl: {
          type: "string",
          title: "URL de l'API GLPI",
          description:
            "L'URL doit contenir « apirest.php » : sans ce suffixe la requête tombe sur la racine web de GLPI, qui répond 403.",
          examples: ["http://serveur-glpi/apirest.php"],
        },
        appToken: {
          type: "string",
          title: "app_token",
          description: "Jeton d'application de l'instance GLPI — toujours requis, quel que soit le mode d'authentification.",
        },
        authMode: {
          type: "string",
          title: "Mode d'authentification",
          description:
            "Les deux modes sont acceptés par GLPI. Un jeton utilisateur déjà enregistré garde la priorité sur un compte de service saisi ensuite.",
          enum: ["user-token", "credentials"],
          enumLabels: [...AUTH_MODE_OPTION_LABELS],
          default: "user-token",
        },
        userToken: {
          type: "string",
          title: "user_token",
          showIf: { field: "authMode", equals: "user-token" },
        },
        username: {
          type: "string",
          title: "Compte de service GLPI",
          showIf: { field: "authMode", equals: "credentials" },
        },
        password: {
          type: "string",
          title: "Mot de passe",
          showIf: { field: "authMode", equals: "credentials" },
        },
      },
      // Les identifiants de l'autre mode sont masqués par showIf : ils ne sont jamais exigés.
      required: ["apiUrl", "appToken", "userToken", "username", "password"],
      additionalProperties: false,
    },
    secretFields: [...GLPI_SECRET_FIELDS],
    // Aucun hôte fixe : le GLPI joint est celui de `apiUrl`, saisi par l'admin — le contrat ne sait
    // pas désigner l'hôte d'un champ de configuration (voir le rapport de migration).
    permissions: { network: [], mutates: true },
    auditLabels: {
      "create-ticket": "Création d'un ticket GLPI",
      "add-followup": "Ajout d'un suivi à un ticket GLPI",
      "resolve-ticket": "Passage d'un ticket GLPI en résolu",
      "report-incident": "Signalement d'un incident dans GLPI (création ou suivi anti-doublon)",
      "resolve-incident": "Clôture de l'incident GLPI correspondant (suivi puis passage en résolu)",
      "create-inventory-computer": "Création de la fiche d'inventaire GLPI d'une ressource réelle",
      "update-inventory-computer": "Alignement d'une fiche d'inventaire GLPI sur la ressource réelle",
    },
  },

  async test(config: unknown): Promise<PluginTestResult> {
    const parsed = parseGlpiConfig(config);
    if (!parsed) return { ok: false, message: "L'URL de l'API GLPI est requise" };
    // testGlpiConnection ouvre une session RÉELLE puis la referme, ne persiste rien et caviarde les
    // secrets de son message.
    const result = await testGlpiConnection(parsed);
    return { ok: result.ok, message: result.message };
  },

  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    const parsed = parseGlpiConfig(config);
    if (!parsed || !isGlpiConfigComplete(parsed)) return snapshotOf("not-configured", NOT_CONFIGURED_MESSAGE);

    try {
      // Lecture RÉELLE et bornée : le total vient du `totalcount` de GLPI, jamais d'un comptage local.
      const page = await listGlpiTicketsPage({ openOnly: true, limit: 1 });
      const authMode = glpiAuthModeOf(parsed);
      const summary: ServiceModuleSummaryItem[] = [
        { label: "URL de l'API", value: parsed.apiUrl, tone: "neutral" },
        { label: "Authentification", value: AUTH_MODE_SUMMARY_LABELS[authMode], tone: "neutral" },
      ];
      if (authMode === "credentials" && parsed.username) {
        summary.push({ label: "Compte de service", value: parsed.username, tone: "neutral" });
      }
      // Total absent = l'instance ne l'a pas communiqué : la ligne disparaît plutôt que d'être estimée.
      if (page.total !== undefined) summary.push({ label: "Tickets ouverts", value: String(page.total), tone: "neutral" });
      return {
        moduleId: GLPI_PLUGIN_ID,
        generatedAt: new Date().toISOString(),
        status: "ready",
        summary,
        // Les tickets et les fiches d'inventaire ne sont pas des nœuds de topologie : ils vivent
        // dans les écrans GLPI, et en inventer ici n'ajouterait aucune donnée réelle.
        entities: [],
        relations: [],
      };
    } catch (err) {
      const { status, message } = statusFromError(err);
      return snapshotOf(status, message);
    }
  },

  // Périmètre d'écriture identique à celui des routes : ni suppression, ni champ libre sur un
  // ticket existant (la seule mutation possible reste `{ status: 5 }`).
  actions: {
    "create-ticket": async (input: unknown) => {
      const body = record(input, "create-ticket");
      const requesterUserId = optionalId(body, "requesterUserId", "create-ticket");
      const ticketId = await createGlpiTicket({
        title: requiredText(body, "title", "create-ticket"),
        content: requiredText(body, "content", "create-ticket"),
        ...(requesterUserId !== undefined ? { requesterUserId } : {}),
      });
      return { ticketId };
    },

    "add-followup": async (input: unknown) => {
      const body = record(input, "add-followup");
      const ticketId = requiredId(body, "ticketId", "add-followup");
      const content = requiredText(body, "content", "add-followup");
      const requesterUserId = optionalId(body, "requesterUserId", "add-followup");
      const followupId = await addGlpiFollowup(ticketId, content, requesterUserId);
      return { ticketId, followupId };
    },

    "resolve-ticket": async (input: unknown) => {
      const body = record(input, "resolve-ticket");
      const ticketId = requiredId(body, "ticketId", "resolve-ticket");
      await markGlpiTicketSolved(ticketId);
      return { ticketId, status: "solved" };
    },

    "report-incident": async (input: unknown) => {
      const body = record(input, "report-incident");
      const details = optionalText(body, "details");
      const occurredAt = optionalText(body, "occurredAt");
      const backUrl = optionalText(body, "backUrl");
      const context: GlpiIncidentContext = {
        ...incidentKey(body, "report-incident"),
        title: requiredText(body, "title", "report-incident"),
        ...(details !== undefined ? { details } : {}),
        ...(occurredAt !== undefined ? { occurredAt } : {}),
        ...(backUrl !== undefined ? { backUrl } : {}),
      };
      return await reportGlpiIncident(context);
    },

    "resolve-incident": async (input: unknown) => {
      const body = record(input, "resolve-incident");
      return await resolveGlpiIncident(incidentKey(body, "resolve-incident"), optionalText(body, "resolvedAt"));
    },

    "create-inventory-computer": async (input: unknown) => {
      const body = record(input, "create-inventory-computer");
      return await createGlpiComputerForResource(requiredText(body, "resourceId", "create-inventory-computer"));
    },

    "update-inventory-computer": async (input: unknown) => {
      const body = record(input, "update-inventory-computer");
      return await updateGlpiComputerForResource(
        requiredId(body, "computerId", "update-inventory-computer"),
        requiredText(body, "resourceId", "update-inventory-computer"),
        optionalFields(body),
      );
    },
  },
};
