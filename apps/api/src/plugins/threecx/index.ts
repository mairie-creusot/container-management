/**
 * Greffon PBX 3CX — LECTURE SEULE stricte du XAPI (voir services/threecx.ts, qui porte tout le
 * savoir-faire réel : deux modes d'authentification, un seul jeton actif à la fois, `$top` plafonné
 * à 100, liste blanche de champs). Ce fichier ne réimplémente rien : il décrit l'intégration au
 * socle et délègue.
 *
 * Aucune action mutante n'est exposée : le XAPI sait raccrocher, appeler et arrêter le PBX de la
 * mairie, et `permissions.mutates: false` interdit au socle d'en accepter une.
 */

import type { Plugin, PluginTestResult, ServiceModuleSnapshot } from "@quai/plugin-contract";
import { threecxModuleProvider } from "../../services/serviceModules.js";
import { testThreecxConnection } from "../../services/threecx.js";
import type { ThreecxConnectionCandidate } from "../../services/threecx.js";
import {
  isThreecxConfigComplete,
  normalizeThreecxAuthMode,
  parseThreecxConfig,
  threecxConfigStore,
  THREECX_PLUGIN_ID,
  THREECX_SECRET_FIELDS,
} from "./config.js";

/** Même message que le module de service 3CX (serviceModules.ts) : l'écran ne doit pas changer. */
const NOT_CONFIGURED_MESSAGE =
  "Intégration 3CX non configurée — renseignez l'URL du PBX, le ClientID et la clé API dans les Réglages.";

function notConfiguredSnapshot(): ServiceModuleSnapshot {
  return {
    moduleId: THREECX_PLUGIN_ID,
    generatedAt: new Date().toISOString(),
    status: "not-configured",
    message: NOT_CONFIGURED_MESSAGE,
    summary: [],
    entities: [],
    relations: [],
  };
}

export const threecxPlugin: Plugin = {
  manifest: {
    id: THREECX_PLUGIN_ID,
    name: "Téléphonie 3CX",
    version: "1.0.0",
    coreApi: "^1.0",
    // Le formulaire de apps/web/src/features/threecx/ThreecxConfigSection.tsx, champ pour champ —
    // voir apps/web/src/components/formSchemaFromManifest.test.tsx, qui en tient la copie de test.
    configSchema: {
      type: "object",
      title: "PBX 3CX",
      properties: {
        baseUrl: {
          type: "string",
          title: "URL de base du PBX",
          description:
            "Adresse du PBX sans le suffixe /xapi/v1 — QUAI l'ajoute lui-même, ainsi que le chemin d'authentification.",
          examples: ["https://pbx.exemple.fr:5001"],
        },
        authMode: {
          type: "string",
          title: "Comment QUAI s'authentifie auprès du PBX",
          enum: ["client-credentials", "user"],
          enumLabels: [
            "ClientID et clé API (point de routage)",
            "Identifiant et mot de passe (extension propriétaire système)",
          ],
          default: "client-credentials",
        },
        clientId: {
          type: "string",
          title: "ClientID — DN du point de routage",
          description:
            "Point de routage créé dans Admin Console → Integrations > API, option « XAPI Access Enabled » activée.",
          showIf: { field: "authMode", equals: "client-credentials" },
        },
        clientSecret: {
          type: "string",
          title: "Clé API",
          showIf: { field: "authMode", equals: "client-credentials" },
        },
        username: {
          type: "string",
          title: "Identifiant (extension avec droits propriétaire système)",
          description:
            "Extension du PBX disposant des droits d'administration système : sans eux, le jeton est délivré mais le XAPI refuse les requêtes.",
          showIf: { field: "authMode", equals: "user" },
        },
        password: {
          type: "string",
          title: "Mot de passe",
          showIf: { field: "authMode", equals: "user" },
        },
        tlsRejectUnauthorized: {
          type: "boolean",
          title: "Vérifier le certificat TLS du PBX",
          description:
            "À laisser activé : un 3CX publié sous son FQDN présente un certificat valide. Ne le désactivez que pour un PBX joint par une adresse interne avec un certificat auto-signé.",
          default: true,
        },
      },
      // Les identifiants de l'autre mode sont masqués par showIf : ils ne sont jamais exigés.
      required: ["baseUrl", "clientId", "clientSecret", "username", "password"],
      additionalProperties: false,
    },
    secretFields: [...THREECX_SECRET_FIELDS],
    // Aucun hôte fixe : le PBX joint est celui de `baseUrl`, saisi par l'admin.
    permissions: { network: [], mutates: false },
    // Aucune action exposée, donc aucun libellé d'audit : le greffon est en lecture seule.
    auditLabels: {},
  },

  configStore: threecxConfigStore,

  async test(config: unknown): Promise<PluginTestResult> {
    const parsed = parseThreecxConfig(config);
    if (!parsed) return { ok: false, message: "L'URL du PBX est requise" };
    // testThreecxConnection valide le mode, teste RÉELLEMENT le PBX et ne persiste rien.
    const candidate: ThreecxConnectionCandidate = { ...parsed, authMode: normalizeThreecxAuthMode(parsed.authMode) };
    const result = await testThreecxConnection(candidate);
    return { ok: result.ok, message: result.message };
  },

  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    const parsed = parseThreecxConfig(config);
    if (!parsed || !isThreecxConfigComplete(parsed)) return notConfiguredSnapshot();
    // Exactement l'instantané servi par GET /api/service-modules/3cx. Le service lit lui-même la
    // configuration STOCKÉE (un seul jeton actif par instance) : `config` dit si le greffon est
    // configuré, il ne sert jamais à joindre un autre PBX que celui enregistré.
    return await threecxModuleProvider.getSnapshot();
  },
};
