/**
 * Configuration du greffon GLPI : lecture/écriture dans le STOCKAGE GÉNÉRIQUE des intégrations
 * (setupStore#integrations, clé "glpi"), avec reprise de celle déjà enregistrée dans le champ typé
 * `glpi` — une instance configurée avant la migration ne se ressaisit jamais.
 *
 * Le champ typé est RETIRÉ dès qu'il a été repris : le laisser en place en ferait une configuration
 * de secours qui ressusciterait le GLPI que l'admin vient de retirer.
 */

import {
  clearGlpiConfig,
  clearIntegrationConfig,
  getCurrent,
  getEffectiveGlpiConfig,
  getEffectiveIntegrationConfig,
  setIntegrationConfig,
} from "../../services/setupStore.js";
import type { SetupGlpiConfig } from "../../services/setupStore.js";

export const GLPI_PLUGIN_ID = "glpi";

/** Champs chiffrés au repos — la MÊME liste que `secretFields` du manifeste et que les champs
 * traités par setupStore#mapGlpiSecrets. */
export const GLPI_SECRET_FIELDS: string[] = ["appToken", "userToken", "password"];

/** Mode d'authentification du FORMULAIRE. Il n'est pas une donnée de GLPI : le jeton réellement
 * enregistré fait foi (services/glpi.ts#authHeader donne la priorité au user_token). */
export type GlpiAuthMode = "user-token" | "credentials";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chaîne réellement renseignée (jamais rognée : un secret peut légitimement porter des espaces). */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Mode DÉDUIT de la configuration, exactement comme routes/glpi.ts#toPublicConfig et
 * services/glpi.ts#getGlpiStatus : il ne peut donc pas contredire l'authentification réelle. */
export function glpiAuthModeOf(cfg: Pick<SetupGlpiConfig, "userToken">): GlpiAuthMode {
  return text(cfg.userToken) ? "user-token" : "credentials";
}

/** Utilisable seulement avec l'URL, l'app_token et les identifiants d'UN mode — même règle exacte
 * que services/glpi.ts#loadConfigOrNull. */
export function isGlpiConfigComplete(cfg: SetupGlpiConfig): boolean {
  if (!cfg.apiUrl || !cfg.appToken) return false;
  return Boolean(cfg.userToken) || Boolean(cfg.username && cfg.password);
}

/** Lecture STRICTE d'une configuration stockée ou candidate — rien n'est deviné ni complété. */
export function parseGlpiConfig(raw: unknown): SetupGlpiConfig | null {
  if (!isRecord(raw)) return null;
  const apiUrl = text(raw.apiUrl);
  if (!apiUrl) return null;
  const userToken = text(raw.userToken);
  const username = text(raw.username);
  const password = text(raw.password);
  // `authMode` n'est pas relu : c'est le jeton présent qui décide, à la lecture comme à l'exécution.
  return {
    apiUrl,
    appToken: text(raw.appToken) ?? "",
    ...(userToken !== undefined ? { userToken } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** Forme écrite dans le stockage générique — mêmes noms de champs que le manifeste. */
function toStored(cfg: SetupGlpiConfig): Record<string, unknown> {
  const userToken = text(cfg.userToken);
  const username = text(cfg.username);
  const password = text(cfg.password);
  return {
    apiUrl: cfg.apiUrl,
    appToken: cfg.appToken,
    // Toujours explicite pour que le formulaire rouvre sur le bon mode, et toujours DÉDUIT des
    // identifiants réellement stockés : impossible d'écrire un mode contredisant la connexion.
    authMode: glpiAuthModeOf(cfg),
    ...(userToken !== undefined ? { userToken } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** Présence du champ typé SANS rien déchiffrer : une clé de chiffrement changée ne doit jamais
 * empêcher d'écrire une nouvelle configuration ni de retirer l'ancienne. */
async function hasLegacyConfig(): Promise<boolean> {
  return (await getCurrent()).glpi !== undefined;
}

async function dropLegacyConfig(): Promise<void> {
  if (await hasLegacyConfig()) await clearGlpiConfig();
}

/**
 * Reprise du champ typé `glpi` : recopié tel quel sous l'identifiant du greffon (secrets déchiffrés
 * par setupStore puis rechiffrés par le stockage générique), puis retiré. Idempotent, et sans effet
 * quand le champ typé n'existe pas. Si les deux coexistent (config.json édité à la main), c'est
 * l'entrée du greffon qui fait foi — le champ typé est simplement retiré.
 */
async function adoptLegacyConfig(): Promise<void> {
  if (!(await hasLegacyConfig())) return;
  // Le champ typé ne peut REAPPARAITRE que si l'assistant de configuration vient de le réécrire :
  // il porte donc une saisie plus récente que l'entrée du greffon et l'emporte. L'ignorer ferait
  // perdre silencieusement des identifiants que l'utilisateur vient de saisir.
  const legacy = await getEffectiveGlpiConfig();
  if (legacy) await setIntegrationConfig(GLPI_PLUGIN_ID, toStored(legacy), GLPI_SECRET_FIELDS);
  await dropLegacyConfig();
}

/**
 * Configuration effective du greffon (secrets déchiffrés), ou `null` s'il n'a jamais été configuré.
 * Ne JAMAIS renvoyer ce résultat par une route : il porte les secrets en clair.
 */
export async function loadGlpiPluginConfig(): Promise<SetupGlpiConfig | null> {
  await adoptLegacyConfig();
  const entry = await getEffectiveIntegrationConfig(GLPI_PLUGIN_ID);
  return entry ? parseGlpiConfig(entry.config) : null;
}

/** Écrit la configuration du greffon — appToken/userToken/password chiffrés au repos par le socle. */
export async function saveGlpiPluginConfig(cfg: SetupGlpiConfig): Promise<void> {
  await setIntegrationConfig(GLPI_PLUGIN_ID, toStored(cfg), GLPI_SECRET_FIELDS);
  await dropLegacyConfig();
}

/** Retire la configuration du greffon ET tout reliquat du champ typé (retour à "jamais configuré"). */
export async function removeGlpiPluginConfig(): Promise<void> {
  await clearIntegrationConfig(GLPI_PLUGIN_ID);
  await dropLegacyConfig();
}
