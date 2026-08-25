/**
 * Greffon d'EXEMPLE — modèle minimal d'intégration et test de bout en bout du socle.
 *
 * Il ne contacte rien (aucun réseau, aucun disque) et n'est jamais enregistré au démarrage
 * (voir plugins/builtins.ts) : il ne doit apparaître nulle part comme une intégration réelle.
 * Copier ce fichier est le point de départ pour brancher une vraie intégration.
 */

import type { Plugin, ServiceModuleSnapshot } from "@quai/plugin-contract";

const MODULE_ID = "example";

interface ExampleConfig {
  label: string;
  token: string;
}

/** Lecture stricte : `unknown` en entrée, rien n'est deviné ni complété. */
function readConfig(config: unknown): ExampleConfig | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const { label, token } = config as { label?: unknown; token?: unknown };
  if (typeof label !== "string" || label.trim().length === 0) return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return { label: label.trim(), token };
}

export const examplePlugin: Plugin = {
  manifest: {
    id: MODULE_ID,
    name: "Greffon d'exemple",
    version: "1.0.0",
    coreApi: "^1.0",
    configSchema: {
      type: "object",
      title: "Greffon d'exemple",
      properties: {
        label: { type: "string", title: "Étiquette", description: "Texte affiché tel quel dans l'instantané.", minLength: 1 },
        token: { type: "string", title: "Jeton", description: "Secret fictif : jamais renvoyé par l'API.", minLength: 1 },
      },
      required: ["label", "token"],
      additionalProperties: false,
    },
    secretFields: ["token"],
    permissions: { network: [], mutates: false },
    auditLabels: {},
  },

  async test(config: unknown) {
    const parsed = readConfig(config);
    if (!parsed) {
      return { ok: false, message: 'Configuration incomplète : "label" et "token" sont requis.' };
    }
    return { ok: true, message: "Configuration valide — ce greffon d'exemple ne contacte aucun service." };
  },

  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    const parsed = readConfig(config);
    const generatedAt = new Date().toISOString();
    if (!parsed) {
      return {
        moduleId: MODULE_ID,
        generatedAt,
        status: "not-configured",
        message: "Greffon d'exemple non configuré.",
        summary: [],
        entities: [],
        relations: [],
      };
    }
    // Rien d'autre à montrer : ce greffon n'interroge aucune source, donc aucune entité inventée.
    return {
      moduleId: MODULE_ID,
      generatedAt,
      status: "ready",
      summary: [{ label: "Étiquette", value: parsed.label, tone: "neutral" }],
      entities: [],
      relations: [],
    };
  },
};
