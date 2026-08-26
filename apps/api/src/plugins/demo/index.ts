/**
 * Module de DÉMONSTRATION — livré, signé et installé comme les autres, mais il ne contacte rien.
 *
 * Il existe pour éprouver le socle de bout en bout sur un module sans conséquence : le configurer,
 * le mettre en pause, le réactiver, le désinstaller puis le restaurer, et voir l'interface suivre
 * (section de Réglages déduite de ce manifeste, carte de la page Modules, journal de traçabilité).
 * Aucun réseau, aucun disque, aucune donnée inventée : son instantané ne rend que ce qui a été saisi.
 */

import { CORE_API_VERSION } from "@quai/plugin-contract";
import type { Plugin, ServiceModuleSnapshot } from "@quai/plugin-contract";

const MODULE_ID = "demo";

/** Sous-ensemble de ServiceModuleTone : les teintes que ce module propose à la saisie. */
type DemoTone = "neutral" | "ok" | "warning";

interface DemoConfig {
  label: string;
  tone: DemoTone;
  note: string;
  token: string;
}

const TONES: readonly DemoTone[] = ["neutral", "ok", "warning"];

function isTone(value: unknown): value is DemoTone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

/** Lecture stricte : `unknown` en entrée, rien n'est deviné ni complété. */
function readConfig(config: unknown): DemoConfig | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const { label, tone, note, token } = config as { label?: unknown; tone?: unknown; note?: unknown; token?: unknown };
  if (typeof label !== "string" || label.trim().length === 0) return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return {
    label: label.trim(),
    tone: isTone(tone) ? tone : "neutral",
    note: typeof note === "string" ? note.trim() : "",
    token,
  };
}

export const demoPlugin: Plugin = {
  manifest: {
    id: MODULE_ID,
    name: "Module de démonstration",
    version: "1.0.0",
    coreApi: "^1.1",
    configSchema: {
      type: "object",
      title: "Module de démonstration",
      description:
        "Module d'essai du socle : il ne joint aucun service et n'affiche que ce que vous saisissez ici.",
      properties: {
        label: {
          type: "string",
          title: "Étiquette",
          description: "Texte repris tel quel dans l'instantané du module.",
          minLength: 1,
        },
        tone: {
          type: "string",
          title: "Couleur de l'étiquette",
          enum: ["neutral", "ok", "warning"],
          enumLabels: ["Neutre", "Vert", "Orange"],
          default: "neutral",
        },
        note: {
          type: "string",
          title: "Remarque",
          description: "Facultatif — sert à vérifier qu'un champ vide reste vide après enregistrement.",
        },
        token: {
          type: "string",
          format: "password",
          title: "Jeton d'essai",
          description: "Secret fictif : chiffré au repos et jamais renvoyé par l'API, comme un vrai identifiant.",
          minLength: 1,
        },
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
    if (!parsed) return { ok: false, message: 'Configuration incomplète : « Étiquette » et « Jeton d\'essai » sont requis.' };
    return {
      ok: true,
      message: `Configuration valide (socle ${CORE_API_VERSION}) — ce module de démonstration ne contacte aucun service.`,
    };
  },

  async snapshot(config: unknown): Promise<ServiceModuleSnapshot> {
    const parsed = readConfig(config);
    const generatedAt = new Date().toISOString();
    if (!parsed) {
      return {
        moduleId: MODULE_ID,
        generatedAt,
        status: "not-configured",
        message: "Module de démonstration non configuré.",
        summary: [],
        entities: [],
        relations: [],
      };
    }
    const summary = [{ label: "Étiquette", value: parsed.label, tone: parsed.tone }];
    if (parsed.note.length > 0) summary.push({ label: "Remarque", value: parsed.note, tone: "neutral" as const });
    // Aucune entité : ce module n'interroge aucune source, il n'a rien de réel à décrire.
    return { moduleId: MODULE_ID, generatedAt, status: "ready", summary, entities: [], relations: [] };
  },
};
