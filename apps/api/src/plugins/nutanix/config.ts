/**
 * Configuration du greffon Nutanix : lecture/écriture dans le STOCKAGE GÉNÉRIQUE des intégrations
 * (setupStore#integrations, clé "nutanix"), avec reprise de celle déjà enregistrée dans le champ
 * typé `nutanix` — un Prism Central configuré avant la migration ne se ressaisit jamais.
 *
 * Modèle EXACT de plugins/threecx/config.ts : le champ typé est RETIRÉ dès qu'il a été repris, pour
 * ne pas laisser derrière une configuration de secours qui ressusciterait l'instance retirée.
 */

import {
  clearIntegrationConfig,
  clearNutanixConfig,
  getCurrent,
  getEffectiveIntegrationConfig,
  getEffectiveNutanixConfig,
  setIntegrationConfig,
} from "../../services/setupStore.js";
import type { SetupNutanixConfig } from "../../services/setupStore.js";

export const NUTANIX_PLUGIN_ID = "nutanix";

/** Champs chiffrés au repos — la MÊME liste que `secretFields` du manifeste. */
export const NUTANIX_SECRET_FIELDS: string[] = ["password"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chaîne réellement renseignée (jamais rognée : un mot de passe peut porter des espaces). */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Les trois champs saisis dans le formulaire, tels qu'ils arrivent — aucun n'est deviné. */
export interface NutanixConfigCandidate {
  prismCentralUrl?: string;
  username?: string;
  password?: string;
}

/** Lecture tolérante d'une configuration candidate (formulaire en cours de saisie, test()). */
export function readNutanixConfigCandidate(raw: unknown): NutanixConfigCandidate {
  if (!isRecord(raw)) return {};
  const prismCentralUrl = text(raw.prismCentralUrl);
  const username = text(raw.username);
  const password = text(raw.password);
  return {
    ...(prismCentralUrl !== undefined ? { prismCentralUrl } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * Configuration UTILISABLE, ou `null` — même exigence exacte qu'avant la migration
 * (services/nutanix.ts#loadNutanixConfig : URL + identifiants complets, sinon "jamais configuré").
 */
export function parseNutanixConfig(raw: unknown): SetupNutanixConfig | null {
  const { prismCentralUrl, username, password } = readNutanixConfigCandidate(raw);
  if (!prismCentralUrl || !username || !password) return null;
  return { prismCentralUrl, username, password };
}

/** Forme écrite dans le stockage générique — mêmes noms de champs que le manifeste. */
function toStored(cfg: SetupNutanixConfig): Record<string, unknown> {
  return { prismCentralUrl: cfg.prismCentralUrl, username: cfg.username, password: cfg.password };
}

/** Présence du champ typé SANS rien déchiffrer : une clé de chiffrement changée ne doit jamais
 * empêcher d'écrire une nouvelle configuration ni de retirer l'ancienne. */
async function hasLegacyConfig(): Promise<boolean> {
  return (await getCurrent()).nutanix !== undefined;
}

async function dropLegacyConfig(): Promise<void> {
  if (await hasLegacyConfig()) await clearNutanixConfig();
}

/**
 * Reprise du champ typé `nutanix` : recopié tel quel sous l'identifiant du greffon (mot de passe
 * déchiffré par setupStore puis rechiffré par le stockage générique), puis retiré. Idempotent, et
 * sans effet quand le champ typé n'existe pas. Si les deux coexistent (config.json édité à la main,
 * assistant rejoué), c'est l'entrée du greffon qui fait foi — le champ typé est simplement retiré.
 */
async function adoptLegacyConfig(): Promise<void> {
  if (!(await hasLegacyConfig())) return;
  const legacy = await getEffectiveNutanixConfig();
  if (legacy && !(await getEffectiveIntegrationConfig(NUTANIX_PLUGIN_ID))) {
    await setIntegrationConfig(NUTANIX_PLUGIN_ID, toStored(legacy), NUTANIX_SECRET_FIELDS);
  }
  await clearNutanixConfig();
}

/**
 * Configuration effective du greffon (mot de passe déchiffré), ou `null` s'il n'a jamais été
 * configuré. Ne JAMAIS renvoyer ce résultat par une route : il porte le secret en clair.
 */
export async function loadNutanixPluginConfig(): Promise<SetupNutanixConfig | null> {
  await adoptLegacyConfig();
  const entry = await getEffectiveIntegrationConfig(NUTANIX_PLUGIN_ID);
  return entry ? parseNutanixConfig(entry.config) : null;
}

/** Écrit la configuration du greffon — `password` chiffré au repos par le socle. */
export async function saveNutanixPluginConfig(cfg: SetupNutanixConfig): Promise<void> {
  await setIntegrationConfig(NUTANIX_PLUGIN_ID, toStored(cfg), NUTANIX_SECRET_FIELDS);
  await dropLegacyConfig();
}

/** Retire la configuration du greffon ET tout reliquat du champ typé (retour à "jamais configuré"). */
export async function removeNutanixPluginConfig(): Promise<void> {
  await clearIntegrationConfig(NUTANIX_PLUGIN_ID);
  await dropLegacyConfig();
}
