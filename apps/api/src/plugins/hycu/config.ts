/**
 * Configuration du greffon HYCU : lecture/écriture dans le STOCKAGE GÉNÉRIQUE des intégrations
 * (setupStore#integrations, clé "hycu"), avec reprise de celle déjà enregistrée dans le champ typé
 * `hycu` — une appliance configurée avant la migration ne se ressaisit jamais.
 *
 * Le champ typé est RETIRÉ dès qu'il a été repris : le laisser en place en ferait une configuration
 * de secours qui ressusciterait l'appliance que l'admin vient de retirer. Modèle EXACT de
 * plugins/threecx/config.ts.
 */

import {
  clearHycuConfig,
  clearIntegrationConfig,
  getCurrent,
  getEffectiveHycuConfig,
  getEffectiveIntegrationConfig,
  setIntegrationConfig,
} from "../../services/setupStore.js";
import type { SetupHycuConfig } from "../../services/setupStore.js";

export const HYCU_PLUGIN_ID = "hycu";

/** Champs chiffrés au repos — la MÊME liste que `secretFields` du manifeste. */
export const HYCU_SECRET_FIELDS: string[] = ["password"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chaîne réellement renseignée (jamais rognée : un secret peut légitimement porter des espaces). */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Une config n'est utilisable que si l'URL ET les deux identifiants sont présents — même garde
 * exacte que services/hycu.ts#loadHycuConfig avant la migration. */
export function isHycuConfigComplete(cfg: SetupHycuConfig): boolean {
  return Boolean(cfg.url && cfg.username && cfg.password);
}

/** Lecture STRICTE d'une configuration stockée ou candidate — rien n'est deviné ni complété. */
export function parseHycuConfig(raw: unknown): SetupHycuConfig | null {
  if (!isRecord(raw)) return null;
  const url = text(raw.url);
  if (!url) return null;
  return { url, username: text(raw.username) ?? "", password: text(raw.password) ?? "" };
}

/** Forme écrite dans le stockage générique — mêmes noms de champs que le manifeste. */
function toStored(cfg: SetupHycuConfig): Record<string, unknown> {
  return { url: cfg.url, username: cfg.username, password: cfg.password };
}

/** Présence du champ typé SANS rien déchiffrer : une clé de chiffrement changée ne doit jamais
 * empêcher d'écrire une nouvelle configuration ni de retirer l'ancienne. */
async function hasLegacyConfig(): Promise<boolean> {
  return (await getCurrent()).hycu !== undefined;
}

async function dropLegacyConfig(): Promise<void> {
  if (await hasLegacyConfig()) await clearHycuConfig();
}

/**
 * Reprise du champ typé `hycu` : recopié tel quel sous l'identifiant du greffon (mot de passe
 * déchiffré par setupStore puis rechiffré par le stockage générique), puis retiré. Idempotent, et
 * sans effet quand le champ typé n'existe pas. Si les deux coexistent (config.json édité à la main,
 * assistant rejoué), c'est l'entrée du greffon qui fait foi — le champ typé est simplement retiré.
 */
async function adoptLegacyConfig(): Promise<void> {
  if (!(await hasLegacyConfig())) return;
  const legacy = await getEffectiveHycuConfig();
  if (legacy && !(await getEffectiveIntegrationConfig(HYCU_PLUGIN_ID))) {
    await setIntegrationConfig(HYCU_PLUGIN_ID, toStored(legacy), HYCU_SECRET_FIELDS);
  }
  await clearHycuConfig();
}

/**
 * Configuration effective du greffon (mot de passe déchiffré), ou `null` s'il n'a jamais été
 * configuré. Ne JAMAIS renvoyer ce résultat par une route : il porte le secret en clair.
 */
export async function loadHycuPluginConfig(): Promise<SetupHycuConfig | null> {
  await adoptLegacyConfig();
  const entry = await getEffectiveIntegrationConfig(HYCU_PLUGIN_ID);
  return entry ? parseHycuConfig(entry.config) : null;
}

/** Écrit la configuration du greffon — `password` chiffré au repos par le socle. */
export async function saveHycuPluginConfig(cfg: SetupHycuConfig): Promise<void> {
  await setIntegrationConfig(HYCU_PLUGIN_ID, toStored(cfg), HYCU_SECRET_FIELDS);
  await dropLegacyConfig();
}

/** Retire la configuration du greffon ET tout reliquat du champ typé (retour à "jamais configuré"). */
export async function removeHycuPluginConfig(): Promise<void> {
  await clearIntegrationConfig(HYCU_PLUGIN_ID);
  await dropLegacyConfig();
}
