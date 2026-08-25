/**
 * Configuration du greffon 3CX : lecture/écriture dans le STOCKAGE GÉNÉRIQUE des intégrations
 * (setupStore#integrations, clé "3cx"), avec reprise de celle déjà enregistrée dans le champ typé
 * `threecx` — un PBX configuré avant la migration ne se ressaisit jamais.
 *
 * Le champ typé est RETIRÉ dès qu'il a été repris : le laisser en place en ferait une configuration
 * de secours qui ressusciterait le PBX que l'admin vient de retirer.
 */

import {
  clearIntegrationConfig,
  clearThreecxConfig,
  getCurrent,
  getEffectiveIntegrationConfig,
  getEffectiveThreecxConfig,
  setIntegrationConfig,
} from "../../services/setupStore.js";
import type { SetupThreecxConfig, ThreecxAuthMode } from "../../services/setupStore.js";

export const THREECX_PLUGIN_ID = "3cx";

/** Champs chiffrés au repos — la MÊME liste que `secretFields` du manifeste. */
export const THREECX_SECRET_FIELDS: string[] = ["clientSecret", "password"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chaîne réellement renseignée (jamais rognée : un secret peut légitimement porter des espaces). */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Une valeur inconnue vaut "client-credentials" : c'est le mode d'une config écrite avant le choix. */
export function normalizeThreecxAuthMode(value: unknown): ThreecxAuthMode {
  return value === "user" ? "user" : "client-credentials";
}

/** Une config n'est utilisable que si les identifiants du MODE choisi sont présents. */
export function isThreecxConfigComplete(cfg: SetupThreecxConfig): boolean {
  if (!cfg.baseUrl) return false;
  return normalizeThreecxAuthMode(cfg.authMode) === "user"
    ? Boolean(cfg.username && cfg.password)
    : Boolean(cfg.clientId && cfg.clientSecret);
}

/** Lecture STRICTE d'une configuration stockée ou candidate — rien n'est deviné ni complété. */
export function parseThreecxConfig(raw: unknown): SetupThreecxConfig | null {
  if (!isRecord(raw)) return null;
  const baseUrl = text(raw.baseUrl);
  if (!baseUrl) return null;
  const clientId = text(raw.clientId);
  const clientSecret = text(raw.clientSecret);
  const username = text(raw.username);
  const password = text(raw.password);
  return {
    baseUrl,
    authMode: normalizeThreecxAuthMode(raw.authMode),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(typeof raw.tlsRejectUnauthorized === "boolean" ? { tlsRejectUnauthorized: raw.tlsRejectUnauthorized } : {}),
  };
}

/** Forme écrite dans le stockage générique — mêmes noms de champs que le manifeste. */
function toStored(cfg: SetupThreecxConfig): Record<string, unknown> {
  const clientId = text(cfg.clientId);
  const clientSecret = text(cfg.clientSecret);
  const username = text(cfg.username);
  const password = text(cfg.password);
  return {
    baseUrl: cfg.baseUrl,
    // Toujours explicite : la migration d'une config sans authMode se fait ici, une fois pour toutes.
    authMode: normalizeThreecxAuthMode(cfg.authMode),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(cfg.tlsRejectUnauthorized !== undefined ? { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized } : {}),
  };
}

/** Présence du champ typé SANS rien déchiffrer : une clé de chiffrement changée ne doit jamais
 * empêcher d'écrire une nouvelle configuration ni de retirer l'ancienne. */
async function hasLegacyConfig(): Promise<boolean> {
  return (await getCurrent()).threecx !== undefined;
}

async function dropLegacyConfig(): Promise<void> {
  if (await hasLegacyConfig()) await clearThreecxConfig();
}

/**
 * Reprise du champ typé `threecx` : recopié tel quel sous l'identifiant du greffon (secrets
 * déchiffrés par setupStore puis rechiffrés par le stockage générique), puis retiré. Idempotent, et
 * sans effet quand le champ typé n'existe pas. Si les deux coexistent (config.json édité à la main,
 * assistant rejoué), c'est l'entrée du greffon qui fait foi — le champ typé est simplement retiré.
 */
async function adoptLegacyConfig(): Promise<void> {
  if (!(await hasLegacyConfig())) return;
  // Le champ typé ne peut REAPPARAITRE que si l'assistant de configuration vient de le réécrire :
  // il porte donc une saisie plus récente que l'entrée du greffon et l'emporte. L'ignorer ferait
  // perdre silencieusement des identifiants que l'utilisateur vient de saisir.
  const legacy = await getEffectiveThreecxConfig();
  if (legacy) await setIntegrationConfig(THREECX_PLUGIN_ID, toStored(legacy), THREECX_SECRET_FIELDS);
  await dropLegacyConfig();
}

/**
 * Configuration effective du greffon (secrets déchiffrés), ou `null` s'il n'a jamais été configuré.
 * Ne JAMAIS renvoyer ce résultat par une route : il porte les secrets en clair.
 */
export async function loadThreecxPluginConfig(): Promise<SetupThreecxConfig | null> {
  await adoptLegacyConfig();
  const entry = await getEffectiveIntegrationConfig(THREECX_PLUGIN_ID);
  return entry ? parseThreecxConfig(entry.config) : null;
}

/** Écrit la configuration du greffon — clientSecret/password chiffrés au repos par le socle. */
export async function saveThreecxPluginConfig(cfg: SetupThreecxConfig): Promise<void> {
  await setIntegrationConfig(THREECX_PLUGIN_ID, toStored(cfg), THREECX_SECRET_FIELDS);
  await dropLegacyConfig();
}

/** Retire la configuration du greffon ET tout reliquat du champ typé (retour à "jamais configuré"). */
export async function removeThreecxPluginConfig(): Promise<void> {
  await clearIntegrationConfig(THREECX_PLUGIN_ID);
  await dropLegacyConfig();
}
